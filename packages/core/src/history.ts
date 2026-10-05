/**
 * A group's history: every expense added, changed or removed, and every debt
 * settled, newest first.
 *
 * It isn't kept anywhere as a history. The expenses say how each reads now,
 * the changes say what every edit and removal did, and the settlements say
 * what was paid, so this reads the three back in the order they happened.
 * The server and the mock both build it here, so they tell the same story.
 */

import { LEDGER_STATUSES, type Expense, type ExpenseChange, type HistoryEntry, type Settlement } from './types';

/** `changes` in the order they were made. */
export function buildHistory(expenses: Expense[], changes: ExpenseChange[], settlements: Settlement[]): HistoryEntry[] {
  // An expense was added as it first read: before its first change, if it has had one. A change
  // noted before `before` was kept can't say how that was, so its expense is shown as it read after.
  const firstReading = new Map(expenses.map((e) => [e.id, e]));
  const changed = new Set<string>();
  for (const c of changes) {
    if (changed.has(c.expenseId)) continue;
    changed.add(c.expenseId);
    const reading = c.before ?? c.after;
    if (reading) firstReading.set(c.expenseId, reading);
  }

  const entries: HistoryEntry[] = [];
  for (const e of firstReading.values()) {
    entries.push({ kind: 'expense_added', id: `added-${e.id}`, at: e.createdAt, byMemberId: e.addedByMemberId, expense: e });
  }
  for (const c of changes) {
    const what = { id: `change-${c.id}`, at: c.at, byMemberId: c.byMemberId };
    entries.push(
      c.after
        ? { ...what, kind: 'expense_changed', expense: c.after, before: c.before }
        : { ...what, kind: 'expense_removed', before: c.before }
    );
  }
  for (const s of settlements) {
    if (!LEDGER_STATUSES.includes(s.status)) continue;
    entries.push({ kind: 'settled', id: `settled-${s.id}`, at: s.updatedAt, byMemberId: s.recordedByMemberId, settlement: s });
  }

  // Newest first. Things that happened in the same instant go the other way round from how they
  // were put in above, so a change sits above the expense being added, and a later change above
  // an earlier one. That is said here rather than left to the sort keeping ties where they were.
  return entries
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => (a.entry.at < b.entry.at ? 1 : a.entry.at > b.entry.at ? -1 : b.i - a.i))
    .map(({ entry }) => entry);
}

/** One person's part of an expense on either side of an edit. A side is absent when they weren't in the split then. */
export interface PartChange {
  memberId: string;
  before?: number;
  after?: number;
}

/**
 * Everyone who was in an expense's split before or after an edit, with their
 * part on each side: the people in it now first, then anyone taken out.
 */
export function partChanges(before: Expense, after: Expense): PartChange[] {
  const was = new Map(before.parts.map((p) => [p.memberId, p.amount]));
  const now = new Set(after.parts.map((p) => p.memberId));
  return [
    ...after.parts.map((p) => ({ memberId: p.memberId, before: was.get(p.memberId), after: p.amount })),
    ...before.parts.filter((p) => !now.has(p.memberId)).map((p) => ({ memberId: p.memberId, before: p.amount })),
  ];
}

/**
 * Whether an edit left the expense saying what it already said. Saving it
 * like that isn't a change, so nothing is noted for it.
 */
export function sameExpense(a: Expense, b: Expense): boolean {
  return (
    a.description === b.description &&
    a.amount === b.amount &&
    a.paidByMemberId === b.paidByMemberId &&
    a.splitMode === b.splitMode &&
    a.parts.length === b.parts.length &&
    a.parts.every((p, i) => p.memberId === b.parts[i].memberId && p.amount === b.parts[i].amount)
  );
}
