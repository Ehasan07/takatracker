#!/usr/bin/env sh
#
# The database roles the API connects as.
#
# ## Why this exists
#
# `POSTGRES_USER` is the container's bootstrap **superuser**, and until this
# script the API's `DATABASE_URL` pointed straight at it. A superuser bypasses
# row-level security unconditionally — FORCE included, no policy consulted, no
# error — so `prisma/rls/row_level_security.sql` could not be applied to a
# deployment shaped like that: every policy in it would be inert while the
# dashboard reported "RLS: enabled", which is worse than having none.
#
# No policies are enabled yet. What this buys today is smaller and still worth
# having on its own: the process serving HTTP requests can no longer create,
# drop or alter a table, read `pg_authid`, write to the filesystem through
# `COPY ... PROGRAM`, or turn off a protection it is supposed to be subject to.
#
# ## The three roles
#
#   <bootstrap>      Owns every table, runs migrations and the seed. This is
#                    the existing POSTGRES_USER and it stays a superuser — the
#                    migrations rewrite every tenant's data at once and the seed
#                    writes rows for workspaces that do not exist yet. Nothing
#                    serving a request connects as it.
#   hishab_app       What the API connects as. Not the owner, no BYPASSRLS, no
#                    DDL: policies will apply to it with no exceptions.
#   hishab_admin     Created and not yet used. The super-admin module reads
#                    across tenants by design, so once policies exist it needs
#                    BYPASSRLS over its own connection string — a *credential*
#                    rather than a runtime flag, because a bug cannot promote
#                    hishab_app into it; it would have to be handed a different
#                    connection string. Making the role now means that step is a
#                    configuration change rather than a database migration.
#
# ## How it is run
#
#   - Mounted into /docker-entrypoint-initdb.d/ so a fresh volume gets it.
#   - `pnpm db:roles` against a volume that already exists — the tables are
#     already there, so the GRANT ON ALL TABLES below is what covers them.
#
# Idempotent either way: every statement is a create-or-alter, so running it
# twice changes nothing and running it after a migration adds the grants that
# migration's new tables need.
set -eu

DB_NAME="${POSTGRES_DB:-hishab}"
OWNER="${POSTGRES_USER:-hishab}"
APP_ROLE="${HISHAB_APP_ROLE:-hishab_app}"
ADMIN_ROLE="${HISHAB_ADMIN_ROLE:-hishab_admin}"

# Dev defaults only. Production passes real secrets — see infra/deploy/10-provision.sh.
APP_PASSWORD="${HISHAB_APP_PASSWORD:-hishab_app}"
ADMIN_PASSWORD="${HISHAB_ADMIN_PASSWORD:-hishab_admin}"

# A single quote in a password would end the literal below and change the
# statement. Refused rather than escaped: the generator is `openssl rand
# -base64`, which never emits one, so this can only be a hand-typed value and
# saying so beats a silent syntax error at three in the morning.
case "${APP_PASSWORD}${ADMIN_PASSWORD}" in
  *"'"*) echo "roles.sh: passwords must not contain a single quote" >&2; exit 1 ;;
esac

# No --host, on purpose. During initdb the server is started with
# `listen_addresses=''` and is reachable over the unix socket alone, so naming a
# TCP host here would work from `docker compose exec` and fail on a fresh
# volume — the case this script mostly exists for. The socket also means no
# password: the container runs as the `postgres` OS user, which the image's
# pg_hba trusts locally.
psql_do() {
  psql -v ON_ERROR_STOP=1 --no-password --username "$OWNER" --dbname "$DB_NAME" "$@"
}

ensure_role() {
  role="$1"
  password="$2"
  bypass="$3"
  exists=$(psql_do -tAc "SELECT 1 FROM pg_roles WHERE rolname = '${role}'")
  verb='CREATE'
  [ "$exists" = '1' ] && verb='ALTER'
  psql_do -c "${verb} ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE ${bypass} PASSWORD '${password}'"
}

ensure_role "$APP_ROLE" "$APP_PASSWORD" 'NOBYPASSRLS'
ensure_role "$ADMIN_ROLE" "$ADMIN_PASSWORD" 'BYPASSRLS'

psql_do <<SQL
GRANT CONNECT ON DATABASE "${DB_NAME}" TO ${APP_ROLE}, ${ADMIN_ROLE};
GRANT USAGE ON SCHEMA public TO ${APP_ROLE}, ${ADMIN_ROLE};

-- Existing tables. On a fresh volume this matches nothing and the default
-- privileges below are what carry the grant forward.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO ${APP_ROLE}, ${ADMIN_ROLE};

-- Nothing in this schema is SERIAL — every id is a cuid — but a future one
-- might be, and a missing sequence grant fails at insert time in production
-- rather than here.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}, ${ADMIN_ROLE};

-- So the next migration's new table is not silently unreadable by the API.
ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}, ${ADMIN_ROLE};
ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE}, ${ADMIN_ROLE};

-- Deliberately not granted: CREATE on schema public, TRUNCATE, REFERENCES, and
-- any DDL. A role that can \`ALTER TABLE ... DISABLE ROW LEVEL SECURITY\` is not
-- constrained by row-level security. Postgres 15 and later revoke this by
-- default; the statement is here for databases older than that.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL

echo "roles.sh: ${APP_ROLE} and ${ADMIN_ROLE} are present on ${DB_NAME}"
