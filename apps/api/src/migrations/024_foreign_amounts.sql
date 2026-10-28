-- An expense paid in another currency than the group's: on a trip, the bill
-- in baht. `amount` stays what everyone owes, in the group's currency; this
-- is what was actually paid and the rate it was converted at, as JSON
-- ({currency, amount, rate}, ForeignAmount). NULL for one paid in the
-- group's own currency, which is every expense before this.

ALTER TABLE expenses ADD COLUMN original TEXT;
