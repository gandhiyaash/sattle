/**
 * The API, abused directly over HTTP: every refusal the routes promise, every
 * rule about who may do what, and the shapes the public pages are allowed to
 * see. No browser here. Each test makes its own accounts and groups, so they
 * run side by side against one server.
 *
 * Messages are asserted as the routes word them (apps/api/src/routes/*.ts,
 * settlementRules.ts, groupRules.ts); statuses as http.ts maps them.
 */

import { formatAmount, groupDebts, type Expense, type Group, type Member, type Settlement } from '@sattle/core';

import { ApiRefusal, type Api } from '../src/api';
import { API_URL, SIM_SETTLE_MS, SIM_STEP_MS } from '../src/env';
import { expect, test } from '../src/fixtures';

/**
 * Awaits a call that must be refused, and hands back what the server said.
 * Takes the call as a function when there are several to make in turn: a
 * promise made ahead of its turn rejects with nobody listening, which Node
 * reports as an unhandled rejection and Playwright counts as a failure.
 */
async function refused(p: Promise<unknown> | (() => Promise<unknown>)): Promise<ApiRefusal> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    if (e instanceof ApiRefusal) return e;
    throw e;
  }
  throw new Error('expected the server to refuse, but it answered');
}

/** Every key anywhere in a JSON value. */
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, into));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keysOf(v, into);
    }
  }
  return into;
}

/** The keys a page without a login must never be handed. */
const ID_KEYS = ['id', 'memberId', 'groupId', 'claimedByUserId', 'fromMemberId', 'toMemberId', 'userId', 'paidByMemberId'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls a settlement until it reaches `status`, or gives up after `ms`. */
async function untilStatus(api: Api, id: string, status: Settlement['status'], ms = 10_000): Promise<Settlement> {
  const until = Date.now() + ms;
  let last: Settlement | undefined;
  while (Date.now() < until) {
    last = await api.get<Settlement>(`/settlements/${id}`);
    if (last.status === status) return last;
    await sleep(100);
  }
  throw new Error(`settlement ${id} is ${last?.status}, not ${status}, after ${ms}ms`);
}

/** How long a simulated payment takes from created to confirmed. */
const PAYMENT_MS = SIM_STEP_MS * 2 + SIM_SETTLE_MS;

/** Something the server would take as an idempotency key: unique per call. */
const newKey = () => `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Two people in one group: Yash made it, Priya joined by its link as the
 * ghost Yash listed her as. Any other ghosts in `people` stay ghosts.
 */
async function pair(
  api: Api,
  opts: { name?: string; people?: string[]; currency?: string; simplifyDebts?: boolean; approveJoins?: boolean } = {}
) {
  const [yash, priya] = await Promise.all([api.account('Yash'), api.account('Priya')]);
  const A = api.as(yash.token);
  const B = api.as(priya.token);
  const { group } = await A.seedGroup({
    name: opts.name ?? 'Goa trip',
    people: opts.people ?? ['Priya'],
    currency: opts.currency,
    simplifyDebts: opts.simplifyDebts,
  });
  const link = await A.createGroupLink(group.id);
  const view = await api.joinView(link.token);
  const ref = view.members.find((m) => m.name === 'Priya')!.ref;
  const bMember = await B.join(link.token, { ref });
  const aMember = await A.myMember(group.id);
  if (opts.approveJoins) await A.setApproveJoins(group.id, true);
  return { yash, priya, A, B, group, link, aMember, bMember };
}

/** An equal split paid by `paidBy` between `between`, in minor units. */
function spend(api: Api, group: Group, input: { description?: string; amount: number; paidBy: Member; between: Member[] }) {
  return api.addExpense({
    groupId: group.id,
    description: input.description ?? 'Dinner',
    amount: input.amount,
    paidByMemberId: input.paidBy.id,
    splitMode: 'equal',
    parts: input.between.map((m) => ({ memberId: m.id })),
  });
}

/** Yash owes Priya `amount`: Priya paid twice that, split between the two of them. */
async function yashOwesPriya(api: Api, amount = 10_000, opts: Parameters<typeof pair>[1] = {}) {
  const p = await pair(api, opts);
  await spend(p.B, p.group, { amount: amount * 2, paidBy: p.bMember, between: [p.aMember, p.bMember] });
  return { ...p, amount };
}

// ---------------------------------------------------------------------------

test.describe('Health and unknown routes', () => {
  test('health says it simulates payments, and needs no account', async ({ api }) => {
    const r = await api.raw<{ ok: boolean; payments: string }>('GET', '/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, payments: 'simulated' });
  });

  test('an unknown route is a 404 with a code, once signed in', async ({ api }) => {
    const { token } = await api.account('Yash');
    const r = await api.raw<{ code: string; message: string }>('GET', '/nothing/here', undefined, { token });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ code: 'not_found', message: 'No such route.' });
  });

  test('an unknown route without a token is turned away before it is looked for', async ({ api }) => {
    const r = await api.raw<{ code: string }>('GET', '/nothing/here');
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('unauthorized');
  });
});

test.describe('Auth', () => {
  test('no token is 401 with "Sign in to continue."', async ({ api }) => {
    const r = await api.raw<{ code: string; message: string }>('GET', '/groups');
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ code: 'unauthorized', message: 'Sign in to continue.' });
  });

  test('a made-up token is 401', async ({ api }) => {
    const r = await api.raw<{ code: string }>('GET', '/me', undefined, { token: 'not-a-token-at-all' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('unauthorized');
  });

  test('an empty bearer and a non-bearer scheme are 401', async ({ api }) => {
    for (const authorization of ['Bearer ', 'Basic abc', 'bearer lowercase']) {
      const r = await api.raw<{ code: string }>('GET', '/me', undefined, { token: null, headers: { authorization } });
      expect(r.status, authorization).toBe(401);
    }
  });

  test('a preflight needs no token', async ({ api }) => {
    const r = await api.raw('OPTIONS', '/groups', undefined, {
      headers: { origin: 'http://127.0.0.1:8900', 'access-control-request-method': 'POST' },
    });
    expect(r.status).toBe(204);
  });

  test('public prefixes answer without a token', async ({ api }) => {
    const bad = await api.raw<{ code: string }>('GET', '/s/no-such-link');
    expect(bad.status).toBe(404);
    expect(bad.body.code).toBe('not_found');
    const group = await api.raw<{ code: string }>('GET', '/g/no-such-link');
    expect(group.status).toBe(404);
    const join = await api.raw<{ code: string }>('GET', '/join/no-such-link');
    expect(join.status).toBe(404);
    const challenge = await api.raw<{ challenge: string }>('POST', '/auth/nostr/challenge', {});
    expect(challenge.status).toBe(200);
    expect(challenge.body.challenge).toEqual(expect.any(String));
  });

  test('a deleted account’s token no longer signs in', async ({ api }) => {
    const { token } = await api.account('Gone');
    const me = api.as(token);
    expect((await me.me()).displayName).toBe('Gone');
    await me.del('/me');
    const r = await refused(me.me());
    expect(r.status).toBe(401);
    expect(r.code).toBe('unauthorized');
    // Deleting again, with the dead token, is 401 too: the app reads that as done.
    const again = await refused(me.del('/me'));
    expect(again.status).toBe(401);
  });

  test('a replaced sign-in key stops working, except to replay the replacement', async ({ api }) => {
    const { token: old } = await api.account('Yash');
    const me = api.as(old);
    const key = newKey();
    const first = await me.raw<{ token: string }>('POST', '/me/token', undefined, { key });
    expect(first.status).toBe(200);
    const fresh = first.body.token;
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fresh).not.toBe(old);

    // The old key is dead everywhere.
    const dead = await refused(me.me());
    expect(dead.status).toBe(401);
    expect(dead.message).toBe('Sign in to continue.');
    expect((await api.as(fresh).me()).displayName).toBe('Yash');

    // Except for the retry of the very request that replaced it, which gets the stored answer.
    const replay = await me.raw<{ token: string }>('POST', '/me/token', undefined, { key });
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body.token).toBe(fresh);

    // A new attempt with the old key can't mint another.
    const minted = await me.raw<{ code: string; message: string }>('POST', '/me/token', undefined, { key: newKey() });
    expect(minted.status).toBe(401);
    expect(minted.body.message).toBe('This sign-in key was replaced. Sign in with the new one.');
  });
});

test.describe('Accounts', () => {
  test('a name is required, trimmed, and at most 40 characters', async ({ api }) => {
    for (const displayName of ['', '   ', 'x'.repeat(41)]) {
      const r = await api.raw<{ code: string; message: string }>('POST', '/accounts', { displayName });
      expect(r.status, JSON.stringify(displayName)).toBe(400);
      expect(r.body.code).toBe('invalid_input');
      expect(r.body.message).toMatch(/^displayName: /);
    }
    const ok = await api.account('x'.repeat(40));
    expect(ok.user.displayName).toBe('x'.repeat(40));
    const padded = await api.account('  Yash  ');
    expect(padded.user.displayName).toBe('Yash');
  });

  test('a body that isn’t JSON is 400', async ({ api }) => {
    const res = await fetch(`${API_URL}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'invalid_input', message: 'Request body isn’t valid JSON.' });
  });

  test('a new account is a user with a 43-character token and no npub', async ({ api }) => {
    const { user, token } = await api.account('Yash');
    expect(user).toEqual({ id: expect.stringMatching(/^u/), displayName: 'Yash' });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await api.as(token).me()).toEqual(user);
  });

  test('an account with a payment on its way to it can’t be deleted yet', async ({ api }) => {
    const { A, B, aMember, bMember, group, amount } = await yashOwesPriya(api);
    await A.post('/groups/' + group.id + '/settlements', {
      fromMemberId: aMember.id,
      toMemberId: bMember.id,
      amount,
      rail: 'invoice',
    });
    const r = await refused(B.del('/me'));
    expect(r.status).toBe(409);
    expect(r.message).toBe('A payment to you is still in progress. Wait for it to finish.');
    expect((await B.me()).displayName).toBe('Priya');
  });

  test('deleting an account ghosts its member in a shared group and deletes a group it alone could open', async ({ api }) => {
    const { A, B, bMember, group } = await pair(api);
    const alone = await B.createGroup({ name: 'Only mine', memberNames: ['Nobody'] });
    await B.del('/me');
    const members = await A.members(group.id);
    const priya = members.find((m) => m.id === bMember.id)!;
    expect(priya.status).toBe('ghost');
    expect(priya.claimedByUserId).toBeUndefined();
    expect(priya.displayName).toBe('Priya');
    const gone = await refused(A.group(alone.id));
    expect(gone.status).toBe(404);
  });
});

