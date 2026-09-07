#!/usr/bin/env bash
#
# Run a Prisma CLI command as the schema owner instead of as the API's role.
#
# `DATABASE_URL` now names `hishab_app`, which has no DDL and does not own a
# single table — deliberately, see infra/db/roles.sh. Migrations and the seed
# are exactly the two things that need what it does not have, so they get the
# owner's connection string instead of a second set of grants that would give
# the request path back the privileges it was just relieved of.
#
# `MIGRATE_DATABASE_URL` unset means "there is only one role here", which is
# true of CI and of any checkout that has not run `pnpm db:roles`. The command
# runs unchanged in that case rather than failing on a missing variable.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"

# Prisma reads .env itself, but only after this script has decided which URL to
# hand it — and an exported variable wins over a .env entry, which is the whole
# mechanism. Sourced rather than parsed: it is the same file Prisma is about to
# read, and two parsers disagreeing about one file is a bug nobody can see.
if [ -f "$root/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$root/.env"
  set +a
fi

if [ -n "${MIGRATE_DATABASE_URL:-}" ]; then
  export DATABASE_URL="$MIGRATE_DATABASE_URL"
fi

exec pnpm --filter @hishab/api exec "$@"
