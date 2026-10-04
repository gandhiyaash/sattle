-- Edits and removals of expenses, in the order they happened.
--
-- The expenses table only holds how things read now. The ledger on Nostr
-- can't alter an entry it has published, only follow it with another, so it
-- needs to know what changed: each row here becomes one more entry.

CREATE TABLE IF NOT EXISTS expense_changes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    TEXT NOT NULL REFERENCES expense_groups(id),
  expense_id  TEXT NOT NULL,
  -- The expense as it reads after the change. NULL when it was removed.
  expense     TEXT,
  created_at  TEXT NOT NULL
);
