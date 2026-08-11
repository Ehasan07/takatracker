-- A workspace's own corrections to the interface's wording.
--
-- The shipped English is a starting point, not an authority: it was written
-- without knowing what a given household calls things, and a family that says
-- "shopping" where we wrote "groceries" should be able to say so and have their
-- app agree. So every visible string has a key, and this table holds the value
-- a workspace has decided that key should read.
--
-- Sparse by design. A workspace with no corrections has no rows, which is the
-- overwhelming majority — so the whole override set for a tenant is a handful
-- of rows fetched once, not a second copy of the catalogue.
CREATE TABLE "WorkspaceTranslation" (
    "id"          TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    -- 'bn' or 'en'. A correction is per language: fixing the English must not
    -- silently rewrite the Bengali the same key renders in.
    "locale"      TEXT NOT NULL,
    "key"         TEXT NOT NULL,
    "value"       TEXT NOT NULL,
    "updatedByUserId" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceTranslation_pkey" PRIMARY KEY ("id")
);

-- One value per key per language per workspace. The upsert path depends on it.
CREATE UNIQUE INDEX "WorkspaceTranslation_workspaceId_locale_key_key"
    ON "WorkspaceTranslation"("workspaceId", "locale", "key");

-- The only read shape there is: everything this workspace has changed, in one
-- language, fetched once when the app boots.
CREATE INDEX "WorkspaceTranslation_workspaceId_locale_idx"
    ON "WorkspaceTranslation"("workspaceId", "locale");

ALTER TABLE "WorkspaceTranslation" ADD CONSTRAINT "WorkspaceTranslation_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
