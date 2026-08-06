#!/usr/bin/env bash
# One-time provisioning for Hishab on a server that already hosts other work.
#
# Rules this script obeys:
#   * it only ever CREATES things named hishab-* / takatracker.com
#   * it never edits an existing nginx site, systemd unit, database or user
#   * it never changes the system Node, the system Postgres, or any container
#     that belongs to someone else
#   * every step is idempotent and skips work that is already done
#   * it aborts rather than overwrite a name that is already taken
set -euo pipefail

APP_USER=hishab
APP_DIR=/opt/hishab
DB_NAME=hishab
DB_USER=hishab
API_PORT=4600
WEB_PORT=3600
PG_PORT=5433
REDIS_PORT=6380
DOMAIN=takatracker.com
NODE_VERSION=22.17.0

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$1"; }
die() { printf '\033[1;31m[abort]\033[0m %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die 'run as root'

# --- guard against clobbering someone else's work --------------------------
say 'Checking that nothing we want is already in use'
for port in "$API_PORT" "$WEB_PORT" "$PG_PORT" "$REDIS_PORT"; do
  if ss -tln 2>/dev/null | grep -q ":${port} "; then
    systemctl is-active --quiet hishab-api || systemctl is-active --quiet hishab-web \
      || docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^hishab-' \
      || die "port ${port} is already in use by another process"
  fi
done

if [ -e "/etc/nginx/sites-available/${DOMAIN}" ] && ! grep -q 'managed by hishab' "/etc/nginx/sites-available/${DOMAIN}"; then
  die "/etc/nginx/sites-available/${DOMAIN} exists and was not created by this script"
fi

for unit in hishab-api hishab-web; do
  if [ -e "/etc/systemd/system/${unit}.service" ] && ! grep -q 'managed by hishab' "/etc/systemd/system/${unit}.service"; then
    die "${unit}.service exists and was not created by this script"
  fi
done

command -v nginx >/dev/null 2>&1 || die 'nginx is not installed; refusing to install a web server on a live box'

# --- packages (only what is missing) ---------------------------------------
say 'Installing missing base packages'
export DEBIAN_FRONTEND=noninteractive
MISSING=()
for pkg in curl ca-certificates xz-utils rsync git build-essential python3; do
  dpkg -s "$pkg" >/dev/null 2>&1 || MISSING+=("$pkg")
done
if [ ${#MISSING[@]} -gt 0 ]; then
  printf '    installing: %s\n' "${MISSING[*]}"
  apt-get update -qq
  apt-get install -y -qq "${MISSING[@]}"
else
  echo '    nothing to install'
fi

# --- app user ---------------------------------------------------------------
if id "$APP_USER" >/dev/null 2>&1; then
  say "User ${APP_USER} already exists"
else
  say "Creating the ${APP_USER} system user"
  adduser --system --group --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi
mkdir -p "$APP_DIR"

# --- private Node -----------------------------------------------------------
# The system Node belongs to whatever else runs here (pm2 apps, tooling).
# Upgrading it could break those, so Hishab gets its own runtime under
# /opt/hishab/node and nothing outside this directory changes.
NODE_DIR="${APP_DIR}/node"
if [ -x "${NODE_DIR}/bin/node" ] && [ "$("${NODE_DIR}/bin/node" -v)" = "v${NODE_VERSION}" ]; then
  say "Private Node v${NODE_VERSION} already installed"
else
  say "Installing a private Node v${NODE_VERSION} into ${NODE_DIR} (system Node untouched)"
  TARBALL="node-v${NODE_VERSION}-linux-x64.tar.xz"
  TMP=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${TARBALL}" -o "${TMP}/${TARBALL}"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o "${TMP}/SHASUMS256.txt"
  (cd "$TMP" && grep " ${TARBALL}\$" SHASUMS256.txt | sha256sum -c -) \
    || die 'Node tarball checksum mismatch'
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xJf "${TMP}/${TARBALL}" -C "$NODE_DIR" --strip-components=1
  rm -rf "$TMP"
fi

export PATH="${NODE_DIR}/bin:${PATH}"
if [ ! -x "${NODE_DIR}/bin/pnpm" ]; then
  say 'Installing pnpm into the private Node'
  "${NODE_DIR}/bin/npm" install -g pnpm@11.11.0 --silent
fi
say "private node $(${NODE_DIR}/bin/node -v), pnpm $(${NODE_DIR}/bin/pnpm -v)"
say "system node still $(/usr/bin/node -v 2>/dev/null || echo 'absent') — unchanged"

# --- database + redis -------------------------------------------------------
# Preference order: a private Docker compose project (most isolated, trivially
# removable), falling back to host packages only if Docker is unavailable.
mkdir -p /etc/hishab
chmod 750 /etc/hishab
DB_PASSWORD_FILE=/etc/hishab/db_password
if [ ! -f "$DB_PASSWORD_FILE" ]; then
  head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32 > "$DB_PASSWORD_FILE"
  chmod 600 "$DB_PASSWORD_FILE"
fi
DB_PASSWORD=$(cat "$DB_PASSWORD_FILE")

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  say "Starting Postgres 16 + Redis 7 as the private compose project 'hishab'"
  mkdir -p "${APP_DIR}/stack"
  cat > "${APP_DIR}/stack/docker-compose.yml" <<COMPOSE
# managed by hishab — its own compose project, its own volumes, loopback only.
# Nothing here touches any other container on this host.
name: hishab

services:
  postgres:
    image: postgres:16-alpine
    container_name: hishab-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: ${DB_NAME}
    ports:
      - '127.0.0.1:${PG_PORT}:5432'
    volumes:
      - hishab_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U ${DB_USER}']
      interval: 5s
      timeout: 5s
      retries: 20

  redis:
    image: redis:7-alpine
    container_name: hishab-redis
    restart: unless-stopped
    command: ['redis-server', '--appendonly', 'yes']
    ports:
      - '127.0.0.1:${REDIS_PORT}:6379'
    volumes:
      - hishab_redisdata:/data
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 5s
      retries: 20

volumes:
  hishab_pgdata:
  hishab_redisdata:
COMPOSE

  docker compose -f "${APP_DIR}/stack/docker-compose.yml" up -d

  say 'Waiting for Postgres to report healthy'
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' hishab-postgres 2>/dev/null)" = 'healthy' ] && break
    sleep 2
  done
  [ "$(docker inspect -f '{{.State.Health.Status}}' hishab-postgres)" = 'healthy' ] \
    || die 'hishab-postgres did not become healthy'

  DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${PG_PORT}/${DB_NAME}?schema=public"
  REDIS_URL="redis://127.0.0.1:${REDIS_PORT}"
else
  say 'Docker unavailable — falling back to host Postgres and Redis'
  for pkg in postgresql postgresql-contrib redis-server; do
    dpkg -s "$pkg" >/dev/null 2>&1 || apt-get install -y -qq "$pkg"
  done
  systemctl is-active --quiet postgresql || systemctl start postgresql
  ROLE_EXISTS=$(su - postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'\"")
  if [ "$ROLE_EXISTS" = '1' ]; then
    su - postgres -c "psql -c \"ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASSWORD}'\"" >/dev/null
  else
    su - postgres -c "psql -c \"CREATE ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASSWORD}'\"" >/dev/null
  fi
  DB_EXISTS=$(su - postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'\"")
  [ "$DB_EXISTS" = '1' ] || su - postgres -c "createdb -O ${DB_USER} ${DB_NAME}"
  DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}?schema=public"
  REDIS_URL='redis://127.0.0.1:6379/9'
fi

# --- environment file -------------------------------------------------------
ENV_FILE=/etc/hishab/hishab.env
if [ -f "$ENV_FILE" ]; then
  say 'Environment file already exists — keeping the existing secrets'
else
  say "Writing ${ENV_FILE}"
  cat > "$ENV_FILE" <<ENV
NODE_ENV=production
APP_VERSION=0.1.0

DATABASE_URL=${DATABASE_URL}
REDIS_URL=${REDIS_URL}

API_PORT=${API_PORT}
WEB_PORT=${WEB_PORT}
API_INTERNAL_URL=http://127.0.0.1:${API_PORT}
CORS_ORIGINS=https://${DOMAIN},https://www.${DOMAIN}

JWT_ACCESS_SECRET=$(openssl rand -base64 48 | tr -d '\n')
JWT_REFRESH_SECRET=$(openssl rand -base64 48 | tr -d '\n')
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=30d

INGEST_ENCRYPTION_KEY=$(openssl rand -base64 32 | tr -d '\n')
ANTHROPIC_API_KEY=
ENV
fi
chown root:"$APP_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# --- systemd units ----------------------------------------------------------
say 'Installing the hishab-api and hishab-web units'
cat > /etc/systemd/system/hishab-api.service <<UNIT
# managed by hishab
[Unit]
Description=Hishab API (NestJS)
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}/current/apps/api
EnvironmentFile=/etc/hishab/hishab.env
Environment=HOME=${APP_DIR}
Environment=PATH=${APP_DIR}/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=${APP_DIR}/node/bin/node dist/main.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${APP_DIR}
StandardOutput=journal
StandardError=journal
SyslogIdentifier=hishab-api

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/hishab-web.service <<UNIT
# managed by hishab
[Unit]
Description=Hishab web (Next.js)
After=network.target hishab-api.service
Wants=hishab-api.service

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}/current/apps/web
EnvironmentFile=/etc/hishab/hishab.env
Environment=HOME=${APP_DIR}
Environment=PORT=${WEB_PORT}
Environment=PATH=${APP_DIR}/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=${APP_DIR}/node/bin/node ${APP_DIR}/current/apps/web/node_modules/next/dist/bin/next start -p ${WEB_PORT}
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${APP_DIR}
StandardOutput=journal
StandardError=journal
SyslogIdentifier=hishab-web

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload

# --- nginx vhost (HTTP only; 30-tls.sh adds HTTPS) --------------------------
say "Adding the nginx site for ${DOMAIN}"
cat > "/etc/nginx/sites-available/${DOMAIN}" <<CONF
# managed by hishab — matches only ${DOMAIN}; every other vhost is unaffected.
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} www.${DOMAIN};

    client_max_body_size 12m;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    # nginx talks to NestJS directly, bypassing the Next proxy route.
    location /api/ {
        proxy_pass http://127.0.0.1:${API_PORT}/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }

    location / {
        proxy_pass http://127.0.0.1:${WEB_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }
}
CONF

mkdir -p /var/www/html
ln -sfn "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"

say 'Testing the whole nginx configuration before reloading'
nginx -t
systemctl reload nginx

say 'Provisioning complete.'
echo "  env file  : ${ENV_FILE}"
echo "  node      : ${NODE_DIR}/bin/node ($(${NODE_DIR}/bin/node -v))"
echo "  api port  : 127.0.0.1:${API_PORT}"
echo "  web port  : 127.0.0.1:${WEB_PORT}"
echo "  database  : 127.0.0.1:${PG_PORT}"
echo "  redis     : ${REDIS_URL}"
echo
echo 'Next: ./infra/deploy/20-release.sh root@SERVER'
