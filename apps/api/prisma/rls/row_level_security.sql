-- ---------------------------------------------------------------------------
-- Row-level security: the second wall.
--
-- NOT A MIGRATION YET, AND MUST NOT BECOME ONE UNTIL PART 0 IS DONE.
--
-- The SQL below is finished and was rehearsed end to end against a scratch
-- database: one workspace's session cannot read, write, update or delete
-- another's rows, and a session with no variable set reads zero rows rather
-- than everything. That part works and is not in doubt.
--
-- The verdict is about the other half — whether the application can bind the
-- variable safely on every request today — and the answer is no. Three things
-- were measured rather than assumed:
--
--   1. The API connects to Postgres as a SUPERUSER in both the dev compose file
--      and the production provisioner. Superusers bypass row security
--      unconditionally, FORCE included. Applied as-is, every policy here is
--      decoration.
--   2. A non-LOCAL `SET` through Prisma leaks exactly as feared: after one
--      `SET app.workspace_id`, 19 of the next 40 unrelated queries landed on a
--      pooled connection that was still bound to that workspace.
--   3. The `$extends` pattern from Prisma's own RLS documentation — wrap each
--      operation in its own `$transaction([set_config, query])` — silently
--      destroys atomicity. A write inside `$transaction(async tx => …)` that
--      then throws is COMMITTED, because the extension moved it into a
--      different database transaction. Rehearsed: the row survived the
--      rollback. There are 13 interactive transactions in this codebase and
--      they include every double-entry ledger write.
--
-- So this file is deliberately outside prisma/migrations/ where
-- `prisma migrate deploy` cannot reach it. Read PART 0 first: applying parts
-- 1–4 without part 0 either does nothing at all or takes the API down.
--
-- What this is for: the application is already correct. `workspaceId` is on
-- every tenant query, `LedgerEntry` carries a trigger asserting it matches its
-- transaction, and every module has a "another workspace's id returns 404"
-- test. This exists so that the day somebody writes `findMany({ where: {} })`
-- the database returns nothing instead of returning somebody else's ledger.
--
-- The mechanism, in one line: every tenant-scoped table gets a policy keyed on
-- a per-transaction session variable, `app.workspace_id`. No variable, no rows.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- PART 0 — PREREQUISITES. Do not skip these.
-- ---------------------------------------------------------------------------
--
-- 0.1  THE API MUST STOP CONNECTING AS A SUPERUSER.
--      `infra/docker-compose.yml` and `infra/deploy/10-provision.sh` both set
--      POSTGRES_USER to the application's own user, which makes it the
--      container's bootstrap superuser. A superuser bypasses row security
--      unconditionally — FORCE included, no policy consulted, no error. Applied
--      to the deployment as it stands today, everything below is inert and the
--      dashboard would show it as "RLS: enabled". That is the exact failure
--      mode this work is supposed to prevent, so it has to be fixed first.
--      Part 1 creates the roles that fix it.
--
-- 0.2  EVERY TENANT QUERY MUST RUN INSIDE A TRANSACTION THAT SETS THE VARIABLE.
--      `SET LOCAL` only holds inside a transaction. Prisma hands out a pooled
--      connection per query, so a plain `SET` outlives the request and the next
--      request on that connection inherits it — which is worse than no RLS,
--      because it silently binds the wrong tenant while looking like
--      protection. Measured, not assumed: 19 of 40.
--
--      The only unit of connection affinity Prisma offers is a transaction, and
--      the per-operation flavour of that is disqualified by the atomicity
--      finding above. What is left is one interactive transaction per request,
--      `set_config(..., true)` as its first statement, and every service method
--      for that request running on its `tx`. That is a change to every service
--      signature (or an AsyncLocalStorage that carries the `tx`), and it puts
--      an open transaction around the whole request — including the disk write
--      in attachments and the outbound HTTP in the Telegram client, which must
--      move outside it first or they will hold a connection open for the length
--      of a network timeout.
--
--      The alternative is a dedicated non-pooled connection per request
--      (`connection_limit=1` per client, or a `pg` pool with a checkout hook
--      that RESETs and re-binds). That buys back plain `SET` semantics and
--      keeps the services untouched, at the cost of a connection per in-flight
--      request and of leaving Prisma's pool behind for tenant traffic.
--
-- 0.3  THE PATHS THAT LEGITIMATELY HAVE NO WORKSPACE MUST HAVE A ROUTE THROUGH.
--      Rehearsed as hishab_app with nothing bound; all four return zero rows,
--      which means each of these features stops working the day this ships:
--        - signup            — creates the Workspace, and the WITH CHECK on
--                              "Workspace" requires app.workspace_id to already
--                              equal the cuid Prisma has not generated yet.
--        - login             — "which workspaces does this person belong to?"
--                              is a Membership read with no workspace in hand.
--        - invitation accept — the workspace is behind the token hash.
--        - telegram webhook  — arrives keyed by chat id, not by workspace.
--        - card-reminder sweep — hourly, every workspace at once, no request.
--        - the super-admin module — cross-tenant by design.
--      Part 3 gives them a credential rather than a loophole. The clean split is
--      that AuthModule, the two webhooks and the sweep get the privileged
--      client, and everything behind JwtAuthGuard gets the bound one.
--
--      What does NOT break, checked: JwtStrategy.validate (the token's `ws`
--      claim names the workspace before the membership query, so it can bind
--      first — and a token naming a workspace the user is not in correctly
--      returns nothing); the ingestion webhook's workspace lookup (bind from
--      the header once the HMAC has verified it); and the boot-time plan and
--      feature upsert, which only touches Plan / PlanFeature / Feature and gets
--      no policy at all.


