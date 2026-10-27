-- How the app is used, one row per thing that happened: a screen opened, a
-- tap, a hand-off to another app, the app going to the background, an error
-- shown, and the server's own row for each request it answered. The app
-- posts its rows in batches (POST /analytics/events); the server adds
-- request rows itself. Nothing reads this yet: it is kept for a statistics
-- page to come.
--
-- user_id is who was signed in, when someone was. It isn't a foreign key, so
-- a guest's rows need no account; deleting an account deletes its rows
-- (repo.deleteUser).
-- device_id is the app's own id for the install, so a guest who later makes
-- an account reads as one person. session_id is one launch of the app, and
-- seq its order within that, since phone clocks drift. Request rows carry
-- the device and session the app sent in its headers, when it did.
--
-- props is JSON, written whole and never queried into by the API. A page
-- that wants a value out of it can use json_extract.

CREATE TABLE IF NOT EXISTS analytics_events (
  id           TEXT PRIMARY KEY,
  user_id      TEXT,
  device_id    TEXT,
  session_id   TEXT,
  seq          INTEGER,
  kind         TEXT NOT NULL CHECK (kind IN ('screen', 'tap', 'action', 'app', 'error', 'request')),
  name         TEXT NOT NULL,
  screen       TEXT,
  props        TEXT,
  platform     TEXT,
  app_version  TEXT,
  -- When the app says it happened, by the device's clock.
  occurred_at  TEXT NOT NULL,
  -- When the server took it, by its own.
  received_at  TEXT NOT NULL
);
-- One index, for the daily prune, which goes by when the server took a row
-- (a device's clock can say anything). The table takes a row for nearly
-- every request, and nothing reads it yet, so every other index would only
-- slow those writes and grow the backups. A statistics page adds the ones
-- its own queries need, by user, session or name, when it exists.
CREATE INDEX IF NOT EXISTS analytics_events_received ON analytics_events(received_at);
