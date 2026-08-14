-- Erasing an account, on the person's own say-so.
--
-- Two nullable columns on `User` hold the request and the day the sweep may act
-- on it. The gap between them is the grace period: an irreversible deletion
-- taken in one tap on a phone is a support request nobody can answer, and
-- signing in during the window cancels it.
--
-- `AccountDeletion` is what is left afterwards. Everything the person owned is
-- gone by then — the cascade from `User` takes the workspace and the whole
-- ledger with it — but a company that cannot say whether it processed a request
-- has no answer when somebody asks a second time. The row holds a SHA-256 of
-- the address and two timestamps: enough to answer that question, not enough to
-- say whose account it was.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deletionRequestedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deletionScheduledFor" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "AccountDeletion" (
    "id" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    CONSTRAINT "AccountDeletion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AccountDeletion_emailHash_key" ON "AccountDeletion"("emailHash");
CREATE INDEX IF NOT EXISTS "AccountDeletion_completedAt_idx" ON "AccountDeletion"("completedAt");
