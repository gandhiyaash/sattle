-- One invoice, one settlement. A payment hash names one payment, so two
-- settlements holding the same one would both be confirmed by it. A wallet
-- or LNURL server that hands back an invoice it already gave us is refused
-- when the invoice is minted; this makes it impossible to store regardless.
-- NULLs stay allowed: a settlement has no hash until it has an invoice.

DROP INDEX IF EXISTS settlements_payment_hash;
CREATE UNIQUE INDEX settlements_payment_hash ON settlements(payment_hash);
