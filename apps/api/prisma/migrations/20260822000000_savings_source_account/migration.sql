-- Which account a DPS instalment is taken out of, remembered on the plan.
--
-- Nullable and unconstrained by design: it is what the deposit dialog defaults
-- to, not a rule about where money may come from. No foreign key for the same
-- reason a stale default is harmless — an account that is later archived leaves
-- the dialog asking, which is exactly what it did before this column existed.
ALTER TABLE "SavingsPlan" ADD COLUMN "sourceAccountId" TEXT;
