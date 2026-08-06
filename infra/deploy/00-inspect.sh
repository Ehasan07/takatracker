#!/usr/bin/env bash
# Read-only reconnaissance. Changes nothing. Run this first so we know exactly
# what else lives on the box before adding anything.
set -uo pipefail

line() { printf '\n===== %s =====\n' "$1"; }

line 'HOST'
hostnamectl 2>/dev/null | sed -n '1,6p'
uptime

line 'RESOURCES'
free -h 2>/dev/null | head -3
df -h / /var 2>/dev/null | sed -n '1,4p'
nproc

line 'LISTENING PORTS'
ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null

line 'RUNNING SERVICES (enabled)'
systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | awk '{print $1}'

line 'NGINX'
nginx -v 2>&1
ls -1 /etc/nginx/sites-enabled/ 2>/dev/null
ls -1 /etc/nginx/conf.d/ 2>/dev/null
grep -rhoP 'server_name\s+\K[^;]+' /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null | sort -u

line 'EXISTING TLS CERTIFICATES'
certbot certificates 2>/dev/null | grep -E 'Certificate Name|Domains|Expiry' || echo 'certbot not installed'

line 'DOCKER'
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}' 2>/dev/null || echo 'no docker'

line 'POSTGRES'
if command -v psql >/dev/null 2>&1; then
  su - postgres -c 'psql -tAc "SELECT datname FROM pg_database WHERE datistemplate = false"' 2>/dev/null
  su - postgres -c 'psql -tAc "SELECT rolname FROM pg_roles WHERE rolcanlogin"' 2>/dev/null
  pg_lsclusters 2>/dev/null
else
  echo 'no postgres client'
fi

line 'REDIS'
if command -v redis-cli >/dev/null 2>&1; then
  redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null || echo 'no redis on 6379'
  redis-cli -h 127.0.0.1 -p 6379 info keyspace 2>/dev/null | head -20
else
  echo 'no redis client'
fi

line 'NODE / PNPM'
node -v 2>/dev/null || echo 'no node'
pnpm -v 2>/dev/null || echo 'no pnpm'

line 'HISHAB ALREADY PRESENT?'
id hishab 2>/dev/null || echo 'no hishab user'
ls -la /opt/hishab 2>/dev/null || echo 'no /opt/hishab'
systemctl list-unit-files 'hishab-*' --no-pager --no-legend 2>/dev/null || true

line 'FIREWALL'
ufw status 2>/dev/null || iptables -S 2>/dev/null | head -20
