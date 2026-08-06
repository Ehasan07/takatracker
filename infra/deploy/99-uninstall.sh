#!/usr/bin/env bash
# Remove Hishab from a shared server, touching nothing else.
# The database is kept unless you pass --drop-db.
set -euo pipefail

DROP_DB=false
[ "${1:-}" = '--drop-db' ] && DROP_DB=true

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$1"; }

say 'Stopping and removing the hishab units'
systemctl disable --now hishab-web hishab-api redis-hishab 2>/dev/null || true
rm -f /etc/systemd/system/hishab-api.service \
      /etc/systemd/system/hishab-web.service \
      /etc/systemd/system/redis-hishab.service
systemctl daemon-reload

say 'Removing only the takatracker.com nginx site'
rm -f /etc/nginx/sites-enabled/takatracker.com /etc/nginx/sites-available/takatracker.com
nginx -t && systemctl reload nginx

say 'Removing the application directory'
rm -rf /opt/hishab /etc/redis/redis-hishab.conf /var/lib/redis-hishab

if [ "$DROP_DB" = true ]; then
  say 'Dropping the hishab database and role'
  su - postgres -c 'dropdb --if-exists hishab'
  su - postgres -c 'psql -c "DROP ROLE IF EXISTS hishab"'
  rm -rf /etc/hishab
else
  say 'Database kept. Re-run with --drop-db to remove it as well.'
fi

say 'The TLS certificate is left in place. Remove it deliberately with:'
echo '  certbot delete --cert-name takatracker.com'
