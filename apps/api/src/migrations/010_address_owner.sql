-- A joined member's payout address is one they set themselves. Until now a
-- ghost kept the address a groupmate typed for them after joining, and the
-- server can't tell those apart from ones the member chose. Clear them all:
-- nothing pays a joined member's address yet, so nothing is lost, and the
-- member sets their own when they want to receive at one.

UPDATE members SET lightning_address = NULL WHERE claimed_by_user_id IS NOT NULL;
