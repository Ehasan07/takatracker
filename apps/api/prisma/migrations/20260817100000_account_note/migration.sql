-- A free-text note on an account.
--
-- The branch, the nominee, the cheque-book series, who else can sign on it.
-- `SavingsPlan.note` has carried the same thing since savings shipped and the
-- accounts screen had nowhere to put it, so the facts people actually needed to
-- keep were going into the account *name*.
--
-- Deliberately not a set of columns. Every structured version of this ends as a
-- form nobody fills in, and the one fact that mattered is never among the
-- fields somebody thought of in advance.

ALTER TABLE "Account" ADD COLUMN "note" TEXT;
