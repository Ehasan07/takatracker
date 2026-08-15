-- What the bank will let a card carry.
--
-- Recorded so the app can answer "how much could I spend today", which is a
-- question about liquidity rather than about wealth. It is deliberately not an
-- asset: IAS 7.6 keeps cash to what is held, the Conceptual Framework asks for
-- a resource the entity controls, and an undrawn limit is neither — the bank
-- holds the money and may withdraw the facility. IAS 7.50(a) disclosure, not
-- recognition.
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "creditLimitMinor" BIGINT NOT NULL DEFAULT 0;
