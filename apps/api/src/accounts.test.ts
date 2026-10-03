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
  async function call<T = unknown>(method: string, path: string, body?: unknown, token?: string) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
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
