# Deploying Hishab to takatracker.com

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
| API port           | `127.0.0.1:4600`                                                                | loopback only, non-standard                                                            |
| Web port           | `127.0.0.1:3600`                                                                | loopback only, non-standard                                                            |
| systemd units      | `hishab-api.service`, `hishab-web.service`                                      | new unit names                                                                         |
| nginx site         | `/etc/nginx/sites-available/takatracker.com`                                    | new file, `server_name takatracker.com www.takatracker.com` only                       |
| TLS cert           | `certbot --nginx -d takatracker.com -d www.takatracker.com`                     | issues one new certificate; existing certificates are not renewed, replaced or touched |

The default nginx site and every other vhost keep working: nginx picks our
server block only for the two hostnames above.

## Order of operations

```bash
# 0. from your laptop — read the server first, change nothing
ssh root@SERVER 'bash -s' < infra/deploy/00-inspect.sh

# 1. one-time provisioning (idempotent; refuses to overwrite anything existing)
ssh root@SERVER 'bash -s' < infra/deploy/10-provision.sh

# 2. ship the code and start the services
./infra/deploy/20-release.sh root@SERVER

# 3. certificate (only after DNS for takatracker.com points at this server)
ssh root@SERVER 'bash -s' < infra/deploy/30-tls.sh
```

`20-release.sh` is safe to re-run: it rsyncs, builds, migrates and restarts only
the two `hishab-*` units.

## Rollback

```bash
ssh root@SERVER 'systemctl stop hishab-web hishab-api'
```

Nothing else on the box changes state. To remove Hishab completely:

```bash
ssh root@SERVER 'bash -s' < infra/deploy/99-uninstall.sh
```

## Redis

If the server already runs Redis, Hishab uses logical database `9` on it
(`redis://127.0.0.1:6379/9`) — separate keyspace, no config change to the
existing instance. If Redis is absent, `10-provision.sh` installs one bound to
`127.0.0.1:6390` under its own unit so nothing else can be affected.
