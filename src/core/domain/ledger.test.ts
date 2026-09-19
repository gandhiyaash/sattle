import { describe, expect, it } from 'vitest';

import { computeBalances, formatFiat, resolveParts, simplifyDebts } from './ledger';
import { resolveSettlementOptions } from './settlementOptions';
import type { Expense, Member, Settlement } from './types';

const expense = (paidBy: string, amount: number, ids: string[]): Expense => ({
  id: `e-${paidBy}-${amount}`,
  groupId: 'g',
  description: 'x',
  amount,
  paidByMemberId: paidBy,
  splitMode: 'equal',
  parts: resolveParts({
    groupId: 'g',
    description: 'x',
    amount,
    paidByMemberId: paidBy,
    splitMode: 'equal',
    parts: ids.map((memberId) => ({ memberId })),
  }),
  createdAt: '',
});

const settlement = (status: Settlement['status']): Settlement => ({
  id: 's',
  groupId: 'g',
  fromMemberId: 'b',
  toMemberId: 'a',
  amount: 500,
  currency: 'INR',
  rail: 'invoice',
  status,
  createdAt: '',
  updatedAt: '',
});

describe('resolveParts', () => {
  it('spreads the remainder a paisa at a time so parts sum exactly', () => {
    const parts = resolveParts({
      groupId: 'g', description: '', amount: 1000, paidByMemberId: 'a',
      splitMode: 'equal', parts: [{ memberId: 'a' }, { memberId: 'b' }, { memberId: 'c' }],
    });
    expect(parts.map((p) => p.amount)).toEqual([334, 333, 333]);
    expect(parts.reduce((s, p) => s + p.amount, 0)).toBe(1000);
  });

  it('weights by shares', () => {
    const parts = resolveParts({
      groupId: 'g', description: '', amount: 900, paidByMemberId: 'a',
      splitMode: 'shares', parts: [{ memberId: 'a', weight: 2 }, { memberId: 'b', weight: 1 }],
    });
    expect(parts.map((p) => p.amount)).toEqual([600, 300]);
  });

  it('rejects exact amounts that do not add up', () => {
    expect(() =>
      resolveParts({
        groupId: 'g', description: '', amount: 1000, paidByMemberId: 'a',
        splitMode: 'exact', parts: [{ memberId: 'a', amount: 400 }, { memberId: 'b', amount: 500 }],
      })
    ).toThrow(/add up/);
  });
});

describe('computeBalances', () => {
  it('balances always sum to zero', () => {
    const b = computeBalances(['a', 'b', 'c'], [expense('a', 1000, ['a', 'b', 'c'])]);
    expect(b.reduce((s, x) => s + x.net, 0)).toBe(0);
  });

  it('ignores settlements that are not confirmed', () => {
    const e = [expense('a', 1000, ['a', 'b'])];
    for (const status of ['created', 'awaiting_payment', 'in_flight', 'failed'] as const) {
      expect(computeBalances(['a', 'b'], e, [settlement(status)])).toEqual(computeBalances(['a', 'b'], e));
    }
  });

  it('moves on confirmed and manually confirmed settlements', () => {
    const e = [expense('a', 1000, ['a', 'b'])];
    expect(computeBalances(['a', 'b'], e, [settlement('confirmed')]).every((x) => x.net === 0)).toBe(true);
    expect(computeBalances(['a', 'b'], e, [settlement('manually_confirmed')]).every((x) => x.net === 0)).toBe(true);
  });
});

describe('simplifyDebts', () => {
  it('nets a chain into fewer payments', () => {
    const debts = simplifyDebts('g', [
      { memberId: 'a', net: 1000 },
      { memberId: 'b', net: 0 },
      { memberId: 'c', net: -1000 },
    ]);
    expect(debts).toHaveLength(1);
    expect(debts[0]).toMatchObject({ fromMemberId: 'c', toMemberId: 'a', amount: 1000 });
  });
});

describe('resolveSettlementOptions', () => {
  const ghost: Member = { id: 'm', groupId: 'g', displayName: 'Aman', status: 'ghost' };

  it('blocks a ghost by name and keeps manual in rails', () => {
    const o = resolveSettlementOptions({ recipient: ghost, walletAvailable: true });
    expect(o.blocked?.message).toContain('Aman');
    expect(o.rails.map((r) => r.rail)).toContain('manual');
  });

  it('unblocks a ghost once they have an address', () => {
    const o = resolveSettlementOptions({
      recipient: { ...ghost, lightningAddress: 'aman@walletofsatoshi.com' },
      walletAvailable: true,
    });
    expect(o.blocked).toBeUndefined();
    expect(o.rails[0].rail).toBe('lightning_address');
  });
});

describe('formatFiat', () => {
  it('formats rupees in Indian grouping', () => {
    expect(formatFiat(12000000)).toBe('₹1,20,000');
    expect(formatFiat(150)).toBe('₹1.50');
  });
});
