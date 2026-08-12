-- A six-digit code beside the link, and a cap on guessing it.
--
-- The link still works and still has its long window: it is opened from an
-- email client, often on a different device, sometimes hours later. The code is
-- for the person who is *already in the app* and would rather type six digits
-- than leave it — which, on a phone, is nearly everyone.
--
-- `codeHash` is not unique, unlike `tokenHash`. Six digits is a million values
-- and two people will collide; the lookup is therefore by (userId, purpose),
-- newest first, with the hash compared afterwards in constant time.
--
-- `attempts` is the part that makes six digits safe to use at all. A million
-- possibilities is a lot for a person and very little for a script, so a code
-- burns after five wrong guesses. Without that column this would be a downgrade
-- from the link, not an addition to it.
ALTER TABLE "EmailToken" ADD COLUMN "codeHash" TEXT;
ALTER TABLE "EmailToken" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;

-- The lookup the code path uses on every attempt.
CREATE INDEX "EmailToken_userId_purpose_createdAt_idx"
    ON "EmailToken"("userId", "purpose", "createdAt" DESC);
