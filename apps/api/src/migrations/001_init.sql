-- Initial schema. Amounts are INTEGER minor units, same as the domain.

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
