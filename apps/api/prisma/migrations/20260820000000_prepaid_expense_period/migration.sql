-- An expense paid once for a period longer than the month it was paid in.
--
-- A year of car insurance, a trade licence, a school session's fee: ৳12,000
-- leaves the bank in Boishakh and the month it left looks ৳12,000 worse than
-- the eleven that follow, none of which look any better. The question the
-- household actually has — "what does a month cost me" — has no answer on a
-- screen that only ever shows the day the money moved.
--
-- ## Two columns, and deliberately nothing else
--
-- These generate no rows. There is no prepaid asset recognised here, no monthly
-- amortisation transaction written, and no change to when the expense posts:
-- the whole ৳12,000 still lands on the day it was paid, exactly as it does
-- today. `prepaidStartDate` and `prepaidMonths` are read by one screen, which
-- divides for the eye and says out loud that it is doing so.
--
-- ## Why not do it properly
--
-- Recognising the prepayment as an asset and releasing it month by month is
-- what IAS 1.27 asks for, and it is the wrong trade in this ledger. Every
-- statement this app serves declares `basis: 'CASH'` from one shared constant.
-- Booking an accrual while four responses go on saying the books are cash-basis
-- makes that declaration false, and a nicer monthly figure is not worth a
-- statement that lies about what it is. The arithmetic therefore lives in the
-- presentation layer, where nothing can mistake it for a posting.
--
-- ## Why two columns rather than a table
--
-- A `PrepaidSchedule` row per month would be the shape that eventually gets
-- posted by accident — it looks like a ledger already. A start and a count on
-- the transaction cannot be posted, cannot drift from the amount it divides,
-- and disappears with the transaction if it is deleted.

ALTER TABLE "Transaction" ADD COLUMN "prepaidStartDate" TIMESTAMP(3);
ALTER TABLE "Transaction" ADD COLUMN "prepaidMonths" INTEGER;

-- The spread screen asks one question: "which of this workspace's rows cover a
-- period at all?" A household marks a handful — the insurance, the licence, the
-- school fee — among thousands of ordinary rows, so the index that matters is
-- the one that skips the thousands. `prepaidMonths IS NOT NULL` is a range on
-- the second column of this key, which is exactly what a btree does well.
CREATE INDEX "Transaction_workspaceId_prepaidMonths_idx"
  ON "Transaction"("workspaceId", "prepaidMonths");
