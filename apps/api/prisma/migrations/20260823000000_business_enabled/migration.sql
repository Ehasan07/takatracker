-- Whether this workspace keeps a personal business or trades shares.
-- Off for every existing workspace: the feature is opt-in, and a household
-- that never asked for a shop's books must not find them switched on.
ALTER TABLE "Workspace" ADD COLUMN "businessEnabled" BOOLEAN NOT NULL DEFAULT false;
