-- Which savings instrument a transaction belongs to, when it belongs to one.
--
-- The profit on a Sanchayapatra arrives monthly or quarterly and lands in an
-- ordinary bank account. Without this column the ledger records that money came
-- in and loses which certificate produced it, so "how much did this DPS earn me
-- this year" has no answer. `personId` already solves the same problem for
-- people; this mirrors it exactly, ON DELETE SET NULL included — retiring a
-- matured plan must not delete the income it paid.

ALTER TABLE "Transaction" ADD COLUMN "savingsPlanId" TEXT;

ALTER TABLE "Transaction"
  ADD CONSTRAINT "Transaction_savingsPlanId_fkey"
  FOREIGN KEY ("savingsPlanId") REFERENCES "SavingsPlan"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Every read is "this workspace, this plan" — the yearly profit total per
-- instrument, and the rows behind it.
CREATE INDEX "Transaction_workspaceId_savingsPlanId_idx"
  ON "Transaction"("workspaceId", "savingsPlanId");
