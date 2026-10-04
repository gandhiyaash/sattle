/**
 * Whether a payment is still under way: it hasn't finished, and it isn't an
 * invoice whose quote has lapsed, which can no longer be paid whatever its
 * status says.
 *
 * The server, the mock and the app all ask this, so they agree on when
 * something has to wait for a payment to finish.
 */

import { TERMINAL_STATUSES, type Settlement } from './types';

export function isInProgress(s: Pick<Settlement, 'status' | 'quote'>): boolean {
  if (TERMINAL_STATUSES.includes(s.status)) return false;
  if (s.status === 'awaiting_payment' && s.quote && Date.parse(s.quote.expiresAt) < Date.now()) return false;
  return true;
}
