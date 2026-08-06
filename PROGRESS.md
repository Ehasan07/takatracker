# PROGRESS

Handoff notes for Hishab. Keep this current — it is the first thing to read
when picking the project back up.

Last updated: 2026-08-06.

---

## Milestone status

| #       | Milestone                                                         | State       |
| ------- | ----------------------------------------------------------------- | ----------- |
| M0      | Monorepo, Docker (Postgres+Redis), lint/format/CI, `.env.example` | done        |
| M1      | Auth, User, Account CRUD, category seed                           | done        |
| M2      | Double-entry engine in `packages/core` + Transaction API          | done        |
| M3      | Web: transaction list, add/edit, accounts, transfers              | done        |
| M4      | Responsive shell + PWA                                            | done        |
| M5      | Reports v1 + filters                                              | next        |
| M6      | Excel/CSV import with mapping UI + export                         | not started |
| M7–M11  | Ingestion, parsing, draft inbox, dedupe, email channel            | not started |
| M12–M14 | People/loans, savings/insurance, assets/net worth                 | not started |
| M15–M22 | Mobile, sync, AI, recurring, SMS, OCR, polish, store prep         | not started |

### Acceptance evidence

- `pnpm test` — 60 passing: 16 money, 16 ledger, 7 parser, 21 API integration.
- `pnpm test:e2e` — 36 passing (9 specs × 320/390/768/1280 px).
- Unbalanced transaction is rejected by the database trigger, proven by a test
  that bypasses the service layer.
- User A cannot read, edit or delete user B's rows by ID (test asserts 404 on
  accounts, transactions, PATCH and cross-account transfer).
- Web bundle: 102 kB shared first-load JS, heaviest route 155 kB — inside the
  250 kB budget.

---

## Decisions taken

**Money.** `BIGINT` poisha in Postgres, `bigint` in Prisma, integer JSON number
on the wire via a `BigInt.prototype.toJSON` that throws above `Number.MAX_SAFE_INTEGER`.
`Int` would have capped a single amount at ৳2.1 crore, which land and property
values exceed.

**Hidden nominal accounts.** The spec's `LedgerEntry` requires an `accountId`,
but income and expense are categories, not accounts. Three system accounts per
user (`SYSTEM_INCOME`, `SYSTEM_EXPENSE`, `SYSTEM_EQUITY`, marked by a new
nullable `Account.systemKey`) carry the other side of each entry, with the
category recorded on that line. They are filtered out of every account list and
cannot be edited or archived.

**`/api/*` is a route handler, not a `next.config` rewrite.** Rewrites are baked
into the build manifest at build time, so the API address could not be changed
at deploy time — the built image would always point at localhost:4000. The
handler in `apps/web/src/app/api/[...path]/route.ts` resolves
`API_INTERNAL_URL` per request. In production nginx sends `/api/` straight to
the API and never reaches this handler.

**Service worker: network-first for data, not stale-while-revalidate.** The
spec asks for stale-while-revalidate on data. For money that is wrong: it hands
the page the previous balance immediately after a write, so a just-added
transaction appears to have vanished. Data is now network-first with the cache
as an offline-only fallback; the app shell is still precached. This was found by
an e2e test, not in review.

**No-store on API responses.** The API sets
`Cache-Control: no-store, no-cache, must-revalidate, private` on every response
and the Next proxy re-asserts it. Without it the browser heuristically cached
`GET /api/v1/accounts` and served a stale balance after a write — an
intermittent failure that looked like flakiness.

**Zod instead of class-validator.** All request validation uses the same Zod
schemas from `packages/shared` that the client uses, through a small
`ZodValidationPipe`. Nest's `ValidationPipe` was removed; it pulls in
`class-validator` and would have meant two sources of truth for the contract.

**Non-default local ports.** Postgres on 5433 and Redis on 6380, because the
developer machine already runs another project's Postgres and Redis on the
defaults. Same reasoning applies on the server (4600/3600, loopback only).

---

## Known gaps and follow-ups

- `apps/mobile` is a reserved workspace with a README only. Installing Expo now
  would slow every install for no M0–M4 benefit; it lands in M15.
- `packages/parsers` has stage 1 (normalise) and the redaction helpers only.
  Templates, LLM fallback, confidence and dedupe are M8–M10.
- The transaction list "আরও দেখুন" button re-fetches rather than appending —
  real cursor pagination and list virtualisation belong with M5's filters.
- Dark mode follows the OS and the settings toggle, but there is no
  server-persisted preference yet.
- The offline queue replays mutations in order and drops any the server rejects
  with a 4xx. Conflict handling proper is M16.
- CI installs Playwright's Chromium on every run; consider caching the browser.

---

## Questions for the product owner (spec §11)

None of these block M5, but M12–M14 cannot be built without answers:

1. DPS profit formula, and whether tax/AIT should be modelled at all.
2. Do loans accrue interest, and on what basis (simple, flat monthly)?
3. Is BDT-only acceptable for v1? The schema keeps `currency` and `fxRate` so
   this is a data change, not a migration.
4. Does a spouse share one dataset in v1, or is household sharing post-v1?
5. Real, redacted SMS and email samples — 5–10 per provider (bKash, Nagad,
   Rocket, and the banks you use) — before any seed `ParseRule` is written.
6. Ship v1 with the Android SMS channel, or defer it to v1.1 to avoid the Play
   Console permissions review?
7. Free/private only, or a paid tier?

---

## Deployment state

Target: **takatracker.com → OLD_SERVER_IP** (Cloudflare DNS, A record already
pointing there; the box currently serves the default nginx page).

The server runs other projects, so `infra/deploy/` is written to be additive
only — new user, new directory, new database, new units, one new vhost, one new
certificate. `00-inspect.sh` reads the box and changes nothing; run it first.

**Blocked:** the server accepts neither the supplied root password
(`PasswordAuthentication` is off) nor either existing key. Install this deploy
key and the release can proceed:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHSiVwJtz+h3D75+tAscTBAgu5p4ufSRplUdIzKBTxni takatracker-deploy
```

Add it to `/root/.ssh/authorized_keys` via the hosting console, or re-enable
password login with
`sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config && systemctl reload ssh`.
