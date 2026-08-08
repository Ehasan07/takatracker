-- CreateEnum
CREATE TYPE "LoanDirection" AS ENUM ('LENT', 'BORROWED');

-- CreateEnum
CREATE TYPE "LoanInterestType" AS ENUM ('NONE', 'FIXED', 'PERCENT');

-- CreateEnum
CREATE TYPE "LoanStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'OVERDUE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK', 'MOBILE_WALLET', 'CHEQUE', 'CARD', 'OTHER');

-- CreateTable
CREATE TABLE "Loan" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "loanNumber" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "direction" "LoanDirection" NOT NULL,
    "principalMinor" BIGINT NOT NULL,
    "interestType" "LoanInterestType" NOT NULL DEFAULT 'NONE',
    "interestMinor" BIGINT NOT NULL DEFAULT 0,
    "interestRateBps" INTEGER NOT NULL DEFAULT 0,
    "loanDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3),
    "accountId" TEXT NOT NULL,
    "loanAccountId" TEXT NOT NULL,
    "transactionId" TEXT,
    "note" TEXT,
    "attachmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "LoanStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanPayment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "method" "PaymentMethod" NOT NULL DEFAULT 'CASH',
    "referenceNumber" TEXT,
    "note" TEXT,
    "attachmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "accountId" TEXT NOT NULL,
    "transactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Loan_loanAccountId_key" ON "Loan"("loanAccountId");

-- CreateIndex
CREATE INDEX "Loan_workspaceId_status_idx" ON "Loan"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Loan_workspaceId_direction_status_idx" ON "Loan"("workspaceId", "direction", "status");

-- CreateIndex
CREATE INDEX "Loan_workspaceId_personId_idx" ON "Loan"("workspaceId", "personId");

-- CreateIndex
CREATE INDEX "Loan_workspaceId_dueDate_idx" ON "Loan"("workspaceId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "Loan_workspaceId_loanNumber_key" ON "Loan"("workspaceId", "loanNumber");

-- CreateIndex
CREATE INDEX "LoanPayment_workspaceId_loanId_date_idx" ON "LoanPayment"("workspaceId", "loanId", "date");

-- CreateIndex
CREATE INDEX "LoanPayment_workspaceId_referenceNumber_idx" ON "LoanPayment"("workspaceId", "referenceNumber");

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_loanAccountId_fkey" FOREIGN KEY ("loanAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanPayment" ADD CONSTRAINT "LoanPayment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanPayment" ADD CONSTRAINT "LoanPayment_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanPayment" ADD CONSTRAINT "LoanPayment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
