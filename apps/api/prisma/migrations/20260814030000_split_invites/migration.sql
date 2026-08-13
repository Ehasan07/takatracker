-- CreateEnum
CREATE TYPE "SplitMirrorStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- DropIndex
DROP INDEX "EmailToken_userId_purpose_createdAt_idx";

-- AlterTable
ALTER TABLE "SplitGroupMember" ADD COLUMN     "linkedUserId" TEXT,
ADD COLUMN     "linkedWorkspaceId" TEXT;

-- CreateTable
CREATE TABLE "SplitInvite" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" TEXT,
    "acceptedWorkspaceId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SplitInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SplitMirror" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "payerName" TEXT NOT NULL,
    "groupName" TEXT NOT NULL,
    "status" "SplitMirrorStatus" NOT NULL DEFAULT 'PENDING',
    "transactionId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SplitMirror_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SplitInvite_memberId_key" ON "SplitInvite"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "SplitInvite_tokenHash_key" ON "SplitInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "SplitInvite_workspaceId_groupId_idx" ON "SplitInvite"("workspaceId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "SplitMirror_transactionId_key" ON "SplitMirror"("transactionId");

-- CreateIndex
CREATE INDEX "SplitMirror_workspaceId_status_createdAt_idx" ON "SplitMirror"("workspaceId", "status", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "SplitMirror_expenseId_workspaceId_key" ON "SplitMirror"("expenseId", "workspaceId");

-- CreateIndex
CREATE INDEX "EmailToken_userId_purpose_createdAt_idx" ON "EmailToken"("userId", "purpose", "createdAt");

-- AddForeignKey
ALTER TABLE "SplitInvite" ADD CONSTRAINT "SplitInvite_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SplitInvite" ADD CONSTRAINT "SplitInvite_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "SplitGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SplitInvite" ADD CONSTRAINT "SplitInvite_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "SplitGroupMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SplitMirror" ADD CONSTRAINT "SplitMirror_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SplitMirror" ADD CONSTRAINT "SplitMirror_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "SharedExpense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SplitMirror" ADD CONSTRAINT "SplitMirror_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "SplitGroupMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;
