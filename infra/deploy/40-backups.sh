#!/usr/bin/env bash
# Install nightly, verified Postgres backups for Hishab.
#
#   ssh root@SERVER 'bash -s' < infra/deploy/40-backups.sh
#
# SCOPE — this server also hosts other people's projects (an n8n instance,
# x-ui, and a Node Telegram bot in /root/other-bot). Everything below is confined
# to /opt/hishab, /etc/hishab, /var/backups/hishab, the hishab-* systemd units
# and the hishab-postgres container. It dumps the `hishab` database only. It
# never touches, restarts or reconfigures anything else on this box — no other
# database, container, unit, timer or nginx site.
#
# Idempotent: safe to run twice. It refuses to overwrite a unit it did not
# create, the same way 10-provision.sh does.
set -euo pipefail

APP_DIR=/opt/hishab
BIN_DIR="${APP_DIR}/bin"
BACKUP_DIR=/var/backups/hishab
UNIT=hishab-backup

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$1"; }
die() { printf '\033[1;31m[abort]\033[0m %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die 'run as root'

# --- refuse to clobber someone else's units ---------------------------------
for f in "/etc/systemd/system/${UNIT}.service" "/etc/systemd/system/${UNIT}.timer"; do
  if [ -e "$f" ] && ! grep -q 'managed by hishab' "$f"; then
    die "${f} exists and was not created by this script"
  fi
done
if [ -e "${BIN_DIR}/hishab-backup" ] && ! grep -q 'managed by hishab' "${BIN_DIR}/hishab-backup"; then
  die "${BIN_DIR}/hishab-backup exists and was not created by this script"
fi

# --- directories -------------------------------------------------------------
say "Creating ${BACKUP_DIR} (root-only; dumps are plaintext)"
mkdir -p "${BACKUP_DIR}/daily" "${BACKUP_DIR}/weekly" "$BIN_DIR"
chmod 700 "$BACKUP_DIR" "${BACKUP_DIR}/daily" "${BACKUP_DIR}/weekly"
chown -R root:root "$BACKUP_DIR"
# The timer runs this script as root, so the app user must not be able to
# rewrite it. 10-provision.sh knows to leave ${BIN_DIR} out of its recursive
# chown for the same reason.
chown root:root "$BIN_DIR"
chmod 750 "$BIN_DIR"

# --- the backup script itself -------------------------------------------------
say "Installing ${BIN_DIR}/hishab-backup"
cat > "${BIN_DIR}/hishab-backup" <<'SCRIPT'
#!/usr/bin/env bash
# managed by hishab — installed by infra/deploy/40-backups.sh. Do not edit here;
# edit the repo and re-run that script.
#
# Dumps the `hishab` database only, gzipped, into /var/backups/hishab, then
# VERIFIES the dump before keeping it. Touches nothing else on this shared host:
# no other database, no other container, no other unit.
set -euo pipefail

DB_NAME=hishab
DB_USER=hishab
PG_CONTAINER=hishab-postgres
ENV_FILE=/etc/hishab/hishab.env

BACKUP_DIR=/var/backups/hishab
DAILY_DIR="${BACKUP_DIR}/daily"
WEEKLY_DIR="${BACKUP_DIR}/weekly"

# --- retention ---------------------------------------------------------------
# 7 daily + 4 weekly. A dump is taken every night into daily/; on Sunday it is
# additionally hard-linked into weekly/ (a hard link, so the second copy costs
# no disk and survives when the daily name is pruned). Anything past those two
# counts is deleted. That is ~7 days at daily granularity and ~1 month at weekly
# granularity — 11 files, roughly 11x one compressed dump on disk.
KEEP_DAILY=7
KEEP_WEEKLY=4
# Pre-migration dumps (written by 20-release.sh, named pre-migrate-<release>)
# are pruned separately: the newest 5 are always kept — matching the 5 releases
# 20-release.sh keeps, so every rollback target still has its dump — and older
# ones are deleted after 30 days.
KEEP_PRE_MIGRATE=5
PRE_MIGRATE_DAYS=30

# --- verification floors ------------------------------------------------------
# A truncated or empty pg_dump gzips to a few hundred bytes; a real Hishab dump
# (schema + any data at all) is several kilobytes even on the first day. 2 KiB
# separates "nothing came out" from "a real dump" without ever tripping on a
# small but legitimate database.
MIN_BYTES=2048
# Refuse to dump if the backup filesystem has less than 1 GiB free. This box is
# shared: filling the disk would take down other people's projects too.
MIN_FREE_KB=$((1024 * 1024))

log() { printf '%s hishab-backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"; }
die() { printf '%s hishab-backup: FAILED: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >&2; exit 1; }

# `ls <glob>` fails when nothing matches, and pipefail would turn that into a
# failed backup run. Go through these helpers instead. The argument is a glob
# and is deliberately left unquoted inside.
list_dumps() {
  # shellcheck disable=SC2012,SC2086  # timestamped names: no spaces, no newlines
  ls -1t $1 2>/dev/null || true
}
count_dumps() { list_dumps "$1" | grep -c . || true; }
prune_keep() {
  local listing
  listing=$(list_dumps "$1")
  [ -n "$listing" ] || return 0
  printf '%s\n' "$listing" | tail -n +$(($2 + 1)) | xargs -r rm -f
}

TAG=daily
if [ "${1:-}" = '--tag' ]; then
  [ -n "${2:-}" ] || die '--tag needs a value'
  TAG=$2
fi

mkdir -p "$DAILY_DIR" "$WEEKLY_DIR"
chmod 700 "$BACKUP_DIR" "$DAILY_DIR" "$WEEKLY_DIR"

FREE_KB=$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}')
[ "${FREE_KB:-0}" -ge "$MIN_FREE_KB" ] \
  || die "only ${FREE_KB} KiB free on the ${BACKUP_DIR} filesystem; refusing to dump (this host is shared)"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
if [ "$TAG" = 'daily' ]; then
  OUT="${DAILY_DIR}/hishab-${STAMP}.sql.gz"
else
  OUT="${BACKUP_DIR}/${TAG}.sql.gz"
fi
# Abort rather than overwrite — a second run must never destroy the first dump.
if [ -e "$OUT" ]; then
  die "${OUT} already exists; refusing to overwrite it"
fi
PART="${OUT}.part"
rm -f "$PART"
# A dump only gets its real name once it has passed verification. Clean up the
# partial on any exit, or failed runs would silently accumulate half-written
# files that the retention pass (which only matches *.sql.gz) never removes.
trap 'rm -f "$PART"' EXIT

# --- dump ---------------------------------------------------------------------
# Preferred path: the private hishab-postgres container. Fallback: a host
# pg_dump against DATABASE_URL from /etc/hishab/hishab.env. Either way only the
# `hishab` database is read.
log "dumping ${DB_NAME} -> ${OUT}"
CONTAINERS=$(docker ps --format '{{.Names}}' 2>/dev/null || true)
if printf '%s\n' "$CONTAINERS" | grep -qx "$PG_CONTAINER"; then
  docker exec "$PG_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" \
    --format=plain --no-owner --no-privileges | gzip -9 > "$PART"
elif command -v pg_dump >/dev/null 2>&1; then
  [ -r "$ENV_FILE" ] || die "${PG_CONTAINER} is not running and ${ENV_FILE} is unreadable"
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
  [ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is not set in ${ENV_FILE}"
  pg_dump "$DATABASE_URL" --format=plain --no-owner --no-privileges | gzip -9 > "$PART"
else
  die "no way to reach Postgres: ${PG_CONTAINER} is not running and pg_dump is not installed"
fi

# --- verify (a backup nobody has tested is not a backup) -----------------------
# Three independent checks, all against the file actually on disk:
#   1. the gzip stream decompresses cleanly end to end
#   2. it is bigger than a plausible floor
#   3. pg_dump wrote its completion trailer, which it only emits on success
gzip -t "$PART" || die "gzip integrity check failed for ${PART}"

SIZE=$(wc -c < "$PART" | tr -d ' ')
[ "$SIZE" -ge "$MIN_BYTES" ] \
  || die "dump is only ${SIZE} bytes (floor ${MIN_BYTES}); treating it as a failed dump"

# Read the tail into a variable rather than piping into `grep -q`: grep exits on
# the first match, which SIGPIPEs the decompressor and, under pipefail, would
# look like a corrupt dump.
TRAILER=$(gzip -dc "$PART" | tail -c 4096)
case "$TRAILER" in
  *'PostgreSQL database dump complete'*) : ;;
  *) die "${OUT}: no 'PostgreSQL database dump complete' trailer — the dump is truncated" ;;
esac

chmod 600 "$PART"
mv "$PART" "$OUT"
log "verified ${OUT} (${SIZE} bytes)"

# --- weekly hard link + retention ---------------------------------------------
if [ "$TAG" = 'daily' ]; then
  if [ "$(date -u +%u)" = '7' ]; then
    ln -f "$OUT" "${WEEKLY_DIR}/$(basename "$OUT")"
    log "linked into weekly/"
  fi

  prune_keep "${DAILY_DIR}/*.sql.gz" "$KEEP_DAILY"
  prune_keep "${WEEKLY_DIR}/*.sql.gz" "$KEEP_WEEKLY"

  # Pre-migration dumps: keep the newest KEEP_PRE_MIGRATE unconditionally, and
  # of the rest delete only those older than PRE_MIGRATE_DAYS days.
  list_dumps "${BACKUP_DIR}/pre-migrate-*.sql.gz" | tail -n +$((KEEP_PRE_MIGRATE + 1)) \
    | while read -r old; do
        if [ -n "$(find "$old" -maxdepth 0 -mtime "+${PRE_MIGRATE_DAYS}" -print -quit)" ]; then
          rm -f "$old"
          log "pruned ${old}"
        fi
      done
fi

log "on disk: $(count_dumps "${DAILY_DIR}/*.sql.gz") daily, $(count_dumps "${WEEKLY_DIR}/*.sql.gz") weekly, $(count_dumps "${BACKUP_DIR}/pre-migrate-*.sql.gz") pre-migration"
SCRIPT
chown root:root "${BIN_DIR}/hishab-backup"
chmod 750 "${BIN_DIR}/hishab-backup"

# --- systemd unit + timer ------------------------------------------------------
say "Installing the ${UNIT}.service unit and ${UNIT}.timer"
cat > "/etc/systemd/system/${UNIT}.service" <<UNITFILE
# managed by hishab
[Unit]
Description=Hishab nightly database backup (hishab database only)
Documentation=file://${APP_DIR}/current/infra/deploy/README.md
After=network.target docker.service
Wants=docker.service

[Service]
Type=oneshot
ExecStart=${BIN_DIR}/hishab-backup
# Runs as root: it needs the docker socket (or the host pg_dump) and writes to
# ${BACKUP_DIR}, which is 0700 root. It reads one database and writes one file.
User=root
# This host is shared. Take the disk and the CPU politely so a 02:30 dump never
# starves n8n, x-ui or anything else running here.
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${UNIT}
UNITFILE

cat > "/etc/systemd/system/${UNIT}.timer" <<UNITFILE
# managed by hishab
[Unit]
Description=Nightly Hishab database backup

[Timer]
OnCalendar=*-*-* 02:30:00
# Spread the load off the hour, and catch up if the box was down at 02:30.
RandomizedDelaySec=900
Persistent=true
Unit=${UNIT}.service

[Install]
WantedBy=timers.target
UNITFILE

systemctl daemon-reload
systemctl enable --now "${UNIT}.timer"

# --- prove it works now, not at 02:30 tomorrow ---------------------------------
say 'Taking one backup right now so we know the whole path works'
"${BIN_DIR}/hishab-backup" || die 'the first backup failed — fix this before trusting the timer'

say 'Installed.'
echo "  script    : ${BIN_DIR}/hishab-backup"
echo "  dumps     : ${BACKUP_DIR}/daily (7 kept), ${BACKUP_DIR}/weekly (4 kept)"
echo "  unit      : ${UNIT}.service"
echo "  timer     : ${UNIT}.timer"
systemctl list-timers "${UNIT}.timer" --no-pager --no-legend || true
ls -lh "${BACKUP_DIR}/daily" | tail -n +2
echo
echo 'Restore instructions (including rehearsing into a scratch database):'
echo '  infra/deploy/README.md, section "Restoring from a backup"'
