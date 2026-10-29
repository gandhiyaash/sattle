-- A member can be joined from more than one phone or browser. Each is an
-- account of its own, and each is that member in the group. The first to
-- join as them stays in members.claimed_by_user_id; the ones after it are
-- here, oldest first. An account is one member in a group, whichever of the
-- two holds it: the app checks that before adding a row anywhere.
CREATE TABLE member_accounts (
  member_id  TEXT NOT NULL REFERENCES members(id),
  group_id   TEXT NOT NULL REFERENCES expense_groups(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  joined_at  TEXT NOT NULL,
  PRIMARY KEY (member_id, user_id),
  UNIQUE (group_id, user_id)
);
CREATE INDEX member_accounts_user ON member_accounts(user_id);

-- Taking a name over from the account that had it is gone, and with it
-- vouching for whoever asked: picking a name someone has joined as now
-- joins as them alongside that account.
ALTER TABLE join_requests DROP COLUMN replaces_user_id;
ALTER TABLE members DROP COLUMN vouched;
