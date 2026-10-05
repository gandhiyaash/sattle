import { describe, expect, it } from 'vitest';

import type { Debt, Group, GroupGuestView, Invite, InviteView, Member, Settlement, UpiClaim, UpiPayee, UpiProfile, User } from '@sattle/core';

import { createApp } from './app';
import { openDb } from './db';
import { SimulatedPayments } from './payments';

type Err = { code?: string; message?: string };

/**
 * A production-shaped server: no fixtures, no demo user. Riya made "Manali"
 * in rupees with Kabir and Aman as ghosts, Kabir has joined, and Riya paid
 * for the cab: Kabir and Aman each owe her ₹10. Riya has put her UPI ID on
 * her account.
 */
async function setup() {
  const db = openDb(':memory:');
  const app = createApp({
    db,
    payments: (repo) =>
      new SimulatedPayments(repo, { stepMs: 1, settleDelayMs: 1, rateFiatPerBtc: 9_000_000, alwaysFail: false }),
  });
  async function call<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    token?: string,
    headers: Record<string, string> = {}
  ) {
    const all: Record<string, string> = { 'content-type': 'application/json', ...headers };
    if (token) all.authorization = `Bearer ${token}`;
    const res = await app.request(path, { method, headers: all, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as T };
  }
  const signUp = async (displayName: string) =>
    (await call<{ user: User; token: string }>('POST', '/accounts', { displayName })).body;

  const riya = await signUp('Riya');
  const kabir = await signUp('Kabir');
  const group = (await call<Group>('POST', '/groups', { name: 'Manali', currency: 'INR', memberNames: ['Kabir', 'Aman'] }, riya.token)).body;
  const [mRiya, mKabir, mAman] = group.memberIds;
  const base = `/groups/${group.id}`;

  /** Joins `as` to a group as the person called `name`, or as someone new, and `by` lets them in. */
  const join = async (groupId: string, name: string, as: string, by = riya.token) => {
    const invite = (await call<Invite>('POST', `/groups/${groupId}/invites`, undefined, by)).body.token;
    const offered = (await call<InviteView>('GET', `/join/${invite}`)).body.members.find((m) => m.name === name);
    const asked = await call<{ id: string }>(
      'POST',
      '/join-requests',
      offered ? { token: invite, ref: offered.ref } : { token: invite, displayName: name },
      as
    );
    return call('POST', `/join-requests/${asked.body.id}/approve`, undefined, by);
  };
  await join(group.id, 'Kabir', kabir.token);

  await call(
    'POST',
    `${base}/expenses`,
    { description: 'Cab', amount: 3000, paidByMemberId: mRiya, splitMode: 'equal', parts: group.memberIds.map((memberId) => ({ memberId })) },
    riya.token
  );
  await call('PUT', '/me/upi', { upiId: 'riya@okhdfcbank' }, riya.token);

  const claim = (amount = 1000, as = kabir.token, extra: Record<string, unknown> = {}, headers?: Record<string, string>) =>
    call<UpiClaim & Err>('POST', `${base}/upi-claims`, { fromMemberId: mKabir, toMemberId: mRiya, amount, ...extra }, as, headers);
  const claims = async (as: string) => (await call<UpiClaim[]>('GET', `${base}/upi-claims`, undefined, as)).body;
  const debts = async () => (await call<Debt[]>('GET', `${base}/debts`, undefined, riya.token)).body;
  const kabirOwes = async () => (await debts()).find((d) => d.fromMemberId === mKabir && d.toMemberId === mRiya)?.amount ?? 0;
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  return { db, call, signUp, join, riya, kabir, group, base, mRiya, mKabir, mAman, claim, claims, debts, kabirOwes, count };
}