test.describe('Groups', () => {
  test('a group’s name is required and at most 80 characters', async ({ api }) => {
    const { token } = await api.account('Yash');
    const me = api.as(token);
    for (const name of ['', ' ', 'g'.repeat(81)]) {
      const r = await refused(me.createGroup({ name, memberNames: [] }));
      expect(r.status).toBe(400);
      expect(r.code).toBe('invalid_input');
      expect(r.message).toMatch(/^name: /);
    }
    const g = await me.createGroup({ name: 'g'.repeat(80), memberNames: [] });
    expect(g.name).toBe('g'.repeat(80));
  });

  test('the currency is a three-letter code, upper-cased, rupees unless said', async ({ api }) => {
    const me = api.as((await api.account('Yash')).token);
    expect((await me.createGroup({ name: 'Default', memberNames: [] })).currency).toBe('INR');
    expect((await me.createGroup({ name: 'Dollars', currency: 'usd', memberNames: [] })).currency).toBe('USD');
    expect((await me.createGroup({ name: 'Sats', currency: 'BTC', memberNames: [] })).currency).toBe('BTC');
    for (const currency of ['xx', 'INRR', '', '12A']) {
      const r = await refused(me.createGroup({ name: 'Bad', currency, memberNames: [] }));
      expect(r.status, currency).toBe(400);
      expect(r.message).toMatch(/^currency: /);
    }
  });

  test('at most 50 people can be listed, each with a name', async ({ api }) => {
    const me = api.as((await api.account('Yash')).token);
    const fifty = Array.from({ length: 50 }, (_, i) => `Person ${i}`);
    const g = await me.createGroup({ name: 'Big', memberNames: fifty });
    expect(g.memberIds).toHaveLength(51);
    const tooMany = await refused(me.createGroup({ name: 'Bigger', memberNames: [...fifty, 'One more'] }));
    expect(tooMany.status).toBe(400);
    expect(tooMany.message).toMatch(/^memberNames/);
    const blank = await refused(me.createGroup({ name: 'Blank', memberNames: ['Ok', '  '] }));
    expect(blank.status).toBe(400);
    expect(blank.message).toMatch(/^memberNames\.1: /);
    const long = await refused(me.createGroup({ name: 'Long', memberNames: ['n'.repeat(41)] }));
    expect(long.status).toBe(400);
  });

  test('the maker is the first member, joined and claimed; the rest are ghosts in order', async ({ api }) => {
    const { user, token } = await api.account('Yash');
    const me = api.as(token);
    const g = await me.createGroup({ name: 'Trip', memberNames: ['Priya', 'Aman'] });
    const members = await me.members(g.id);
    expect(members.map((m) => m.displayName)).toEqual(['Yash', 'Priya', 'Aman']);
    expect(members[0]).toMatchObject({ status: 'joined', claimedByUserId: user.id, receivable: true });
    expect(members[1]).toMatchObject({ status: 'ghost', receivable: false });
    expect(members[1].claimedByUserId).toBeUndefined();
    expect(members[1].upi).toBeUndefined();
    expect(g.memberIds).toEqual(members.map((m) => m.id));
    expect(g).toMatchObject({ simplifyDebts: true, approveJoins: false, currency: 'INR' });
  });

  test('another account can’t see, change or delete a group it isn’t in', async ({ api }) => {
    const me = api.as((await api.account('Yash')).token);
    const other = api.as((await api.account('Stranger')).token);
    const g = await me.createGroup({ name: 'Private', memberNames: [] });
    for (const attempt of [
      () => other.group(g.id),
      () => other.members(g.id),
      () => other.expenses(g.id),
      () => other.debts(g.id),
      () => other.settlements(g.id),
      () => other.history(g.id),
      () => other.groupLink(g.id),
      () => other.put(`/groups/${g.id}`, { name: 'Taken' }),
      () => other.del(`/groups/${g.id}`),
      () => other.addMember(g.id, 'Me'),
    ]) {
      const r = await refused(attempt);
      expect(r.status).toBe(404);
      expect(r.message).toBe('That group doesn’t exist.');
    }
    expect((await me.group(g.id)).name).toBe('Private');
    expect(await other.groups()).toEqual([]);
  });

  test('changing a group needs one of its three settings', async ({ api }) => {
    const me = api.as((await api.account('Yash')).token);
    const g = await me.createGroup({ name: 'Trip', memberNames: [] });
    const r = await refused(me.put(`/groups/${g.id}`, {}));
    expect(r.status).toBe(400);
    expect(r.message).toBe('body: expected name, simplifyDebts or approveJoins');
    const renamed = await me.put<Group>(`/groups/${g.id}`, { name: '  Goa  ' });
    expect(renamed.name).toBe('Goa');
    const off = await me.put<Group>(`/groups/${g.id}`, { simplifyDebts: false, approveJoins: true });
    expect(off).toMatchObject({ simplifyDebts: false, approveJoins: true, name: 'Goa' });
  });

  test('simplifying can’t change while a payment is in progress', async ({ api }) => {
    const { A, aMember, bMember, group, amount } = await yashOwesPriya(api);
    await A.post(`/groups/${group.id}/settlements`, { fromMemberId: aMember.id, toMemberId: bMember.id, amount, rail: 'invoice' });
    const r = await refused(A.setSimplifyDebts(group.id, false));
    expect(r.status).toBe(409);
    expect(r.message).toBe('A payment in this group is still in progress. Wait for it to finish.');
    // Setting it to what it already is isn't a change, so that goes through.
    expect((await A.setSimplifyDebts(group.id, true)).simplifyDebts).toBe(true);
  });

  test('simplifying can’t change while a UPI payment waits to be confirmed', async ({ api }) => {
    const { A, B, aMember, bMember, group, amount } = await yashOwesPriya(api);
    await B.setUpiId('priya@okhdfcbank');
    await A.post(`/groups/${group.id}/upi-claims`, { fromMemberId: aMember.id, toMemberId: bMember.id, amount });
    const r = await refused(A.setSimplifyDebts(group.id, false));
    expect(r.status).toBe(409);
    expect(r.message).toBe('A UPI payment in this group hasn’t been confirmed yet. Wait until it has.');
  });

  test('a group is deleted only once nothing is owed and no payment is under way', async ({ api }) => {
    const { A, B, aMember, bMember, group, amount } = await yashOwesPriya(api);
    const owed = await refused(A.del(`/groups/${group.id}`));
    expect(owed.status).toBe(409);
    expect(owed.message).toBe('There’s still money owed in this group. Settle up first.');
    const s = await A.post<Settlement>(`/groups/${group.id}/settlements`, { fromMemberId: aMember.id, toMemberId: bMember.id, amount, rail: 'invoice' });
    const paying = await refused(B.del(`/groups/${group.id}`));
    expect(paying.status).toBe(409);
    expect(paying.message).toBe('A payment in this group is still in progress. Wait for it to finish.');
    await untilStatus(A, s.id, 'confirmed');
    expect(await A.debts(group.id)).toEqual([]);
    await B.del(`/groups/${group.id}`);
    expect(await A.groups()).toEqual([]);
    expect(await B.groups()).toEqual([]);
  });

  test('leaving: not the last account, not with a payment incoming; the member stays as a ghost', async ({ api }) => {
    const { A, B, aMember, bMember, group, amount } = await yashOwesPriya(api);
    const alone = await A.createGroup({ name: 'Solo', memberNames: ['Ghost'] });
    const last = await refused(A.post(`/groups/${alone.id}/leave`));
    expect(last.status).toBe(409);
    expect(last.message).toBe('You’re the only one here with an account. Delete the group instead.');

    await A.post(`/groups/${group.id}/settlements`, { fromMemberId: aMember.id, toMemberId: bMember.id, amount, rail: 'invoice' });
    const incoming = await refused(B.post(`/groups/${group.id}/leave`));
    expect(incoming.status).toBe(409);
    expect(incoming.message).toBe('A payment to you is still in progress. Wait for it to finish.');
    // The payer may leave meanwhile: nothing is on its way to them.
    await A.post(`/groups/${group.id}/leave`);
    expect((await A.groups()).map((g) => g.id)).toEqual([alone.id]);
    const left = await refused(A.group(group.id));
    expect(left.status).toBe(404);
    const yash = (await B.members(group.id)).find((m) => m.id === aMember.id)!;
    expect(yash).toMatchObject({ displayName: 'Yash', status: 'ghost' });
    expect(yash.claimedByUserId).toBeUndefined();
  });
});

