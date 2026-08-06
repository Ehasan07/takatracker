-- Hard invariant (spec §3.2): per transaction, SUM(debits) = SUM(credits).
-- packages/core enforces it in application code; this enforces it in the
-- database, so no code path — import, sync, worker, psql — can write a
-- lopsided transaction.
--
-- The trigger is DEFERRABLE INITIALLY DEFERRED: it fires once at COMMIT, after
-- all of a transaction's entries have been inserted.

CREATE OR REPLACE FUNCTION hishab_assert_transaction_balanced()
RETURNS TRIGGER AS $$
DECLARE
  target_id TEXT;
  total_debit  BIGINT;
  total_credit BIGINT;
  entry_count  INT;
BEGIN
  target_id := COALESCE(NEW."transactionId", OLD."transactionId");

  SELECT
    COALESCE(SUM(CASE WHEN "direction" = 'DEBIT'  THEN "amountMinor" ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN "direction" = 'CREDIT' THEN "amountMinor" ELSE 0 END), 0),
    COUNT(*)
  INTO total_debit, total_credit, entry_count
  FROM "LedgerEntry"
  WHERE "transactionId" = target_id;

  -- Zero entries means the whole transaction was deleted; nothing to check.
  IF entry_count = 0 THEN
    RETURN NULL;
  END IF;

  IF entry_count < 2 THEN
    RAISE EXCEPTION 'Transaction % has % ledger entr(y/ies); a transaction needs at least two',
      target_id, entry_count
      USING ERRCODE = 'check_violation';
  END IF;

  IF total_debit <> total_credit THEN
    RAISE EXCEPTION 'Unbalanced transaction %: debits % <> credits % (difference % poisha)',
      target_id, total_debit, total_credit, total_debit - total_credit
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entry_balanced
AFTER INSERT OR UPDATE OR DELETE ON "LedgerEntry"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION hishab_assert_transaction_balanced();

-- Entry amounts are always positive; `direction` carries the sign.
ALTER TABLE "LedgerEntry"
  ADD CONSTRAINT "LedgerEntry_amountMinor_positive" CHECK ("amountMinor" > 0);
