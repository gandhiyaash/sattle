-- Joining needs a yes from someone already in the group. An invite link can
-- be forwarded, so holding one no longer makes you a member: it lets you ask.
--
-- One request per person per group: asking again, as someone else, replaces
-- it. `member_id` is the name they picked, or NULL when they gave their own
-- (`display_name`), in which case they'd be added as someone new. `code` is
-- four digits shown to them and to whoever lets them in. A request goes once
-- it's let in; a declined one stays until the asker has seen it.

CREATE TABLE join_requests (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL REFERENCES expense_groups(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  member_id     TEXT REFERENCES members(id),
  display_name  TEXT NOT NULL,
  code          TEXT NOT NULL,
  status        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (group_id, user_id)
);

CREATE INDEX join_requests_by_group ON join_requests (group_id, status);

-- UPI on a group's shared link, which has no login. Off until the person
-- turns it on, since a UPI ID often holds a phone number.
ALTER TABLE users ADD COLUMN upi_on_links INTEGER NOT NULL DEFAULT 0;

-- A UPI claim made from a shared link, by whoever held it.
ALTER TABLE upi_claims ADD COLUMN via_link INTEGER NOT NULL DEFAULT 0;
