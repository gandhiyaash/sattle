-- The invoice's payment hash, so the confirmation loop can look it up on the
-- payee's wallet and check the preimage against it.

ALTER TABLE settlements ADD COLUMN payment_hash TEXT;
CREATE INDEX IF NOT EXISTS settlements_payment_hash ON settlements(payment_hash);
