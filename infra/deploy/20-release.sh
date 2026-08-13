#!/usr/bin/env bash
# Ship a release: rsync the source, install, dump the database, migrate, build,
# swap the symlink, restart.
#
#   ./infra/deploy/20-release.sh root@SERVER
#
# Auth: an SSH key by default. Set SSHPASS=... to use password auth instead
# (requires sshpass).
#
# SCOPE — the target server hosts other people's projects (n8n, x-ui, a Node
# Telegram bot in /root/other-bot). This script only ever writes under /opt/hishab,
# /etc/hishab and /var/backups/hishab, and only ever restarts hishab-* units. It
# reads and dumps the `hishab` database and no other.
set -euo pipefail

TARGET=${1:-}
[ -n "$TARGET" ] || { echo "usage: $0 root@SERVER" >&2; exit 1; }

APP_DIR=/opt/hishab
BACKUP_DIR=/var/backups/hishab
RELEASE=$(date -u +%Y%m%d%H%M%S)
RELEASED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

# --- what exactly are we shipping? -------------------------------------------
# Until now the deployed build was anonymous: APP_VERSION was hardcoded to
# 0.1.0 in 10-provision.sh and /v1/health repeated it forever. Stamp the real
# thing instead. rsync uploads the *working tree*, not a git ref, so a SHA alone
# would be a lie whenever the tree is dirty — say so in the stamp when it is.
GIT_SHA=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo 'unknown')
if [ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]; then
  GIT_SHA="${GIT_SHA}-dirty"
fi
APP_VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "${REPO_ROOT}/apps/api/package.json" | head -1)
APP_VERSION=${APP_VERSION:-0.1.0}

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30)
[ -n "${SSH_KEY:-}" ] && SSH_OPTS+=(-i "$SSH_KEY")

if [ -n "${SSHPASS:-}" ]; then
  command -v sshpass >/dev/null 2>&1 || { echo 'SSHPASS set but sshpass is not installed' >&2; exit 1; }
  SSH=(sshpass -e ssh "${SSH_OPTS[@]}")
  RSYNC_RSH="sshpass -e ssh ${SSH_OPTS[*]}"
else
  SSH=(ssh "${SSH_OPTS[@]}")
  RSYNC_RSH="ssh ${SSH_OPTS[*]}"
fi

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$1"; }

say "Release ${RELEASE} — version ${APP_VERSION}, commit ${GIT_SHA}, built ${RELEASED_AT}"

say "Uploading the working tree to ${TARGET}:${APP_DIR}/releases/${RELEASE}"
"${SSH[@]}" "$TARGET" "mkdir -p ${APP_DIR}/releases/${RELEASE}"

rsync -az --delete \
  -e "$RSYNC_RSH" \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.next' \
  --exclude 'dist' \
  --exclude '.turbo' \
  --exclude 'test-results' \
  --exclude 'playwright-report' \
  --exclude '.env' \
  "${REPO_ROOT}/" "${TARGET}:${APP_DIR}/releases/${RELEASE}/"

say 'Installing, building and migrating on the server'
"${SSH[@]}" "$TARGET" bash -s <<REMOTE
set -euo pipefail
export CI=1
export PATH=${APP_DIR}/node/bin:\$PATH
export HOME=${APP_DIR}
# Playwright is a devDependency of the web app; the server never runs browsers.
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

cd ${APP_DIR}/releases/${RELEASE}
set -a; . /etc/hishab/hishab.env; set +a

echo '--- node' && node -v && pnpm -v

echo '--- pnpm install'
pnpm install --frozen-lockfile --prod=false

echo '--- prisma generate'
pnpm --filter @hishab/api exec prisma generate

# --- dump BEFORE migrating ----------------------------------------------------
# 'prisma migrate deploy' runs against the live database while the previous
# release is still serving it, and 'systemctl stop' cannot undo a migration. So
# the last thing that happens before the schema changes is a verified dump of
# the hishab database, tagged with this release id. No dump, no release.
echo '--- pre-migration dump'
DUMP=${BACKUP_DIR}/pre-migrate-${RELEASE}.sql.gz
mkdir -p ${BACKUP_DIR}
chmod 700 ${BACKUP_DIR}

if [ -x ${APP_DIR}/bin/hishab-backup ]; then
  ${APP_DIR}/bin/hishab-backup --tag pre-migrate-${RELEASE}
else
  echo 'warning: ${APP_DIR}/bin/hishab-backup is missing — run infra/deploy/40-backups.sh.'
  echo '         Taking a one-off pre-migration dump instead.'
  if [ -e "\$DUMP" ]; then
    echo "refusing to overwrite \$DUMP" >&2; exit 1
  fi
  trap 'rm -f "\${DUMP}.part"' EXIT
  CONTAINERS=\$(docker ps --format '{{.Names}}' 2>/dev/null || true)
  if printf '%s\n' "\$CONTAINERS" | grep -qx hishab-postgres; then
    docker exec hishab-postgres pg_dump -U hishab -d hishab \
      --format=plain --no-owner --no-privileges | gzip -9 > "\${DUMP}.part"
  else
    pg_dump "\$DATABASE_URL" --format=plain --no-owner --no-privileges | gzip -9 > "\${DUMP}.part"
  fi
  # Same three checks the nightly job makes: decompresses, big enough to be
  # real, and carries pg_dump's completion trailer.
  gzip -t "\${DUMP}.part"
  SIZE=\$(wc -c < "\${DUMP}.part" | tr -d ' ')
  [ "\$SIZE" -ge 2048 ] || { echo "dump is only \$SIZE bytes — aborting the release" >&2; exit 1; }
  TRAILER=\$(gzip -dc "\${DUMP}.part" | tail -c 4096)
  case "\$TRAILER" in
    *'PostgreSQL database dump complete'*) : ;;
    *) echo 'dump is truncated — aborting the release' >&2; exit 1 ;;
  esac
  chmod 600 "\${DUMP}.part"
  mv "\${DUMP}.part" "\$DUMP"
  echo "verified \$DUMP (\$SIZE bytes)"
