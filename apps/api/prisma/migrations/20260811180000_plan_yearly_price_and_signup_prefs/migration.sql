-- A plan is a bundle of entitlements; how often it is billed is a property of
-- the subscription, not of the bundle. Rather than split PREMIUM into a monthly
-- row and a yearly row — which would double every plan, and make "is this
-- workspace on premium?" a two-value question in every entitlement check — the
-- yearly price sits beside the monthly one on the same plan.
--
-- Nullable: a plan with no yearly price is sold monthly only, which is what
-- FREE is (and free is free at any cadence).
ALTER TABLE "Plan" ADD COLUMN "priceYearlyMinor" BIGINT;

-- The currency a person picked when they signed up, so the choice survives a
-- session. `Workspace.currency` already existed and already defaults to BDT;
-- nothing here changes an existing row.
--
-- `User.locale` already exists too. What was missing is the workspace-level
-- copy: a locale belongs to the person, but the *categories* and the reports
-- are the workspace's, and a shared workspace has to render one way for
-- everybody rather than flickering between two members' preferences.
ALTER TABLE "Workspace" ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'bn';
