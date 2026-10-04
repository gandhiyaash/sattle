/**
 * Rules shared by every route that creates a settlement — direct pay,
 * manual, and pay links. The client is never trusted on amounts.
 */

import {
  SattleError,
  TERMINAL_STATUSES,
  computeBalances,
  simplifyDebts,
  type Group,
  type Settlement,
} from '@sattle/core';

import { newId, nowIso, type Repo } from './repo';

export interface Pair {
  fromMemberId: string;
  toMemberId: string;
  amount: number;
}

export function debtsOf(repo: Repo, g: Group) {
  return simplifyDebts(g.id, computeBalances(g.memberIds, repo.expenses(g.id), repo.settlements(g.id)));
}

/**
 * Both members are in the group, and the amount is no more than the netted
 * debt between them right now. Returns the payee.
 */
export function checkSettlement(repo: Repo, g: Group, body: Pair) {
  if (!g.memberIds.includes(body.fromMemberId) || !g.memberIds.includes(body.toMemberId)) {
    throw new SattleError('not_found', 'That member isn’t in this group.');
  }
  if (body.fromMemberId === body.toMemberId) {
    throw new SattleError('invalid_input', 'Someone can’t settle with themselves.');
  }
  const debt = debtsOf(repo, g).find(
    (d) => d.fromMemberId === body.fromMemberId && d.toMemberId === body.toMemberId
  );
  if (!debt) throw new SattleError('conflict', 'Nothing is owed here any more.');
  if (body.amount > debt.amount) {
    throw new SattleError('conflict', 'That’s more than is owed. Refresh and try again.');
  }
  return repo.member(body.toMemberId)!;
}

/** Only the payer starts a payment. Call after checkSettlement. */
export function checkPayer(repo: Repo, body: Pair, userId: string) {
  const payer = repo.member(body.fromMemberId)!;
  if (payer.claimedByUserId !== userId) {
    throw new SattleError('invalid_input', `Only ${payer.displayName} can pay this.`);
  }
}

/**
 * Who may record a payment made outside the app. Nobody can check it, so the
 * person it costs if it's false makes it: the payee. A ghost payee has no
 * account to ask, so for them the payer may record it instead. Call after
 * checkSettlement.
 */
export function checkManualRecorder(repo: Repo, body: Pair, userId: string) {
  const payer = repo.member(body.fromMemberId)!;
  const payee = repo.member(body.toMemberId)!;
  if (payee.claimedByUserId === userId) return;
  if (!payee.claimedByUserId && payer.claimedByUserId === userId) return;
  throw new SattleError(
    'invalid_input',
    payee.claimedByUserId
      ? `Only ${payee.displayName} can mark this as settled.`
      : `Only ${payer.displayName} can mark this as settled.`
  );
}

/** The settlement already running for this pair, if any. */
export function inProgressFor(repo: Repo, g: Group, body: Pair) {
  return repo
    .settlements(g.id)
    .find((s) => isInProgress(s) && s.fromMemberId === body.fromMemberId && s.toMemberId === body.toMemberId);
}

/** Non-terminal, and not an awaiting_payment whose quote has lapsed. */
export function isInProgress(s: Settlement) {
  if (TERMINAL_STATUSES.includes(s.status)) return false;
  if (s.status === 'awaiting_payment' && s.quote && Date.parse(s.quote.expiresAt) < Date.now()) return false;
  return true;
}

export function newSettlement(
  g: Group,
  body: Pair,
  rail: Settlement['rail'],
  status: Settlement['status']
): Settlement {
  const now = nowIso();
  return {
    id: newId('s'),
    groupId: g.id,
    fromMemberId: body.fromMemberId,
    toMemberId: body.toMemberId,
    amount: body.amount,
    currency: g.currency,
    rail,
    status,
    createdAt: now,
    updatedAt: now,
  };
}
