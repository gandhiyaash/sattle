import { describe, expect, it } from 'vitest';

import type { Expense, Group, Invite, InviteView, JoinRequest, Member, PendingJoin, User } from '@sattle/core';

import { createApp } from './app';
import { openDb } from './db';
import { SimulatedPayments } from './payments';
import { INVITE_TTL_MS, MAX_PENDING_JOINS } from './routes/invites';

/** A production-shaped server: no fixtures, no demo user. Riya has a group with two ghosts. */
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

  const invite = (as = riya.token) => call<Invite>('POST', `${base}/invites`, undefined, as);
  const page = (token: string) => call<InviteView>('GET', `/join/${token}`);
  /** What the page would send back for the person with that name. */
  const refOf = async (token: string, name: string) => (await page(token)).body.members.find((m) => m.name === name)!.ref;
  /** Asks to join as the person with that ref. Nothing changes in the group until someone lets them in. */
  const ask = (token: string, ref: string, as: string, headers?: Record<string, string>) =>
    call<JoinRequest>('POST', '/join-requests', { token, ref }, as, headers);
  const askAsNew = (token: string, displayName: string, as: string) =>
    call<JoinRequest>('POST', '/join-requests', { token, displayName }, as);
  const approve = (id: string, by = riya.token, headers?: Record<string, string>) =>
    call<Member>('POST', `/join-requests/${id}/approve`, undefined, by, headers);
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
    db, call, signUp, riya, group, base, kabir, aman, invite, page, refOf,
    ask, askAsNew, approve, decline, waiting, mine, join, joinAs, joinAsNew, members,
  };
}

describe('POST /groups/:id/invites', () => {
  it('gives a member of the group a link for the whole group, good for a week', async () => {
    const { invite, group } = await setup();
    const before = Date.now();
    const res = await invite();
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ token: expect.any(String), groupId: group.id, createdAt: expect.any(String), expiresAt: expect.any(String) });
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Date.parse(res.body.expiresAt) - before).toBeGreaterThanOrEqual(INVITE_TTL_MS);
    expect(Date.parse(res.body.expiresAt) - Date.now()).toBeLessThanOrEqual(INVITE_TTL_MS);
  });

  it('is refused for someone outside the group, without saying the group exists', async () => {
    const { invite, signUp } = await setup();
    const stranger = await signUp('Stranger');
    expect((await invite(stranger.token)).status).toBe(404);
  });

  it('replaces the last one, so a link sent to the wrong place can be taken back', async () => {
    const { signUp, invite, page, join, joinAs, members, kabir } = await setup();
    const first = (await invite()).body.token;
    const ref = (await page(first)).body.members[0].ref;
    const second = (await invite()).body.token;
    const k = await signUp('Kabir');

    expect((await page(first)).status).toBe(404);
    expect((await join(first, ref, k.token)).status).toBe(404);
    expect((await members()).find((m) => m.id === kabir)?.status).toBe('ghost');
    expect((await joinAs('Kabir', second, k.token)).status).toBe(200);
  });
});

describe('GET /groups/:id/invites', () => {
  it('is null until someone makes one, then the one that works', async () => {
    const { call, base, invite, riya } = await setup();
    expect((await call('GET', `${base}/invites`, undefined, riya.token)).body).toBeNull();
    const made = (await invite()).body;
    expect((await call('GET', `${base}/invites`, undefined, riya.token)).body).toEqual(made);
  });

  it('is null again once the invite has expired, so the next share makes a new one', async () => {
    const { db, call, base, invite, riya } = await setup();
    const { token } = (await invite()).body;
    db.prepare('UPDATE invites SET expires_at = ? WHERE token = ?').run(new Date(Date.now() - 1000).toISOString(), token);
    expect((await call('GET', `${base}/invites`, undefined, riya.token)).body).toBeNull();
    expect((await invite()).status).toBe(201);
  });

  it('is 404 for someone who isn’t in the group', async () => {
    const { call, base, invite, signUp } = await setup();
    await invite();
    expect((await call('GET', `${base}/invites`, undefined, (await signUp('Stranger')).token)).status).toBe(404);
  });
});

