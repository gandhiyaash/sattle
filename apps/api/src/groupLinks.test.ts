import { describe, expect, it } from 'vitest';

import type { Expense, Group, GroupGuestView, GroupLink, GuestView, Member, User } from '@sattle/core';

import { createApp } from './app';
import { openDb, seedIfEmpty } from './db';
import { SimulatedPayments } from './payments';

/**
 * A production-shaped server: no fixtures, no demo user. Riya made "Manali"
 * with Kabir and Aman as ghosts, and paid for the cab: each of them owes her ₹10.
 */
async function setup() {
  const db = openDb(':memory:');
  const app = createApp({
    db,
    payments: (repo) =>
      new SimulatedPayments(repo, { stepMs: 1, settleDelayMs: 60_000, rateFiatPerBtc: 9_000_000, alwaysFail: false }),
  });
  async function call<T = unknown>(method: string, path: string, body?: unknown, token?: string) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as T };
  }
  const signUp = async (displayName: string) =>
    (await call<{ user: User; token: string }>('POST', '/accounts', { displayName })).body;

  const riya = await signUp('Riya');
  const group = (await call<Group>('POST', '/groups', { name: 'Manali', memberNames: ['Kabir', 'Aman'] }, riya.token)).body;
  const [mRiya, mKabir, mAman] = group.memberIds;
  const base = `/groups/${group.id}`;
  const addExpense = (paidByMemberId: string, amount: number, description = 'Cab') =>
    call<Expense>(
      'POST',
      `${base}/expenses`,
      { description, amount, paidByMemberId, splitMode: 'equal', parts: group.memberIds.map((memberId) => ({ memberId })) },
      riya.token
    );
  await addExpense(mRiya, 3000);

  const share = async (as = riya.token) => (await call<GroupLink>('POST', `${base}/link`, undefined, as)).body.token;
  const view = (token: string) => call<GroupGuestView>('GET', `/g/${token}`);
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  return { db, call, signUp, riya, group, base, mRiya, mKabir, mAman, addExpense, share, view, count };
}

