/**
 * The ledger on Nostr. Every expense and every confirmed settlement becomes
 * one event, so a group's history outlives this server:
 *
 *   signed     by the server's key, so an entry can't be forged by a relay
 *   encrypted  with NIP-44 under a random per-group key that only members
 *              get, so relays and strangers see ciphertext
 *   chained    each entry names the one before it (seq + prev), so a missing
 *              or reordered entry shows up when the ledger is read back
 *
 * Writes go through an outbox (ledger_entries). `sync` finds expenses and
 * confirmed settlements that have no entry yet and signs one for each;
 * `publish` sends unpublished entries to the relays. Both run on a timer, so
 * no route has to remember to call them, and a relay outage or a restart
 * only delays publishing.
 *
 * What it doesn't fix: the server still signs, so the record proves what the
 * server said, not what each member agreed to. And while relays can't read an
 * entry, they can see the server's pubkey, a per-group tag, and when each
 * entry was made.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { Event } from 'nostr-tools';
import * as nip44 from 'nostr-tools/nip44';
import { npubEncode } from 'nostr-tools/nip19';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';

import { LEDGER_STATUSES, type Expense, type LedgerBackup, type Settlement } from '@sattle/core';

import { transaction, type Db } from './db';
import { relayTransport, type NostrTransport } from './nwc';
import { createRepo } from './repo';

/** A regular (stored, non-replaceable) kind, so relays keep every entry. Not a registered NIP kind. */
export const LEDGER_KIND = 4733;

