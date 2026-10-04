import { describe, expect, it } from 'vitest';

import type { Expense, Group, Invite, InviteView, Member, User } from '@sattle/core';

import { createApp } from './app';
import { openDb } from './db';
import { SimulatedPayments } from './payments';
import { INVITE_TTL_MS } from './routes/invites';

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
  const join = (token: string, ref: string, as: string, headers?: Record<string, string>) =>
    call<Group>('POST', '/groups/join', { token, ref }, as, headers);
  const joinAs = async (name: string, token: string, as: string) => join(token, await refOf(token, name), as);
  const members = async (as = riya.token) => (await call<Member[]>('GET', `${base}/members`, undefined, as)).body;

  return { db, call, signUp, riya, group, base, kabir, aman, invite, page, refOf, join, joinAs, members };
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

describe('POST /groups/join', () => {
  it('makes the person the ghost they picked: a member who can read the group and add to it', async () => {
    const { call, signUp, invite, joinAs, members, group, base, kabir, aman, riya } = await setup();
    await call<Expense>(
      'POST',
      `${base}/expenses`,
      { description: 'Cab', amount: 3000, paidByMemberId: group.memberIds[0], splitMode: 'equal', parts: group.memberIds.map((memberId) => ({ memberId })) },
      riya.token
    );
    const { token } = (await invite()).body;
    const k = await signUp('Kabir S');
    expect((await call('GET', base, undefined, k.token)).status).toBe(404);

    const joined = await joinAs('Kabir', token, k.token);
    expect(joined.status).toBe(200);
    expect(joined.body.id).toBe(group.id);

    // Same row, same name, same history: only who holds it changed. Nobody else's did.
    const ms = await members();
    expect(ms.find((m) => m.id === kabir)).toMatchObject({ displayName: 'Kabir', status: 'joined', claimedByUserId: k.user.id });
    expect(ms.find((m) => m.id === aman)?.status).toBe('ghost');
    expect((await call<Group[]>('GET', '/groups', undefined, k.token)).body.map((g) => g.id)).toEqual([group.id]);
    expect((await call<Expense[]>('GET', `${base}/expenses`, undefined, k.token)).body).toHaveLength(1);

    const added = await call<Expense>(
      'POST',
      `${base}/expenses`,
      { description: 'Chai', amount: 200, paidByMemberId: kabir, splitMode: 'equal', parts: [{ memberId: kabir }, { memberId: group.memberIds[0] }] },
      k.token
    );
    expect(added.status).toBe(201);
  });

  it('needs an account', async () => {
    const { call, invite, refOf, kabir, members } = await setup();
    const { token } = (await invite()).body;
    const ref = await refOf(token, 'Kabir');
    expect((await call('POST', '/groups/join', { token, ref })).status).toBe(401);
    expect((await members()).find((m) => m.id === kabir)?.status).toBe('ghost');
  });

  it('needs to be told who the person is', async () => {
    const { call, signUp, invite, members } = await setup();
    const { token } = (await invite()).body;
    const res = await call('POST', '/groups/join', { token }, (await signUp('Kabir')).token);
    expect(res.status).toBe(400);
    expect((await members()).every((m) => m.displayName === 'Riya' || m.status === 'ghost')).toBe(true);
  });

  it('lets everyone in with the same link, each as themselves', async () => {
    const { signUp, invite, joinAs, members, kabir, aman } = await setup();
    const { token } = (await invite()).body;
    const k = await signUp('Kabir');
    const a = await signUp('Aman');
    expect((await joinAs('Aman', token, a.token)).status).toBe(200);
    expect((await joinAs('Kabir', token, k.token)).status).toBe(200);

    const ms = await members();
    expect(ms.find((m) => m.id === aman)?.claimedByUserId).toBe(a.user.id);
    expect(ms.find((m) => m.id === kabir)?.claimedByUserId).toBe(k.user.id);
  });

  it('turns away a second person picking a name someone has already joined as', async () => {
    const { signUp, invite, refOf, join, members, kabir } = await setup();
    const { token } = (await invite()).body;
    const ref = await refOf(token, 'Kabir');
    const k = await signUp('Kabir');
    expect((await join(token, ref, k.token)).status).toBe(200);

    const late = await join(token, ref, (await signUp('Mallory')).token);
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ code: 'conflict', message: 'Someone has already joined as Kabir.' });
    expect((await members()).find((m) => m.id === kabir)?.claimedByUserId).toBe(k.user.id);
  });

  it('is 404 for a ref nobody in the group has, and for one from another link', async () => {
    const { call, signUp, invite, refOf, join, members, riya } = await setup();
    const other = (await call<Group>('POST', '/groups', { name: 'Flat', memberNames: ['Dev'] }, riya.token)).body;
    const theirs = (await call<Invite>('POST', `/groups/${other.id}/invites`, undefined, riya.token)).body.token;
    const dev = await refOf(theirs, 'Dev');
    const { token } = (await invite()).body;
    const k = await signUp('Kabir');

    expect((await join(token, 'nope', k.token)).status).toBe(404);
    expect((await join(token, dev, k.token)).status).toBe(404);
    expect((await members()).filter((m) => m.status !== 'ghost').map((m) => m.displayName)).toEqual(['Riya']);
  });

  it('drops the address a groupmate typed, so the member chooses where they get paid', async () => {
    const { call, signUp, invite, join, members, riya, kabir } = await setup();
    // Riya could type her own address for Kabir. Once he has joined, a
    // payment proven to that address must not count as paying him.
    expect((await call('PUT', `/members/${kabir}/payout-address`, { address: 'riya@getalby.com' }, riya.token)).status).toBe(200);
    const { token } = (await invite(kabir)).body;
    const k = await signUp('Kabir');
    expect((await join(token, k.token)).status).toBe(200);
    expect((await members()).find((m) => m.id === kabir)?.lightningAddress).toBeUndefined();

    // Only he can set one now.
    expect((await call('PUT', `/members/${kabir}/payout-address`, { address: 'riya@getalby.com' }, riya.token)).status).toBe(400);
    expect((await call('PUT', `/members/${kabir}/payout-address`, { address: 'kabir@blink.sv' }, k.token)).status).toBe(200);
    expect((await members()).find((m) => m.id === kabir)?.lightningAddress).toBe('kabir@blink.sv');
  });

  it('stops working after a week', async () => {
    const { db, signUp, invite, page, refOf, join } = await setup();
    const { token } = (await invite()).body;
    const ref = await refOf(token, 'Kabir');
    db.prepare('UPDATE invites SET expires_at = ? WHERE token = ?').run(new Date(Date.now() - 1000).toISOString(), token);

    expect((await page(token)).status).toBe(410);
    const res = await join(token, ref, (await signUp('Kabir')).token);
    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ code: 'link_expired' });
  });

  it('won’t give one person two members of the same group', async () => {
    const { invite, joinAs, members, riya, kabir } = await setup();
    const { token } = (await invite()).body;
    const res = await joinAs('Kabir', token, riya.token);
    expect(res.status).toBe(409);
    expect((await members()).find((m) => m.id === kabir)?.status).toBe('ghost');
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

  it('answers a retry of the same join with the group, not "already joined"', async () => {
    const { signUp, invite, refOf, join, group } = await setup();
    const { token } = (await invite()).body;
    const ref = await refOf(token, 'Kabir');
    const k = await signUp('Kabir');
    const key = { 'idempotency-key': 'join-1' };
    expect((await join(token, ref, k.token, key)).status).toBe(200);
    const again = await join(token, ref, k.token, key);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(group.id);
  });

  it('lets someone who isn’t on the list add themselves, as a member who has joined', async () => {
    const { call, base, signUp, invite, page, members, group } = await setup();
    const { token } = (await invite()).body;
    const d = await signUp('Dev');

    const joined = await call<Group>('POST', '/groups/join', { token, displayName: '  Dev  ' }, d.token);
    expect(joined.status).toBe(200);
    expect(joined.body.id).toBe(group.id);

    // A new row after everyone else, already theirs. The ghosts are still there to be picked.
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

  it('still lets people in once everyone listed has joined', async () => {
    const { call, signUp, invite, joinAs, page, members } = await setup();
    const { token } = (await invite()).body;
    await joinAs('Kabir', token, (await signUp('Kabir')).token);
    await joinAs('Aman', token, (await signUp('Aman')).token);
    expect((await page(token)).body.members).toEqual([]);

    expect((await call('POST', '/groups/join', { token, displayName: 'Dev' }, (await signUp('Dev')).token)).status).toBe(200);
    expect((await members()).map((m) => m.displayName)).toEqual(['Riya', 'Kabir', 'Aman', 'Dev']);
  });

  it('won’t start a second row beside a name that is still waiting to be picked', async () => {
    const { call, signUp, invite, members } = await setup();
    const { token } = (await invite()).body;
    const res = await call('POST', '/groups/join', { token, displayName: 'kabir ' }, (await signUp('Kabir')).token);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'conflict', message: 'Kabir is already in this group. Pick that name to join as them.' });
    expect(await members()).toHaveLength(3);
  });

  it('allows a name someone who has joined already goes by', async () => {
    const { call, signUp, invite, members } = await setup();
    const { token } = (await invite()).body;
    expect((await call('POST', '/groups/join', { token, displayName: 'Riya' }, (await signUp('Riya')).token)).status).toBe(200);
    expect((await members()).filter((m) => m.displayName === 'Riya')).toHaveLength(2);
  });

  it('adds nobody without an account, with an empty or overlong name, on a dead link, or twice', async () => {
    const { db, call, signUp, invite, members, riya } = await setup();
    const { token } = (await invite()).body;
    const d = await signUp('Dev');

    expect((await call('POST', '/groups/join', { token, displayName: 'Dev' })).status).toBe(401);
    expect((await call('POST', '/groups/join', { token, displayName: '   ' }, d.token)).status).toBe(400);
    expect((await call('POST', '/groups/join', { token, displayName: 'x'.repeat(41) }, d.token)).status).toBe(400);
    expect((await call('POST', '/groups/join', { token: 'nope', displayName: 'Dev' }, d.token)).status).toBe(404);
    expect((await call('POST', '/groups/join', { token, displayName: 'Riya again' }, riya.token)).status).toBe(409);
    expect(await members()).toHaveLength(3);

    expect((await call('POST', '/groups/join', { token, displayName: 'Dev' }, d.token)).status).toBe(200);
    expect((await call('POST', '/groups/join', { token, displayName: 'Dev' }, d.token)).status).toBe(409);
    expect(await members()).toHaveLength(4);

    db.prepare('UPDATE invites SET expires_at = ? WHERE token = ?').run(new Date(Date.now() - 1000).toISOString(), token);
    expect((await call('POST', '/groups/join', { token, displayName: 'Late' }, (await signUp('Late')).token)).status).toBe(410);
    expect(await members()).toHaveLength(4);
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
