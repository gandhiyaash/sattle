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

/**
 * Which of the group's two pages a link is for, and its token. They share the
 * token and differ in what whoever taps the link is after: the group's page,
 * to see what's been split and pay, or its join page, to say who they are.
 * Null for anything that is a link to neither, a pay link included.
 */
export function parseSharedLink(url: string): { page: 'group' | 'join'; token: string } | null {
  const m = /\/(join|g)\/([A-Za-z0-9_-]+)/.exec(url.trim());
  return m ? { page: m[1] === 'g' ? 'group' : 'join', token: m[2] } : null;
}
