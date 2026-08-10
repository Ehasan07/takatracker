-- ---------------------------------------------------------------------------
-- One control account per loan  ->  two control accounts per workspace
-- ---------------------------------------------------------------------------
--
-- WHY. `LoansService` used to create an Account for every loan — a RECEIVABLE
-- named `করিম — ধার #L-0001` when we lent, a PAYABLE when we borrowed. That is
-- not how a chart of accounts works: *Accounts receivable* is one account and
-- করিম is a row in its subsidiary ledger. Worse, `AccountsService.list` filters
-- only on `systemKey IS NULL`, so every one of those accounts appeared on the
-- user's wallet screen next to নগদ and BRAC Bank, and the screen's total added
-- a bank balance to a receivable — a number that means nothing.
--
-- After this migration each workspace has at most two loan control accounts,
-- SYSTEM_LOAN_RECEIVABLE (ঋণ পাওনা) and SYSTEM_LOAN_PAYABLE (ঋণ দেনা). The
-- `systemKey` keeps them off the wallet list and out of the plan's account
-- limit; `ReportsService.balanceSheet` stops filtering on `systemKey` in the
-- same change, so they still appear where they belong. What each person owes is
-- derived from `Loan` and `LoanPayment`, as it always was.
--
-- CONSERVATION. Nothing here creates, destroys, splits or re-signs a ledger
-- entry: entries are only moved from one account to another *inside the same
-- workspace*. Every assertion below is enforced at run time, not just asserted
-- in prose — Prisma runs this file in one transaction, so a RAISE rolls the
-- whole thing back and the deploy fails loudly instead of half-migrating.
--
--   * every account not touched by the move keeps its exact balance;
--   * each new control account ends at the sum of the per-loan accounts it
--     absorbed;
--   * each emptied per-loan account ends at zero;
--   * debits still equal credits, per workspace, before and after;
--   * every `Loan` ends up pointing at a control account in its own workspace
--     and on the side its `direction` says.
--
-- The standalone before/after query for running against a restored dump is at
-- the bottom of this file.

-- ---------------------------------------------------------------------------
-- 0. Remember the world as it was
-- ---------------------------------------------------------------------------

-- Plain temp tables, dropped explicitly at the end rather than ON COMMIT DROP:
-- this file has to behave the same whether Prisma runs it inside its
-- transaction or somebody applies it by hand in psql, where every statement
-- self-commits and ON COMMIT DROP would delete the table the moment it existed.
--
-- The per-loan control accounts, identified by the FK rather than by name:
-- `Loan.loanAccountId` is unique at this point, so this is exact and cannot
-- catch a receivable the user made by hand and happened to name the same way.
--
-- `systemKey IS NULL` is not decoration. If the new code is ever released
-- before this migration runs — a wrong deploy order, a rollback, a rerun — the
-- app will already have made a shared control account and pointed new loans at
-- it, and this join would then hand the *shared* account to step 4 to archive
-- and soft-delete, taking every loan in the workspace off the balance sheet.
-- A genuine per-loan account never has a systemKey.
DROP TABLE IF EXISTS _lc_old_control;
CREATE TEMP TABLE _lc_old_control AS
SELECT DISTINCT a.id, a."workspaceId", l.direction, a."openingBalance"
FROM "Account" a
JOIN "Loan" l ON l."loanAccountId" = a.id
WHERE a."systemKey" IS NULL;

-- Signed balance of every account in the database, over *all* entries: live and
-- soft-deleted alike, because repointing has to conserve both. Debits add,
-- credits subtract, whatever the type — the same convention as
-- `AccountsService.balances` and `signedEffect` in @hishab/core.
DROP TABLE IF EXISTS _lc_before;
CREATE TEMP TABLE _lc_before AS
SELECT a.id, a."workspaceId",
       a."openingBalance"
         + COALESCE(SUM(CASE WHEN e.direction = 'DEBIT' THEN e."amountMinor"
                             ELSE -e."amountMinor" END), 0) AS balance
