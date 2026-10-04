/**
 * Pins the shape of the API that both tracks build against. When a stub
 * here gets implemented, replace its 501 assertion with real tests.
 */

import { describe, expect, it } from 'vitest';

import { createApp } from './app';
import { migrate, openDb, seedIfEmpty } from './db';
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
  it('requires auth everywhere except /health, /s/, /g/, reading an invite and making an account', async () => {
    const { call } = setup(undefined);
    expect((await call('GET', '/groups')).status).toBe(401);
    expect((await call('GET', '/me/wallet')).status).toBe(401);
    expect((await call('GET', '/health')).status).toBe(200);
    expect((await call('GET', '/s/demo')).status).not.toBe(401);
    expect((await call('POST', '/s/demo/open')).status).not.toBe(401);
    expect((await call('GET', '/join/nope')).status).toBe(404);
    expect((await call('GET', '/g/demo-group')).status).toBe(200);
    expect((await call('POST', '/groups/g-flat/link')).status).toBe(401);
    expect((await call('POST', '/groups/join', { token: 'nope' })).status).toBe(401);
    expect((await call('POST', '/accounts', { displayName: 'Riya' })).status).toBe(201);
  });
});

describe('migrations', () => {
  it('records each applied file once', () => {
    const { db } = setup();
    const rows = db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(['001_init.sql', '002_pay_links.sql', '003_wallet_connections.sql', '004_payment_hash.sql', '005_invites.sql', '006_nostr_ledger.sql', '007_expense_changes.sql', '008_group_links.sql', '009_address_owner.sql']);
  });

  it('009 clears the addresses joined members inherited as ghosts, and keeps ghosts’ own', () => {
    const { db } = setup();
    db.prepare('DELETE FROM schema_migrations WHERE name = ?').run('009_address_owner.sql');
    db.prepare(`UPDATE members SET lightning_address = 'typed@getalby.com'`).run();
    migrate(db);

    const rows = db.prepare('SELECT claimed_by_user_id, lightning_address FROM members').all() as {
      claimed_by_user_id: string | null;
      lightning_address: string | null;
    }[];
    expect(rows.some((r) => r.claimed_by_user_id) && rows.some((r) => !r.claimed_by_user_id)).toBe(true);
    for (const r of rows) expect(r.lightning_address).toBe(r.claimed_by_user_id ? null : 'typed@getalby.com');
  });
});
