-- Joining no longer needs a yes, unless the group asks for one. Whoever
-- holds the group's link picks a name nobody has joined as, or adds
-- themselves, and is in. A group that wants to look first turns this on
-- under Manage: then picking a name makes a request (join_requests), as 015
-- had it for everyone, and someone in the group lets them in by the code.
-- Taking over a name someone has joined as asks either way.

ALTER TABLE expense_groups ADD COLUMN approve_joins INTEGER NOT NULL DEFAULT 0;

-- Whether a member can vouch for someone taking over a name someone has
-- joined as: they made the group, or whoever let them in could. Someone who
-- got in by the link alone can't, or one throwaway account joining would be
-- all it took to hand anyone's name to another. Everyone already in a group
-- made it or was let in with a yes.

ALTER TABLE members ADD COLUMN vouched INTEGER NOT NULL DEFAULT 1;
