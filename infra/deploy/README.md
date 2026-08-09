# Deploying Hishab to takatracker.com

**Live at https://takatracker.com** on `SERVER_IP` (Ubuntu 24.04), a
shared box that also runs n8n, an x-ui/xray VPN panel and a pm2 app. See
[../../PROGRESS.md](../../PROGRESS.md) for the deployed topology.

The target server already runs other projects. Everything here is written to be
**additive and isolated** — nothing touches an existing site, service, database
or nginx config.

## What gets created (and nothing else)

| Resource           | Value                                                                           | Why it cannot collide                                                                  |
| ------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Unix user          | `hishab`                                                                        | new, unprivileged, owns only its own directory                                         |
| Directory          | `/opt/hishab`                                                                   | new                                                                                    |
| Postgres role + DB | `hishab` / `hishab`                                                             | new role and database inside the existing cluster; other databases untouched           |
| Redis              | logical DB `9` on the existing Redis, or a private instance on `127.0.0.1:6390` | see `redis` note below                                                                 |
| Node runtime       | private Node 22 at `/opt/hishab/node` — the system Node is never touched        |
| API port           | `127.0.0.1:4600`                                                                | loopback only, non-standard                                                            |
| Web port           | `127.0.0.1:3600`                                                                | loopback only, non-standard                                                            |
| systemd units      | `hishab-api.service`, `hishab-web.service`                                      | new unit names                                                                         |
| Backup unit+timer  | `hishab-backup.service`, `hishab-backup.timer`                                  | new unit names; dumps the `hishab` database only                                       |
| Backup files       | `/var/backups/hishab/`                                                          | new directory, `0700 root`                                                             |
| Backup script      | `/opt/hishab/bin/hishab-backup`                                                 | new file, root-owned (a root timer must not run an app-writable script)                |
| Release stamp      | `/etc/hishab/release.env` + `hishab-*.service.d/10-release-env.conf`            | new files; drop-ins attach only to the two hishab units                                |
| nginx site         | `/etc/nginx/sites-available/takatracker.com`                                    | new file, `server_name takatracker.com www.takatracker.com` only                       |
| TLS cert           | `certbot --nginx -d takatracker.com -d www.takatracker.com`                     | issues one new certificate; existing certificates are not renewed, replaced or touched |

The default nginx site and every other vhost keep working: nginx picks our
server block only for the two hostnames above.

## Order of operations

```bash
# 0. from your laptop — read the server first, change nothing
ssh root@SERVER 'bash -s' < infra/deploy/00-inspect.sh

# password auth instead of a key? prefix every command with SSHPASS=...

# 1. one-time provisioning (idempotent; refuses to overwrite anything existing)
ssh root@SERVER 'bash -s' < infra/deploy/10-provision.sh

# 2. ship the code and start the services
./infra/deploy/20-release.sh root@SERVER

# 3. certificate (only after DNS for takatracker.com points at this server)
ssh root@SERVER 'bash -s' < infra/deploy/30-tls.sh

# 4. nightly backups (do this BEFORE the next release — 20-release.sh uses the
#    same script for its pre-migration dump)
ssh root@SERVER 'bash -s' < infra/deploy/40-backups.sh
```

`20-release.sh` is safe to re-run: it rsyncs, builds, migrates and restarts only
the two `hishab-*` units.

## What version is running

Every deploy writes `/etc/hishab/release.env` (read by both units, after
`hishab.env`, so it wins) and copies it into the release directory as
`.release-env`:

```
APP_VERSION=0.1.0
GIT_SHA=9f3c1ab          # short SHA; suffixed -dirty if the tree was not clean
RELEASE_ID=20260809031500 # also the directory under /opt/hishab/releases
RELEASED_AT=2026-08-09T03:15:00Z
```

`GET /v1/health` reports all four:

```bash
curl -s https://takatracker.com/api/v1/health
# {"status":"ok","db":true,"version":"0.1.0","commit":"9f3c1ab",
#  "release":"20260809031500","releasedAt":"2026-08-09T03:15:00Z"}
```

It answers **503** when it cannot reach Postgres (the body is unchanged:
`{"status":"degraded","db":false,...}`). `20-release.sh` and Playwright both
`curl -fsS` this endpoint, so a deploy that comes up without a database now
fails the release instead of exiting 0.

