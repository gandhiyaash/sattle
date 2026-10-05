/**
 * Proving the person holds a Nostr key, for signing in with it or linking it
 * (see @sattle/core nostrAuth). Two kinds of signer, neither of which shows
 * us the private key:
 *
 *   extension  NIP-07, window.nostr in a browser (Alby, nos2x, …). Web only.
 *   bunker     NIP-46, a remote signer the person points us at with a
 *              bunker:// link (nsec.app, Amber on Android, …). Anywhere.
 */

import { Platform } from 'react-native';
import type { Event } from 'nostr-tools';

import { nostrAuthTemplate, type NostrAuthTemplate } from '@sattle/core';
import { nostrChallenge } from '../client/ApiClient';
import { API_URL } from '../react/SattleProvider';

export type NostrSigner = { kind: 'extension' } | { kind: 'bunker'; link: string };

interface WindowNostr {
  getPublicKey(): Promise<string>;
  signEvent(event: NostrAuthTemplate): Promise<Event>;
}

const extension = (): WindowNostr | undefined =>
  Platform.OS === 'web' && typeof window !== 'undefined'
    ? (window as unknown as { nostr?: WindowNostr }).nostr
    : undefined;

/** Whether this browser has a Nostr extension. Extensions can load after the page, so ask when drawing. */
export const hasExtension = () => Boolean(extension());

/**
 * A signed proof for `path`, answering a fresh challenge from the server.
 * `onAuthUrl` is for a remote signer that wants approval in a page of its own.
 */
export async function proveNostrKey(
  signer: NostrSigner,
  path: string,
  onAuthUrl: (url: string) => void
): Promise<Event> {
  const template = nostrAuthTemplate(`${API_URL}${path}`, await nostrChallenge(API_URL));
  if (signer.kind === 'bunker') {
    const { signWithBunker } = await import('./lazy');
    return signWithBunker(signer.link, template, onAuthUrl);
  }
  const nostr = extension();
  if (!nostr) throw new Error('No Nostr extension found in this browser.');
  try {
    return await nostr.signEvent(template);
  } catch {
    throw new Error('Your extension didn’t sign it. Approve the request in the extension, then try again.');
  }
}
