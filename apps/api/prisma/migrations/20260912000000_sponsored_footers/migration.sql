-- Sponsored footers on printed documents.
--
-- Two tables rather than columns on "Workspace": one campaign runs across
-- several shops, and a sponsor's phone number stored once is a sponsor's phone
-- number corrected once.

CREATE TABLE "AdCampaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "body" TEXT,
    "contactLine" TEXT,
    "linkUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdCampaign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdPlacement" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "note" TEXT,
    "grantedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdPlacement_pkey" PRIMARY KEY ("id")
);

-- "Stop every advert that is off" without walking the placements.
CREATE INDEX "AdCampaign_isActive_idx" ON "AdCampaign" ("isActive");

-- The read every printed document performs: what runs on this workspace today.
CREATE INDEX "AdPlacement_workspaceId_endsAt_idx" ON "AdPlacement" ("workspaceId", "endsAt");

-- Running the same advert twice on one document is a bug, not a louder advert.
CREATE UNIQUE INDEX "AdPlacement_campaignId_workspaceId_key"
  ON "AdPlacement" ("campaignId", "workspaceId");

-- CASCADE both ways. A deleted campaign takes its placements with it, and a
-- closed workspace has no documents left to print a footer on.
ALTER TABLE "AdPlacement"
  ADD CONSTRAINT "AdPlacement_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "AdCampaign"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AdPlacement"
  ADD CONSTRAINT "AdPlacement_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
