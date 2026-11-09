/**
 * A group's log (GET /groups/:id/log, and each group's `log` in GET /sync):
 * every change to the group itself, with the member who made it. Saying what
 * something already is isn't a change, and notes nothing.
 */

import { describe, expect, it } from 'vitest';

import type { Group, GroupChange, GroupLink, GroupLogEntry, JoinView, Member, SyncView, User } from '@sattle/core';

import { createApp } from './app';
import { openDb } from './db';
import { SimulatedPayments } from './payments';

/** Riya made "Manali" with Kabir and Aman as ghosts. Nothing else has happened. */
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
  const group = (await call<Group>('POST', '/groups', { name: 'Manali', memberNames: ['Kabir', 'Aman'] }, riya.token)).body;
  const [mRiya, mKabir] = group.memberIds;
  const base = `/groups/${group.id}`;
  const log = async (as = riya.token) => (await call<GroupLogEntry[]>('GET', `${base}/log`, undefined, as)).body;
  /** Who did each thing, and what, oldest first. */
  const lines = async (as = riya.token): Promise<Array<[string | undefined, GroupChange]>> =>
    (await log(as)).map((l) => [l.byMemberId, l.change]);
  const join = async (as: string, name: string) => {
    const link = (await call<GroupLink | null>('GET', `${base}/link`, undefined, riya.token)).body!;
    const ref = (await call<JoinView>('GET', `/join/${link.token}`)).body.members.find((m) => m.name === name)!.ref;
    return (await call<Member>('POST', '/join', { token: link.token, ref }, as)).body;
  };

  return { db, call, signUp, riya, group, base, mRiya, mKabir, log, lines, join };
}

describe('GET /groups/:id/log', () => {
  it('starts empty', async () => {
    const { log } = await setup();
    expect(await log()).toEqual([]);
  });

  it('notes each setting changed, with who changed it, and nothing for a setting left as it was', async () => {
    const { call, base, riya, mRiya, lines } = await setup();
    await call('PUT', base, { simplifyDebts: false }, riya.token);
    await call('PUT', base, { approveJoins: true }, riya.token);
    await call('PUT', base, { name: 'Manali 2026' }, riya.token);
    // The same again: nothing changes, so nothing is noted.
    await call('PUT', base, { simplifyDebts: false, approveJoins: true, name: 'Manali 2026' }, riya.token);

    expect(await lines()).toEqual([
      [mRiya, { kind: 'simplify_debts', on: false }],
      [mRiya, { kind: 'approve_joins', on: true }],
      [mRiya, { kind: 'renamed', from: 'Manali', to: 'Manali 2026' }],
    ]);
  });

  it('notes the link made, replaced and turned off, and nothing for turning off one that’s off', async () => {
    const { call, base, riya, mRiya, lines } = await setup();
    await call('POST', `${base}/link`, undefined, riya.token);
    await call('POST', `${base}/link`, undefined, riya.token);
    await call('DELETE', `${base}/link`, undefined, riya.token);
    await call('DELETE', `${base}/link`, undefined, riya.token);

    expect(await lines()).toEqual([
      [mRiya, { kind: 'link_made' }],
      [mRiya, { kind: 'link_replaced' }],
      [mRiya, { kind: 'link_off' }],
    ]);
  });

  it('notes people added and removed by name, and who joined, was let in or left', async () => {
    const { call, base, riya, signUp, mRiya, mKabir, lines, join } = await setup();
    const dev = (await call<Member>('POST', `${base}/members`, { displayName: 'Dev' }, riya.token)).body;
    await call('DELETE', `${base}/members/${dev.id}`, undefined, riya.token);

    await call('POST', `${base}/link`, undefined, riya.token);
    const kabir = await signUp('Kabir');
    await join(kabir.token, 'Kabir');

    await call('PUT', base, { approveJoins: true }, riya.token);
    const aman = await signUp('Aman');
    const link = (await call<GroupLink | null>('GET', `${base}/link`, undefined, riya.token)).body!;
    const ref = (await call<JoinView>('GET', `/join/${link.token}`)).body.members.find((m) => m.name === 'Aman')!.ref;
    const asked = await call<{ id: string }>('POST', '/join-requests', { token: link.token, ref }, aman.token);
    await call('POST', `/join-requests/${asked.body.id}/approve`, undefined, kabir.token);

    await call('POST', `${base}/leave`, undefined, kabir.token);

    expect(await lines()).toEqual([
      [mRiya, { kind: 'member_added', name: 'Dev' }],
      [mRiya, { kind: 'member_removed', name: 'Dev' }],
      [mRiya, { kind: 'link_made' }],
      [mKabir, { kind: 'joined', name: 'Kabir' }],
      [mRiya, { kind: 'approve_joins', on: true }],
      [mKabir, { kind: 'let_in', name: 'Aman' }],
      [mKabir, { kind: 'left', name: 'Kabir' }],
    ]);
  });

  it('notes a person joining or leaving, not one more device of someone already in', async () => {
    const { call, base, riya, signUp, mKabir, lines, join } = await setup();
    await call('POST', `${base}/link`, undefined, riya.token);
    const phone = await signUp('Kabir');
    const laptop = await signUp('Kabir');
    await join(phone.token, 'Kabir');
    // The same Kabir, on another device: he's already in, so nothing is noted.
    await join(laptop.token, 'Kabir');
    // One device leaving isn't him leaving: he's still in on the other.
    await call('POST', `${base}/leave`, undefined, laptop.token);
    await call('POST', `${base}/leave`, undefined, phone.token);

    expect((await lines()).slice(1)).toEqual([
      [mKabir, { kind: 'joined', name: 'Kabir' }],
      [mKabir, { kind: 'left', name: 'Kabir' }],
    ]);
  });

  it('is in sync, is for members only, and goes with the group', async () => {
    const { call, base, riya, group, log, signUp } = await setup();
    await call('PUT', base, { simplifyDebts: false }, riya.token);
    const sync = (await call<SyncView>('GET', '/sync', undefined, riya.token)).body;
    expect(sync.groups[0]!.log).toEqual(await log());

    const stranger = await signUp('Stranger');
    expect((await call('GET', `${base}/log`, undefined, stranger.token)).status).toBe(404);

    await call('DELETE', base, undefined, riya.token);
    expect((await call('GET', `/groups/${group.id}/log`, undefined, riya.token)).status).toBe(404);
  });
});
