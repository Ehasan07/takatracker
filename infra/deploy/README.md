# Deploying Hishab to takatracker.com

**Live at https://takatracker.com** on `SERVER_IP` (Ubuntu 24.04), a
shared box that also runs n8n, an x-ui/xray VPN panel and a pm2 app. See
[../../PROGRESS.md](../../PROGRESS.md) for the deployed topology.

The target server already runs other projects. Everything here is written to be
**additive and isolated** — nothing touches an existing site, service, database
or nginx config.

The neighbours, by name, because every guard in these scripts exists to protect
one of them: `automation.example.com` (n8n), `vpn.example.com` (x-ui), and a Node
Telegram bot on `:3000` out of `/root/other-bot`. nginx serves all of them from
`/etc/nginx/sites-enabled/` and Let's Encrypt holds their certificates. A bad
`nginx -t`, a reload of a broken config, or a certbot run that rewrites the
wrong vhost takes all three down along with ours.

## What gets created (and nothing else)

| Resource            | Value                                                                           | Why it cannot collide                                                                  |
| ------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Unix user           | `hishab`                                                                        | new, unprivileged, owns only its own directory                                         |
| Directory           | `/opt/hishab`                                                                   | new                                                                                    |
| Postgres roles + DB | `hishab` / `hishab`, plus `hishab_app` and `hishab_admin`                       | new roles and database inside the existing cluster; other databases untouched          |
| Redis               | logical DB `9` on the existing Redis, or a private instance on `127.0.0.1:6390` | see `redis` note below                                                                 |
| Node runtime        | private Node 22 at `/opt/hishab/node` — the system Node is never touched        |
| API port            | `127.0.0.1:4600`                                                                | loopback only, non-standard                                                            |
| Web port            | `127.0.0.1:3600`                                                                | loopback only, non-standard                                                            |
| systemd units       | `hishab-api.service`, `hishab-web.service`                                      | new unit names                                                                         |
| Backup unit+timer   | `hishab-backup.service`, `hishab-backup.timer`                                  | new unit names; dumps the `hishab` database only                                       |
| Backup files        | `/var/backups/hishab/`                                                          | new directory, `0700 root`                                                             |
| Backup script       | `/opt/hishab/bin/hishab-backup`                                                 | new file, root-owned (a root timer must not run an app-writable script)                |
| Release stamp       | `/etc/hishab/release.env` + `hishab-*.service.d/10-release-env.conf`            | new files; drop-ins attach only to the two hishab units                                |
| nginx site          | `/etc/nginx/sites-available/takatracker.com`                                    | new file, `server_name takatracker.com www.takatracker.com` only                       |
| TLS cert            | `certbot --nginx -d takatracker.com -d www.takatracker.com`                     | issues one new certificate; existing certificates are not renewed, replaced or touched |
| Subdomain sites     | `sites-available/{api,sms,mail}.takatracker.com` (see below)                    | new files, one exact `server_name` each                                                |
| Subdomain certs     | `certbot --cert-name api.takatracker.com` and the same for `sms`/`mail`         | three new independent lineages; the apex certificate is not expanded or reissued       |

The default nginx site and every other vhost keep working: nginx picks our
server block only for the two hostnames above.

### The three database roles

`hishab` owns every table and runs `prisma migrate deploy` and the seed; under
Docker it is also the cluster's bootstrap superuser. Nothing serving an HTTP
request connects as it. The API connects as **`hishab_app`**, which has
`SELECT`/`INSERT`/`UPDATE`/`DELETE` and nothing else — no DDL, no `TRUNCATE`, no
`BYPASSRLS` — so the process handling requests cannot alter a table or switch
off a protection it is meant to be subject to. **`hishab_admin`** exists and is
read by nothing: the super-admin module crosses tenants by design, so when the
row-level security policies in `apps/api/prisma/rls/` are eventually applied it
will need its own credential, and making the role now keeps that a
configuration change rather than a database migration.

Passwords live in `/etc/hishab/db_password`, `db_app_password` and
`db_admin_password`, `0600 root`. The connection strings are
`DATABASE_URL` (app), `MIGRATE_DATABASE_URL` (owner, read by `20-release.sh`)
and `ADMIN_DATABASE_URL`.

**An install provisioned before these roles existed keeps working and keeps
connecting as the owner.** `10-provision.sh` creates the roles on any re-run,
but it never rewrites `/etc/hishab/hishab.env` — that file holds the JWT
secrets, and replacing them signs every live session out. So it prints the three
lines to paste in instead. Do that, then `systemctl restart hishab-api
hishab-web`. Locally the same split is `pnpm db:roles` (a volume that predates
it; a fresh one gets the roles from `initdb`).

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

