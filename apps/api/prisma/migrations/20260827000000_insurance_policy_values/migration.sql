-- What the insurer says a policy is worth, and what is owed against it.
--
-- Transcribed from the policy portal and dated by "valuedOn"; nothing in the
-- ledger reads these. Zero is the honest default: a policy nobody has typed a
-- statement for has no cash value on file, which is not the same as being
-- worth nothing, and "valuedOn" being NULL is how the screen tells them apart.
ALTER TABLE "InsurancePolicy"
  ADD COLUMN "cashValueMinor" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "surrenderValueMinor" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "policyLoanMinor" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "aplMinor" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "loanLimitMinor" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "valuedOn" TIMESTAMP(3);
