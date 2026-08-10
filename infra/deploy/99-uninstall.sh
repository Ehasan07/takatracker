#!/usr/bin/env bash
# Remove Hishab from a shared server, touching nothing else.
# The database is kept unless you pass --drop-db.
set -euo pipefail

DROP_DB=false
[ "${1:-}" = '--drop-db' ] && DROP_DB=true

say() { printf '\n\033[1;32m==>\033[0m %s\n' "$1"; }

say 'Stopping and removing the hishab units'
systemctl disable --now hishab-backup.timer 2>/dev/null || true
systemctl disable --now hishab-web hishab-api redis-hishab 2>/dev/null || true
rm -f /etc/systemd/system/hishab-api.service \
      /etc/systemd/system/hishab-web.service \
      /etc/systemd/system/hishab-backup.service \
      /etc/systemd/system/hishab-backup.timer \
      /etc/systemd/system/redis-hishab.service
rm -rf /etc/systemd/system/hishab-api.service.d \
       /etc/systemd/system/hishab-web.service.d
systemctl daemon-reload

say 'Removing only the hishab nginx sites'
# The apex plus the three subdomains from 60-subdomains.sh. Each is deleted only
# if it still says 'managed by hishab' — if someone has since replaced one of
# these files with their own, it stays. A vhost left pointing at a dead
# 127.0.0.1:4600 would answer 502 forever, which is why the subdomains are
# listed here and not left behind.
for site in takatracker.com api.takatracker.com sms.takatracker.com mail.takatracker.com; do
  conf="/etc/nginx/sites-available/${site}"
  if [ -e "$conf" ] && ! grep -q 'managed by hishab' "$conf"; then
    say "  keeping ${conf} — it was not created by these scripts"
    continue
  fi
  rm -f "/etc/nginx/sites-enabled/${site}" "$conf"
done
rm -rf /etc/nginx/hishab
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

# Backups outlive the installation on purpose: they are the only copy of the
# ledger, and this script is not the place to destroy them.
say 'Backups in /var/backups/hishab were NOT removed. Delete them deliberately:'
echo '  rm -rf /var/backups/hishab'

say 'The TLS certificates are left in place. Remove them deliberately with:'
echo '  certbot delete --cert-name takatracker.com'
echo '  certbot delete --cert-name api.takatracker.com'
echo '  certbot delete --cert-name sms.takatracker.com'
echo '  certbot delete --cert-name mail.takatracker.com'
echo '(the neighbours automation.example.com and vpn.example.com are not listed on purpose)'