-- ---------------------------------------------------------------------------
-- PART 1 — ROLES
--
-- Three, because the difference between them is a credential rather than a
-- runtime value. A bug cannot promote hishab_app into hishab_admin; it would
-- have to be handed a different connection string.
--
-- Passwords: generate with `openssl rand -base64 36` and write them into
-- /etc/hishab/hishab.env. They are placeholders here.
-- ---------------------------------------------------------------------------

-- Run as a superuser: BYPASSRLS can only be granted by one.

-- Owns every table. Runs `prisma migrate deploy`, `prisma db seed`, and the
-- boot-time plan/feature upsert. BYPASSRLS because the seed writes rows for
-- workspaces that do not exist yet and migrations rewrite every tenant's data
-- at once. This role must never be the one an HTTP request connects as.
CREATE ROLE hishab_migrator LOGIN PASSWORD 'REPLACE_ME' NOSUPERUSER BYPASSRLS;

-- What the API connects as for tenant traffic. Not the owner, no BYPASSRLS, so
-- policies apply to it with no exceptions. This is the role DATABASE_URL points
-- at.
CREATE ROLE hishab_app LOGIN PASSWORD 'REPLACE_ME' NOSUPERUSER NOBYPASSRLS;

-- The super-admin module, and only that module, over its own connection string
-- (ADMIN_DATABASE_URL) and its own PrismaClient. See PART 3 for why this is a
-- separate login rather than a sentinel value.
CREATE ROLE hishab_admin LOGIN PASSWORD 'REPLACE_ME' NOSUPERUSER BYPASSRLS;

-- Existing installs: the tables are currently owned by whatever role ran the
-- first migration. Move them, then move the database, so hishab_migrator is
-- genuinely the owner and hishab_app genuinely is not.
--   REASSIGN OWNED BY hishab TO hishab_migrator;
--   ALTER DATABASE hishab OWNER TO hishab_migrator;

GRANT USAGE ON SCHEMA public TO hishab_app, hishab_admin;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO hishab_app, hishab_admin;

-- So a later migration's new table is not silently unreadable by the API.
ALTER DEFAULT PRIVILEGES FOR ROLE hishab_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hishab_app, hishab_admin;

-- Nothing in this schema is SERIAL — every id is a cuid — but a future one
-- might be, and a missing sequence grant fails at insert time in production
-- rather than here.
ALTER DEFAULT PRIVILEGES FOR ROLE hishab_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO hishab_app;

-- Deliberately NOT granted to hishab_app: CREATE on schema public, TRUNCATE,
-- REFERENCES, and any DDL. A role that can `ALTER TABLE ... DISABLE ROW LEVEL
-- SECURITY` is not constrained by row-level security.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;


-- ---------------------------------------------------------------------------
-- PART 2 — THE SESSION VARIABLE
-- ---------------------------------------------------------------------------

-- One reader, so "unset" means exactly one thing in twenty-six policies.
--
-- `current_setting(..., true)` returns NULL rather than erroring when the
-- variable was never set; `nullif(..., '')` folds the empty string into the
-- same answer, because `set_config(..., '', true)` is what a well-meaning
-- `?? ''` in application code produces. Both end as `"workspaceId" = NULL`,
-- which is NULL, which is not true, which is zero rows. Unset is closed.
--
-- STABLE, not VOLATILE: the planner may then hoist it out of the scan and use
-- the existing `("workspaceId", ...)` indexes instead of re-evaluating per row.
-- PARALLEL SAFE for the same reason. Not SECURITY DEFINER — it reads a GUC and
-- touches no table, so there is nothing to elevate.
CREATE OR REPLACE FUNCTION app_current_workspace() RETURNS text
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('app.workspace_id', true), '')
$$;