describe('/me/upi', () => {
  it('starts empty, is set, and can be cleared', async () => {
    const { call, signUp } = await setup();
    const dev = await signUp('Dev');
    const none = { upiId: null, onGroupLinks: false };
    expect((await call<UpiProfile>('GET', '/me/upi', undefined, dev.token)).body).toEqual(none);

    const set = await call<UpiProfile>('PUT', '/me/upi', { upiId: '  Dev.D@OkAxis ' }, dev.token);
    expect(set).toEqual({ status: 200, body: { upiId: 'dev.d@okaxis', onGroupLinks: false } });
    expect((await call<UpiProfile>('GET', '/me/upi', undefined, dev.token)).body).toEqual({ upiId: 'dev.d@okaxis', onGroupLinks: false });

    expect((await call<UpiProfile>('DELETE', '/me/upi', undefined, dev.token)).body).toEqual(none);
    expect((await call<UpiProfile>('GET', '/me/upi', undefined, dev.token)).body).toEqual(none);
  });

  it('is off shared group links until the person turns it on, and again for a new ID', async () => {
    const { call, signUp } = await setup();
    const dev = await signUp('Dev');
    const links = (on: boolean) => call<UpiProfile>('PUT', '/me/upi/group-links', { on }, dev.token);

    // Nothing to show yet.
    expect((await links(true)).status).toBe(400);

    await call('PUT', '/me/upi', { upiId: 'dev@okaxis' }, dev.token);
    expect((await links(true)).body).toEqual({ upiId: 'dev@okaxis', onGroupLinks: true });
    // Saving the same ID again keeps the choice.
    expect((await call<UpiProfile>('PUT', '/me/upi', { upiId: 'DEV@okaxis' }, dev.token)).body.onGroupLinks).toBe(true);
    // A different one doesn't: the choice was made for the old one.
    expect((await call<UpiProfile>('PUT', '/me/upi', { upiId: 'dev@ybl' }, dev.token)).body.onGroupLinks).toBe(false);

    await links(true);
    expect((await links(false)).body.onGroupLinks).toBe(false);
    await links(true);
    expect((await call<UpiProfile>('DELETE', '/me/upi', undefined, dev.token)).body.onGroupLinks).toBe(false);
    expect((await call('PUT', '/me/upi/group-links', { on: 'yes' }, dev.token)).status).toBe(400);
  });

  it('refuses what isn’t a UPI ID, and says why for a Lightning address', async () => {
    const { call, riya } = await setup();
    const address = await call<Err>('PUT', '/me/upi', { upiId: 'riya@walletofsatoshi.com' }, riya.token);
    expect(address.status).toBe(400);
    expect(address.body).toMatchObject({ code: 'invalid_input' });
    expect(address.body.message).toMatch(/Lightning address/);
    expect((await call('PUT', '/me/upi', { upiId: 'riya' }, riya.token)).status).toBe(400);
    expect((await call<UpiProfile>('GET', '/me/upi', undefined, riya.token)).body.upiId).toBe('riya@okhdfcbank');
  });

  it('needs an account', async () => {
    const { call } = await setup();
    expect((await call('GET', '/me/upi')).status).toBe(401);
    expect((await call('PUT', '/me/upi', { upiId: 'x@ybl' })).status).toBe(401);
  });
});

