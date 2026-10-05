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
  it('requires auth everywhere except /health, /s/, /g/, reading who a link offers to join as, and making an account', async () => {
    const { call } = setup(undefined);
    expect((await call('GET', '/groups')).status).toBe(401);
    expect((await call('GET', '/me/wallet')).status).toBe(401);
    expect((await call('GET', '/health')).status).toBe(200);
    expect((await call('GET', '/s/demo')).status).not.toBe(401);
    expect((await call('POST', '/s/demo/open')).status).not.toBe(401);
    expect((await call('GET', '/join/nope')).status).toBe(404);
    expect((await call('GET', '/links/nope/group')).status).toBe(401);
    expect((await call('GET', '/g/demo-group')).status).toBe(200);
    expect((await call('POST', '/groups/g-flat/link')).status).toBe(401);
    expect((await call('POST', '/join-requests', { token: 'nope', ref: 'nope' })).status).toBe(401);
    expect((await call('POST', '/accounts', { displayName: 'Riya' })).status).toBe(201);
  });
});

describe('migrations', () => {
  it('records each applied file once', () => {
    const { db } = setup();
    const rows = db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(['001_init.sql', '002_pay_links.sql', '003_wallet_connections.sql', '004_payment_hash.sql', '005_invites.sql', '006_nostr_ledger.sql', '007_expense_changes.sql', '008_group_links.sql', '009_group_invites.sql', '010_address_owner.sql', '011_unique_payment_hash.sql', '012_address_invoices.sql', '013_receive_address.sql', '014_upi.sql', '015_join_requests.sql', '016_one_group_link.sql', '017_take_over.sql', '018_nostr_sign_in.sql']);
  });

  it('010 clears the addresses joined members inherited as ghosts, and keeps ghosts’ own', () => {
    const { db } = setup();
    db.prepare('DELETE FROM schema_migrations WHERE name = ?').run('010_address_owner.sql');
    db.prepare(`UPDATE members SET lightning_address = 'typed@getalby.com'`).run();
    migrate(db);

    const rows = db.prepare('SELECT claimed_by_user_id, lightning_address FROM members').all() as {
      claimed_by_user_id: string | null;
      lightning_address: string | null;
    }[];
    expect(rows.some((r) => r.claimed_by_user_id) && rows.some((r) => !r.claimed_by_user_id)).toBe(true);
    for (const r of rows) expect(r.lightning_address).toBe(r.claimed_by_user_id ? null : 'typed@getalby.com');
  });

  it('016 drops invites, starts everyone on shared links but an ID with a phone number, and keeps the ID and the group link', () => {
    const { db } = setup();
    // A database from before it: an invite out, the column as 015 made it, off, and no choice per group.
    db.prepare('DELETE FROM schema_migrations WHERE name = ?').run('016_one_group_link.sql');
    db.exec(`
      CREATE TABLE invites (
        token TEXT PRIMARY KEY, group_id TEXT NOT NULL UNIQUE REFERENCES expense_groups(id),
        created_by_user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      INSERT INTO invites VALUES ('old-invite', 'g-goa', 'u-yash', '2026-01-01T00:00:00.000Z', '2026-01-08T00:00:00.000Z');
      ALTER TABLE members DROP COLUMN upi_on_link;
      ALTER TABLE users DROP COLUMN upi_on_links;
      ALTER TABLE users ADD COLUMN upi_on_links INTEGER NOT NULL DEFAULT 0;
      UPDATE users SET upi_id = 'om@okhdfcbank' WHERE id = 'u-om';
      UPDATE users SET upi_id = '9876543210@ybl' WHERE id = 'u-yash';
      UPDATE users SET upi_id = '919812345678@paytm', upi_on_links = 1 WHERE id = 'u-priya';
    `);
    migrate(db);

    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'invites'`).get()).toBeUndefined();
    expect(db.prepare(`SELECT group_id FROM group_links WHERE token = 'demo-group'`).get()).toEqual({ group_id: 'g-flat' });

    const users = db.prepare('SELECT id, upi_id, upi_on_links FROM users ORDER BY id').all() as {
      id: string;
      upi_id: string | null;
      upi_on_links: number;
    }[];
    const on = Object.fromEntries(users.map((u) => [u.id, u.upi_on_links]));
    // No phone number in the ID: on, though it was off.
    expect(on['u-om']).toBe(1);
    // A phone number in the ID: what it was, off or on, until Wallet has warned them.
    expect(on['u-yash']).toBe(0);
    expect(on['u-priya']).toBe(1);
    expect(users.find((u) => u.id === 'u-om')?.upi_id).toBe('om@okhdfcbank');
    expect(users.find((u) => u.id === 'u-yash')?.upi_id).toBe('9876543210@ybl');
    expect(db.prepare('SELECT COUNT(*) AS n FROM members WHERE upi_on_link IS NOT NULL').get()).toEqual({ n: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    // And someone new starts on too.
    db.prepare(`INSERT INTO users (id, display_name) VALUES ('u-new', 'New')`).run();
    expect(db.prepare(`SELECT upi_on_links FROM users WHERE id = 'u-new'`).get()).toEqual({ upi_on_links: 1 });
  });
});
