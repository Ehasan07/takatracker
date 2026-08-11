-- What the money actually was, when it was not the workspace's own currency.
--
-- The ledger itself stays single-currency: `amountMinor` and every LedgerEntry
-- remain in the workspace's money, so balances, reports, the balance sheet and
-- the deferred debits-equal-credits trigger are all untouched. That is
-- deliberate — converting inside the ledger would mean an FX gain/loss account
-- and a revaluation pass, which is a different and much heavier product.
--
-- Instead the original is recorded beside the converted figure. The rate is
-- then `amountMinor / fxAmountMinor`, derivable exactly and *not stored*: a
-- rate is the only number here that cannot be an integer, and `LedgerEntry.
-- fxRate` is an Int column that could never have held 110.25 anyway.
ALTER TABLE "Transaction" ADD COLUMN "fxCurrency" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "fxAmountMinor" BIGINT;
