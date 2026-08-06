#!/usr/bin/env bash
# Ship a release: rsync the source, install, build, migrate, restart.
# Run from the repo root:  ./infra/deploy/20-release.sh root@SERVER
set -euo pipefail

TARGET=${1:-}
[ -n "$TARGET" ] || { echo "usage: $0 root@SERVER" >&2; exit 1; }

SSH_KEY=${SSH_KEY:-}
SSH_OPTS=(-o StrictHostKeyChecking=accept-new)
[ -n "$SSH_KEY" ] && SSH_OPTS+=(-i "$SSH_KEY")

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
APP_DIR=/opt/hishab
RELEASE=$(date -u +%Y%m%d%H%M%S)

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$1"; }

say "Uploading the working tree to ${TARGET}:${APP_DIR}/releases/${RELEASE}"
ssh "${SSH_OPTS[@]}" "$TARGET" "mkdir -p ${APP_DIR}/releases/${RELEASE}"

rsync -az --delete \
  -e "ssh ${SSH_OPTS[*]}" \
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
ssh "${SSH_OPTS[@]}" "$TARGET" bash -s <<REMOTE
set -euo pipefail
export CI=1
cd ${APP_DIR}/releases/${RELEASE}

set -a; . /etc/hishab/hishab.env; set +a

echo '--- pnpm install'
pnpm install --frozen-lockfile --prod=false

echo '--- prisma generate + migrate deploy'
pnpm --filter @hishab/api exec prisma generate
pnpm --filter @hishab/api exec prisma migrate deploy

echo '--- build'
pnpm build

chown -R hishab:hishab ${APP_DIR}/releases/${RELEASE}
ln -sfn ${APP_DIR}/releases/${RELEASE} ${APP_DIR}/current

echo '--- restart'
systemctl enable hishab-api hishab-web >/dev/null 2>&1 || true
systemctl restart hishab-api
sleep 3
systemctl restart hishab-web
sleep 3

systemctl is-active hishab-api
systemctl is-active hishab-web

echo '--- health'
curl -fsS http://127.0.0.1:\${API_PORT}/v1/health && echo

# Keep the last five releases only.
ls -1dt ${APP_DIR}/releases/* | tail -n +6 | xargs -r rm -rf
REMOTE

say 'Release complete'
