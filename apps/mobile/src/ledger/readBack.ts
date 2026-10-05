/**
 * A group read straight off Nostr relays with its backup key: no Sattle
 * server, no account. The same check `npm run ledger:verify` does, in the app.
 *
 * The key never leaves the device. Relays are asked for the server's
 * entries under the group's tag, a hash of the key, and the decrypting
 * happens here.
 *
 * Screens load this file with import() when someone asks to restore, so
 * nostr-tools isn't evaluated while the app starts.
 */

import { npubEncode } from 'nostr-tools/nip19';
import { SimplePool } from 'nostr-tools/pool';

import { ledgerFilter, parseBackupUri, readLedger, type ReadLedger } from '@sattle/core/nostrLedger';

export interface ReadBack extends ReadLedger {
  /** The relays that were asked. */
  relays: string[];
  /** Who signed every entry: the server's key, as npub. */
  npub: string;
}

/** How long to wait for relays that answer slowly or not at all. */
const MAX_WAIT_MS = 8000;

export async function readBack(uri: string): Promise<ReadBack> {
  // Throws, with a message for the screen, when the key isn't one.
  const access = parseBackupUri(uri);
  if (access.relays.length === 0) throw new Error('This key doesn’t say which relays the group is on.');

  const pool = new SimplePool();
  try {
    const events = await pool.querySync(access.relays, ledgerFilter(access), { maxWait: MAX_WAIT_MS });
    return { ...readLedger(events, access), relays: access.relays, npub: npubEncode(access.pubkey) };
  } catch {
    throw new Error('Couldn’t reach the relays. Check your connection and try again.');
  } finally {
    pool.close(access.relays);
  }
}