FROM "Account" a
LEFT JOIN "LedgerEntry" e ON e."accountId" = a.id
GROUP BY a.id, a."workspaceId", a."openingBalance";

DROP TABLE IF EXISTS _lc_before_totals;
CREATE TEMP TABLE _lc_before_totals AS
SELECT e."workspaceId",
       SUM(CASE WHEN e.direction = 'DEBIT'  THEN e."amountMinor" ELSE 0 END) AS debits,
       SUM(CASE WHEN e.direction = 'CREDIT' THEN e."amountMinor" ELSE 0 END) AS credits,
       COUNT(*) AS entries
FROM "LedgerEntry" e
GROUP BY e."workspaceId";

-- A per-loan control account was always created with `openingBalance: 0n`. If
-- one is not zero, somebody edited it by hand and moving only the entries would
-- silently lose money — refuse rather than guess.
DO $$
DECLARE
  bad BIGINT;
BEGIN
  SELECT COUNT(*) INTO bad FROM _lc_old_control WHERE "openingBalance" <> 0;
  IF bad > 0 THEN
    RAISE EXCEPTION
      '% per-loan control account(s) carry a non-zero opening balance; migrate them by hand', bad;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Schema: `loanAccountId` stops being one-to-one
-- ---------------------------------------------------------------------------
--
-- Dropped before the data moves, not after: the moment two loans of the same
-- direction share a control account the unique index would reject the UPDATE.

DROP INDEX IF EXISTS "Loan_loanAccountId_key";
CREATE INDEX IF NOT EXISTS "Loan_workspaceId_loanAccountId_idx"
  ON "Loan"("workspaceId", "loanAccountId");

-- ---------------------------------------------------------------------------
-- 2. The two control accounts, per workspace that has ever had a loan
-- ---------------------------------------------------------------------------
--
-- Per direction and including soft-deleted loans: a deleted loan's entries are
-- still on the books and still have to land somewhere. A workspace that never
-- lent gets no receivable — `AccountsService.loanControlAccount` makes it on the
-- day it first does, and an unused ঋণ দেনা would otherwise print a ৳0 liability
-- on the balance sheet of somebody who has never borrowed.
--
-- ON CONFLICT DO NOTHING, so a workspace that already has one (see the deploy-
-- order note in step 0) keeps it rather than failing the migration.

