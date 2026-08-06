#!/usr/bin/env bash
# Issue the Let's Encrypt certificate for takatracker.com only.
#
# certbot --nginx edits ONLY the server block that matches the -d names, which
# is the file 10-provision.sh created. Certificates belonging to other sites on
# this box are not touched, renewed or replaced.
set -euo pipefail

DOMAIN=takatracker.com
EMAIL=${LETSENCRYPT_EMAIL:-shawon.link@gmail.com}

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$1"; }
die() { printf '\033[1;31m[abort]\033[0m %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die 'run as root'

if ! command -v certbot >/dev/null 2>&1; then
  say 'Installing certbot'
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq certbot python3-certbot-nginx
fi

say 'Certificates already on this server (for the record)'
certbot certificates 2>/dev/null | grep -E 'Certificate Name|Domains' || true

# Only ask for www if it actually resolves here — a failing name kills the whole order.
SERVER_IP=$(curl -fsS4 https://api.ipify.org || hostname -I | awk '{print $1}')
DOMAINS=(-d "$DOMAIN")
WWW_IP=$(getent hosts "www.${DOMAIN}" | awk '{print $1}' | head -1 || true)
if [ "$WWW_IP" = "$SERVER_IP" ]; then
  DOMAINS+=(-d "www.${DOMAIN}")
  say "www.${DOMAIN} points here too — including it"
else
  say "www.${DOMAIN} does not resolve to ${SERVER_IP} — requesting the apex only"
fi

say "Requesting the certificate for ${DOMAIN}"
certbot --nginx "${DOMAINS[@]}" \
  --non-interactive --agree-tos --email "$EMAIL" \
  --redirect --keep-until-expiring

say 'Hardening the new server block'
CONF="/etc/nginx/sites-available/${DOMAIN}"
if ! grep -q 'Strict-Transport-Security' "$CONF"; then
  # Insert security headers into the TLS server block certbot just wrote.
  python3 - "$CONF" <<'PY'
import re, sys
path = sys.argv[1]
conf = open(path, encoding='utf-8').read()
headers = (
    "\n    add_header Strict-Transport-Security \"max-age=31536000; includeSubDomains\" always;"
    "\n    add_header X-Content-Type-Options nosniff always;"
    "\n    add_header Referrer-Policy strict-origin-when-cross-origin always;\n"
)
# Only the block that listens on 443.
def patch(match):
    block = match.group(0)
    if 'listen 443' in block and 'Strict-Transport-Security' not in block:
        return block.replace('{', '{' + headers, 1)
    return block

conf = re.sub(r'server\s*\{[^}]*(?:\{[^}]*\}[^}]*)*\}', patch, conf, flags=re.S)
open(path, 'w', encoding='utf-8').write(conf)
print('security headers added')
PY
fi

nginx -t
systemctl reload nginx

say 'Renewal timer'
systemctl list-timers 'certbot*' --no-pager --no-legend || true

say "Done — https://${DOMAIN}"
curl -fsS -o /dev/null -w 'https status: %{http_code}\n' "https://${DOMAIN}/" || true
