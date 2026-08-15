-- Papers that expire.
--
-- A fitness certificate, a tax token, khajna, holding tax, a trade licence, a
-- passport. None of them are bookkeeping: the obligation exists whether or not
-- it has been paid, and the payment when it happens is an ordinary expense.
--
-- `lastRemindedOn` is a YYYY-MM-DD string rather than a timestamp on purpose —
-- it is the same idempotency guard the credit-card reminders use, and comparing
-- local dates is what makes "already told them today" true across a restart, an
-- overlapping sweep, or a second instance.
CREATE TABLE IF NOT EXISTS "AssetObligation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "recurrence" TEXT NOT NULL DEFAULT 'YEARLY',
    "dueDate" TIMESTAMP(3) NOT NULL,
    "reminderLeadDays" INTEGER NOT NULL DEFAULT 30,
    "estimatedCostMinor" BIGINT NOT NULL DEFAULT 0,
    "lastCompletedOn" TIMESTAMP(3),
    "documentRef" TEXT,
    "note" TEXT,
    "lastRemindedOn" TEXT,
    "isMuted" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "AssetObligation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AssetObligation_workspaceId_status_dueDate_idx"
    ON "AssetObligation"("workspaceId", "status", "dueDate");
CREATE INDEX IF NOT EXISTS "AssetObligation_workspaceId_accountId_idx"
    ON "AssetObligation"("workspaceId", "accountId");

-- Guarded, so re-running the file is not an error. SET NULL rather than
-- CASCADE on the account: selling the car does not un-happen its renewals.
DO $$ BEGIN
    ALTER TABLE "AssetObligation" ADD CONSTRAINT "AssetObligation_workspaceId_fkey"
        FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "AssetObligation" ADD CONSTRAINT "AssetObligation_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