export interface LedgerEntry {
  v: 1;
  /** 1 for a group's first entry, then +1 each time. */
  seq: number;
  /** The previous entry's event id; null for seq 1. */
  prev: string | null;
  group: { id: string; name: string; currency: string };
  /** Everyone in the group when the entry was made, so names and balances can be read without the server. */
  members: { id: string; displayName: string }[];
  expense?: Expense;
  settlement?: Settlement;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** The `h` tag on a group's entries. A hash of its key, so it says nothing about which group. */
export const groupTag = (key: string) => createHash('sha256').update(`sattle-ledger:${key}`).digest('hex');

export function signEntry(entry: LedgerEntry, key: string, secret: Uint8Array, createdAt: number): Event {
  return finalizeEvent(
    {
      kind: LEDGER_KIND,
      created_at: createdAt,
      tags: [['h', groupTag(key)]],
      content: nip44.encrypt(JSON.stringify(entry), hexToBytes(key)),
    },
    secret
  );
}

// ---------------------------------------------------------------------------
// The backup URI: everything a member needs to read the ledger back
// ---------------------------------------------------------------------------

export interface LedgerAccess {
  /** Hex. The server's signing key. */
  pubkey: string;
  /** Hex. The group's encryption key. */
  key: string;
  relays: string[];
}

export const backupUri = ({ pubkey, key, relays }: LedgerAccess) =>
  `sattle-ledger://${pubkey}?${new URLSearchParams([['key', key], ...relays.map((r): [string, string] => ['relay', r])])}`;

export function parseBackupUri(uri: string): LedgerAccess {
  const m = /^sattle-ledger:\/\/([0-9a-f]{64})\?(.*)$/i.exec(uri.trim());
  if (!m) throw new Error('That isn’t a ledger backup key. It starts with sattle-ledger://');
  const params = new URLSearchParams(m[2]);
  const key = (params.get('key') ?? '').toLowerCase();
  if (!HEX64.test(key)) throw new Error('The backup key’s group key is missing or malformed.');
  return { pubkey: m[1].toLowerCase(), key, relays: params.getAll('relay') };
}

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

export interface ReadLedger {
  group?: LedgerEntry['group'];
  members: LedgerEntry['members'];
  expenses: Expense[];
  settlements: Settlement[];
  entries: number;
  /** Anything that doesn't add up: bad signatures, gaps, a broken chain. Empty when the ledger is whole. */
  problems: string[];
}

/**
 * Rebuilds a group from its events, trusting nothing but the server's
 * pubkey and the group key. Events from anyone else, or that don't decrypt,
 * are ignored; gaps and breaks in the chain are reported.
 */
export function readLedger(events: Event[], { pubkey, key }: Pick<LedgerAccess, 'pubkey' | 'key'>): ReadLedger {
  const tag = groupTag(key);
  const problems: string[] = [];
  const bySeq = new Map<number, { id: string; entry: LedgerEntry }>();

  for (const ev of events) {
    if (ev.kind !== LEDGER_KIND || ev.pubkey !== pubkey) continue;
    if (!ev.tags.some((t) => t[0] === 'h' && t[1] === tag)) continue;
    if (!verifyEvent(ev)) {
      problems.push(`Event ${ev.id.slice(0, 12)}… has a bad signature, so it was skipped.`);
      continue;
    }
    let entry: LedgerEntry;
    try {
      entry = JSON.parse(nip44.decrypt(ev.content, hexToBytes(key)));
    } catch {
      problems.push(`Event ${ev.id.slice(0, 12)}… doesn’t decrypt with this key, so it was skipped.`);
      continue;
    }
    if (!bySeq.has(entry.seq)) bySeq.set(entry.seq, { id: ev.id, entry });
  }

  const ordered = [...bySeq.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  let prevId: string | null = null;
  ordered.forEach(({ id, entry }, i) => {
    if (entry.seq !== i + 1) {
      problems.push(`Entry ${i + 1} is missing.`);
    } else if (entry.prev !== prevId) {
      problems.push(`Entry ${entry.seq} doesn’t follow the entry before it.`);
    }
    prevId = id;
  });

  const last = ordered.at(-1)?.entry;
  return {
    group: last?.group,
    members: last?.members ?? [],
    expenses: ordered.flatMap(({ entry }) => (entry.expense ? [entry.expense] : [])),
    settlements: ordered.flatMap(({ entry }) => (entry.settlement ? [entry.settlement] : [])),
    entries: ordered.length,
    problems,
  };
}

// ---------------------------------------------------------------------------
// Writing it: the outbox and the publisher
// ---------------------------------------------------------------------------

export interface NostrLedgerOptions {
  db: Db;
  /** Where entries are published. Empty: entries are still signed and kept, just not sent. */
  relays: string[];
  /** Defaults to the relays themselves. A fake in tests. */
  transport?: NostrTransport;
  intervalMs?: number;
}

type Row = Record<string, unknown>;

export class NostrLedger {
  readonly relays: string[];
  private readonly db: Db;
  private readonly repo;
  private transport?: NostrTransport;
  private readonly intervalMs: number;
  private secret?: Uint8Array;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private failing = false;

  constructor(opts: NostrLedgerOptions) {
    this.db = opts.db;
    this.repo = createRepo(opts.db);
    this.relays = opts.relays;
    this.transport = opts.transport;
    this.intervalMs = opts.intervalMs ?? 3_000;
  }

  /** The server's signing key, made on first use and kept in the database. */
  private signingKey(): Uint8Array {
    if (!this.secret) {
      this.db
        .prepare('INSERT OR IGNORE INTO ledger_identity (id, secret) VALUES (1, ?)')
        .run(bytesToHex(generateSecretKey()));
      const { secret } = this.db.prepare('SELECT secret FROM ledger_identity WHERE id = 1').get() as { secret: string };
      this.secret = hexToBytes(secret);
    }
    return this.secret;
  }

  get pubkey() {
    return getPublicKey(this.signingKey());
  }

  /** The group's encryption key, made on first use. Groups from before this existed get one too. */
  groupKey(groupId: string): string {
    this.db
      .prepare('UPDATE expense_groups SET ledger_key = ? WHERE id = ? AND ledger_key IS NULL')
      .run(randomBytes(32).toString('hex'), groupId);
    const r = this.db.prepare('SELECT ledger_key FROM expense_groups WHERE id = ?').get(groupId) as Row | undefined;
    return r!.ledger_key as string;
  }

  backup(groupId: string): LedgerBackup {
    const pubkey = this.pubkey;
    const counts = this.db
      .prepare('SELECT COUNT(*) AS entries, COUNT(published_at) AS published FROM ledger_entries WHERE group_id = ?')
      .get(groupId) as { entries: number; published: number };
    return {
      uri: backupUri({ pubkey, key: this.groupKey(groupId), relays: this.relays }),
      npub: npubEncode(pubkey),
      relays: this.relays,
      ...counts,
    };
  }

  /**
   * Signs an entry for every expense and confirmed settlement that doesn't
   * have one, oldest first. Returns how many it made.
   */
  sync(): number {
    const due = this.db
      .prepare(
        `SELECT 'expense' AS kind, id, group_id, created_at AS at FROM expenses e
           WHERE NOT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.kind = 'expense' AND l.ref_id = e.id)
         UNION ALL
         SELECT 'settlement', id, group_id, updated_at FROM settlements s
           WHERE status IN (${LEDGER_STATUSES.map((st) => `'${st}'`).join(', ')})
             AND NOT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.kind = 'settlement' AND l.ref_id = s.id)
         ORDER BY at, id`
      )
      .all() as { kind: 'expense' | 'settlement'; id: string; group_id: string; at: string }[];
    if (due.length === 0) return 0;

    const secret = this.signingKey();
    const lastOf = this.db.prepare(
      'SELECT seq, event_id FROM ledger_entries WHERE group_id = ? ORDER BY seq DESC LIMIT 1'
    );
    const insert = this.db.prepare(
      `INSERT INTO ledger_entries (event_id, group_id, seq, kind, ref_id, event, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    transaction(this.db, () => {
      for (const d of due) {
        const group = this.repo.group(d.group_id)!;
        const last = lastOf.get(d.group_id) as { seq: number; event_id: string } | undefined;
        const entry: LedgerEntry = {
          v: 1,
          seq: (last?.seq ?? 0) + 1,
          prev: last?.event_id ?? null,
          group: { id: group.id, name: group.name, currency: group.currency },
          members: this.repo.members(group.id).map((m) => ({ id: m.id, displayName: m.displayName })),
          ...(d.kind === 'expense'
            ? { expense: this.repo.expenses(group.id).find((e) => e.id === d.id)! }
            : { settlement: this.repo.settlement(d.id)! }),
        };
        const key = this.groupKey(group.id);
        const event = signEntry(entry, key, secret, Math.floor(Date.parse(d.at) / 1000));
        insert.run(event.id, group.id, entry.seq, d.kind, d.id, JSON.stringify(event), new Date().toISOString());
      }
    });
    return due.length;
  }

  /** Sends unpublished entries, oldest first, until one fails. Returns how many went out. */
  async publish(): Promise<number> {
    if (this.relays.length === 0) return 0;
    this.transport ??= relayTransport(this.relays);
    const rows = this.db
      .prepare('SELECT event_id, event FROM ledger_entries WHERE published_at IS NULL ORDER BY created_at, seq LIMIT 50')
      .all() as { event_id: string; event: string }[];
    const mark = this.db.prepare('UPDATE ledger_entries SET published_at = ? WHERE event_id = ?');

    let sent = 0;
    for (const r of rows) {
      try {
        await this.transport.publish(JSON.parse(r.event));
      } catch {
        // Once per outage, not once per tick.
        if (!this.failing) console.error('ledger: no relay accepted an entry; retrying');
        this.failing = true;
        break;
      }
      this.failing = false;
      mark.run(new Date().toISOString(), r.event_id);
      sent++;
    }
    return sent;
  }

  async tick() {
    try {
      this.sync();
      await this.publish();
    } catch (e) {
      console.error('ledger: sync failed', e);
    }
  }

  start() {
    const loop = async () => {
      await this.tick();
      if (!this.stopped) this.timer = setTimeout(loop, this.intervalMs);
    };
    void loop();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.transport?.close();
  }
}
