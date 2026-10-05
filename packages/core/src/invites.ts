/**
 * Small pure helpers both sides of joining use. The token is the group
 * link's: /g/<token> shows the group, and /join/<token> is where someone
 * says who they are in it.
 */

export const invitePath = (token: string) => `/join/${token}`;

/**
 * The token in whatever someone pasted: the group's link, in either of those
 * forms, the whole message it came in, or the token alone. Null when there
 * isn't one.
 */
export function parseInviteToken(text: string): string | null {
  const t = text.trim();
  const inLink = /\/(?:join|g)\/([A-Za-z0-9_-]+)/.exec(t);
  if (inLink) return inLink[1];
  return /^[A-Za-z0-9_-]{8,}$/.test(t) ? t : null;
}
