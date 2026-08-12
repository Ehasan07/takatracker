-- How much of a thing, beside how much it cost.
--
-- "I spent ৳12,000 on fuel this year" is a number the ledger already gives.
-- "I bought 340 litres" is a different question and the books could not answer
-- it at all — which is the one a household actually acts on, because a price
-- rise and a habit change look identical in taka and completely different in
-- litres.
--
-- `quantityMilli` is an integer in thousandths, not a decimal. Half a kilo is
-- 500, one and a quarter litres is 1250. The same reasoning as money: a float
-- quantity summed over a year drifts, and a drifting answer to "how much rice
-- did we get through" is worse than none. Thousandths because that is the
-- finest anybody weighs a household purchase.
--
-- `quantityUnit` is free text, capped in the schema. A fixed enum would be
-- wrong within a week — কেজি, লিটার, পিস, ডজন, হালি, বস্তা, গজ are all real,
-- and the list a Bangladeshi kitchen needs is not one anybody can finish
-- writing in advance.
--
-- Both nullable and both optional. Almost every entry will leave them empty.
ALTER TABLE "Transaction" ADD COLUMN "quantityMilli" BIGINT;
ALTER TABLE "Transaction" ADD COLUMN "quantityUnit" TEXT;

-- The rollup this exists for: how much of a unit, per category, over a period.
CREATE INDEX "Transaction_workspaceId_quantityUnit_date_idx"
    ON "Transaction"("workspaceId", "quantityUnit", "date")
    WHERE "quantityUnit" IS NOT NULL;
