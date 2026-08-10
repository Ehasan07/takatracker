#!/usr/bin/env bash
# Put Hishab on its own hostnames, without moving anything off the ones that
# already work.
#
#   api.takatracker.com   -> the whole API on 127.0.0.1:4600
#   sms.takatracker.com   -> POST /v1/ingestion/webhook and nothing else
#   mail.takatracker.com  -> reserved for the mailbox connector's OAuth
#                            callbacks; TLS now, 404 until that code exists
#
# takatracker.com and takatracker.com/api/ are NOT touched and keep serving
# exactly what they serve today. Every installed PWA, the service worker and the
# webhook URL printed in the settings screen still point there. A subdomain is
# an addition; the migration is a separate, later decision.
#
# Rules this script obeys, in the same spirit as 10-provision.sh:
#   * it only ever writes /etc/nginx/{sites-available,sites-enabled}/{api,sms,
#     mail}.takatracker.com, /etc/nginx/hishab/ and its own certificates
#   * it refuses to overwrite a file that does not say 'managed by hishab'
#   * it runs `nginx -t` before every reload and, if that fails, puts back every
#     file it changed and reloads nothing
#   * it aborts if `nginx -t` was already failing before it started — the other
#     sites on this box are not ours to break, and not ours to be blamed for
#   * it is idempotent: a second run issues no certificate, rewrites no
#     identical file, and if nothing changed it does not reload nginx at all
#
# Usage (as root, on the server):
#   bash 60-subdomains.sh              # all three names
#   bash 60-subdomains.sh api sms      # only the names whose DNS is ready
#
# Environment:
#   LETSENCRYPT_EMAIL       registration address (default below)
#   SERVER_IP               skip public-IP detection and use this
#   HISHAB_SKIP_DNS_CHECK=1 issue anyway (e.g. the names are behind a proxy)
set -euo pipefail

DOMAIN=takatracker.com
API_PORT=4600
# The one route sms.takatracker.com exposes. Source of truth is
# apps/api/src/ingestion/ingestion.controller.ts (@Controller('ingestion') +
# @Post('webhook')) under the global '/v1' prefix set in apps/api/src/main.ts.
# nginx matches it exactly, so if that route is ever renamed this host starts
# answering 404 to the forwarders and the path below has to move with it.
WEBHOOK_PATH=/v1/ingestion/webhook
MARKER='managed by hishab'
EMAIL=${LETSENCRYPT_EMAIL:-shawon.link@gmail.com}

API_HOST="api.${DOMAIN}"
SMS_HOST="sms.${DOMAIN}"
MAIL_HOST="mail.${DOMAIN}"

SITES_AVAILABLE=/etc/nginx/sites-available
SITES_ENABLED=/etc/nginx/sites-enabled
SNIPPET_ROOT=/etc/nginx/hishab
ACME_WEBROOT=/var/www/html
LE_LIVE=/etc/letsencrypt/live
LE_RENEWAL=/etc/letsencrypt/renewal
# Reload nginx after a renewal, but only if the whole box still tests clean.
# certonly leaves no installer behind, so without this the certificate renews on
# disk and nginx keeps serving the old one until someone happens to reload.
DEPLOY_HOOK='nginx -t && systemctl reload nginx'

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }
die() { printf '\033[1;31m[abort]\033[0m %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die 'run as root'
command -v nginx >/dev/null 2>&1 || die 'nginx is not installed'

# --- which names are we doing --------------------------------------------------
ALL_HOSTS=("$API_HOST" "$SMS_HOST" "$MAIL_HOST")
HOSTS=()
if [ "$#" -eq 0 ]; then
  HOSTS=("${ALL_HOSTS[@]}")
else
  for arg in "$@"; do
    case "$arg" in
      api | "$API_HOST") HOSTS+=("$API_HOST") ;;
      sms | "$SMS_HOST") HOSTS+=("$SMS_HOST") ;;
      mail | "$MAIL_HOST") HOSTS+=("$MAIL_HOST") ;;
      *) die "unknown name '${arg}' — expected one or more of: api sms mail" ;;
    esac
  done
fi
say "Names to install: ${HOSTS[*]}"

