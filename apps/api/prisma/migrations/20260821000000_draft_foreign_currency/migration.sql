-- A draft that can say the money was not in taka.
--
-- The bug this closes was measured on the owner's own inbox. Their bank sent:
--
--     USD 4.6 transacted at OPENAI *CHATGPT SUBSCR on 16/08/26 …
--       Available balance: USD 538.24. Helpline 16221.
--
-- and the review screen offered it in a box labelled "টাকার পরিমাণ (৳)" holding
-- 4.60. A ৳560 subscription about to be filed at ৳4.60 — a hundred and twentieth
-- of its size — with nothing anywhere on the screen saying dollars, and no way
-- for the person reading it to say so either. `TransactionDraft` had exactly one
-- column about money, `amountMinor`, and nothing at all about which money it was.
--
-- ## Why these two columns and not a rate
--
-- They are `Transaction.fxCurrency` and `Transaction.fxAmountMinor`, same names,
-- same meaning, same units. That is deliberate rather than lazy: accepting a
-- draft copies the pair straight onto the transaction, so "this money was in
-- another currency" has one shape in this database instead of a draft dialect
-- and a ledger dialect that somebody has to keep in step.
--
-- There is no rate column here for the same reason there is none on
-- `Transaction`. A rate is 121.50 — the one number in this schema that cannot be
-- an integer, and every integer in this schema exists so that no amount is ever
-- a float. Once the reviewer supplies the taka figure the rate is the ratio of
-- the two amounts, exact, derivable, and impossible to store wrongly.
--
-- ## What `amountMinor` means now
--
-- Unchanged: the workspace's own currency, always. What changes is that it is
-- left NULL when `fxCurrency` is set, because a message reading "USD 4.6" states
-- no taka figure and none can be derived from it. Nothing in this system knows
-- what the card issuer charged — that is not the mid-market rate on the day, it
-- is whatever the issuer applied plus whatever they added — and a draft that
-- guessed would be repeating the bug in a smaller font. The review screen asks,
-- and the accept endpoint refuses until it has been told.
--
-- ## The rows already in the table
--
-- Both columns arrive NULL, and no backfill runs. A backfill would mean the
-- parser, and the parser is JavaScript that this file cannot call; it would also
-- rewrite rows a person may already be halfway through reviewing. Instead the
-- service re-reads the stored message for any *pending* draft whose columns are
-- empty — the raw body is kept for exactly this kind of correction — so the
-- drafts sitting in the queue today start reading in dollars the moment they are
-- next looked at, without a single row being rewritten behind anyone's back.

ALTER TABLE "TransactionDraft" ADD COLUMN "fxCurrency" TEXT;
ALTER TABLE "TransactionDraft" ADD COLUMN "fxAmountMinor" BIGINT;

-- Both or neither, at the database rather than only in the service.
--
-- A currency with no amount says nothing; an amount with no currency is a number
-- whose units are unknown, which is worse than not recording it at all — it is
-- precisely the half-fact that produced ৳4.60. `transactionWriteSchema` already
-- enforces the same pairing for the ledger's own two columns in zod; this puts
-- it somewhere a bad migration or a future writer cannot step around.
ALTER TABLE "TransactionDraft"
  ADD CONSTRAINT "TransactionDraft_fx_pair_check"
  CHECK (("fxCurrency" IS NULL) = ("fxAmountMinor" IS NULL));
