/**
 * Whether a payment is still under way: it hasn't finished, and it isn't an
 * invoice whose quote has lapsed, which can no longer be paid whatever its
 * status says.
 *
 * The server, the mock and the app all ask this, so they agree on when
 * something has to wait for a payment to finish.
 */

import { TERMINAL_STATUSES, type Debt, type Settlement } from './types';

export function isInProgress(s: Pick<Settlement, 'status' | 'quote'>): boolean {
  if (TERMINAL_STATUSES.includes(s.status)) return false;
  if (s.status === 'awaiting_payment' && s.quote && Date.parse(s.quote.expiresAt) < Date.now()) return false;
  return true;
}

/**
 * The invoice already out for this debt, if it can still be paid. The server
 * makes one at a time for a pair, so a sheet that is opened again picks this
 * up instead of asking for another and being refused. Only when it is for what
 * is owed now: after the debt has changed, it is no longer the one to pay.
 */
export function liveInvoiceFor(
  settlements: Settlement[],
  debt: Pick<Debt, 'fromMemberId' | 'toMemberId' | 'amount'>
): Settlement | undefined {
  return settlements.find(
    (s) =>
      s.rail === 'invoice' &&
      isInProgress(s) &&
      s.fromMemberId === debt.fromMemberId &&
      s.toMemberId === debt.toMemberId &&
      s.amount === debt.amount
  );
}
