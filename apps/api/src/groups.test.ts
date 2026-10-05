import { describe, expect, it } from 'vitest';

import type { Debt, Expense, Group, Member } from '@sattle/core';

import { createApp } from './app';
import { openDb, seedIfEmpty } from './db';
import { SimulatedPayments } from './payments';

function setup() {
  const db = openDb(':memory:');
  seedIfEmpty(db);
  const app = createApp({
    db,
    demoUserId: 'u-yash',
    payments: (repo) =>
      new SimulatedPayments(repo, { stepMs: 1, settleDelayMs: 1, rateFiatPerBtc: 9_000_000, alwaysFail: false }),
  });

  async function call<T = unknown>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await app.request(path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  const createGroup = async (memberNames = ['Riya', 'Kabir']) => {
    const res = await call<Group>('POST', '/groups', { name: 'Manali', memberNames });
    expect(res.status).toBe(201);
    return res.body;
  };

  const members = async (groupId: string) => (await call<Member[]>('GET', `/groups/${groupId}/members`)).body;

  return { db, call, createGroup, members };
}

describe('POST /groups', () => {
  it('makes the creator a joined, claimed member and everyone else a ghost', async () => {
    const { createGroup, members } = setup();
    const g = await createGroup();
    expect(g).toMatchObject({ name: 'Manali', currency: 'INR' });
    expect(g.memberIds).toHaveLength(3);

    const ms = await members(g.id);
    expect(ms.map((m) => m.id)).toEqual(g.memberIds);
    expect(ms.map((m) => [m.displayName, m.status, m.claimedByUserId])).toEqual([
      ['Yash', 'joined', 'u-yash'],
      ['Riya', 'ghost', undefined],
      ['Kabir', 'ghost', undefined],
    ]);
  });

  it('makes a creator with a connected wallet nwc_linked, like their other groups', async () => {
    const { db, createGroup, members } = setup();
    db.prepare(
      `INSERT INTO wallet_connections (user_id, nwc_uri, wallet_pubkey, methods, alias, connected_at)
       VALUES ('u-yash', 'nostr+walletconnect://x', 'x', '[]', NULL, '2026-10-01')`
    ).run();
    const g = await createGroup();
    expect((await members(g.id))[0].status).toBe('nwc_linked');
  });

  it('allows a group of just the creator', async () => {
    const { createGroup } = setup();
    expect((await createGroup([])).memberIds).toHaveLength(1);
  });

  it('lists the new group first and lets it take expenses', async () => {
    const { call, createGroup } = setup();
    const g = await createGroup();
    expect((await call<Group[]>('GET', '/groups')).body[0].id).toBe(g.id);

    const [me, riya] = g.memberIds;
    const expense = await call<Expense>('POST', `/groups/${g.id}/expenses`, {
      description: 'Fuel',
      amount: 2000,
      paidByMemberId: me,
      splitMode: 'equal',
      parts: [{ memberId: me }, { memberId: riya }],
    });
    expect(expense.status).toBe(201);
    const debts = (await call<Debt[]>('GET', `/groups/${g.id}/debts`)).body;
    expect(debts).toEqual([expect.objectContaining({ fromMemberId: riya, toMemberId: me, amount: 1000 })]);
  });

  it('hides the group from people who aren’t in it', async () => {
    const { db, call, createGroup } = setup();
    const g = await createGroup();
    db.prepare("UPDATE users SET token = 't-om' WHERE id = 'u-om'").run();
    const asOm = { authorization: 'Bearer t-om' };
    expect((await call('GET', `/groups/${g.id}`, undefined, asOm)).status).toBe(404);
    expect((await call('POST', `/groups/${g.id}/members`, { displayName: 'Om' }, asOm)).status).toBe(404);
  });

  it.each([
    [{ name: '  ', memberNames: [] }],
    [{ name: 'Manali', memberNames: ['Riya', ' '] }],
    [{ name: 'Manali' }],
  ])('rejects %j', async (body) => {
    const { call } = setup();
    const res = await call<{ code: string }>('POST', '/groups', body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_input');
  });

  it('uppercases the currency', async () => {
    const { call } = setup();
    const res = await call<Group>('POST', '/groups', { name: 'Trip', currency: ' usd ', memberNames: [] });
    expect(res.status).toBe(201);
    expect(res.body.currency).toBe('USD');
  });

  it('keeps a bitcoin group in whole sats, and says so when a split doesn’t add up', async () => {
    const { call } = setup();
    const g = (await call<Group>('POST', '/groups', { name: 'Meetup', currency: 'btc', memberNames: ['Riya'] })).body;
    expect(g.currency).toBe('BTC');

    const [me, riya] = g.memberIds;
    const spend = (parts: unknown[]) =>
      call<Expense & { message: string }>('POST', `/groups/${g.id}/expenses`, {
        description: 'Pizza',
        amount: 21_000,
        paidByMemberId: me,
        splitMode: 'exact',
        parts,
      });

    const off = await spend([{ memberId: me, amount: 10_000 }, { memberId: riya, amount: 10_000 }]);
    expect(off.status).toBe(400);
    expect(off.body.message).toBe('Exact amounts add up to 20,000 sats, not 21,000 sats.');

    expect((await spend([{ memberId: me, amount: 10_000 }, { memberId: riya, amount: 11_000 }])).status).toBe(201);
    const debts = (await call<Debt[]>('GET', `/groups/${g.id}/debts`)).body;
    expect(debts).toEqual([expect.objectContaining({ fromMemberId: riya, toMemberId: me, amount: 11_000 })]);
  });

  it.each(['12!', 'RUPEE', '', 'ab'])('refuses currency %j, which the app couldn’t format', async (currency) => {
    const { call } = setup();
    const res = await call<{ code: string; message: string }>('POST', '/groups', { name: 'Trip', currency, memberNames: [] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'invalid_input', message: expect.stringContaining('currency') });
  });

  it('replays a repeated idempotency key instead of making a second group', async () => {
    const { call } = setup();
    const h = { 'idempotency-key': 'new-group-1' };
    const a = await call<Group>('POST', '/groups', { name: 'Manali', memberNames: [] }, h);
    const b = await call<Group>('POST', '/groups', { name: 'Manali', memberNames: [] }, h);
    expect(b.body.id).toBe(a.body.id);
    expect((await call<Group[]>('GET', '/groups')).body.filter((g) => g.name === 'Manali')).toHaveLength(1);
  });
});

describe('POST /groups/:id/members', () => {
  it('appends a ghost after the existing members', async () => {
    const { call, members } = setup();
    const res = await call<Member>('POST', '/groups/g-goa/members', { displayName: '  Riya ' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ groupId: 'g-goa', displayName: 'Riya', status: 'ghost' });
    expect(res.body).not.toHaveProperty('claimedByUserId');

    const ms = await members('g-goa');
    expect(ms.at(-1)!.id).toBe(res.body.id);
    expect((await call<Group>('GET', '/groups/g-goa')).body.memberIds.at(-1)).toBe(res.body.id);
  });

  it('keeps order across several adds', async () => {
    const { call, createGroup, members } = setup();
    const g = await createGroup([]);
    for (const displayName of ['A', 'B', 'C']) await call('POST', `/groups/${g.id}/members`, { displayName });
    expect((await members(g.id)).map((m) => m.displayName)).toEqual(['Yash', 'A', 'B', 'C']);
  });

  it('rejects a blank name', async () => {
    const { call } = setup();
    const res = await call<{ code: string }>('POST', '/groups/g-goa/members', { displayName: ' ' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_input');
  });

  it('404s a group that doesn’t exist', async () => {
    const { call } = setup();
    expect((await call('POST', '/groups/g-nope/members', { displayName: 'Riya' })).status).toBe(404);
  });

  it('replays a repeated idempotency key instead of adding twice', async () => {
    const { call, members } = setup();
    const h = { 'idempotency-key': 'add-riya-1' };
    const a = await call<Member>('POST', '/groups/g-goa/members', { displayName: 'Riya' }, h);
    const b = await call<Member>('POST', '/groups/g-goa/members', { displayName: 'Riya' }, h);
    expect(b.body.id).toBe(a.body.id);
    expect((await members('g-goa')).filter((m) => m.displayName === 'Riya')).toHaveLength(1);
  });
});
