-- Group links: one token that shows a whole group, read-only, to anyone who
-- holds it, and lets them pay a debt in it. A group has none until someone in
-- it makes one, and at most one at a time: making another replaces it.

CREATE TABLE IF NOT EXISTS group_links (
  token       TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL UNIQUE REFERENCES expense_groups(id),
  created_at  TEXT NOT NULL
);
