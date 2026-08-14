-- Bringing another product's books across, one reviewable batch at a time.
--
-- Nothing is created until every row has been decided. The owner's Wallet
-- account holds twenty accounts and two hundred categories, and most of those
-- categories are not categories — a DPS became one because Wallet had nowhere
-- else to put it. Creating all two hundred and sorting it out afterwards would
-- take a usable chart of accounts and make it unusable.
--
-- The batch exists separately from the items so the whole thing can be undone:
-- apply writes each created id onto its item, and rollback deletes exactly
-- those and nothing else. An import somebody cannot take back is an import they
-- will not risk running.
CREATE TABLE IF NOT EXISTS "MigrationBatch" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "rolledBackAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "note" TEXT,
    CONSTRAINT "MigrationBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MigrationItem" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "sourcePayload" JSONB,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "decision" TEXT NOT NULL DEFAULT 'CREATE',
    "targetType" TEXT,
    "targetId" TEXT,
    "createdEntityId" TEXT,
    "createdEntityKind" TEXT,
    "skippedReason" TEXT,
    CONSTRAINT "MigrationItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MigrationBatch_workspaceId_createdAt_idx"
    ON "MigrationBatch"("workspaceId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "MigrationItem_batchId_kind_sourceId_key"
    ON "MigrationItem"("batchId", "kind", "sourceId");
CREATE INDEX IF NOT EXISTS "MigrationItem_workspaceId_kind_idx"
    ON "MigrationItem"("workspaceId", "kind");

ALTER TABLE "MigrationBatch" DROP CONSTRAINT IF EXISTS "MigrationBatch_workspaceId_fkey";
ALTER TABLE "MigrationBatch" ADD CONSTRAINT "MigrationBatch_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MigrationItem" DROP CONSTRAINT IF EXISTS "MigrationItem_batchId_fkey";
ALTER TABLE "MigrationItem" ADD CONSTRAINT "MigrationItem_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "MigrationBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
