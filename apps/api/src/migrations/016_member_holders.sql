-- A name can be joined from more than one device: a browser first and the app
-- later, a new phone. Each device has its own account, so a member can now be
-- held by several. members.claimed_by_user_id stays the one the member is paid
-- through; the others are here. All of them act as that member in the group.

CREATE TABLE member_holders (
  member_id   TEXT NOT NULL REFERENCES members(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (member_id, user_id)
);

CREATE INDEX member_holders_user ON member_holders(user_id);
