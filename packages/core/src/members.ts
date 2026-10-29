/**
 * Who a member is, in accounts.
 *
 * A member can be joined from more than one phone or browser. Each is an
 * account of its own, and each is that member in the group: it sees what
 * they see, pays what they owe, and says what they would say. The first to
 * join as them is `claimedByUserId`; the ones after it are `alsoHeldBy`.
 */

import type { Member } from './types';

type Held = Pick<Member, 'claimedByUserId' | 'alsoHeldBy'>;

/** Every account that is this member, the first to join as them first. None for a ghost. */
export function accountsOf(member: Held): string[] {
  return member.claimedByUserId ? [member.claimedByUserId, ...(member.alsoHeldBy ?? [])] : [];
}

/** Whether `userId` is this member, on whichever of their devices. */
export function isHeldBy(member: Held | undefined, userId: string): boolean {
  return Boolean(member) && accountsOf(member!).includes(userId);
}