describe('DELETE /groups/:id/invites', () => {
  it('turns the link off for everyone holding it, and anyone in the group can', async () => {
    const { call, base, signUp, invite, page, joinAs, refOf, join, riya } = await setup();
    const { token } = (await invite()).body;
    const k = await signUp('Kabir');
    await joinAs('Kabir', token, k.token);
    const amanRef = await refOf(token, 'Aman');

    expect((await call('DELETE', `${base}/invites`, undefined, k.token)).status).toBe(200);
    expect((await page(token)).status).toBe(404);
    expect((await join(token, amanRef, (await signUp('Aman')).token)).status).toBe(404);
    expect((await call('GET', `${base}/invites`, undefined, riya.token)).body).toBeNull();
  });

  it('is 404 for someone who isn’t in the group, and leaves the link working', async () => {
    const { call, base, signUp, invite, page } = await setup();
    const { token } = (await invite()).body;
    expect((await call('DELETE', `${base}/invites`, undefined, (await signUp('Stranger')).token)).status).toBe(404);
    expect((await page(token)).status).toBe(200);
  });
});

describe('GET /join/:token', () => {
  it('shows names to anyone holding the link, and nothing else', async () => {
    const { invite, page } = await setup();
    const { token } = (await invite()).body;
    const res = await page(token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      groupName: 'Manali',
      invitedBy: 'Riya',
      members: [
        { ref: expect.any(String), name: 'Kabir' },
        { ref: expect.any(String), name: 'Aman' },
      ],
    });
  });

  it('offers only the people who haven’t joined, by a ref that isn’t their id', async () => {
    const { signUp, invite, page, joinAs, group } = await setup();
    const { token } = (await invite()).body;
    const refs = (await page(token)).body.members.map((m) => m.ref);
    expect(new Set(refs).size).toBe(2);
    for (const ref of refs) expect(group.memberIds).not.toContain(ref);

    await joinAs('Kabir', token, (await signUp('Kabir')).token);
    expect((await page(token)).body.members.map((m) => m.name)).toEqual(['Aman']);
  });

  it('gives the same person a different ref on a new link', async () => {
    const { invite, refOf } = await setup();
    const old = await refOf((await invite()).body.token, 'Kabir');
    expect(await refOf((await invite()).body.token, 'Kabir')).not.toBe(old);
  });

  it('is 404 for a token nobody made', async () => {
    const { call } = await setup();
    expect((await call('GET', '/join/nope')).status).toBe(404);
  });
});

