-- UPI, for settling a rupee debt outside Lightning.
--
-- A person's own UPI ID, one per person like their receive address, so it
-- covers every group they're in. Only they can set it.

ALTER TABLE users ADD COLUMN upi_id TEXT;

-- A payer's word that they paid a debt over UPI. Nobody can check it, so it
-- isn't a settlement and moves no balance. The payee confirms it, and the row
-- is replaced by a settlement; or says it didn't arrive, and the row stays,
-- `declined`, until the payer has seen it. One per pair: a new claim takes
-- the place of the last.

CREATE TABLE upi_claims (
  id              TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL REFERENCES expense_groups(id),
  from_member_id  TEXT NOT NULL REFERENCES members(id),
  to_member_id    TEXT NOT NULL REFERENCES members(id),
  amount          INTEGER NOT NULL CHECK (amount > 0),
  reference       TEXT,
  status          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (group_id, from_member_id, to_member_id)
);
