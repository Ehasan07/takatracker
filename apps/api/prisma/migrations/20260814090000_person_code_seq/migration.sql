-- "What is the next code" has to be arithmetic, not a string sort.
--
-- `code` sorts as text, and text puts P-9999 above P-10000. Reading the highest
-- code off a descending string sort therefore handed out P-10000 a second time
-- once a workspace passed ten thousand people, and the duplicate bounced off the
-- unique index — a shop with a long supplier list would simply have stopped
-- being able to add one.
--
-- The integer is the sort key; the string stays what gets printed on a delivery
-- note.

ALTER TABLE "Person" ADD COLUMN "codeSeq" INTEGER;

UPDATE "Person"
SET "codeSeq" = NULLIF(regexp_replace("code", '\D', '', 'g'), '')::integer;

-- Anything whose code carried no digits (there should be none) is numbered
-- after everything that did, rather than left null and blocking the constraint.
WITH fallback AS (
  SELECT id,
         COALESCE((SELECT max("codeSeq") FROM "Person" q WHERE q."workspaceId" = p."workspaceId"), 0)
           + row_number() OVER (PARTITION BY p."workspaceId" ORDER BY p."createdAt", p.id) AS seq
  FROM "Person" p
  WHERE p."codeSeq" IS NULL
)
UPDATE "Person" p SET "codeSeq" = f.seq FROM fallback f WHERE f.id = p.id;

ALTER TABLE "Person" ALTER COLUMN "codeSeq" SET NOT NULL;

CREATE UNIQUE INDEX "Person_workspaceId_codeSeq_key" ON "Person"("workspaceId", "codeSeq");
