-- Letting a model propose the category and the account.
--
-- A regular expression can find an amount in a bank alert. It can never know
-- that "স্বপ্ন" is groceries or that "UCBL ATM" is a cash withdrawal, because
-- that is knowledge about the world rather than about the string. A model has
-- it, so the draft can arrive filled in rather than half empty.
--
-- Two columns, and both exist to keep the person in charge:
--
--   `TransactionDraft.suggestedBy` records which model proposed the fields, so
--   the review screen can say which of the values in front of somebody were
--   read from their bank and which were guessed. A suggestion presented as a
--   reading is how people stop checking.
--
--   `Workspace.aiSuggestEnabled` is off by default. Turning it on sends that
--   workspace's messages to a third party, which is a decision for the person
--   whose messages they are and not a default they find out about afterwards.
ALTER TABLE "TransactionDraft" ADD COLUMN IF NOT EXISTS "suggestedBy" TEXT;
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "aiSuggestEnabled" BOOLEAN NOT NULL DEFAULT false;