COMMENT ON FUNCTION app_current_workspace() IS
  'The workspace the current transaction is bound to, or NULL. Set it with '
  'SELECT set_config(''app.workspace_id'', $1, true) as the first statement of '
  'a transaction — the third argument is is_local and it is not optional: '
  'without it the value survives on the pooled connection into the next '
  'request.';


-- ---------------------------------------------------------------------------
-- PART 3 — HOW THE SUPER ADMIN GETS OUT, AND WHY IT IS THIS WAY
--
-- Three options were on the table.
--
--   (a) A sentinel: policies also pass when app.workspace_id = '*'.
--       Rejected. The sentinel is reachable from the ordinary application role
--       through the ordinary mechanism — the same set_config call that binds a
--       tenant. Every bug that can produce the wrong workspace id can produce
--       the sentinel: a `user.workspaceId ?? '*'`, a template literal over an
--       undefined, a stray default in a helper. The failure is silent and it is
--       total. It also puts the bypass inside the SQL string, which is the one
--       place an injection can reach.
--
--   (b) SET ROLE to a BYPASSRLS role from the application connection.
--       Rejected. It requires hishab_app to be a member of the bypass role,
--       which means any code path — or any successful injection — running as
--       hishab_app can issue `SET ROLE` and turn tenancy off for itself. The
--       privilege is present on the connection at all times and only convention
--       keeps it unused.
--
--   (c) A separate login with BYPASSRLS, used by a second PrismaClient built
--       from ADMIN_DATABASE_URL, constructed inside AdminModule and exported
--       nowhere. CHOSEN.
--       The bypass is bound to a credential the tenant path does not hold. A
--       mistake in tenant code cannot reach it; it would have to import a
--       different client from a module that does not export one.
--
-- What (c) still costs, stated plainly rather than discovered later:
--   - The admin client sees everything, always. Nothing in the database
--     constrains it, so every cross-tenant read is only as careful as the admin
--     service is. Its queries should be as auditable as the code that writes
--     the audit log.
--   - A second connection pool. Size it small (connection_limit=2); it serves a
--     handful of operators, not traffic.
--   - Two secrets to rotate instead of one, and the admin secret is the more
--     dangerous. It belongs in /etc/hishab/hishab.env with the same 0600 the
--     JWT secrets get, and it must never appear in a container env that the web
--     app or a worker can read.
--   - `assertProductionEnv` in src/common/env.ts should treat ADMIN_DATABASE_URL
--     the way it treats DATABASE_URL: never a placeholder, and never equal to
--     DATABASE_URL — the two being the same string is the whole scheme quietly
--     collapsing back to option (b).
--
-- The migrations/seed/boot-upsert path uses hishab_migrator, which has the same
-- bypass for the same reason and is likewise not the runtime credential.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- PART 4 — POLICIES
--
-- One PERMISSIVE policy per table, FOR ALL, with a matching WITH CHECK.
--
--   USING       — filters what SELECT, UPDATE and DELETE can see. This is the
--                 half that turns a forgotten `where` into zero rows.
--   WITH CHECK  — validates the row INSERT and UPDATE leave behind. Without it
--                 a tenant could write a row stamped with somebody else's
--                 workspaceId, or re-parent one of its own rows out of its
--                 workspace and lose sight of it forever.
--
-- ENABLE turns policies on for everyone except the table owner and superusers.
-- FORCE removes the owner's exemption too, so the protection does not evaporate
-- the day someone points DATABASE_URL at hishab_migrator "just to debug it".
-- Superusers are still exempt and cannot be made otherwise — see 0.1.
--
-- Two things RLS does not cover, so nobody is surprised:
--   - Referential integrity bypasses row security by design, so a FK to a
--     Workspace or an Account still resolves. That is what keeps the schema
--     working, and it means a unique-constraint violation can still reveal that
--     *some* row with that key exists in another tenant. Every unique key here
--     is either workspace-scoped or a hash of a secret, so there is nothing to
--     enumerate.
--   - The `hishab_assert_entry_workspace_matches` and
--     `hishab_assert_transaction_balanced` triggers are plain plpgsql, not
--     SECURITY DEFINER, so their internal SELECTs run under the caller's
--     policies. Both only ever look at rows in the same workspace as the row
--     being written, so they see what they need. The balanced-entries trigger
--     is DEFERRABLE INITIALLY DEFERRED and fires at COMMIT — inside the
--     transaction, so `app.workspace_id` is still set when it runs. This is
--     rehearsed below; it is the reason the variable must be set with
--     is_local = true *inside* the transaction rather than before it.
-- ---------------------------------------------------------------------------

