import { describe, expect, it } from 'vitest';

import type { Settlement } from '@sattle/core';
import { MockClient } from './MockClient';

/** A group kept in bitcoin: Yash, the mock's one user, and Dev, who paid 21,000 sats for both. */
async function meetup() {
  const c = new MockClient({ latencyMs: 0, settleDelayMs: 0 });
  const group = await c.createGroup({ name: 'Meetup', currency: 'btc', memberNames: ['Dev'] });
  const [yash, dev] = group.memberIds;
  const spend = (parts: Array<{ memberId: string; amount: number }>) =>
    c.addExpense({ groupId: group.id, description: 'Pizza', amount: 21_000, paidByMemberId: dev, splitMode: 'exact', parts });
  return { c, group, yash, dev, spend };
}

describe('MockClient and a group kept in bitcoin', () => {
  it('counts the group in sats, and says so when a split doesn’t add up', async () => {
    const { c, group, yash, dev, spend } = await meetup();
    expect(group.currency).toBe('BTC');

    await expect(
      spend([
        { memberId: yash, amount: 10_000 },
        { memberId: dev, amount: 10_000 },
      ])
    ).rejects.toThrow('Exact amounts add up to 20,000 sats, not 21,000 sats.');

    await spend([
      { memberId: yash, amount: 11_000 },
      { memberId: dev, amount: 10_000 },
    ]);
    expect(await c.getDebts(group.id)).toEqual([
      expect.objectContaining({ fromMemberId: yash, toMemberId: dev, amount: 11_000 }),
    ]);
  });

  it('asks for the sats owed, with no rate between them', async () => {
    const { c, group, yash, dev, spend } = await meetup();
    await spend([
      { memberId: yash, amount: 11_000 },
      { memberId: dev, amount: 10_000 },
    ]);
    await c.setMemberPayoutAddress(dev, 'dev@walletofsatoshi.com');

    const created = await c.createSettlement({
      groupId: group.id,
      fromMemberId: yash,
      toMemberId: dev,
      amount: 11_000,
      rail: 'lightning_address',
    });
    const quoted = await new Promise<Settlement>((resolve) => {
      const stop = c.onSettlementUpdate(created.id, (s) => {
        if (!s.quote) return;
        stop();
        resolve(s);
      });
    });

    expect(quoted.currency).toBe('BTC');
    // At the mock's rupee rate, 11,000 read as paise would have come to 1,222 sats.
    expect(quoted.quote).toMatchObject({ amountFiat: 11_000, amountSat: 11_000, rateFiatPerBtc: 1 });
    // The mock simulates, and the quote still says so.
    expect(quoted.quote?.rateSource).toEqual({ kind: 'demo' });
  });
});
