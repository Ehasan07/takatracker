-- CreateEnum
CREATE TYPE "TelegramMode" AS ENUM ('SHARED_BOT', 'OWN_BOT');

-- CreateEnum
CREATE TYPE "TelegramStatus" AS ENUM ('PENDING', 'ACTIVE', 'AUTH_FAILED', 'DISABLED', 'REVOKED');

-- CreateEnum
CREATE TYPE "CardMuteReason" AS ENUM ('MANUAL', 'PAID');

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "dueDayOfMonth" INTEGER,
ADD COLUMN     "reminderLeadDays" INTEGER,
ADD COLUMN     "statementDayOfMonth" INTEGER;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "autoMuteOnCardPayment" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "creditCardReminderLeadDays" INTEGER NOT NULL DEFAULT 7;

-- CreateTable
CREATE TABLE "TelegramConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" "TelegramMode" NOT NULL DEFAULT 'SHARED_BOT',
    "chatId" TEXT,
    "botTokenRef" TEXT,
    "botUsername" TEXT,
    "bindingTokenHash" TEXT,
    "bindingExpiresAt" TIMESTAMP(3),
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "status" "TelegramStatus" NOT NULL DEFAULT 'PENDING',
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "TelegramConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardReminderCycle" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "cycleMonth" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "mutedAt" TIMESTAMP(3),
    "mutedByUserId" TEXT,
    "mutedReason" "CardMuteReason",
    "lastSentOn" TEXT,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardReminderCycle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TelegramConnection_status_idx" ON "TelegramConnection"("status");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramConnection_workspaceId_userId_key" ON "TelegramConnection"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramConnection_bindingTokenHash_key" ON "TelegramConnection"("bindingTokenHash");

-- CreateIndex
CREATE INDEX "CardReminderCycle_workspaceId_cycleMonth_idx" ON "CardReminderCycle"("workspaceId", "cycleMonth");

-- CreateIndex
CREATE UNIQUE INDEX "CardReminderCycle_accountId_cycleMonth_key" ON "CardReminderCycle"("accountId", "cycleMonth");

-- AddForeignKey
ALTER TABLE "TelegramConnection" ADD CONSTRAINT "TelegramConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramConnection" ADD CONSTRAINT "TelegramConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardReminderCycle" ADD CONSTRAINT "CardReminderCycle_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardReminderCycle" ADD CONSTRAINT "CardReminderCycle_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
