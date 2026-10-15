import { describe, expect, it } from 'vitest';

import { MockClient } from './MockClient';

/** The seeded demo payment to Yash is in progress for 90s; these start after it lapses. */
const client = () => new MockClient({ latencyMs: 0 });

const yashPaid = async (c: MockClient) => (await c.getExpenses('g-goa')).find((e) => e.paidByMemberId === 'm-goa-yash')!;
const omPaid = async (c: MockClient) => (await c.getExpenses('g-goa')).find((e) => e.paidByMemberId === 'm-goa-om')!;

describe('MockClient: changing an expense', () => {
  it('lets the user change and remove what they paid', async () => {
    const c = client();
    const mine = await yashPaid(c);
    const input = { groupId: 'g-goa', description: 'Renamed', amount: 1000, paidByMemberId: 'm-goa-yash', splitMode: 'equal' as const, parts: [{ memberId: 'm-goa-yash' }, { memberId: 'm-goa-om' }] };

    const edited = await c.updateExpense(mine.id, input);
    expect(edited).toMatchObject({ id: mine.id, createdAt: mine.createdAt, description: 'Renamed', amount: 1000 });
    expect(edited.parts).toEqual([{ memberId: 'm-goa-yash', amount: 500 }, { memberId: 'm-goa-om', amount: 500 }]);

    await c.deleteExpense('g-goa', mine.id);
    expect((await c.getExpenses('g-goa')).map((e) => e.id)).not.toContain(mine.id);
  });

  it('refuses what a groupmate who has joined paid', async () => {
    const c = client();
    const theirs = await omPaid(c);
    await expect(c.deleteExpense('g-goa', theirs.id)).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'Only Om can change this, because they paid it.',
    });
  });
});

describe('MockClient: groups and members', () => {
  it('renames a group', async () => {
    const c = client();
    expect((await c.renameGroup('g-goa', ' Goa 2026 ')).name).toBe('Goa 2026');
    expect((await c.getGroup('g-goa')).name).toBe('Goa 2026');
  });

  it('pays back whoever paid in a group that doesn’t simplify its debts, until it does', async () => {
    const c = client();
    const g = await c.createGroup({ name: 'Flat', currency: 'INR', memberNames: ['Dev', 'Ira'], simplifyDebts: false });
    expect(g.simplifyDebts).toBe(false);
    const [me, dev, ira] = g.memberIds;
    // Dev owes the user 1000, and Ira owes Dev 1000.
    const spend = (paidByMemberId: string, ids: string[]) =>
      c.addExpense({ groupId: g.id, description: 'Rent', amount: 2000, paidByMemberId, splitMode: 'equal', parts: ids.map((memberId) => ({ memberId })) });
    await spend(me, [me, dev]);
    await spend(dev, [dev, ira]);
    const name = { [me]: 'Yash', [dev]: 'Dev', [ira]: 'Ira' };
    const owed = async () =>
      (await c.getDebts(g.id)).map((d) => `${name[d.fromMemberId]} → ${name[d.toMemberId]} ${d.amount}`).sort();
    expect(await owed()).toEqual(['Dev → Yash 1000', 'Ira → Dev 1000']);

    expect((await c.setSimplifyDebts(g.id, true)).simplifyDebts).toBe(true);
    expect(await owed()).toEqual(['Ira → Yash 1000']);
  });

  it('won’t change how a group’s debts are worked out while a payment in it is under way', async () => {
    await expect(client().setSimplifyDebts('g-flat', false)).rejects.toMatchObject({
      code: 'conflict',
      message: 'A payment in this group is still in progress. Wait for it to finish.',
    });
  });

  it('won’t delete a group while money is owed in it', async () => {
    await expect(client().deleteGroup('g-goa')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('deletes a group that has nothing owed', async () => {
    const c = client();
    const g = await c.createGroup({ name: 'Empty', currency: 'INR', memberNames: ['Dev'], simplifyDebts: true });
    await c.deleteGroup(g.id);
    expect((await c.getGroups()).map((x) => x.id)).not.toContain(g.id);
  });

  it('removes a ghost added by mistake, but not one who is in an expense or has joined', async () => {
    const c = client();
    const typo = await c.addMember('g-goa', 'Amna');
    await c.removeMember('g-goa', typo.id);
    expect((await c.getMembers('g-goa')).map((m) => m.id)).not.toContain(typo.id);

    await expect(c.removeMember('g-goa', 'm-goa-aman')).rejects.toMatchObject({ code: 'conflict' });
    await expect(c.removeMember('g-goa', 'm-goa-om')).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('takes the user out of a group they leave, and leaves their row behind as a ghost', async () => {
    const c = client();
    await c.leaveGroup('g-goa');
    expect((await c.getGroups()).map((g) => g.id)).toEqual(['g-flat']);
    expect((await c.getMembers('g-goa')).find((m) => m.id === 'm-goa-yash')).toEqual({
      id: 'm-goa-yash', groupId: 'g-goa', displayName: 'Yash', status: 'ghost',
    });
  });

  it('won’t let the only person with an account leave', async () => {
    const c = client();
    const g = await c.createGroup({ name: 'Solo', currency: 'INR', memberNames: ['Dev'], simplifyDebts: true });
    await expect(c.leaveGroup(g.id)).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('MockClient: wallet and account', () => {
  it('won’t disconnect or leave while the seeded payment to the user is in progress', async () => {
    const c = client();
    await c.connectWallet('nostr+walletconnect://abc');
    await expect(c.disconnectWallet()).rejects.toMatchObject({ code: 'conflict' });
    await expect(c.leaveGroup('g-flat')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('disconnects once nothing is on its way, putting the user’s members back to joined', async () => {
    const c = client();
    await c.connectWallet('nostr+walletconnect://abc');
    // The demo invoice is the only thing in progress; a lapsed quote no longer counts.
    const realNow = Date.now;
    Date.now = () => realNow() + 120_000;
    try {
      expect(await c.disconnectWallet()).toEqual({ connected: false, methods: [], excessMethods: [] });
    } finally {
      Date.now = realNow;
    }
    expect((await c.getMembers('g-goa')).find((m) => m.id === 'm-goa-yash')?.status).toBe('joined');
  });

  it('has no account to delete', async () => {
    await expect(client().deleteAccount()).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