describe('the group’s link', () => {
  it('doesn’t exist until someone in the group makes one', async () => {
    const { call, base, riya } = await setup();
    expect((await call('GET', `${base}/link`, undefined, riya.token)).body).toBeNull();
  });

  it('is made by anyone in the group, and read back by them', async () => {
    const { call, base, group, riya } = await setup();
    const made = await call<GroupLink>('POST', `${base}/link`, undefined, riya.token);
    expect(made.status).toBe(201);
    expect(made.body.groupId).toBe(group.id);
    expect(made.body.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect((await call('GET', `${base}/link`, undefined, riya.token)).body).toEqual(made.body);
  });

  it('is out of reach of anyone outside the group', async () => {
    const { call, base, signUp, share } = await setup();
    await share();
    const stranger = (await signUp('Stranger')).token;
    expect((await call('GET', `${base}/link`, undefined, stranger)).status).toBe(404);
    expect((await call('POST', `${base}/link`, undefined, stranger)).status).toBe(404);
    expect((await call('DELETE', `${base}/link`, undefined, stranger)).status).toBe(404);
    expect((await call('POST', `${base}/link`)).status).toBe(401);
  });

  it('is one at a time: making another takes the old one back', async () => {
    const { share, view, count } = await setup();
    const first = await share();
    const second = await share();
    expect(second).not.toBe(first);
    expect((await view(first)).status).toBe(404);
    expect((await view(second)).status).toBe(200);
    expect(count('group_links')).toBe(1);
  });

  it('can be turned off by anyone in the group', async () => {
    const { call, base, riya, share, view } = await setup();
    const token = await share();
    expect((await call('DELETE', `${base}/link`, undefined, riya.token)).status).toBe(200);
    expect((await view(token)).status).toBe(404);
    expect((await call('GET', `${base}/link`, undefined, riya.token)).body).toBeNull();
  });

  it('never expires by itself, and survives the person who made it leaving', async () => {
    const { db, call, base, riya, signUp, mKabir, share, view } = await setup();
    const kabir = await signUp('Kabir');
    const invite = (await call<{ token: string }>('POST', `${base}/invites`, { memberId: mKabir }, riya.token)).body.token;
    await call('POST', '/groups/join', { token: invite }, kabir.token);
    const token = await share(kabir.token);

    db.prepare('UPDATE group_links SET created_at = ?').run('2020-01-01T00:00:00.000Z');
    await call('POST', `${base}/leave`, undefined, kabir.token);
    expect((await view(token)).status).toBe(200);
  });

  it('goes with the group when the group is deleted', async () => {
    const { call, riya, view, count } = await setup();
    const empty = (await call<Group>('POST', '/groups', { name: 'Empty', memberNames: [] }, riya.token)).body;
    const token = (await call<GroupLink>('POST', `/groups/${empty.id}/link`, undefined, riya.token)).body.token;
    expect((await call('DELETE', `/groups/${empty.id}`, undefined, riya.token)).status).toBe(200);
    expect((await view(token)).status).toBe(404);
    expect(count('group_links')).toBe(0);
  });
});

describe('GET /g/:token', () => {
  it('shows the group to anyone holding the link: spends, each person’s share, who owes whom', async () => {
    const { share, view } = await setup();
    const res = await view(await share());
    expect(res.status).toBe(200);
    // The two debts are the same size, so their order follows the members' random ids.
    res.body.debts.sort((a, b) => a.from.localeCompare(b.from));
    expect(res.body).toEqual({
      groupName: 'Manali',
      currency: 'INR',
      expenses: [
        {
          description: 'Cab',
          amount: 3000,
          paidBy: 'Riya',
          shares: [{ name: 'Riya', amount: 1000 }, { name: 'Kabir', amount: 1000 }, { name: 'Aman', amount: 1000 }],
          createdAt: expect.any(String),
        },
      ],
      debts: [
        { ref: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/), from: 'Aman', to: 'Riya', amount: 1000, payable: true },
        { ref: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/), from: 'Kabir', to: 'Riya', amount: 1000, payable: true },
      ],
    });
  });

  it('carries names and amounts, never an id', async () => {
    const { share, view, group, riya } = await setup();
    const text = JSON.stringify((await view(await share())).body);
    for (const id of [group.id, ...group.memberIds, riya.user.id]) expect(text).not.toContain(id);
    expect(text).not.toMatch(/"(id|groupId|memberId|fromMemberId|toMemberId|claimedByUserId)"/);
  });

  it('says when the person owed has nowhere to receive', async () => {
    const { share, view, addExpense, mKabir } = await setup();
    await addExpense(mKabir, 9000, 'Hotel');
    const debts = (await view(await share())).body.debts;
    expect(debts).toContainEqual(expect.objectContaining({ to: 'Kabir', payable: false }));
  });

  it('is 404 for a link nobody made', async () => {
    const { view } = await setup();
    expect((await view('nope')).status).toBe(404);
  });
});

