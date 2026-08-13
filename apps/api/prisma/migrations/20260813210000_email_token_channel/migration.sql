-- Which way the code was actually sent.
--
-- A sign-in code can now go by email or by SMS, and the two are not
-- interchangeable to anybody: email is free and unlimited, an SMS costs money
-- per message and lands on a lock screen. "No more than three SMS" cannot be
-- counted without knowing which rows were SMS, and inferring it from anything
-- else would be guessing about money.
--
-- `EMAIL` for every row that already exists, because every code sent before
-- this went by email.
CREATE TYPE "TokenChannel" AS ENUM ('EMAIL', 'SMS');

ALTER TABLE "EmailToken" ADD COLUMN "channel" "TokenChannel" NOT NULL DEFAULT 'EMAIL';

-- The daily cap reads (user, channel, createdAt) and nothing else.
CREATE INDEX "EmailToken_userId_channel_createdAt_idx"
    ON "EmailToken"("userId", "channel", "createdAt");