`GIT_SHA` can say `-dirty` because `20-release.sh` rsyncs the working tree, not
a git ref. If you want the SHA to mean something exact, commit and push to
`ssh://root@SERVER_IP/srv/git/takatracker.git` first.

## Backups

`40-backups.sh` installs (and re-running it is safe):

| Thing               | Value                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| Script              | `/opt/hishab/bin/hishab-backup` (root-owned, `0750`)                                               |
| Unit / timer        | `hishab-backup.service` / `hishab-backup.timer`                                                    |
| Schedule            | `02:30` daily, up to 15 min random delay, `Persistent=true`                                        |
| Nightly dumps       | `/var/backups/hishab/daily/hishab-<UTC timestamp>.sql.gz`                                          |
| Weekly dumps        | `/var/backups/hishab/weekly/…` — a hard link made on Sundays                                       |
| Pre-migration dumps | `/var/backups/hishab/pre-migrate-<release id>.sql.gz`                                              |
| **Retention**       | **7 daily, 4 weekly.** Pre-migration dumps: newest 5 always kept, older ones deleted after 30 days |

It dumps the `hishab` database and nothing else — no other database, container
or unit on this shared box is read, written or restarted.

Every dump is **verified before it is kept**: it is written to `<name>.part`,
then checked three ways — `gzip -t`, a 2 KiB size floor (an empty or failed
`pg_dump` gzips to a few hundred bytes), and the presence of pg_dump's
`PostgreSQL database dump complete` trailer, which it only writes on success.
Only then is it renamed. A run that fails any check exits non-zero, leaves no
partial file, and the unit goes into `failed`. It also refuses to run at all if
the filesystem has under 1 GiB free — filling this disk would take down the
other projects on the box, not just ours.

Checking on it:

```bash
systemctl list-timers hishab-backup.timer      # when it next runs
systemctl status hishab-backup.service         # how the last run went
journalctl -u hishab-backup -n 50              # what it said
ls -lh /var/backups/hishab/daily/              # what is actually on disk
/opt/hishab/bin/hishab-backup                  # run one right now
```

## Restoring from a backup

**Rehearse into a scratch database first.** This touches neither the live
database nor the running app, so there is no excuse not to do it before a real
restore — and doing it once a month is the only thing that turns these files
into an actual backup.

```bash
DUMP=/var/backups/hishab/daily/hishab-20260809T023000Z.sql.gz   # pick one

# 1. a throwaway database beside the real one
docker exec hishab-postgres createdb -U hishab hishab_restore_test

# 2. load the dump into it
gunzip -c "$DUMP" \
  | docker exec -i hishab-postgres psql -U hishab -d hishab_restore_test -v ON_ERROR_STOP=1 -q

# 3. prove it is a real ledger and not an empty shell
docker exec hishab-postgres psql -U hishab -d hishab_restore_test -c '\dt'
docker exec hishab-postgres psql -U hishab -d hishab_restore_test -tAc \
  'SELECT (SELECT count(*) FROM "User"), (SELECT count(*) FROM "Transaction"), (SELECT count(*) FROM "LedgerEntry")'

# 4. throw it away
docker exec hishab-postgres dropdb -U hishab hishab_restore_test
```

**The real thing.** This is destructive and takes the site down for its
duration. It restores the ledger to the moment of the dump; everything written
since is gone.

```bash
DUMP=/var/backups/hishab/daily/hishab-20260809T023000Z.sql.gz

# 1. stop only the hishab units (this also closes their database connections)
systemctl stop hishab-web hishab-api

# 2. keep the broken database instead of dropping it — you may need it later
docker exec hishab-postgres psql -U hishab -d postgres \
  -c 'ALTER DATABASE hishab RENAME TO hishab_broken_20260809'
#    if the rename complains about open connections:
#    docker exec hishab-postgres psql -U hishab -d postgres -c \
#      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='hishab'"

# 3. recreate and load
docker exec hishab-postgres createdb -U hishab hishab
gunzip -c "$DUMP" \
  | docker exec -i hishab-postgres psql -U hishab -d hishab -v ON_ERROR_STOP=1 -q

# 4. back up
systemctl start hishab-api hishab-web
curl -fsS http://127.0.0.1:4600/v1/health && echo

# 5. once you are sure, and not before:
# docker exec hishab-postgres dropdb -U hishab hishab_broken_20260809
```

