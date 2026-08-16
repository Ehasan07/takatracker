-- Loan interest, posted as it is earned instead of only when somebody pays.
--
-- Interest used to be derived for display and only reach the ledger inside a
-- repayment, so the receivable understated what was owed for as long as nobody
-- paid. It is now recognised monthly for every loan whose `interestType` is not
-- NONE. Interest-free family lending — most of what this product records — has
-- nothing to accrue and never writes a row here.
--
-- `throughDate` is a YYYY-MM-DD local calendar day rather than a timestamp, the
-- same idempotency guard the card and renewal reminders use: comparing local
-- dates is what makes "this period is already in the books" true across a
-- restart, an overlapping sweep, or a second instance. The unique index on
-- (loanId, throughDate) is the hard version of it — the amount posted is always
-- the derived figure less what the books already hold, so a repeat run computes
-- zero on its own, and the index holds even for two sweeps racing.
CREATE TABLE IF NOT EXISTS "LoanInterestAccrual" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "throughDate" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL DEFAULT 0,
    -- Null when the period earned nothing: a zero-value transaction would be
    -- noise on every statement it appeared in, but the row still has to exist
    -- so the period is not reconsidered every hour for the life of the loan.
    "transactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LoanInterestAccrual_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "LoanInterestAccrual_loanId_throughDate_key"
    ON "LoanInterestAccrual"("loanId", "throughDate");
CREATE INDEX IF NOT EXISTS "LoanInterestAccrual_workspaceId_loanId_idx"
    ON "LoanInterestAccrual"("workspaceId", "loanId");

-- Guarded, so re-running the file is not an error. CASCADE on both: an accrual
-- is a fact about one loan in one workspace and means nothing without either.
DO $$ BEGIN
    ALTER TABLE "LoanInterestAccrual" ADD CONSTRAINT "LoanInterestAccrual_workspaceId_fkey"
        FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "LoanInterestAccrual" ADD CONSTRAINT "LoanInterestAccrual_loanId_fkey"
        FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
