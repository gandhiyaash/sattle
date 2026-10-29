import { describe, expect, it } from 'vitest';

import type {
  Expense, Group, GroupGuestView, GroupLink, GuestView, JoinView, JoinRequest, Member, PendingJoin, User,
} from '@sattle/core';

import { createApp } from './app';
import { openDb } from './db';
import { SimulatedPayments } from './payments';
import { MAX_PENDING_JOINS } from './routes/joining';

/**
 * A production-shaped server: no fixtures, no demo user. Riya has a group with two ghosts.
 * `link` makes the group's link, which is what people ask to join with.
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
  const group = (await call<Group>('POST', '/groups', { name: 'Manali', memberNames: ['Kabir', 'Aman'] }, riya.token)).body;
  const [, kabir, aman] = group.memberIds;
  const base = `/groups/${group.id}`;

  const link = (as = riya.token) => call<GroupLink>('POST', `${base}/link`, undefined, as);
  const page = (token: string) => call<JoinView>('GET', `/join/${token}`);
  /** What the page would send back for the person with that name. */
  const refOf = async (token: string, name: string) => (await page(token)).body.members.find((m) => m.name === name)!.ref;
  /** Asks to join as the person with that ref. Nothing changes in the group until someone lets them in. */
  const ask = (token: string, ref: string, as: string, headers?: Record<string, string>) =>
    call<JoinRequest>('POST', '/join-requests', { token, ref }, as, headers);
  const askAsNew = (token: string, displayName: string, as: string) =>
    call<JoinRequest>('POST', '/join-requests', { token, displayName }, as);
  const approve = (id: string, by = riya.token, headers?: Record<string, string>) =>
    call<Member>('POST', `/join-requests/${id}/approve`, undefined, by, headers);
  /** Joins at once, with nobody to say yes: what the link does unless the group has turned approving on. */
  const joinNow = (token: string, as: { ref: string } | { displayName: string }, by: string, headers?: Record<string, string>) =>
    call<Member>('POST', '/join', { token, ...as }, by, headers);
  const approveJoins = (on: boolean, by = riya.token) => call<Group>('PUT', base, { approveJoins: on }, by);
  const decline = (id: string, by = riya.token) => call('POST', `/join-requests/${id}/decline`, undefined, by);
  const waiting = async (as = riya.token) => (await call<PendingJoin[]>('GET', `${base}/join-requests`, undefined, as)).body;
  const mine = async (as: string) => (await call<JoinRequest[]>('GET', '/me/join-requests', undefined, as)).body;
  /** Asks, then Riya lets them in. Answers with the approval, or the request if asking failed. */
  const join = async (token: string, ref: string, as: string) => {
    const asked = await ask(token, ref, as);
    return asked.status === 201 ? approve(asked.body.id) : asked;
  };
  const joinAs = async (name: string, token: string, as: string) => join(token, await refOf(token, name), as);
  const joinAsNew = async (token: string, displayName: string, as: string) => {
    const asked = await askAsNew(token, displayName, as);
    return asked.status === 201 ? approve(asked.body.id) : asked;
  };
  const members = async (as = riya.token) => (await call<Member[]>('GET', `${base}/members`, undefined, as)).body;

  return {
    db, call, signUp, riya, group, base, kabir, aman, link, page, refOf,
    ask, askAsNew, approve, decline, waiting, mine, join, joinAs, joinAsNew, members, joinNow, approveJoins,
  };
}

describe('the group link, for joining', () => {
  it('stops being a way in once it is replaced, so a link sent to the wrong place can be taken back', async () => {
    const { signUp, link, page, join, joinAs, members, kabir } = await setup();
    const first = (await link()).body.token;
    const ref = (await page(first)).body.members[0].ref;
    const second = (await link()).body.token;
    const k = await signUp('Kabir');

    expect((await page(first)).status).toBe(404);
    expect((await join(first, ref, k.token)).status).toBe(404);
    expect((await members()).find((m) => m.id === kabir)?.status).toBe('ghost');
    expect((await joinAs('Kabir', second, k.token)).status).toBe(200);
  });

  it('stops being a way in once it is turned off, and anyone in the group can do that', async () => {
    const { call, base, signUp, link, page, joinAs, refOf, join } = await setup();
    const { token } = (await link()).body;
    const k = await signUp('Kabir');
    await joinAs('Kabir', token, k.token);
    const amanRef = await refOf(token, 'Aman');

    expect((await call('DELETE', `${base}/link`, undefined, k.token)).status).toBe(200);
    expect((await page(token)).status).toBe(404);
    expect((await join(token, amanRef, (await signUp('Aman')).token)).status).toBe(404);
  });

  it('doesn’t run out by itself', async () => {
    const { db, signUp, link, page, joinAs } = await setup();
    const { token } = (await link()).body;
    db.prepare('UPDATE group_links SET created_at = ?').run('2020-01-01T00:00:00.000Z');
    expect((await page(token)).status).toBe(200);
    expect((await joinAs('Kabir', token, (await signUp('Kabir')).token)).status).toBe(200);
  });
});