describe('POST /join-requests', () => {
  it('asks to be the person picked, and changes nothing in the group until someone says yes', async () => {
    const { call, signUp, invite, refOf, ask, waiting, mine, members, base, kabir } = await setup();
    const { token } = (await invite()).body;
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
    const { call, invite, refOf, waiting } = await setup();
    const { token } = (await invite()).body;
    const ref = await refOf(token, 'Kabir');
    expect((await call('POST', '/join-requests', { token, ref })).status).toBe(401);
    expect(await waiting()).toEqual([]);
  });

  it('needs to be told who the person is', async () => {
    const { call, signUp, invite, waiting } = await setup();
    const { token } = (await invite()).body;
    expect((await call('POST', '/join-requests', { token }, (await signUp('Kabir')).token)).status).toBe(400);
    expect(await waiting()).toEqual([]);
  });

  it('is 404 for a ref nobody in the group has, and for one from another link', async () => {
    const { call, signUp, invite, refOf, ask, waiting, riya } = await setup();
    const other = (await call<Group>('POST', '/groups', { name: 'Flat', memberNames: ['Dev'] }, riya.token)).body;
    const theirs = (await call<Invite>('POST', `/groups/${other.id}/invites`, undefined, riya.token)).body.token;
    const dev = await refOf(theirs, 'Dev');
    const { token } = (await invite()).body;
    const k = await signUp('Kabir');

    expect((await ask(token, 'nope', k.token)).status).toBe(404);
    expect((await ask(token, dev, k.token)).status).toBe(404);
    expect(await waiting()).toEqual([]);
  });

  it('stops working after a week', async () => {
    const { db, signUp, invite, page, refOf, ask } = await setup();
    const { token } = (await invite()).body;
    const ref = await refOf(token, 'Kabir');
    db.prepare('UPDATE invites SET expires_at = ? WHERE token = ?').run(new Date(Date.now() - 1000).toISOString(), token);

    expect((await page(token)).status).toBe(410);
    const res = await ask(token, ref, (await signUp('Kabir')).token);
    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ code: 'link_expired' });
  });

  it('won’t give one person two members of the same group', async () => {
    const { invite, refOf, ask, riya } = await setup();
    const { token } = (await invite()).body;
    const res = await ask(token, await refOf(token, 'Kabir'), riya.token);
    expect(res.status).toBe(409);
  });

  it('lets several people ask to be the same person, so a stranger asking first can’t lock them out', async () => {
    const { signUp, invite, refOf, ask, waiting } = await setup();
    const { token } = (await invite()).body;
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
    const { signUp, invite, refOf, ask, waiting, mine } = await setup();
    const { token } = (await invite()).body;
    const k = await signUp('Kabir');
    await ask(token, await refOf(token, 'Aman'), k.token);
    const again = await ask(token, await refOf(token, 'Kabir'), k.token);
    expect(again.status).toBe(201);
    expect((await waiting()).map((w) => w.name)).toEqual(['Kabir']);
    expect((await mine(k.token)).map((r) => r.name)).toEqual(['Kabir']);
  });

  it('answers a retry of the same request with the same request', async () => {
    const { signUp, invite, refOf, ask, waiting } = await setup();
    const { token } = (await invite()).body;
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
    const { signUp, invite, askAsNew, waiting, members } = await setup();
    const { token } = (await invite()).body;
    const asked = await askAsNew(token, '  Dev  ', (await signUp('Dev')).token);
    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({ name: 'Dev', status: 'pending' });
    expect(await waiting()).toEqual([expect.objectContaining({ name: 'Dev', existing: false })]);
    expect(await members()).toHaveLength(3);
  });

  it('won’t start a second row beside a name that is still waiting to be picked', async () => {
    const { signUp, invite, askAsNew, waiting } = await setup();
    const { token } = (await invite()).body;
    const res = await askAsNew(token, 'kabir ', (await signUp('Kabir')).token);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'conflict', message: 'Kabir is already in this group. Pick that name to join as them.' });
    expect(await waiting()).toEqual([]);
  });

  it('turns away an empty or overlong name, or a dead link', async () => {
    const { call, signUp, invite, askAsNew } = await setup();
    const { token } = (await invite()).body;
    const d = await signUp('Dev');
    expect((await call('POST', '/join-requests', { token, displayName: 'Dev' })).status).toBe(401);
    expect((await askAsNew(token, '   ', d.token)).status).toBe(400);
    expect((await askAsNew(token, 'x'.repeat(41), d.token)).status).toBe(400);
    expect((await askAsNew('nope', 'Dev', d.token)).status).toBe(404);
  });

  it(`stops at ${MAX_PENDING_JOINS} people waiting, so a leaked link can’t bury the real request`, async () => {
    const { signUp, invite, askAsNew, ask, refOf, waiting, decline } = await setup();
    const { token } = (await invite()).body;
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

describe('POST /groups/join', () => {
  it('tells an app from before approvals to update, and lets nobody in', async () => {
    const { call, signUp, invite, refOf, members, waiting } = await setup();
    const { token } = (await invite()).body;
    const res = await call('POST', '/groups/join', { token, ref: await refOf(token, 'Kabir') }, (await signUp('Kabir')).token);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'conflict', message: expect.stringContaining('Update Sattle') });
    expect((await members()).filter((m) => m.claimedByUserId)).toHaveLength(1);
    expect(await waiting()).toEqual([]);
  });
});

