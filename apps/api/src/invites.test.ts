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

  const invite = async (memberId: string, as = riya.token) =>
    call<Invite>('POST', `/groups/${group.id}/invites`, { memberId }, as);
  const join = (token: string, as: string, headers?: Record<string, string>) =>
    call<Group>('POST', '/groups/join', { token }, as, headers);
  const members = async (as = riya.token) => (await call<Member[]>('GET', `/groups/${group.id}/members`, undefined, as)).body;

  return { db, call, signUp, riya, group, kabir, aman, invite, join, members };
}

describe('POST /groups/:id/invites', () => {
  it('gives a member of the group a link for one of its ghosts, good for a week', async () => {
    const { invite, group, kabir } = await setup();
    const before = Date.now();
    const res = await invite(kabir);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ groupId: group.id, memberId: kabir });
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Date.parse(res.body.expiresAt) - before).toBeGreaterThanOrEqual(INVITE_TTL_MS);
    expect(Date.parse(res.body.expiresAt) - Date.now()).toBeLessThanOrEqual(INVITE_TTL_MS);
  });

  it('is refused for someone outside the group, without saying the group exists', async () => {
    const { invite, signUp, kabir } = await setup();
    const stranger = await signUp('Stranger');
    expect((await invite(kabir, stranger.token)).status).toBe(404);
  });

  it('is refused for a member of another group, and for one who has already joined', async () => {
    const { call, invite, riya, group } = await setup();
    const other = (await call<Group>('POST', '/groups', { name: 'Flat', memberNames: ['Dev'] }, riya.token)).body;
    expect((await invite(other.memberIds[1])).status).toBe(404);

    const mine = await invite(group.memberIds[0]);
    expect(mine.status).toBe(409);
    expect(mine.body).toMatchObject({ code: 'conflict' });
  });
});