describe('GET /join/:token', () => {
  it('shows names to anyone holding the link, and nothing else', async () => {
    const { link, page } = await setup();
    const { token } = (await link()).body;
    const res = await page(token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      groupName: 'Manali',
      approveJoins: false,
      members: [
        { ref: expect.any(String), name: 'Riya', joined: true },
        { ref: expect.any(String), name: 'Kabir' },
        { ref: expect.any(String), name: 'Aman' },
      ],
    });
  });

  it('offers everyone, joined or not, by a ref that isn’t their id', async () => {
    const { signUp, link, page, joinAs, group } = await setup();
    const { token } = (await link()).body;
    const refs = (await page(token)).body.members.map((m) => m.ref);
    expect(new Set(refs).size).toBe(3);
    for (const ref of refs) expect(group.memberIds).not.toContain(ref);

    await joinAs('Kabir', token, (await signUp('Kabir')).token);
    const after = (await page(token)).body.members;
    expect(after.map((m) => m.ref)).toEqual(refs);
    expect(after.map((m) => [m.name, Boolean(m.joined)])).toEqual([['Riya', true], ['Kabir', true], ['Aman', false]]);
  });

  it('says who has joined, and asking isn’t joining', async () => {
    const { signUp, link, page, refOf, ask, joinAs, joinAsNew } = await setup();
    const { token } = (await link()).body;
    await joinAs('Kabir', token, (await signUp('Kabir')).token);
    await joinAsNew(token, 'Dev', (await signUp('Dev')).token);
    await ask(token, await refOf(token, 'Aman'), (await signUp('Aman')).token);

    const { body } = await page(token);
    expect(body.members.map((m) => [m.name, Boolean(m.joined)])).toEqual([
      ['Riya', true],
      ['Kabir', true],
      ['Aman', false],
      ['Dev', true],
    ]);
  });

  it('gives the same person a different ref on a new link', async () => {
    const { link, refOf } = await setup();
    const old = await refOf((await link()).body.token, 'Kabir');
    expect(await refOf((await link()).body.token, 'Kabir')).not.toBe(old);
  });

  it('is 404 for a token nobody made', async () => {
    const { call } = await setup();
    expect((await call('GET', '/join/nope')).status).toBe(404);
  });
});

describe('GET /links/:token/group', () => {
  it('is the group for someone already in it, and null for someone who isn’t, or who has only asked', async () => {
    const { call, signUp, link, refOf, ask, approve, group, riya } = await setup();
    const { token } = (await link()).body;
    const path = `/links/${token}/group`;

    expect((await call<Group>('GET', path, undefined, riya.token)).body).toMatchObject({ id: group.id, name: 'Manali' });

    const k = await signUp('Kabir');
    expect(await call('GET', path, undefined, k.token)).toEqual({ status: 200, body: null });
    const asked = await ask(token, await refOf(token, 'Kabir'), k.token);
    expect(await call('GET', path, undefined, k.token)).toEqual({ status: 200, body: null });
    await approve(asked.body.id);
    expect((await call<Group>('GET', path, undefined, k.token)).body.id).toBe(group.id);
  });

  it('needs an account, and a link that still works', async () => {
    const { call, base, link, riya } = await setup();
    const { token } = (await link()).body;
    expect((await call('GET', `/links/${token}/group`)).status).toBe(401);
    expect((await call('GET', '/links/nope/group', undefined, riya.token)).status).toBe(404);

    await call('DELETE', `${base}/link`, undefined, riya.token);
    expect((await call('GET', `/links/${token}/group`, undefined, riya.token)).status).toBe(404);
  });
});