If the dump predates a migration the running code expects, the app will be
newer than the schema. Check with:

```bash
cd /opt/hishab/current && pnpm --filter @hishab/api exec prisma migrate status
```

and either apply the missing migrations (`prisma migrate deploy`) or roll the
code back to the release that matches (see below).

If Postgres is running on the host rather than in the `hishab-postgres`
container, replace every `docker exec [-i] hishab-postgres <cmd>` above with
`sudo -u postgres <cmd>`.

## Rolling back a release

```bash
ssh root@SERVER 'bash -s' < infra/deploy/50-rollback.sh                    # previous release
ssh root@SERVER 'bash -s -- 20260809031500' < infra/deploy/50-rollback.sh  # a specific one
```

It repoints `/opt/hishab/current` at a previous release (five are kept), puts
back that release's version stamp, and restarts the two `hishab-*` units.
It refuses to point at a release that was never built.

**It does not revert database migrations.** Old code on a new schema is a real
failure mode, so the script prints the name of the dump taken immediately before
the migration that release applied — `/var/backups/hishab/pre-migrate-<release
id>.sql.gz`. Restoring that dump is a separate, deliberate act using the
procedure above, and it discards every write since the migration.

The old advice, `systemctl stop hishab-web hishab-api`, is an outage, not a
rollback — it leaves the migrated schema in place and the site down. Use it only
to deliberately take Hishab offline. Nothing else on the box changes state.

To remove Hishab completely (backups are deliberately left behind):

```bash
ssh root@SERVER 'bash -s' < infra/deploy/99-uninstall.sh
```

## What disaster recovery still does NOT cover

Read this as the honest limit of the above, not as a to-do list someone already
did. Today the backups protect against exactly one thing: **the database being
damaged while the server survives** (a bad migration, a bad delete, corruption).

- **No offsite copy.** Every dump lives on the same VPS, on the same disk, as
  the database it came from. Lose the host — provider incident, disk failure,
  account suspension, ransomware — and you lose the ledger and every backup of
  it in the same instant. This is the single biggest gap. Fixing it needs an
  account and credentials nobody has given me (S3/B2/rsync.net + a key).
- **No encryption at rest.** The dumps are plain gzip, `0700 root`. Anyone with
  root on this shared box, or with a copy of its disk image, reads every user's
  financial history. Encrypting them needs a key that must itself be stored
  somewhere other than this server — same missing decision as above.
- **Up to 24 hours of data loss.** One dump a night, no WAL archiving, no
  point-in-time recovery. A failure at 02:29 loses a full day of transactions.
- **Nothing tells you when backups stop.** If the timer is masked, the disk
  fills, or Postgres stops answering, the unit goes to `failed` in the journal
  and no human is notified. Until there is alerting, `systemctl list-timers
hishab-backup.timer` is a manual chore.
- **Verification is not a restore.** The three checks prove the file is a
  complete, well-formed pg_dump — not that the app boots against it. Only the
  scratch-database rehearsal above proves that, and nothing schedules it.
- **Secrets are not backed up.** `/etc/hishab/hishab.env` holds the JWT signing
  keys, the database password and `INGEST_ENCRYPTION_KEY`. It is deliberately
  never written into `/var/backups` (that would scatter secrets into files meant
  to be copied around), so a rebuild-from-scratch needs it from somewhere else.
  Keep a copy in a password manager, out of band. Without
  `INGEST_ENCRYPTION_KEY` the encrypted ingest data is unreadable even with a
  perfect database restore.
- **No rebuild runbook.** There is no tested "the VPS is gone, here is how we
  are serving takatracker.com again in an hour" procedure — no second host, no
  DNS failover, no recovery-time target anyone has agreed to.
- **The app is not fenced off during a restore.** Steps 1–4 above are manual;
  nothing stops a second operator deploying mid-restore.

## Redis

If the server already runs Redis, Hishab uses logical database `9` on it
(`redis://127.0.0.1:6379/9`) — separate keyspace, no config change to the
existing instance. If Redis is absent, `10-provision.sh` installs one bound to
`127.0.0.1:6390` under its own unit so nothing else can be affected.
