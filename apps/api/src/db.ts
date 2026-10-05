/**
 * SQLite via node:sqlite — no native build step, one file on disk.
 *
 * Schema lives in migrations/NNN_name.sql, applied in order and recorded in
 * schema_migrations. Add a new file for a schema change; never edit one that
 * has been merged. Expense parts and quotes are JSON columns: they are always
 * read and written whole, never queried into.
 */

import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { fixtures, upiIdHasPhoneNumber } from '@sattle/core';

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

export function migrate(db: Db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  // For 016, so the migration and the app agree on what a phone number in a UPI ID looks like.
  db.function('upi_id_has_phone_number', { deterministic: true }, (id) =>
    typeof id === 'string' && upiIdHasPhoneNumber(id) ? 1 : 0
  );
  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name)
  );
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    transaction(db, () => {
      db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
    });
  }
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Loads the same fixtures the mock uses, so both backends demo identically. */
export function seedIfEmpty(db: Db) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM expense_groups').get() as { n: number };
  if (n > 0) return;

  transaction(db, () => {
    const users = new Map<string, string>([[fixtures.currentUser.id, fixtures.currentUser.displayName]]);
    for (const m of fixtures.members) {
      if (m.claimedByUserId && !users.has(m.claimedByUserId)) users.set(m.claimedByUserId, m.displayName);
    }
    const insUser = db.prepare('INSERT INTO users (id, display_name) VALUES (?, ?)');
    for (const [id, name] of users) insUser.run(id, name);

    const insGroup = db.prepare(
      'INSERT INTO expense_groups (id, name, currency, created_at) VALUES (?, ?, ?, ?)'
    );
    const insMember = db.prepare(
      `INSERT INTO members (id, group_id, position, display_name, status, claimed_by_user_id, lightning_address)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const g of fixtures.groups) {
      insGroup.run(g.id, g.name, g.currency, g.createdAt);
      g.memberIds.forEach((id, position) => {
        const m = fixtures.members.find((x) => x.id === id)!;
        insMember.run(m.id, g.id, position, m.displayName, m.status, m.claimedByUserId ?? null, m.lightningAddress ?? null);
      });
    }

    const insExpense = db.prepare(
      `INSERT INTO expenses (id, group_id, description, amount, paid_by_member_id, split_mode, parts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const e of fixtures.expenses) {
      insExpense.run(e.id, e.groupId, e.description, e.amount, e.paidByMemberId, e.splitMode, JSON.stringify(e.parts), e.createdAt);
    }

    const insSettlement = db.prepare(
      `INSERT INTO settlements (id, group_id, from_member_id, to_member_id, amount, currency, rail, status,
                                quote, destination, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const s of fixtures.settlements) {
      insSettlement.run(
        s.id, s.groupId, s.fromMemberId, s.toMemberId, s.amount, s.currency, s.rail, s.status,
        s.quote ? JSON.stringify(s.quote) : null, s.destination ?? null, s.createdAt, s.updatedAt
      );
    }

    const insPayLink = db.prepare(
      `INSERT INTO pay_links (token, group_id, from_member_id, to_member_id, amount, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of fixtures.payLinks) {
      // Only the payee can make a link, so they're its creator.
      const creator = fixtures.members.find((m) => m.id === l.toMemberId)?.claimedByUserId;
      if (!creator) throw new Error(`Fixture pay link ${l.token}: the payee must be a claimed member.`);
      insPayLink.run(l.token, l.groupId, l.fromMemberId, l.toMemberId, l.amount, creator, l.createdAt);
    }
    const insGroupLink = db.prepare('INSERT INTO group_links (token, group_id, created_at) VALUES (?, ?, ?)');
    for (const l of fixtures.groupLinks) insGroupLink.run(l.token, l.groupId, l.createdAt);
    const tagSettlement = db.prepare('UPDATE settlements SET pay_link_token = ? WHERE id = ?');
    for (const [token, settlementId] of Object.entries(fixtures.payLinkSettlements)) {
      tagSettlement.run(token, settlementId);
    }
  });
}
