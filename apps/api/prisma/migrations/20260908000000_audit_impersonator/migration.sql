-- A support session may write, and the row it writes names the customer.
--
-- `actorUserId` stays the customer deliberately: the session authenticates as
-- their user and the write belongs in their books. This column is the only
-- record that an operator was holding the keyboard, so it is what makes the
-- write attributable at all. Nullable because every ordinary action has none.
ALTER TABLE "AuditEvent" ADD COLUMN "impersonatorUserId" TEXT;

-- SET NULL rather than CASCADE: deleting an operator's account must not delete
-- the trail of what they did in other people's workspaces.
ALTER TABLE "AuditEvent"
  ADD CONSTRAINT "AuditEvent_impersonatorUserId_fkey"
  FOREIGN KEY ("impersonatorUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- "What did this operator do, and where?" — asked across every tenant at once,
-- which none of the existing workspace-first indexes can answer.
CREATE INDEX "AuditEvent_impersonatorUserId_createdAt_idx"
  ON "AuditEvent" ("impersonatorUserId", "createdAt" DESC);