describe('who can see a UPI ID', () => {
  it('tells the group who takes UPI, and never the ID', async () => {
    const { call, base, kabir, mRiya } = await setup();
    const members = (await call<Member[]>('GET', `${base}/members`, undefined, kabir.token)).body;
    expect(members.filter((m) => m.upi).map((m) => m.id)).toEqual([mRiya]);
    expect(members.find((m) => m.id !== mRiya)).not.toHaveProperty('upi');
    expect(JSON.stringify(members)).not.toContain('okhdfcbank');
  });

  it('gives it to someone who owes them', async () => {
    const { call, base, kabir, mRiya } = await setup();
    const res = await call<UpiPayee>('GET', `${base}/members/${mRiya}/upi`, undefined, kabir.token);
    expect(res).toEqual({ status: 200, body: { upiId: 'riya@okhdfcbank', name: 'Riya' } });
  });

  it('keeps it from someone in the group who owes them nothing, and from anyone outside it', async () => {
    const { call, signUp, join, group, base, riya, mRiya } = await setup();
    const dev = await signUp('Dev');
    await join(group.id, 'Dev', dev.token);
    const inGroup = await call<Err>('GET', `${base}/members/${mRiya}/upi`, undefined, dev.token);
    expect(inGroup.status).toBe(409);
    expect(JSON.stringify(inGroup.body)).not.toContain('okhdfcbank');
    expect((await call('GET', `${base}/members/${mRiya}/upi`, undefined, riya.token)).status).toBe(409);
    expect((await call('GET', `${base}/members/${mRiya}/upi`, undefined, (await signUp('Stranger')).token)).status).toBe(404);
    expect((await call('GET', `${base}/members/${mRiya}/upi`)).status).toBe(401);
  });

  it('says so when the person owed has no UPI ID, or the group isn’t in rupees', async () => {
    const { call, signUp, join, base, riya, kabir, mRiya } = await setup();
    await call('DELETE', '/me/upi', undefined, riya.token);
    expect((await call<Err>('GET', `${base}/members/${mRiya}/upi`, undefined, kabir.token)).body).toMatchObject({ code: 'member_cannot_receive' });

    await call('PUT', '/me/upi', { upiId: 'riya@okhdfcbank' }, riya.token);
    const usd = (await call<Group>('POST', '/groups', { name: 'NYC', currency: 'USD', memberNames: ['Kabir'] }, riya.token)).body;
    const k2 = await signUp('Kabir');
    await join(usd.id, 'Kabir', k2.token);
    await call(
      'POST',
      `/groups/${usd.id}/expenses`,
      { description: 'Cab', amount: 2000, paidByMemberId: usd.memberIds[0], splitMode: 'equal', parts: usd.memberIds.map((memberId) => ({ memberId })) },
      riya.token
    );
    const res = await call<Err>('GET', `/groups/${usd.id}/members/${usd.memberIds[0]}/upi`, undefined, k2.token);
    expect(res.status).toBe(400);
    const claimed = await call<Err>(
      'POST',
      `/groups/${usd.id}/upi-claims`,
      { fromMemberId: usd.memberIds[1], toMemberId: usd.memberIds[0], amount: 1000 },
      k2.token
    );
    expect(claimed.status).toBe(400);
  });
});

