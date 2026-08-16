-- ===========================================================================
-- Opening balances move into the ledger, and the column goes.
-- ===========================================================================
--
-- ## What was wrong
--
-- `Account.openingBalance` was a plain BIGINT that posted no ledger entry. It
-- was added straight into the balance map (`AccountsService.balances`) and into
-- the cash flow's opening figure (`ReportsService.cashFlow`), so a number
-- present in every total had no transaction, no audit entry and no line on the
-- account statement behind it. Worse, it carried **no date**: a balance sheet
-- dated last January showed the opening balance of an account opened in June,
-- so two periods were not comparable — IAS 1.38.
--
-- Meanwhile `OPENING_BALANCE` already existed as a transaction type that does
-- the same job properly, booking the account against the workspace's
-- SYSTEM_EQUITY account (`packages/core/src/ledger.ts`). Two mechanisms, one of
-- them outside the ledger. This migration keeps the one inside it.
--
-- ## What this does
--
--   1. Turns every non-zero `Account.openingBalance` into a dated
--      `OPENING_BALANCE` transaction with two balanced ledger entries.
--   2. Drops the column, so nothing can read it again.
--
-- Balances *today* are unchanged, by construction: the amount is the same, the
-- sign convention is the same (debits add, credits subtract, whatever the
-- account type — a ৳15,000 debt is −1,500,000 and becomes a credit on the
-- account), and it moves from one side of the sum to the other. What changes is
-- that the figure now belongs to a **day**, so a dated report can decide
-- whether it had happened yet. That is the entire point, and it is a real
-- change to historical reports: an account with an opening balance no longer
-- appears on a balance sheet dated before that day.
--
-- ## The date these get, and why
--
--   LEAST(Account."createdAt", the earliest live entry on the account)
--
-- `createdAt` is the only date the system holds about the account itself, and
-- it is the honest default. It is not enough on its own. This workspace
-- back-fills: accounts are created today and then loaded with history dated
-- months earlier (the Wallet import moved 9,625 records). Dating an opening
-- balance at `createdAt` there would put it *after* movements it is supposed to
-- precede, and every historical balance sheet would show a month of spending
-- with no money to spend it from — a new wrong answer in place of the old one.
--
-- An opening balance means "what was there before this ledger begins", so it
-- cannot be later than the ledger's first entry for that account. Both
-- candidates are dates the system actually knows; nothing is invented; and
-- taking the earlier of the two is the choice that leaves every sheet that
-- already balanced still balancing. On an account with no history, or one whose
-- history starts after it was created, the two collapse to `createdAt`.
--
-- Soft-deleted accounts are migrated too. Their column value is still a balance
-- the books contain, and the rule here is that no figure disappears; callers
-- that hide deleted accounts go on hiding them.
--
-- ## Idempotency
--
-- The production database is live (24 accounts). Both inserts are guarded by
-- NOT EXISTS against work already done, and the whole block is a no-op once the
-- column is gone, so running this file twice creates one transaction per
-- account and not two. The guard is keyed on `Transaction."externalRef" =
-- 'opening-balance:<accountId>'` rather than on "does this account have any
-- OPENING_BALANCE transaction". That distinction matters: somebody who typed an
-- opening balance at account creation *and* posted an OPENING_BALANCE
-- transaction by hand has two real figures, and skipping the column value
-- because a hand-made one exists would quietly delete money from their books.
-- `AccountsService` writes the same `externalRef`, so the app and this file
-- agree on which transaction is the account's own opening balance.
--
-- `apps/api/test/opening-balance.e2e-spec.ts` executes the block below twice
-- against a seeded legacy row and asserts exactly one transaction results.
--
-- ## Verifying against the live database before and after
--
--   -- Net worth per workspace must be identical either side of this migration.
--   -- Before:
--   SELECT a."workspaceId",
--          SUM(a."openingBalance" + COALESCE((
--            SELECT SUM(CASE WHEN le.direction = 'DEBIT' THEN le."amountMinor"
--                            ELSE -le."amountMinor" END)
--            FROM "LedgerEntry" le
--            JOIN "Transaction" t ON t.id = le."transactionId"
--            WHERE le."accountId" = a.id AND t."deletedAt" IS NULL), 0)) AS total
--   FROM "Account" a WHERE a."deletedAt" IS NULL GROUP BY 1 ORDER BY 1;
--   -- After: the same query with the `a."openingBalance" +` term removed.

-- >>> BACKFILL BEGIN (the test slices the file on these two markers)
DO $opening_balance_to_ledger$
DECLARE
  stranded BIGINT;
  moved    BIGINT;
