-- A person's own Lightning address for receiving, for wallets that can't do
-- NWC. One per person, like their NWC connection, so it covers every group
-- they're in, including ones they join later. Only they can set it, so a
-- payment proven to it is a payment to them.

ALTER TABLE users ADD COLUMN receive_address TEXT;
