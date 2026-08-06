#!/usr/bin/env bash
# Ship a release: rsync the source, install, build, migrate, restart.
#
#   ./infra/deploy/20-release.sh root@SERVER
#
# Auth: an SSH key by default. Set SSHPASS=... to use password auth instead
# (requires sshpass).
set -euo pipefail

TARGET=${1:-}
[ -n "$TARGET" ] || { echo "usage: $0 root@SERVER" >&2; exit 1; }

APP_DIR=/opt/hishab
RELEASE=$(date -u +%Y%m%d%H%M%S)
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

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

echo '--- prisma generate + migrate deploy'
pnpm --filter @hishab/api exec prisma generate
pnpm --filter @hishab/api exec prisma migrate deploy

echo '--- build'
pnpm build

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
curl -fsS "http://127.0.0.1:\${API_PORT}/v1/health" && echo
curl -fsS -o /dev/null -w 'web: %{http_code}\n' "http://127.0.0.1:\${WEB_PORT}/login"

# Keep the last five releases.
ls -1dt ${APP_DIR}/releases/* | tail -n +6 | xargs -r rm -rf
REMOTE

say 'Release complete'