BEGIN
  /* Already migrated. plpgsql plans a statement the first time it runs it, so
     the references to the dropped column further down never have to resolve on
     this path — which is what makes the file re-runnable. */
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'Account'
      AND column_name = 'openingBalance'
  ) THEN
    RAISE NOTICE 'Account."openingBalance" is already gone; nothing to move.';
    RETURN;
  END IF;

  /* Every opening balance needs its workspace's equity account to post the
     other leg against. One is created for every workspace at signup, so this
     should be zero — but if it is not, the alternative to stopping is dropping
     somebody's balance on the floor. */
  SELECT COUNT(*) INTO stranded
  FROM "Account" a
  WHERE a."openingBalance" <> 0
    AND NOT EXISTS (
      SELECT 1 FROM "Account" eq
      WHERE eq."workspaceId" = a."workspaceId"
        AND eq."systemKey" = 'SYSTEM_EQUITY'
    );
  IF stranded > 0 THEN
    RAISE EXCEPTION
      '% account(s) carry an opening balance in a workspace with no SYSTEM_EQUITY account to post it against; refusing to lose the balance',
      stranded USING ERRCODE = 'data_exception';
  END IF;

  -- 1. The transaction. One per account, found again by its externalRef.
  INSERT INTO "Transaction"
    (id, "workspaceId", date, type, description, source, "externalRef",
     "attachmentIds", "createdAt", "updatedAt")
  SELECT
    gen_random_uuid()::text,
    a."workspaceId",
    LEAST(a."createdAt", COALESCE(first_entry.first_date, a."createdAt")),
    'OPENING_BALANCE',
    -- Bengali: what the user sees in their own transaction list.
    'প্রারম্ভিক জের',
    'MANUAL',
    'opening-balance:' || a.id,
    ARRAY[]::TEXT[],
    now(),
    now()
  FROM "Account" a
  LEFT JOIN LATERAL (
    SELECT MIN(t.date) AS first_date
    FROM "LedgerEntry" le
    JOIN "Transaction" t ON t.id = le."transactionId"
    WHERE le."accountId" = a.id
      AND t."deletedAt" IS NULL
  ) first_entry ON TRUE
  WHERE a."openingBalance" <> 0
    AND NOT EXISTS (
      SELECT 1 FROM "Transaction" prior
      WHERE prior."externalRef" = 'opening-balance:' || a.id
    );

  GET DIAGNOSTICS moved = ROW_COUNT;

  /* 2. The two legs. A separate statement because `ledger_entry_workspace_matches`
        is a BEFORE INSERT trigger that looks the transaction up, so the
        transaction has to be on disk first. The balance trigger is deferred to
        COMMIT, so the moment between the two legs is not a violation.

        Guarded on the transaction having no entries yet rather than on the
        column, so a run interrupted between the two statements heals itself. */
  INSERT INTO "LedgerEntry"
    (id, "workspaceId", "transactionId", "accountId", "amountMinor", direction,
     currency, "fxRate")
  SELECT
    gen_random_uuid()::text,
    t."workspaceId",
    t.id,
    CASE WHEN leg.own THEN a.id ELSE eq.id END,
    abs(a."openingBalance"),
    /* Positive means the account gains value: debit the account, credit equity.
       Negative — a debt carried in — is the mirror. Identical to
       `expandSimpleTransaction`'s OPENING_BALANCE case in packages/core. */
    (CASE
       WHEN leg.own = (a."openingBalance" > 0) THEN 'DEBIT'
       ELSE 'CREDIT'
     END)::"EntryDirection",
    /* The account's own currency, as `expandSimpleTransaction` does — nothing
       reads it for arithmetic, and calling a USD account's opening balance BDT
       would be a second wrong answer. */
    a.currency,
    1
  FROM "Transaction" t
  JOIN "Account" a ON t."externalRef" = 'opening-balance:' || a.id
  JOIN "Account" eq
    ON eq."workspaceId" = a."workspaceId"
   AND eq."systemKey" = 'SYSTEM_EQUITY'
  CROSS JOIN (VALUES (true), (false)) AS leg(own)
  WHERE a."openingBalance" <> 0
    AND NOT EXISTS (
      SELECT 1 FROM "LedgerEntry" le WHERE le."transactionId" = t.id
    );

  RAISE NOTICE 'Moved % opening balance(s) into the ledger.', moved;
END
$opening_balance_to_ledger$;
-- <<< BACKFILL END

-- The column, now that every value in it is a transaction. `IF EXISTS` keeps
-- the file re-runnable end to end.
ALTER TABLE "Account" DROP COLUMN IF EXISTS "openingBalance";
