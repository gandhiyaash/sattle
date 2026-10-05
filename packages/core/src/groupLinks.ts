/**
 * Small pure helpers both sides of the group link contract use. A group has
 * one link and one token: /g/<token> shows the group, and /join/<token> is
 * where someone says who they are in it.
 */

export const groupLinkPath = (token: string) => `/g/${token}`;

export const joinPath = (token: string) => `/join/${token}`;

/**
 * The token in whatever someone pasted: the group's link, in either of those
 * forms, the whole message it came in, or the token alone. Null when there
 * isn't one.
 */
export function parseGroupLinkToken(text: string): string | null {
  const t = text.trim();
  const inLink = /\/(?:join|g)\/([A-Za-z0-9_-]+)/.exec(t);
  if (inLink) return inLink[1];
  return /^[A-Za-z0-9_-]{8,}$/.test(t) ? t : null;
}
