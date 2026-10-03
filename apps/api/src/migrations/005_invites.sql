-- Invites: a token that lets whoever opens it take over one ghost member.
-- Joining a group means reading and writing everything in it, so there is at
-- most one live token per member, and it expires.

CREATE TABLE IF NOT EXISTS invites (
  token               TEXT PRIMARY KEY,
  group_id            TEXT NOT NULL REFERENCES expense_groups(id),
  member_id           TEXT NOT NULL REFERENCES members(id),
  created_by_user_id  TEXT NOT NULL REFERENCES users(id),
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS invites_member ON invites(member_id);