describe('POST /groups/:id/upi-claims', () => {
  it('records the payer’s word, with the reference their app gave, and moves nothing', async () => {
    const { claim, claims, kabirOwes, riya, kabir, group, mRiya, mKabir, count } = await setup();
    const res = await claim(1000, kabir.token, { reference: ' 412345678901 ' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: expect.any(String),
      groupId: group.id,
      fromMemberId: mKabir,
      toMemberId: mRiya,
      amount: 1000,
      reference: '412345678901',
      status: 'pending',
      createdAt: expect.any(String),
    });
    expect(await kabirOwes()).toBe(1000);
    expect(count('settlements')).toBe(0);
    expect(await claims(riya.token)).toEqual([res.body]);
    expect(await claims(kabir.token)).toEqual([res.body]);
  });

  it('shows a claim only to the two people in it', async () => {
    const { claim, claims, signUp, join, group } = await setup();
    await claim();
    const dev = await signUp('Dev');
    await join(group.id, 'Dev', dev.token);
    expect(await claims(dev.token)).toEqual([]);
  });

  it('is the payer’s to make, for no more than is owed, to someone who takes UPI', async () => {
    const { call, claim, riya, kabir, base, mAman, mRiya, mKabir, count } = await setup();
    expect((await claim(1000, riya.token)).status).toBe(400);
    expect((await claim(1001)).status).toBe(409);
    expect((await call('POST', `${base}/upi-claims`, { fromMemberId: mRiya, toMemberId: mKabir, amount: 100 }, riya.token)).status).toBe(409);
    expect((await call('POST', `${base}/upi-claims`, { fromMemberId: mAman, toMemberId: mRiya, amount: 1000 }, kabir.token)).status).toBe(400);
    expect((await call('POST', `${base}/upi-claims`, { fromMemberId: mKabir, toMemberId: mRiya, amount: 1000 })).status).toBe(401);

    await call('DELETE', '/me/upi', undefined, riya.token);
    expect((await claim()).body).toMatchObject({ code: 'member_cannot_receive' });
    expect(count('upi_claims')).toBe(0);
  });

  it('takes the place of the last claim for the same debt', async () => {
    const { claim, claims, kabir, count } = await setup();
    const first = (await claim(400)).body;
    const second = (await claim(1000, kabir.token, { reference: 'R2' })).body;
    expect(second.id).not.toBe(first.id);
    expect(count('upi_claims')).toBe(1);
    expect(await claims(kabir.token)).toEqual([second]);
  });

  it('answers a retry of the same claim with the same claim', async () => {
    const { claim, kabir, count } = await setup();
    const key = { 'idempotency-key': 'claim-1' };
    const first = await claim(1000, kabir.token, {}, key);
    const again = await claim(1000, kabir.token, {}, key);
    expect(again.body.id).toBe(first.body.id);
    expect(count('upi_claims')).toBe(1);
  });

  it('waits for a Lightning payment that is under way for the same debt', async () => {
    const { db, claim, group, mRiya, mKabir } = await setup();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO settlements (id, group_id, from_member_id, to_member_id, amount, currency, rail, status, created_at, updated_at)
       VALUES ('s-open', ?, ?, ?, 100, 'INR', 'invoice', 'created', ?, ?)`
    ).run(group.id, mKabir, mRiya, now, now);
    expect((await claim()).status).toBe(409);
  });
});

describe('POST /upi-claims/:id/confirm', () => {
  it('is the payee’s word: the debt is settled, and the claim is gone', async () => {
    const { call, claim, claims, kabirOwes, riya, kabir, mRiya, mKabir, base } = await setup();
    const { id } = (await claim(1000, kabir.token, { reference: '412345678901' })).body;

    const res = await call<Settlement>('POST', `/upi-claims/${id}/confirm`, undefined, riya.token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      fromMemberId: mKabir,
      toMemberId: mRiya,
      amount: 1000,
      currency: 'INR',
      rail: 'upi',
      status: 'manually_confirmed',
      note: 'Paid by UPI, ref 412345678901',
    });
    expect(await kabirOwes()).toBe(0);
    expect(await claims(riya.token)).toEqual([]);
    expect((await call<Settlement[]>('GET', `${base}/settlements`, undefined, kabir.token)).body.map((s) => s.id)).toEqual([res.body.id]);
    expect((await call('POST', `/upi-claims/${id}/confirm`, undefined, riya.token)).status).toBe(404);
  });

  it('settles part of a debt when that is what was paid', async () => {
    const { call, claim, kabirOwes, riya } = await setup();
    const { id } = (await claim(400)).body;
    expect((await call<Settlement>('POST', `/upi-claims/${id}/confirm`, undefined, riya.token)).body.note).toBe('Paid by UPI');
    expect(await kabirOwes()).toBe(600);
  });

  it('can’t be given by the payer, or by anyone else', async () => {
    const { call, claim, kabirOwes, signUp, join, group, kabir, count } = await setup();
    const { id } = (await claim()).body;
    const dev = await signUp('Dev');
    await join(group.id, 'Dev', dev.token);
    expect((await call('POST', `/upi-claims/${id}/confirm`, undefined, kabir.token)).status).toBe(400);
    expect((await call('POST', `/upi-claims/${id}/confirm`, undefined, dev.token)).status).toBe(400);
    expect((await call('POST', `/upi-claims/${id}/confirm`, undefined, (await signUp('Stranger')).token)).status).toBe(404);
    expect((await call('POST', `/upi-claims/${id}/confirm`)).status).toBe(401);
    expect(await kabirOwes()).toBe(1000);
    expect(count('upi_claims')).toBe(1);
  });

  it('won’t settle more than is still owed, and keeps the claim', async () => {
    const { call, claim, claims, kabirOwes, riya, base, mRiya, mKabir } = await setup();
    const { id } = (await claim(1000)).body;
    await call('POST', `${base}/settlements/manual`, { fromMemberId: mKabir, toMemberId: mRiya, amount: 600 }, riya.token);

    const res = await call<Err>('POST', `/upi-claims/${id}/confirm`, undefined, riya.token);
    expect(res.status).toBe(409);
    expect(await kabirOwes()).toBe(400);
    expect(await claims(riya.token)).toHaveLength(1);
  });

  it('answers a retry with the same settlement, not a second one', async () => {
    const { call, claim, riya, count } = await setup();
    const { id } = (await claim(500)).body;
    const key = { 'idempotency-key': 'confirm-1' };
    const first = await call<Settlement>('POST', `/upi-claims/${id}/confirm`, undefined, riya.token, key);
    const again = await call<Settlement>('POST', `/upi-claims/${id}/confirm`, undefined, riya.token, key);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(count('settlements')).toBe(1);
  });
});

describe('declining and taking back', () => {
  it('lets the payee say it didn’t arrive, which the payer then sees', async () => {
    const { call, claim, claims, kabirOwes, riya, kabir } = await setup();
    const { id } = (await claim()).body;
    const res = await call<UpiClaim>('POST', `/upi-claims/${id}/decline`, undefined, riya.token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, status: 'declined' });
    expect((await claims(kabir.token))[0]).toMatchObject({ id, status: 'declined' });
    expect(await kabirOwes()).toBe(1000);
  });

  it('still lets a declined one be confirmed, if it turned up after all', async () => {
    const { call, claim, kabirOwes, riya } = await setup();
    const { id } = (await claim()).body;
    await call('POST', `/upi-claims/${id}/decline`, undefined, riya.token);
    expect((await call('POST', `/upi-claims/${id}/confirm`, undefined, riya.token)).status).toBe(200);
    expect(await kabirOwes()).toBe(0);
  });

  it('lets the payer take a claim back, pending or declined, and nobody else', async () => {
    const { call, claim, claims, riya, kabir } = await setup();
    const { id } = (await claim()).body;
    expect((await call('POST', `/upi-claims/${id}/decline`, undefined, kabir.token)).status).toBe(400);
    expect((await call('DELETE', `/upi-claims/${id}`, undefined, riya.token)).status).toBe(400);
    expect((await call('DELETE', `/upi-claims/${id}`, undefined, kabir.token)).status).toBe(200);
    expect(await claims(riya.token)).toEqual([]);
    expect((await call('DELETE', `/upi-claims/${id}`, undefined, kabir.token)).status).toBe(404);

    const second = (await claim()).body.id;
    await call('POST', `/upi-claims/${second}/decline`, undefined, riya.token);
    expect((await call('DELETE', `/upi-claims/${second}`, undefined, kabir.token)).status).toBe(200);
  });
});

describe('claims and people going', () => {
  it('drops a claim when either person leaves the group', async () => {
    const { call, claim, base, kabir, count } = await setup();
    await claim();
    expect((await call('POST', `${base}/leave`, undefined, kabir.token)).status).toBe(200);
    expect(count('upi_claims')).toBe(0);
  });

  it('drops them when an account is deleted', async () => {
    const { call, claim, kabir, count } = await setup();
    await claim();
    expect((await call('DELETE', '/me', undefined, kabir.token)).status).toBe(200);
    expect(count('upi_claims')).toBe(0);
  });

  it('goes with the group when the group is deleted', async () => {
    const { call, claim, base, riya, mRiya, mKabir, mAman, count } = await setup();
    await claim(400);
    await call('POST', `${base}/settlements/manual`, { fromMemberId: mKabir, toMemberId: mRiya, amount: 1000 }, riya.token);
    await call('POST', `${base}/settlements/manual`, { fromMemberId: mAman, toMemberId: mRiya, amount: 1000 }, riya.token);
    expect(count('upi_claims')).toBe(1);
    expect((await call('DELETE', base, undefined, riya.token)).status).toBe(200);
    expect(count('upi_claims')).toBe(0);
  });
});

describe('UPI on a group link', () => {
  /** Riya shares the group link. Answers with helpers for the page. */
  async function shared() {
    const t = await setup();
    const token = (await t.call<{ token: string }>('POST', `${t.base}/link`, undefined, t.riya.token)).body.token;
    const view = async () => (await t.call<GroupGuestView>('GET', `/g/${token}`)).body;
    const debtOf = async (from: string) => (await view()).debts.find((d) => d.from === from)!;
    const payee = async (from: string) => t.call<UpiPayee & Err>('GET', `/g/${token}/debts/${(await debtOf(from)).ref}/upi`);
    const say = async (from: string, headers?: Record<string, string>) =>
      t.call<Err>('POST', `/g/${token}/debts/${(await debtOf(from)).ref}/upi-claims`, undefined, undefined, headers);
    const onLinks = (on: boolean) => t.call<UpiProfile>('PUT', '/me/upi/group-links', { on }, t.riya.token);
    return { ...t, token, view, debtOf, payee, say, onLinks };
  }

  it('isn’t offered until the person owed turns it on', async () => {
    const { debtOf, payee, say, count } = await shared();
    expect((await debtOf('Kabir')).upi).toBeUndefined();
    expect((await payee('Kabir')).status).toBe(409);
    expect((await say('Kabir')).status).toBe(409);
    expect(count('upi_claims')).toBe(0);
  });

  it('then offers it on each debt to them, and gives the ID only for the debt someone asks to pay', async () => {
    const { view, debtOf, payee, onLinks } = await shared();
    await onLinks(true);
    expect((await debtOf('Kabir')).upi).toBe(true);
    expect((await debtOf('Aman')).upi).toBe(true);
    expect(JSON.stringify(await view())).not.toContain('riya@okhdfcbank');

    const res = await payee('Aman');
    expect(res).toEqual({ status: 200, body: { upiId: 'riya@okhdfcbank', name: 'Riya' } });
  });

  it('stops when they turn it off, or the group isn’t in rupees', async () => {
    const { call, riya, debtOf, payee, onLinks } = await shared();
    await onLinks(true);
    await onLinks(false);
    expect((await debtOf('Kabir')).upi).toBeUndefined();
    expect((await payee('Kabir')).status).toBe(409);

    await onLinks(true);
    const usd = (await call<Group>('POST', '/groups', { name: 'NYC', currency: 'USD', memberNames: ['Kabir'] }, riya.token)).body;
    await call(
      'POST',
      `/groups/${usd.id}/expenses`,
      { description: 'Cab', amount: 3000, paidByMemberId: usd.memberIds[0], splitMode: 'equal', parts: usd.memberIds.map((memberId) => ({ memberId })) },
      riya.token
    );
    const token = (await call<{ token: string }>('POST', `/groups/${usd.id}/link`, undefined, riya.token)).body.token;
    const debt = (await call<GroupGuestView>('GET', `/g/${token}`)).body.debts[0];
    expect(debt.upi).toBeUndefined();
    expect((await call('GET', `/g/${token}/debts/${debt.ref}/upi`)).status).toBe(409);
  });

  it('lets the page say it was paid, which the person owed confirms like any claim, marked as from the link', async () => {
    const { call, riya, mAman, mRiya, view, debtOf, say, claims, onLinks, debts } = await shared();
    await onLinks(true);
    expect((await say('Aman')).status).toBe(201);
    expect((await debtOf('Aman')).upiClaim).toBe('pending');
    // Nothing moved yet.
    expect((await debts()).find((d) => d.fromMemberId === mAman)?.amount).toBe(1000);

    const [made] = await claims(riya.token);
    expect(made).toMatchObject({ fromMemberId: mAman, toMemberId: mRiya, amount: 1000, status: 'pending', viaLink: true });
    expect((await call('POST', `/upi-claims/${made.id}/confirm`, undefined, riya.token)).status).toBe(200);
    expect((await view()).debts.map((d) => d.from)).toEqual(['Kabir']);
  });

  it('shows the person owed turning it down, and lets the page say so again', async () => {
    const { call, riya, debtOf, say, claims, onLinks } = await shared();
    await onLinks(true);
    await say('Aman');
    await call('POST', `/upi-claims/${(await claims(riya.token))[0].id}/decline`, undefined, riya.token);
    expect((await debtOf('Aman')).upiClaim).toBe('declined');
    expect((await say('Aman')).status).toBe(201);
    expect((await debtOf('Aman')).upiClaim).toBe('pending');
  });

  it('won’t replace what the payer said in the app', async () => {
    const { kabir, claim, claims, say, onLinks } = await shared();
    await onLinks(true);
    const theirs = (await claim(600, kabir.token, { reference: 'UPI123' })).body;
    expect((await say('Kabir')).status).toBe(201);
    expect(await claims(kabir.token)).toEqual([theirs]);
  });

  it('is 410 for a debt that has been settled, and 404 on a link that was turned off', async () => {
    const { call, base, riya, token, debtOf, onLinks, mAman, mRiya } = await shared();
    await onLinks(true);
    const { ref } = await debtOf('Aman');
    await call('POST', `${base}/settlements/manual`, { fromMemberId: mAman, toMemberId: mRiya, amount: 1000 }, riya.token);
    expect((await call('GET', `/g/${token}/debts/${ref}/upi`)).status).toBe(410);
    expect((await call('POST', `/g/${token}/debts/${ref}/upi-claims`)).status).toBe(410);

    await call('DELETE', `${base}/link`, undefined, riya.token);
    expect((await call('GET', `/g/${token}/debts/${ref}/upi`)).status).toBe(404);
  });
});
