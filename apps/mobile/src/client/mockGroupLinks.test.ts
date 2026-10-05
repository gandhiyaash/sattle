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

  it('makes a new pay link when the same two people owe the same amount again', async () => {
    const c = new MockClient({ latencyMs: 0, settleDelayMs: 1 });
    const link = await c.createGroupLink('g-goa');
    const yash = (v: Awaited<ReturnType<typeof c.getGroupGuestView>>) => v.debts.find((d) => d.from === 'Yash' && d.to === 'Om')!;

    const before = yash(await c.getGroupGuestView(link.token));
    const first = (await c.payFromGroupLink(link.token, before.ref)).token;
    await c.openPayLink(first);
    // The mock's wallet pays on its own; wait for the page to say so.
    await new Promise<void>((done) => {
      const stop = c.onGuestViewUpdate(first, (v) => {
        if (v.settlement?.status !== 'confirmed') return;
        stop();
        done();
      });
    });

    // Om pays for something again, so Yash owes him the same amount as before.
    await c.addExpense({
      groupId: 'g-goa',
      description: 'Same again',
      amount: before.amount * 2,
      paidByMemberId: 'm-goa-om',
      splitMode: 'equal',
      parts: [{ memberId: 'm-goa-om' }, { memberId: 'm-goa-yash' }],
    });
    const after = yash(await c.getGroupGuestView(link.token));
    expect(after.amount).toBe(before.amount);
    const second = (await c.payFromGroupLink(link.token, after.ref)).token;
    expect(second).not.toBe(first);
    expect((await c.openPayLink(second)).settlement?.status).not.toBe('confirmed');
  });

  it('refuses a debt it never listed, and one whose payee can’t receive', async () => {
    const c = client();
    await expect(c.payFromGroupLink('demo-group', 'made-up')).rejects.toMatchObject({ code: 'link_expired' });

    const link = await c.createGroupLink('g-goa');
    const toAman = (await c.getGroupGuestView(link.token)).debts.find((d) => d.to === 'Aman')!;
    expect(toAman.payable).toBe(false);
    await expect(c.payFromGroupLink(link.token, toAman.ref)).rejects.toMatchObject({ code: 'member_cannot_receive' });
  });

  it('offers UPI on a debt only once the person owed turns it on, and gives the ID for that debt', async () => {
    const c = client();
    await c.setUpiId('yash@okaxis');
    const toYash = async () => (await c.getGroupGuestView('demo-group')).debts.find((d) => d.to === 'Yash')!;
    expect((await toYash()).upi).toBeUndefined();
    await expect(c.getGroupLinkUpi('demo-group', (await toYash()).ref)).rejects.toMatchObject({ code: 'member_cannot_receive' });

    expect((await c.setUpiOnGroupLinks(true)).onGroupLinks).toBe(true);
    const debt = await toYash();
    expect(debt.upi).toBe(true);
    expect(JSON.stringify(await c.getGroupGuestView('demo-group'))).not.toContain('yash@okaxis');
    expect(await c.getGroupLinkUpi('demo-group', debt.ref)).toEqual({ upiId: 'yash@okaxis', name: 'Yash' });

    await c.claimUpiFromGroupLink('demo-group', debt.ref);
    expect((await toYash()).upiClaim).toBe('pending');
    const [claim] = (await c.getUpiClaims('g-flat')).filter((x) => x.viaLink);
    expect(claim).toMatchObject({ amount: debt.amount, status: 'pending' });
  });
});
