-- CreateEnum
CREATE TYPE "SavingsPlanType" AS ENUM ('DPS', 'FDR', 'SANCHAYPATRA', 'RECURRING_DEPOSIT', 'GOAL_SAVINGS');

-- CreateEnum
CREATE TYPE "ProfitCalc" AS ENUM ('SIMPLE', 'COMPOUND_MONTHLY', 'COMPOUND_QUARTERLY', 'COMPOUND_YEARLY');

-- CreateEnum
CREATE TYPE "PlanFrequency" AS ENUM ('MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "SavingsStatus" AS ENUM ('ACTIVE', 'MATURED', 'CLOSED');

-- CreateEnum
CREATE TYPE "InstalmentStatus" AS ENUM ('DUE', 'PAID', 'MISSED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "PolicyStatus" AS ENUM ('ACTIVE', 'LAPSED', 'MATURED', 'CANCELLED');

-- CreateTable
CREATE TABLE "SavingsPlan" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "institution" TEXT,
    "planName" TEXT NOT NULL,
    "planType" "SavingsPlanType" NOT NULL DEFAULT 'DPS',
    "installmentMinor" BIGINT NOT NULL DEFAULT 0,
    "principalMinor" BIGINT NOT NULL DEFAULT 0,
    "frequency" "PlanFrequency" NOT NULL DEFAULT 'MONTHLY',
    "termMonths" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "maturityDate" TIMESTAMP(3),
    "profitRateBps" INTEGER NOT NULL DEFAULT 0,
    "profitCalc" "ProfitCalc" NOT NULL DEFAULT 'COMPOUND_YEARLY',
    "linkedAccountId" TEXT,
    "status" "SavingsStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SavingsPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavingsInstallment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "expectedMinor" BIGINT NOT NULL,
    "paidDate" TIMESTAMP(3),
    "transactionId" TEXT,
    "status" "InstalmentStatus" NOT NULL DEFAULT 'DUE',

    CONSTRAINT "SavingsInstallment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InsurancePolicy" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "insurer" TEXT NOT NULL,
    "policyNumberMasked" TEXT,
    "policyType" TEXT,
    "sumAssuredMinor" BIGINT NOT NULL DEFAULT 0,
    "premiumMinor" BIGINT NOT NULL DEFAULT 0,
    "frequency" "PlanFrequency" NOT NULL DEFAULT 'YEARLY',
    "startDate" TIMESTAMP(3) NOT NULL,
    "maturityDate" TIMESTAMP(3),
    "nomineeName" TEXT,
    "status" "PolicyStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "InsurancePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PremiumPayment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "paidDate" TIMESTAMP(3),
    "transactionId" TEXT,
    "status" "InstalmentStatus" NOT NULL DEFAULT 'DUE',

    CONSTRAINT "PremiumPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SavingsPlan_workspaceId_status_idx" ON "SavingsPlan"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "SavingsInstallment_workspaceId_status_dueDate_idx" ON "SavingsInstallment"("workspaceId", "status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "SavingsInstallment_planId_dueDate_key" ON "SavingsInstallment"("planId", "dueDate");

-- CreateIndex
CREATE INDEX "InsurancePolicy_workspaceId_status_idx" ON "InsurancePolicy"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "PremiumPayment_workspaceId_status_dueDate_idx" ON "PremiumPayment"("workspaceId", "status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "PremiumPayment_policyId_dueDate_key" ON "PremiumPayment"("policyId", "dueDate");

-- AddForeignKey
ALTER TABLE "SavingsPlan" ADD CONSTRAINT "SavingsPlan_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavingsInstallment" ADD CONSTRAINT "SavingsInstallment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavingsInstallment" ADD CONSTRAINT "SavingsInstallment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SavingsPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsurancePolicy" ADD CONSTRAINT "InsurancePolicy_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PremiumPayment" ADD CONSTRAINT "PremiumPayment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PremiumPayment" ADD CONSTRAINT "PremiumPayment_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "InsurancePolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
