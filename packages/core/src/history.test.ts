import { describe, expect, it } from 'vitest';

import { buildHistory, partChanges, sameExpense } from './history';
import type { Expense, ExpenseChange, Settlement } from './types';

const at = (minute: number) => `2026-10-05T10:${String(minute).padStart(2, '0')}:00.000Z`;

const expense = (id: string, minute: number, over: Partial<Expense> = {}): Expense => ({
  id,
  groupId: 'g',
  description: id,
  amount: 1000,
  paidByMemberId: 'a',
  splitMode: 'equal',
  parts: [
    { memberId: 'a', amount: 500 },
    { memberId: 'b', amount: 500 },
  ],
  createdAt: at(minute),
  addedByMemberId: 'a',
  ...over,
});

const settlement = (id: string, minute: number, over: Partial<Settlement> = {}): Settlement => ({
  id,
  groupId: 'g',
  fromMemberId: 'b',
  toMemberId: 'a',
  amount: 500,
  currency: 'INR',
  rail: 'invoice',
  status: 'confirmed',
  createdAt: at(minute - 1),
  updatedAt: at(minute),
  ...over,
});

describe('buildHistory', () => {
  it('lists what was added and what was settled, newest first', () => {
    const cab = expense('cab', 1);
    const tea = expense('tea', 3);
    const paid = settlement('s1', 2, { preimage: 'ab'.repeat(32) });

    expect(buildHistory([cab, tea], [], [paid])).toEqual([
      { kind: 'expense_added', id: 'added-tea', at: at(3), byMemberId: 'a', expense: tea },
      { kind: 'settled', id: 'settled-s1', at: at(2), settlement: paid },
      { kind: 'expense_added', id: 'added-cab', at: at(1), byMemberId: 'a', expense: cab },
    ]);
  });

  it('dates a settlement from when it was paid, not when it was started, and says whose word it was', () => {
    const manual = settlement('s1', 9, { rail: 'manual', status: 'manually_confirmed', recordedByMemberId: 'a' });
    expect(buildHistory([], [], [manual])).toMatchObject([{ kind: 'settled', at: at(9), byMemberId: 'a' }]);
  });

  it.each(['created', 'awaiting_payment', 'in_flight', 'failed', 'expired'] as const)(
    'leaves out a payment that is %s, which moved nothing',
    (status) => {
      expect(buildHistory([], [], [settlement('s1', 2, { status })])).toEqual([]);
    }
  );

  it('shows an edited expense as it was added, then each change with both sides of it', () => {
    const first = expense('cab', 1);
    const second = { ...first, amount: 1200 };
    const third = { ...second, description: 'Cabs' };
    const changes: ExpenseChange[] = [
      { id: '1', expenseId: 'cab', before: first, after: second, byMemberId: 'a', at: at(2) },
      { id: '2', expenseId: 'cab', before: second, after: third, byMemberId: 'b', at: at(3) },
    ];

    expect(buildHistory([third], changes, [])).toEqual([
      { kind: 'expense_changed', id: 'change-2', at: at(3), byMemberId: 'b', expense: third, before: second },
      { kind: 'expense_changed', id: 'change-1', at: at(2), byMemberId: 'a', expense: second, before: first },
      { kind: 'expense_added', id: 'added-cab', at: at(1), byMemberId: 'a', expense: first },
    ]);
  });

  it('keeps a removed expense: added as it was, and removed with what it said', () => {
    const cab = expense('cab', 1);
    const changes: ExpenseChange[] = [{ id: '1', expenseId: 'cab', before: cab, byMemberId: 'b', at: at(4) }];

    expect(buildHistory([], changes, [])).toEqual([
      { kind: 'expense_removed', id: 'change-1', at: at(4), byMemberId: 'b', before: cab },
      { kind: 'expense_added', id: 'added-cab', at: at(1), byMemberId: 'a', expense: cab },
    ]);
  });

  it('puts a change above the expense it changed when both happened in the same instant', () => {
    const first = expense('cab', 1);
    const second = { ...first, amount: 1200 };
    const changes: ExpenseChange[] = [
      { id: '1', expenseId: 'cab', before: first, after: second, at: at(1) },
      { id: '2', expenseId: 'cab', before: second, at: at(1) },
    ];
    expect(buildHistory([], changes, []).map((e) => e.id)).toEqual(['change-2', 'change-1', 'added-cab']);
  });

  describe('a change noted before how the expense read was kept', () => {
    it('shows the expense as it read after its first change, since that is the earliest reading there is', () => {
      const now = expense('cab', 1, { amount: 1200, addedByMemberId: undefined });
      const changes: ExpenseChange[] = [{ id: '1', expenseId: 'cab', after: now, at: at(2) }];

      expect(buildHistory([now], changes, [])).toEqual([
        { kind: 'expense_changed', id: 'change-1', at: at(2), expense: now },
        { kind: 'expense_added', id: 'added-cab', at: at(1), expense: now },
      ]);
    });

    it('says only that something was removed when nothing about it is left', () => {
      const changes: ExpenseChange[] = [{ id: '1', expenseId: 'cab', at: at(2) }];
      expect(buildHistory([], changes, [])).toEqual([{ kind: 'expense_removed', id: 'change-1', at: at(2) }]);
    });
  });
});

describe('partChanges', () => {
  it('gives each person’s part on both sides, with anyone taken out of the split last', () => {
    const before = expense('cab', 1);
    const after = expense('cab', 1, {
      amount: 1200,
      parts: [
        { memberId: 'c', amount: 600 },
        { memberId: 'a', amount: 600 },
      ],
    });

    expect(partChanges(before, after)).toEqual([
      { memberId: 'c', after: 600 },
      { memberId: 'a', before: 500, after: 600 },
      { memberId: 'b', before: 500 },
    ]);
  });
});

describe('sameExpense', () => {
  const cab = expense('cab', 1);

  it('is true for an expense saved as it stood, whoever added it and whenever', () => {
    expect(sameExpense(cab, { ...cab, parts: cab.parts.map((p) => ({ ...p })), createdAt: at(9), addedByMemberId: 'b' })).toBe(true);
  });

  it.each<[string, Partial<Expense>]>([
    ['its name', { description: 'Cabs' }],
    ['its amount', { amount: 1001 }],
    ['who paid', { paidByMemberId: 'b' }],
    ['how it is split', { splitMode: 'exact' }],
    ['someone’s part', { parts: [{ memberId: 'a', amount: 400 }, { memberId: 'b', amount: 600 }] }],
    ['who is in it', { parts: [{ memberId: 'a', amount: 1000 }] }],
  ])('is false once %s has changed', (_what, over) => {
    expect(sameExpense(cab, { ...cab, ...over })).toBe(false);
  });
});
