-- Invoices from a Lightning address, alongside NWC ones.
--   receive_via         'nwc' or 'address'; NULL on older rows, which are NWC
--   verify_url          the address's LUD-21 link for this invoice, if it gave one.
--                       Server-side only: it shows whether the invoice was paid,
--                       so it never goes out in a response or the Nostr ledger.
--   invoice_expires_at  unix seconds, from the invoice: an address invoice can
--                       outlive its quote, and is watched until this

ALTER TABLE settlements ADD COLUMN receive_via TEXT;
ALTER TABLE settlements ADD COLUMN verify_url TEXT;
ALTER TABLE settlements ADD COLUMN invoice_expires_at INTEGER;
