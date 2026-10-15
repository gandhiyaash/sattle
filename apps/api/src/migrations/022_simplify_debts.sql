-- Whether a group simplifies its debts (Group.simplifyDebts). 1: debts are
-- combined into as few payments as there can be, which every group did
-- until now, so every group already here keeps doing it. 0: everyone pays
-- back whoever paid for them.

ALTER TABLE expense_groups ADD COLUMN simplify_debts INTEGER NOT NULL DEFAULT 1;