fi
ls -lh "\$DUMP"

echo '--- prisma migrate deploy'
pnpm --filter @hishab/api exec prisma migrate deploy

# --- make the service worker's bytes change ------------------------------------
# A browser installs a new service worker only when sw.js differs byte for byte.
# Without this the file is identical after every deploy, no worker installs,
# `activate` never runs, and an installed home-screen app keeps serving the
# previous release's shell out of its cache — including chunk URLs this build no
# longer has. Stamping the release id makes every deploy a new worker.
#
# `grep -q` first: if the placeholder ever disappears, this has to fail the
# release rather than silently stop working.
echo '--- stamp the service worker'
SW=apps/web/public/sw.js
grep -q '__BUILD__' "\$SW" || { echo "\$SW has no __BUILD__ placeholder — refusing to ship a service worker that cannot update" >&2; exit 1; }
sed -i "s/__BUILD__/${RELEASE}/" "\$SW"
grep -n "const BUILD" "\$SW"

echo '--- build'
pnpm build

# --- stamp what is running ----------------------------------------------------
# The units read this after hishab.env, so these values win; /v1/health reports
# them. A copy lives in the release directory so 50-rollback.sh can restore the
# stamp that belongs to the release it rolls back to.
cat > /etc/hishab/release.env <<STAMP
# managed by hishab — rewritten by 20-release.sh and 50-rollback.sh.
APP_VERSION=${APP_VERSION}
GIT_SHA=${GIT_SHA}
RELEASE_ID=${RELEASE}
RELEASED_AT=${RELEASED_AT}
STAMP
chmod 644 /etc/hishab/release.env
cp /etc/hishab/release.env ${APP_DIR}/releases/${RELEASE}/.release-env

# Servers provisioned before release.env existed have no EnvironmentFile line
# for it. This drop-in adds one to the two hishab units and nothing else.
for unit in hishab-api hishab-web; do
  mkdir -p /etc/systemd/system/\${unit}.service.d
  cat > /etc/systemd/system/\${unit}.service.d/10-release-env.conf <<DROPIN
# managed by hishab
[Service]
EnvironmentFile=-/etc/hishab/release.env
DROPIN
done
systemctl daemon-reload

chown -R hishab:hishab ${APP_DIR}/releases/${RELEASE}
ln -sfn ${APP_DIR}/releases/${RELEASE} ${APP_DIR}/current
chown -h hishab:hishab ${APP_DIR}/current

echo '--- restart'
systemctl enable hishab-api hishab-web >/dev/null 2>&1 || true
systemctl restart hishab-api
sleep 4
systemctl restart hishab-web
sleep 5

systemctl is-active hishab-api
systemctl is-active hishab-web

echo '--- health'
# /v1/health now answers 503 when it cannot reach Postgres, so -f makes this a
# real gate: a release that came up without a database fails here instead of
# printing {"status":"degraded"} and exiting 0.
#
# Note the shape. The old 'curl -fsS ... && echo' could never fail the deploy:
# under 'set -e' a command before the final && is exempt from errexit, so a
# failing curl was simply ignored. It has to be tested explicitly.
HEALTH=''
for _ in \$(seq 1 15); do
  if HEALTH=\$(curl -fsS "http://127.0.0.1:\${API_PORT}/v1/health"); then break; fi
  HEALTH=''
  sleep 2
done
if [ -z "\$HEALTH" ]; then
  echo 'API health check FAILED — 503 means it is up but cannot reach Postgres.' >&2
  echo 'This release is not good. Roll the code back with infra/deploy/50-rollback.sh' >&2
  echo '(it does not revert migrations; the pre-migration dump is' >&2
  echo "  ${BACKUP_DIR}/pre-migrate-${RELEASE}.sql.gz)" >&2
  journalctl -u hishab-api -n 30 --no-pager >&2 || true
  exit 1
fi
echo "\$HEALTH"

curl -fsS -o /dev/null -w 'web: %{http_code}\n' "http://127.0.0.1:\${WEB_PORT}/login"

# Keep the last five releases — 50-rollback.sh can only reach what is still here.
ls -1dt ${APP_DIR}/releases/* | tail -n +6 | xargs -r rm -rf
REMOTE

say "Release ${RELEASE} complete (${APP_VERSION} @ ${GIT_SHA})"
echo "  pre-migration dump : ${BACKUP_DIR}/pre-migrate-${RELEASE}.sql.gz"
echo "  rollback           : ssh ${TARGET} 'bash -s' < infra/deploy/50-rollback.sh"