INSERT INTO "Account"
  (id, "workspaceId", name, type, currency, "openingBalance", "matchHints",
   "isArchived", "sortOrder", "systemKey", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, w."workspaceId", 'ঋণ পাওনা', 'RECEIVABLE', 'BDT', 0,
       ARRAY[]::TEXT[], false, 900, 'SYSTEM_LOAN_RECEIVABLE', now(), now()
FROM (SELECT DISTINCT "workspaceId" FROM "Loan" WHERE direction = 'LENT') w
ON CONFLICT ("workspaceId", "systemKey") DO NOTHING;

INSERT INTO "Account"
  (id, "workspaceId", name, type, currency, "openingBalance", "matchHints",
   "isArchived", "sortOrder", "systemKey", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, w."workspaceId", 'ঋণ দেনা', 'PAYABLE', 'BDT', 0,
       ARRAY[]::TEXT[], false, 900, 'SYSTEM_LOAN_PAYABLE', now(), now()
FROM (SELECT DISTINCT "workspaceId" FROM "Loan" WHERE direction = 'BORROWED') w
ON CONFLICT ("workspaceId", "systemKey") DO NOTHING;

-- The loan -> control account map, resolved once and reused by both UPDATEs so
-- the entries and the `Loan` row cannot possibly be repointed differently.
DROP TABLE IF EXISTS _lc_map;
CREATE TEMP TABLE _lc_map AS
SELECT l.id            AS loan_id,
       l."workspaceId" AS workspace_id,
       l."loanAccountId" AS old_account_id,
       ctl.id          AS new_account_id
FROM "Loan" l
JOIN "Account" ctl
  ON ctl."workspaceId" = l."workspaceId"
 AND ctl."systemKey" = CASE l.direction
                         WHEN 'LENT' THEN 'SYSTEM_LOAN_RECEIVABLE'
                         ELSE 'SYSTEM_LOAN_PAYABLE'
                       END;

DO $$
DECLARE
  unmapped BIGINT;
BEGIN
  SELECT COUNT(*) INTO unmapped
  FROM "Loan" l WHERE NOT EXISTS (SELECT 1 FROM _lc_map m WHERE m.loan_id = l.id);
  IF unmapped > 0 THEN
    RAISE EXCEPTION 'No control account resolved for % loan(s); aborting', unmapped;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Move the entries, then the loans
-- ---------------------------------------------------------------------------
--
-- `workspaceId` is matched on both sides of the join. Repointing an entry into
-- another tenant's account is the one way this migration could do real harm,
-- and it is closed here and checked again in step 5.

UPDATE "LedgerEntry" e
   SET "accountId" = m.new_account_id
  FROM _lc_map m
 WHERE e."accountId"   = m.old_account_id
   AND e."workspaceId" = m.workspace_id;

UPDATE "Loan" l
   SET "loanAccountId" = m.new_account_id
  FROM _lc_map m
 WHERE l.id = m.loan_id
   AND l."loanAccountId" <> m.new_account_id;

-- The balance trigger on "LedgerEntry" is DEFERRABLE INITIALLY DEFERRED. Fire it
-- now, so an unbalanced transaction surfaces here rather than at COMMIT, after
-- the assertions below have already passed.
SET CONSTRAINTS ALL IMMEDIATE;

-- ---------------------------------------------------------------------------
-- 4. Retire the emptied per-loan accounts
-- ---------------------------------------------------------------------------
--
-- Archived *and* soft-deleted, never dropped: `Account.deletedAt` is how every
-- other account leaves the app, the rows are cheap, and an `AuditEvent` or an
-- old client payload naming one of these ids must still resolve to something.

UPDATE "Account" a
   SET "isArchived" = true,
       "deletedAt"  = COALESCE(a."deletedAt", now()),
       "updatedAt"  = now()
  FROM _lc_old_control o
 WHERE a.id = o.id;

-- ---------------------------------------------------------------------------
-- 5. Prove it was conservative
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  offender RECORD;
  n BIGINT;
BEGIN
  -- 5a. Debits still equal credits, per workspace, and no entry was created,
  --     destroyed or re-signed.
  FOR offender IN
    SELECT b."workspaceId", b.debits, b.credits, b.entries,
           a.debits AS a_debits, a.credits AS a_credits, a.entries AS a_entries
    FROM _lc_before_totals b
    FULL JOIN (
      SELECT e."workspaceId",
             SUM(CASE WHEN e.direction = 'DEBIT'  THEN e."amountMinor" ELSE 0 END) AS debits,
             SUM(CASE WHEN e.direction = 'CREDIT' THEN e."amountMinor" ELSE 0 END) AS credits,
             COUNT(*) AS entries
      FROM "LedgerEntry" e GROUP BY e."workspaceId"
    ) a ON a."workspaceId" = b."workspaceId"
    WHERE b.debits IS DISTINCT FROM a.debits
       OR b.credits IS DISTINCT FROM a.credits
       OR b.entries IS DISTINCT FROM a.entries
       OR a.debits IS DISTINCT FROM a.credits
  LOOP
    RAISE EXCEPTION
      'Workspace %: ledger totals moved (was %/% over % entries, now %/% over % entries)',
      offender."workspaceId", offender.debits, offender.credits, offender.entries,
      offender.a_debits, offender.a_credits, offender.a_entries;
  END LOOP;

  -- 5b. Every account that was not part of the move kept its exact balance. The
  --     two ends of the move are excluded here and checked exactly in 5c/5d:
  --     the per-loan accounts, which must now be empty, and the control
  --     accounts, which must now hold their sum.
  FOR offender IN
    SELECT b.id, b."workspaceId", b.balance AS was, n.balance AS now_is
    FROM _lc_before b
    JOIN (
      SELECT a.id,
             a."openingBalance"
               + COALESCE(SUM(CASE WHEN e.direction = 'DEBIT' THEN e."amountMinor"
                                   ELSE -e."amountMinor" END), 0) AS balance
      FROM "Account" a
      LEFT JOIN "LedgerEntry" e ON e."accountId" = a.id
      GROUP BY a.id, a."openingBalance"
    ) n ON n.id = b.id
    WHERE b.balance <> n.balance
      AND b.id NOT IN (SELECT id FROM _lc_old_control)
      AND b.id NOT IN (SELECT id FROM "Account"
                        WHERE "systemKey" IN ('SYSTEM_LOAN_RECEIVABLE', 'SYSTEM_LOAN_PAYABLE'))
  LOOP
    RAISE EXCEPTION 'Account % (workspace %) changed balance: % -> %',
      offender.id, offender."workspaceId", offender.was, offender.now_is;
  END LOOP;

  -- 5c. Every emptied per-loan account is at zero.
  SELECT COUNT(*) INTO n FROM (
    SELECT a.id
    FROM _lc_old_control o
    JOIN "Account" a ON a.id = o.id
    LEFT JOIN "LedgerEntry" e ON e."accountId" = a.id
    GROUP BY a.id, a."openingBalance"
    HAVING a."openingBalance"
           + COALESCE(SUM(CASE WHEN e.direction = 'DEBIT' THEN e."amountMinor"
                               ELSE -e."amountMinor" END), 0) <> 0
  ) still_holding;
  IF n > 0 THEN
    RAISE EXCEPTION '% retired per-loan control account(s) still hold a balance', n;
  END IF;

  -- 5d. Each control account holds exactly what it held before plus what the
  --     per-loan accounts on its side of the workspace held. The "before" term
  --     is zero for an account this migration just made, and carries the right
  --     opening figure for one the app had already made.
  FOR offender IN
    SELECT ctl.id, ctl."workspaceId", ctl."systemKey",
           ctl."openingBalance"
             + COALESCE(SUM(CASE WHEN e.direction = 'DEBIT' THEN e."amountMinor"
                                 ELSE -e."amountMinor" END), 0) AS now_is,
           COALESCE((SELECT b.balance FROM _lc_before b WHERE b.id = ctl.id), 0)
           + (SELECT COALESCE(SUM(b.balance), 0)
                FROM _lc_old_control o JOIN _lc_before b ON b.id = o.id
               WHERE o."workspaceId" = ctl."workspaceId"
                 AND (CASE o.direction WHEN 'LENT' THEN 'SYSTEM_LOAN_RECEIVABLE'
                                       ELSE 'SYSTEM_LOAN_PAYABLE' END) = ctl."systemKey"
             ) AS expected
    FROM "Account" ctl
    LEFT JOIN "LedgerEntry" e ON e."accountId" = ctl.id
    WHERE ctl."systemKey" IN ('SYSTEM_LOAN_RECEIVABLE', 'SYSTEM_LOAN_PAYABLE')
    GROUP BY ctl.id, ctl."workspaceId", ctl."systemKey", ctl."openingBalance"
  LOOP
    IF offender.now_is <> offender.expected THEN
      RAISE EXCEPTION 'Control account % (workspace %, %) holds % but absorbed %',
        offender.id, offender."workspaceId", offender."systemKey",
        offender.now_is, offender.expected;
    END IF;
  END LOOP;

  -- 5e. Every loan points at a control account in its own workspace, on the
  --     side its direction says, and no loan still points at a per-loan one.
  SELECT COUNT(*) INTO n
  FROM "Loan" l
  LEFT JOIN "Account" a ON a.id = l."loanAccountId"
  WHERE a.id IS NULL
     OR a."workspaceId" <> l."workspaceId"
     OR a."systemKey" IS DISTINCT FROM (CASE l.direction
                                          WHEN 'LENT' THEN 'SYSTEM_LOAN_RECEIVABLE'
                                          ELSE 'SYSTEM_LOAN_PAYABLE' END);
  IF n > 0 THEN
    RAISE EXCEPTION '% loan(s) point at the wrong control account', n;
  END IF;

  -- 5f. No ledger entry was left behind on a retired account.
  SELECT COUNT(*) INTO n
  FROM "LedgerEntry" e WHERE e."accountId" IN (SELECT id FROM _lc_old_control);
  IF n > 0 THEN
    RAISE EXCEPTION '% ledger entr(y/ies) still sit on a retired per-loan account', n;
  END IF;
END $$;

DROP TABLE IF EXISTS _lc_map;
DROP TABLE IF EXISTS _lc_before_totals;
DROP TABLE IF EXISTS _lc_before;
DROP TABLE IF EXISTS _lc_old_control;

-- ---------------------------------------------------------------------------
-- Verification to run by hand against a restored dump, before and after
-- ---------------------------------------------------------------------------
--
-- Run it on the copy, save both outputs, diff them. `balance` must be identical
-- for every account that is not a loan control account; the per-loan rows must
-- go to zero (and disappear from the wallet view); the two control rows must
-- appear holding their sum; `wallet_total` must lose the loan accounts and
-- `assets` / `liabilities` must not move at all.
--
--   -- signed balance per account, live entries only (what the app shows)
--   SELECT a."workspaceId", a.name, a.type, a."systemKey", a."isArchived",
--          a."deletedAt" IS NOT NULL AS deleted,
--          a."openingBalance" + COALESCE((
--            SELECT SUM(CASE WHEN e.direction = 'DEBIT' THEN e."amountMinor"
--                            ELSE -e."amountMinor" END)
--            FROM "LedgerEntry" e JOIN "Transaction" t ON t.id = e."transactionId"
--            WHERE e."accountId" = a.id AND t."deletedAt" IS NULL), 0) AS balance
--   FROM "Account" a ORDER BY a."workspaceId", a.type, a.name;
--
--   -- debits = credits, per workspace
--   SELECT e."workspaceId",
--          SUM(CASE WHEN e.direction = 'DEBIT'  THEN e."amountMinor" ELSE 0 END) AS debits,
--          SUM(CASE WHEN e.direction = 'CREDIT' THEN e."amountMinor" ELSE 0 END) AS credits
--   FROM "LedgerEntry" e GROUP BY 1 ORDER BY 1;
--
--   -- the wallet screen: rows listed and the total it prints
--   SELECT a."workspaceId", COUNT(*) AS rows_shown, SUM(a."openingBalance" + COALESCE((
--            SELECT SUM(CASE WHEN e.direction = 'DEBIT' THEN e."amountMinor"
--                            ELSE -e."amountMinor" END)
--            FROM "LedgerEntry" e JOIN "Transaction" t ON t.id = e."transactionId"
--            WHERE e."accountId" = a.id AND t."deletedAt" IS NULL), 0)) AS wallet_total
--   FROM "Account" a
--   WHERE a."systemKey" IS NULL AND a."deletedAt" IS NULL AND a."isArchived" = false
--   GROUP BY 1 ORDER BY 1;
--
--   -- the balance sheet, the way ReportsService builds it after this change
--   WITH bal AS (
--     SELECT a."workspaceId" AS ws, a.type, a."openingBalance" + COALESCE((
--              SELECT SUM(CASE WHEN e.direction = 'DEBIT' THEN e."amountMinor"
--                              ELSE -e."amountMinor" END)
--              FROM "LedgerEntry" e JOIN "Transaction" t ON t.id = e."transactionId"
--              WHERE e."accountId" = a.id AND t."deletedAt" IS NULL), 0) AS b
--     FROM "Account" a WHERE a."deletedAt" IS NULL AND a.type <> 'EQUITY')
--   SELECT ws,
--          SUM(CASE WHEN type IN ('CASH','BANK','MOBILE_WALLET','SAVINGS','RECEIVABLE','ASSET')
--                   THEN b ELSE 0 END) AS assets,
--          SUM(CASE WHEN type IN ('CREDIT_CARD','PAYABLE','LIABILITY')
--                   THEN -b ELSE 0 END) AS liabilities
--   FROM bal GROUP BY 1 ORDER BY 1;
