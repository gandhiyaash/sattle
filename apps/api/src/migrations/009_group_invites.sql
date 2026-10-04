-- An invite is now for the group, not for one member: whoever opens it picks
-- which ghost they are. So a group has at most one at a time, like its group
-- link, and making another replaces it. Invites made before this named a
-- single ghost and can't be carried over; their links stop working.

DROP TABLE IF EXISTS invites;

CREATE TABLE invites (
  token               TEXT PRIMARY KEY,
  group_id            TEXT NOT NULL UNIQUE REFERENCES expense_groups(id),
  created_by_user_id  TEXT NOT NULL REFERENCES users(id),
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL
);
