/**
 * SQLite via node:sqlite — no native build step, one file on disk.
 *
 * Amounts are INTEGER minor units, same as the domain. Expense parts and
 * quotes are JSON columns: they are always read and written whole, never
 * queried into.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { fixtures } from '@sattle/core';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  token         TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS expense_groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  currency    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id                  TEXT PRIMARY KEY,
  group_id            TEXT NOT NULL REFERENCES expense_groups(id),
  position            INTEGER NOT NULL,
  display_name        TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('ghost', 'joined', 'nwc_linked')),
  claimed_by_user_id  TEXT REFERENCES users(id),
  lightning_address   TEXT
);
CREATE INDEX IF NOT EXISTS members_group ON members(group_id, position);
CREATE INDEX IF NOT EXISTS members_user ON members(claimed_by_user_id);

CREATE TABLE IF NOT EXISTS expenses (
  id                 TEXT PRIMARY KEY,
  group_id           TEXT NOT NULL REFERENCES expense_groups(id),
  description        TEXT NOT NULL,
  amount             INTEGER NOT NULL CHECK (amount > 0),
  paid_by_member_id  TEXT NOT NULL REFERENCES members(id),
  split_mode         TEXT NOT NULL,
  parts              TEXT NOT NULL,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS expenses_group ON expenses(group_id, created_at);

CREATE TABLE IF NOT EXISTS settlements (
  id              TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL REFERENCES expense_groups(id),
  from_member_id  TEXT NOT NULL REFERENCES members(id),
  to_member_id    TEXT NOT NULL REFERENCES members(id),
  amount          INTEGER NOT NULL CHECK (amount > 0),
  currency        TEXT NOT NULL,
  rail            TEXT NOT NULL,
  status          TEXT NOT NULL,
  quote           TEXT,
  destination     TEXT,
  preimage        TEXT,
  note            TEXT,
  failure_reason  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS settlements_group ON settlements(group_id, created_at);

-- status/body stay NULL while the first request is still running.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id     TEXT NOT NULL,
  key         TEXT NOT NULL,
  route       TEXT NOT NULL,
  status      INTEGER,
  body        TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
`;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
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
  });
}
