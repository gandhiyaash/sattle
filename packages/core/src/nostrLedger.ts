/**
 * Reading a group's ledger back from Nostr, with nothing but its backup key.
 * Shared by the server (which writes the ledger, see apps/api nostrLedger.ts),
 * the ledger:verify script and the app's restore screen.
 *
 * Pure like the rest of core: it checks and decrypts events someone else
 * fetched. Not exported from the package root, so only what reads the ledger
 * pulls in nostr-tools: import it from '@sattle/core/nostrLedger'.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Event, Filter } from 'nostr-tools';
import * as nip44 from 'nostr-tools/nip44';
import { verifyEvent } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';

import type { Expense, Settlement } from './types';

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
  /** A new expense, or an earlier one as it reads after an edit. */
  expense?: Expense;
  /** An earlier expense that was removed. */
  removed?: { expenseId: string };
  settlement?: Settlement;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** The `h` tag on a group's entries. A hash of its key, so it says nothing about which group. */
export const groupTag = (key: string) => bytesToHex(sha256(utf8ToBytes(`sattle-ledger:${key}`)));

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

/** What to ask relays for: the group's entries, signed by the server. */
export const ledgerFilter = ({ pubkey, key }: Pick<LedgerAccess, 'pubkey' | 'key'>): Filter => ({
  kinds: [LEDGER_KIND],
  authors: [pubkey],
  '#h': [groupTag(key)],
});

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

  // The last word on each expense: an edit replaces it where it stands, a removal drops it.
  const expenses = new Map<string, Expense>();
  for (const { entry } of ordered) {
    if (entry.expense) expenses.set(entry.expense.id, entry.expense);
    if (entry.removed) expenses.delete(entry.removed.expenseId);
  }

  const last = ordered.at(-1)?.entry;
  return {
    group: last?.group,
    members: last?.members ?? [],
    expenses: [...expenses.values()],
    settlements: ordered.flatMap(({ entry }) => (entry.settlement ? [entry.settlement] : [])),
    entries: ordered.length,
    problems,
  };
}
