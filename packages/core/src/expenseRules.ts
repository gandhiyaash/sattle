/**
 * Who may change or remove an expense.
 *
 * An expense says the payer is owed money back, so undoing or shrinking it
 * costs the payer: they are the one who may. A ghost payer has no account to
 * ask, so anyone in the group may change what a ghost paid. The server
 * enforces the same rule (PUT and DELETE /groups/:id/expenses/:expenseId).
 */

import type { Member } from './types';

export function canChangeExpense(payer: Pick<Member, 'claimedByUserId'> | undefined, userId: string): boolean {
  return !payer?.claimedByUserId || payer.claimedByUserId === userId;
}
