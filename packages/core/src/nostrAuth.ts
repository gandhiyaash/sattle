/**
 * Signing in with Nostr: proving you hold a Nostr key, so it can stand in
 * for the sign-in key on a device that has neither.
 *
 * The proof is an HTTP-auth event in the shape NIP-98 gives it (kind 27235,
 * the URL and method as tags), signed by the person's own signer: a browser
 * extension (NIP-07) or a remote signer (NIP-46). It also carries a
 * challenge the server handed out, which it accepts once, so a signed event
 * can't be used twice. The app never sees the private key.
 */

/** NIP-98 HTTP auth. */
export const NOSTR_AUTH_KIND = 27235;

/** Where each proof is sent. The server checks the event names the one it arrived at. */
export const NOSTR_AUTH_PATHS = {
  /** Public: the account linked to the key, and its token. */
  signIn: '/auth/nostr',
  /** Signed in: link the key to this account. */
  link: '/me/nostr',
} as const;

export interface NostrAuthTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/** What the signer is asked to sign: a POST to `url`, answering `challenge`. */
export function nostrAuthTemplate(url: string, challenge: string, createdAt = Math.floor(Date.now() / 1000)): NostrAuthTemplate {
  return {
    kind: NOSTR_AUTH_KIND,
    created_at: createdAt,
    tags: [
      ['u', url],
      ['method', 'POST'],
      ['challenge', challenge],
    ],
    content: '',
  };
}
