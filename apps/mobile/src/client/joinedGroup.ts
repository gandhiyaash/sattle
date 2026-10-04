/**
 * The group an invite is for, when whoever holds it is already in that group.
 *
 * A group has one link, so the people in it tap it too: it is what's in the
 * chat. They have nobody left to be, and the join page would only turn them
 * away. The page tells nobody which group it is for, but a group hands each
 * of its members its invite, so theirs is found by its token.
 */

import type { SattleClient } from './SattleClient';

/** The id of that group, or null when the signed-in user isn't in it. */
export async function joinedGroupFor(client: SattleClient, token: string): Promise<string | null> {
  const groups = await client.getGroups();
  // One group that can't be read mustn't hide the others.
  const invites = await Promise.all(groups.map((g) => client.getGroupInvite(g.id).catch(() => null)));
  return groups.find((_, i) => invites[i]?.token === token)?.id ?? null;
}