describe('POST /g/:token/debts/:ref/pay-link', () => {
  const kabirs = (v: GroupGuestView) => v.debts.find((d) => d.from === 'Kabir')!;

  it('hands back a pay link for that debt, which opens and mints like any other', async () => {
    const { call, share, view } = await setup();
    const token = await share();
    const debt = kabirs((await view(token)).body);

    const res = await call<{ token: string }>('POST', `/g/${token}/debts/${debt.ref}/pay-link`);
    expect(res.status).toBe(201);
    const opened = await call<GuestView>('POST', `/s/${res.body.token}/open`);
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ payerName: 'Kabir', payeeName: 'Riya', reason: 'Manali', settlement: { amount: 1000 } });
  });

  it('needs no account', async () => {
    const { call, share, view } = await setup();
    const token = await share();
    const res = await call('POST', `/g/${token}/debts/${kabirs((await view(token)).body).ref}/pay-link`);
    expect(res.status).not.toBe(401);
  });

  it('gives the same pay link for the same debt, so the route can’t pile up rows', async () => {
    const { call, share, view, count } = await setup();
    const token = await share();
    const path = `/g/${token}/debts/${kabirs((await view(token)).body).ref}/pay-link`;
    const first = (await call<{ token: string }>('POST', path)).body.token;
    const second = (await call<{ token: string }>('POST', path)).body.token;
    expect(second).toBe(first);
    expect(count('pay_links')).toBe(1);
  });

  it('is refused once that debt has been settled, and the page stops listing it', async () => {
    const { call, base, riya, mRiya, mKabir, share, view } = await setup();
    const token = await share();
    const debt = kabirs((await view(token)).body);
    await call('POST', `${base}/settlements/manual`, { fromMemberId: mKabir, toMemberId: mRiya, amount: 1000 }, riya.token);

    const res = await call<{ code: string }>('POST', `/g/${token}/debts/${debt.ref}/pay-link`);
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('link_expired');
    expect((await view(token)).body.debts.map((d) => d.from)).toEqual(['Aman']);
  });

  it('is refused when the person owed has nowhere to receive', async () => {
    const { call, share, view, addExpense, mKabir } = await setup();
    await addExpense(mKabir, 9000, 'Hotel');
    const token = await share();
    const toKabir = (await view(token)).body.debts.find((d) => d.to === 'Kabir')!;
    const res = await call<{ code: string }>('POST', `/g/${token}/debts/${toKabir.ref}/pay-link`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('member_cannot_receive');
  });

  it('files a ghost’s pay link under the group’s first account', async () => {
    const { db, call, riya, share, view, addExpense, mKabir } = await setup();
    await addExpense(mKabir, 9000, 'Hotel');
    await call('PUT', `/members/${mKabir}/payout-address`, { address: 'kabir@walletofsatoshi.com' }, riya.token);
    const token = await share();
    const toKabir = (await view(token)).body.debts.find((d) => d.to === 'Kabir')!;
    expect(toKabir.payable).toBe(true);

    const res = await call<{ token: string }>('POST', `/g/${token}/debts/${toKabir.ref}/pay-link`);
    expect(res.status).toBe(201);
    const row = db.prepare('SELECT created_by_user_id AS owner FROM pay_links WHERE token = ?').get(res.body.token);
    expect(row).toEqual({ owner: riya.user.id });
  });

  it('won’t take a debt’s ref from another link, or a ref it never gave out', async () => {
    const { call, share, view } = await setup();
    const old = await share();
    const stale = kabirs((await view(old)).body).ref;
    const fresh = await share();
    expect((await call('POST', `/g/${fresh}/debts/${stale}/pay-link`)).status).toBe(410);
    expect((await call('POST', `/g/${fresh}/debts/made-up/pay-link`)).status).toBe(410);
    expect((await call('POST', `/g/${old}/debts/${stale}/pay-link`)).status).toBe(404);
  });
});

describe('holding the link changes nothing', () => {
  it('offers no way to write to the group: only reading it, and asking to pay a debt', async () => {
    const { call, base, share, group, mKabir } = await setup();
    const token = await share();
    for (const [method, path, body] of [
      ['PUT', `/g/${token}`, { name: 'Mine now' }],
      ['DELETE', `/g/${token}`, undefined],
      ['POST', `/g/${token}/expenses`, { description: 'x', amount: 1 }],
      ['DELETE', `/g/${token}/members/${mKabir}`, undefined],
    ] as const) {
      expect([method, path, (await call(method, path, body)).status]).toEqual([method, path, 404]);
    }
    // And the group's own routes still want an account.
    expect((await call('PUT', base, { name: 'Mine now' })).status).toBe(401);
    expect((await call('POST', `${base}/expenses`, { description: 'x', amount: 1 })).status).toBe(401);
    expect((await call<Member[]>('GET', `/groups/${group.id}/members`)).status).toBe(401);
  });
});

describe('the demo data', () => {
  it('shares Flat 4B at /g/demo-group', async () => {
    const db = openDb(':memory:');
    seedIfEmpty(db);
    const app = createApp({
      db,
      payments: (repo) =>
        new SimulatedPayments(repo, { stepMs: 1, settleDelayMs: 1, rateFiatPerBtc: 9_000_000, alwaysFail: false }),
    });
    const res = await app.request('/g/demo-group');
    expect(res.status).toBe(200);
    expect(((await res.json()) as GroupGuestView).groupName).toBe('Flat 4B');
  });
});
