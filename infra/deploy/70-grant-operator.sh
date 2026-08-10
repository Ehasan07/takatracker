#!/usr/bin/env bash
# Make a person a platform operator, or take it away.
#
#   ./infra/deploy/70-grant-operator.sh root@SERVER grant you@example.com
#   ./infra/deploy/70-grant-operator.sh root@SERVER revoke you@example.com
#   ./infra/deploy/70-grant-operator.sh root@SERVER list
#
# Deliberately not an API route and deliberately not a UI. A super admin can
# read every tenant's books, so the switch that creates one must not be
# reachable from the internet at all — if it were an endpoint, then a flaw in
# authentication anywhere in the application would be a flaw in this. Shell
# access to the server is the authorisation.
#
# It touches only the `hishab` database and nothing else on this shared box.
set -euo pipefail

TARGET=${1:-}
ACTION=${2:-}
EMAIL=${3:-}
[ -n "$TARGET" ] && [ -n "$ACTION" ] || {
  echo "usage: $0 root@SERVER {grant|revoke|list} [email]" >&2
  exit 1
}

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30)
[ -n "${SSH_KEY:-}" ] && SSH_OPTS+=(-i "$SSH_KEY")
if [ -n "${SSHPASS:-}" ]; then
  command -v sshpass >/dev/null 2>&1 || { echo 'SSHPASS set but sshpass is missing' >&2; exit 1; }
  SSH=(sshpass -e ssh "${SSH_OPTS[@]}")
else
  SSH=(ssh "${SSH_OPTS[@]}")
fi

# Single-quoted for psql, with any embedded quote doubled.
sql_quote() { printf "'%s'" "${1//\'/\'\'}"; }

case "$ACTION" in
  list)
    QUERY='SELECT email, name, "createdAt" FROM "User" WHERE "isSuperAdmin" = true ORDER BY "createdAt";'
    ;;
  grant|revoke)
    [ -n "$EMAIL" ] || { echo "an email is required to ${ACTION}" >&2; exit 1; }
    VALUE=$([ "$ACTION" = grant ] && echo true || echo false)
    # RETURNING makes a typo in the address obvious: no row comes back, rather
    # than a silent success that leaves nobody an operator.
    QUERY="UPDATE \"User\" SET \"isSuperAdmin\" = ${VALUE} WHERE email = $(sql_quote "$EMAIL") RETURNING email, \"isSuperAdmin\";"
    ;;
  *)
    echo "unknown action: ${ACTION}" >&2
    exit 1
    ;;
esac

# The change is audited by hand here because it happens outside the application,
# where nothing can write an AuditEvent for it.
printf '\033[1;32m==>\033[0m %s\n' "${ACTION} ${EMAIL:-} on ${TARGET}"
"${SSH[@]}" "$TARGET" "docker exec hishab-postgres psql -U hishab -d hishab -c \"${QUERY//\"/\\\"}\""

if [ "$ACTION" = grant ]; then
  cat <<'NOTE'

The change takes effect on the next request: SuperAdminGuard re-reads the flag
from the database every time, so nobody has to sign out and in again — and a
revoke is immediate for the same reason.
NOTE
fi
