-- CreateEnum
CREATE TYPE "FeatureKind" AS ENUM ('LIMIT', 'FLAG', 'QUOTA');

-- CreateEnum
CREATE TYPE "MeterPeriod" AS ENUM ('LIFETIME', 'MONTHLY', 'DAILY');

-- CreateEnum
CREATE TYPE "MailProvider" AS ENUM ('IMAP', 'GMAIL_OAUTH', 'OUTLOOK_OAUTH');

-- CreateEnum
CREATE TYPE "MailAccountStatus" AS ENUM ('ACTIVE', 'AUTH_FAILED', 'DISABLED');

-- CreateEnum
CREATE TYPE "MailFolder" AS ENUM ('INBOX', 'SENT', 'DRAFTS', 'ARCHIVE');

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "searchAliases" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "WorkspaceFeatureOverride" ADD COLUMN     "grantedByUserId" TEXT;

-- CreateTable
CREATE TABLE "Feature" (
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "labelBn" TEXT NOT NULL,
    "kind" "FeatureKind" NOT NULL,
    "unit" TEXT NOT NULL,
    "period" "MeterPeriod" NOT NULL DEFAULT 'LIFETIME',
    "category" TEXT NOT NULL DEFAULT 'core',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Feature_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "UsageMeter" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "value" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageMeter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailAccount" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" "MailProvider" NOT NULL,
    "email" TEXT NOT NULL,
    "secretCipher" TEXT NOT NULL,
    "secretIv" TEXT NOT NULL,
    "imapHost" TEXT,
    "imapPort" INTEGER,
    "status" "MailAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastError" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "syncSince" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "MailAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailMessage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "mailAccountId" TEXT NOT NULL,
    "folder" "MailFolder" NOT NULL,
    "externalId" TEXT NOT NULL,
    "fromAddress" TEXT,
    "toAddress" TEXT,
    "subject" TEXT,
    "snippet" TEXT,
    "body" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsGateway" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "senderId" TEXT,
    "secretCipher" TEXT NOT NULL,
    "secretIv" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SmsGateway_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UsageMeter_workspaceId_featureKey_idx" ON "UsageMeter"("workspaceId", "featureKey");

-- CreateIndex
CREATE UNIQUE INDEX "UsageMeter_workspaceId_featureKey_periodKey_key" ON "UsageMeter"("workspaceId", "featureKey", "periodKey");

-- CreateIndex
CREATE INDEX "MailAccount_workspaceId_status_idx" ON "MailAccount"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MailAccount_workspaceId_email_key" ON "MailAccount"("workspaceId", "email");

-- CreateIndex
CREATE INDEX "MailMessage_workspaceId_folder_receivedAt_idx" ON "MailMessage"("workspaceId", "folder", "receivedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "MailMessage_mailAccountId_folder_externalId_key" ON "MailMessage"("mailAccountId", "folder", "externalId");

-- CreateIndex
CREATE INDEX "SmsGateway_workspaceId_isActive_idx" ON "SmsGateway"("workspaceId", "isActive");

-- AddForeignKey
ALTER TABLE "UsageMeter" ADD CONSTRAINT "UsageMeter_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageMeter" ADD CONSTRAINT "UsageMeter_featureKey_fkey" FOREIGN KEY ("featureKey") REFERENCES "Feature"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanFeature" ADD CONSTRAINT "PlanFeature_featureKey_fkey" FOREIGN KEY ("featureKey") REFERENCES "Feature"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceFeatureOverride" ADD CONSTRAINT "WorkspaceFeatureOverride_featureKey_fkey" FOREIGN KEY ("featureKey") REFERENCES "Feature"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailAccount" ADD CONSTRAINT "MailAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailMessage" ADD CONSTRAINT "MailMessage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailMessage" ADD CONSTRAINT "MailMessage_mailAccountId_fkey" FOREIGN KEY ("mailAccountId") REFERENCES "MailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmsGateway" ADD CONSTRAINT "SmsGateway_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