# 5. subdomains (only after the three A records below exist — see "Subdomains")
ssh root@SERVER 'bash -s' < infra/deploy/60-subdomains.sh
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

## Subdomains

`60-subdomains.sh` adds three hostnames. It is an **addition**: `takatracker.com`
and `takatracker.com/api/` are not edited and keep serving exactly what they
serve today.

| Hostname               | Serves                                                 | Everything else |
| ---------------------- | ------------------------------------------------------ | --------------- |
| `api.takatracker.com`  | the whole API, `127.0.0.1:4600`, no `/api` prefix      | —               |
| `sms.takatracker.com`  | `POST /v1/ingestion/webhook` only                      | **404**         |
| `mail.takatracker.com` | nothing yet — reserved for the mailbox OAuth callbacks | **404**         |

### DNS — do this first, it is the only manual step

Create three **A** records at the registrar for `takatracker.com`, all pointing
at the server:

| Type | Name   | Value             | TTL     |
| ---- | ------ | ----------------- | ------- |
| A    | `api`  | `SERVER_IP` | default |
| A    | `sms`  | `SERVER_IP` | default |
| A    | `mail` | `SERVER_IP` | default |

No AAAA, no CNAME, no MX. `mail` is an ordinary web hostname here — it receives
OAuth redirects, it does not receive email, and adding an MX record for it would
be a different and unrelated decision.

Check from your laptop, not from the server — the server's resolver may have
cached the old `NXDOMAIN`:

```bash
dig +short api.takatracker.com sms.takatracker.com mail.takatracker.com
# expect SERVER_IP three times
```

`60-subdomains.sh` refuses to start until all three resolve here, and prints the
table above if they do not, rather than letting certbot fail with ACME JSON. If
a name is deliberately behind a proxy such as Cloudflare, re-run with
`HISHAB_SKIP_DNS_CHECK=1`.

You do not have to do all three at once:

```bash
ssh root@SERVER 'bash -s -- api sms' < infra/deploy/60-subdomains.sh
```

### Running it

```bash
# 1. DNS, from your laptop — must show SERVER_IP three times
dig +short api.takatracker.com sms.takatracker.com mail.takatracker.com

# 2. read the box first; nothing is written
ssh root@SERVER 'bash -s' < infra/deploy/00-inspect.sh

# 3. install the three vhosts and their certificates
ssh root@SERVER 'bash -s' < infra/deploy/60-subdomains.sh

# 4. the new names
curl -si https://api.takatracker.com/v1/health                        # 200
curl -si -X POST https://sms.takatracker.com/v1/ingestion/webhook     # 401 — route is live, no secret sent
curl -si https://sms.takatracker.com/v1/health                        # 404 — the rest of the API is not here
curl -si https://sms.takatracker.com/v1/auth/login                    # 404
curl -si https://mail.takatracker.com/                                # 404
curl -sI http://api.takatracker.com/                                  # 301 to https

# 5. the old paths, which must be unchanged
curl -si https://takatracker.com/api/v1/health                        # 200
curl -si https://takatracker.com/                                     # 200
curl -si https://takatracker.com/api/v1/ingestion/webhook -X POST     # 401, exactly as before

# 6. the neighbours, which must also be unchanged
curl -sI https://automation.example.com/ | head -1
curl -skI https://vpn.example.com/ | head -1
ssh root@SERVER 'pm2 list; docker ps --format "{{.Names}}\t{{.Status}}"'
```

The `401` in step 4 is the point: it proves nginx routed the request to NestJS
and NestJS rejected the missing shared secret. A `404` there would mean the
location did not match.

### How `sms.` is restricted to one route

One exact-match location and a catch-all:

```nginx
location = /v1/ingestion/webhook {
    limit_except POST { deny all; }
    proxy_pass http://127.0.0.1:4600;
    ...
}

location / {
    return 404;
}
```

`location =` is an exact match, so `/v1/ingestion/webhook/`, `/v1/ingestion`,
`/v1/auth/login` and everything else fall through to the 404 and never reach
Node. A query string still works. Non-`POST` on the webhook path itself is
`403` from `limit_except`, not 404 — the path is not a secret (it is in the
settings screen), and a distinguishable answer is worth more than the pretence.

