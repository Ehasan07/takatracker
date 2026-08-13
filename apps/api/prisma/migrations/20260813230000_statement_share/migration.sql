-- A statement somebody outside the app can open.
--
-- The case is ordinary and the product could not do it: you have lent money to
-- a relative, or you pay a premium to an insurer, and they ask for the account.
-- The only answer was a screenshot, or reading figures down the phone.
--
-- ## The window lives here, not in the URL
--
-- `from`/`to` are columns rather than query parameters because the person
-- holding the link must not be able to widen it. A link to March cannot be
-- edited into a link to everything; there is nothing in the URL to edit.
--
-- ## Only the hash of the token
--
-- Exactly as `RefreshToken` and `EmailToken` do it. A leaked database backup
-- must not hand somebody a working statement link. The plaintext exists once,
-- in the response that creates it — losing it means revoking and making
-- another, which is a feature rather than an inconvenience.
--
-- ## Why the counters
--
-- There is no login on the far side; the link *is* the credential. So the owner
-- is shown what happened to it — how many times it has been opened and when it
-- was last opened. A link sent to one person and read forty times is a fact
-- they should be able to notice.
CREATE TYPE "StatementKind" AS ENUM ('PERSON', 'LOAN', 'SAVINGS', 'INSURANCE');

CREATE TABLE "StatementShare" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" "StatementKind" NOT NULL,
    "subjectId" TEXT NOT NULL,
    -- Null means the whole life of the subject.
    "fromDate" DATE,
    "toDate" DATE,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "lastViewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatementShare_pkey" PRIMARY KEY ("id")
);

-- The public route's only lookup, and it must be exact.
CREATE UNIQUE INDEX "StatementShare_tokenHash_key" ON "StatementShare"("tokenHash");

-- The owner's list, newest first, per subject.
CREATE INDEX "StatementShare_workspaceId_kind_subjectId_idx"
    ON "StatementShare"("workspaceId", "kind", "subjectId");

-- Sweeping expired rows.
CREATE INDEX "StatementShare_expiresAt_idx" ON "StatementShare"("expiresAt");

ALTER TABLE "StatementShare" ADD CONSTRAINT "StatementShare_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The link outlives the person who made it: a share must not disappear because
-- a colleague's account was removed, and must not block that removal either.
ALTER TABLE "StatementShare" ADD CONSTRAINT "StatementShare_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
