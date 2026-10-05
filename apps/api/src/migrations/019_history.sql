-- What a group's history needs that nothing kept: who did each thing, and how
-- an expense read before it was changed.
--
-- The history itself isn't a table. It is read off expenses, expense_changes
-- and settlements (buildHistory in @sattle/core), which already say what
-- happened and when.
--
-- Each "who" is the member that person was in the group. None is a foreign
-- key: who put an expense in isn't part of what anyone owes, so it mustn't
-- be what keeps a member from being removed. Rows from before this have none.

ALTER TABLE expenses ADD COLUMN added_by_member_id TEXT;

-- Who marked a debt as settled, or confirmed that a UPI payment arrived. NULL
-- for a Lightning payment, which is settled by its proof, not on anyone's word.
ALTER TABLE settlements ADD COLUMN recorded_by_member_id TEXT;

-- expense_changes.expense is how the expense read after the change. The row
-- in expenses is overwritten by an edit and gone after a removal, so without
-- this the first reading of an edited expense, and the last of a removed
-- one, is lost.
ALTER TABLE expense_changes ADD COLUMN expense_before TEXT;
ALTER TABLE expense_changes ADD COLUMN by_member_id TEXT;

-- A change made before this still has the change before it to go on. The
-- first change to each expense has nothing, and stays NULL.
UPDATE expense_changes SET expense_before = (
  SELECT p.expense FROM expense_changes p
  WHERE p.expense_id = expense_changes.expense_id AND p.id < expense_changes.id
  ORDER BY p.id DESC LIMIT 1
);
