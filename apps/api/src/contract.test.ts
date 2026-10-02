/**
 * Pins the shape of the API that both tracks build against. When a stub
 * here gets implemented, replace its 501 assertion with real tests.
 */

import { describe, expect, it } from 'vitest';

import { createApp } from './app';
import { openDb, seedIfEmpty } from './db';
import { SimulatedPayments } from './payments';

function setup(demoUserId?: string) {
  const db = openDb(':memory:');
  seedIfEmpty(db);
  const app = createApp({
    db,
    demoUserId,
    payments: (repo) =>
      new SimulatedPayments(repo, { stepMs: 1, settleDelayMs: 1, rateFiatPerBtc: 9_000_000, alwaysFail: false }),
  });
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { db, call };
}

describe('auth boundary', () => {
  it('requires auth everywhere except /health and /s/', async () => {
    const { call } = setup(undefined);
    expect((await call('GET', '/groups')).status).toBe(401);
    expect((await call('GET', '/me/wallet')).status).toBe(401);
    expect((await call('GET', '/health')).status).toBe(200);
    expect((await call('GET', '/s/demo')).status).not.toBe(401);
    expect((await call('POST', '/s/demo/open')).status).not.toBe(401);
  });
});

describe('migrations', () => {
  it('records each applied file once', () => {
    const { db } = setup();
    const rows = db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(['001_init.sql', '002_pay_links.sql', '003_wallet_connections.sql']);
  });
});

describe('stubs', () => {
  const pending: Array<[string, string, unknown?]> = [
    ['POST', '/groups', { name: 'Trip', memberNames: ['Om'] }],
    ['POST', '/groups/g-goa/members', { displayName: 'Riya' }],
  ];

  it.each(pending)('%s %s returns 501 until built', async (method, path, body) => {
    const { call } = setup('u-yash');
    const res = await call(method, path, body);
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ code: 'not_implemented' });
  });
});
