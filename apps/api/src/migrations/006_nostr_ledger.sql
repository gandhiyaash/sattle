-- The ledger, mirrored to Nostr so it outlives this server.
--
-- Each group gets a random key that encrypts its entries; only members are
-- given it. ledger_identity is the server's Nostr key, which signs every
-- entry. ledger_entries is an outbox: an entry is signed and stored here
-- first, then published, so a relay outage or a restart loses nothing.

ALTER TABLE expense_groups ADD COLUMN ledger_key TEXT;

CREATE TABLE IF NOT EXISTS ledger_identity (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  secret  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  event_id      TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL REFERENCES expense_groups(id),
  seq           INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('expense', 'settlement')),
  ref_id        TEXT NOT NULL,
  event         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  published_at  TEXT,
  UNIQUE (group_id, seq),
  UNIQUE (kind, ref_id)
);
CREATE INDEX IF NOT EXISTS ledger_entries_unpublished ON ledger_entries(created_at) WHERE published_at IS NULL;
