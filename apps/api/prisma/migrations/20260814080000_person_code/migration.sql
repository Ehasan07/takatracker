-- A handle you can say out loud.
--
-- A number identifies most people and a name identifies none of them, but some
-- have neither: two suppliers called "রফিক এন্টারপ্রাইজ" reachable on the same
-- shop phone are two accounts, and somebody has to be able to point at one of
-- them on a delivery note. `id` is a cuid nobody will read aloud; this is short,
-- ordered and printable.

ALTER TABLE "Person" ADD COLUMN "code" TEXT;

-- Numbered in the order they were created, per workspace, so the oldest
-- supplier is P-0001 in every workspace and nobody's code depends on anybody
-- else's data.
WITH ordered AS (
  SELECT id,
         'P-' || lpad(
           row_number() OVER (PARTITION BY "workspaceId" ORDER BY "createdAt", id)::text,
           4, '0'
         ) AS code
  FROM "Person"
)
UPDATE "Person" p SET "code" = o.code FROM ordered o WHERE o.id = p.id;

ALTER TABLE "Person" ALTER COLUMN "code" SET NOT NULL;

-- Unique per workspace, and never reused: a code already written into a paper
-- ledger must not come to mean somebody else.
CREATE UNIQUE INDEX "Person_workspaceId_code_key" ON "Person"("workspaceId", "code");