describe('POST /join', () => {
  it('makes whoever holds the link the person they picked, at once, with nobody to say yes', async () => {
    const { call, signUp, link, refOf, joinNow, members, mine, waiting, group, base, kabir, aman } = await setup();
    const { token } = (await link()).body;
    const k = await signUp('Kabir S');

    const joined = await joinNow(token, { ref: await refOf(token, 'Kabir') }, k.token);
    expect(joined.status).toBe(201);
    expect(joined.body).toMatchObject({ id: kabir, displayName: 'Kabir', status: 'joined', claimedByUserId: k.user.id });

    // Same row, same name: only who holds it changed. Nobody else's did, and nobody is waiting.
    const ms = await members();
    expect(ms.find((m) => m.id === kabir)).toMatchObject({ status: 'joined', claimedByUserId: k.user.id });
    expect(ms.find((m) => m.id === aman)?.status).toBe('ghost');
    expect((await call<Group[]>('GET', '/groups', undefined, k.token)).body.map((g) => g.id)).toEqual([group.id]);
    expect(await waiting()).toEqual([]);
    expect(await mine(k.token)).toEqual([]);
    expect((await call('GET', base, undefined, k.token)).status).toBe(200);
  });

  it('adds someone who gave their own name as a new member, after everyone else', async () => {
    const { signUp, link, joinNow, members, group } = await setup();
    const { token } = (await link()).body;
    const n = await signUp('Nisha');

    const joined = await joinNow(token, { displayName: 'Nisha' }, n.token);
    expect(joined.status).toBe(201);
    expect(joined.body).toMatchObject({ displayName: 'Nisha', status: 'joined', claimedByUserId: n.user.id });
    expect((await members()).map((m) => m.id)).toEqual([...group.memberIds, joined.body.id]);
  });

  it('is refused once the group has turned approving on, and then asking is the way in', async () => {
    const { signUp, link, page, refOf, joinNow, ask, approve, approveJoins, members, kabir } = await setup();
    const { token } = (await link()).body;
    const k = await signUp('Kabir S');
    expect((await approveJoins(true)).body.approveJoins).toBe(true);
    expect((await page(token)).body.approveJoins).toBe(true);

    const refused = await joinNow(token, { ref: await refOf(token, 'Kabir') }, k.token);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ message: 'Someone in Manali has to let you in. Ask to join instead.' });
    expect((await members()).find((m) => m.id === kabir)?.status).toBe('ghost');

    const asked = await ask(token, await refOf(token, 'Kabir'), k.token);
    expect(asked.status).toBe(201);
    expect((await approve(asked.body.id)).status).toBe(200);

    // And off again: the next person is in at once.
    expect((await approveJoins(false, k.token)).body.approveJoins).toBe(false);
    const a = await signUp('Aman');
    expect((await joinNow(token, { ref: await refOf(token, 'Aman') }, a.token)).status).toBe(201);
  });

  it('joins as someone who has joined, as another device of theirs, with nobody to say yes', async () => {
    const { call, signUp, link, refOf, joinAs, joinNow, members, group, kabir } = await setup();
    const { token } = (await link()).body;
    const k = await signUp('Kabir');
    await joinAs('Kabir', token, k.token);
    const laptop = await signUp('Kabir laptop');

    const joined = await joinNow(token, { ref: await refOf(token, 'Kabir') }, laptop.token);
    expect(joined.status).toBe(201);
    expect(joined.body).toMatchObject({ id: kabir, displayName: 'Kabir', claimedByUserId: k.user.id, alsoHeldBy: [laptop.user.id] });
    // Still one Kabir, on two devices, and both have the group.
    expect((await members()).filter((m) => m.displayName === 'Kabir')).toHaveLength(1);
    for (const who of [k, laptop]) {
      expect((await call<Group[]>('GET', '/groups', undefined, who.token)).body.map((g) => g.id)).toEqual([group.id]);
    }
  });

  it('drops the request the person had waiting, and leaves anyone else asking to be them waiting', async () => {
    const { signUp, link, refOf, ask, joinNow, approve, waiting, mine, members, kabir } = await setup();
    const { token } = (await link()).body;
    const k = await signUp('Kabir S');
    const other = await signUp('Someone');
    await ask(token, await refOf(token, 'Kabir'), k.token);
    const otherAsked = await ask(token, await refOf(token, 'Kabir'), other.token);
    expect(await waiting()).toHaveLength(2);

    expect((await joinNow(token, { ref: await refOf(token, 'Kabir') }, k.token)).status).toBe(201);
    expect((await waiting()).map((w) => w.id)).toEqual([otherAsked.body.id]);
    expect(await mine(k.token)).toEqual([]);
    expect(await mine(other.token)).toEqual([otherAsked.body]);
    // Whoever lets them in makes them Kabir too.
    expect((await approve(otherAsked.body.id)).status).toBe(200);
    expect((await members()).find((m) => m.id === kabir)).toMatchObject({ claimedByUserId: k.user.id, alsoHeldBy: [other.user.id] });
  });

  it('won’t give one account two members of the same group, and lets a second account be the same person', async () => {
    const { signUp, link, refOf, joinNow, members, aman } = await setup();
    const { token } = (await link()).body;
    const k = await signUp('Kabir S');
    expect((await joinNow(token, { ref: await refOf(token, 'Kabir') }, k.token)).status).toBe(201);
    expect((await joinNow(token, { displayName: 'Kabir S' }, k.token)).status).toBe(409);
    const twice = await joinNow(token, { ref: await refOf(token, 'Aman') }, k.token);
    expect(twice.status).toBe(409);
    expect(twice.body).toMatchObject({ message: 'You’re already in this group.' });

    const amanRef = await refOf(token, 'Aman');
    const a = await signUp('Aman');
    const also = await signUp('Also Aman');
    expect((await joinNow(token, { ref: amanRef }, a.token)).status).toBe(201);
    expect((await joinNow(token, { ref: amanRef }, also.token)).status).toBe(201);
    expect((await members()).filter((m) => m.id === aman)).toEqual([
      expect.objectContaining({ claimedByUserId: a.user.id, alsoHeldBy: [also.user.id] }),
    ]);
  });

  it('won’t start a second person under the name of someone who has joined, since nobody is there to see it', async () => {
    const { signUp, link, joinNow, askAsNew, members } = await setup();
    const { token } = (await link()).body;

    const refused = await joinNow(token, { displayName: ' riya ' }, (await signUp('Not Riya')).token);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      message: 'Riya has already joined. If that’s you, pick Riya on the list. Otherwise give a name that tells you apart.',
    });
    expect((await members()).filter((m) => m.displayName === 'Riya')).toHaveLength(1);
    // Asking still can: whoever lets them in sees who it is.
    expect((await askAsNew(token, 'Riya', (await signUp('Riya K')).token)).status).toBe(201);
  });

  it('tells someone already in an approving group that they’re in, not to ask', async () => {
    const { link, joinNow, approveJoins, riya } = await setup();
    const { token } = (await link()).body;
    await approveJoins(true);
    const again = await joinNow(token, { displayName: 'Riya again' }, riya.token);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ message: 'You’re already in this group.' });
  });

  it('is 404 for a ref nobody in the group has, and for a dead link; 409 for a name still waiting to be picked', async () => {
    const { signUp, link, joinNow } = await setup();
    const { token } = (await link()).body;
    const k = await signUp('Kabir S');
    expect((await joinNow(token, { ref: 'nope' }, k.token)).status).toBe(404);
    expect((await joinNow('nope', { displayName: 'Kabir S' }, k.token)).status).toBe(404);
    expect((await joinNow(token, { displayName: 'kabir' }, k.token)).status).toBe(409);
  });

  it('answers a retry of the same join with the same member', async () => {
    const { signUp, link, refOf, joinNow, members, kabir } = await setup();
    const { token } = (await link()).body;
    const k = await signUp('Kabir S');
    const as = { ref: await refOf(token, 'Kabir') };
    const headers = { 'idempotency-key': 'join-once' };
    const first = await joinNow(token, as, k.token, headers);
    const again = await joinNow(token, as, k.token, headers);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect((await members()).filter((m) => m.id === kabir)).toHaveLength(1);
  });
});

describe('PUT /groups/:id with approveJoins', () => {
  it('is off for a new group, and anyone in the group can turn it on or off, nobody outside it', async () => {
    const { call, signUp, link, joinAs, approveJoins, group, base, riya } = await setup();
    expect(group.approveJoins).toBe(false);
    expect((await call<Group>('GET', base, undefined, riya.token)).body.approveJoins).toBe(false);

    const { token } = (await link()).body;
    const k = await signUp('Kabir S');
    await joinAs('Kabir', token, k.token);
    expect((await approveJoins(true, k.token)).body.approveJoins).toBe(true);
    expect((await call<Group>('GET', base, undefined, riya.token)).body.approveJoins).toBe(true);
    expect((await approveJoins(false, (await signUp('Outsider')).token)).status).toBe(404);
    expect((await call<Group>('GET', base, undefined, riya.token)).body.approveJoins).toBe(true);
    expect((await approveJoins(false)).body.approveJoins).toBe(false);
  });

  it('needs a yes or no, and leaves the name and debts as they were', async () => {
    const { call, base, riya, approveJoins } = await setup();
    expect((await call('PUT', base, { approveJoins: 'yes' }, riya.token)).status).toBe(400);
    expect((await approveJoins(true)).body).toMatchObject({ name: 'Manali', simplifyDebts: true, approveJoins: true });
  });
});