# --- a change-set we can undo --------------------------------------------------
# Everything this script writes goes through stage_file/stage_link, so a failing
# `nginx -t` can put the box back exactly as it was and reload nothing. A syntax
# error left on disk is worse than a failed run: the next `systemctl reload
# nginx` by anyone — a certbot renewal, a reboot, another project's deploy —
# would then take automation.example.com and vpn.example.com down with it.
TX_TARGET=()
TX_BACKUP=()
TX_LINK=()

# Every write below is checked explicitly rather than left to `set -e`. These
# functions are called as `stage_file … && info …`, and inside a && list bash
# switches `set -e` off for the whole function body — a failed `install` would
# otherwise return success and we would go on to reload nginx believing we had
# written a file we had not.
stage_file() { # <target> <source>; returns 1 if the target is already identical
  local target=$1 src=$2 backup=''
  if [ -e "$target" ]; then
    cmp -s "$src" "$target" && return 1
    backup=$(mktemp) || die 'could not create a backup file'
    cp -p "$target" "$backup" || die "could not back up ${target}"
  fi
  TX_TARGET+=("$target")
  TX_BACKUP+=("$backup")
  install -m 0644 "$src" "$target" || die "could not write ${target}"
  return 0
}

stage_link() { # <link> <target>; returns 1 if it already points there
  local link=$1 target=$2
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then
    return 1
  fi
  ln -sfn "$target" "$link" || die "could not create the symlink ${link}"
  TX_LINK+=("$link")
  return 0
}

