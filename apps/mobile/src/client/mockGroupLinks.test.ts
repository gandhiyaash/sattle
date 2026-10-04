import { describe, expect, it } from 'vitest';

import { MockClient } from './MockClient';

const client = () => new MockClient({ latencyMs: 0 });

describe('MockClient group links', () => {
  it('shares Flat 4B in the demo, and shows spends, shares and debts by name', async () => {
    const view = await client().getGroupGuestView('demo-group');
    expect(view.groupName).toBe('Flat 4B');
    expect(view.expenses.length).toBeGreaterThan(0);
    expect(view.expenses[0].shares.every((s) => typeof s.name === 'string' && s.amount > 0)).toBe(true);
    expect(view.debts.map((d) => d.to)).toContain('Yash');
    expect(JSON.stringify(view)).not.toMatch(/m-flat-|g-flat|u-yash/);
  });

  it('has no link for a group until one is made, and only one at a time', async () => {
    const c = client();
    expect(await c.getGroupLink('g-goa')).toBeNull();
    const first = await c.createGroupLink('g-goa');
    expect(await c.getGroupLink('g-goa')).toEqual(first);

    const second = await c.createGroupLink('g-goa');
    await expect(c.getGroupGuestView(first.token)).rejects.toMatchObject({ code: 'not_found' });
    expect((await c.getGroupGuestView(second.token)).groupName).toBe('Goa trip');
  });

  it('stops working when it is turned off', async () => {
    const c = client();
    await c.removeGroupLink('g-flat');
    expect(await c.getGroupLink('g-flat')).toBeNull();
    await expect(c.getGroupGuestView('demo-group')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('turns a debt on the page into a pay link that opens like any other', async () => {
    const c = client();
    const view = await c.getGroupGuestView('demo-group');
    const debt = view.debts.find((d) => d.from === 'Priya' && d.payable)!;

    const { token } = await c.payFromGroupLink('demo-group', debt.ref);
    expect((await c.payFromGroupLink('demo-group', debt.ref)).token).toBe(token);
    const opened = await c.openPayLink(token);
    expect(opened).toMatchObject({ payerName: 'Priya', payeeName: 'Yash', reason: 'Flat 4B' });
    expect(opened.settlement?.amount).toBe(debt.amount);
  });

  it('refuses a debt it never listed, and one whose payee can’t receive', async () => {
    const c = client();
    await expect(c.payFromGroupLink('demo-group', 'made-up')).rejects.toMatchObject({ code: 'link_expired' });

    const link = await c.createGroupLink('g-goa');
    const toAman = (await c.getGroupGuestView(link.token)).debts.find((d) => d.to === 'Aman')!;
    expect(toAman.payable).toBe(false);
    await expect(c.payFromGroupLink(link.token, toAman.ref)).rejects.toMatchObject({ code: 'member_cannot_receive' });
  });
});
