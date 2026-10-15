import { describe, expect, it } from 'vitest';

import { computeBalances, directDebts, groupDebts, resolveParts, simplifyDebts } from './ledger';
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

describe('directDebts', () => {
  const pairs = (debts: { fromMemberId: string; toMemberId: string; amount: number }[]) =>
    debts.map((d) => `${d.fromMemberId}->${d.toMemberId} ${d.amount}`);

  it('has everyone pay back whoever paid, instead of passing a debt along', () => {
    // b owes a 500, c owes b 500.
    const e = [expense('a', 1000, ['a', 'b']), expense('b', 1000, ['b', 'c'])];
    expect(pairs(directDebts('g', e))).toEqual(['b->a 500', 'c->b 500']);
  });

  it('cancels what two people owe each other', () => {
    // b owes a 500, a owes b 300.
    const e = [expense('a', 1000, ['a', 'b']), expense('b', 600, ['a', 'b'])];
    expect(pairs(directDebts('g', e))).toEqual(['b->a 200']);
  });

  it('counts a settlement against its pair once it is confirmed', () => {
    const e = [expense('a', 1000, ['a', 'b'])];
    expect(directDebts('g', e, [settlement('confirmed')])).toEqual([]);
    expect(pairs(directDebts('g', e, [settlement('created')]))).toEqual(['b->a 500']);
  });

  it('leaves everyone with the same total as computeBalances', () => {
    const e = [
      expense('a', 1000, ['a', 'b', 'c']),
      expense('b', 2400, ['a', 'b', 'c', 'd']),
      expense('d', 700, ['b', 'c']),
    ];
    const s = [settlement('confirmed')];
    const total = new Map<string, number>();
    for (const d of directDebts('g', e, s)) {
      total.set(d.fromMemberId, (total.get(d.fromMemberId) ?? 0) - d.amount);
      total.set(d.toMemberId, (total.get(d.toMemberId) ?? 0) + d.amount);
    }
    for (const b of computeBalances(['a', 'b', 'c', 'd'], e, s)) expect(total.get(b.memberId) ?? 0).toBe(b.net);
  });
});

describe('groupDebts', () => {
  // a pays for b, b for c, c for a: everyone is square, but each owes the next.
  const e = [expense('a', 1000, ['a', 'b']), expense('b', 1000, ['b', 'c']), expense('c', 1000, ['c', 'a'])];
  const group = { id: 'g', memberIds: ['a', 'b', 'c'] };

  it('simplifies for a group that does', () => {
    expect(groupDebts({ ...group, simplifyDebts: true }, e)).toEqual([]);
  });

  it('pays back whoever paid for a group that doesn’t', () => {
    expect(groupDebts({ ...group, simplifyDebts: false }, e)).toHaveLength(3);
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

  it('leaves marking it settled to a payee who has joined', () => {
    const om: Member = { id: 'm-om', groupId: 'g', displayName: 'Om', status: 'joined', claimedByUserId: 'u-om' };
    const manual = resolveSettlementOptions({ recipient: om, walletAvailable: true }).rails.find((r) => r.rail === 'manual');
    expect(manual?.availability.available).toBe(false);
    expect(manual?.detail).toContain('Om');

    const ghostManual = resolveSettlementOptions({ recipient: ghost, walletAvailable: true }).rails.find((r) => r.rail === 'manual');
    expect(ghostManual?.availability.available).toBe(true);
  });
});
