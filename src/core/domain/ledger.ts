/**
 * Ledger maths. Pure functions, no I/O, safe to import on the server so both
 * sides net debts with the same code.
 *
 * All amounts are integer minor units. Nothing here ever sees a float.
 */

import {
  LEDGER_STATUSES,
  SplitSatsError,
  type Balance,
  type Debt,
  type Expense,
  type ExpenseInput,
  type ResolvedPart,
  type Settlement,
} from './types';

/**
 * Turns an expense's split instructions into exact per-member amounts.
 * Remainders are spread one minor unit at a time, in part order, so the
 * parts always sum to the total.
 */
export function resolveParts(input: ExpenseInput): ResolvedPart[] {
  const { amount, parts, splitMode } = input;

  if (!Number.isInteger(amount) || amount <= 0) {
    throw new SplitSatsError('invalid_expense', 'Amount must be a positive whole number of minor units.');
  }
  if (parts.length === 0) {
    throw new SplitSatsError('invalid_expense', 'An expense needs at least one person.');
  }

  if (splitMode === 'exact') {
    const resolved = parts.map((p) => ({ memberId: p.memberId, amount: p.amount ?? 0 }));
    const sum = resolved.reduce((acc, p) => acc + p.amount, 0);
    if (sum !== amount) {
      throw new SplitSatsError(
        'invalid_expense',
        `Exact amounts add up to ${formatFiat(sum)}, not ${formatFiat(amount)}.`
      );
    }
    return resolved;
  }

  const weights = parts.map((p) => (splitMode === 'shares' ? (p.weight ?? 1) : 1));
  if (weights.some((w) => !(w > 0))) {
    throw new SplitSatsError('invalid_expense', 'Shares must be greater than zero.');
  }
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const base = weights.map((w) => Math.floor((amount * w) / totalWeight));
  let remainder = amount - base.reduce((a, b) => a + b, 0);

  const resolved = parts.map((p, i) => ({ memberId: p.memberId, amount: base[i] }));
  for (let i = 0; remainder > 0; i = (i + 1) % resolved.length) {
    resolved[i].amount += 1;
    remainder -= 1;
  }
  return resolved;
}

/**
 * Net position per member. Settlements count only once they are confirmed
 * or manually confirmed — the ledger moves on preimage, never on optimism.
 */
export function computeBalances(
  memberIds: string[],
  expenses: Expense[],
  settlements: Settlement[] = []
): Balance[] {
  const net = new Map<string, number>(memberIds.map((id) => [id, 0]));
  const add = (id: string, delta: number) => net.set(id, (net.get(id) ?? 0) + delta);

  for (const e of expenses) {
    add(e.paidByMemberId, e.amount);
    for (const p of e.parts) add(p.memberId, -p.amount);
  }

  for (const s of settlements) {
    if (!LEDGER_STATUSES.includes(s.status)) continue;
    add(s.fromMemberId, s.amount);
    add(s.toMemberId, -s.amount);
  }

  return [...net.entries()].map(([memberId, n]) => ({ memberId, net: n }));
}

/**
 * Greedy netting: repeatedly match the largest debtor with the largest
 * creditor. Produces at most n-1 payments for n members.
 */
export function simplifyDebts(groupId: string, balances: Balance[]): Debt[] {
  const debtors = balances
    .filter((b) => b.net < 0)
    .map((b) => ({ id: b.memberId, amt: -b.net }))
    .sort((a, b) => b.amt - a.amt || a.id.localeCompare(b.id));
  const creditors = balances
    .filter((b) => b.net > 0)
    .map((b) => ({ id: b.memberId, amt: b.net }))
    .sort((a, b) => b.amt - a.amt || a.id.localeCompare(b.id));

  const debts: Debt[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amt, creditors[j].amt);
    if (pay > 0) {
      debts.push({
        id: `${groupId}:${debtors[i].id}->${creditors[j].id}`,
        groupId,
        fromMemberId: debtors[i].id,
        toMemberId: creditors[j].id,
        amount: pay,
      });
    }
    debtors[i].amt -= pay;
    creditors[j].amt -= pay;
    if (debtors[i].amt === 0) i++;
    if (creditors[j].amt === 0) j++;
  }
  return debts;
}

/** ₹1,200 rather than ₹1,200.00; paise shown only when there are some. */
export function formatFiat(minor: number, currency = 'INR'): string {
  const major = minor / 100;
  const hasFraction = minor % 100 !== 0;
  return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(major);
}
