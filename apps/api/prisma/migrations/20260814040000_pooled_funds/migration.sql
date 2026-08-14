-- AlterTable
ALTER TABLE "SharedExpense" ADD COLUMN     "fromPot" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "SplitGroup" ADD COLUMN     "potAccountId" TEXT;

-- CreateTable
CREATE TABLE "SplitContribution" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "accountId" TEXT,
    "note" TEXT,
    "transactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SplitContribution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SplitContribution_workspaceId_groupId_date_idx" ON "SplitContribution"("workspaceId", "groupId", "date");

-- AddForeignKey
ALTER TABLE "SplitGroup" ADD CONSTRAINT "SplitGroup_potAccountId_fkey" FOREIGN KEY ("potAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SplitContribution" ADD CONSTRAINT "SplitContribution_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SplitContribution" ADD CONSTRAINT "SplitContribution_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "SplitGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SplitContribution" ADD CONSTRAINT "SplitContribution_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "SplitGroupMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SplitContribution" ADD CONSTRAINT "SplitContribution_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SplitContribution" ADD CONSTRAINT "SplitContribution_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
