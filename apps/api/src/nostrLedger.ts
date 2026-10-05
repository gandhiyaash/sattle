/**
 * The ledger on Nostr. Every expense, every change to one, and every
 * confirmed settlement becomes one event, so a group's history outlives this
 * server:
 *
 *   signed     by the server's key, so an entry can't be forged by a relay
 *   encrypted  with NIP-44 under a random per-group key that only members
 *              get, so relays and strangers see ciphertext
 *   chained    each entry names the one before it (seq + prev), so a missing
 *              or reordered entry shows up when the ledger is read back
 *
 * A published entry can't be altered, so an expense that is edited gets a
 * second entry with how it reads now, and one that is removed gets an entry
 * saying so. Whoever reads the ledger back takes the last word on each.
 *
 * Writes go through an outbox (ledger_entries). `sync` finds expenses, changes
 * to them and confirmed settlements that have no entry yet and signs one for each;
 * `publish` sends unpublished entries to the relays. Both run on a timer, so
 * no route has to remember to call them, and a relay outage or a restart
 * only delays publishing.
 *
 * What it doesn't fix: the server still signs, so the record proves what the
 * server said, not what each member agreed to. And while relays can't read an
 * entry, they can see the server's pubkey, a per-group tag, and when each
 * entry was made.
 */

import { randomBytes } from 'node:crypto';

import type { Event } from 'nostr-tools';
import * as nip44 from 'nostr-tools/nip44';
import { neventEncode, npubEncode } from 'nostr-tools/nip19';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';

import { LEDGER_STATUSES, type LedgerBackup } from '@sattle/core';
import { LEDGER_KIND, backupUri, groupTag, type LedgerEntry } from '@sattle/core/nostrLedger';

import { transaction, type Db } from './db';
import { relayTransport, type NostrTransport } from './nwc';
import { createRepo } from './repo';

// The reading half lives in core, where the app's restore screen can use it too.
export {
  LEDGER_KIND,
  backupUri,
  groupTag,
  ledgerFilter,
  parseBackupUri,
  readLedger,
  type LedgerAccess,
  type LedgerEntry,
  type ReadLedger,
} from '@sattle/core/nostrLedger';

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
    const latest = this.db
      .prepare(
        'SELECT event_id FROM ledger_entries WHERE group_id = ? AND published_at IS NOT NULL ORDER BY seq DESC LIMIT 1'
      )
      .get(groupId) as { event_id: string } | undefined;
    return {
      uri: backupUri({ pubkey, key: this.groupKey(groupId), relays: this.relays }),
      npub: npubEncode(pubkey),
      relays: this.relays,
      ...counts,
      // Only the id and where to find it: the event is ciphertext to anyone without the key.
      ...(latest && {
        latest: neventEncode({ id: latest.event_id, relays: this.relays.slice(0, 2), author: pubkey, kind: LEDGER_KIND }),
      }),
    };
  }

  /**
   * Signs an entry for every expense, change to an expense and confirmed
   * settlement that doesn't have one, oldest first. Returns how many it made.
   *
   * A change is filed as an 'expense' entry whose ref is the change, not the
   * expense. `ord` keeps changes made in the same instant in the order they
   * happened, after the expense they change.
   */
  sync(): number {
    const due = this.db
      .prepare(
        `SELECT 'expense' AS kind, id, group_id, created_at AS at, 0 AS ord FROM expenses e
           WHERE NOT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.kind = 'expense' AND l.ref_id = e.id)
         UNION ALL
         SELECT 'change', 'change-' || id, group_id, created_at, id FROM expense_changes c
           WHERE NOT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.kind = 'expense' AND l.ref_id = 'change-' || c.id)
         UNION ALL
         SELECT 'settlement', id, group_id, updated_at, 0 FROM settlements s
           WHERE status IN (${LEDGER_STATUSES.map((st) => `'${st}'`).join(', ')})
             AND NOT EXISTS (SELECT 1 FROM ledger_entries l WHERE l.kind = 'settlement' AND l.ref_id = s.id)
         ORDER BY at, ord, id`
      )
      .all() as { kind: 'expense' | 'change' | 'settlement'; id: string; group_id: string; at: string; ord: number }[];
    if (due.length === 0) return 0;

    const secret = this.signingKey();
    const lastOf = this.db.prepare(
      'SELECT seq, event_id FROM ledger_entries WHERE group_id = ? ORDER BY seq DESC LIMIT 1'
    );
    const insert = this.db.prepare(
      `INSERT INTO ledger_entries (event_id, group_id, seq, kind, ref_id, event, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const changeById = this.db.prepare('SELECT expense_id, expense FROM expense_changes WHERE id = ?');
    /** What the entry is about: the expense, how it now reads, that it's gone, or the settlement. */
    const subject = (d: (typeof due)[number]): Pick<LedgerEntry, 'expense' | 'removed' | 'settlement'> => {
      if (d.kind === 'settlement') return { settlement: this.repo.settlement(d.id)! };
      if (d.kind === 'expense') return { expense: this.repo.expense(d.id)! };
      const change = changeById.get(d.ord) as { expense_id: string; expense: string | null };
      return change.expense ? { expense: JSON.parse(change.expense) } : { removed: { expenseId: change.expense_id } };
    };

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
          ...subject(d),
        };
        const key = this.groupKey(group.id);
        const event = signEntry(entry, key, secret, Math.floor(Date.parse(d.at) / 1000));
        const kind = d.kind === 'settlement' ? 'settlement' : 'expense';
        insert.run(event.id, group.id, entry.seq, kind, d.id, JSON.stringify(event), new Date().toISOString());
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