describe('POST /join-requests', () => {
  it('asks to be the person picked, and changes nothing in the group until someone says yes', async () => {
    const { call, signUp, link, refOf, ask, waiting, mine, members, base, kabir } = await setup();
    const { token } = (await link()).body;
    const k = await signUp('Kabir S');

    const asked = await ask(token, await refOf(token, 'Kabir'), k.token);
    expect(asked.status).toBe(201);
    expect(asked.body).toEqual({
      id: expect.any(String),
      groupName: 'Manali',
      name: 'Kabir',
      code: expect.stringMatching(/^\d{4}$/),
      status: 'pending',
      createdAt: expect.any(String),
    });
    // Names only, as on the join page.
    expect(JSON.stringify(asked.body)).not.toContain(kabir);

    expect((await call('GET', base, undefined, k.token)).status).toBe(404);
    expect((await call<Group[]>('GET', '/groups', undefined, k.token)).body).toEqual([]);
    expect((await members()).find((m) => m.id === kabir)).toMatchObject({ status: 'ghost' });
    expect((await members()).find((m) => m.id === kabir)?.claimedByUserId).toBeUndefined();

    // Everyone in the group sees who is waiting, with the same code.
    expect(await waiting()).toEqual([
      { id: asked.body.id, name: 'Kabir', existing: true, code: asked.body.code, createdAt: expect.any(String) },
    ]);
    expect(await mine(k.token)).toEqual([asked.body]);
  });

  it('needs an account', async () => {
    const { call, link, refOf, waiting } = await setup();
    const { token } = (await link()).body;
    const ref = await refOf(token, 'Kabir');
    expect((await call('POST', '/join-requests', { token, ref })).status).toBe(401);
    expect(await waiting()).toEqual([]);
  });

  it('needs to be told who the person is', async () => {
    const { call, signUp, link, waiting } = await setup();
    const { token } = (await link()).body;
    expect((await call('POST', '/join-requests', { token }, (await signUp('Kabir')).token)).status).toBe(400);
    expect(await waiting()).toEqual([]);
  });

  it('is 404 for a ref nobody in the group has, and for one from another link', async () => {
    const { call, signUp, link, refOf, ask, waiting, riya } = await setup();
    const other = (await call<Group>('POST', '/groups', { name: 'Flat', memberNames: ['Dev'] }, riya.token)).body;
    const theirs = (await call<GroupLink>('POST', `/groups/${other.id}/link`, undefined, riya.token)).body.token;
    const dev = await refOf(theirs, 'Dev');
    const { token } = (await link()).body;
    const k = await signUp('Kabir');

    expect((await ask(token, 'nope', k.token)).status).toBe(404);
    expect((await ask(token, dev, k.token)).status).toBe(404);
    expect(await waiting()).toEqual([]);
  });

  it('won’t give one person two members of the same group', async () => {
    const { link, refOf, ask, riya } = await setup();
    const { token } = (await link()).body;
    const res = await ask(token, await refOf(token, 'Kabir'), riya.token);
    expect(res.status).toBe(409);
  });

  it('lets several people ask to be the same person, so a stranger asking first can’t lock them out', async () => {
    const { signUp, link, refOf, ask, waiting } = await setup();
    const { token } = (await link()).body;
    const ref = await refOf(token, 'Kabir');
    const mallory = await ask(token, ref, (await signUp('Mallory')).token);
    const kabir = await ask(token, ref, (await signUp('Kabir')).token);
    expect(mallory.status).toBe(201);
    expect(kabir.status).toBe(201);
    expect((await waiting()).map((w) => w.name)).toEqual(['Kabir', 'Kabir']);
    // Two codes, so whoever lets one in can ask which they're talking to. (One in 10,000 they match.)
    expect((await waiting()).map((w) => w.id)).toEqual([mallory.body.id, kabir.body.id]);
  });

  it('replaces the last request when the same person asks again, as someone else', async () => {
    const { signUp, link, refOf, ask, waiting, mine } = await setup();
    const { token } = (await link()).body;
    const k = await signUp('Kabir');
    await ask(token, await refOf(token, 'Aman'), k.token);
    const again = await ask(token, await refOf(token, 'Kabir'), k.token);
    expect(again.status).toBe(201);
    expect((await waiting()).map((w) => w.name)).toEqual(['Kabir']);
    expect((await mine(k.token)).map((r) => r.name)).toEqual(['Kabir']);
  });

  it('answers a retry of the same request with the same request', async () => {
    const { signUp, link, refOf, ask, waiting } = await setup();
    const { token } = (await link()).body;
    const ref = await refOf(token, 'Kabir');
    const k = await signUp('Kabir');
    const key = { 'idempotency-key': 'ask-1' };
    const first = await ask(token, ref, k.token, key);
    const again = await ask(token, ref, k.token, key);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(await waiting()).toHaveLength(1);
  });

  it('lets someone who isn’t on the list ask to be added under their own name', async () => {
    const { signUp, link, askAsNew, waiting, members } = await setup();
    const { token } = (await link()).body;
    const asked = await askAsNew(token, '  Dev  ', (await signUp('Dev')).token);
    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({ name: 'Dev', status: 'pending' });
    expect(await waiting()).toEqual([expect.objectContaining({ name: 'Dev', existing: false })]);
    expect(await members()).toHaveLength(3);
  });

  it('won’t start a second row beside a name that is still waiting to be picked', async () => {
    const { signUp, link, askAsNew, waiting } = await setup();
    const { token } = (await link()).body;
    const res = await askAsNew(token, 'kabir ', (await signUp('Kabir')).token);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'conflict', message: 'Kabir is already in this group. Pick that name to join as them.' });
    expect(await waiting()).toEqual([]);
  });

  it('turns away an empty or overlong name, or a dead link', async () => {
    const { call, signUp, link, askAsNew } = await setup();
    const { token } = (await link()).body;
    const d = await signUp('Dev');
    expect((await call('POST', '/join-requests', { token, displayName: 'Dev' })).status).toBe(401);
    expect((await askAsNew(token, '   ', d.token)).status).toBe(400);
    expect((await askAsNew(token, 'x'.repeat(41), d.token)).status).toBe(400);
    expect((await askAsNew('nope', 'Dev', d.token)).status).toBe(404);
  });

  it(`stops at ${MAX_PENDING_JOINS} people waiting, so a leaked link can’t bury the real request`, async () => {
    const { signUp, link, askAsNew, ask, refOf, waiting, decline } = await setup();
    const { token } = (await link()).body;
    for (let i = 0; i < MAX_PENDING_JOINS; i++) {
      expect((await askAsNew(token, `Bot ${i}`, (await signUp(`Bot ${i}`)).token)).status).toBe(201);
    }
    const k = await signUp('Kabir');
    const full = await ask(token, await refOf(token, 'Kabir'), k.token);
    expect(full.status).toBe(409);

    // Turning one down makes room.
    await decline((await waiting())[0].id);
    expect((await ask(token, await refOf(token, 'Kabir'), k.token)).status).toBe(201);
  });
});