The path is deliberately **identical** to the one already in use, so the only
difference between the old URL and the new one is the hostname:

```
https://takatracker.com/api/v1/ingestion/webhook   (still works, unchanged)
https://sms.takatracker.com/v1/ingestion/webhook   (new)
```

`sms.` also has its own access log at
`/var/log/nginx/sms.takatracker.com.access.log`, because "did the forwarder ever
actually reach us" is the first question every time this feature is reported
broken, and the shared log does not record which hostname was asked for. The
distribution's `logrotate` rule for `/var/log/nginx/*.log` already covers it.

The URL printed in the settings screen comes from `API_PUBLIC_URL` in
`/etc/hishab/hishab.env`. It is **not** changed by this script — the old URL
keeps working and switching what new users are told is a separate decision. When
you want it:

```bash
# on the server
sed -i 's#^API_PUBLIC_URL=.*#API_PUBLIC_URL=https://sms.takatracker.com#' /etc/hishab/hishab.env
systemctl restart hishab-api
```

Every forwarder already configured with the old URL keeps working; the setting
only affects what the screen tells someone to paste next.

### `mail.` is a reservation

It exists so a redirect URI can be registered with Google before the code behind
it does. A callback URL has to resolve and present a valid certificate before
anyone will accept it — and because the apex sends
`Strict-Transport-Security: … includeSubDomains`, any browser that has already
visited `https://takatracker.com` will refuse plain HTTP to `mail.` entirely. A
subdomain without TLS here is not merely insecure, it is unreachable.

Until the connector ships every path returns 404 and nothing is proxied.

**To add the callback route, do not edit the vhost.** Drop a file into
`/etc/nginx/hishab/mail.takatracker.com.d/`, which is `include`d inside the TLS
server block:

```nginx
# /etc/nginx/hishab/mail.takatracker.com.d/10-oauth.conf
location = /oauth/google/callback {
    proxy_pass http://127.0.0.1:4600;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

then `nginx -t && systemctl reload nginx`. A location in a snippet takes
precedence over the `location /` catch-all. Editing the vhost directly would
work until the next run of `60-subdomains.sh` rewrote it.

Do **not** put `add_header` in a snippet: nginx inherits `add_header` into a
child block only while that block declares none of its own, so one `add_header`
in one location silently drops HSTS, `X-Content-Type-Options` and
`Referrer-Policy` for that route. The same rule applies to the vhosts
themselves, which is why all three headers live at server level.

### What the script will not do

- It refuses to touch any nginx file that does not say `managed by hishab`, and
  refuses to repoint a `sites-enabled` symlink it did not create.
- It runs `nginx -t` **before** it starts, and aborts if the configuration was
  already broken — a pre-existing error from another project is not ours to be
  blamed for, and reloading on top of it would be worse.
- It runs `nginx -t` before every reload. If the test fails it puts back every
  file it wrote, byte for byte, deletes the symlinks it created, and reloads
  nothing. Leaving a syntax error on disk would take down
  `automation.example.com` and `vpn.example.com` at the next reload by anybody.
- It refuses if another config already declares one of these `server_name`s.
- Re-running it issues no certificate, rewrites no identical file, and if
  nothing changed does not reload nginx at all.
- It never expands the existing `takatracker.com` certificate. Expanding it
  would make certbot rewrite the apex vhost — the exact failure recorded in
  `10-provision.sh`, where a rewrite dropped the `listen 443` block and this
  domain started serving another project's certificate.

### Certificates

Three separate lineages, one name each, issued with

```
certbot certonly --nginx --cert-name api.takatracker.com -d api.takatracker.com \
  --keep-until-expiring --deploy-hook 'nginx -t && systemctl reload nginx'
```

Same challenge method as the apex (`--nginx`, HTTP-01, a temporary exact-match
location certbot adds and removes) — nothing about how this box validates
changes. `certonly` is the one difference: certbot's _installer_ is not allowed
to rewrite these vhosts, so the TLS blocks are written by the script,
deterministically, and a re-run reproduces them byte for byte.

The `--deploy-hook` matters. `certonly` records no installer, so without it the
certificate would renew on disk and nginx would keep serving the old one until
somebody happened to reload. The hook is stored in each lineage's own file under
`/etc/letsencrypt/renewal/` and affects no other certificate on this box.

Separate certificates rather than one with three names: a DNS mistake on one
name cannot then block the other two, and each can be revoked or removed on its
own.

### What has NOT moved, and what it would take

`takatracker.com/api/` is still the only URL the browser app uses, and it should
stay that way for now:

- **Session cookies are host-only.** `apps/api/src/auth/auth.controller.ts` sets
  the access and refresh cookies with no `Domain` attribute, so they are sent to
  `takatracker.com` and _not_ to `api.takatracker.com`. Pointing the web app at
  the subdomain today would log everyone out. Moving would mean setting
  `Domain=.takatracker.com` — which also widens the cookie to `sms.` and
  `mail.`, so it is a real decision, not a config tweak.
- **CORS already allows it.** `CORS_ORIGINS` is
  `https://takatracker.com,https://www.takatracker.com`; the browser sends
  `Origin: https://takatracker.com` when calling `api.takatracker.com`, so
  cross-origin XHR is permitted. Only the cookies are the blocker.
