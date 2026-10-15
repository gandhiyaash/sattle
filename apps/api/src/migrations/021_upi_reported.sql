-- A UPI payment can settle a debt on the payer's UPI app's word.
--
-- On Android the app that was opened to pay hands back what happened. When it
-- says the payment went through, the debt is settled straight away, with
-- nothing for the person owed to confirm. upi_receipt is what the app handed
-- back, as JSON: its transaction ID, the bank's approval reference, and the
-- link's own reference when there was one.
--
-- It is the payer's phone talking, so nothing here can check it. It is kept
-- so that anyone in the group can look the payment up against a statement.
--
-- NULL for every other settlement, including a UPI payment the person owed
-- confirmed from a claim (014): that one was their word.
--
-- Numbered after 020, which is the pay-link change still open as #75.

ALTER TABLE settlements ADD COLUMN upi_receipt TEXT;
