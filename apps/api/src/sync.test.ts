import { describe, expect, it } from 'vitest';

import type { Expense, Group, GroupLink, JoinRequest, JoinView, Member, SyncAnswer, SyncView, User } from '@sattle/core';

import { createApp } from './app';
import { openDb } from './db';
import { SimulatedPayments } from './payments';

type Synced = Extract<SyncAnswer, SyncView>;

/**
 * A production-shaped server: no fixtures, no demo user. Riya has a group in
 * rupees with two ghosts, Kabir and Aman, and a UPI ID. Om joins as Kabir.
 */
async function setup(opts: { corsOrigin?: string } = {}) {
  const db = openDb(':memory:');
  const app = createApp({
    db,
    corsOrigin: opts.corsOrigin,
    payments: (repo) =>
      new SimulatedPayments(repo, { stepMs: 1, settleDelayMs: 1, rateFiatPerBtc: 9_000_000, alwaysFail: false }),
  });
  async function raw(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) {
    const all: Record<string, string> = { 'content-type': 'application/json', ...headers };
    if (token) all.authorization = `Bearer ${token}`;
    return app.request(path, { method, headers: all, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  async function call<T = unknown>(method: string, path: string, body?: unknown, token?: string) {
    const res = await raw(method, path, body, token);
    return { status: res.status, body: (await res.json()) as T };
  }
  const signUp = async (displayName: string) =>
    (await call<{ user: User; token: string }>('POST', '/accounts', { displayName })).body;
  const sync = async (token: string, query = '') => {
    const res = await raw('GET', `/sync${query}`, undefined, token);
    expect(res.status).toBe(200);
    return (await res.json()) as Synced;
  };

  const riya = await signUp('Riya');
  const group = (await call<Group>('POST', '/groups', { name: 'Manali', memberNames: ['Kabir', 'Aman'] }, riya.token)).body;
  const [riyaMember, kabir, aman] = group.memberIds;
  const base = `/groups/${group.id}`;
  await call('PUT', '/me/upi', { upiId: 'riya@okaxis' }, riya.token);

  const link = (await call<GroupLink>('POST', `${base}/link`, undefined, riya.token)).body;
  const refOf = async (name: string) =>
    (await call<JoinView>('GET', `/join/${link.token}`)).body.members.find((m) => m.name === name)!.ref;
  const om = await signUp('Om');
  await call<Member>('POST', '/join', { token: link.token, ref: await refOf('Kabir') }, om.token);

  const spend = (description: string, amount: number, by = riya.token, paidBy = riyaMember) =>
    call<Expense>(
      'POST',
      `${base}/expenses`,
      { description, amount, paidByMemberId: paidBy, splitMode: 'equal', parts: [riyaMember, kabir, aman].map((memberId) => ({ memberId })) },
      by
    );

  return { db, app, raw, call, sync, signUp, riya, om, group, base, riyaMember, kabir, aman, link, refOf, spend };
}

/** What a route answers, as the text it sent. */
async function text(res: Response) {
  expect(res.status).toBe(200);
  return res.text();
}

describe('GET /sync', () => {
  it('answers each part exactly as its own route does, byte for byte, for everyone in the group', async () => {
    const t = await setup();
    await t.spend('Dinner', 90000);
    await t.spend('Cab', 1200, t.om.token, t.kabir);
    // Aman, a ghost, paid Riya back in cash; Om says he paid Riya by UPI.
    await t.call('POST', `${t.base}/settlements/manual`, { fromMemberId: t.aman, toMemberId: t.riyaMember, amount: 10000, note: 'cash' }, t.riya.token);
    expect(
      (await t.call('POST', `${t.base}/upi-claims`, { fromMemberId: t.kabir, toMemberId: t.riyaMember, amount: 20000 }, t.om.token)).status
    ).toBe(201);
    // Someone asks to be Aman, so there is a join waiting.
    await t.call('PUT', t.base, { approveJoins: true }, t.riya.token);
    const dev = await t.signUp('Dev');
    expect((await t.call('POST', '/join-requests', { token: t.link.token, ref: await t.refOf('Aman') }, dev.token)).status).toBe(201);

    for (const who of [t.riya, t.om, dev]) {
      const answer = await t.sync(who.token);
      const get = (path: string) => t.raw('GET', path, undefined, who.token).then(text);
      const { version, ...view } = answer;
      expect(version).toMatch(/^[\w-]+$/);
      expect(JSON.stringify(view.user)).toBe(await get('/me'));
      expect(JSON.stringify(view.upiProfile)).toBe(await get('/me/upi'));
      expect(JSON.stringify(view.joinRequests)).toBe(await get('/me/join-requests'));
      expect(JSON.stringify(view.groups.map((g) => g.group))).toBe(await get('/groups'));
      for (const g of view.groups) {
        const at = `/groups/${g.group.id}`;
        expect(JSON.stringify(g.group)).toBe(await get(at));
        expect(JSON.stringify(g.members)).toBe(await get(`${at}/members`));
        expect(JSON.stringify(g.expenses)).toBe(await get(`${at}/expenses`));
        expect(JSON.stringify(g.settlements)).toBe(await get(`${at}/settlements`));
        expect(JSON.stringify(g.upiClaims)).toBe(await get(`${at}/upi-claims`));
        expect(JSON.stringify(g.pendingJoins)).toBe(await get(`${at}/join-requests`));
        expect(JSON.stringify(g.log)).toBe(await get(`${at}/log`));
      }
    }

    // What there was to see, so the comparisons above weren't of empty lists.
    const riyas = await t.sync(t.riya.token);
    const manali = riyas.groups[0]!;
    expect(manali.expenses.map((e) => e.description)).toEqual(['Dinner', 'Cab']);
    expect(manali.settlements).toHaveLength(1);
    expect(manali.upiClaims).toHaveLength(1);
    expect(manali.pendingJoins.map((p) => p.name)).toEqual(['Aman']);
    expect(manali.members.find((m) => m.id === t.riyaMember)?.upi).toBe(true);
    expect((await t.sync(dev.token)).joinRequests.map((r) => r.groupName)).toEqual(['Manali']);
  });

  it('answers 304, with nothing in it, when asked with the version it would answer', async () => {
    const t = await setup();
    const first = await t.sync(t.riya.token);
    const asked = (tag: string) => t.raw('GET', '/sync', undefined, t.riya.token, { 'if-none-match': tag });

    for (const tag of [`W/"${first.version}"`, `"${first.version}"`, `"other", W/"${first.version}"`, '*']) {
      const res = await asked(tag);
      expect(res.status).toBe(304);
      expect(await res.text()).toBe('');
      expect(res.headers.get('etag')).toBe(`W/"${first.version}"`);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
    }

    // Anything that changes what it says is a new version, in full.
    await t.spend('Snacks', 300);
    const res = await asked(`W/"${first.version}"`);
    expect(res.status).toBe(200);
    const next = (await res.json()) as Synced;
    expect(next.version).not.toBe(first.version);
    expect(res.headers.get('etag')).toBe(`W/"${next.version}"`);
    expect(next.groups[0]!.expenses.map((e) => e.description)).toEqual(['Snacks']);
  });

  it('answers the same version for the same view, so a phone polling it is told nothing changed', async () => {
    const t = await setup();
    const a = await t.sync(t.om.token);
    const b = await t.sync(t.om.token);
    expect(b.version).toBe(a.version);
    // Someone else's change in the group is a change for Om too.
    await t.spend('Fuel', 2400);
    expect((await t.sync(t.om.token)).version).not.toBe(a.version);
  });

  it('answers for the groups asked for alone, and leaves out a group the user isn’t in instead of refusing', async () => {
    const t = await setup();
    const other = (await t.call<Group>('POST', '/groups', { name: 'Goa', memberNames: ['Priya'] }, t.riya.token)).body;
    const stranger = await t.signUp('Sam');
    const theirs = (await t.call<Group>('POST', '/groups', { name: 'Not yours', memberNames: [] }, stranger.token)).body;

    const all = await t.sync(t.riya.token);
    expect(all.groups.map((g) => g.group.name)).toEqual(['Goa', 'Manali']);

    const one = await t.sync(t.riya.token, `?group=${t.group.id}`);
    expect(one.groups.map((g) => g.group.id)).toEqual([t.group.id]);
    // The same group answers the same, asked alone or with the rest.
    expect(JSON.stringify(one.groups[0])).toBe(JSON.stringify(all.groups.find((g) => g.group.id === t.group.id)));
    expect(one.user).toEqual(all.user);
    expect(one.version).not.toBe(all.version);

    // However they're asked for, the same groups are the same answer.
    const both = await t.sync(t.riya.token, `?group=${other.id}&group=${t.group.id}&group=${other.id}`);
    const again = await t.sync(t.riya.token, `?group=${t.group.id}&group=${other.id}`);
    expect(both.groups.map((g) => g.group.id)).toEqual([other.id, t.group.id].sort());
    expect(again.version).toBe(both.version);

    // Not hers, or not there at all: just not in the answer, never a 404.
    for (const id of [theirs.id, 'g-nope']) {
      expect((await t.sync(t.riya.token, `?group=${id}`)).groups).toEqual([]);
    }
  });

  it('doesn’t have a group in it for someone who left it, nor once it’s deleted', async () => {
    const t = await setup();
    expect((await t.sync(t.om.token)).groups).toHaveLength(1);
    expect((await t.call('POST', `${t.base}/leave`, undefined, t.om.token)).status).toBe(200);
    expect((await t.sync(t.om.token)).groups).toEqual([]);
    expect((await t.sync(t.om.token, `?group=${t.group.id}`)).groups).toEqual([]);

    expect((await t.call('DELETE', t.base, undefined, t.riya.token)).status).toBe(200);
    expect((await t.sync(t.riya.token)).groups).toEqual([]);
  });

  it('has a request to join until the person is let in, and then has the group instead', async () => {
    const t = await setup();
    await t.call('PUT', t.base, { approveJoins: true }, t.riya.token);
    const dev = await t.signUp('Dev');
    const asked = (await t.call<JoinRequest>('POST', '/join-requests', { token: t.link.token, ref: await t.refOf('Aman') }, dev.token)).body;

    const waiting = await t.sync(dev.token);
    expect(waiting.groups).toEqual([]);
    expect(waiting.joinRequests.map((r) => [r.groupName, r.name, r.status])).toEqual([['Manali', 'Aman', 'pending']]);
    expect((await t.sync(t.riya.token)).groups[0]!.pendingJoins.map((p) => p.id)).toEqual([asked.id]);

    expect((await t.call('POST', `/join-requests/${asked.id}/approve`, undefined, t.riya.token)).status).toBe(200);
    const inside = await t.sync(dev.token);
    expect(inside.joinRequests).toEqual([]);
    expect(inside.groups.map((g) => g.group.name)).toEqual(['Manali']);
    expect((await t.sync(t.riya.token)).groups[0]!.pendingJoins).toEqual([]);
  });

  it('is refused without a token', async () => {
    const t = await setup();
    const res = await t.raw('GET', '/sync');
    expect(res.status).toBe(401);
  });

  it('lets a browser on another origin ask with its version and read the answer’s', async () => {
    const t = await setup({ corsOrigin: 'https://sattle.example' });
    const origin = { origin: 'https://sattle.example' };
    const preflight = await t.app.request('/sync', {
      method: 'OPTIONS',
      headers: { ...origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization,if-none-match' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('if-none-match');

    const first = await t.raw('GET', '/sync', undefined, t.riya.token, origin);
    expect(first.headers.get('access-control-expose-headers')).toContain('etag');
    const { version } = (await first.json()) as Synced;
    // A 304 still says who may read it, or the browser would take it for a network error.
    const again = await t.raw('GET', '/sync', undefined, t.riya.token, { ...origin, 'if-none-match': `W/"${version}"` });
    expect(again.status).toBe(304);
    expect(again.headers.get('access-control-allow-origin')).toBe('https://sattle.example');
  });
});
