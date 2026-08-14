-- A person is identified by their number or their address, not by their name.
--
-- Two people called করিম are two people. One number is one person. Until now a
-- group member was created by name alone, so adding করিম to a trip made a second
-- করিম beside the one who had borrowed money last year — two rows, two
-- balances, and no screen that showed the ৳7,000 he actually owed.

ALTER TABLE "Person" ADD COLUMN "phoneKey" TEXT;
ALTER TABLE "Person" ADD COLUMN "email" TEXT;

-- Backfill from the numbers already on file.
--
-- Digits only, then reduced to the `01XXXXXXXXX` form, so +8801712345678,
-- 8801712345678, 01712-345678 and 1712345678 collide as they should. Anything
-- that is not a recognisable Bangladeshi mobile is left null rather than
-- guessed at: a landline or a half-typed number must not claim to identify
-- somebody, and a wrong match is worse than no match.
UPDATE "Person"
SET "phoneKey" = '01' || right(regexp_replace(phone, '\D', '', 'g'), 9)
WHERE phone IS NOT NULL
  AND right(regexp_replace(phone, '\D', '', 'g'), 10) ~ '^1[3-9][0-9]{8}$';

-- Where two rows turn out to be the same number, the older one keeps the key
-- and the newer is left null, so the index below can be created.
--
-- Nothing is deleted and nothing is merged. Deciding that two rows are one
-- person is the owner's call, the People screen already has a merge that moves
-- the loans across, and a migration that quietly joined two ledgers would be
-- the worst possible place to make that decision.
UPDATE "Person" p
SET "phoneKey" = NULL
WHERE p."phoneKey" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "Person" q
    WHERE q."workspaceId" = p."workspaceId"
      AND q."phoneKey" = p."phoneKey"
      AND q."createdAt" < p."createdAt"
  );

-- Partial by nature: most people in a household ledger have no number at all,
-- and Postgres lets any number of nulls sit under a unique index.
CREATE UNIQUE INDEX "Person_workspaceId_phoneKey_key" ON "Person"("workspaceId", "phoneKey");
CREATE UNIQUE INDEX "Person_workspaceId_email_key" ON "Person"("workspaceId", "email");

-- A whole trip or event as a shared statement: what it cost, and who carried
-- what share. Reuses the statement-share machinery rather than growing a second
-- kind of public link — expiry, revocation, view counts and the one-sentence
-- 404 all come with it.
ALTER TYPE "StatementKind" ADD VALUE IF NOT EXISTS 'GROUP';
