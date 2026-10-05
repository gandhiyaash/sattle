/**
 * Signing with a remote signer over Nostr Connect (NIP-46): the person's
 * keys stay in their signer app (nsec.app, Amber, a bunker of their own),
 * which they point us at with a bunker:// link. We make a throwaway key to
 * talk to it, ask it to sign one event, and hang up.
 *
 * Loaded with import(), through nostr/lazy.ts, only when someone uses it.
 */

import type { Event } from 'nostr-tools';
import { BunkerSigner, parseBunkerInput } from 'nostr-tools/nip46';
import { generateSecretKey } from 'nostr-tools/pure';

import type { NostrAuthTemplate } from '@sattle/core';

/** Long enough to find the phone and approve, no longer. */
const WAIT_MS = 2 * 60_000;

function timeout<T>(work: Promise<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), WAIT_MS);
    work.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/**
 * Has the signer behind `input`, a bunker:// link or a name@domain that
 * points at one, sign `template`. `onAuthUrl` is called if the signer wants
 * the person to approve in a page of its own.
 */
export async function signWithBunker(
  input: string,
  template: NostrAuthTemplate,
  onAuthUrl: (url: string) => void
): Promise<Event> {
  const pointer = await parseBunkerInput(input.trim()).catch(() => null);
  if (!pointer) throw new Error('That isn’t a bunker link. Copy the bunker:// link from your signer.');
  const signer = BunkerSigner.fromBunker(generateSecretKey(), pointer, { onauth: onAuthUrl });
  try {
    await timeout(signer.connect({ name: 'Sattle' }), 'Your signer didn’t answer. Check it’s open, then try again.');
    return await timeout(signer.signEvent(template), 'Your signer didn’t sign it in time. Try again.');
  } finally {
    void signer.close().catch(() => {});
  }
}
