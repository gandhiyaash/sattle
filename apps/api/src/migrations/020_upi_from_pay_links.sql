-- A pay link can be paid by UPI, not only over Lightning.
--
-- Someone on the link says they paid: a claim, like any other. This keeps
-- which link it was said from, so that when the person owed confirms it the
-- settlement is tied to that link, the way an invoice the link minted is.
-- The link then shows "Paid" and can't be paid a second time. NULL for a
-- claim made in the app or from the group's link.
--
-- Not a foreign key: a pay link goes when the account that made it is
-- deleted, and the claim is still the payee's to answer.

ALTER TABLE upi_claims ADD COLUMN pay_link_token TEXT;
