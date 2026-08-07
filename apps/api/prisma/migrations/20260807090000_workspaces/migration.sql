-- M23 — multi-tenancy.
--
-- Tenant scoping moves from `userId` to `workspaceId`. Written by hand rather
-- than generated, because the new columns are NOT NULL and existing rows must
-- be backfilled before the constraints go on. Order matters throughout:
--   create tenancy tables → backfill one workspace per user → add nullable
--   columns → fill them → tighten to NOT NULL → swap keys and indexes.

-- ---------------------------------------------------------------------------
-- 1. Tenancy tables
-- ---------------------------------------------------------------------------

CREATE TYPE "WorkspaceStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED');
CREATE TYPE "MembershipRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

CREATE TABLE "Workspace" (
    "id"          TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "planId"      TEXT,
    "status"      "WorkspaceStatus" NOT NULL DEFAULT 'ACTIVE',
    "currency"    TEXT NOT NULL DEFAULT 'BDT',
    "timezone"    TEXT NOT NULL DEFAULT 'Asia/Dhaka',
    "trialEndsAt" TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    "deletedAt"   TIMESTAMP(3),
    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Membership" (
    "id"          TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "role"        "MembershipRole" NOT NULL DEFAULT 'OWNER',
    "invitedBy"   TEXT,
    "status"      "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "joinedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Invitation" (
    "id"          TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email"       TEXT NOT NULL,
    "role"        "MembershipRole" NOT NULL DEFAULT 'MEMBER',
    "tokenHash"   TEXT NOT NULL,
    "invitedBy"   TEXT,
    "expiresAt"   TIMESTAMP(3) NOT NULL,
    "acceptedAt"  TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Workspace_ownerUserId_idx" ON "Workspace"("ownerUserId");
CREATE INDEX "Workspace_status_idx" ON "Workspace"("status");
CREATE UNIQUE INDEX "Membership_workspaceId_userId_key" ON "Membership"("workspaceId", "userId");
CREATE INDEX "Membership_userId_status_idx" ON "Membership"("userId", "status");
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");
CREATE INDEX "Invitation_workspaceId_email_idx" ON "Invitation"("workspaceId", "email");
CREATE INDEX "Invitation_expiresAt_idx" ON "Invitation"("expiresAt");

ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_invitedBy_fkey"
    FOREIGN KEY ("invitedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Backfill: one workspace per existing user, owned by them
--    Currency and timezone move off the user and onto their workspace.
-- ---------------------------------------------------------------------------

INSERT INTO "Workspace" ("id", "name", "ownerUserId", "currency", "timezone", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    u."name",
    u."id",
    u."baseCurrency",
    u."timezone",
    u."createdAt",
    CURRENT_TIMESTAMP
FROM "User" u;

INSERT INTO "Membership" ("id", "workspaceId", "userId", "role", "status", "joinedAt")
SELECT gen_random_uuid()::text, w."id", w."ownerUserId", 'OWNER', 'ACTIVE', w."createdAt"
FROM "Workspace" w;

-- ---------------------------------------------------------------------------
-- 3. User loses currency; `timezone` becomes a personal notification setting
-- ---------------------------------------------------------------------------

ALTER TABLE "User" RENAME COLUMN "timezone" TO "notifyTimezone";
ALTER TABLE "User" DROP COLUMN "baseCurrency";

-- ---------------------------------------------------------------------------
-- 4. Tenant-scoped tables gain workspaceId, backfilled through the owner
-- ---------------------------------------------------------------------------

ALTER TABLE "Account"     ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "Category"    ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "Person"      ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "LedgerEntry" ADD COLUMN "workspaceId" TEXT;

UPDATE "Account" a
   SET "workspaceId" = w."id"
  FROM "Workspace" w
 WHERE w."ownerUserId" = a."userId";

UPDATE "Category" c
   SET "workspaceId" = w."id"
  FROM "Workspace" w
 WHERE w."ownerUserId" = c."userId";

UPDATE "Person" p
   SET "workspaceId" = w."id"
  FROM "Workspace" w
 WHERE w."ownerUserId" = p."userId";

UPDATE "Transaction" t
   SET "workspaceId" = w."id"
  FROM "Workspace" w
 WHERE w."ownerUserId" = t."userId";

-- Entries inherit from their transaction; that is the invariant the trigger
-- below then enforces for every future write.
UPDATE "LedgerEntry" e
   SET "workspaceId" = t."workspaceId"
  FROM "Transaction" t
 WHERE t."id" = e."transactionId";

-- Refuse to proceed if anything failed to map, rather than silently orphaning
-- a customer's data behind a NOT NULL failure further down.
DO $$
DECLARE
  orphans INT;
BEGIN
  SELECT
    (SELECT COUNT(*) FROM "Account"     WHERE "workspaceId" IS NULL) +
    (SELECT COUNT(*) FROM "Category"    WHERE "workspaceId" IS NULL) +
    (SELECT COUNT(*) FROM "Person"      WHERE "workspaceId" IS NULL) +
    (SELECT COUNT(*) FROM "Transaction" WHERE "workspaceId" IS NULL) +
    (SELECT COUNT(*) FROM "LedgerEntry" WHERE "workspaceId" IS NULL)
  INTO orphans;

  IF orphans > 0 THEN
    RAISE EXCEPTION 'Backfill left % row(s) without a workspace; aborting', orphans;
  END IF;
END $$;

-- The balance trigger on LedgerEntry is DEFERRABLE INITIALLY DEFERRED, so the
-- UPDATE above leaves pending trigger events and Postgres then refuses to
-- ALTER the table. Force them to fire now.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE "Account"     ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "Category"    ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "Person"      ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "Transaction" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "LedgerEntry" ALTER COLUMN "workspaceId" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. Swap the old userId keys, indexes and constraints for workspace ones
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS "Account_userId_systemKey_key";
DROP INDEX IF EXISTS "Account_userId_isArchived_sortOrder_idx";
DROP INDEX IF EXISTS "Category_userId_kind_sortOrder_idx";
DROP INDEX IF EXISTS "Person_userId_idx";
DROP INDEX IF EXISTS "Transaction_userId_clientId_key";
DROP INDEX IF EXISTS "Transaction_userId_date_idx";
DROP INDEX IF EXISTS "Transaction_userId_type_idx";
DROP INDEX IF EXISTS "Transaction_userId_source_idx";
DROP INDEX IF EXISTS "Transaction_userId_externalRef_idx";
DROP INDEX IF EXISTS "LedgerEntry_accountId_idx";
DROP INDEX IF EXISTS "LedgerEntry_categoryId_idx";

ALTER TABLE "Account"     DROP CONSTRAINT IF EXISTS "Account_userId_fkey";
ALTER TABLE "Category"    DROP CONSTRAINT IF EXISTS "Category_userId_fkey";
ALTER TABLE "Person"      DROP CONSTRAINT IF EXISTS "Person_userId_fkey";
ALTER TABLE "Transaction" DROP CONSTRAINT IF EXISTS "Transaction_userId_fkey";

ALTER TABLE "Account"  DROP COLUMN "userId";
ALTER TABLE "Category" DROP COLUMN "userId";
ALTER TABLE "Person"   DROP COLUMN "userId";

-- The transaction keeps its author, which is a different fact from its tenant.
ALTER TABLE "Transaction" RENAME COLUMN "userId" TO "createdByUserId";
ALTER TABLE "Transaction" ALTER COLUMN "createdByUserId" DROP NOT NULL;

CREATE UNIQUE INDEX "Account_workspaceId_systemKey_key" ON "Account"("workspaceId", "systemKey");
CREATE INDEX "Account_workspaceId_isArchived_sortOrder_idx" ON "Account"("workspaceId", "isArchived", "sortOrder");
CREATE INDEX "Category_workspaceId_kind_sortOrder_idx" ON "Category"("workspaceId", "kind", "sortOrder");
CREATE INDEX "Person_workspaceId_idx" ON "Person"("workspaceId");
CREATE UNIQUE INDEX "Transaction_workspaceId_clientId_key" ON "Transaction"("workspaceId", "clientId");
CREATE INDEX "Transaction_workspaceId_date_idx" ON "Transaction"("workspaceId", "date" DESC);
CREATE INDEX "Transaction_workspaceId_type_idx" ON "Transaction"("workspaceId", "type");
CREATE INDEX "Transaction_workspaceId_source_idx" ON "Transaction"("workspaceId", "source");
CREATE INDEX "Transaction_workspaceId_externalRef_idx" ON "Transaction"("workspaceId", "externalRef");
CREATE INDEX "LedgerEntry_workspaceId_accountId_idx" ON "LedgerEntry"("workspaceId", "accountId");
CREATE INDEX "LedgerEntry_workspaceId_categoryId_idx" ON "LedgerEntry"("workspaceId", "categoryId");

ALTER TABLE "Account" ADD CONSTRAINT "Account_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Category" ADD CONSTRAINT "Category_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Person" ADD CONSTRAINT "Person_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 6. Keep the denormalised column honest
--
-- `LedgerEntry.workspaceId` exists so balance aggregation avoids a join. That
-- speed is only safe if it can never disagree with its transaction, so the
-- database enforces the equality rather than trusting every future code path —
-- the same reasoning as the balance trigger.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION hishab_assert_entry_workspace_matches()
RETURNS TRIGGER AS $$
DECLARE
  txn_workspace TEXT;
BEGIN
  SELECT "workspaceId" INTO txn_workspace FROM "Transaction" WHERE "id" = NEW."transactionId";

  IF txn_workspace IS NULL THEN
    RAISE EXCEPTION 'Ledger entry % references a transaction that does not exist', NEW."id"
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF txn_workspace <> NEW."workspaceId" THEN
    RAISE EXCEPTION 'Ledger entry workspace % does not match its transaction workspace %',
      NEW."workspaceId", txn_workspace
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entry_workspace_matches
BEFORE INSERT OR UPDATE OF "workspaceId", "transactionId" ON "LedgerEntry"
FOR EACH ROW
EXECUTE FUNCTION hishab_assert_entry_workspace_matches();
