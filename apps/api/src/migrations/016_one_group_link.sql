-- A group has one link now. Its shared link (group_links) shows the group,
-- takes payments, and is what someone asks to join with, so the separate
-- invite goes. Invites still out stop working.

DROP TABLE IF EXISTS invites;

-- That link shows a person's UPI ID from the start: 015 had it off until
-- they turned it on. There is nothing to show until they give an ID, and
-- they can turn it off. A column's default can't be changed in place, so the
-- column is made again, and everyone starts on.
--
-- Except an ID that already has a phone number in it. Wallet warns about
-- that before a new ID is saved, but these were saved before the warning
-- existed, so they keep what they had until the person sees it there.
-- upi_id_has_phone_number is core's upiIdHasPhoneNumber, which migrate()
-- gives SQLite.

ALTER TABLE users RENAME COLUMN upi_on_links TO upi_on_links_015;
ALTER TABLE users ADD COLUMN upi_on_links INTEGER NOT NULL DEFAULT 1;
UPDATE users SET upi_on_links = upi_on_links_015
  WHERE upi_id IS NOT NULL AND upi_id_has_phone_number(upi_id);
ALTER TABLE users DROP COLUMN upi_on_links_015;

-- The same choice for one group, where they've made it: 1 or 0, and it wins.
-- NULL follows the one above. It is the person's, not the row's, so it goes
-- when they leave the group.

ALTER TABLE members ADD COLUMN upi_on_link INTEGER;
