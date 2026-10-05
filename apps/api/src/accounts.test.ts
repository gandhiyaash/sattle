import { describe, expect, it } from 'vitest';

import type { Group, User } from '@sattle/core';

import { createApp } from './app';
import { openDb } from './db';
import { SimulatedPayments } from './payments';

/** A production-shaped server: no fixtures, no demo user. */
function setup() {
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
    extra: Record<string, string> = {}
  ) {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...extra };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await app.request(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  }
  const signUp = async (displayName: string) => {
    const res = await call<{ user: User; token: string }>('POST', '/accounts', { displayName });
    expect(res.status).toBe(201);
    return res.body;
  };
  return { db, call, signUp };
}

describe('POST /accounts', () => {
  it('makes an account whose token signs in as it', async () => {
    const { call, signUp } = setup();
    const { user, token } = await signUp('  Riya ');
    expect(user.displayName).toBe('Riya');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await call<User>('GET', '/me', undefined, token)).body).toEqual(user);
  });

  it('starts with no groups, and the first group makes them its claimed creator', async () => {
    const { call, signUp } = setup();
    const { token } = await signUp('Riya');
    expect((await call<Group[]>('GET', '/groups', undefined, token)).body).toEqual([]);

    const g = await call<Group>('POST', '/groups', { name: 'Manali', memberNames: ['Kabir'] }, token);
    expect(g.status).toBe(201);
    expect((await call<Group[]>('GET', '/groups', undefined, token)).body.map((x) => x.id)).toEqual([g.body.id]);
  });

  it('keeps accounts apart', async () => {
    const { call, signUp } = setup();
    const riya = await signUp('Riya');
    const kabir = await signUp('Kabir');
    expect(riya.token).not.toBe(kabir.token);
    const g = await call<Group>('POST', '/groups', { name: 'Manali', memberNames: [] }, riya.token);
    expect((await call('GET', `/groups/${g.body.id}`, undefined, kabir.token)).status).toBe(404);
    expect((await call<Group[]>('GET', '/groups', undefined, kabir.token)).body).toEqual([]);
  });

  it.each([{ displayName: ' ' }, { displayName: 'x'.repeat(41) }, {}])('rejects %j', async (body) => {
    const { call } = setup();
    expect((await call('POST', '/accounts', body)).status).toBe(400);
  });

  it('refuses everything else without a token when there is no demo user', async () => {
    const { call } = setup();
    expect((await call('GET', '/me')).status).toBe(401);
    expect((await call('GET', '/me', undefined, 'not-a-token')).status).toBe(401);
  });
});

describe('POST /me/token', () => {
  const replace = (call: ReturnType<typeof setup>['call'], token: string, key?: string) =>
    call<{ token: string; code?: string }>('POST', '/me/token', undefined, token, key ? { 'idempotency-key': key } : {});

  it('gives a new sign-in key, the same account, and ends the old key everywhere', async () => {
    const { call, signUp } = setup();
    const { user, token } = await signUp('Riya');
    expect((await call<Group>('POST', '/groups', { name: 'Manali', memberNames: [] }, token)).status).toBe(201);

    const res = await replace(call, token, 'k1');
    expect(res.status).toBe(200);
    const next = res.body.token;
    expect(next).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(next).not.toBe(token);
    expect((await call<User>('GET', '/me', undefined, next)).body).toEqual(user);
    expect((await call<Group[]>('GET', '/groups', undefined, next)).body.map((g) => g.name)).toEqual(['Manali']);
    expect((await call('GET', '/me', undefined, token)).status).toBe(401);
    expect((await call('GET', '/groups', undefined, token)).status).toBe(401);
  });

  it('replays the new key to a retry with the old one, so a lost answer doesn’t lock the device out', async () => {
    const { call, signUp } = setup();
    const { token } = await signUp('Riya');
    const first = await replace(call, token, 'k1');
    const retry = await replace(call, token, 'k1');
    expect(retry.status).toBe(200);
    expect(retry.body.token).toBe(first.body.token);
  });

  it('won’t let the old key make another new one, or do anything else', async () => {
    const { call, signUp } = setup();
    const { token } = await signUp('Riya');
    const next = (await replace(call, token, 'k1')).body.token;

    expect((await replace(call, token, 'k2')).status).toBe(401);
    expect((await replace(call, token)).status).toBe(401);
    expect((await call('DELETE', '/me', undefined, token)).status).toBe(401);
    expect((await call('GET', '/me', undefined, next)).status).toBe(200);
  });

  it('stops replaying after a few minutes', async () => {
    const { db, call, signUp } = setup();
    const { token } = await signUp('Riya');
    await replace(call, token, 'k1');
    db.prepare('UPDATE users SET previous_token_until = ?').run(new Date(Date.now() - 1000).toISOString());
    expect((await replace(call, token, 'k1')).status).toBe(401);
  });

  it('can be replaced again, and then the first key is no good even for a replay', async () => {
    const { call, signUp } = setup();
    const { token } = await signUp('Riya');
    const second = (await replace(call, token, 'k1')).body.token;
    const third = (await replace(call, second, 'k2')).body.token;
    expect((await replace(call, token, 'k1')).status).toBe(401);
    expect((await replace(call, second, 'k2')).body.token).toBe(third);
  });

  it('needs a sign-in', async () => {
    const { call } = setup();
    expect((await call('POST', '/me/token')).status).toBe(401);
  });
});
