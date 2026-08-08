-- CreateEnum
CREATE TYPE "EmailTokenPurpose" AS ENUM ('VERIFY_EMAIL', 'RESET_PASSWORD');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('PENDING', 'APPLIED', 'REVERTED');

-- CreateEnum
CREATE TYPE "IngestionChannel" AS ENUM ('SMS', 'EMAIL', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'DUPLICATE');

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "importBatchId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "EmailToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "EmailTokenPurpose" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestIp" TEXT,

    CONSTRAINT "EmailToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "filename" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "mapping" JSONB NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "importedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "status" "ImportStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "revertedAt" TIMESTAMP(3),

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestionMessage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channel" "IngestionChannel" NOT NULL,
    "sender" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "body" TEXT NOT NULL,
    "bodyHash" TEXT NOT NULL,
    "parsed" JSONB,
    "parserName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IngestionMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionDraft" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "messageId" TEXT,
    "status" "DraftStatus" NOT NULL DEFAULT 'PENDING',
    "date" TIMESTAMP(3),
    "amountMinor" BIGINT,
    "direction" TEXT,
    "payee" TEXT,
    "accountId" TEXT,
    "categoryId" TEXT,
    "confidence" INTEGER NOT NULL DEFAULT 0,
    "evidence" JSONB,
    "transactionId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailToken_tokenHash_key" ON "EmailToken"("tokenHash");

-- CreateIndex
CREATE INDEX "EmailToken_userId_purpose_idx" ON "EmailToken"("userId", "purpose");

-- CreateIndex
CREATE INDEX "EmailToken_expiresAt_idx" ON "EmailToken"("expiresAt");

-- CreateIndex
CREATE INDEX "ImportBatch_workspaceId_createdAt_idx" ON "ImportBatch"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ImportBatch_workspaceId_fileHash_idx" ON "ImportBatch"("workspaceId", "fileHash");

-- CreateIndex
CREATE INDEX "IngestionMessage_workspaceId_receivedAt_idx" ON "IngestionMessage"("workspaceId", "receivedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "IngestionMessage_workspaceId_bodyHash_key" ON "IngestionMessage"("workspaceId", "bodyHash");

-- CreateIndex
CREATE UNIQUE INDEX "TransactionDraft_transactionId_key" ON "TransactionDraft"("transactionId");

-- CreateIndex
CREATE INDEX "TransactionDraft_workspaceId_status_createdAt_idx" ON "TransactionDraft"("workspaceId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Transaction_workspaceId_importBatchId_idx" ON "Transaction"("workspaceId", "importBatchId");

-- AddForeignKey
ALTER TABLE "EmailToken" ADD CONSTRAINT "EmailToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngestionMessage" ADD CONSTRAINT "IngestionMessage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionDraft" ADD CONSTRAINT "TransactionDraft_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionDraft" ADD CONSTRAINT "TransactionDraft_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "IngestionMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
