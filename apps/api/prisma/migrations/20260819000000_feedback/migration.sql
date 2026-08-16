-- A way for a user to say what is broken and what they wish existed.
--
-- Deliberately not foreign-keyed to "User" or "Workspace". A complaint has to
-- survive the person who sent it closing their account — which is exactly the
-- case where they had something to complain about — and both ON DELETE CASCADE
-- and ON DELETE SET NULL would either destroy the row or strip it of who it
-- came from. The identifying columns are plain text, and the name and email are
-- copies taken at the moment of writing so the row can still be answered.
--
-- One consequence, stated so nobody discovers it by surprise: deleting a
-- workspace leaves its feedback behind. That is the intent. This is the one
-- table in the product that belongs to the operator rather than to the tenant.

CREATE TYPE "FeedbackKind" AS ENUM ('PROBLEM', 'IDEA', 'OTHER');

CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userEmail" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "kind" "FeedbackKind" NOT NULL DEFAULT 'OTHER',
    "message" TEXT NOT NULL,
    -- The path they were on, never the full URL: a query string carries account
    -- ids and date ranges into a table an operator reads.
    "screen" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- Newest first is the only order this is ever read in.
CREATE INDEX "Feedback_createdAt_idx" ON "Feedback"("createdAt" DESC);

-- Everything one tenant has ever told us.
CREATE INDEX "Feedback_workspaceId_createdAt_idx" ON "Feedback"("workspaceId", "createdAt" DESC);

-- The daily-cap query: this person's rows since a cutoff. Without it the
-- ceiling that stops one person flooding the table costs a full scan, which
-- would make the flood cheaper the more of it there already was.
CREATE INDEX "Feedback_userId_createdAt_idx" ON "Feedback"("userId", "createdAt");
