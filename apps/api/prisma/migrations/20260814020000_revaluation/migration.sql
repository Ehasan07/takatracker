-- Marking an asset to what it is worth now.
--
-- A revaluation is not a reconciliation: reconciling says the ledger was wrong
-- about cash that already existed, revaluing says the world moved. Both post
-- against the equity account, and telling them apart is what lets the statement
-- of changes in net worth explain a movement that no income produced.
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'REVALUATION';