describe('POST /join-requests/:id/approve', () => {
  it('makes the person the ghost they picked: a member who can read the group and add to it', async () => {
    const { call, signUp, link, joinAs, members, group, base, kabir, aman, riya, mine } = await setup();
    await call<Expense>(
      'POST',
      `${base}/expenses`,
      { description: 'Cab', amount: 3000, paidByMemberId: group.memberIds[0], splitMode: 'equal', parts: group.memberIds.map((memberId) => ({ memberId })) },
      riya.token
    );
    const { token } = (await link()).body;
    const k = await signUp('Kabir S');

    const joined = await joinAs('Kabir', token, k.token);
    expect(joined.status).toBe(200);
    expect(joined.body).toMatchObject({ id: kabir, displayName: 'Kabir', status: 'joined', claimedByUserId: k.user.id });

    // Same row, same name, same history: only who holds it changed. Nobody else's did.
    const ms = await members();
    expect(ms.find((m) => m.id === kabir)).toMatchObject({ displayName: 'Kabir', status: 'joined', claimedByUserId: k.user.id });
    expect(ms.find((m) => m.id === aman)?.status).toBe('ghost');
    expect((await call<Group[]>('GET', '/groups', undefined, k.token)).body.map((g) => g.id)).toEqual([group.id]);
    expect((await call<Expense[]>('GET', `${base}/expenses`, undefined, k.token)).body).toHaveLength(1);
    // The request is done with.
    expect(await mine(k.token)).toEqual([]);

    const added = await call<Expense>(
      'POST',
      `${base}/expenses`,
      { description: 'Chai', amount: 200, paidByMemberId: kabir, splitMode: 'equal', parts: [{ memberId: kabir }, { memberId: group.memberIds[0] }] },
      k.token
    );
    expect(added.status).toBe(201);
  });

  it('can be done by anyone in the group, and by nobody outside it, including the person asking', async () => {
    const { signUp, link, joinAs, refOf, ask, approve, members, aman } = await setup();
    const { token } = (await link()).body;
    const k = await signUp('Kabir');
    await joinAs('Kabir', token, k.token);

    const a = await signUp('Aman');
    const asked = (await ask(token, await refOf(token, 'Aman'), a.token)).body;
    expect((await approve(asked.id, a.token)).status).toBe(404);
    expect((await approve(asked.id, (await signUp('Stranger')).token)).status).toBe(404);
    expect((await members()).find((m) => m.id === aman)?.status).toBe('ghost');

    expect((await approve(asked.id, k.token)).status).toBe(200);
    expect((await members()).find((m) => m.id === aman)?.claimedByUserId).toBe(a.user.id);
  });

  it('leaves everyone else who asked to be that person waiting, for a yes or a no of their own', async () => {
    const { signUp, link, refOf, ask, approve, decline, waiting, mine, members, kabir } = await setup();
    const { token } = (await link()).body;
    const ref = await refOf(token, 'Kabir');
    const m = await signUp('Mallory');
    const k = await signUp('Kabir');
    const fake = (await ask(token, ref, m.token)).body;
    const real = (await ask(token, ref, k.token)).body;

    expect((await approve(real.id)).status).toBe(200);
    expect(await waiting()).toEqual([expect.objectContaining({ id: fake.id, name: 'Kabir', joined: 'someone' })]);
    expect(await mine(m.token)).toEqual([fake]);
    expect((await decline(fake.id)).status).toBe(200);
    expect((await members()).find((x) => x.id === kabir)).toMatchObject({ claimedByUserId: k.user.id });
    expect((await members()).find((x) => x.id === kabir)?.alsoHeldBy).toBeUndefined();
  });

  it('adds someone who gave their own name as a new member, after everyone else', async () => {
    const { call, base, signUp, link, page, joinAsNew, members } = await setup();
    const { token } = (await link()).body;
    const d = await signUp('Dev');

    expect((await joinAsNew(token, 'Dev', d.token)).status).toBe(200);
    const ms = await members();
    expect(ms.map((m) => m.displayName)).toEqual(['Riya', 'Kabir', 'Aman', 'Dev']);
    expect(ms[3]).toMatchObject({ displayName: 'Dev', status: 'joined', claimedByUserId: d.user.id });
    expect((await page(token)).body.members.map((m) => m.name)).toEqual(['Riya', 'Kabir', 'Aman', 'Dev']);

    const added = await call<Expense>(
      'POST',
      `${base}/expenses`,
      { description: 'Chai', amount: 200, paidByMemberId: ms[3].id, splitMode: 'equal', parts: ms.map((m) => ({ memberId: m.id })) },
      d.token
    );
    expect(added.status).toBe(201);
  });

  it('still lets people in once everyone listed has joined, and allows a name someone already goes by', async () => {
    const { signUp, link, joinAs, joinAsNew, page, members } = await setup();
    const { token } = (await link()).body;
    await joinAs('Kabir', token, (await signUp('Kabir')).token);
    await joinAs('Aman', token, (await signUp('Aman')).token);
    expect((await page(token)).body.members.every((m) => m.joined)).toBe(true);

    expect((await joinAsNew(token, 'Riya', (await signUp('Riya')).token)).status).toBe(200);
    expect((await members()).map((m) => m.displayName)).toEqual(['Riya', 'Kabir', 'Aman', 'Riya']);
  });

  it('marks whoever has been let in as joined, and only them', async () => {
    const { signUp, link, page, refOf, ask, joinAs } = await setup();
    const { token } = (await link()).body;
    const joinedNames = async () => (await page(token)).body.members.filter((m) => m.joined).map((m) => m.name);
    await ask(token, await refOf(token, 'Aman'), (await signUp('Aman')).token);
    // Asking isn't joining.
    expect(await joinedNames()).toEqual(['Riya']);
    await joinAs('Kabir', token, (await signUp('Kabir')).token);
    expect(await joinedNames()).toEqual(['Riya', 'Kabir']);
  });

  it('drops the address a groupmate typed, so the member chooses where they get paid', async () => {
    const { call, signUp, link, joinAs, members, riya, kabir } = await setup();
    // Riya could type her own address for Kabir. Once he has joined, a
    // payment proven to that address must not count as paying him.
    expect((await call('PUT', `/members/${kabir}/payout-address`, { address: 'riya@getalby.com' }, riya.token)).status).toBe(200);
    const { token } = (await link()).body;
    const k = await signUp('Kabir');
    expect((await joinAs('Kabir', token, k.token)).status).toBe(200);
    expect((await members()).find((m) => m.id === kabir)?.lightningAddress).toBeUndefined();

    // Only he can set one now.
    expect((await call('PUT', `/members/${kabir}/payout-address`, { address: 'riya@getalby.com' }, riya.token)).status).toBe(400);
    expect((await call('PUT', `/members/${kabir}/payout-address`, { address: 'kabir@blink.sv' }, k.token)).status).toBe(200);
    expect((await members()).find((m) => m.id === kabir)?.lightningAddress).toBe('kabir@blink.sv');
  });

  it('marks someone with a wallet connected nwc_linked, like their other groups', async () => {
    const { db, signUp, link, joinAs, members, kabir } = await setup();
    const { token } = (await link()).body;
    const k = await signUp('Kabir');
    db.prepare(
      `INSERT INTO wallet_connections (user_id, nwc_uri, wallet_pubkey, methods, alias, connected_at)
       VALUES (?, 'nostr+walletconnect://x', 'x', '[]', NULL, '2026-10-01')`
    ).run(k.user.id);
    await joinAs('Kabir', token, k.token);
    expect((await members()).find((m) => m.id === kabir)?.status).toBe('nwc_linked');
  });

  it('answers a retry of the same approval with the member, not "not found"', async () => {
    const { signUp, link, refOf, ask, approve, kabir } = await setup();
    const { token } = (await link()).body;
    const asked = (await ask(token, await refOf(token, 'Kabir'), (await signUp('Kabir')).token)).body;
    const key = { 'idempotency-key': 'approve-1' };
    expect((await approve(asked.id, undefined, key)).status).toBe(200);
    const again = await approve(asked.id, undefined, key);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(kabir);
  });

  it('still works after the link has been turned off: the yes is what counts', async () => {
    const { call, base, signUp, link, refOf, ask, approve, riya } = await setup();
    const { token } = (await link()).body;
    const asked = (await ask(token, await refOf(token, 'Kabir'), (await signUp('Kabir')).token)).body;
    await call('DELETE', `${base}/link`, undefined, riya.token);
    expect((await approve(asked.id)).status).toBe(200);
  });

  it('lets the new member share the link, and replace it', async () => {
    const { call, base, signUp, link, joinAs } = await setup();
    const { token } = (await link()).body;
    const k = await signUp('Kabir');
    await joinAs('Kabir', token, k.token);
    expect((await call<GroupLink>('GET', `${base}/link`, undefined, k.token)).body.token).toBe(token);
    expect((await link(k.token)).status).toBe(201);
  });
});

