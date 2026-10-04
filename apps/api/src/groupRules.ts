/**
 * Rules for taking things out: changing or removing an expense, removing a
 * member, leaving, deleting a group, deleting an account.
 *
 * They follow the same idea as settlementRules: nobody can undo what someone
 * else is owed. So an expense is the payer's to change, a group with money
 * still owed in it can't be deleted, and a member who is part of the ledger
 * can't be removed from it. What someone can always do is take themselves
 * out, and their row stays behind as a ghost with its balance.
 */

import { SattleError, canChangeExpense, type Expense, type Group, type Member, type User } from '@sattle/core';

import type { Repo } from './repo';
import { debtsOf, isInProgress } from './settlementRules';
import type { WalletStore } from './walletStore';

const conflict = (message: string) => new SattleError('conflict', message);

/** The payer if they've joined; anyone in the group if the payer is a ghost. See canChangeExpense. */
export function checkExpenseOwner(repo: Repo, expense: Expense, userId: string) {
  const payer = repo.member(expense.paidByMemberId);
  if (!canChangeExpense(payer, userId)) {
    throw new SattleError('invalid_input', `Only ${payer!.displayName} can change this, because they paid it.`);
  }
}

/**
 * A payment on its way to this user is confirmed through their wallet and
 * lands on their member, so neither can go until it has finished.
 */
export function checkNothingIncoming(repo: Repo, userId: string, groupId?: string) {
  const open = repo.unfinishedToUser(userId).some((s) => isInProgress(s) && (!groupId || s.groupId === groupId));
  if (open) throw conflict('A payment to you is still in progress. Wait for it to finish.');
}

/** Only a ghost nobody has built anything on: no expense, payment or pay link names them. */
export function checkMemberCanGo(repo: Repo, g: Group, member: Member) {
  if (member.claimedByUserId) {
    throw new SattleError('invalid_input', `${member.displayName} has joined. Only they can leave.`);
  }
  if (repo.memberHasHistory(g.id, member.id)) {
    throw conflict(`${member.displayName} is part of this group’s expenses or payments, so they can’t be removed.`);
  }
}

/**
 * The user's member becomes a ghost again, keeping its name, history and
 * balance; an invite can hand it back. The last person with an account can't
 * leave, because nobody could reach the group afterwards.
 */
export function leaveGroup(repo: Repo, g: Group, userId: string) {
  if (repo.claimedCount(g.id) === 1) {
    throw conflict('You’re the only one here with an account. Delete the group instead.');
  }
  checkNothingIncoming(repo, userId, g.id);
  repo.unclaimMember(repo.memberForUser(g.id, userId)!.id);
}

/** A group goes only once nothing is owed in it, so deleting it can't erase a debt. */
export function checkGroupCanGo(repo: Repo, g: Group) {
  if (repo.settlements(g.id).some(isInProgress)) {
    throw conflict('A payment in this group is still in progress. Wait for it to finish.');
  }
  if (debtsOf(repo, g).length > 0) {
    throw conflict('There’s still money owed in this group. Settle up first.');
  }
}

/**
 * Removes the account. In each group it leaves, as leaveGroup does, unless it
 * is the only account there: nobody else could ever open that group, so the
 * group goes with it, debts and all. Then the wallet connection, its links,
 * and the account itself.
 */
export function deleteAccount(repo: Repo, wallets: WalletStore, user: User) {
  checkNothingIncoming(repo, user.id);
  for (const g of repo.groupsForUser(user.id)) {
    if (repo.claimedCount(g.id) > 1) continue;
    if (repo.settlements(g.id).some(isInProgress)) {
      throw conflict('A payment in one of your groups is still in progress. Wait for it to finish.');
    }
    repo.deleteGroup(g.id);
  }
  repo.unclaimAllOf(user.id);
  wallets.remove(user.id);
  repo.deleteUser(user.id);
}