rollback_tx() {
  local i failed=0
  for ((i = ${#TX_LINK[@]} - 1; i >= 0; i--)); do
    rm -f "${TX_LINK[i]}" || failed=1
  done
  for ((i = ${#TX_TARGET[@]} - 1; i >= 0; i--)); do
    if [ -n "${TX_BACKUP[i]}" ]; then
      cp -p "${TX_BACKUP[i]}" "${TX_TARGET[i]}" || {
        failed=1
        warn "COULD NOT RESTORE ${TX_TARGET[i]} — the original is still at ${TX_BACKUP[i]}, put it back by hand before anything reloads nginx"
      }
    else
      rm -f "${TX_TARGET[i]}" || failed=1
    fi
  done
  [ "$failed" -eq 0 ] || warn 'the rollback was incomplete; read the warnings above before reloading nginx'
  TX_TARGET=()
  TX_BACKUP=()
  TX_LINK=()
}

commit_tx() {
  local b
  for b in "${TX_BACKUP[@]:-}"; do
    if [ -n "$b" ]; then rm -f "$b"; fi
  done
  TX_TARGET=()
  TX_BACKUP=()
  TX_LINK=()
}

apply_nginx() { # test, then reload — or undo everything and reload nothing
  if [ ${#TX_TARGET[@]} -eq 0 ] && [ ${#TX_LINK[@]} -eq 0 ]; then
    info 'nothing changed — not reloading nginx'
    return 0
  fi
  say 'Testing the whole nginx configuration before reloading'
  if nginx -t; then
    systemctl reload nginx
    commit_tx
    info 'reloaded'
    return 0
  fi
  warn 'nginx -t FAILED — undoing everything this script wrote'
  rollback_tx
  if nginx -t; then
    die 'configuration restored to what it was; nginx was NOT reloaded and nothing else on this box was affected'
  fi
  die 'nginx -t still fails after the rollback. DO NOT reload nginx. Investigate before touching anything else.'
}

# --- refuse to start on a box that is already broken ---------------------------
# If someone else left a syntax error in /etc/nginx, we must find out now: a
# later `nginx -t` failure would look like ours and we would roll back files
# that were never the problem.
say 'Checking the existing nginx configuration is valid before we touch anything'
nginx -t || die 'nginx -t already fails on this server, before this script changed anything. Fix that first — it is not ours, and reloading now would take every site here down.'

# --- guards: never adopt a file we did not write -------------------------------
say 'Checking that no name or file we want already belongs to someone else'

APEX_SITE="${SITES_AVAILABLE}/${DOMAIN}"
[ -e "$APEX_SITE" ] || die "${APEX_SITE} does not exist — run 10-provision.sh and 30-tls.sh first; this script matches that vhost rather than inventing its own settings"
grep -q "$MARKER" "$APEX_SITE" || die "${APEX_SITE} was not created by these scripts; refusing to guess what else on this box is ours"

for host in "${HOSTS[@]}"; do
  avail="${SITES_AVAILABLE}/${host}"
  link="${SITES_ENABLED}/${host}"

  if [ -e "$avail" ] && ! grep -q "$MARKER" "$avail"; then
    die "${avail} exists and was not created by this script — refusing to overwrite it"
  fi

  if [ -e "$link" ] || [ -L "$link" ]; then
    [ -L "$link" ] || die "${link} is a real file, not our symlink — refusing to replace it"
    current=$(readlink "$link")
    [ "$current" = "$avail" ] || die "${link} already points at ${current} — refusing to repoint it"
  fi

  # Another vhost claiming the same server_name would make nginx log
  # 'conflicting server name' and answer from whichever block it loaded first.
  # -R, not -r: sites-enabled is a directory of symlinks and -r does not follow
  # them, so -r would silently find nothing and this guard would never fire.
  escaped=${host//./\\.}
  conflict=$(grep -RlE "server_name[^;]*[[:space:]]${escaped}[[:space:];]" \
    "$SITES_ENABLED" /etc/nginx/conf.d 2>/dev/null | grep -v "/${host}$" || true)
  if [ -n "$conflict" ]; then
    die "another nginx config already declares server_name ${host}: ${conflict}"
  fi

  # Looser net for the case the strict pattern cannot see: a server_name split
  # across lines, or the hostname used in a proxy_pass or a redirect somewhere.
  # Worth saying out loud, not worth refusing over.
  mentions=$(grep -RlF "$host" "$SITES_ENABLED" /etc/nginx/conf.d 2>/dev/null | grep -v "/${host}$" || true)
  if [ -n "$mentions" ]; then
    warn "${host} is also mentioned in: ${mentions} — check that is not a second vhost for it"
  fi
done

# A wildcard vhost is not a conflict — nginx prefers an exact server_name — but
# it changes who used to answer these names, so say so out loud.
wildcards=$(grep -RlE "server_name[^;]*\*\.${DOMAIN//./\\.}" "$SITES_ENABLED" /etc/nginx/conf.d 2>/dev/null || true)
if [ -n "$wildcards" ]; then
  warn "a wildcard vhost for *.${DOMAIN} exists (${wildcards}); our exact names now win over it"
fi

# Informational only: the vhosts are valid without the API running, they just 502.
if ! ss -tln 2>/dev/null | grep -q ":${API_PORT} "; then
  warn "nothing is listening on 127.0.0.1:${API_PORT} — the new vhosts will 502 until hishab-api is up"
fi

# --- certbot -------------------------------------------------------------------
if ! command -v certbot >/dev/null 2>&1; then
  say 'Installing certbot'
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq certbot python3-certbot-nginx
fi
[ -d /etc/letsencrypt/renewal ] || mkdir -p /etc/letsencrypt/renewal

# --- DNS must be real before certbot is asked for anything ---------------------
# certbot's failure for a name that does not resolve is a wall of ACME JSON.
# This is the same check, in English, before any request is made — and it also
# keeps us under Let's Encrypt's five-failed-validations-per-hour ceiling.
resolve_a() {
  local name=$1 out=''
  if command -v dig >/dev/null 2>&1; then
    out=$(dig +short +time=3 +tries=2 A "$name" 2>/dev/null | grep -E '^[0-9]+\.[0-9.]+$' | head -n1 || true)
  elif command -v host >/dev/null 2>&1; then
    out=$(host -t A "$name" 2>/dev/null | awk '/has address/ {print $4; exit}' || true)
  else
    out=$(getent ahostsv4 "$name" 2>/dev/null | awk '{print $1; exit}' || true)
  fi
  printf '%s' "$out"
}

if [ "${HISHAB_SKIP_DNS_CHECK:-0}" = '1' ]; then
  warn 'HISHAB_SKIP_DNS_CHECK=1 — not verifying DNS; certbot will tell you if it was a lie'
else
  SERVER_IP=${SERVER_IP:-$(curl -fsS4 --max-time 10 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')}
  [ -n "$SERVER_IP" ] || die 'could not work out the public IP of this server; re-run with SERVER_IP=x.x.x.x'
  say "Checking DNS (this server is ${SERVER_IP})"
  DNS_PROBLEMS=()
  for host in "${HOSTS[@]}"; do
    ip=$(resolve_a "$host")
    if [ -z "$ip" ]; then
      DNS_PROBLEMS+=("${host}  — no A record at all")
    elif [ "$ip" != "$SERVER_IP" ]; then
      DNS_PROBLEMS+=("${host}  — resolves to ${ip}, not ${SERVER_IP}")
    else
      info "${host} -> ${ip}  ok"
    fi
  done
  if [ ${#DNS_PROBLEMS[@]} -gt 0 ]; then
    printf '\n\033[1;31m[abort]\033[0m DNS is not ready. Nothing was changed.\n\n' >&2
    for p in "${DNS_PROBLEMS[@]}"; do printf '    %s\n' "$p" >&2; done
    cat >&2 <<MSG

    Create these records at the registrar for ${DOMAIN}, then wait for the TTL:

        Type   Name    Value
        A      api     ${SERVER_IP}
        A      sms     ${SERVER_IP}
        A      mail    ${SERVER_IP}

    Check from your laptop, not from the server (its resolver may have cached
    the old answer):

        dig +short api.${DOMAIN} sms.${DOMAIN} mail.${DOMAIN}

    You can also install just the names that are ready:

        bash 60-subdomains.sh api

    If these names are deliberately behind a proxy such as Cloudflare, re-run
    with HISHAB_SKIP_DNS_CHECK=1.
MSG
    exit 1
  fi
fi

# --- match the TLS settings the rest of the box already uses -------------------
# certbot --nginx wrote these two lines into the apex vhost; reusing the same
# files means our subdomains follow the same cipher policy and pick up whatever
# certbot updates it to, instead of freezing a second opinion into three files.
SSL_EXTRA=''
if [ -f /etc/letsencrypt/options-ssl-nginx.conf ]; then
  SSL_EXTRA=$'\n    include /etc/letsencrypt/options-ssl-nginx.conf;'
else
  warn 'options-ssl-nginx.conf is missing; writing explicit protocol settings instead'
  SSL_EXTRA=$'\n    ssl_protocols TLSv1.2 TLSv1.3;\n    ssl_prefer_server_ciphers off;\n    ssl_session_cache shared:SSL:10m;\n    ssl_session_timeout 1d;'
fi
if [ -f /etc/letsencrypt/ssl-dhparams.pem ]; then
  SSL_EXTRA="${SSL_EXTRA}"$'\n    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;'
fi

# `listen ... http2` is deprecated from nginx 1.25.1, where it became its own
# directive; the directive does not exist before then. Guessing wrong is a hard
# `nginx -t` failure, so ask nginx which one it speaks.
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }
NGINX_VER=$(nginx -v 2>&1 | sed -n 's#^nginx version: nginx/\([0-9][0-9.]*\).*#\1#p')
if [ -n "$NGINX_VER" ] && version_ge "$NGINX_VER" 1.25.1; then
  LISTEN_TLS=$'listen 443 ssl;\n    listen [::]:443 ssl;\n    http2 on;'
else
  LISTEN_TLS=$'listen 443 ssl http2;\n    listen [::]:443 ssl http2;'
fi
info "nginx ${NGINX_VER:-unknown}"

# The three headers 30-tls.sh adds to the apex vhost, verbatim.
#
# They sit at server level and deliberately not inside any location: nginx
# inherits add_header into a child block only while that block adds none of its
# own, so one add_header in one location would silently drop all three there.
# Anyone editing these files must add headers here or in every location, never
# in just one.
security_headers() {
  cat <<'CONF'
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
CONF
}

# Note what is NOT here: no `expires`, no `add_header Cache-Control`, no
# `proxy_hide_header Cache-Control`. The API sets
# `Cache-Control: no-store, no-cache, must-revalidate, private` on every
# response itself (apps/api/src/main.ts) and nginx passes an upstream header
# through untouched. Adding one here would send two conflicting values and put
# balances in a browser cache.
proxy_to_api() {
  cat <<CONF
        proxy_pass http://127.0.0.1:${API_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
CONF
}

# The :80 half. The redirect lives in `location /` and not at server level on
# purpose: a server-level `return` runs before nginx picks a location, so it
# would swallow /.well-known/acme-challenge/ too and break webroot renewal.
# The literal hostname rather than $host keeps the target independent of
# whatever Host header a client invents.
http_redirect_server() { # <host>
  cat <<CONF
server {
    listen 80;
    listen [::]:80;
    server_name ${1};

    location /.well-known/acme-challenge/ {
        root ${ACME_WEBROOT};
    }

    location / {
        return 301 https://${1}\$request_uri;
    }
}
CONF
}

# --- vhost bodies --------------------------------------------------------------

render_bootstrap() { # <host> — HTTP only, no certificate yet
  cat <<CONF
# ${MARKER} — temporary, written by 60-subdomains.sh so certbot has a server
# block to answer the HTTP-01 challenge in. Replaced by the real vhost as soon
# as the certificate exists. It matches only ${1}.
#
# It deliberately does NOT redirect to https: if issuance fails, a redirect
# would send clients to a port with no certificate for this name. 503 is the
# honest answer for a hostname that is half built.
server {
    listen 80;
    listen [::]:80;
    server_name ${1};

    location /.well-known/acme-challenge/ {
        root ${ACME_WEBROOT};
    }

    location / {
        default_type text/plain;
        return 503 "${1} is not configured yet\n";
    }
}
CONF
}

render_api() {
  cat <<CONF
# ${MARKER} — the API on its own hostname. Matches only ${API_HOST}; every
# other vhost on this box, including ${DOMAIN} itself, is unaffected.
#
# This is an ADDITION. https://${DOMAIN}/api/ still proxies to the same
# upstream and must keep doing so: the installed PWA, its service worker and
# the webhook URL in the settings screen all point there.
#
# The difference is the path prefix. ${DOMAIN} strips /api/ before proxying,
# so both of these reach the same handler:
#     https://${DOMAIN}/api/v1/health
#     https://${API_HOST}/v1/health
CONF
  http_redirect_server "$API_HOST"
  cat <<CONF

server {
    ${LISTEN_TLS}
    server_name ${API_HOST};

    ssl_certificate ${LE_LIVE}/${API_HOST}/fullchain.pem;
    ssl_certificate_key ${LE_LIVE}/${API_HOST}/privkey.pem;${SSL_EXTRA}

$(security_headers)
    # Receipt photos. Same ceiling as the apex vhost.
    client_max_body_size 12m;

    location / {
$(proxy_to_api)
    }
}
CONF
}

render_sms() {
  cat <<CONF
# ${MARKER} — the ingestion webhook, and nothing else.
#
# This hostname exists to receive one POST from an SMS-forwarder app running on
# somebody's phone. That caller has no login: it authenticates with a
# per-workspace shared secret in a header. Exposing the rest of the API behind
# the same name would mean every authenticated route shares a hostname whose
# whole reason to exist is an unauthenticated door, so everything except the one
# route below returns 404 in nginx and never reaches NestJS.
#
# Exactly one location, an exact match, deliberately the same path as today —
# only the hostname differs from
# https://${DOMAIN}/api${WEBHOOK_PATH}, which keeps working. Moving a
# forwarder over is a one-word edit, and there is still only one URL shape to
# support.
CONF
  http_redirect_server "$SMS_HOST"
  cat <<CONF

server {
    ${LISTEN_TLS}
    server_name ${SMS_HOST};

    ssl_certificate ${LE_LIVE}/${SMS_HOST}/fullchain.pem;
    ssl_certificate_key ${LE_LIVE}/${SMS_HOST}/privkey.pem;${SSL_EXTRA}

$(security_headers)
    # A bank alert is a few hundred bytes and the API refuses a body over 32 KB
    # anyway. 64k lets nginx reject the absurd ones before they reach Node,
    # rather than inheriting the 12m the attachment uploads need.
    client_max_body_size 64k;

    # Its own log: 'did the forwarder ever actually reach us' is the first
    # question every time this feature is reported broken, and the shared log
    # does not record which hostname was asked for. /var/log/nginx/*.log is
    # already covered by the distribution's logrotate rule.
    access_log /var/log/nginx/${SMS_HOST}.access.log;

    location = ${WEBHOOK_PATH} {
        # Only POST. Anything else here is 403 without touching the API.
        limit_except POST {
            deny all;
        }
$(proxy_to_api)
    }

    # Everything else, including /v1/auth/login and /v1/accounts, stops here.
    location / {
        return 404;
    }
}
CONF
}

render_mail() {
  cat <<CONF
# ${MARKER} — reserved for the mailbox connector's OAuth callbacks.
#
# Stood up before the code that uses it on purpose: a redirect URI has to be
# registered with Google, and it has to resolve and present a valid certificate
# before anyone will accept it. It also has to exist before the apex's
# Strict-Transport-Security 'includeSubDomains' becomes a problem — that header
# means any browser which has already seen https://${DOMAIN} will refuse
# plain HTTP to this name, so a subdomain without TLS here is not reachable at
# all, not merely insecure.
#
# Until the connector ships, every path returns 404. Nothing is proxied to the
# API: an empty reservation cannot leak anything.
#
# To add the callback route, drop a file into
# ${SNIPPET_ROOT}/${MAIL_HOST}.d/ rather than editing this
# file — 60-subdomains.sh rewrites this file and would discard the edit, and it
# refuses to touch anything it did not write. An exact or prefix location in a
# snippet takes precedence over the 'location /' catch-all below.
CONF
  http_redirect_server "$MAIL_HOST"
  cat <<CONF

server {
    ${LISTEN_TLS}
    server_name ${MAIL_HOST};

    ssl_certificate ${LE_LIVE}/${MAIL_HOST}/fullchain.pem;
    ssl_certificate_key ${LE_LIVE}/${MAIL_HOST}/privkey.pem;${SSL_EXTRA}

$(security_headers)
    client_max_body_size 64k;

    include ${SNIPPET_ROOT}/${MAIL_HOST}.d/*.conf;

    location / {
        return 404;
    }
}
CONF
}

render_vhost() { # <host>
  case $1 in
    "$API_HOST") render_api ;;
    "$SMS_HOST") render_sms ;;
    "$MAIL_HOST") render_mail ;;
    *) die "no renderer for $1" ;;
  esac
}

# --- directories ---------------------------------------------------------------
mkdir -p "$ACME_WEBROOT" "${SNIPPET_ROOT}/${MAIL_HOST}.d"
if [ ! -f "${SNIPPET_ROOT}/${MAIL_HOST}.d/00-README.txt" ]; then
  cat > "${SNIPPET_ROOT}/${MAIL_HOST}.d/00-README.txt" <<TXT
# managed by hishab
Files matching *.conf in this directory are included inside the
server { listen 443; server_name ${MAIL_HOST}; } block written by
infra/deploy/60-subdomains.sh.

Put the mailbox connector's OAuth callback here, e.g. 10-oauth.conf:

    location = /oauth/google/callback {
        proxy_pass http://127.0.0.1:${API_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

Do not put add_header directives in here. The vhost sets HSTS,
X-Content-Type-Options and Referrer-Policy at server level, and nginx drops all
inherited add_headers in any block that declares one of its own.

Run 'nginx -t' before reloading. This file is not *.conf and is not included.
TXT
fi

# --- phase A: a server block for certbot to answer in --------------------------
NEED_CERT=()
for host in "${HOSTS[@]}"; do
  if [ -f "${LE_LIVE}/${host}/fullchain.pem" ]; then
    info "certificate for ${host} already exists"
  else
    NEED_CERT+=("$host")
  fi
done

if [ ${#NEED_CERT[@]} -gt 0 ]; then
  say "Installing temporary HTTP-only vhosts for: ${NEED_CERT[*]}"
  tmp=$(mktemp)
  for host in "${NEED_CERT[@]}"; do
    render_bootstrap "$host" > "$tmp"
    stage_file "${SITES_AVAILABLE}/${host}" "$tmp" && info "wrote ${SITES_AVAILABLE}/${host}" || true
    stage_link "${SITES_ENABLED}/${host}" "${SITES_AVAILABLE}/${host}" && info "enabled ${host}" || true
  done
  rm -f "$tmp"
  apply_nginx
fi

# --- phase B: certificates -----------------------------------------------------
# One certificate per hostname, not one certificate with three names, and never
# an expansion of the existing takatracker.com certificate. Expanding it would
# make certbot rewrite the apex vhost — the exact thing that once dropped its
# `listen 443` block and served another project's certificate for this domain.
# Separate lineages also mean a DNS mistake on one name cannot block the others.
#
# `certonly` with the nginx authenticator: the same challenge method the apex
# already uses (certbot --nginx, HTTP-01, a temporary exact-match location that
# certbot adds and removes), so nothing about how this box validates changes.
# What it does not do is let certbot's *installer* rewrite these vhosts — the
# TLS blocks above are written here, deterministically, and a re-run reproduces
# them byte for byte.
for host in "${NEED_CERT[@]:-}"; do
  [ -n "$host" ] || continue
  say "Requesting a certificate for ${host}"
  if ! certbot certonly --nginx \
    --cert-name "$host" -d "$host" \
    --non-interactive --agree-tos --email "$EMAIL" \
    --keep-until-expiring \
    --deploy-hook "$DEPLOY_HOOK"; then
    warn "certbot failed for ${host}."
    warn "The temporary HTTP-only vhost is still in place — it only matches ${host}, serves 503, and affects nothing else on this box."
    warn "Read /var/log/letsencrypt/letsencrypt.log, then re-run: bash 60-subdomains.sh ${host%%.*}"
    die "no certificate for ${host}"
  fi
done

# A lineage created by an earlier hand may have no renewal hook, in which case
# nginx would keep serving a certificate that has already been replaced on disk.
for host in "${HOSTS[@]}"; do
  conf="${LE_RENEWAL}/${host}.conf"
  if [ -f "$conf" ] && ! grep -q '^renew_hook' "$conf" && ! grep -q '^installer = nginx' "$conf"; then
    warn "${conf} has no renew_hook — nginx will not pick up a renewed certificate for ${host}."
    warn "  fix: certbot certonly --nginx --cert-name ${host} -d ${host} --keep-until-expiring --deploy-hook '${DEPLOY_HOOK}'"
  fi
done

# --- phase C: the real vhosts --------------------------------------------------
say 'Installing the TLS vhosts'
tmp=$(mktemp)
for host in "${HOSTS[@]}"; do
  [ -f "${LE_LIVE}/${host}/fullchain.pem" ] || die "expected ${LE_LIVE}/${host}/fullchain.pem to exist by now"
  render_vhost "$host" > "$tmp"
  if stage_file "${SITES_AVAILABLE}/${host}" "$tmp"; then
    info "wrote ${SITES_AVAILABLE}/${host}"
  else
    info "${SITES_AVAILABLE}/${host} already up to date"
  fi
  stage_link "${SITES_ENABLED}/${host}" "${SITES_AVAILABLE}/${host}" && info "enabled ${host}" || true
done
rm -f "$tmp"
apply_nginx

# --- what the neighbours look like now -----------------------------------------
say 'Neighbouring sites, for the record (none of these were edited)'
for f in "$SITES_ENABLED"/*; do
  [ -e "$f" ] || continue
  case "$(basename "$f")" in
    "$API_HOST" | "$SMS_HOST" | "$MAIL_HOST" | "$DOMAIN") continue ;;
  esac
  info "$(basename "$f")"
done

# --- prove it, without asserting anything about it -----------------------------
say 'Checking the new names answer'
for host in "${HOSTS[@]}"; do
  code=$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 15 "https://${host}/" 2>/dev/null || true)
  info "https://${host}/  -> ${code:-no answer}"
done
info "apex, unchanged:"
code=$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 15 "https://${DOMAIN}/" 2>/dev/null || true)
info "  https://${DOMAIN}/                 -> ${code:-no answer}"
code=$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 15 "https://${DOMAIN}/api/v1/health" 2>/dev/null || true)
info "  https://${DOMAIN}/api/v1/health    -> ${code:-no answer}"

say 'Done.'
cat <<SUMMARY
  https://${API_HOST}/v1/health          the API, same upstream as ${DOMAIN}/api/
  https://${SMS_HOST}${WEBHOOK_PATH}   the only route on that host; everything else 404
  https://${MAIL_HOST}/                 reserved, 404 until the mailbox connector ships

  ${DOMAIN} and ${DOMAIN}/api/ were not modified and keep working.

  Expected answers:
    curl -si https://${API_HOST}/v1/health              200
    curl -si -X POST https://${SMS_HOST}${WEBHOOK_PATH}  401  (no secret sent — proves the route is wired)
    curl -si https://${SMS_HOST}/v1/health              404  (the rest of the API is not here)
    curl -si https://${MAIL_HOST}/                      404
    curl -sI http://${API_HOST}/                        301 to https
SUMMARY