describe('POST /join-requests/:id/decline', () => {
  it('turns the request down for good: the person asking sees it, and nothing in the group changed', async () => {
    const { signUp, link, refOf, ask, decline, approve, waiting, mine, members, kabir } = await setup();
    const { token } = (await link()).body;
    const m = await signUp('Mallory');
    const asked = (await ask(token, await refOf(token, 'Kabir'), m.token)).body;

    expect((await decline(asked.id)).status).toBe(200);
    expect(await waiting()).toEqual([]);
    expect(await mine(m.token)).toEqual([{ ...asked, status: 'declined' }]);
    expect((await approve(asked.id)).status).toBe(409);
    expect((await members()).find((x) => x.id === kabir)?.status).toBe('ghost');
  });

  it('is 404 for someone outside the group', async () => {
    const { signUp, link, refOf, ask, decline, waiting } = await setup();
    const { token } = (await link()).body;
    const asked = (await ask(token, await refOf(token, 'Kabir'), (await signUp('Kabir')).token)).body;
    expect((await decline(asked.id, (await signUp('Stranger')).token)).status).toBe(404);
    expect(await waiting()).toHaveLength(1);
  });
});

describe('join requests and people going', () => {
  it('turns down a request for someone who is then removed from the group', async () => {
    const { call, base, signUp, link, refOf, ask, approve, waiting, mine, riya, aman } = await setup();
    const { token } = (await link()).body;
    const a = await signUp('Aman');
    const asked = (await ask(token, await refOf(token, 'Aman'), a.token)).body;

    expect((await call('DELETE', `${base}/members/${aman}`, undefined, riya.token)).status).toBe(200);
    expect(await waiting()).toEqual([]);
    expect(await mine(a.token)).toEqual([{ ...asked, status: 'declined' }]);
    expect((await approve(asked.id)).status).toBe(409);
  });

  it('goes with the account that asked, and with the group', async () => {
    const { call, base, signUp, link, refOf, ask, waiting, riya, db } = await setup();
    const { token } = (await link()).body;
    const k = await signUp('Kabir');
    await ask(token, await refOf(token, 'Kabir'), k.token);
    expect((await call('DELETE', '/me', undefined, k.token)).status).toBe(200);
    expect(await waiting()).toEqual([]);

    await ask(token, await refOf(token, 'Kabir'), (await signUp('Kabir')).token);
    expect((await call('DELETE', base, undefined, riya.token)).status).toBe(200);
    expect((db.prepare('SELECT COUNT(*) AS n FROM join_requests').get() as { n: number }).n).toBe(0);
  });
});

