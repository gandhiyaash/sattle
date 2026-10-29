/**
 * Rules shared by every route that creates a settlement — direct pay,
 * manual, and pay links. The client is never trusted on amounts.
 */

import {
  SattleError,
  groupDebts,
  isHeldBy,
  isInProgress,
  type Group,
  type Settlement,
} from '@sattle/core';

import { newId, nowIso, type Repo } from './repo';

export interface Pair {
  fromMemberId: string;
  toMemberId: string;
  amount: number;
}

/** What is owed in the group right now, simplified or not as the group chose. */
export function debtsOf(repo: Repo, g: Group) {
  return groupDebts(g, repo.expenses(g.id), repo.settlements(g.id));
}

/**
 * Both members are in the group, and the amount is no more than what one
 * owes the other right now (debtsOf). Returns the payee.
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

/** Only the payer starts a payment, on any of their devices. Call after checkSettlement. */
export function checkPayer(repo: Repo, body: Pair, userId: string) {
  const payer = repo.member(body.fromMemberId)!;
  if (!isHeldBy(payer, userId)) {
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
  if (isHeldBy(payee, userId)) return;
  if (!payee.claimedByUserId && isHeldBy(payer, userId)) return;
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

/**
 * For settling a debt outside Lightning (Mark as settled, confirming a UPI
 * payment): not while an invoice for it is out, which could still be paid,
 * and then it's paid twice.
 */
export function checkNoPaymentUnderWay(repo: Repo, g: Group, body: Pair) {
  if (inProgressFor(repo, g, body)) {
    throw new SattleError(
      'conflict',
      'A Lightning payment for this is under way. Wait for it to finish or its invoice to expire, then try again.'
    );
  }
}

/** Non-terminal, and not an awaiting_payment whose quote has lapsed. Shared with the app, so it lives in @sattle/core. */
export { isInProgress };

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
