-- A user's NWC connection: what lets the server mint invoices into their
-- wallet. One per user. nwc_uri is a secret: never returned, never logged.

CREATE TABLE IF NOT EXISTS wallet_connections (
  user_id        TEXT PRIMARY KEY REFERENCES users(id),
  nwc_uri        TEXT NOT NULL,
  wallet_pubkey  TEXT NOT NULL,
  methods        TEXT NOT NULL,
  alias          TEXT,
  connected_at   TEXT NOT NULL
);
