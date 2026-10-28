import { describe, expect, it } from 'vitest';

import { convertForeign } from '@sattle/core';

import { MockClient } from './MockClient';

const client = () => new MockClient({ latencyMs: 0 });

const tukTuk = (amount: number, original?: { currency: string; amount: number; rate: number }) => ({
  groupId: 'g-goa',
  description: 'Tuk-tuk',
  amount,
  paidByMemberId: 'm-goa-yash',
  splitMode: 'equal' as const,
  parts: [{ memberId: 'm-goa-yash' }, { memberId: 'm-goa-om' }],
  ...(original ? { original } : {}),
});

describe('MockClient: an expense paid in another currency', () => {
  it('prices a baht in paise, and a dollar in sats', async () => {
    const c = client();
    // ₹90,00,000 and ฿35,00,000 a bitcoin: a baht is about ₹2.57.
    expect((await c.getConversionRate('THB', 'INR')).rate).toBe(257.143);
    expect((await c.getConversionRate('USD', 'BTC')).rate).toBe(952.381);
  });

  it('keeps what was paid, and drops it when changed back to rupees', async () => {
    const c = client();
    const { rate } = await c.getConversionRate('THB', 'INR');
    const original = { currency: 'THB', amount: 40_000, rate };
    const added = await c.addExpense(tukTuk(convertForeign(original), original));
    expect(added.original).toEqual(original);

    const back = await c.updateExpense(added.id, tukTuk(100_000));
    expect(back.original).toBeUndefined();
    expect((await c.getExpenses('g-goa')).find((e) => e.id === added.id)?.original).toBeUndefined();
  });

  it('refuses an amount that isn’t what was paid at that rate', async () => {
    const c = client();
    await expect(c.addExpense(tukTuk(1, { currency: 'THB', amount: 40_000, rate: 257 }))).rejects.toMatchObject({
      code: 'invalid_expense',
    });
  });
});
