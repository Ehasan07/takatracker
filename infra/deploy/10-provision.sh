#!/usr/bin/env bash
# One-time provisioning for Hishab on a shared server.
#
# Rules this script obeys:
#   * it only ever CREATES things named hishab-* / takatracker.com
#   * it never edits an existing nginx site, systemd unit, database or user
#   * every step is idempotent and skips work that is already done
#   * it refuses to continue if a name it wants is already taken by something
#     that is not ours
set -euo pipefail

APP_USER=hishab
APP_DIR=/opt/hishab
DB_NAME=hishab
DB_USER=hishab
API_PORT=4600
WEB_PORT=3600
DOMAIN=takatracker.com
NODE_MAJOR=22

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$1"; }
die() { printf '\033[1;31m[abort]\033[0m %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die 'run as root'

# --- guard against clobbering someone else's work --------------------------
for port in "$API_PORT" "$WEB_PORT"; do
  if ss -tln 2>/dev/null | grep -q ":${port}\b"; then
    systemctl is-active --quiet "hishab-api" || systemctl is-active --quiet "hishab-web" \
      || die "port ${port} is already in use by another process"
  fi
done

if [ -e "/etc/nginx/sites-available/${DOMAIN}" ] && ! grep -q 'managed by hishab' "/etc/nginx/sites-available/${DOMAIN}"; then
  die "/etc/nginx/sites-available/${DOMAIN} exists and was not created by this script"
fi

# --- packages ---------------------------------------------------------------
say 'Installing base packages (only what is missing)'
export DEBIAN_FRONTEND=noninteractive
MISSING=()
for pkg in curl ca-certificates gnupg rsync git nginx postgresql postgresql-contrib; do
  dpkg -s "$pkg" >/dev/null 2>&1 || MISSING+=("$pkg")
done
if [ ${#MISSING[@]} -gt 0 ]; then
  apt-get update -qq
  apt-get install -y -qq "${MISSING[@]}"
else
  say 'All base packages already present'
fi

# --- Node 22 ----------------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt "$NODE_MAJOR" ]; then
  say "Installing Node ${NODE_MAJOR}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
else
  say "Node $(node -v) already installed — leaving it alone"
fi

corepack enable >/dev/null 2>&1 || npm install -g corepack >/dev/null 2>&1
corepack prepare pnpm@11.11.0 --activate >/dev/null 2>&1 || npm install -g pnpm@11 >/dev/null 2>&1
say "pnpm $(pnpm -v)"

# --- app user ---------------------------------------------------------------
if id "$APP_USER" >/dev/null 2>&1; then
  say "User ${APP_USER} already exists"
else
  say "Creating user ${APP_USER}"
  adduser --system --group --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi
mkdir -p "$APP_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# --- postgres role + database ----------------------------------------------
say 'Provisioning the Postgres role and database'
systemctl is-active --quiet postgresql || systemctl start postgresql

DB_PASSWORD_FILE=/etc/hishab/db_password
mkdir -p /etc/hishab
chmod 750 /etc/hishab
if [ ! -f "$DB_PASSWORD_FILE" ]; then
  head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32 > "$DB_PASSWORD_FILE"
  chmod 600 "$DB_PASSWORD_FILE"
fi
DB_PASSWORD=$(cat "$DB_PASSWORD_FILE")

ROLE_EXISTS=$(su - postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'\"")
if [ "$ROLE_EXISTS" = '1' ]; then
  say "Role ${DB_USER} exists — resetting only its password"
  su - postgres -c "psql -c \"ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASSWORD}'\"" >/dev/null
else
  su - postgres -c "psql -c \"CREATE ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASSWORD}'\"" >/dev/null
fi

DB_EXISTS=$(su - postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'\"")
if [ "$DB_EXISTS" = '1' ]; then
  say "Database ${DB_NAME} already exists — leaving its contents untouched"
else
  su - postgres -c "createdb -O ${DB_USER} ${DB_NAME}"
fi

# --- redis ------------------------------------------------------------------
if redis-cli -h 127.0.0.1 -p 6379 ping >/dev/null 2>&1; then
  say 'Reusing the existing Redis on 6379, logical DB 9 (separate keyspace)'
  REDIS_URL='redis://127.0.0.1:6379/9'
else
  say 'No Redis found — installing a private instance on 127.0.0.1:6390'
  dpkg -s redis-server >/dev/null 2>&1 || apt-get install -y -qq redis-server
  install -d -m 755 /etc/redis
  cat > /etc/redis/redis-hishab.conf <<'CONF'
# managed by hishab — private instance, loopback only
port 6390
bind 127.0.0.1 -::1
daemonize no
supervised systemd
dir /var/lib/redis-hishab
appendonly yes
CONF
  install -d -o redis -g redis -m 750 /var/lib/redis-hishab
  cat > /etc/systemd/system/redis-hishab.service <<'UNIT'
[Unit]
Description=Redis for Hishab (private instance)
After=network.target

[Service]
Type=notify
ExecStart=/usr/bin/redis-server /etc/redis/redis-hishab.conf
User=redis
Group=redis
Restart=always

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now redis-hishab
  REDIS_URL='redis://127.0.0.1:6390'
fi

# --- environment file -------------------------------------------------------
ENV_FILE=/etc/hishab/hishab.env
if [ -f "$ENV_FILE" ]; then
  say 'Environment file already exists — keeping the existing secrets'
else
  say 'Writing /etc/hishab/hishab.env'
  cat > "$ENV_FILE" <<ENV
NODE_ENV=production
APP_VERSION=0.1.0

DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}?schema=public
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
  chmod 600 "$ENV_FILE"
fi
chown root:"$APP_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

# --- systemd units ----------------------------------------------------------
say 'Installing the hishab-api and hishab-web units'
cat > /etc/systemd/system/hishab-api.service <<UNIT
# managed by hishab
[Unit]
Description=Hishab API (NestJS)
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}/current/apps/api
EnvironmentFile=/etc/hishab/hishab.env
ExecStart=/usr/bin/node dist/main.js
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
Environment=PORT=${WEB_PORT}
ExecStart=/usr/bin/npx --no-install next start -p ${WEB_PORT}
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

# --- nginx vhost (HTTP only for now; 30-tls.sh adds HTTPS) ------------------
say "Adding the nginx site for ${DOMAIN}"
cat > "/etc/nginx/sites-available/${DOMAIN}" <<CONF
# managed by hishab — serves only ${DOMAIN}; every other vhost is unaffected.
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} www.${DOMAIN};

    client_max_body_size 12m;

    # Let's Encrypt HTTP-01 challenge
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    # API first: nginx talks to NestJS directly, bypassing the Next proxy route.
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
echo "  env file : ${ENV_FILE}"
echo "  api port : 127.0.0.1:${API_PORT}"
echo "  web port : 127.0.0.1:${WEB_PORT}"
echo "  redis    : ${REDIS_URL}"
echo
echo 'Next: ./infra/deploy/20-release.sh root@SERVER'
