-- Two ways back into an account, or a place in a group, after losing the
-- device it lived on.
--
-- A sign-in key can be replaced, which ends the old one everywhere. The token
-- before it is kept for a few minutes so a retry of that same replacement,
-- whose answer never arrived, can still be replayed; it can do nothing else
-- (see auth).
ALTER TABLE users ADD COLUMN previous_token TEXT;
ALTER TABLE users ADD COLUMN previous_token_until TEXT;
CREATE INDEX users_by_previous_token ON users (previous_token);

-- Asking for a name someone has joined as, to take it over from the account
-- that has it. Letting them in hands it over only while that account still
-- has it. No foreign key: an account that is deleted hands its members back
-- first, and the request then reads as one for a ghost.
ALTER TABLE join_requests ADD COLUMN replaces_user_id TEXT;
