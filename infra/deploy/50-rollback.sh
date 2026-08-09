#!/usr/bin/env bash
# Roll the code back to the previous release: repoint /opt/hishab/current and
# restart the two hishab units.
#
#   ssh root@SERVER 'bash -s' < infra/deploy/50-rollback.sh              # previous release
#   ssh root@SERVER 'bash -s -- 20260809031500' < infra/deploy/50-rollback.sh   # a specific one
#
# THIS DOES NOT REVERT DATABASE MIGRATIONS. See the banner it prints.
#
# SCOPE — this server also hosts other people's projects (an n8n instance,
# x-ui, and a Node Telegram bot in /root/other-bot). This script only reads and
# writes /opt/hishab, /etc/hishab and /var/backups/hishab, and only restarts
# hishab-api and hishab-web. Nothing else on the box is touched.
#
# Safe to run twice: rolling back to the release that is already current is
# refused, not repeated.
set -euo pipefail

APP_DIR=/opt/hishab
RELEASES="${APP_DIR}/releases"
BACKUP_DIR=/var/backups/hishab
ENV_FILE=/etc/hishab/hishab.env

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$1"; }
die() { printf '\033[1;31m[abort]\033[0m %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die 'run as root'
[ -d "$RELEASES" ] || die "${RELEASES} does not exist — nothing to roll back to"

CURRENT_PATH=$(readlink -f "${APP_DIR}/current" 2>/dev/null || true)
CURRENT_ID=$(basename "${CURRENT_PATH:-none}")

# shellcheck disable=SC2012  # release ids are timestamps: no spaces, no newlines
AVAILABLE=$(ls -1dt "${RELEASES}"/* 2>/dev/null || true)
[ -n "$AVAILABLE" ] || die "no releases under ${RELEASES}"

WANTED=${1:-}
if [ -n "$WANTED" ]; then
  TARGET_PATH="${RELEASES}/${WANTED}"
  [ -d "$TARGET_PATH" ] || {
    echo 'available releases (newest first):' >&2
    printf '%s\n' "$AVAILABLE" >&2
    die "no such release: ${WANTED}"
  }
else
  # The newest release that is not the one currently linked.
  TARGET_PATH=$(printf '%s\n' "$AVAILABLE" | grep -v -x -F "${RELEASES}/${CURRENT_ID}" | head -1 || true)
  [ -n "$TARGET_PATH" ] || die "only one release (${CURRENT_ID}) is on disk — there is nothing to roll back to"
fi
TARGET_ID=$(basename "$TARGET_PATH")

[ "$TARGET_ID" != "$CURRENT_ID" ] || die "${TARGET_ID} is already the current release"

# A release without build output would be an outage, not a rollback.
[ -f "${TARGET_PATH}/apps/api/dist/main.js" ] \
  || die "${TARGET_ID} has no apps/api/dist/main.js — it was never built; pick another release"
[ -d "${TARGET_PATH}/apps/web/.next" ] \
  || die "${TARGET_ID} has no apps/web/.next — it was never built; pick another release"

# --- the part people skip reading ---------------------------------------------
PRE_DUMP="${BACKUP_DIR}/pre-migrate-${CURRENT_ID}.sql.gz"
cat <<BANNER

  ============================================================================
   THIS ROLLBACK CHANGES CODE ONLY. IT DOES NOT REVERT DATABASE MIGRATIONS.
  ============================================================================

   Rolling back:  ${CURRENT_ID}  ->  ${TARGET_ID}

   The migrations that release ${CURRENT_ID} applied are still applied. You are
   about to run OLDER CODE ON A NEWER SCHEMA. If that release added a NOT NULL
   column, dropped one, or renamed a table, the old code will fail against it —
   sometimes quietly, in the ledger.

   Before ${CURRENT_ID} migrated, 20-release.sh dumped the database to:

     ${PRE_DUMP}
BANNER

if [ -f "$PRE_DUMP" ]; then
  printf '     (%s)\n' "$(du -h "$PRE_DUMP" | cut -f1)"
else
  printf '     *** THAT FILE IS NOT ON DISK. ***\n'
  printf '     Available dumps:\n'
  # shellcheck disable=SC2012
  ls -1t "${BACKUP_DIR}"/*.sql.gz "${BACKUP_DIR}"/daily/*.sql.gz 2>/dev/null | head -10 | sed 's/^/       /' || true
fi

cat <<'BANNER'

   Restoring that dump is a SEPARATE, DELIBERATE act and it loses every write
   made since the migration. Rehearse it into a scratch database first:
   see "Restoring from a backup" in infra/deploy/README.md.

BANNER

# --- swap ----------------------------------------------------------------------
say "Repointing ${APP_DIR}/current at ${TARGET_ID}"
ln -sfn "$TARGET_PATH" "${APP_DIR}/current"
chown -h hishab:hishab "${APP_DIR}/current"

# Put back the version stamp that belongs to this release so /v1/health stops
# claiming the rolled-back-from build is running.
if [ -f "${TARGET_PATH}/.release-env" ]; then
  cp "${TARGET_PATH}/.release-env" /etc/hishab/release.env
else
  warn "${TARGET_ID} predates release stamping — writing a minimal stamp"
  cat > /etc/hishab/release.env <<STAMP
# managed by hishab — written by 50-rollback.sh.
GIT_SHA=unknown
RELEASE_ID=${TARGET_ID}
RELEASED_AT=unknown
STAMP
fi
chmod 644 /etc/hishab/release.env

say 'Restarting hishab-api and hishab-web (and nothing else on this host)'
systemctl restart hishab-api
sleep 4
systemctl restart hishab-web
sleep 5
systemctl is-active hishab-api
systemctl is-active hishab-web

API_PORT=$(sed -n 's/^API_PORT=//p' "$ENV_FILE" 2>/dev/null | head -1)
API_PORT=${API_PORT:-4600}
say 'Health'
# /v1/health returns 503 when the database is unreachable, so -f catches the
# case where the old code cannot talk to the migrated schema at all.
if curl -fsS "http://127.0.0.1:${API_PORT}/v1/health"; then
  echo
else
  echo
  die "the API is not healthy on ${TARGET_ID} — check: journalctl -u hishab-api -n 50"
fi

say "Rolled back to ${TARGET_ID}"
echo "  code     : ${TARGET_PATH}"
echo "  schema   : STILL AT WHATEVER ${CURRENT_ID} MIGRATED IT TO — not reverted"
if [ -f "$PRE_DUMP" ]; then
  echo "  dump     : ${PRE_DUMP} (taken before ${CURRENT_ID} migrated)"
else
  echo "  dump     : MISSING — ${PRE_DUMP} is not on disk"
fi
echo "  forward  : ./infra/deploy/20-release.sh root@SERVER"
