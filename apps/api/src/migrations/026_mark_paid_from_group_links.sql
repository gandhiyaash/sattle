-- The group's page can mark a debt as paid, for a payment made outside
-- Sattle: cash, or UPI to a phone number. It works whatever the person owed
-- has set up, UPI ID, Lightning address or nothing. It is a claim like the
-- UPI ones, made from the link, and the person owed confirms it or says it
-- didn't arrive. Confirmed, the debt is settled outside the app (rail
-- `manual`), not paid by UPI. 0 for every claim made before this.

ALTER TABLE upi_claims ADD COLUMN another_way INTEGER NOT NULL DEFAULT 0;
