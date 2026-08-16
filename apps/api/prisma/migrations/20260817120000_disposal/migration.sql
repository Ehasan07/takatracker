-- Selling an asset: land, a car, gold, shares.
--
-- Its own transaction type because it is the opposite of REVALUATION in the one
-- way that matters. Revaluing moves net worth without any money changing hands
-- and posts against equity (IAS 16.39). Selling turns the asset into cash, and
-- the gain or loss on disposal goes to profit or loss (IAS 16.68).
--
-- Booking one as the other puts a realised gain in equity or an unrealised one
-- in income, and both errors run in the direction that flatters — which is
-- exactly why the two must be distinguishable on the statement of changes in
-- net worth rather than inferred from the accounts a transaction touched.

ALTER TYPE "TransactionType" ADD VALUE 'DISPOSAL';