- **The service worker and every installed PWA** have `takatracker.com` baked
  in. They keep working because that vhost is untouched.

`api.takatracker.com` is immediately useful for anything that is not the
browser app: mobile clients, scripts, `curl`, and any integration that would
rather not carry an `/api` prefix.

## Per-tenant custom domains (design only — not built)

What it would take for a workspace to be reachable at `paisa.example.com`
instead of `takatracker.com`. Nothing below is implemented.

**1. Hostname → workspace lookup.** A `WorkspaceDomain` table
(`hostname` unique, `workspaceId`, `verifiedAt`, `status`) and a request-scoped
resolver that maps `Host` to a workspace before authentication runs. The trap is
that this becomes a second, weaker way of choosing a tenant next to the JWT: if
the host can select a workspace on its own, a request with a valid token for
workspace A arriving on workspace B's hostname must be **rejected**, not
silently retargeted. I would treat the hostname as an assertion to be checked
against the token, never as a source of authority.

Verification before anything is issued: the customer adds
`_hishab-challenge.<their host> TXT <random>`, we poll for it, and only then
mark the domain verified. Without that, anyone can point a hostname at us and
make us request a certificate for a name they do not control.

**2. On-demand ACME.** nginx cannot do this natively. Two ways:

- **Caddy in front, with `on_demand_tls` and an `ask` endpoint** that answers
  200 only for hostnames already `verified` in the table. Caddy obtains and
  renews the certificate on the first TLS handshake for a new name and stores it
  itself. This is the option I would choose — it is a few lines of config
  against several hundred lines of glue — but not on this box: Caddy would have
  to own :80 and :443, and those belong to an nginx that also serves
  `automation.example.com` and `vpn.example.com`. It only becomes reasonable on a
  host we own outright, or by moving the neighbours off first.
- **Keep nginx and write the glue**: a job that watches for newly verified
  domains, runs `certbot certonly --webroot` per hostname, writes a vhost from a
  template, tests and reloads. That is `60-subdomains.sh` generalised, plus a
  queue, plus retry and backoff, plus a reload debounce so a hundred signups do
  not reload nginx a hundred times. Workable, and the honest cost is that we
  would be maintaining a small ACME orchestration service.

Given the shared box, the realistic path is the second one until custom domains
justify their own host, then the first.

**3. Wildcard certificates need DNS-01, and therefore DNS API access.** A single
`*.takatracker.com` certificate would cover every _subdomain_ we hand out
(`acme.takatracker.com`, `beximco.takatracker.com`) and remove per-tenant
issuance entirely for that case. Let's Encrypt will only issue a wildcard
against a **DNS-01** challenge — HTTP-01 cannot prove control of a whole label —
which means certbot must write `_acme-challenge.takatracker.com TXT` at the
registrar every 60 days. That needs an API token for the DNS provider, stored on
this server, with permission to edit records for the zone: a credential that can
repoint `takatracker.com` anywhere is a bigger blast radius than the certificate
it protects. It would want a provider that supports scoped tokens, or a
delegated `_acme-challenge` CNAME into a throwaway zone so the token cannot
touch the real records.

And a wildcard does nothing at all for genuinely custom domains:
`*.takatracker.com` cannot cover `paisa.example.com`. Those need per-hostname
certificates regardless.

**What I would choose.** Subdomains per tenant, on a wildcard, with DNS-01 and a
delegated `_acme-challenge` zone: one certificate, no per-signup ACME, no
per-signup nginx reload, and new tenants work the instant the row is written.
Customer-supplied domains stay a paid, manual-ish tier on top — verified by TXT,
issued per hostname, small enough numbers that the second option above is fine.
Wildcard-first is the choice that keeps the common case boring.

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
