-- Income tax: a rate table, and a taxpayer.
--
-- The one thing to understand before changing anything here: every rate column
-- on "TaxRegime" is NULLABLE and the seeded rows at the bottom leave all of them
-- NULL. That is not an unfinished migration. It is the feature.
--
-- docs/RENEWALS-AND-TAX.md §3.5 states the rule and §3.7 states why the first
-- release must not compute a number: a tax figure computed on rates nobody
-- checked looks exactly like one computed on rates somebody did, and the person
-- carrying it to their practitioner cannot tell the two apart. So the row exists
-- (the app can name the year and say what it does not know), `verified` is
-- false, and packages/core/src/tax.ts refuses to produce a figure until a human
-- has transcribed the Finance Act and ticked the box.
--
-- The feasibility report deliberately states no rates — it says what the fields
-- are and where they come from, never what the numbers are. Nothing here was
-- filled in from memory.

CREATE TABLE IF NOT EXISTS "TaxRegime" (
    "id" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    -- Named as `fiscalYearOf` in @hishab/core names it: "2025-26".
    "fiscalYear" TEXT NOT NULL,
    -- TEXT, not TIMESTAMP. A fiscal year boundary is a date in law, and the same
    -- date everywhere; a timestamp would invite the off-by-one that buckets a
    -- 1 July salary into the previous year on a server in another timezone.
    "fiscalYearStart" TEXT NOT NULL,
    "fiscalYearEnd" TEXT NOT NULL,
    -- A correction writes version 2. It never edits version 1, because a
    -- worksheet printed last week has to stay explainable.
    "version" INTEGER NOT NULL DEFAULT 1,

    "slabs" JSONB,
    "thresholdByCategory" JSONB,
    "rebate" JSONB,
    "minimumTaxByArea" JSONB,
    "surchargeBands" JSONB,

    "sourceCitation" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    -- No foreign key on purpose: the provenance of a verified tax year outlives
    -- the account of whoever verified it.
    "verifiedByUserId" TEXT,
    "verifiedByName" TEXT,
    "verificationNote" TEXT,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TaxRegime_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TaxRegime_country_fiscalYear_version_key"
    ON "TaxRegime"("country", "fiscalYear", "version");
CREATE INDEX IF NOT EXISTS "TaxRegime_country_fiscalYear_verified_idx"
    ON "TaxRegime"("country", "fiscalYear", "verified");

-- Facts about the taxpayer that no transaction can supply: which threshold they
-- start on, and which minimum tax applies where they live.
CREATE TABLE IF NOT EXISTS "TaxProfile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'BD',
    "category" TEXT NOT NULL DEFAULT 'general',
    "area" TEXT NOT NULL DEFAULT 'elsewhere',
    "isRequiredToFile" BOOLEAN NOT NULL DEFAULT true,
    "tinMasked" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TaxProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TaxProfile_workspaceId_key"
    ON "TaxProfile"("workspaceId");

DO $$ BEGIN
    ALTER TABLE "TaxProfile" ADD CONSTRAINT "TaxProfile_workspaceId_fkey"
        FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Two Bangladeshi fiscal years, both unverified, every rate NULL.
--
-- 2025-26 is the year docs/RENEWALS-AND-TAX.md was written against; 2026-27 is
-- the year that is running as this migration lands. Both are here so the screen
-- can say "the rules for 2026-27 have not been confirmed yet" rather than "no
-- such year", which is a different and less useful sentence.
--
-- The July–June dates are arithmetic, not rates, so they are safe to state. The
-- slabs, thresholds, rebate caps, minimum tax and surcharge bands are not
-- stated anywhere in the feasibility report and are therefore NULL. Filling one
-- in from memory is the single failure mode this whole feature is shaped to
-- prevent.
--
-- To make a year usable: transcribe it from the gazette into version 2 of the
-- row, then set verified = true with verifiedAt, verifiedByUserId and
-- verifiedByName. Nothing computes until that has happened.
-- ---------------------------------------------------------------------------

INSERT INTO "TaxRegime" (
    "id", "country", "fiscalYear", "fiscalYearStart", "fiscalYearEnd", "version",
    "sourceCitation", "verified", "verificationNote", "updatedAt"
) VALUES (
    'taxregime_bd_2025_26_v1', 'BD', '2025-26', '2025-07-01', '2026-06-30', 1,
    'Finance Act 2025 — অনুলিখন বাকি',
    false,
    'করহার এখনো লেখা হয়নি। গেজেট দেখে স্ল্যাব, করমুক্ত সীমা, রেয়াতের সীমা, ন্যূনতম কর ও সারচার্জ বসিয়ে যাচাই করুন।',
    CURRENT_TIMESTAMP
), (
    'taxregime_bd_2026_27_v1', 'BD', '2026-27', '2026-07-01', '2027-06-30', 1,
    'Finance Act 2026 — অনুলিখন বাকি',
    false,
    'করহার এখনো লেখা হয়নি। গেজেট দেখে স্ল্যাব, করমুক্ত সীমা, রেয়াতের সীমা, ন্যূনতম কর ও সারচার্জ বসিয়ে যাচাই করুন।',
    CURRENT_TIMESTAMP
)
ON CONFLICT ("country", "fiscalYear", "version") DO NOTHING;