-- The tenant itself, keyed on its primary key rather than on a workspaceId
-- column. Note what this means for signup: creating a workspace requires
-- app.workspace_id to already equal the id being created, and Prisma generates
-- that cuid inside the query engine. Signup therefore cannot run as hishab_app.
-- See the report.
ALTER TABLE "Workspace" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Workspace" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Workspace" FOR ALL
  USING ("id" = app_current_workspace())
  WITH CHECK ("id" = app_current_workspace());

-- Everything else carries the column. Generated rather than hand-written so a
-- table cannot be forgotten: the DO block below covers the twenty-five tables
-- that have a workspaceId today and would cover a twenty-sixth added tomorrow.
-- The explicit list is kept alongside it as documentation of what is expected,
-- and the assertion at the end fails the migration if the two disagree.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND a.attname = 'workspaceId'
       AND NOT a.attisdropped
     ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL '
      '  USING ("workspaceId" = app_current_workspace()) '
      '  WITH CHECK ("workspaceId" = app_current_workspace())', t);
  END LOOP;
END
$$;

-- Expected, as of this schema:
--   Account, Attachment, AuditEvent, CardReminderCycle, Category, ImportBatch,
--   IngestionMessage, InsurancePolicy, Invitation, LedgerEntry, Loan,
--   LoanPayment, MailAccount, MailMessage, Membership, Person, PremiumPayment,
--   SavingsInstallment, SavingsPlan, SmsGateway, TelegramConnection,
--   Transaction, TransactionDraft, UsageMeter, WorkspaceFeatureOverride
--   ... plus Workspace itself = 26.
--
-- Deliberately NOT covered, because they are not tenant-scoped and RLS on them
-- would break login before the workspace is known:
--   User, RefreshToken, EmailToken  — a person, not a tenant. A missing `where`
--     on these leaks across *users*, which RLS as designed here does not
--     address. If that matters, it is a second variable (app.user_id) and a
--     second design, not an extra line in this one.
--   Feature, Plan, PlanFeature      — the price list. Global by definition, and
--     the boot-time upsert writes them before any request exists.
--   _prisma_migrations              — the migrator's own bookkeeping.

DO $$
DECLARE
  covered int;
BEGIN
  SELECT count(*) INTO covered
    FROM pg_policies
   WHERE schemaname = 'public' AND policyname = 'tenant_isolation';
  IF covered <> 26 THEN
    RAISE EXCEPTION
      'Expected 26 tenant_isolation policies, found %. A tenant-scoped table is '
      'either missing its workspaceId column or has been added since this was '
      'written — check before shipping.', covered;
  END IF;
END
$$;


-- ---------------------------------------------------------------------------
-- PART 5 — WHAT THE APPLICATION MUST DO ON EVERY REQUEST
--
-- Inside a transaction, as its first statement, parameterised:
--
--   BEGIN;
--   SELECT set_config('app.workspace_id', $1, true);   -- true = is_local
--   ... every query for this request ...
--   COMMIT;
--
-- `true` is the whole thing. With `false` — or with `SET app.workspace_id = …`
-- — the value stays on the connection after COMMIT and Prisma hands that same
-- connection to whoever asks next. The rehearsal demonstrates both halves of
-- that: LOCAL is gone after COMMIT, non-LOCAL is still there twenty queries
-- later on whichever pooled connection caught it.
--
-- `set_config` with a bind parameter, not string interpolation into `SET`,
-- because `SET` does not take parameters and the workspace id would have to be
-- concatenated into SQL.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- DO $$
-- DECLARE t text;
-- BEGIN
--   FOR t IN SELECT tablename FROM pg_policies
--             WHERE schemaname='public' AND policyname='tenant_isolation'
--   LOOP
--     EXECUTE format('DROP POLICY tenant_isolation ON %I', t);
--     EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t);
--     EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
--   END LOOP;
-- END $$;
-- DROP FUNCTION IF EXISTS app_current_workspace();
