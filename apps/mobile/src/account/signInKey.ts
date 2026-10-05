/**
 * The sign-in key: this device's account token, written so it can be pasted
 * on another device or in a fresh browser to be the same person there.
 *
 * It is the token itself, so whoever has it is signed in as you. The prefix
 * is so a paste of something else (a backup key, a group link) is caught on
 * the device, not sent to the server as a token.
 */

const PREFIX = 'sattle-signin:';
/** What POST /accounts hands out: 32 random bytes, base64url. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const signInKey = (token: string) => `${PREFIX}${token}`;

/** The token in a pasted key, or null if it isn't one. A bare token is taken too. */
export function parseSignInKey(text: string): string | null {
  const t = text.trim();
  const token = t.toLowerCase().startsWith(PREFIX) ? t.slice(PREFIX.length) : t;
  return TOKEN.test(token) ? token : null;
}