describe('DELETE /join-requests/:id', () => {
  it('lets the person asking take it back, or clear one that was turned down, and nobody else', async () => {
    const { call, signUp, link, refOf, ask, decline, waiting, mine, riya } = await setup();
    const { token } = (await link()).body;
    const k = await signUp('Kabir');
    const asked = (await ask(token, await refOf(token, 'Kabir'), k.token)).body;

    expect((await call('DELETE', `/join-requests/${asked.id}`, undefined, riya.token)).status).toBe(404);
    expect((await call('DELETE', `/join-requests/${asked.id}`, undefined, k.token)).status).toBe(200);
    expect(await waiting()).toEqual([]);

    const again = (await ask(token, await refOf(token, 'Kabir'), k.token)).body;
    await decline(again.id);
    expect((await call('DELETE', `/join-requests/${again.id}`, undefined, k.token)).status).toBe(200);
    expect(await mine(k.token)).toEqual([]);
  });
});

describe('joining from another device', () => {
  /** Kabir has joined from his phone and paid for fuel he shared with Aman; then he opens the link on his laptop. */
  async function twoDevices() {
    const t = await setup();
    const { token } = (await t.link()).body;
    const phone = await t.signUp('Kabir');
    await t.joinAs('Kabir', token, phone.token);
    const fuel = await t.call<Expense>(
      'POST',
      `${t.base}/expenses`,
      { description: 'Fuel', amount: 3000, paidByMemberId: t.kabir, splitMode: 'equal', parts: [{ memberId: t.kabir }, { memberId: t.aman }] },
      phone.token
    );
    expect(fuel.status).toBe(201);
    const laptop = await t.signUp('Kabir');
    expect((await t.joinNow(token, { ref: await t.refOf(token, 'Kabir') }, laptop.token)).status).toBe(201);
    return { ...t, token, phone, laptop, fuel: fuel.body };
  }

  const kabirOf = async (t: Awaited<ReturnType<typeof twoDevices>>) => (await t.members()).find((m) => m.id === t.kabir)!;

  it('is the same member on both, with the same history, and either can change what he paid', async () => {
    const t = await twoDevices();
    const expenses = (await t.call<Expense[]>('GET', `${t.base}/expenses`, undefined, t.laptop.token)).body;
    expect(expenses.map((e) => [e.description, e.paidByMemberId])).toEqual([['Fuel', t.kabir]]);

    const changed = await t.call<Expense>(
      'PUT',
      `${t.base}/expenses/${t.fuel.id}`,
      { description: 'Fuel and tolls', amount: 3600, paidByMemberId: t.kabir, splitMode: 'equal', parts: [{ memberId: t.kabir }, { memberId: t.aman }] },
      t.laptop.token
    );
    expect(changed.status).toBe(200);
    // Riya is someone else, and still can't.
    expect((await t.call('DELETE', `${t.base}/expenses/${t.fuel.id}`, undefined, t.riya.token)).status).toBe(400);
  });

  it('says what Kabir would say from either device: marking what Aman owes him settled, and where he gets paid', async () => {
    const t = await twoDevices();
    const settled = await t.call('POST', `${t.base}/settlements/manual`, { fromMemberId: t.aman, toMemberId: t.kabir, amount: 1500 }, t.laptop.token);
    expect(settled.status).toBe(201);
    expect((await t.call('PUT', `/members/${t.kabir}/payout-address`, { address: 'kabir@blink.sv' }, t.laptop.token)).status).toBe(200);
    expect((await t.call('PUT', `/members/${t.kabir}/payout-address`, { address: 'riya@getalby.com' }, t.riya.token)).status).toBe(400);
  });

  it('is paid through whichever device has a way set up', async () => {
    const t = await twoDevices();
    expect((await kabirOf(t)).upi).toBeUndefined();
    expect((await t.call('PUT', '/me/upi', { upiId: 'kabir@okaxis' }, t.laptop.token)).status).toBe(200);
    expect((await kabirOf(t)).upi).toBe(true);

    // A wallet on either one links the member, and only taking off the last one unlinks it.
    const connect = (userId: string) =>
      t.db
        .prepare(
          `INSERT INTO wallet_connections (user_id, nwc_uri, wallet_pubkey, methods, alias, connected_at)
           VALUES (?, 'nostr+walletconnect://x', 'x', '[]', NULL, '2026-10-01')`
        )
        .run(userId);
    connect(t.phone.user.id);
    connect(t.laptop.user.id);
    t.db.prepare(`UPDATE members SET status = 'nwc_linked' WHERE id = ?`).run(t.kabir);
    expect((await t.call('DELETE', '/me/wallet', undefined, t.phone.token)).status).toBe(200);
    expect((await kabirOf(t)).status).toBe('nwc_linked');
    expect((await t.call('DELETE', '/me/wallet', undefined, t.laptop.token)).status).toBe(200);
    expect((await kabirOf(t)).status).toBe('joined');
  });

  it('brings a wallet the new device has connected', async () => {
    const t = await setup();
    const { token } = (await t.link()).body;
    const phone = await t.signUp('Kabir');
    await t.joinAs('Kabir', token, phone.token);
    const laptop = await t.signUp('Kabir');
    t.db
      .prepare(
        `INSERT INTO wallet_connections (user_id, nwc_uri, wallet_pubkey, methods, alias, connected_at)
         VALUES (?, 'nostr+walletconnect://x', 'x', '[]', NULL, '2026-10-01')`
      )
      .run(laptop.user.id);
    expect((await t.joinNow(token, { ref: await t.refOf(token, 'Kabir') }, laptop.token)).body.status).toBe('nwc_linked');
  });

  it('leaves the member with the other device when the first one leaves, or its account goes', async () => {
    const t = await twoDevices();
    expect((await t.call('POST', `${t.base}/leave`, undefined, t.phone.token)).status).toBe(200);
    expect(await kabirOf(t)).toMatchObject({ status: 'joined', claimedByUserId: t.laptop.user.id });
    expect((await kabirOf(t)).alsoHeldBy).toBeUndefined();
    expect((await t.call<Group[]>('GET', '/groups', undefined, t.phone.token)).body).toEqual([]);
    expect((await t.call<Group[]>('GET', '/groups', undefined, t.laptop.token)).body.map((g) => g.id)).toEqual([t.group.id]);

    // The phone comes back the same way it can always come back: by the link.
    expect((await t.joinNow(t.token, { ref: await t.refOf(t.token, 'Kabir') }, t.phone.token)).status).toBe(201);
    expect((await t.call('DELETE', '/me', undefined, t.laptop.token)).status).toBe(200);
    expect(await kabirOf(t)).toMatchObject({ claimedByUserId: t.phone.user.id });
    expect((await kabirOf(t)).alsoHeldBy).toBeUndefined();
  });

  it('keeps the pay links made for him working once the first device has left and its account has gone', async () => {
    const t = await twoDevices();
    const toKabir = (await t.call<GroupGuestView>('GET', `/g/${t.token}`)).body.debts.find((d) => d.to === 'Kabir')!;
    const made = await t.call<{ token: string }>('POST', `/g/${t.token}/debts/${toKabir.ref}/pay-link`);
    expect(made.status).toBe(201);

    expect((await t.call('POST', `${t.base}/leave`, undefined, t.phone.token)).status).toBe(200);
    expect((await t.call('DELETE', '/me', undefined, t.phone.token)).status).toBe(200);
    const opened = await t.call<GuestView>('POST', `/s/${made.body.token}/open`);
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ payerName: 'Aman', payeeName: 'Kabir' });
  });

  it('takes only itself out when the second device leaves', async () => {
    const t = await twoDevices();
    expect((await t.call('POST', `${t.base}/leave`, undefined, t.laptop.token)).status).toBe(200);
    expect(await kabirOf(t)).toMatchObject({ claimedByUserId: t.phone.user.id });
    expect((await kabirOf(t)).alsoHeldBy).toBeUndefined();
    expect((await t.call('GET', t.base, undefined, t.laptop.token)).status).toBe(404);
  });

  it('counts each device as an account, so the one person in a group can leave it from one of two', async () => {
    const { call, signUp, link, refOf, joinNow, members, base, riya, group } = await setup();
    const { token } = (await link()).body;
    const laptop = await signUp('Riya');
    expect((await joinNow(token, { ref: await refOf(token, 'Riya') }, laptop.token)).status).toBe(201);

    expect((await call('POST', `${base}/leave`, undefined, riya.token)).status).toBe(200);
    expect((await members(laptop.token)).find((m) => m.id === group.memberIds[0])).toMatchObject({ claimedByUserId: laptop.user.id });
    const last = await call<{ message: string }>('POST', `${base}/leave`, undefined, laptop.token);
    expect(last.status).toBe(409);
    expect(last.body.message).toBe('You’re the only one here with an account. Delete the group instead.');
  });

  it('waits for a payment to him to finish before a device leaves', async () => {
    const t = await twoDevices();
    const now = new Date().toISOString();
    t.db
      .prepare(
        `INSERT INTO settlements (id, group_id, from_member_id, to_member_id, amount, currency, rail, status, created_at, updated_at)
         VALUES ('s-open', ?, ?, ?, 100, 'INR', 'invoice', 'created', ?, ?)`
      )
      .run(t.group.id, t.aman, t.kabir, now, now);
    const res = await t.call<{ message: string }>('POST', `${t.base}/leave`, undefined, t.laptop.token);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('A payment to you is still in progress. Wait for it to finish.');
  });

  it('is asked for in a group that approves joins, and the group sees whose name it is', async () => {
    const t = await setup();
    const { token } = (await t.link()).body;
    const phone = await t.signUp('Kabir');
    await t.joinAs('Kabir', token, phone.token);
    await t.approveJoins(true);
    const laptop = await t.signUp('Kabir');

    const asked = await t.ask(token, await t.refOf(token, 'Kabir'), laptop.token);
    expect(asked.status).toBe(201);
    expect((await t.waiting()).map((w) => [w.name, w.existing, w.joined])).toEqual([['Kabir', true, 'someone']]);
    // The phone sees that it is its own name.
    expect((await t.waiting(phone.token))[0].joined).toBe('you');
    expect((await t.approve(asked.body.id, phone.token)).status).toBe(200);
    expect((await t.members()).find((m) => m.id === t.kabir)).toMatchObject({
      claimedByUserId: phone.user.id,
      alsoHeldBy: [laptop.user.id],
    });
  });
});
