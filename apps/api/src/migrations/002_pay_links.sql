-- Pay links: one shareable token per debt. A link can be opened many times;
-- each open that needs a fresh invoice adds a settlement pointing back here.

CREATE TABLE IF NOT EXISTS pay_links (
  token               TEXT PRIMARY KEY,
  group_id            TEXT NOT NULL REFERENCES expense_groups(id),
  from_member_id      TEXT NOT NULL REFERENCES members(id),
  to_member_id        TEXT NOT NULL REFERENCES members(id),
  amount              INTEGER NOT NULL CHECK (amount > 0),
  created_by_user_id  TEXT NOT NULL REFERENCES users(id),
  created_at          TEXT NOT NULL
);

ALTER TABLE settlements ADD COLUMN pay_link_token TEXT REFERENCES pay_links(token);
CREATE INDEX IF NOT EXISTS settlements_pay_link ON settlements(pay_link_token, created_at);
