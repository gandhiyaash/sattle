-- Signing in with Nostr. An account can have one Nostr key linked to it, and
-- a key can be linked to one account: signing in with the key opens that
-- account, so a lost device and a lost sign-in key no longer lose it.
ALTER TABLE users ADD COLUMN nostr_pubkey TEXT;
CREATE UNIQUE INDEX users_by_nostr_pubkey ON users (nostr_pubkey) WHERE nostr_pubkey IS NOT NULL;

-- One-time challenges for those proofs. Each is good once, for a few minutes,
-- so a signed proof can't be replayed.
CREATE TABLE nostr_challenges (
  challenge   TEXT PRIMARY KEY,
  expires_at  TEXT NOT NULL
);
