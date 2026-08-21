-- A shape of message the owner has already rejected as "not mine" or
-- "read wrongly". The next message of that shape from that sender is stored
-- without raising a decision, so the same junk is not reviewed forever.
CREATE TABLE "IngestionRule" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "sender" TEXT NOT NULL,
  "shape" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "sample" TEXT NOT NULL,
  "matchCount" INTEGER NOT NULL DEFAULT 0,
  "lastMatchAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdByUserId" TEXT,
  CONSTRAINT "IngestionRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IngestionRule_workspaceId_sender_shape_key"
  ON "IngestionRule"("workspaceId", "sender", "shape");
CREATE INDEX "IngestionRule_workspaceId_createdAt_idx"
  ON "IngestionRule"("workspaceId", "createdAt" DESC);

ALTER TABLE "IngestionRule" ADD CONSTRAINT "IngestionRule_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Which rule kept a message out of the queue. Null for every message that
-- reached the queue on its own merits, which is every message so far.
ALTER TABLE "IngestionMessage" ADD COLUMN "suppressedByRuleId" TEXT;
