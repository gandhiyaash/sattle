/**
 * GET /groups/:id/history: what has happened in a group, newest first. It is
 * read off the expenses, the changes to them and the settlements, so these
 * check that each of those keeps what the history needs.
 */

import { describe, expect, it } from 'vitest';

import type { Expense, Group, GroupLink, HistoryEntry, JoinView, Settlement, UpiClaim, User } from '@sattle/core';

import { createApp } from './app';
import { openDb } from './db';
import { SimulatedPayments } from './payments';

/**
 * A production-shaped server: no fixtures, no demo user. Riya made "Manali"
 * in rupees with Kabir and Aman as ghosts, and Kabir has since joined.
 */
async function setup() {
  const db = openDb(':memory:');
  const app = createApp({
    db,
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
  const base = `/groups/${group.id}`;

  const link = (await call<GroupLink>('POST', `${base}/link`, undefined, riya.token)).body.token;
  const ref = (await call<JoinView>('GET', `/join/${link}`)).body.members.find((m) => m.name === 'Kabir')!.ref;
  const asked = await call<{ id: string }>('POST', '/join-requests', { token: link, ref }, kabir.token);
  await call('POST', `/join-requests/${asked.body.id}/approve`, undefined, riya.token);

  const equally = (ids: string[]) => ({ splitMode: 'equal', parts: ids.map((memberId) => ({ memberId })) });
  const addExpense = async (description: string, paidByMemberId: string, amount: number, as = riya.token) =>
    (await call<Expense>('POST', `${base}/expenses`, { description, amount, paidByMemberId, ...equally(group.memberIds) }, as))
      .body;
  const history = async (as = riya.token) => (await call<HistoryEntry[]>('GET', `${base}/history`, undefined, as)).body;

  return { db, call, signUp, riya, kabir, group, base, mRiya, mKabir, mAman, equally, addExpense, history };
}

const waitFor = async <T>(fn: () => Promise<T>, ok: (v: T) => boolean) => {
  for (let i = 0; i < 100; i++) {
    const v = await fn();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timed out');
};

describe('GET /groups/:id/history', () => {
  it('is empty for a group nothing has happened in', async () => {
    const { history } = await setup();
    expect(await history()).toEqual([]);
  });

  it('shows an expense added, with who put it in, which needn’t be who paid', async () => {
    const { history, addExpense, kabir, mKabir, mAman } = await setup();
    const fuel = await addExpense('Fuel', mAman, 900, kabir.token);

    expect(fuel.addedByMemberId).toBe(mKabir);
    expect(await history()).toEqual([
      { kind: 'expense_added', id: `added-${fuel.id}`, at: fuel.createdAt, byMemberId: mKabir, expense: fuel },
    ]);
  });

  it('keeps how an expense read before it was changed, and who changed it', async () => {
    const { call, base, history, addExpense, equally, riya, kabir, mRiya, mKabir, mAman } = await setup();
    const fuel = await addExpense('Fuel', mAman, 900);
    const edited = (
      await call<Expense>(
        'PUT',
        `${base}/expenses/${fuel.id}`,
        { description: 'Fuel and tolls', amount: 1200, paidByMemberId: mAman, ...equally([mRiya, mAman]) },
        kabir.token
      )
    ).body;

    const [changed, added] = await history();
    expect(changed).toMatchObject({ kind: 'expense_changed', byMemberId: mKabir, expense: edited, before: fuel });
    // Still added the way Riya put it in, not the way it reads now.
    expect(added).toMatchObject({ kind: 'expense_added', at: fuel.createdAt, byMemberId: mRiya, expense: fuel });
    expect(edited.addedByMemberId).toBe(mRiya);
    expect((await history(kabir.token)).map((e) => e.id)).toEqual([changed.id, added.id]);
  });

  it('notes nothing when an expense is saved as it already stood', async () => {
    const { db, call, base, history, addExpense, equally, group, riya, mRiya } = await setup();
    const cab = await addExpense('Cab', mRiya, 3000);

    const res = await call<Expense>(
      'PUT',
      `${base}/expenses/${cab.id}`,
      { description: 'Cab', amount: 3000, paidByMemberId: mRiya, ...equally(group.memberIds) },
      riya.token
    );
    expect(res).toEqual({ status: 200, body: cab });
    expect((await history()).map((e) => e.kind)).toEqual(['expense_added']);
    // So the ledger on Nostr doesn't get an entry for it either.
    expect(db.prepare('SELECT COUNT(*) AS n FROM expense_changes').get()).toEqual({ n: 0 });
  });

  it('keeps a removed expense in the history, with what it said', async () => {
    const { call, base, history, addExpense, riya, mRiya } = await setup();
    const cab = await addExpense('Cab', mRiya, 3000);
    await call('DELETE', `${base}/expenses/${cab.id}`, undefined, riya.token);

    expect(await call<Expense[]>('GET', `${base}/expenses`, undefined, riya.token)).toMatchObject({ body: [] });
    expect(await history()).toMatchObject([
      { kind: 'expense_removed', byMemberId: mRiya, before: cab },
      { kind: 'expense_added', byMemberId: mRiya, expense: cab },
    ]);
  });

  it('shows a debt marked as settled: when, on whose word, and with no proof', async () => {
    const { call, base, history, addExpense, riya, mRiya, mKabir } = await setup();
    await addExpense('Cab', mRiya, 3000);
    const marked = (
      await call<Settlement>(
        'POST',
        `${base}/settlements/manual`,
        { fromMemberId: mKabir, toMemberId: mRiya, amount: 1000, note: 'Settled outside the app' },
        riya.token
      )
    ).body;

    const [settled] = await history();
    expect(settled).toEqual({
      kind: 'settled',
      id: `settled-${marked.id}`,
      at: marked.updatedAt,
      byMemberId: mRiya,
      settlement: marked,
    });
    expect(marked).toMatchObject({ rail: 'manual', status: 'manually_confirmed', recordedByMemberId: mRiya });
    expect(marked.preimage).toBeUndefined();
  });

  it('shows a Lightning payment with its proof, dated when it was paid, on nobody’s word', async () => {
    const { call, base, history, addExpense, kabir, mRiya, mKabir } = await setup();
    await addExpense('Cab', mRiya, 3000);
    const started = (
      await call<Settlement>('POST', `${base}/settlements`, { fromMemberId: mKabir, toMemberId: mRiya, amount: 1000, rail: 'invoice' }, kabir.token)
    ).body;
    const paid = await waitFor(
      () => call<Settlement>('GET', `/settlements/${started.id}`, undefined, kabir.token).then((r) => r.body),
      (s) => s.status === 'confirmed'
    );

    const [settled] = await history();
    expect(settled).toEqual({ kind: 'settled', id: `settled-${paid.id}`, at: paid.updatedAt, settlement: paid });
    expect(paid.preimage).toMatch(/^[0-9a-f]{64}$/);
    expect(paid.recordedByMemberId).toBeUndefined();
    expect(Date.parse(settled.at)).toBeGreaterThanOrEqual(Date.parse(paid.createdAt));
  });

  it('shows a UPI payment once the person owed confirms it, with the reference and their name on it', async () => {
    const { call, base, history, addExpense, riya, kabir, mRiya, mKabir } = await setup();
    await addExpense('Cab', mRiya, 3000);
    await call('PUT', '/me/upi', { upiId: 'riya@okhdfcbank' }, riya.token);
    const claim = (
      await call<UpiClaim>('POST', `${base}/upi-claims`, { fromMemberId: mKabir, toMemberId: mRiya, amount: 1000, reference: '412345678901' }, kabir.token)
    ).body;
    // Kabir's word alone settles nothing, so there is nothing to show yet.
    expect((await history()).map((e) => e.kind)).toEqual(['expense_added']);

    const confirmed = (await call<Settlement>('POST', `/upi-claims/${claim.id}/confirm`, undefined, riya.token)).body;
    expect((await history())[0]).toMatchObject({
      kind: 'settled',
      at: confirmed.updatedAt,
      byMemberId: mRiya,
      settlement: { rail: 'upi', note: 'Paid by UPI, ref 412345678901', recordedByMemberId: mRiya },
    });
  });

  it('leaves out payments that didn’t finish, which moved nothing', async () => {
    const { db, history, group, mRiya, mKabir } = await setup();
    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO settlements (id, group_id, from_member_id, to_member_id, amount, currency, rail, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 100, 'INR', 'invoice', ?, ?, ?)`
    );
    for (const status of ['created', 'awaiting_payment', 'failed', 'expired']) {
      insert.run(`s-${status}`, group.id, mKabir, mRiya, status, now, now);
    }
    expect(await history()).toEqual([]);
  });

  it('is only for people in the group', async () => {
    const { call, base, signUp, addExpense, mRiya } = await setup();
    await addExpense('Cab', mRiya, 3000);
    const dev = await signUp('Dev');
    expect((await call('GET', `${base}/history`, undefined, dev.token)).status).toBe(404);
    expect((await call('GET', `${base}/history`)).status).toBe(401);
  });

  it('still names someone who has since left, and drops the group’s history with the group', async () => {
    const { db, call, base, history, addExpense, riya, kabir, mRiya, mKabir } = await setup();
    await addExpense('Tea', mRiya, 300, kabir.token);
    await call('POST', `${base}/leave`, undefined, kabir.token);
    // Their member stays behind as a ghost, so what they did is still theirs.
    expect((await history())[0]).toMatchObject({ kind: 'expense_added', byMemberId: mKabir });

    const tea = (await call<Expense[]>('GET', `${base}/expenses`, undefined, riya.token)).body[0];
    await call('DELETE', `${base}/expenses/${tea.id}`, undefined, riya.token);
    expect((await call('DELETE', base, undefined, riya.token)).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM expense_changes').get()).toEqual({ n: 0 });
  });
});
