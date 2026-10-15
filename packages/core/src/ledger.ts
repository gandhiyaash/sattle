/**
 * Ledger maths. Pure functions, no I/O, safe to import on the server so both
 * sides net debts with the same code.
 *
 * All amounts are integer minor units. Nothing here ever sees a float.
 */

import { formatAmount } from './currency';
import {
  LEDGER_STATUSES,
  SattleError,
  type Balance,
  type Debt,
  type Expense,
  type ExpenseInput,
  type Group,
  type ResolvedPart,
  type Settlement,
} from './types';

/**
 * Turns an expense's split instructions into exact per-member amounts.
 * Remainders are spread one minor unit at a time, in part order, so the
 * parts always sum to the total. `currency` is the group's, and only words
 * the message when exact amounts don't add up.
 */
export function resolveParts(input: ExpenseInput, currency = 'INR'): ResolvedPart[] {
  const { amount, parts, splitMode } = input;

  if (!Number.isInteger(amount) || amount <= 0) {
    throw new SattleError('invalid_expense', 'Amount must be a positive whole number of minor units.');
  }
  if (parts.length === 0) {
    throw new SattleError('invalid_expense', 'An expense needs at least one person.');
  }

  if (splitMode === 'exact') {
    const resolved = parts.map((p) => ({ memberId: p.memberId, amount: p.amount ?? 0 }));
    const sum = resolved.reduce((acc, p) => acc + p.amount, 0);
    if (sum !== amount) {
      throw new SattleError(
        'invalid_expense',
        `Exact amounts add up to ${formatAmount(sum, currency)}, not ${formatAmount(amount, currency)}.`
      );
    }
    return resolved;
  }

  const weights = parts.map((p) => (splitMode === 'shares' ? (p.weight ?? 1) : 1));
  if (weights.some((w) => !(w > 0))) {
    throw new SattleError('invalid_expense', 'Shares must be greater than zero.');
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

/**
 * Debts without simplifying: everyone in a split owes whoever paid it their
 * part, and only what two people owe each other cancels out. Nothing is
 * passed on to a third person, so it can take more payments than
 * simplifyDebts, but each one goes back to someone who paid. A settlement
 * counts against the pair it was between, on the same terms as
 * computeBalances.
 *
 * Every member's total comes out the same as computeBalances'. Only how it's
 * divided into payments differs.
 */
export function directDebts(groupId: string, expenses: Expense[], settlements: Settlement[] = []): Debt[] {
  // owes.get(a).get(b): everything a has ever owed b, before anything b owes a is taken off.
  const owes = new Map<string, Map<string, number>>();
  const add = (from: string, to: string, amount: number) => {
    if (from === to) return;
    const row = owes.get(from) ?? new Map<string, number>();
    row.set(to, (row.get(to) ?? 0) + amount);
    owes.set(from, row);
  };

  for (const e of expenses) {
    for (const p of e.parts) add(p.memberId, e.paidByMemberId, p.amount);
  }
  // Paying someone back is the same as their owing you that much.
  for (const s of settlements) {
    if (LEDGER_STATUSES.includes(s.status)) add(s.toMemberId, s.fromMemberId, s.amount);
  }

  const debts: Debt[] = [];
  for (const [from, row] of owes) {
    for (const [to, amount] of row) {
      const net = amount - (owes.get(to)?.get(from) ?? 0);
      if (net > 0) {
        debts.push({ id: `${groupId}:${from}->${to}`, groupId, fromMemberId: from, toMemberId: to, amount: net });
      }
    }
  }
  return debts.sort(
    (a, b) =>
      b.amount - a.amount ||
      a.fromMemberId.localeCompare(b.fromMemberId) ||
      a.toMemberId.localeCompare(b.toMemberId)
  );
}

/**
 * What is owed in a group, the way that group settles up: simplified, or
 * straight back to whoever paid (Group.simplifyDebts). Whatever asks what is
 * owed asks this, so the app, the server and a restored backup agree.
 */
export function groupDebts(
  group: Pick<Group, 'id' | 'memberIds' | 'simplifyDebts'>,
  expenses: Expense[],
  settlements: Settlement[] = []
): Debt[] {
  return group.simplifyDebts
    ? simplifyDebts(group.id, computeBalances(group.memberIds, expenses, settlements))
    : directDebts(group.id, expenses, settlements);
}