describe('POST /join-requests/:id/approve', () => {
  it('makes the person the ghost they picked: a member who can read the group and add to it', async () => {
    const { call, signUp, invite, joinAs, members, group, base, kabir, aman, riya, mine } = await setup();
    await call<Expense>(
      'POST',
      `${base}/expenses`,
      { description: 'Cab', amount: 3000, paidByMemberId: group.memberIds[0], splitMode: 'equal', parts: group.memberIds.map((memberId) => ({ memberId })) },
      riya.token
    );
    const { token } = (await invite()).body;
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
    const { signUp, invite, joinAs, refOf, ask, approve, members, aman } = await setup();
    const { token } = (await invite()).body;
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

  it('turns down everyone else who asked to be that person', async () => {
    const { signUp, invite, refOf, ask, approve, waiting, mine, members, kabir } = await setup();
    const { token } = (await invite()).body;
    const ref = await refOf(token, 'Kabir');
    const m = await signUp('Mallory');
    const k = await signUp('Kabir');
    const fake = (await ask(token, ref, m.token)).body;
    const real = (await ask(token, ref, k.token)).body;

    expect((await approve(real.id)).status).toBe(200);
    expect(await waiting()).toEqual([]);
    expect(await mine(m.token)).toEqual([{ ...fake, status: 'declined' }]);
    expect((await approve(fake.id)).status).toBe(409);
    expect((await members()).find((x) => x.id === kabir)?.claimedByUserId).toBe(k.user.id);
  });

  it('adds someone who gave their own name as a new member, after everyone else', async () => {
    const { call, base, signUp, invite, page, joinAsNew, members } = await setup();
    const { token } = (await invite()).body;
    const d = await signUp('Dev');

    expect((await joinAsNew(token, 'Dev', d.token)).status).toBe(200);
    const ms = await members();
    expect(ms.map((m) => m.displayName)).toEqual(['Riya', 'Kabir', 'Aman', 'Dev']);
    expect(ms[3]).toMatchObject({ displayName: 'Dev', status: 'joined', claimedByUserId: d.user.id });
    expect((await page(token)).body.members.map((m) => m.name)).toEqual(['Kabir', 'Aman']);

    const added = await call<Expense>(
      'POST',
      `${base}/expenses`,
      { description: 'Chai', amount: 200, paidByMemberId: ms[3].id, splitMode: 'equal', parts: ms.map((m) => ({ memberId: m.id })) },
      d.token
    );
    expect(added.status).toBe(201);
  });

  it('still lets people in once everyone listed has joined, and allows a name someone already goes by', async () => {
    const { signUp, invite, joinAs, joinAsNew, page, members } = await setup();
    const { token } = (await invite()).body;
    await joinAs('Kabir', token, (await signUp('Kabir')).token);
    await joinAs('Aman', token, (await signUp('Aman')).token);
    expect((await page(token)).body.members).toEqual([]);

    expect((await joinAsNew(token, 'Riya', (await signUp('Riya')).token)).status).toBe(200);
    expect((await members()).map((m) => m.displayName)).toEqual(['Riya', 'Kabir', 'Aman', 'Riya']);
  });

  it('offers only the people nobody has been let in as', async () => {
    const { signUp, invite, page, refOf, ask, joinAs } = await setup();
    const { token } = (await invite()).body;
    await ask(token, await refOf(token, 'Aman'), (await signUp('Aman')).token);
    // Asking isn't joining: Aman is still offered.
    expect((await page(token)).body.members.map((m) => m.name)).toEqual(['Kabir', 'Aman']);
    await joinAs('Kabir', token, (await signUp('Kabir')).token);
    expect((await page(token)).body.members.map((m) => m.name)).toEqual(['Aman']);
  });

  it('drops the address a groupmate typed, so the member chooses where they get paid', async () => {
    const { call, signUp, invite, joinAs, members, riya, kabir } = await setup();
    // Riya could type her own address for Kabir. Once he has joined, a
    // payment proven to that address must not count as paying him.
    expect((await call('PUT', `/members/${kabir}/payout-address`, { address: 'riya@getalby.com' }, riya.token)).status).toBe(200);
    const { token } = (await invite()).body;
    const k = await signUp('Kabir');
    expect((await joinAs('Kabir', token, k.token)).status).toBe(200);
    expect((await members()).find((m) => m.id === kabir)?.lightningAddress).toBeUndefined();

    // Only he can set one now.
    expect((await call('PUT', `/members/${kabir}/payout-address`, { address: 'riya@getalby.com' }, riya.token)).status).toBe(400);
    expect((await call('PUT', `/members/${kabir}/payout-address`, { address: 'kabir@blink.sv' }, k.token)).status).toBe(200);
    expect((await members()).find((m) => m.id === kabir)?.lightningAddress).toBe('kabir@blink.sv');
  });

  it('marks someone with a wallet connected nwc_linked, like their other groups', async () => {
    const { db, signUp, invite, joinAs, members, kabir } = await setup();
    const { token } = (await invite()).body;
    const k = await signUp('Kabir');
    db.prepare(
      `INSERT INTO wallet_connections (user_id, nwc_uri, wallet_pubkey, methods, alias, connected_at)
       VALUES (?, 'nostr+walletconnect://x', 'x', '[]', NULL, '2026-10-01')`
    ).run(k.user.id);
    await joinAs('Kabir', token, k.token);
    expect((await members()).find((m) => m.id === kabir)?.status).toBe('nwc_linked');
  });

  it('answers a retry of the same approval with the member, not "not found"', async () => {
    const { signUp, invite, refOf, ask, approve, kabir } = await setup();
    const { token } = (await invite()).body;
    const asked = (await ask(token, await refOf(token, 'Kabir'), (await signUp('Kabir')).token)).body;
    const key = { 'idempotency-key': 'approve-1' };
    expect((await approve(asked.id, undefined, key)).status).toBe(200);
    const again = await approve(asked.id, undefined, key);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(kabir);
  });

  it('still works after the invite has expired or been turned off: the yes is what counts', async () => {
    const { call, base, signUp, invite, refOf, ask, approve, riya } = await setup();
    const { token } = (await invite()).body;
    const asked = (await ask(token, await refOf(token, 'Kabir'), (await signUp('Kabir')).token)).body;
    await call('DELETE', `${base}/invites`, undefined, riya.token);
    expect((await approve(asked.id)).status).toBe(200);
  });

  it('lets the new member share the invite, and replace it', async () => {
    const { call, base, signUp, invite, joinAs } = await setup();
    const { token } = (await invite()).body;
    const k = await signUp('Kabir');
    await joinAs('Kabir', token, k.token);
    expect((await call<Invite>('GET', `${base}/invites`, undefined, k.token)).body.token).toBe(token);
    expect((await invite(k.token)).status).toBe(201);
  });
});

describe('POST /join-requests/:id/decline', () => {
  it('turns the request down for good: the person asking sees it, and nothing in the group changed', async () => {
    const { signUp, invite, refOf, ask, decline, approve, waiting, mine, members, kabir } = await setup();
    const { token } = (await invite()).body;
    const m = await signUp('Mallory');
    const asked = (await ask(token, await refOf(token, 'Kabir'), m.token)).body;

    expect((await decline(asked.id)).status).toBe(200);
    expect(await waiting()).toEqual([]);
    expect(await mine(m.token)).toEqual([{ ...asked, status: 'declined' }]);
    expect((await approve(asked.id)).status).toBe(409);
    expect((await members()).find((x) => x.id === kabir)?.status).toBe('ghost');
  });

  it('is 404 for someone outside the group', async () => {
    const { signUp, invite, refOf, ask, decline, waiting } = await setup();
    const { token } = (await invite()).body;
    const asked = (await ask(token, await refOf(token, 'Kabir'), (await signUp('Kabir')).token)).body;
    expect((await decline(asked.id, (await signUp('Stranger')).token)).status).toBe(404);
    expect(await waiting()).toHaveLength(1);
  });
});

describe('join requests and people going', () => {
  it('turns down a request for someone who is then removed from the group', async () => {
    const { call, base, signUp, invite, refOf, ask, approve, waiting, mine, riya, aman } = await setup();
    const { token } = (await invite()).body;
    const a = await signUp('Aman');
    const asked = (await ask(token, await refOf(token, 'Aman'), a.token)).body;

    expect((await call('DELETE', `${base}/members/${aman}`, undefined, riya.token)).status).toBe(200);
    expect(await waiting()).toEqual([]);
    expect(await mine(a.token)).toEqual([{ ...asked, status: 'declined' }]);
    expect((await approve(asked.id)).status).toBe(409);
  });

  it('goes with the account that asked, and with the group', async () => {
    const { call, base, signUp, invite, refOf, ask, waiting, riya, db } = await setup();
    const { token } = (await invite()).body;
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
    const { call, signUp, invite, refOf, ask, decline, waiting, mine, riya } = await setup();
    const { token } = (await invite()).body;
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