describe('GET /join/:token', () => {
  it('shows names to anyone holding the link, and nothing else', async () => {
    const { call, invite, kabir } = await setup();
    const { token } = (await invite(kabir)).body;
    const res = await call<InviteView>('GET', `/join/${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ groupName: 'Manali', memberName: 'Kabir', invitedBy: 'Riya' });
  });

  it('is 404 for a token nobody made', async () => {
    const { call } = await setup();
    expect((await call('GET', '/join/nope')).status).toBe(404);
  });
});

describe('POST /groups/join', () => {
  it('makes the person that ghost: a member who can read the group and add to it', async () => {
    const { call, signUp, invite, join, members, group, kabir, riya } = await setup();
    await call<Expense>(
      'POST',
      `/groups/${group.id}/expenses`,
      { description: 'Cab', amount: 3000, paidByMemberId: group.memberIds[0], splitMode: 'equal', parts: group.memberIds.map((memberId) => ({ memberId })) },
      riya.token
    );
    const { token } = (await invite(kabir)).body;
    const k = await signUp('Kabir S');
    expect((await call('GET', `/groups/${group.id}`, undefined, k.token)).status).toBe(404);

    const joined = await join(token, k.token);
    expect(joined.status).toBe(200);
    expect(joined.body.id).toBe(group.id);

    // Same row, same name, same history: only who holds it changed.
    const kabirNow = (await members()).find((m) => m.id === kabir);
    expect(kabirNow).toMatchObject({ displayName: 'Kabir', status: 'joined', claimedByUserId: k.user.id });
    expect((await call<Group[]>('GET', '/groups', undefined, k.token)).body.map((g) => g.id)).toEqual([group.id]);
    expect((await call<Expense[]>('GET', `/groups/${group.id}/expenses`, undefined, k.token)).body).toHaveLength(1);

    const added = await call<Expense>(
      'POST',
      `/groups/${group.id}/expenses`,
      { description: 'Chai', amount: 200, paidByMemberId: kabir, splitMode: 'equal', parts: [{ memberId: kabir }, { memberId: group.memberIds[0] }] },
      k.token
    );
    expect(added.status).toBe(201);
  });

  it('needs an account', async () => {
    const { call, invite, kabir, members } = await setup();
    const { token } = (await invite(kabir)).body;
    expect((await call('POST', '/groups/join', { token })).status).toBe(401);
    expect((await members()).find((m) => m.id === kabir)?.status).toBe('ghost');
  });

  it('works once: a second person with the same link is turned away, and so is the page', async () => {
    const { call, signUp, invite, join, kabir } = await setup();
    const { token } = (await invite(kabir)).body;
    expect((await join(token, (await signUp('Kabir')).token)).status).toBe(200);

    const late = await join(token, (await signUp('Mallory')).token);
    expect(late.status).toBe(410);
    expect(late.body).toMatchObject({ code: 'link_expired' });
    expect((await call('GET', `/join/${token}`)).status).toBe(410);
  });

  it('only honours the newest link for a ghost', async () => {
    const { call, signUp, invite, join, members, kabir } = await setup();
    const first = (await invite(kabir)).body.token;
    const second = (await invite(kabir)).body.token;
    const k = await signUp('Kabir');

    expect((await call('GET', `/join/${first}`)).status).toBe(404);
    expect((await join(first, k.token)).status).toBe(404);
    expect((await members()).find((m) => m.id === kabir)?.status).toBe('ghost');
    expect((await join(second, k.token)).status).toBe(200);
  });

  it('keeps links for different ghosts apart', async () => {
    const { signUp, invite, join, members, kabir, aman } = await setup();
    const forKabir = (await invite(kabir)).body.token;
    const forAman = (await invite(aman)).body.token;
    const a = await signUp('Aman');
    expect((await join(forAman, a.token)).status).toBe(200);

    const ms = await members();
    expect(ms.find((m) => m.id === aman)?.claimedByUserId).toBe(a.user.id);
    expect(ms.find((m) => m.id === kabir)?.status).toBe('ghost');
    expect((await join(forKabir, (await signUp('Kabir')).token)).status).toBe(200);
  });

  it('stops working after a week', async () => {
    const { db, call, signUp, invite, join, kabir } = await setup();
    const { token } = (await invite(kabir)).body;
    db.prepare('UPDATE invites SET expires_at = ? WHERE token = ?').run(new Date(Date.now() - 1000).toISOString(), token);

    expect((await call('GET', `/join/${token}`)).status).toBe(410);
    const res = await join(token, (await signUp('Kabir')).token);
    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ code: 'link_expired' });
  });

  it('won’t give one person two members of the same group', async () => {
    const { invite, join, members, riya, kabir } = await setup();
    const { token } = (await invite(kabir)).body;
    const res = await join(token, riya.token);
    expect(res.status).toBe(409);
    expect((await members()).find((m) => m.id === kabir)?.status).toBe('ghost');
  });

  it('marks someone with a wallet connected nwc_linked, like their other groups', async () => {
    const { db, signUp, invite, join, members, kabir } = await setup();
    const { token } = (await invite(kabir)).body;
    const k = await signUp('Kabir');
    db.prepare(
      `INSERT INTO wallet_connections (user_id, nwc_uri, wallet_pubkey, methods, alias, connected_at)
       VALUES (?, 'nostr+walletconnect://x', 'x', '[]', NULL, '2026-10-01')`
    ).run(k.user.id);
    await join(token, k.token);
    expect((await members()).find((m) => m.id === kabir)?.status).toBe('nwc_linked');
  });

  it('answers a retry of the same join with the group, not "already used"', async () => {
    const { signUp, invite, join, group, kabir } = await setup();
    const { token } = (await invite(kabir)).body;
    const k = await signUp('Kabir');
    const key = { 'idempotency-key': 'join-1' };
    expect((await join(token, k.token, key)).status).toBe(200);
    const again = await join(token, k.token, key);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(group.id);
  });

  it('lets the new member invite the next ghost', async () => {
    const { signUp, invite, join, kabir, aman } = await setup();
    const k = await signUp('Kabir');
    await join((await invite(kabir)).body.token, k.token);
    expect((await invite(aman, k.token)).status).toBe(201);
  });
});
