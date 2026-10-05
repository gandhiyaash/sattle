/**
 * Changing and removing things: expenses, members, groups, wallet
 * connections, accounts. The rules are in groupRules.ts.
 */

import { describe, expect, it } from 'vitest';

import type { Debt, Expense, Group, Invite, InviteView, Member, User, WalletConnection } from '@sattle/core';

import { createApp } from './app';
import { openDb } from './db';
import type { NwcApi } from './nwc';
import { SimulatedPayments } from './payments';

const URI = `nostr+walletconnect://${'a'.repeat(64)}?relay=wss://relay.example&secret=${'b'.repeat(64)}`;

const receiveOnly = (): NwcApi => ({
  getInfo: async () => ({ alias: 'Test Hub', methods: ['get_info', 'make_invoice', 'lookup_invoice'] }),
  makeInvoice: async () => {
    throw new Error('not used here');
  },
  lookupInvoice: async () => {
    throw new Error('not used here');
  },
  close: () => {},
});

/**
 * A production-shaped server: no fixtures, no demo user. Riya made "Manali"
 * with Kabir and Aman as ghosts; Kabir has since joined with an invite.
 */
async function setup() {
  const db = openDb(':memory:');
  const app = createApp({
    db,
    nwc: receiveOnly,
    payments: (repo) =>
      new SimulatedPayments(repo, { stepMs: 1, settleDelayMs: 1, rateFiatPerBtc: 9_000_000, alwaysFail: false }),
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
  const kabir = await signUp('Kabir');
  const group = (await call<Group>('POST', '/groups', { name: 'Manali', memberNames: ['Kabir', 'Aman'] }, riya.token)).body;
  const [mRiya, mKabir, mAman] = group.memberIds;
  const invite = async (as = riya.token) =>
    (await call<Invite>('POST', `/groups/${group.id}/invites`, undefined, as)).body.token;
  /** Who the join page offers, by name. */
  const offered = async (token: string) => (await call<InviteView>('GET', `/join/${token}`)).body.members;
  /** Asks to join as `name`, and Riya lets them in. */
  const joinAs = async (name: string, token: string, as: string) => {
    const ref = (await offered(token)).find((m) => m.name === name)!.ref;
    const asked = await call<{ id: string }>('POST', '/join-requests', { token, ref }, as);
    return call('POST', `/join-requests/${asked.body.id}/approve`, undefined, riya.token);
  };
  await joinAs('Kabir', await invite(), kabir.token);

  const base = `/groups/${group.id}`;
  const addExpense = async (paidByMemberId: string, amount: number, as = riya.token, description = 'Cab') =>
    (
      await call<Expense>(
        'POST',
        `${base}/expenses`,
        { description, amount, paidByMemberId, splitMode: 'equal', parts: group.memberIds.map((memberId) => ({ memberId })) },
        as
      )
    ).body;
  const members = async (as = riya.token) => (await call<Member[]>('GET', `${base}/members`, undefined, as)).body;
  const expenses = async (as = riya.token) => (await call<Expense[]>('GET', `${base}/expenses`, undefined, as)).body;
  const debts = async (as = riya.token) => (await call<Debt[]>('GET', `${base}/debts`, undefined, as)).body;
  /** A payment that hasn't finished, straight into the table: the simulator would finish a real one at once. */
  const openPayment = (fromMemberId: string, toMemberId: string) => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO settlements (id, group_id, from_member_id, to_member_id, amount, currency, rail, status, created_at, updated_at)
       VALUES ('s-open', ?, ?, ?, 100, 'INR', 'invoice', 'created', ?, ?)`
    ).run(group.id, fromMemberId, toMemberId, now, now);
  };
  const count = (table: string, where = '1 = 1', ...args: string[]) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args) as { n: number }).n;

  return { db, call, signUp, riya, kabir, group, base, mRiya, mKabir, mAman, invite, offered, joinAs, addExpense, members, expenses, debts, openPayment, count };
}

const equally = (ids: string[]) => ({ splitMode: 'equal', parts: ids.map((memberId) => ({ memberId })) });

describe('PUT /groups/:id/expenses/:expenseId', () => {
  it('lets the person who paid change what it was, how much, and who it’s split between', async () => {
    const { call, base, riya, mRiya, mKabir, addExpense, expenses, debts } = await setup();
    const cab = await addExpense(mRiya, 3000);

    const res = await call<Expense>(
      'PUT',
      `${base}/expenses/${cab.id}`,
      { description: 'Cab to Manali', amount: 5000, paidByMemberId: mRiya, ...equally([mRiya, mKabir]) },
      riya.token
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: cab.id, createdAt: cab.createdAt, description: 'Cab to Manali', amount: 5000 });
    expect(res.body.parts).toEqual([{ memberId: mRiya, amount: 2500 }, { memberId: mKabir, amount: 2500 }]);

    expect(await expenses()).toEqual([res.body]);
    expect(await debts()).toMatchObject([{ fromMemberId: mKabir, toMemberId: mRiya, amount: 2500 }]);
  });

  it('refuses a groupmate, so nobody can shrink what they owe someone else', async () => {
    const { call, base, kabir, mRiya, mKabir, addExpense, expenses } = await setup();
    const cab = await addExpense(mRiya, 3000);

    const edit = await call<{ code: string; message: string }>(
      'PUT',
      `${base}/expenses/${cab.id}`,
      { description: 'Cab', amount: 3, paidByMemberId: mRiya, ...equally([mRiya, mKabir]) },
      kabir.token
    );
    expect(edit.status).toBe(400);
    expect(edit.body.message).toBe('Only Riya can change this, because they paid it.');
    expect((await call('DELETE', `${base}/expenses/${cab.id}`, undefined, kabir.token)).status).toBe(400);
    expect(await expenses()).toEqual([cab]);
  });

  it('lets anyone in the group change what a ghost paid', async () => {
    const { call, base, kabir, mRiya, mAman, addExpense } = await setup();
    const fuel = await addExpense(mAman, 900);
    const res = await call<Expense>(
      'PUT',
      `${base}/expenses/${fuel.id}`,
      { description: 'Fuel', amount: 600, paidByMemberId: mAman, ...equally([mRiya, mAman]) },
      kabir.token
    );
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(600);
  });

  it('lets the payer hand the expense to someone else, after which it is theirs', async () => {
    const { call, base, riya, kabir, mRiya, mKabir, addExpense } = await setup();
    const cab = await addExpense(mRiya, 3000);
    const body = { description: 'Cab', amount: 3000, paidByMemberId: mKabir, ...equally([mRiya, mKabir]) };
    expect((await call('PUT', `${base}/expenses/${cab.id}`, body, riya.token)).status).toBe(200);
    expect((await call('PUT', `${base}/expenses/${cab.id}`, body, riya.token)).status).toBe(400);
    expect((await call('DELETE', `${base}/expenses/${cab.id}`, undefined, kabir.token)).status).toBe(200);
  });

  it('checks the new split like a new expense, and 404s for an expense that isn’t this group’s', async () => {
    const { call, base, riya, mRiya, addExpense } = await setup();
    const cab = await addExpense(mRiya, 3000);
    const outsider = await call('PUT', `${base}/expenses/${cab.id}`, { description: 'Cab', amount: 3000, paidByMemberId: mRiya, ...equally([mRiya, 'm-nobody']) }, riya.token);
    expect(outsider.status).toBe(400);
    expect(outsider.body).toMatchObject({ code: 'invalid_expense' });

    const other = (await call<Group>('POST', '/groups', { name: 'Flat', memberNames: [] }, riya.token)).body;
    const elsewhere = await call('PUT', `/groups/${other.id}/expenses/${cab.id}`, { description: 'Cab', amount: 1, paidByMemberId: other.memberIds[0], ...equally(other.memberIds) }, riya.token);
    expect(elsewhere.status).toBe(404);
    expect((await call('DELETE', `${base}/expenses/e-nope`, undefined, riya.token)).status).toBe(404);
  });
});

describe('DELETE /groups/:id/expenses/:expenseId', () => {
  it('removes the expense and what it made people owe', async () => {
    const { call, base, riya, mRiya, addExpense, expenses, debts } = await setup();
    const cab = await addExpense(mRiya, 3000);
    expect(await debts()).toHaveLength(2);

    expect((await call('DELETE', `${base}/expenses/${cab.id}`, undefined, riya.token)).status).toBe(200);
    expect(await expenses()).toEqual([]);
    expect(await debts()).toEqual([]);
  });
});

describe('PUT /groups/:id', () => {
  it('lets anyone in the group rename it, for everyone', async () => {
    const { call, base, riya, kabir } = await setup();
    const res = await call<Group>('PUT', base, { name: '  Manali 2026 ' }, kabir.token);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Manali 2026');
    expect((await call<Group>('GET', base, undefined, riya.token)).body.name).toBe('Manali 2026');
  });

  it('refuses an empty name, and anyone outside the group', async () => {
    const { call, base, riya, signUp } = await setup();
    expect((await call('PUT', base, { name: ' ' }, riya.token)).status).toBe(400);
    expect((await call('PUT', base, { name: 'Mine now' }, (await signUp('Stranger')).token)).status).toBe(404);
  });
});

describe('DELETE /groups/:id', () => {
  it('is refused while money is owed, so deleting a group can’t erase a debt', async () => {
    const { call, base, kabir, mRiya, addExpense } = await setup();
    await addExpense(mRiya, 3000);
    const res = await call<{ message: string }>('DELETE', base, undefined, kabir.token);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('There’s still money owed in this group. Settle up first.');
    expect((await call('GET', base, undefined, kabir.token)).status).toBe(200);
  });

  it('is refused while a payment is under way', async () => {
    const { call, base, riya, mRiya, mKabir, openPayment } = await setup();
    openPayment(mKabir, mRiya);
    expect((await call('DELETE', base, undefined, riya.token)).status).toBe(409);
  });

  it('takes the group and everything in it away from everyone, once it’s settled', async () => {
    const { call, base, group, riya, kabir, mRiya, invite, addExpense, count } = await setup();
    const cab = await addExpense(mRiya, 3000);
    await invite();
    await call('DELETE', `${base}/expenses/${cab.id}`, undefined, riya.token);

    expect((await call('DELETE', base, undefined, kabir.token)).status).toBe(200);
    expect((await call('GET', base, undefined, riya.token)).status).toBe(404);
    expect((await call<Group[]>('GET', '/groups', undefined, kabir.token)).body).toEqual([]);
    for (const table of ['members', 'expenses', 'settlements', 'invites', 'pay_links', 'expense_changes', 'ledger_entries']) {
      expect([table, count(table, 'group_id = ?', group.id)]).toEqual([table, 0]);
    }
    expect(count('expense_groups')).toBe(0);
  });

  it('is 404 for someone who isn’t in it', async () => {
    const { call, base, signUp } = await setup();
    expect((await call('DELETE', base, undefined, (await signUp('Stranger')).token)).status).toBe(404);
  });
});

describe('DELETE /groups/:id/members/:memberId', () => {
  it('removes a ghost nobody has built anything on, and the invite stops offering them', async () => {
    const { call, base, kabir, mAman, invite, offered, members } = await setup();
    const token = await invite();
    const aman = (await offered(token)).find((m) => m.name === 'Aman')!.ref;

    expect((await call('DELETE', `${base}/members/${mAman}`, undefined, kabir.token)).status).toBe(200);
    expect((await members()).map((m) => m.displayName)).toEqual(['Riya', 'Kabir']);
    expect(await offered(token)).toEqual([]);
    expect((await call('POST', '/join-requests', { token, ref: aman }, (await call<{ token: string }>('POST', '/accounts', { displayName: 'Aman' })).body.token)).status).toBe(404);
  });

  it('keeps anyone who is part of an expense', async () => {
    const { call, base, riya, mRiya, mAman, addExpense, members } = await setup();
    await addExpense(mRiya, 3000);
    const res = await call<{ message: string }>('DELETE', `${base}/members/${mAman}`, undefined, riya.token);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Aman is part of this group’s expenses or payments, so they can’t be removed.');
    expect(await members()).toHaveLength(3);
  });

  it('won’t throw out someone who has joined', async () => {
    const { call, base, riya, mKabir } = await setup();
    const res = await call<{ message: string }>('DELETE', `${base}/members/${mKabir}`, undefined, riya.token);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Kabir has joined. Only they can leave.');
  });

  it('is 404 for a member of another group', async () => {
    const { call, base, riya } = await setup();
    const other = (await call<Group>('POST', '/groups', { name: 'Flat', memberNames: ['Dev'] }, riya.token)).body;
    expect((await call('DELETE', `${base}/members/${other.memberIds[1]}`, undefined, riya.token)).status).toBe(404);
  });
});

describe('POST /groups/:id/leave', () => {
  it('turns the person back into a ghost with the same name and balance, and shuts them out', async () => {
    const { call, base, kabir, mRiya, mKabir, addExpense, members, debts } = await setup();
    await addExpense(mRiya, 3000);

    expect((await call('POST', `${base}/leave`, undefined, kabir.token)).status).toBe(200);
    expect((await call('GET', base, undefined, kabir.token)).status).toBe(404);
    expect((await members()).find((m) => m.id === mKabir)).toEqual({ id: mKabir, groupId: expect.any(String), displayName: 'Kabir', status: 'ghost', receivable: false });
    expect(await debts()).toContainEqual(expect.objectContaining({ fromMemberId: mKabir, toMemberId: mRiya, amount: 1000 }));
  });

  it('can be undone with a new invite', async () => {
    const { call, base, kabir, mKabir, invite, joinAs, members } = await setup();
    await call('POST', `${base}/leave`, undefined, kabir.token);
    expect((await joinAs('Kabir', await invite(), kabir.token)).status).toBe(200);
    expect((await members()).find((m) => m.id === mKabir)?.status).toBe('joined');
  });

  it('is refused for the only person with an account, who should delete the group instead', async () => {
    const { call, base, riya, kabir } = await setup();
    await call('POST', `${base}/leave`, undefined, kabir.token);
    const res = await call<{ message: string }>('POST', `${base}/leave`, undefined, riya.token);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('You’re the only one here with an account. Delete the group instead.');
  });

  it('is refused while a payment to them is under way', async () => {
    const { call, base, kabir, mRiya, mKabir, openPayment, members } = await setup();
    openPayment(mRiya, mKabir);
    expect((await call('POST', `${base}/leave`, undefined, kabir.token)).status).toBe(409);
    expect((await members()).find((m) => m.id === mKabir)?.status).toBe('joined');
  });

  it('isn’t held up by a payment that has finished, or by an invoice nobody can pay any more', async () => {
    const { db, call, base, kabir, mRiya, mKabir, openPayment } = await setup();
    openPayment(mRiya, mKabir);
    const lapsed = JSON.stringify({ amountFiat: 100, currency: 'INR', amountSat: 11, feeSat: 1, rateFiatPerBtc: 9_000_000, expiresAt: new Date(Date.now() - 1000).toISOString() });
    db.prepare("UPDATE settlements SET status = 'awaiting_payment', quote = ? WHERE id = 's-open'").run(lapsed);
    const now = new Date().toISOString();
    for (const [id, status] of [['s-paid', 'confirmed'], ['s-failed', 'failed'], ['s-expired', 'expired'], ['s-cash', 'manually_confirmed']]) {
      db.prepare(
        `INSERT INTO settlements (id, group_id, from_member_id, to_member_id, amount, currency, rail, status, created_at, updated_at)
         SELECT ?, group_id, from_member_id, to_member_id, 100, 'INR', 'invoice', ?, ?, ? FROM settlements WHERE id = 's-open'`
      ).run(id, status, now, now);
    }
    expect((await call('POST', `${base}/leave`, undefined, kabir.token)).status).toBe(200);
  });
});

describe('DELETE /me/wallet', () => {
  it('forgets the connection string and puts the person’s members back to joined', async () => {
    const { call, kabir, mKabir, members, count } = await setup();
    expect((await call('PUT', '/me/wallet', { nwcUri: URI }, kabir.token)).status).toBe(200);
    expect((await members()).find((m) => m.id === mKabir)?.status).toBe('nwc_linked');

    const res = await call<WalletConnection>('DELETE', '/me/wallet', undefined, kabir.token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false, methods: [], excessMethods: [] });
    expect(count('wallet_connections')).toBe(0);
    expect((await members()).find((m) => m.id === mKabir)?.status).toBe('joined');
    expect((await call<WalletConnection>('GET', '/me/wallet', undefined, kabir.token)).body.connected).toBe(false);
  });

  it('is refused while a payment to them is under way, because that wallet is what confirms it', async () => {
    const { call, kabir, mRiya, mKabir, openPayment, count } = await setup();
    await call('PUT', '/me/wallet', { nwcUri: URI }, kabir.token);
    openPayment(mRiya, mKabir);
    expect((await call('DELETE', '/me/wallet', undefined, kabir.token)).status).toBe(409);
    expect(count('wallet_connections')).toBe(1);
  });

  it('leaves other people’s connections alone', async () => {
    const { call, riya, kabir, count } = await setup();
    await call('PUT', '/me/wallet', { nwcUri: URI }, riya.token);
    await call('PUT', '/me/wallet', { nwcUri: URI }, kabir.token);
    await call('DELETE', '/me/wallet', undefined, kabir.token);
    expect(count('wallet_connections')).toBe(1);
    expect((await call<WalletConnection>('GET', '/me/wallet', undefined, riya.token)).body.connected).toBe(true);
  });
});

describe('DELETE /me', () => {
  it('needs an account', async () => {
    const { call } = await setup();
    expect((await call('DELETE', '/me')).status).toBe(401);
  });

  it('ends the account: the token, the wallet connection, and the links it made', async () => {
    const { call, kabir, invite, count } = await setup();
    await call('PUT', '/me/wallet', { nwcUri: URI }, kabir.token);
    const sent = await invite(kabir.token);

    expect((await call('DELETE', '/me', undefined, kabir.token)).status).toBe(200);
    expect((await call('GET', '/me', undefined, kabir.token)).status).toBe(401);
    expect(count('users', 'id = ?', kabir.user.id)).toBe(0);
    expect(count('wallet_connections')).toBe(0);
    expect((await call('GET', `/join/${sent}`)).status).toBe(404);
  });

  it('leaves their row in a shared group as a ghost, so the others’ ledger still adds up', async () => {
    const { call, kabir, mRiya, mKabir, addExpense, members, debts } = await setup();
    await addExpense(mRiya, 3000);
    await call('DELETE', '/me', undefined, kabir.token);

    expect((await members()).find((m) => m.id === mKabir)).toMatchObject({ displayName: 'Kabir', status: 'ghost' });
    expect((await members()).find((m) => m.id === mKabir)?.claimedByUserId).toBeUndefined();
    expect(await debts()).toContainEqual(expect.objectContaining({ fromMemberId: mKabir, toMemberId: mRiya, amount: 1000 }));
  });

  it('deletes a group nobody else could ever open, debts and all', async () => {
    const { call, kabir, count } = await setup();
    const solo = (await call<Group>('POST', '/groups', { name: 'Just me', memberNames: ['Dev'] }, kabir.token)).body;
    await call('POST', `/groups/${solo.id}/expenses`, { description: 'Tea', amount: 100, paidByMemberId: solo.memberIds[0], ...equally(solo.memberIds) }, kabir.token);

    expect((await call('DELETE', '/me', undefined, kabir.token)).status).toBe(200);
    expect(count('expense_groups', 'id = ?', solo.id)).toBe(0);
    expect(count('members', 'group_id = ?', solo.id)).toBe(0);
    expect(count('expenses', 'group_id = ?', solo.id)).toBe(0);
    expect(count('expense_groups')).toBe(1);
  });

  it('removes the pay links they made, without losing the payments made through them', async () => {
    const { db, call, group, riya, kabir, mRiya, mKabir, mAman, addExpense, count } = await setup();
    await addExpense(mKabir, 3000, kabir.token);
    const link = await call<{ token: string }>('POST', `/groups/${group.id}/pay-links`, { fromMemberId: mAman, toMemberId: mKabir, amount: 1000 }, kabir.token);
    expect(link.status).toBe(201);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO settlements (id, group_id, from_member_id, to_member_id, amount, currency, rail, status, pay_link_token, created_at, updated_at)
       VALUES ('s-paid', ?, ?, ?, 1000, 'INR', 'invoice', 'confirmed', ?, ?, ?)`
    ).run(group.id, mAman, mKabir, link.body.token, now, now);

    expect((await call('DELETE', '/me', undefined, kabir.token)).status).toBe(200);
    expect(count('pay_links')).toBe(0);
    expect((await call('GET', `/s/${link.body.token}`)).status).toBe(404);
    const kept = await call<{ id: string }[]>('GET', `/groups/${group.id}/settlements`, undefined, riya.token);
    expect(kept.body.map((s) => s.id)).toEqual(['s-paid']);
    expect(mRiya).toBeTruthy();
  });

  it('is refused while a payment to them is under way', async () => {
    const { call, kabir, mRiya, mKabir, openPayment } = await setup();
    openPayment(mRiya, mKabir);
    const res = await call<{ message: string }>('DELETE', '/me', undefined, kabir.token);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('A payment to you is still in progress. Wait for it to finish.');
    expect((await call('GET', '/me', undefined, kabir.token)).status).toBe(200);
  });

  it('touches nobody else', async () => {
    const { call, riya, kabir, base } = await setup();
    await call('DELETE', '/me', undefined, kabir.token);
    expect((await call<User>('GET', '/me', undefined, riya.token)).body.displayName).toBe('Riya');
    expect((await call('GET', base, undefined, riya.token)).status).toBe(200);
  });
});
