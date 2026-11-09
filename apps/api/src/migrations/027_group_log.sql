-- What's changed about a group itself, and who changed it (GroupLogEntry):
-- a setting turned on or off, a rename, someone added, removed, joining or
-- leaving, the group's link made, replaced or turned off. Nothing kept these
-- before, so a group's log starts here.
--
-- `change` is the GroupChange as JSON, with names as they were at the time,
-- so the log still reads right once someone is renamed or gone. As with the
-- history's other "who"s, by_member_id is no foreign key: having changed a
-- setting mustn't be what keeps a member from being removed.

CREATE TABLE IF NOT EXISTS group_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id      TEXT NOT NULL REFERENCES expense_groups(id),
  by_member_id  TEXT,
  change        TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS group_log_by_group ON group_log (group_id, id);
