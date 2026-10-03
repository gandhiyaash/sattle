/**
 * Small pure helpers both sides of the invite contract use.
 */

export const invitePath = (token: string) => `/join/${token}`;

/**
 * The token in whatever someone pasted: the link, the whole message it came
 * in, or the token alone. Null when there isn't one.
 */
export function parseInviteToken(text: string): string | null {
  const t = text.trim();
  const inLink = /\/join\/([A-Za-z0-9_-]+)/.exec(t);
  if (inLink) return inLink[1];
  return /^[A-Za-z0-9_-]{8,}$/.test(t) ? t : null;
}
