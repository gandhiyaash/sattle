/**
 * One member, several accounts.
 *
 * An account lives on one device, and people have more than one: they join in
 * a browser and install the app later, or get a new phone. So a name on the
 * join page can be picked again, and each device that picks it gets its own
 * account holding the same member. Every one of them is that member in the
 * group: same name, same balance, same say over what the member is owed.
 *
 * Money still needs one answer to "where is this member paid", so one of the
 * accounts is the one the member is paid through (members.claimed_by_user_id);
 * the payment code reads only that. It is the first of the member's accounts
 * that has somewhere to be paid, which is what settleOwner keeps true.
 *
 * It is scoped to the group. Picking a name gives a device that member, not
 * the rest of what its other accounts hold.
 */

import { isInProgress, type Member } from '@sattle/core';

import type { Repo } from './repo';
import type { WalletStore } from './walletStore';

/** What a member paid through this account is: `nwc_linked` with a wallet connected, as in their other groups. */
export const statusFor = (wallets: WalletStore, userId: string) =>
  wallets.connection(userId).connected ? 'nwc_linked' : 'joined';

/** Whether this account has anywhere to be paid: a wallet, its own address, or a UPI ID. */
const canBePaid = (wallets: WalletStore, userId: string) =>
  wallets.connection(userId).connected || Boolean(wallets.receiveAddress(userId) ?? wallets.upiId(userId));

/**
 * Moves the member to another of its accounts when the one it is paid through
 * has nowhere to be paid and the other does. Someone who joined in a browser
 * and connected their wallet in the app is then paid there, without doing
 * anything about it. The account it moves from stays one of the member's.
 *
 * Left alone while a payment to the member is under way. The next change to
 * how any of its accounts are paid looks again.
 */
export function settleOwner(repo: Repo, wallets: WalletStore, member: Member) {
  const owner = member.claimedByUserId;
  if (!owner || canBePaid(wallets, owner)) return;
  const next = repo.holders(member.id).find((userId) => canBePaid(wallets, userId));
  if (!next || repo.unfinishedToMember(member.id).some(isInProgress)) return;
  repo.removeHolder(member.id, next);
  repo.addHolder(member.id, owner);
  repo.setOwner(member.id, next, statusFor(wallets, next));
}

/** After this account's way of being paid changed: every member it is one of is looked at again. */
export function settleAccount(repo: Repo, wallets: WalletStore, userId: string) {
  for (const member of repo.membersHeldBy(userId)) settleOwner(repo, wallets, member);
}

/**
 * The account a member is paid through gives the member up. Another of its
 * accounts takes over, one that can be paid if there is one. With no other
 * account, the member is a ghost again.
 */
export function releaseOwned(repo: Repo, wallets: WalletStore, member: Member) {
  const others = repo.holders(member.id);
  const next = others.find((userId) => canBePaid(wallets, userId)) ?? others[0];
  if (!next) return repo.unclaimMember(member.id);
  repo.removeHolder(member.id, next);
  repo.setOwner(member.id, next, statusFor(wallets, next));
}