test.describe('Members', () => {
  test('a ghost nobody built on can go; one named in an expense can’t; a joined member only leaves', async ({ api }) => {
    const { A, B, aMember, bMember, group } = await pair(api, { people: ['Priya', 'Aman', 'Rohan'] });
    const aman = await A.memberNamed(group.id, 'Aman');
    const rohan = await A.memberNamed(group.id, 'Rohan');
    await spend(A, group, { amount: 3000, paidBy: aMember, between: [aMember, aman] });

    await A.del(`/groups/${group.id}/members/${rohan.id}`);
    expect((await A.members(group.id)).map((m) => m.displayName)).toEqual(['Yash', 'Priya', 'Aman']);

    const named = await refused(A.del(`/groups/${group.id}/members/${aman.id}`));
    expect(named.status).toBe(409);
    expect(named.message).toBe('Aman is part of this group’s expenses or payments, so they can’t be removed.');

    const joined = await refused(A.del(`/groups/${group.id}/members/${bMember.id}`));
    expect(joined.status).toBe(400);
    expect(joined.message).toBe('Priya has joined. Only they can leave.');

    const self = await refused(B.del(`/groups/${group.id}/members/${bMember.id}`));
    expect(self.status).toBe(400);
  });

  test('a member of another group isn’t in this one', async ({ api }) => {
    const me = api.as((await api.account('Yash')).token);
    const g1 = await me.createGroup({ name: 'One', memberNames: ['Priya'] });
    const g2 = await me.createGroup({ name: 'Two', memberNames: ['Aman'] });
    const aman = await me.memberNamed(g2.id, 'Aman');
    const r = await refused(me.del(`/groups/${g1.id}/members/${aman.id}`));
    expect(r.status).toBe(404);
    expect(r.message).toBe('That member isn’t in this group.');
    const missing = await refused(me.del(`/groups/${g1.id}/members/m-nope`));
    expect(missing.status).toBe(404);
  });

  test('adding someone needs a name, appends them as a ghost, and names can repeat', async ({ api }) => {
    const me = api.as((await api.account('Yash')).token);
    const g = await me.createGroup({ name: 'Trip', memberNames: ['Priya'] });
    const blank = await refused(me.addMember(g.id, '   '));
    expect(blank.status).toBe(400);
    expect(blank.message).toMatch(/^displayName: /);
    const added = await me.addMember(g.id, '  Aman ');
    expect(added).toMatchObject({ displayName: 'Aman', status: 'ghost', groupId: g.id });
    // Nothing stops a second Priya: the server leaves names to the group.
    await me.addMember(g.id, 'Priya');
    expect((await me.members(g.id)).map((m) => m.displayName)).toEqual(['Yash', 'Priya', 'Aman', 'Priya']);
    expect((await me.group(g.id)).memberIds).toHaveLength(4);
  });

  test('members say whether they can be paid now and whether they take UPI', async ({ api }) => {
    const { A, B, aMember, bMember, group } = await pair(api, { people: ['Priya', 'Aman'] });
    await B.setUpiId('priya@okhdfcbank');
    const aman = await A.memberNamed(group.id, 'Aman');
    await A.put(`/members/${aman.id}/payout-address`, { address: 'aman@walletofsatoshi.com' });
    const members = await A.members(group.id);
    const byId = new Map(members.map((m) => [m.id, m]));
    expect(byId.get(aMember.id)).toMatchObject({ receivable: true });
    expect(byId.get(aMember.id)!.upi).toBeUndefined();
    expect(byId.get(bMember.id)).toMatchObject({ receivable: true, upi: true });
    // A ghost with an address is payable under simulated payments, and takes no UPI: no account to have an ID on.
    expect(byId.get(aman.id)).toMatchObject({ status: 'ghost', lightningAddress: 'aman@walletofsatoshi.com', receivable: true });
    expect(byId.get(aman.id)!.upi).toBeUndefined();
    // The UPI ID itself never rides on a member.
    expect(JSON.stringify(members)).not.toContain('priya@okhdfcbank');
  });

  test('a payout address: anyone’s for a ghost, only your own once joined, and never an invoice', async ({ api }) => {
    const { A, B, aMember, bMember, group } = await pair(api, { people: ['Priya', 'Aman'] });
    const aman = await A.memberNamed(group.id, 'Aman');
    const set = await B.put<Member>(`/members/${aman.id}/payout-address`, { address: ' Aman@WalletOfSatoshi.com ' });
    expect(set).toMatchObject({ status: 'ghost', lightningAddress: 'aman@walletofsatoshi.com' });

    const theirs = await refused(A.put(`/members/${bMember.id}/payout-address`, { address: 'me@wallet.com' }));
    expect(theirs.status).toBe(400);
    expect(theirs.message).toBe('Only Priya can change where they get paid.');
    const own = await B.put<Member>(`/members/${bMember.id}/payout-address`, { address: 'priya@wallet.com' });
    expect(own.lightningAddress).toBe('priya@wallet.com');

    const invoice = await refused(A.put(`/members/${aman.id}/payout-address`, { address: 'lnbc10n1pjexample' }));
    expect(invoice.status).toBe(400);
    expect(invoice.code).toBe('invalid_address');
    expect(invoice.message).toMatch(/^That's an invoice, which only works once/);
    const lnurl = await refused(A.put(`/members/${aman.id}/payout-address`, { address: 'lnurl1dp68gurn8ghj7' }));
    expect(lnurl.message).toBe('LNURL codes aren’t supported yet. Ask for the address that looks like an email.');
    const nonsense = await refused(A.put(`/members/${aman.id}/payout-address`, { address: 'not an address' }));
    expect(nonsense.message).toBe('That doesn’t look like a Lightning address. It should look like name@wallet.com.');

    const outsider = api.as((await api.account('Stranger')).token);
    const notMine = await refused(outsider.put(`/members/${aman.id}/payout-address`, { address: 'x@y.com' }));
    expect(notMine.status).toBe(404);
    expect((await refused(A.put('/members/m-nope/payout-address', { address: 'x@y.com' }))).message).toBe('That member doesn’t exist.');
  });
});

test.describe('Expenses', () => {
  test('an amount is a positive whole number of minor units', async ({ api }) => {
    const { A, aMember, bMember, group } = await pair(api);
    for (const amount of [0, -1, 1.5, '100', null]) {
      const r = await refused(
        A.post(`/groups/${group.id}/expenses`, {
          description: 'Dinner',
          amount,
          paidByMemberId: aMember.id,
          splitMode: 'equal',
          parts: [{ memberId: aMember.id }, { memberId: bMember.id }],
        })
      );
      expect(r.status, String(amount)).toBe(400);
      expect(r.code, String(amount)).toBe('invalid_expense');
      expect(r.message).toMatch(/^amount: /);
    }
  });

  test('a description is required and at most 200 characters; parts can’t be empty', async ({ api }) => {
    const { A, aMember, bMember, group } = await pair(api);
    const base = { amount: 1000, paidByMemberId: aMember.id, splitMode: 'equal', parts: [{ memberId: bMember.id }] };
    for (const description of ['', '   ', 'd'.repeat(201)]) {
      const r = await refused(A.post(`/groups/${group.id}/expenses`, { ...base, description }));
      expect(r.status).toBe(400);
      expect(r.code).toBe('invalid_expense');
      expect(r.message).toMatch(/^description: /);
    }
    const none = await refused(A.post(`/groups/${group.id}/expenses`, { ...base, description: 'Dinner', parts: [] }));
    expect(none.status).toBe(400);
    expect(none.message).toMatch(/^parts: /);
    const mode = await refused(A.post(`/groups/${group.id}/expenses`, { ...base, description: 'Dinner', splitMode: 'weird' }));
    expect(mode.message).toMatch(/^splitMode: /);
    const ok = await A.post<Expense>(`/groups/${group.id}/expenses`, { ...base, description: ' d'.repeat(100) });
    expect(ok.description).toHaveLength(199);
  });

  test('everyone in a split, and whoever paid, has to be in the group', async ({ api }) => {
    const { A, aMember, bMember, group } = await pair(api);
    const other = await A.createGroup({ name: 'Other', memberNames: ['Aman'] });
    const aman = await A.memberNamed(other.id, 'Aman');
    const inParts = await refused(
      A.post(`/groups/${group.id}/expenses`, {
        description: 'Dinner',
        amount: 1000,
        paidByMemberId: aMember.id,
        splitMode: 'equal',
        parts: [{ memberId: bMember.id }, { memberId: aman.id }],
      })
    );
    expect(inParts.status).toBe(400);
    expect(inParts.code).toBe('invalid_expense');
    expect(inParts.message).toBe('Someone in that split isn’t in this group.');
    const asPayer = await refused(
      A.post(`/groups/${group.id}/expenses`, {
        description: 'Dinner',
        amount: 1000,
        paidByMemberId: aman.id,
        splitMode: 'equal',
        parts: [{ memberId: bMember.id }],
      })
    );
    expect(asPayer.message).toBe('Someone in that split isn’t in this group.');
  });

  test('exact amounts have to add up, in the group’s own words; shares have to be positive', async ({ api }) => {
    const { A, aMember, bMember, group } = await pair(api);
    const exact = await refused(
      A.post(`/groups/${group.id}/expenses`, {
        description: 'Dinner',
        amount: 30050,
        paidByMemberId: aMember.id,
        splitMode: 'exact',
        parts: [
          { memberId: aMember.id, amount: 10000 },
          { memberId: bMember.id, amount: 10000 },
        ],
      })
    );
    expect(exact.status).toBe(400);
    expect(exact.code).toBe('invalid_expense');
    expect(exact.message).toBe(`Exact amounts add up to ${formatAmount(20000, 'INR')}, not ${formatAmount(30050, 'INR')}.`);
    const negativeShare = await refused(
      A.post(`/groups/${group.id}/expenses`, {
        description: 'Dinner',
        amount: 300,
        paidByMemberId: aMember.id,
        splitMode: 'shares',
        parts: [
          { memberId: aMember.id, weight: 0 },
          { memberId: bMember.id, weight: 1 },
        ],
      })
    );
    expect(negativeShare.status).toBe(400);
    expect(negativeShare.message).toMatch(/^parts\.0\.weight: /);
    // An exact part with a negative amount is refused by shape before the sum is looked at.
    const negativeExact = await refused(
      A.post(`/groups/${group.id}/expenses`, {
        description: 'Dinner',
        amount: 100,
        paidByMemberId: aMember.id,
        splitMode: 'exact',
        parts: [
          { memberId: aMember.id, amount: 200 },
          { memberId: bMember.id, amount: -100 },
        ],
      })
    );
    expect(negativeExact.status).toBe(400);
    expect(negativeExact.message).toMatch(/^parts\.1\.amount: /);
  });

  test('a sats group refuses exact parts that don’t add up, worded in sats', async ({ api }) => {
    const { A, aMember, bMember, group } = await pair(api, { currency: 'BTC' });
    const r = await refused(
      A.post(`/groups/${group.id}/expenses`, {
        description: 'Dinner',
        amount: 1001,
        paidByMemberId: aMember.id,
        splitMode: 'exact',
        parts: [
          { memberId: aMember.id, amount: 500 },
          { memberId: bMember.id, amount: 500 },
        ],
      })
    );
    expect(r.message).toBe('Exact amounts add up to 1,000 sats, not 1,001 sats.');
  });

  test('a remainder lands one minor unit at a time from the first part; shares weigh; exact is kept as given', async ({ api }) => {
    const { A, aMember, bMember, group } = await pair(api, { people: ['Priya', 'Aman'] });
    const aman = await A.memberNamed(group.id, 'Aman');
    const equal = await spend(A, group, { amount: 100, paidBy: aMember, between: [aMember, bMember, aman] });
    expect(equal.parts.map((p) => p.amount)).toEqual([34, 33, 33]);
    expect(equal.addedByMemberId).toBe(aMember.id);
    expect(equal.splitMode).toBe('equal');
    const shares = await A.addExpense({
      groupId: group.id,
      description: 'Villa',
      amount: 1000,
      paidByMemberId: bMember.id,
      splitMode: 'shares',
      parts: [
        { memberId: aMember.id, weight: 2 },
        { memberId: bMember.id, weight: 1 },
        { memberId: aman.id },
      ],
    });
    expect(shares.parts.map((p) => p.amount)).toEqual([500, 250, 250]);
    const exact = await A.addExpense({
      groupId: group.id,
      description: 'Cab',
      amount: 999,
      paidByMemberId: aman.id,
      splitMode: 'exact',
      parts: [
        { memberId: aMember.id, amount: 0 },
        { memberId: bMember.id, amount: 999 },
      ],
    });
    expect(exact.parts).toEqual([
      { memberId: aMember.id, amount: 0 },
      { memberId: bMember.id, amount: 999 },
    ]);
    expect((await A.expenses(group.id)).map((e) => e.id)).toEqual([equal.id, shares.id, exact.id]);
  });

  test('an expense is its payer’s to change or remove; what a ghost paid is anyone’s', async ({ api }) => {
    const { A, B, aMember, bMember, group } = await pair(api, { people: ['Priya', 'Aman'] });
    const aman = await A.memberNamed(group.id, 'Aman');
    const priyas = await spend(B, group, { amount: 2000, paidBy: bMember, between: [aMember, bMember] });
    const body = {
      description: 'Dinner, changed',
      amount: 3000,
      paidByMemberId: bMember.id,
      splitMode: 'equal',
      parts: [{ memberId: aMember.id }, { memberId: bMember.id }],
    };
    const notMine = await refused(A.put(`/groups/${group.id}/expenses/${priyas.id}`, body));
    expect(notMine.status).toBe(400);
    expect(notMine.code).toBe('invalid_input');
    expect(notMine.message).toBe('Only Priya can change this, because they paid it.');
    const notMineToDelete = await refused(A.del(`/groups/${group.id}/expenses/${priyas.id}`));
    expect(notMineToDelete.message).toBe('Only Priya can change this, because they paid it.');
    const changed = await B.put<Expense>(`/groups/${group.id}/expenses/${priyas.id}`, body);
    expect(changed).toMatchObject({ id: priyas.id, description: 'Dinner, changed', amount: 3000 });
    expect(changed.parts.map((p) => p.amount)).toEqual([1500, 1500]);

    const amans = await spend(A, group, { amount: 500, paidBy: aman, between: [aMember, aman] });
    const byPriya = await B.put<Expense>(`/groups/${group.id}/expenses/${amans.id}`, { ...body, paidByMemberId: aman.id, amount: 600 });
    expect(byPriya.amount).toBe(600);
    await B.del(`/groups/${group.id}/expenses/${amans.id}`);
    expect((await A.expenses(group.id)).map((e) => e.id)).toEqual([priyas.id]);

    const missing = await refused(A.put(`/groups/${group.id}/expenses/e-nope`, body));
    expect(missing.status).toBe(404);
    expect(missing.message).toBe('That expense doesn’t exist.');
    // An expense of another group, through this group's route, is not found either.
    const other = await A.createGroup({ name: 'Other', memberNames: [] });
    const elsewhere = await refused(A.del(`/groups/${other.id}/expenses/${priyas.id}`));
    expect(elsewhere.status).toBe(404);
  });

  test('saving an expense as it already stands changes nothing and notes nothing', async ({ api }) => {
    const { A, aMember, bMember, group } = await pair(api);
    const e = await spend(A, group, { description: 'Cab', amount: 2000, paidBy: aMember, between: [aMember, bMember] });
    const before = await A.history(group.id);
    expect(before.map((h) => h.kind)).toEqual(['expense_added']);
    const same = await A.put<Expense>(`/groups/${group.id}/expenses/${e.id}`, {
      description: 'Cab',
      amount: 2000,
      paidByMemberId: aMember.id,
      splitMode: 'equal',
      parts: [{ memberId: aMember.id }, { memberId: bMember.id }],
    });
    expect(same).toEqual(e);
    expect(await A.history(group.id)).toEqual(before);
    // A real change is noted, with both sides.
    await A.put(`/groups/${group.id}/expenses/${e.id}`, {
      description: 'Cab',
      amount: 2400,
      paidByMemberId: aMember.id,
      splitMode: 'equal',
      parts: [{ memberId: aMember.id }, { memberId: bMember.id }],
    });
    const after = await A.history(group.id);
    expect(after.map((h) => h.kind)).toEqual(['expense_changed', 'expense_added']);
    const change = after[0];
    if (change.kind !== 'expense_changed') throw new Error('expected a change');
    expect(change.before?.amount).toBe(2000);
    expect(change.expense.amount).toBe(2400);
    expect(change.byMemberId).toBe(aMember.id);
    // The added entry shows the expense as it first read, not as it reads now.
    const added = after[1];
    if (added.kind !== 'expense_added') throw new Error('expected the addition');
    expect(added.expense.amount).toBe(2000);
    await A.del(`/groups/${group.id}/expenses/${e.id}`);
    const removed = (await A.history(group.id))[0];
    expect(removed.kind).toBe('expense_removed');
    if (removed.kind === 'expense_removed') expect(removed.before?.amount).toBe(2400);
  });
});

test.describe('Debts', () => {
  test('what is owed is groupDebts over the group’s expenses and counted settlements, simplified', async ({ api }) => {
    const { A, B, aMember, bMember, group } = await pair(api, { people: ['Priya', 'Aman'] });
    const aman = await A.memberNamed(group.id, 'Aman');
    // Yash paid for Priya, Priya paid for Aman: simplified, Aman pays Yash and Priya is done.
    await spend(A, group, { amount: 1000, paidBy: aMember, between: [bMember] });
    await spend(B, group, { amount: 1000, paidBy: bMember, between: [aman] });
    const debts = await A.debts(group.id);
    expect(debts).toEqual([{ id: `${group.id}:${aman.id}->${aMember.id}`, groupId: group.id, fromMemberId: aman.id, toMemberId: aMember.id, amount: 1000 }]);
    const g = await A.group(group.id);
    expect(debts).toEqual(groupDebts(g, await A.expenses(group.id), await A.settlements(group.id)));
  });

  test('without simplifying, everyone pays back whoever paid for them', async ({ api }) => {
    const { A, B, aMember, bMember, group } = await pair(api, { people: ['Priya', 'Aman'], simplifyDebts: false });
    const aman = await A.memberNamed(group.id, 'Aman');
    await spend(A, group, { amount: 1000, paidBy: aMember, between: [bMember] });
    await spend(B, group, { amount: 1000, paidBy: bMember, between: [aman] });
    const debts = await A.debts(group.id);
    expect(debts).toHaveLength(2);
    expect(debts.map((d) => [d.fromMemberId, d.toMemberId, d.amount])).toEqual(
      expect.arrayContaining([
        [bMember.id, aMember.id, 1000],
        [aman.id, bMember.id, 1000],
      ])
    );
    const g = await A.group(group.id);
    expect(debts).toEqual(groupDebts(g, await A.expenses(group.id), await A.settlements(group.id)));
    // Turning simplifying on changes who pays whom, and nothing else.
    await A.setSimplifyDebts(group.id, true);
    expect((await A.debts(group.id)).map((d) => [d.fromMemberId, d.toMemberId, d.amount])).toEqual([[aman.id, aMember.id, 1000]]);
  });

  test('only confirmed settlements count against a debt', async ({ api }) => {
    const { A, B, aMember, bMember, group, amount } = await yashOwesPriya(api, 10_000);
    expect((await A.debts(group.id)).map((d) => d.amount)).toEqual([amount]);
    await B.markSettled({ groupId: group.id, fromMemberId: aMember.id, toMemberId: bMember.id, amount: 4000 });
    expect((await A.debts(group.id)).map((d) => d.amount)).toEqual([6000]);
    const s = await A.post<Settlement>(`/groups/${group.id}/settlements`, { fromMemberId: aMember.id, toMemberId: bMember.id, amount: 6000, rail: 'invoice' });
    // Still owed while the payment is on its way.
    expect((await A.debts(group.id)).map((d) => d.amount)).toEqual([6000]);
    await untilStatus(A, s.id, 'confirmed');
    expect(await A.debts(group.id)).toEqual([]);
  });
});

test.describe('Settlements', () => {
  test('a simulated payment walks created → awaiting_payment → in_flight → confirmed, with a proof', async ({ api }) => {
    const { A, aMember, bMember, group, amount } = await yashOwesPriya(api);
    const started = Date.now();
    const s = await A.post<Settlement>(`/groups/${group.id}/settlements`, {
      fromMemberId: aMember.id,
      toMemberId: bMember.id,
      amount,
      rail: 'invoice',
    });
    expect(s).toMatchObject({ status: 'created', rail: 'invoice', amount, currency: 'INR', groupId: group.id });
    const awaiting = await untilStatus(A, s.id, 'awaiting_payment');
    expect(awaiting.destination).toMatch(/^lnbc/);
    expect(awaiting.quote).toMatchObject({ amountFiat: amount, currency: 'INR', rateFiatPerBtc: 9_000_000, rateSource: { kind: 'demo' } });
    expect(awaiting.quote!.amountSat).toBe(Math.round((amount / 100 / 9_000_000) * 1e8));
    expect(awaiting.quote!.feeSat).toBeGreaterThanOrEqual(2);
    await untilStatus(A, s.id, 'in_flight');
    const done = await untilStatus(A, s.id, 'confirmed');
    expect(done.preimage).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(PAYMENT_MS - 100);
    expect((await A.settlements(group.id)).map((x) => x.id)).toEqual([s.id]);
    const history = await A.history(group.id);
    expect(history[0]).toMatchObject({ kind: 'settled', settlement: { id: s.id, status: 'confirmed' } });
    expect(history[0].byMemberId).toBeUndefined();
  });

  test('the events stream sends each status until the payment is done', async ({ api }) => {
    const { A, aMember, bMember, group, amount, yash } = await yashOwesPriya(api);
    const s = await A.post<Settlement>(`/groups/${group.id}/settlements`, { fromMemberId: aMember.id, toMemberId: bMember.id, amount, rail: 'invoice' });
    const res = await fetch(`${API_URL}/settlements/${s.id}/events`, { headers: { authorization: `Bearer ${yash.token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 15_000;
    while (!text.includes('"confirmed"') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    const statuses = [...text.matchAll(/^data: (.*)$/gm)].map((m) => (JSON.parse(m[1]) as Settlement).status);
    expect(statuses).toEqual(['created', 'awaiting_payment', 'in_flight', 'confirmed']);
    expect(text).toMatch(/^event: settlement$/m);
  });

  test('the events stream is members only', async ({ api }) => {
    const { A, aMember, bMember, group, amount } = await yashOwesPriya(api);
    const s = await A.post<Settlement>(`/groups/${group.id}/settlements`, { fromMemberId: aMember.id, toMemberId: bMember.id, amount, rail: 'invoice' });
    const stranger = await api.account('Stranger');
    const r = await fetch(`${API_URL}/settlements/${s.id}/events`, { headers: { authorization: `Bearer ${stranger.token}` } });
    expect(r.status).toBe(404);
    const none = await fetch(`${API_URL}/settlements/${s.id}/events`);
    expect(none.status).toBe(401);
    const missing = await fetch(`${API_URL}/settlements/s-nope/events`, { headers: { authorization: `Bearer ${stranger.token}` } });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ code: 'not_found', message: 'That payment doesn’t exist.' });
  });

  test('the rules on starting a payment', async ({ api }) => {
    const { A, B, aMember, bMember, group, amount } = await yashOwesPriya(api);
    const path = `/groups/${group.id}/settlements`;
    const self = await refused(A.post(path, { fromMemberId: aMember.id, toMemberId: aMember.id, amount, rail: 'invoice' }));
    expect(self.status).toBe(400);
    expect(self.message).toBe('Someone can’t settle with themselves.');
    const tooMuch = await refused(A.post(path, { fromMemberId: aMember.id, toMemberId: bMember.id, amount: amount + 1, rail: 'invoice' }));
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.message).toBe('That’s more than is owed. Refresh and try again.');
    const wrongWay = await refused(B.post(path, { fromMemberId: bMember.id, toMemberId: aMember.id, amount, rail: 'invoice' }));
    expect(wrongWay.status).toBe(409);
    expect(wrongWay.message).toBe('Nothing is owed here any more.');
    const manual = await refused(A.post(path, { fromMemberId: aMember.id, toMemberId: bMember.id, amount, rail: 'manual' }));
    expect(manual.status).toBe(400);
    expect(manual.message).toBe('Use /settlements/manual for manual settlements.');
    const notPayer = await refused(B.post(path, { fromMemberId: aMember.id, toMemberId: bMember.id, amount, rail: 'invoice' }));
    expect(notPayer.status).toBe(400);
    expect(notPayer.message).toBe('Only Yash can pay this.');
    const zero = await refused(A.post(path, { fromMemberId: aMember.id, toMemberId: bMember.id, amount: 0, rail: 'invoice' }));
    expect(zero.status).toBe(400);
    const badRail = await refused(A.post(path, { fromMemberId: aMember.id, toMemberId: bMember.id, amount, rail: 'upi' }));
    expect(badRail.status).toBe(400);
    expect(badRail.message).toMatch(/^rail: /);
    const outsider = await refused(A.post(path, { fromMemberId: aMember.id, toMemberId: 'm-nope', amount, rail: 'invoice' }));
    expect(outsider.status).toBe(404);
    expect(outsider.message).toBe('That member isn’t in this group.');

    const first = await A.post<Settlement>(path, { fromMemberId: aMember.id, toMemberId: bMember.id, amount, rail: 'invoice' });
    const second = await refused(A.post(path, { fromMemberId: aMember.id, toMemberId: bMember.id, amount, rail: 'invoice' }));
    expect(second.status).toBe(409);
    expect(second.message).toBe('A payment for this is already in progress. Wait for it to finish.');
    const part = await refused(A.post(path, { fromMemberId: aMember.id, toMemberId: bMember.id, amount: 1, rail: 'invoice' }));
    expect(part.message).toBe('A payment for this is already in progress. Wait for it to finish.');
    await untilStatus(A, first.id, 'confirmed');
    const after = await refused(A.post(path, { fromMemberId: aMember.id, toMemberId: bMember.id, amount, rail: 'invoice' }));
    expect(after.message).toBe('Nothing is owed here any more.');
  });

  test('a payment to a ghost with nowhere to receive is refused; to one with an address it goes', async ({ api }) => {
    const { A, aMember, group } = await pair(api, { people: ['Priya', 'Aman'] });
    const aman = await A.memberNamed(group.id, 'Aman');
    await spend(A, group, { amount: 2000, paidBy: aman, between: [aMember, aman] });
    const path = `/groups/${group.id}/settlements`;
    const nowhere = await refused(A.post(path, { fromMemberId: aMember.id, toMemberId: aman.id, amount: 1000, rail: 'invoice' }));
    expect(nowhere.status).toBe(409);
    expect(nowhere.code).toBe('member_cannot_receive');
    expect(nowhere.message).toBe('Aman has nowhere to receive this yet.');
    await A.put(`/members/${aman.id}/payout-address`, { address: 'aman@walletofsatoshi.com' });
    const s = await A.post<Settlement>(path, { fromMemberId: aMember.id, toMemberId: aman.id, amount: 1000, rail: 'lightning_address' });
    const awaiting = await untilStatus(A, s.id, 'awaiting_payment');
    expect(awaiting.destination).toBe('aman@walletofsatoshi.com');
    await untilStatus(A, s.id, 'confirmed');
  });

  test('marking settled by hand: the payee’s word, or the payer’s for a ghost', async ({ api }) => {
    const { A, B, aMember, bMember, group, amount } = await yashOwesPriya(api, 10_000, { people: ['Priya', 'Aman'] });
    const aman = await A.memberNamed(group.id, 'Aman');
    await spend(A, group, { description: 'Cab', amount: 400, paidBy: aman, between: [aMember, aman] });
    const path = `/groups/${group.id}/settlements/manual`;

    const payer = await refused(A.post(path, { fromMemberId: aMember.id, toMemberId: bMember.id, amount }));
    expect(payer.status).toBe(400);
    expect(payer.message).toBe('Only Priya can mark this as settled.');
    const bystander = await refused(B.post(path, { fromMemberId: aMember.id, toMemberId: aman.id, amount: 200 }));
    expect(bystander.status).toBe(400);
    expect(bystander.message).toBe('Only Yash can mark this as settled.');
    const longNote = await refused(B.post(path, { fromMemberId: aMember.id, toMemberId: bMember.id, amount, note: 'n'.repeat(201) }));
    expect(longNote.status).toBe(400);
    expect(longNote.message).toMatch(/^note: /);

    const part = await B.post<Settlement>(path, { fromMemberId: aMember.id, toMemberId: bMember.id, amount: 4000, note: 'cash' });
    expect(part).toMatchObject({ rail: 'manual', status: 'manually_confirmed', amount: 4000, note: 'cash', recordedByMemberId: bMember.id });
    expect((await A.debts(group.id)).find((d) => d.toMemberId === bMember.id)!.amount).toBe(6000);
    const ghostPayee = await A.post<Settlement>(path, { fromMemberId: aMember.id, toMemberId: aman.id, amount: 200 });
    expect(ghostPayee).toMatchObject({ status: 'manually_confirmed', recordedByMemberId: aMember.id });
    expect(ghostPayee.note).toBeUndefined();
    const tooMuch = await refused(B.post(path, { fromMemberId: aMember.id, toMemberId: bMember.id, amount: 6001 }));
    expect(tooMuch.message).toBe('That’s more than is owed. Refresh and try again.');
    const history = await A.history(group.id);
    expect(history.filter((h) => h.kind === 'settled').map((h) => h.byMemberId)).toEqual([aMember.id, bMember.id]);
  });

  test('nothing settles a debt by hand while an invoice for it is still out', async ({ api }) => {
    const { A, B, aMember, bMember, group, amount } = await yashOwesPriya(api);
    await A.post(`/groups/${group.id}/settlements`, { fromMemberId: aMember.id, toMemberId: bMember.id, amount, rail: 'invoice' });
    const r = await refused(B.markSettled({ groupId: group.id, fromMemberId: aMember.id, toMemberId: bMember.id, amount }));
    expect(r.status).toBe(409);
    expect(r.message).toBe('A Lightning payment for this is under way. Wait for it to finish or its invoice to expire, then try again.');
  });

  test('a proof is 64 hex characters, and a simulated payment has no invoice to prove', async ({ api }) => {
    const { A, B, aMember, bMember, group, amount } = await yashOwesPriya(api);
    const s = await A.post<Settlement>(`/groups/${group.id}/settlements`, { fromMemberId: aMember.id, toMemberId: bMember.id, amount, rail: 'invoice' });
    const shape = await refused(A.post(`/settlements/${s.id}/proof`, { preimage: 'abc' }));
    expect(shape.status).toBe(400);
    expect(shape.message).toBe('That isn’t a payment proof. It’s 64 characters of 0–9 and a–f, from your wallet’s payment details.');
    const tooLong = await refused(A.post(`/settlements/${s.id}/proof`, { preimage: 'a'.repeat(201) }));
    expect(tooLong.message).toMatch(/^preimage: /);
    const noInvoice = await refused(B.post(`/settlements/${s.id}/proof`, { preimage: 'a'.repeat(64) }));
    expect(noInvoice.status).toBe(400);
    expect(noInvoice.message).toBe('This payment never had an invoice, so there’s nothing to prove.');
    const manual = await B.markSettled({ groupId: group.id, fromMemberId: bMember.id, toMemberId: aMember.id, amount: 1 }).catch(() => null);
    expect(manual).toBeNull();
    const stranger = api.as((await api.account('Stranger')).token);
    const notTheirs = await refused(stranger.post(`/settlements/${s.id}/proof`, { preimage: 'a'.repeat(64) }));
    expect(notTheirs.status).toBe(404);
    const unknown = await refused(A.post('/settlements/s-nope/proof', { preimage: 'a'.repeat(64) }));
    expect(unknown.message).toBe('That payment doesn’t exist.');
  });

  test('a settlement is seen only by the people in its group', async ({ api }) => {
    const { A, B, aMember, bMember, group, amount } = await yashOwesPriya(api);
    const s = await A.post<Settlement>(`/groups/${group.id}/settlements`, { fromMemberId: aMember.id, toMemberId: bMember.id, amount, rail: 'invoice' });
    expect((await B.get<Settlement>(`/settlements/${s.id}`)).id).toBe(s.id);
    const stranger = api.as((await api.account('Stranger')).token);
    const r = await refused(stranger.get(`/settlements/${s.id}`));
    expect(r.status).toBe(404);
    expect(r.message).toBe('That group doesn’t exist.');
    const missing = await refused(A.get('/settlements/s-nope'));
    expect(missing.message).toBe('That payment doesn’t exist.');
  });
});

test.describe('Idempotency', () => {
  test('the same key on the same route replays the first answer and does the thing once', async ({ api }) => {
    const me = api.as((await api.account('Yash')).token);
    const key = newKey();
    const first = await me.raw<Group>('POST', '/groups', { name: 'Once', memberNames: ['Priya'] }, { key });
    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replay']).toBeUndefined();
    const second = await me.raw<Group>('POST', '/groups', { name: 'Once', memberNames: ['Priya'] }, { key });
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body).toEqual(first.body);
    // Even with a different body: the key is what counts.
    const third = await me.raw<Group>('POST', '/groups', { name: 'Twice?', memberNames: [] }, { key });
    expect(third.body).toEqual(first.body);
    expect((await me.groups()).map((g) => g.name)).toEqual(['Once']);
  });

  test('a key is tied to its route', async ({ api }) => {
    const me = api.as((await api.account('Yash')).token);
    const key = newKey();
    const g = await me.post<Group>('/groups', { name: 'Trip', memberNames: ['Priya'] }, key);
    const r = await refused(me.post(`/groups/${g.id}/members`, { displayName: 'Aman' }, key));
    expect(r.status).toBe(409);
    expect(r.message).toBe('That request key was already used for something else.');
    expect((await me.members(g.id)).map((m) => m.displayName)).toEqual(['Yash', 'Priya']);
  });

  test('a key whose attempt failed is free for a retry that succeeds', async ({ api }) => {
    const me = api.as((await api.account('Yash')).token);
    const key = newKey();
    const bad = await refused(me.post('/groups', { name: '', memberNames: [] }, key));
    expect(bad.status).toBe(400);
    const g = await me.post<Group>('/groups', { name: 'Fixed', memberNames: [] }, key);
    expect(g.name).toBe('Fixed');
    const replay = await me.raw<Group>('POST', '/groups', { name: 'Fixed', memberNames: [] }, { key });
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body.id).toBe(g.id);
  });

  test('keys are per account: two people may use the same key', async ({ api }) => {
    const a = api.as((await api.account('Yash')).token);
    const b = api.as((await api.account('Priya')).token);
    const key = newKey();
    const ga = await a.post<Group>('/groups', { name: 'A', memberNames: [] }, key);
    const gb = await b.post<Group>('/groups', { name: 'B', memberNames: [] }, key);
    expect(ga.id).not.toBe(gb.id);
    expect(gb.name).toBe('B');
  });

  test('public routes share one guest’s keys: another link with the same key is refused', async ({ api }) => {
    const one = await yashOwesPriya(api);
    const two = await yashOwesPriya(api);
    const linkOne = await one.B.createPayLink({ groupId: one.group.id, fromMemberId: one.aMember.id, toMemberId: one.bMember.id, amount: one.amount });
    const linkTwo = await two.B.createPayLink({ groupId: two.group.id, fromMemberId: two.aMember.id, toMemberId: two.bMember.id, amount: two.amount });
    const key = newKey();
    const first = await api.raw<{ settlement?: Settlement }>('POST', `/s/${linkOne.token}/open`, undefined, { token: null, key });
    expect(first.status).toBe(200);
    expect(first.body.settlement?.status).toBe('created');
    // The same guest asking again gets the same answer, and no second invoice.
    const again = await api.raw<{ settlement?: Settlement }>('POST', `/s/${linkOne.token}/open`, undefined, { token: null, key });
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.body.settlement?.id).toBe(first.body.settlement?.id);
    // Every guest is 'guest' to the key store, so the same key on another link is another route.
    const other = await api.raw<{ code: string; message: string }>('POST', `/s/${linkTwo.token}/open`, undefined, { token: null, key });
    expect(other.status).toBe(409);
    expect(other.body.message).toBe('That request key was already used for something else.');
  });
});

test.describe('Joining', () => {
  test('a dead or made-up link is 404, and the join view carries names and refs only', async ({ api }) => {
    const bad = await refused(api.joinView('no-such-link'));
    expect(bad.status).toBe(404);
    expect(bad.message).toBe('This link is no longer valid.');
    const { A, link, group } = await pair(api, { people: ['Priya', 'Aman'] });
    const view = await api.joinView(link.token);
    expect(view).toEqual({
      groupName: 'Goa trip',
      approveJoins: false,
      members: [{ ref: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/), name: 'Aman' }],
      joined: ['Yash', 'Priya'],
      rejoin: [
        { ref: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/), name: 'Yash' },
        { ref: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/), name: 'Priya' },
      ],
    });
    for (const k of ID_KEYS) expect([...keysOf(view)], k).not.toContain(k);
    // The refs are for this link alone: a new link gets new ones.
    const fresh = await A.createGroupLink(group.id);
    const view2 = await api.joinView(fresh.token);
    expect(view2.members[0].ref).not.toBe(view.members[0].ref);
    const old = await refused(api.joinView(link.token));
    expect(old.status).toBe(404);
  });

  test('joining: once, as a ghost or a new name, and the rules on names', async ({ api }) => {
    const { A, B, link, group, yash } = await pair(api, { people: ['Priya', 'Aman'] });
    const again = await refused(B.join(link.token, { displayName: 'Priya again' }));
    expect(again.status).toBe(409);
    expect(again.message).toBe('You’re already in this group.');

    const C = api.as((await api.account('Chetan')).token);
    const waiting = await refused(C.join(link.token, { displayName: ' aman ' }));
    expect(waiting.status).toBe(409);
    expect(waiting.message).toBe('Aman is already in this group. Pick that name to join as them.');
    const taken = await refused(C.join(link.token, { displayName: 'priya' }));
    expect(taken.status).toBe(409);
    expect(taken.message).toBe('Priya has already joined. If that’s you, pick Priya on the list. Otherwise give a name that tells you apart.');
    const view = await api.joinView(link.token);
    const priyaRef = view.rejoin!.find((m) => m.name === 'Priya')!.ref;
    const holder = await refused(C.join(link.token, { ref: priyaRef }));
    expect(holder.status).toBe(409);
    expect(holder.message).toBe('Priya has already joined. To take the name back, ask, and someone in the group lets you in.');
    const bogus = await refused(C.join(link.token, { ref: 'AAAAAAAAAAAAAAAA' }));
    expect(bogus.status).toBe(404);
    expect(bogus.message).toBe('That person is no longer in this group.');
    const shape = await refused(C.join(link.token, {} as never));
    expect(shape.status).toBe(400);
    const dead = await refused(C.join('no-such-link', { displayName: 'Chetan' }));
    expect(dead.status).toBe(404);

    const asAman = await C.join(link.token, { ref: view.members[0].ref });
    expect(asAman).toMatchObject({ displayName: 'Aman', status: 'joined', groupId: group.id });
    expect(asAman.claimedByUserId).toEqual(expect.any(String));
    const D = api.as((await api.account('Dev')).token);
    const asNew = await D.join(link.token, { displayName: 'Dev' });
    expect(asNew).toMatchObject({ displayName: 'Dev', status: 'joined' });
    expect((await A.members(group.id)).map((m) => m.displayName)).toEqual(['Yash', 'Priya', 'Aman', 'Dev']);
    // The people who joined by the link can't vouch: the join view now offers nobody to claim.
    expect((await api.joinView(link.token)).members).toEqual([]);
    expect(yash.user.id).toBe((await A.me()).id);
  });

  test('a group that approves joins turns joining into asking', async ({ api }) => {
    const { A, link, group } = await pair(api, { people: ['Priya', 'Aman'], approveJoins: true });
    const C = api.as((await api.account('Chetan')).token);
    const view = await api.joinView(link.token);
    expect(view.approveJoins).toBe(true);
    const r = await refused(C.join(link.token, { ref: view.members[0].ref }));
    expect(r.status).toBe(409);
    expect(r.message).toBe('Someone in Goa trip has to let you in. Ask to join instead.');
    const req = await C.askToJoin(link.token, { ref: view.members[0].ref });
    expect(req).toEqual({
      id: expect.stringMatching(/^jr/),
      groupName: 'Goa trip',
      name: 'Aman',
      code: expect.stringMatching(/^\d{4}$/),
      status: 'pending',
      createdAt: expect.any(String),
    });
    expect(await C.myJoinRequests()).toEqual([req]);
    expect(await C.groups()).toEqual([]);
    const pending = await A.pendingJoins(group.id);
    expect(pending).toEqual([{ id: req.id, name: 'Aman', existing: true, code: req.code, createdAt: req.createdAt }]);
    const member = await A.approveJoin(req.id);
    expect(member).toMatchObject({ displayName: 'Aman', status: 'joined' });
    expect(await C.myJoinRequests()).toEqual([]);
    expect((await C.groups()).map((g) => g.id)).toEqual([group.id]);
    expect(await A.pendingJoins(group.id)).toEqual([]);
    const gone = await refused(A.approveJoin(req.id));
    expect(gone.status).toBe(404);
    expect(gone.message).toBe('Nobody is waiting to join with that request.');
  });

  test('asking again replaces the last request; one who is in can’t ask; at most 20 wait', async ({ api }) => {
    const { A, B, link, group } = await pair(api, { people: ['Priya', 'Aman'], approveJoins: true });
    const C = api.as((await api.account('Chetan')).token);
    const view = await api.joinView(link.token);
    const first = await C.askToJoin(link.token, { ref: view.members[0].ref });
    const second = await C.askToJoin(link.token, { displayName: 'Chetan' });
    expect(second.id).not.toBe(first.id);
    expect(second.name).toBe('Chetan');
    expect(await C.myJoinRequests()).toEqual([second]);
    expect((await A.pendingJoins(group.id)).map((p) => p.id)).toEqual([second.id]);
    const inAlready = await refused(B.askToJoin(link.token, { displayName: 'Priya 2' }));
    expect(inAlready.status).toBe(409);
    expect(inAlready.message).toBe('You’re already in this group.');

    for (let i = 1; i < 20; i++) {
      const other = api.as((await api.account(`Asker ${i}`)).token);
      await other.askToJoin(link.token, { displayName: `Asker ${i}` });
    }
    expect(await A.pendingJoins(group.id)).toHaveLength(20);
    const extra = api.as((await api.account('Asker 21')).token);
    const full = await refused(extra.askToJoin(link.token, { displayName: 'Asker 21' }));
    expect(full.status).toBe(409);
    expect(full.message).toBe('Too many people are waiting to join this group. Ask someone in it to look at who’s waiting.');
    // Someone already waiting may still change their request.
    const changed = await C.askToJoin(link.token, { displayName: 'Chetan K' });
    expect(changed.name).toBe('Chetan K');
  });

  test('turning down, taking back, and the rules around them', async ({ api }) => {
    const { A, link, group } = await pair(api, { people: ['Priya', 'Aman'], approveJoins: true });
    const C = api.as((await api.account('Chetan')).token);
    const D = api.as((await api.account('Dev')).token);
    const stranger = api.as((await api.account('Stranger')).token);
    const view = await api.joinView(link.token);
    const req = await C.askToJoin(link.token, { ref: view.members[0].ref });

    const notIn = await refused(stranger.approveJoin(req.id));
    expect(notIn.status).toBe(404);
    expect(notIn.message).toBe('That group doesn’t exist.');
    const notInDecline = await refused(stranger.post(`/join-requests/${req.id}/decline`));
    expect(notInDecline.status).toBe(404);
    const notTheirs = await refused(D.del(`/join-requests/${req.id}`));
    expect(notTheirs.status).toBe(404);
    expect(notTheirs.message).toBe('That request isn’t there any more.');

    await A.post(`/join-requests/${req.id}/decline`);
    const seen = await C.myJoinRequests();
    expect(seen).toEqual([{ ...req, status: 'declined' }]);
    expect(await A.pendingJoins(group.id)).toEqual([]);
    const declined = await refused(A.approveJoin(req.id));
    expect(declined.status).toBe(409);
    expect(declined.message).toBe('Aman was already turned down.');
    await C.del(`/join-requests/${req.id}`);
    expect(await C.myJoinRequests()).toEqual([]);
    const missing = await refused(A.approveJoin('jr-nope'));
    expect(missing.status).toBe(404);
    expect(missing.message).toBe('Nobody is waiting to join with that request.');
  });

  test('someone joining as a ghost turns down everyone else asking to be them', async ({ api }) => {
    const { A, link, group } = await pair(api, { people: ['Priya', 'Aman'] });
    const C = api.as((await api.account('Chetan')).token);
    const D = api.as((await api.account('Dev')).token);
    const view = await api.joinView(link.token);
    const amanRef = view.members[0].ref;
    // Asking is allowed even where joining is open.
    const req = await C.askToJoin(link.token, { ref: amanRef });
    expect((await A.pendingJoins(group.id)).map((p) => p.id)).toEqual([req.id]);
    await D.join(link.token, { ref: amanRef });
    expect((await C.myJoinRequests())[0].status).toBe('declined');
    const r = await refused(A.approveJoin(req.id));
    expect(r.status).toBe(409);
    expect(r.message).toBe('Aman was already turned down.');
  });

  test('a request from someone who has since joined is refused as already in', async ({ api }) => {
    const { A, link, group } = await pair(api, { people: ['Priya', 'Aman', 'Rohan'] });
    const C = api.as((await api.account('Chetan')).token);
    const view = await api.joinView(link.token);
    const req = await C.askToJoin(link.token, { ref: view.members.find((m) => m.name === 'Aman')!.ref });
    // Joining by the open link takes the request with it.
    await C.join(link.token, { ref: view.members.find((m) => m.name === 'Rohan')!.ref });
    expect(await C.myJoinRequests()).toEqual([]);
    const gone = await refused(A.approveJoin(req.id));
    expect(gone.status).toBe(404);
    expect((await A.members(group.id)).find((m) => m.displayName === 'Aman')!.claimedByUserId).toBeUndefined();
  });

  test('taking a name back: only the holder or someone who can vouch may say yes, and the old account leaves', async ({ api }) => {
    const { A, B, link, group, bMember } = await pair(api, { people: ['Priya', 'Aman'] });
    // Dev joins by the link alone, as Aman: no yes behind them, so they can't vouch.
    const D = api.as((await api.account('Dev')).token);
    const view = await api.joinView(link.token);
    await D.join(link.token, { ref: view.members[0].ref });
    // Priya lost her phone: a new account asks to be Priya again.
    const C = api.as((await api.account('Priya on a new phone')).token);
    const priyaRef = (await api.joinView(link.token)).rejoin!.find((m) => m.name === 'Priya')!.ref;
    const req = await C.askToJoin(link.token, { ref: priyaRef });
    expect(req).toMatchObject({ name: 'Priya', takesOver: true, status: 'pending' });

    // Who sees it: the holder as a takeover of their place, the maker as someone's, Dev not at all.
    expect(await B.pendingJoins(group.id)).toEqual([expect.objectContaining({ id: req.id, name: 'Priya', existing: true, replacing: 'you' })]);
    expect(await A.pendingJoins(group.id)).toEqual([expect.objectContaining({ id: req.id, replacing: 'someone' })]);
    expect(await D.pendingJoins(group.id)).toEqual([]);

    const linkOnly = await refused(D.approveJoin(req.id));
    expect(linkOnly.status).toBe(400);
    expect(linkOnly.message).toBe('You joined by the link alone, so you can’t hand over Priya’s place. Someone who made the group or was let in with a yes can.');

    const moved = await A.approveJoin(req.id);
    expect(moved.id).toBe(bMember.id);
    expect(moved.claimedByUserId).toBe((await C.me()).id);
    const lost = await refused(B.group(group.id));
    expect(lost.status).toBe(404);
    expect(await B.groups()).toEqual([]);
    expect((await C.groups()).map((g) => g.id)).toEqual([group.id]);
    expect((await A.members(group.id)).filter((m) => m.displayName === 'Priya')).toHaveLength(1);
  });

  test('the holder can hand their own place to a new device', async ({ api }) => {
    const { B, link, group, bMember } = await pair(api);
    const C = api.as((await api.account('Priya 2')).token);
    const priyaRef = (await api.joinView(link.token)).rejoin!.find((m) => m.name === 'Priya')!.ref;
    const req = await C.askToJoin(link.token, { ref: priyaRef });
    const moved = await B.approveJoin(req.id);
    expect(moved.id).toBe(bMember.id);
    expect(await B.groups()).toEqual([]);
    expect((await C.myMember(group.id)).id).toBe(bMember.id);
  });

  test('a takeover waits while a payment to the holder is on its way', async ({ api }) => {
    const { A, B, aMember, bMember, group, link, amount } = await yashOwesPriya(api);
    const C = api.as((await api.account('Priya 2')).token);
    const priyaRef = (await api.joinView(link.token)).rejoin!.find((m) => m.name === 'Priya')!.ref;
    const req = await C.askToJoin(link.token, { ref: priyaRef });
    await A.post(`/groups/${group.id}/settlements`, { fromMemberId: aMember.id, toMemberId: bMember.id, amount, rail: 'invoice' });
    const r = await refused(B.approveJoin(req.id));
    expect(r.status).toBe(409);
    expect(r.message).toBe('A payment to Priya is still in progress. Wait for it to finish.');
  });

  test('the link’s group is given only to someone in it', async ({ api }) => {
    const { A, link, group } = await pair(api);
    expect((await A.get<Group | null>(`/links/${link.token}/group`))?.id).toBe(group.id);
    const C = api.as((await api.account('Chetan')).token);
    expect(await C.get<Group | null>(`/links/${link.token}/group`)).toBeNull();
    const dead = await refused(C.get('/links/no-such-link/group'));
    expect(dead.status).toBe(404);
    const anon = await api.raw<{ code: string }>('GET', `/links/${link.token}/group`);
    expect(anon.status).toBe(401);
  });

  test('turning the link off kills the group page and the join page', async ({ api }) => {
    const { A, link, group } = await pair(api);
    await A.del(`/groups/${group.id}/link`);
    expect(await A.groupLink(group.id)).toBeNull();
    for (const attempt of [() => api.joinView(link.token), () => api.groupGuestView(link.token)]) {
      const r = await refused(attempt);
      expect(r.status).toBe(404);
      expect(r.message).toBe('This link is no longer valid.');
    }
    const C = api.as((await api.account('Chetan')).token);
    expect((await refused(C.join(link.token, { displayName: 'Chetan' }))).status).toBe(404);
  });
});

test.describe('Group links', () => {
  test('a group has no link until one is made; making another replaces it', async ({ api }) => {
    const me = api.as((await api.account('Yash')).token);
    const g = await me.createGroup({ name: 'Trip', memberNames: ['Priya'] });
    expect(await me.groupLink(g.id)).toBeNull();
    const first = await me.createGroupLink(g.id);
    expect(first).toEqual({ token: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/), groupId: g.id, createdAt: expect.any(String) });
    expect(await me.groupLink(g.id)).toEqual(first);
    const second = await me.createGroupLink(g.id);
    expect(second.token).not.toBe(first.token);
    expect(await me.groupLink(g.id)).toEqual(second);
    expect((await refused(api.groupGuestView(first.token))).status).toBe(404);
    expect((await api.groupGuestView(second.token)).groupName).toBe('Trip');
  });

  test('the group page shows names and amounts, never ids, and says how each debt can be paid', async ({ api }) => {
    const { A, B, aMember, bMember, group, link } = await yashOwesPriya(api, 10_000, { people: ['Priya', 'Aman'] });
    const aman = await A.memberNamed(group.id, 'Aman');
    await spend(A, group, { description: 'Cab', amount: 600, paidBy: aman, between: [aMember, aman] });
    const view = await api.groupGuestView(link.token);
    for (const k of ID_KEYS) expect([...keysOf(view)], k).not.toContain(k);
    expect(view).toMatchObject({ groupName: 'Goa trip', currency: 'INR', approveJoins: false });
    expect(view.expenses).toEqual([
      {
        description: 'Dinner',
        amount: 20_000,
        paidBy: 'Priya',
        shares: [
          { name: 'Yash', amount: 10_000 },
          { name: 'Priya', amount: 10_000 },
        ],
        createdAt: expect.any(String),
      },
      { description: 'Cab', amount: 600, paidBy: 'Aman', shares: [{ name: 'Yash', amount: 300 }, { name: 'Aman', amount: 300 }], createdAt: expect.any(String) },
    ]);
    const toPriya = view.debts.find((d) => d.to === 'Priya')!;
    expect(toPriya).toEqual({ ref: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/), from: 'Yash', to: 'Priya', amount: 10_000, payable: true });
    const toAman = view.debts.find((d) => d.to === 'Aman')!;
    expect(toAman).toMatchObject({ from: 'Yash', amount: 300, payable: false });
    expect(toAman.upi).toBeUndefined();
    await B.setUpiId('priya@okhdfcbank');
    const withUpi = (await api.groupGuestView(link.token)).debts.find((d) => d.to === 'Priya')!;
    expect(withUpi.upi).toBe(true);
    expect(withUpi.ref).toBe(toPriya.ref);
    expect(JSON.stringify(withUpi)).not.toContain('priya@okhdfcbank');
    expect(bMember.id).toBeTruthy();
  });

  test('paying a debt from the page: a pay link, the same one again, and the refusals', async ({ api }) => {
    const { A, B, aMember, bMember, group, link, amount } = await yashOwesPriya(api, 10_000, { people: ['Priya', 'Aman'] });
    const aman = await A.memberNamed(group.id, 'Aman');
    await spend(A, group, { description: 'Cab', amount: 600, paidBy: aman, between: [aMember, aman] });
    const view = await api.groupGuestView(link.token);
    const toPriya = view.debts.find((d) => d.to === 'Priya')!;
    const toAman = view.debts.find((d) => d.to === 'Aman')!;

    const made = await api.raw<{ token: string }>('POST', `/g/${link.token}/debts/${toPriya.ref}/pay-link`, undefined, { token: null });
    expect(made.status).toBe(201);
    expect(made.body.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const again = await api.raw<{ token: string }>('POST', `/g/${link.token}/debts/${toPriya.ref}/pay-link`, undefined, { token: null });
    expect(again.body.token).toBe(made.body.token);
    const guest = await api.guestView(made.body.token);
    expect(guest).toMatchObject({ payerName: 'Yash', payeeName: 'Priya', amount, reason: 'Goa trip', payable: true });

    const ghost = await refused(api.call('POST', `/g/${link.token}/debts/${toAman.ref}/pay-link`, undefined, { token: null }));
    expect(ghost.status).toBe(409);
    expect(ghost.code).toBe('member_cannot_receive');
    expect(ghost.message).toBe('Aman has nowhere to receive this yet.');
    const bogus = await refused(api.call('POST', `/g/${link.token}/debts/AAAAAAAAAAAAAAAA/pay-link`, undefined, { token: null }));
    expect(bogus.status).toBe(410);
    expect(bogus.code).toBe('link_expired');
    expect(bogus.message).toBe('This has already been settled.');
    const deadLink = await refused(api.call('POST', `/g/no-such-link/debts/${toPriya.ref}/pay-link`, undefined, { token: null }));
    expect(deadLink.status).toBe(404);

    // Once settled another way, the debt is gone from the page and its ref is dead.
    await B.markSettled({ groupId: group.id, fromMemberId: aMember.id, toMemberId: bMember.id, amount });
    const settled = await refused(api.call('POST', `/g/${link.token}/debts/${toPriya.ref}/pay-link`, undefined, { token: null }));
    expect(settled.status).toBe(410);
    expect((await api.groupGuestView(link.token)).debts.map((d) => d.to)).toEqual(['Aman']);
    // The pay link it handed out shows that settlement.
    expect((await api.guestView(made.body.token)).settlement?.status).toBe('manually_confirmed');
  });

  test('UPI from the page: who to pay, only when they allow it, and a claim that waits on them', async ({ api }) => {
    const { A, B, aMember, bMember, group, link, amount } = await yashOwesPriya(api);
    const ref = (await api.groupGuestView(link.token)).debts[0].ref;
    const off = await refused(api.call('GET', `/g/${link.token}/debts/${ref}/upi`, undefined, { token: null }));
    expect(off.status).toBe(409);
    expect(off.code).toBe('member_cannot_receive');
    expect(off.message).toBe('Priya can’t be paid by UPI from here.');
    const claimOff = await refused(api.call('POST', `/g/${link.token}/debts/${ref}/upi-claims`, undefined, { token: null }));
    expect(claimOff.status).toBe(409);

    await B.setUpiId('priya@okhdfcbank');
    expect(await api.call('GET', `/g/${link.token}/debts/${ref}/upi`, undefined, { token: null })).toEqual({ upiId: 'priya@okhdfcbank', name: 'Priya' });
    // Turned off for shared links, the ID is withheld again.
    await B.setUpiOnGroupLinks(false);
    expect((await refused(api.call('GET', `/g/${link.token}/debts/${ref}/upi`, undefined, { token: null }))).status).toBe(409);
    expect((await api.groupGuestView(link.token)).debts[0].upi).toBeUndefined();
    // Chosen for this group alone, it wins over that.
    await B.put(`/me/upi/group-links/${group.id}`, { on: true });
    expect((await api.groupGuestView(link.token)).debts[0].upi).toBe(true);

    const claimed = await api.raw('POST', `/g/${link.token}/debts/${ref}/upi-claims`, undefined, { token: null });
    expect(claimed.status).toBe(201);
    expect(claimed.body).toEqual({ ok: true });
    const claims = await B.upiClaims(group.id);
    expect(claims).toEqual([expect.objectContaining({ fromMemberId: aMember.id, toMemberId: bMember.id, amount, status: 'pending', viaLink: true })]);
    // Said again while the first waits: nothing new.
    await api.raw('POST', `/g/${link.token}/debts/${ref}/upi-claims`, undefined, { token: null });
    expect((await B.upiClaims(group.id)).map((c) => c.id)).toEqual([claims[0].id]);
    expect((await api.groupGuestView(link.token)).debts[0].upiClaim).toBe('pending');
    // The page can't settle anything: the debt is still owed.
    expect((await A.debts(group.id)).map((d) => d.amount)).toEqual([amount]);
    const settled = await B.post<Settlement>(`/upi-claims/${claims[0].id}/confirm`);
    expect(settled).toMatchObject({ rail: 'upi', status: 'manually_confirmed', amount, recordedByMemberId: bMember.id });
    expect(await A.debts(group.id)).toEqual([]);
    expect((await api.groupGuestView(link.token)).debts).toEqual([]);
  });

  test('a claim from the page waits while a Lightning payment for the debt is in progress', async ({ api }) => {
    const { A, B, aMember, bMember, group, link, amount } = await yashOwesPriya(api);
    await B.setUpiId('priya@okhdfcbank');
    const ref = (await api.groupGuestView(link.token)).debts[0].ref;
    await A.post(`/groups/${group.id}/settlements`, { fromMemberId: aMember.id, toMemberId: bMember.id, amount, rail: 'invoice' });
    const r = await refused(api.call('POST', `/g/${link.token}/debts/${ref}/upi-claims`, undefined, { token: null }));
    expect(r.status).toBe(409);
    expect(r.message).toBe('A payment for this is already in progress. Wait for it to finish.');
  });

  test('the link’s routes are members only', async ({ api }) => {
    const { group } = await pair(api);
    const stranger = api.as((await api.account('Stranger')).token);
    for (const attempt of [() => stranger.groupLink(group.id), () => stranger.createGroupLink(group.id), () => stranger.del(`/groups/${group.id}/link`)]) {
      expect((await refused(attempt)).status).toBe(404);
    }
    expect((await api.raw('POST', `/groups/${group.id}/link`)).status).toBe(401);
  });
});

test.describe('Pay links', () => {
  test('only the person owed makes one, for at most what is owed, and only with a way to be paid', async ({ api }) => {
    const { A, B, aMember, bMember, group, amount } = await yashOwesPriya(api, 10_000, { people: ['Priya', 'Aman'] });
    const aman = await A.memberNamed(group.id, 'Aman');
    await spend(A, group, { description: 'Cab', amount: 600, paidBy: aman, between: [aMember, aman] });
    const payer = await refused(A.createPayLink({ groupId: group.id, fromMemberId: aMember.id, toMemberId: bMember.id, amount }));
    expect(payer.status).toBe(400);
    expect(payer.message).toBe('Only Priya can send a link for this.');
    const tooMuch = await refused(B.createPayLink({ groupId: group.id, fromMemberId: aMember.id, toMemberId: bMember.id, amount: amount + 1 }));
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.message).toBe('That’s more than is owed. Refresh and try again.');
    const forGhost = await refused(A.createPayLink({ groupId: group.id, fromMemberId: aMember.id, toMemberId: aman.id, amount: 300 }));
    expect(forGhost.status).toBe(400);
    expect(forGhost.message).toBe('Only Aman can send a link for this.');
    const outsider = await refused(B.createPayLink({ groupId: group.id, fromMemberId: aMember.id, toMemberId: 'm-nope', amount: 1 }));
    expect(outsider.status).toBe(404);
    expect(outsider.message).toBe('That member isn’t in this group.');
    const link = await B.createPayLink({ groupId: group.id, fromMemberId: aMember.id, toMemberId: bMember.id, amount: 4000 });
    expect(link).toEqual({ token: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/), groupId: group.id, fromMemberId: aMember.id, toMemberId: bMember.id, amount: 4000, createdAt: expect.any(String) });
    // Several for one debt are allowed.
    const another = await B.createPayLink({ groupId: group.id, fromMemberId: aMember.id, toMemberId: bMember.id, amount });
    expect(another.token).not.toBe(link.token);
  });

  test('under simulated payments anyone who joined can be paid, so a link in sats is made like any other', async ({ api }) => {
    // The refusal for a payee nobody could pay (member_cannot_receive, with what to add) needs
    // real payments, where receiving takes a wallet or an address: the simulator pays anyone joined.
    const { B, aMember, bMember, group, amount } = await yashOwesPriya(api, 1000, { currency: 'BTC' });
    const link = await B.createPayLink({ groupId: group.id, fromMemberId: aMember.id, toMemberId: bMember.id, amount });
    const view = await api.guestView(link.token);
    expect(view).toMatchObject({ currency: 'BTC', amount, payable: true });
    expect(view.upi).toBeUndefined();
    const opened = await api.call<{ settlement?: Settlement }>('POST', `/s/${link.token}/open`, undefined, { token: null });
    const awaiting = await untilStatus(B, opened.settlement!.id, 'awaiting_payment');
    // In sats nothing is converted: the quote is for the sats owed, at a rate of one.
    expect(awaiting.quote).toMatchObject({ currency: 'BTC', amountFiat: amount, amountSat: amount, rateFiatPerBtc: 1, rateSource: { kind: 'demo' } });
  });

  test('the guest view carries names and amounts only, and opening mints one invoice at a time', async ({ api }) => {
    const { B, aMember, bMember, group, amount } = await yashOwesPriya(api);
    const link = await B.createPayLink({ groupId: group.id, fromMemberId: aMember.id, toMemberId: bMember.id, amount });
    const before = await api.guestView(link.token);
    expect(before).toEqual({ payerName: 'Yash', payeeName: 'Priya', reason: 'Goa trip', amount, currency: 'INR', payable: true });
    const opened = await api.call<{ settlement?: Settlement }>('POST', `/s/${link.token}/open`, undefined, { token: null });
    for (const k of ID_KEYS.filter((x) => x !== 'id')) expect([...keysOf(opened)], k).not.toContain(k);
    expect(opened.settlement).toMatchObject({ status: 'created', amount, currency: 'INR' });
    const guestKeys = Object.keys(opened.settlement!).sort();
    expect(guestKeys.every((k) => ['id', 'amount', 'currency', 'status', 'quote', 'destination', 'preimage', 'failureReason', 'updatedAt'].includes(k))).toBe(true);
    const again = await api.call<{ settlement?: Settlement }>('POST', `/s/${link.token}/open`, undefined, { token: null });
    expect(again.settlement!.id).toBe(opened.settlement!.id);
    expect((await B.settlements(group.id))).toHaveLength(1);
    await untilStatus(B, opened.settlement!.id, 'confirmed');
    const paid = await api.call<{ settlement?: Settlement }>('POST', `/s/${link.token}/open`, undefined, { token: null });
    expect(paid.settlement).toMatchObject({ id: opened.settlement!.id, status: 'confirmed', preimage: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await api.guestView(link.token)).settlement?.status).toBe('confirmed');
    // A second link for the same, now settled, debt has nothing left to pay.
    const second = await refused(B.createPayLink({ groupId: group.id, fromMemberId: aMember.id, toMemberId: bMember.id, amount }));
    expect(second.message).toBe('Nothing is owed here any more.');
  });

  test('a link whose debt shrank is 410; a smaller one is settled by the cash that shrank it', async ({ api }) => {
    const { A, B, aMember, bMember, group, amount } = await yashOwesPriya(api);
    const link = await B.createPayLink({ groupId: group.id, fromMemberId: aMember.id, toMemberId: bMember.id, amount });
    const smaller = await B.createPayLink({ groupId: group.id, fromMemberId: aMember.id, toMemberId: bMember.id, amount: 1000 });
    // Part of it paid in cash: the link for all of it no longer fits what is owed…
    const cash = await B.markSettled({ groupId: group.id, fromMemberId: aMember.id, toMemberId: bMember.id, amount: 1500 });
    const shrunk = await refused(api.call('POST', `/s/${link.token}/open`, undefined, { token: null }));
    expect(shrunk.status).toBe(410);
    expect(shrunk.code).toBe('link_expired');
    expect(shrunk.message).toBe('This has already been settled.');
    expect((await api.guestView(link.token)).settlement).toBeUndefined();
    // …and the smaller one was covered by it, so it shows that settlement rather than asking to be paid.
    const covered = await api.call<{ settlement?: Settlement }>('POST', `/s/${smaller.token}/open`, undefined, { token: null });
    expect(covered.settlement).toMatchObject({ id: cash.id, status: 'manually_confirmed' });
    // Without the invoice and proof it never had: those are for whoever paid through a link.
    expect(covered.settlement!.destination).toBeUndefined();
    expect(covered.settlement!.preimage).toBeUndefined();
    expect(await B.settlements(group.id)).toHaveLength(1);
    // A link for the rest can still be made and paid.
    const rest = await B.createPayLink({ groupId: group.id, fromMemberId: aMember.id, toMemberId: bMember.id, amount: amount - 1500 });
    const opened = await api.call<{ settlement?: Settlement }>('POST', `/s/${rest.token}/open`, undefined, { token: null });
    expect(opened.settlement?.status).toBe('created');
    await untilStatus(A, opened.settlement!.id, 'confirmed');
    expect(await A.debts(group.id)).toEqual([]);
    const nothing = await refused(B.createPayLink({ groupId: group.id, fromMemberId: aMember.id, toMemberId: bMember.id, amount: 1 }));
    expect(nothing.message).toBe('Nothing is owed here any more.');
  });

  test('with UPI on offer nothing is minted until Lightning is chosen, and a claim holds it', async ({ api }) => {
    const { A, B, aMember, bMember, group, amount } = await yashOwesPriya(api);
    await B.setUpiId('priya@okhdfcbank');
    const link = await B.createPayLink({ groupId: group.id, fromMemberId: aMember.id, toMemberId: bMember.id, amount });
    const asked = await api.call<{ upi?: boolean; settlement?: Settlement }>('POST', `/s/${link.token}/open`, undefined, { token: null });
    expect(asked.upi).toBe(true);
    expect(asked.settlement).toBeUndefined();
    expect(await B.settlements(group.id)).toEqual([]);
    expect(await api.call('GET', `/s/${link.token}/upi`, undefined, { token: null })).toEqual({ upiId: 'priya@okhdfcbank', name: 'Priya' });

    const claimed = await api.raw('POST', `/s/${link.token}/upi-claims`, undefined, { token: null });
    expect(claimed.status).toBe(201);
    expect((await api.guestView(link.token)).upiClaim).toBe('pending');
    const held = await api.call<{ settlement?: Settlement }>('POST', `/s/${link.token}/open`, { rail: 'lightning' }, { token: null });
    expect(held.settlement).toBeUndefined();
    const claim = (await B.upiClaims(group.id))[0];
    expect(claim).toMatchObject({ status: 'pending', viaLink: true, amount });
    // Nothing moved: Priya is still owed.
    expect((await A.debts(group.id)).map((d) => d.amount)).toEqual([amount]);
    const confirmed = await B.post<Settlement>(`/upi-claims/${claim.id}/confirm`);
    expect(confirmed).toMatchObject({ rail: 'upi', status: 'manually_confirmed', note: 'Paid by UPI' });
    const view = await api.guestView(link.token);
    expect(view.settlement).toMatchObject({ id: confirmed.id, status: 'manually_confirmed' });
    expect(view.upiClaim).toBeUndefined();
    const paidUpi = await refused(api.call('GET', `/s/${link.token}/upi`, undefined, { token: null }));
    expect(paidUpi.status).toBe(410);
    const paidClaim = await refused(api.call('POST', `/s/${link.token}/upi-claims`, undefined, { token: null }));
    expect(paidClaim.status).toBe(410);
  });

  test('choosing Lightning mints, and the UPI ID is withheld when shared links may not show it', async ({ api }) => {
    const { B, aMember, bMember, group, amount } = await yashOwesPriya(api);
    await B.setUpiId('priya@okhdfcbank');
    await B.setUpiOnGroupLinks(false);
    const link = await B.createPayLink({ groupId: group.id, fromMemberId: aMember.id, toMemberId: bMember.id, amount });
    const view = await api.guestView(link.token);
    expect(view.upi).toBeUndefined();
    const off = await refused(api.call('GET', `/s/${link.token}/upi`, undefined, { token: null }));
    expect(off.status).toBe(409);
    expect(off.message).toBe('Priya can’t be paid by UPI from here.');
    await B.setUpiOnGroupLinks(true);
    expect((await api.guestView(link.token)).upi).toBe(true);
    const minted = await api.call<{ settlement?: Settlement }>('POST', `/s/${link.token}/open`, { rail: 'lightning' }, { token: null });
    expect(minted.settlement?.status).toBe('created');
    const badRail = await refused(api.call('POST', `/s/${link.token}/open`, { rail: 'upi' }, { token: null }));
    expect(badRail.status).toBe(400);
  });

  test('a proof on the pay link has to be for one of its invoices', async ({ api }) => {
    const { B, aMember, bMember, group, amount } = await yashOwesPriya(api);
    const link = await B.createPayLink({ groupId: group.id, fromMemberId: aMember.id, toMemberId: bMember.id, amount });
    await api.call('POST', `/s/${link.token}/open`, undefined, { token: null });
    const shape = await refused(api.call('POST', `/s/${link.token}/proof`, { preimage: 'zz' }, { token: null }));
    expect(shape.status).toBe(400);
    expect(shape.message).toBe('That isn’t a payment proof. It’s 64 characters of 0–9 and a–f, from your wallet’s payment details.');
    const wrong = await refused(api.call('POST', `/s/${link.token}/proof`, { preimage: 'f'.repeat(64) }, { token: null }));
    expect(wrong.status).toBe(400);
    expect(wrong.message).toBe('That proof is for a different payment.');
    const dead = await refused(api.call('POST', '/s/no-such-link/proof', { preimage: 'f'.repeat(64) }, { token: null }));
    expect(dead.status).toBe(404);
  });

  test('a dead pay link is 404 everywhere', async ({ api }) => {
    for (const attempt of [
      () => api.guestView('no-such-link'),
      () => api.call('POST', '/s/no-such-link/open', undefined, { token: null }),
      () => api.call('GET', '/s/no-such-link/upi', undefined, { token: null }),
      () => api.call('POST', '/s/no-such-link/upi-claims', undefined, { token: null }),
    ]) {
      const r = await refused(attempt);
      expect(r.status).toBe(404);
      expect(r.message).toBe('This link is no longer valid.');
    }
  });
});

test.describe('UPI', () => {
  test('a UPI ID has to look like one', async ({ api }) => {
    const me = api.as((await api.account('Yash')).token);
    expect(await me.get('/me/upi')).toEqual({ upiId: null, onGroupLinks: true });
    const empty = await refused(me.setUpiId('   '));
    expect(empty.status).toBe(400);
    expect(empty.message).toBe('Enter your UPI ID.');
    const email = await refused(me.setUpiId('yash@gmail.com'));
    expect(email.message).toBe('That looks like an email or a Lightning address. A UPI ID looks like name@okhdfcbank or 98xxxxxx10@ybl.');
    const odd = await refused(me.setUpiId('yash'));
    expect(odd.message).toBe('That doesn’t look like a UPI ID. It should look like name@okhdfcbank or 98xxxxxx10@ybl.');
    const long = await refused(me.setUpiId('a'.repeat(321)));
    expect(long.status).toBe(400);
    expect(await me.setUpiId(' Yash.Pay@OKHDFCBANK ')).toEqual({ upiId: 'yash.pay@okhdfcbank', onGroupLinks: true });
    expect(await me.setUpiId('upi://pay?pa=9876543210@ybl')).toEqual({ upiId: '9876543210@ybl', onGroupLinks: true });
    expect(await me.del('/me/upi')).toEqual({ upiId: null, onGroupLinks: true });
  });

  test('who is shown a UPI ID: only someone who owes them, in a rupee group, once they have one', async ({ api }) => {
    const { A, B, aMember, bMember, group } = await yashOwesPriya(api);
    const none = await refused(A.get(`/groups/${group.id}/members/${bMember.id}/upi`));
    expect(none.status).toBe(409);
    expect(none.code).toBe('member_cannot_receive');
    expect(none.message).toBe('Priya hasn’t added a UPI ID.');
    await B.setUpiId('priya@okhdfcbank');
    expect(await A.get(`/groups/${group.id}/members/${bMember.id}/upi`)).toEqual({ upiId: 'priya@okhdfcbank', name: 'Priya' });
    const notOwing = await refused(B.get(`/groups/${group.id}/members/${aMember.id}/upi`));
    expect(notOwing.status).toBe(409);
    expect(notOwing.code).toBe('conflict');
    expect(notOwing.message).toBe('You don’t owe Yash anything right now.');
    const stranger = api.as((await api.account('Stranger')).token);
    expect((await refused(stranger.get(`/groups/${group.id}/members/${bMember.id}/upi`))).status).toBe(404);
    expect((await refused(A.get(`/groups/${group.id}/members/m-nope/upi`))).message).toBe('That member isn’t in this group.');
    // Turning the link setting off doesn't hide it from someone in the group who owes them.
    await B.setUpiOnGroupLinks(false);
    expect(await A.get(`/groups/${group.id}/members/${bMember.id}/upi`)).toEqual({ upiId: 'priya@okhdfcbank', name: 'Priya' });
  });

  test('UPI only moves rupees', async ({ api }) => {
    const { A, B, aMember, bMember, group, amount } = await yashOwesPriya(api, 1000, { currency: 'BTC' });
    await B.setUpiId('priya@okhdfcbank');
    const payee = await refused(A.get(`/groups/${group.id}/members/${bMember.id}/upi`));
    expect(payee.status).toBe(400);
    expect(payee.message).toBe('UPI only works for a group in rupees.');
    const claim = await refused(A.post(`/groups/${group.id}/upi-claims`, { fromMemberId: aMember.id, toMemberId: bMember.id, amount }));
    expect(claim.message).toBe('UPI only works for a group in rupees.');
    const report = await refused(A.post(`/groups/${group.id}/upi-payments`, { fromMemberId: aMember.id, toMemberId: bMember.id, amount, byPayer: true }));
    expect(report.message).toBe('UPI only works for a group in rupees.');
    expect((await A.members(group.id)).find((m) => m.id === bMember.id)!.upi).toBe(true);
  });

  test('a claim: the payer’s word, replaced by the next, answered by the payee', async ({ api }) => {
    const { A, B, aMember, bMember, group, amount } = await yashOwesPriya(api);
    const path = `/groups/${group.id}/upi-claims`;
    const noId = await refused(A.post(path, { fromMemberId: aMember.id, toMemberId: bMember.id, amount }));
    expect(noId.status).toBe(409);
    expect(noId.message).toBe('Priya hasn’t added a UPI ID.');
    await B.setUpiId('priya@okhdfcbank');
    const notPayer = await refused(B.post(path, { fromMemberId: aMember.id, toMemberId: bMember.id, amount }));
    expect(notPayer.message).toBe('Only Yash can pay this.');
    const tooMuch = await refused(A.post(path, { fromMemberId: aMember.id, toMemberId: bMember.id, amount: amount + 1 }));
    expect(tooMuch.message).toBe('That’s more than is owed. Refresh and try again.');

    const first = await A.post<{ id: string; status: string }>(path, { fromMemberId: aMember.id, toMemberId: bMember.id, amount, reference: ' 1234 5678 9012 ' });
    expect(first).toMatchObject({ status: 'pending', amount, reference: '1234 5678 9012', groupId: group.id });
    const second = await A.post<{ id: string }>(path, { fromMemberId: aMember.id, toMemberId: bMember.id, amount: 4000 });
    expect(second.id).not.toBe(first.id);
    expect((await A.upiClaims(group.id)).map((c) => c.id)).toEqual([second.id]);
    expect((await B.upiClaims(group.id)).map((c) => c.id)).toEqual([second.id]);
    // Nothing moved.
    expect((await A.debts(group.id)).map((d) => d.amount)).toEqual([amount]);

    const notPayee = await refused(A.post(`/upi-claims/${second.id}/confirm`));
    expect(notPayee.status).toBe(400);
    expect(notPayee.message).toBe('Only Priya can confirm this.');
    const notPayeeDecline = await refused(A.post(`/upi-claims/${second.id}/decline`));
    expect(notPayeeDecline.message).toBe('Only Priya can say whether this arrived.');
    const notPayerWithdraw = await refused(B.del(`/upi-claims/${second.id}`));
    expect(notPayerWithdraw.message).toBe('Only Yash can take this back.');

    const declined = await B.post<{ status: string }>(`/upi-claims/${second.id}/decline`);
    expect(declined.status).toBe('declined');
    // Turned up after all: a declined claim can still be confirmed.
    const settled = await B.post<Settlement>(`/upi-claims/${second.id}/confirm`);
    expect(settled).toMatchObject({ rail: 'upi', status: 'manually_confirmed', amount: 4000, note: 'Paid by UPI', recordedByMemberId: bMember.id });
    expect(settled.upi).toBeUndefined();
    expect(await A.upiClaims(group.id)).toEqual([]);
    expect((await A.debts(group.id)).map((d) => d.amount)).toEqual([amount - 4000]);
    const gone = await refused(B.post(`/upi-claims/${second.id}/confirm`));
    expect(gone.status).toBe(404);
    expect(gone.message).toBe('That UPI payment isn’t waiting any more.');

    const withRef = await A.post<{ id: string }>(path, { fromMemberId: aMember.id, toMemberId: bMember.id, amount: 1000, reference: '987654321098' });
    const settledRef = await B.post<Settlement>(`/upi-claims/${withRef.id}/confirm`);
    expect(settledRef.note).toBe('Paid by UPI, ref 987654321098');
    const mine = await A.post<{ id: string }>(path, { fromMemberId: aMember.id, toMemberId: bMember.id, amount: 1000 });
    await A.del(`/upi-claims/${mine.id}`);
    expect(await A.upiClaims(group.id)).toEqual([]);
  });

  test('confirming a claim waits for an invoice to lapse, and fails once less is owed', async ({ api }) => {
    const { A, B, aMember, bMember, group, amount } = await yashOwesPriya(api);
    await B.setUpiId('priya@okhdfcbank');
    const claim = await A.post<{ id: string }>(`/groups/${group.id}/upi-claims`, { fromMemberId: aMember.id, toMemberId: bMember.id, amount });
    const s = await A.post<Settlement>(`/groups/${group.id}/settlements`, { fromMemberId: aMember.id, toMemberId: bMember.id, amount: 1000, rail: 'invoice' });
    const underWay = await refused(B.post(`/upi-claims/${claim.id}/confirm`));
    expect(underWay.status).toBe(409);
    expect(underWay.message).toBe('A Lightning payment for this is under way. Wait for it to finish or its invoice to expire, then try again.');
    const claimUnderWay = await refused(A.post(`/groups/${group.id}/upi-claims`, { fromMemberId: aMember.id, toMemberId: bMember.id, amount: 500 }));
    expect(claimUnderWay.message).toBe('A payment for this is already in progress. Wait for it to finish.');
    await untilStatus(A, s.id, 'confirmed');
    // ₹10 of it went over Lightning, so the claim for all of it is now for more than is owed.
    const tooMuch = await refused(B.post(`/upi-claims/${claim.id}/confirm`));
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.message).toBe('That’s more than is owed. Refresh and try again.');
  });

  test('a payment the payer’s side says went through settles the debt on their word, with what they gave', async ({ api }) => {
    const { A, B, aMember, bMember, group, amount } = await yashOwesPriya(api);
    await B.setUpiId('priya@okhdfcbank');
    const path = `/groups/${group.id}/upi-payments`;
    const badRef = await refused(A.post(path, { fromMemberId: aMember.id, toMemberId: bMember.id, amount, byPayer: true, reference: 'nonsense' }));
    expect(badRef.status).toBe(400);
    expect(badRef.message).toBe('That doesn’t look like a UPI reference. It’s the number your UPI app shows for the payment, usually 12 digits.');
    const pending = await A.post<{ id: string }>(`/groups/${group.id}/upi-claims`, { fromMemberId: aMember.id, toMemberId: bMember.id, amount });

    const said = await A.post<Settlement>(path, {
      fromMemberId: aMember.id,
      toMemberId: bMember.id,
      amount: 3000,
      reference: ' 1234-5678 9012 ',
      paidWith: `  ${'x'.repeat(70)}  `,
    });
    expect(said).toMatchObject({
      rail: 'upi',
      status: 'manually_confirmed',
      amount: 3000,
      note: 'Paid by UPI',
      recordedByMemberId: aMember.id,
      upi: { byPayer: true, reference: '123456789012', paidWith: 'x'.repeat(64) },
    });
    // The claim that was waiting is gone: this is the later word on the debt.
    expect((await A.upiClaims(group.id)).map((c) => c.id)).not.toContain(pending.id);
    expect((await A.debts(group.id)).map((d) => d.amount)).toEqual([amount - 3000]);

    // An id the app left out is left out, never sent empty: empty is refused by shape.
    const emptyId = await refused(A.post(path, { fromMemberId: aMember.id, toMemberId: bMember.id, amount: 2000, txnId: 'T123', approvalRef: '' }));
    expect(emptyId.status).toBe(400);
    expect(emptyId.message).toMatch(/^approvalRef: /);
    // The app's name is only metadata: blank is none, and never refuses the report.
    const fromApp = await A.post<Settlement>(path, { fromMemberId: aMember.id, toMemberId: bMember.id, amount: 2000, txnId: 'T123', paidWith: '   ' });
    expect(fromApp.upi).toEqual({ txnId: 'T123' });
    expect(fromApp.note).toBe('Paid by UPI');
    const byPayerBare = await A.post<Settlement>(path, { fromMemberId: aMember.id, toMemberId: bMember.id, amount: 1000, byPayer: true });
    expect(byPayerBare.upi).toEqual({ byPayer: true });
    const noId = await refused(A.post(path, { fromMemberId: bMember.id, toMemberId: aMember.id, amount: 1 }));
    expect(noId.message).toBe('Nothing is owed here any more.');
    const notPayer = await refused(B.post(path, { fromMemberId: aMember.id, toMemberId: bMember.id, amount: 1000 }));
    expect(notPayer.message).toBe('Only Yash can pay this.');
    const history = await A.history(group.id);
    expect(history.filter((h) => h.kind === 'settled').map((h) => h.byMemberId)).toEqual([aMember.id, aMember.id, aMember.id]);
  });

  test('whether shared links may show the ID: for all groups, or for one', async ({ api }) => {
    const { A, B, group } = await pair(api);
    expect(await B.get(`/me/upi/group-links/${group.id}`)).toEqual({ on: true, choice: null });
    expect(await B.setUpiOnGroupLinks(false)).toEqual({ upiId: null, onGroupLinks: false });
    expect(await B.get(`/me/upi/group-links/${group.id}`)).toEqual({ on: false, choice: null });
    expect(await B.put(`/me/upi/group-links/${group.id}`, { on: true })).toEqual({ on: true, choice: true });
    expect(await B.setUpiOnGroupLinks(true)).toEqual({ upiId: null, onGroupLinks: true });
    expect(await B.put(`/me/upi/group-links/${group.id}`, { on: false })).toEqual({ on: false, choice: false });
    expect(await B.put(`/me/upi/group-links/${group.id}`, { on: null })).toEqual({ on: true, choice: null });
    const shape = await refused(B.put(`/me/upi/group-links/${group.id}`, { on: 'yes' }));
    expect(shape.status).toBe(400);
    const notMine = await refused(api.as((await api.account('Stranger')).token).get(`/me/upi/group-links/${group.id}`));
    expect(notMine.status).toBe(404);
    expect(A.token).toBeTruthy();
  });
});

test.describe('Wallet', () => {
  test('a wallet connection string has to be one', async ({ api }) => {
    const me = api.as((await api.account('Yash')).token);
    expect(await me.get('/me/wallet')).toEqual({ connected: false, methods: [], excessMethods: [] });
    const notNwc = await refused(me.put('/me/wallet', { nwcUri: 'http://example.com' }));
    expect(notNwc.status).toBe(400);
    expect(notNwc.code).toBe('invalid_wallet');
    const noRelay = await refused(me.put('/me/wallet', { nwcUri: `nostr+walletconnect://${'a'.repeat(64)}?secret=${'b'.repeat(64)}` }));
    expect(noRelay.status).toBe(400);
    expect(noRelay.message).toBe('That isn’t a wallet connection string: it names no relay.');
    const badKey = await refused(me.put('/me/wallet', { nwcUri: `nostr+walletconnect://abc?relay=wss://r.example&secret=${'b'.repeat(64)}` }));
    expect(badKey.message).toBe('That isn’t a wallet connection string: the wallet key is missing or malformed.');
    const badSecret = await refused(me.put('/me/wallet', { nwcUri: `nostr+walletconnect://${'a'.repeat(64)}?relay=wss://r.example&secret=xyz` }));
    expect(badSecret.message).toBe('That isn’t a wallet connection string: the secret is missing or malformed.');
    expect(await me.get('/me/wallet')).toEqual({ connected: false, methods: [], excessMethods: [] });
    expect(await me.del('/me/wallet')).toEqual({ connected: false, methods: [], excessMethods: [] });
  });

  test('a wallet that can’t be reached is a network error, and nothing is kept', async ({ api }) => {
    test.setTimeout(45_000);
    const me = api.as((await api.account('Yash')).token);
    const r = await refused(me.put('/me/wallet', { nwcUri: `nostr+walletconnect://${'a'.repeat(64)}?relay=wss://127.0.0.1:1&secret=${'b'.repeat(64)}` }));
    expect([503, 400]).toContain(r.status);
    expect(['network', 'invalid_wallet']).toContain(r.code);
    expect(r.message).not.toContain('b'.repeat(64));
    expect(await me.get('/me/wallet')).toEqual({ connected: false, methods: [], excessMethods: [] });
  });

  test('a receive address: checked for shape, kept, and cleared', async ({ api }) => {
    const me = api.as((await api.account('Yash')).token);
    expect(await me.get('/me/receive-address')).toEqual({ address: null });
    const bad = await refused(me.setReceiveAddress('not an address'));
    expect(bad.status).toBe(400);
    expect(bad.code).toBe('invalid_address');
    const invoice = await refused(me.setReceiveAddress('lnbc1500n1pexample'));
    expect(invoice.message).toMatch(/^That's an invoice/);
    const long = await refused(me.setReceiveAddress(`${'a'.repeat(310)}@example.com`));
    expect(long.status).toBe(400);
    expect(await me.setReceiveAddress(' Yash@WalletOfSatoshi.com ')).toEqual({ address: 'yash@walletofsatoshi.com' });
    expect(await me.get('/me/receive-address')).toEqual({ address: 'yash@walletofsatoshi.com' });
    expect(await me.del('/me/receive-address')).toEqual({ address: null });
  });
});

test.describe('CORS', () => {
  test('the web app’s origin is allowed, with the headers the app sends', async () => {
    const res = await fetch(`${API_URL}/groups`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://127.0.0.1:8900',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type,idempotency-key,x-sattle-device,x-sattle-session',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:8900');
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    for (const h of ['authorization', 'content-type', 'idempotency-key', 'x-sattle-device', 'x-sattle-session']) expect(allowed).toContain(h);
    expect(res.headers.get('access-control-allow-methods')).toContain('DELETE');
    expect(res.headers.get('access-control-max-age')).toBe('600');
  });

  test('another origin gets no allowance', async () => {
    const res = await fetch(`${API_URL}/groups`, {
      method: 'OPTIONS',
      headers: { origin: 'http://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const plain = await fetch(`${API_URL}/health`, { headers: { origin: 'http://evil.example' } });
    expect(plain.headers.get('access-control-allow-origin')).toBeNull();
    const ours = await fetch(`${API_URL}/health`, { headers: { origin: 'http://127.0.0.1:8900' } });
    expect(ours.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:8900');
  });
});

test.describe('Analytics', () => {
  const event = (seq: number, id = `ev-${Date.now()}-${Math.random().toString(36).slice(2)}`) => ({
    id,
    sessionId: 'sess-1',
    seq,
    kind: 'screen',
    name: 'Groups',
    screen: 'Groups',
    at: new Date().toISOString(),
  });

  test('a batch is kept once, as a guest or as an account', async ({ api }) => {
    const batch = { deviceId: `dev-${Math.random().toString(36).slice(2)}`, platform: 'web', appVersion: 'e2e', events: [event(0), event(1)] };
    const first = await api.raw<{ accepted: number }>('POST', '/analytics/events', batch);
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ accepted: 2 });
    const again = await api.raw<{ accepted: number }>('POST', '/analytics/events', batch);
    expect(again.status).toBe(202);
    expect(again.body).toEqual({ accepted: 0 });
    const { token } = await api.account('Yash');
    const mine = await api.raw<{ accepted: number }>('POST', '/analytics/events', { ...batch, events: [event(2)] }, { token });
    expect(mine.body).toEqual({ accepted: 1 });
    // A token the server doesn't know doesn't fail the batch: it's a guest's.
    const unknown = await api.raw<{ accepted: number }>('POST', '/analytics/events', { ...batch, events: [event(3)] }, { token: 'nobody' });
    expect(unknown.status).toBe(202);
  });

  test('a batch past the limits is refused whole', async ({ api }) => {
    const deviceId = `dev-${Math.random().toString(36).slice(2)}`;
    const tooMany = await api.raw<{ code: string }>('POST', '/analytics/events', {
      deviceId,
      platform: 'web',
      events: Array.from({ length: 201 }, (_, i) => event(i)),
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.code).toBe('invalid_input');
    const big = await api.raw<{ code: string; message: string }>('POST', '/analytics/events', {
      deviceId,
      platform: 'web',
      events: [{ ...event(0), props: { pad: 'p'.repeat(70 * 1024) } }],
    });
    expect(big.status).toBe(413);
    expect(big.body).toEqual({ code: 'invalid_input', message: 'That batch is too big.' });
    const empty = await api.raw<{ code: string }>('POST', '/analytics/events', { deviceId, platform: 'web', events: [] });
    expect(empty.status).toBe(400);
    const kind = await api.raw<{ code: string }>('POST', '/analytics/events', { deviceId, platform: 'web', events: [{ ...event(0), kind: 'request' }] });
    expect(kind.status).toBe(400);
    const platform = await api.raw<{ code: string }>('POST', '/analytics/events', { deviceId, platform: 'windows', events: [event(0)] });
    expect(platform.status).toBe(400);
    const bigProps = await api.raw<{ code: string }>('POST', '/analytics/events', { deviceId, platform: 'web', events: [{ ...event(0), props: { pad: 'p'.repeat(5000) } }] });
    expect(bigProps.status).toBe(400);
  });
});
