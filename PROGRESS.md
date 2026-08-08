# PROGRESS

Handoff notes for Hishab. Keep this current — it is the first thing to read
when picking the project back up.

Last updated: 2026-08-08.

---

## Milestone status

| #       | Milestone                                                         | State       |
| ------- | ----------------------------------------------------------------- | ----------- |
| M0      | Monorepo, Docker (Postgres+Redis), lint/format/CI, `.env.example` | done        |
| M1      | Auth, User, Account CRUD, category seed                           | done        |
| M2      | Double-entry engine in `packages/core` + Transaction API          | done        |
| M3      | Web: transaction list, add/edit, accounts, transfers              | done        |
| M4      | Responsive shell + PWA                                            | done        |
| M23     | Workspaces + `workspaceId` migration                              | done        |
| M24     | Entitlements engine + 402 limit responses                         | done        |
| M36     | Telegram credit-card due reminders                                | done        |
| M25     | Audit log + timeline                                              | done        |
| —       | Category management + asset/liability accounts                    | done        |
| M5      | Reports v1 + filters                                              | done        |
| M6      | Excel/CSV import with mapping UI + export                         | **next**    |
| M7–M11  | Ingestion, parsing, draft inbox, dedupe, email channel            | not started |
| M12–M14 | People/loans, savings/insurance, assets/net worth                 | not started |
| M15–M22 | Mobile, sync, AI, recurring, SMS, OCR, polish, store prep         | not started |

### Acceptance evidence

- `pnpm test` — 181 passing: 16 money, 16 ledger, 18 entitlements, 24 card-reminder, 24 reports, 7 parser, 76 API integration.
- `pnpm test:e2e` — 48 passing (12 specs × 320/390/768/1280 px).
- Unbalanced transaction is rejected by the database trigger, proven by a test
  that bypasses the service layer.
- Workspace isolation holds on every surface that exists: read by ID, write by
  ID, delete, restore, reconcile, both lists, text search, filtering by another
  tenant's account ID, the summary aggregate, categories, and a cross-tenant
  transfer. Each new surface gets a case as it lands.
- A ledger entry whose workspace differs from its transaction's is rejected by
  the database, proven by a test that bypasses the service layer.
- A suspended membership or workspace invalidates an already-issued token on the
  very next request.
- Web bundle: 102 kB shared first-load JS, heaviest route 155 kB — inside the
  250 kB budget.

---

## Loan ledger (M12) — the design, so nobody re-litigates it

Every loan owns a **control account**: `RECEIVABLE` when we lent, `PAYABLE` when
we borrowed, created automatically and named after the counterparty and the loan
number (`করিম — ধার #L-0001`). Disbursement and every repayment are ordinary
double-entry transfers between that control account and a cash or bank account.

This is deliberate, and it is what QuickBooks does. The consequence worth
stating: `packages/core/src/reports.ts` classifies by `ACCOUNT_CLASS`, so loan
movements reach the balance sheet, the cash flow statement and the account
running balance **with no special-casing**, and can never be counted as income
or expense. There is no rule anywhere that says "exclude loans from income" —
the structure makes it impossible. No `INCOME`/`EXPENSE` transaction is ever
written by the loan module, and it never posts to `SYSTEM_INCOME`/`SYSTEM_EXPENSE`.

The second consequence: per-loan statements, running balances and the party
ledger came free, because account-scoped running balances already worked.

Interest is off by default (`NONE`), because most household lending in
Bangladesh carries none. `PERCENT` is **simple** interest over elapsed days and
**stops accruing at the due date** — a household loan does not keep growing
forever after the agreed date. The user types every rate; we infer none.

### Deliberately not built, and why

| Asked for       | Shipped                                      | Why                                                                                                    |
| --------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| PDF export      | Print-to-PDF via a `@media print` stylesheet | A real PDF needs a new dependency. The button says print, so nobody is misled.                         |
| Excel export    | CSV with a UTF-8 BOM                         | The BOM is what makes Bengali survive Excel. A file named `.xlsx` that is really CSV corrupts on open. |
| SMS reminders   | Telegram only                                | No SMS gateway is configured. Telegram reminders (M36) carry loan due dates too.                       |
| Multi-currency  | `currency` column, no conversion             | Storing a currency is not supporting one. No rate source, so no conversion.                            |
| Email reminders | Not yet                                      | M28/M29 own outbound email; the loan reminder hooks into it when it lands.                             |

### Timezone caveat carried by the maths

`packages/core/src/loans.ts` reads dates as **local calendar days**. On a UTC
server with an Asia/Dhaka user that differs by up to six hours at the day
boundary, which can move `daysOverdue` by one. The API must therefore pass dates
already shifted into the workspace timezone, exactly as the card reminder
scheduler does. Flagged rather than silently papered over.

### Defects the loan work turned up elsewhere

Four were in the savings and insurance modules written the same week, found by
their own e2e suite and fixed:

- **Deletion was logged as an update.** Both `savings.remove` and
  `insurance.remove` emitted `*_updated`, so the one event an operator opens an
  audit log to find was the one it did not record.
- **A policy's term and its maturity date could disagree, and both were
  honoured** — a policy maturing in 2030 with premiums scheduled to 2046. The
  date on the document now wins and the term is derived from it.
- **"Next due" skipped a missed instalment**, pointing the saver at a later date
  and quietly dropping the payment actually owed. Insurance already got this
  right; savings now matches it.
- **A yearly plan over a six-month term** passed validation with zero scheduled
  instalments: money attached, nothing to tick off, progress frozen at zero.

Two were in the loan maths itself:

- **A repaid loan reopened the next morning.** Interest stopped at the due date
  but not at settlement, so ৳1,00,000 at 10% settled in full showed ৳27.40
  outstanding the following day and flipped back to ACTIVE. `settlementDate` in
  `packages/core/src/loans.ts` now walks the payments in date order and freezes
  accrual on the day the debt was cleared. It is exported rather than private
  because the API stamps the statement's interest row with it and the web app
  renders progress from it — two copies of that rule would drift, and the first
  symptom would be a statement disagreeing with the summary above it.
- **A back-dated final payment drove the statement negative**, because the
  payment cap was judged as of today while the freeze keys off the payment's own
  date. Both now use the day the money changed hands.

And one in the web forms, shared with savings and insurance:
`Math.trunc(Number('0.29') * 100)` is **28**, not 29 — the float lands a hair
under and truncation removes the hair. Every new form now uses
`parseMoneyToMinor`, which does it with string maths. Bengali digits work as a
side effect.

### Known gap: the e2e specs are not typechecked

`apps/api/tsconfig.json` excludes `test/`, and vitest runs the specs through swc,
which only strips types. So no `*.e2e-spec.ts` in this repo has ever been
typechecked — the new ones were verified against a throwaway config instead.
Worth fixing; recorded here so it is not rediscovered as a surprise.

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

**The tenant guard is `workspaceId`, and the JWT carries it.** `activeWorkspaceId`
rides in the access token, and `JwtStrategy` re-reads the membership on every
request rather than trusting the signature — so suspending a member or a
workspace locks the session out immediately instead of fifteen minutes later
when the token would have expired. Two tests cover exactly that.

**`LedgerEntry` carries a denormalised `workspaceId`.** It removes a join from
every balance aggregate, and it is only safe because a trigger refuses any entry
whose workspace differs from its transaction's — the same belt-and-braces
reasoning as the balance invariant. Both are covered by tests that bypass the
service layer.

**Tenant context instead of a user id.** Services take
`{ id, workspaceId, timezone }`, which `AuthUser` satisfies structurally. The
timezone is already loaded to validate the membership, so this also deleted a
per-request `SELECT` on the user table.

**Plans live in code, not in a migration.** `packages/core/entitlements.ts` is
the catalogue, and the API upserts it at boot. Changing what a tier includes is
then a pull request that every environment converges on, rather than a data
migration that production and development can disagree about. A key removed
from the definition is deleted from the database too, so a retired limit stops
being enforced.

**One entitlement engine, called by both sides.** The API enforces limits with
it and the UI renders quotas with it. A client-side copy of a paywall is how a
paywall drifts out of step with the server that actually charges people, so
`GET /v1/entitlements` returns limits, usage and headroom together and the
accounts screen disables its button before the user can hit a refusal.

**Only creation is metered.** Editing, deleting and restoring a transaction stay
available at the ceiling. Locking someone out of correcting their own books is a
worse outcome than letting a count drift, and archiving an account returns its
slot so the way out of the limit is never "delete your history".

**One official Telegram bot, not a token per user.** A bot token is full control
of that bot, so collecting one per customer would mean operating a store of
thousands of live credentials. Binding stores a `chat_id` — an address, not a
secret — and the single token sits in the server's secret file, out of the
repository. It also makes muting a one-tap inline button inside Telegram, which
a per-user bot cannot offer: a bot has one webhook, and in that design it
belongs to the user.

**Reminders do not stop at the due date.** A cycle's window runs until the next
bill's window opens, so an unpaid card keeps nagging — it is more urgent late,
not less. Coverage is continuous, and only a mute or a recorded payment ends a
cycle. A card added today does not inherit last month's cycle, though: without
that guard the back-to-back windows would invent a debt the card never had.

**An hourly sweep, not a queue.** The job is idempotent by the day
(`CardReminderCycle.lastSentOn`), so a restart, an overlap or a second instance
cannot double-send. BullMQ and a separate worker process would buy scheduling
guarantees this job does not need. Each workspace is served at 09:00 in its own
timezone.

**Report numbers come from a hand-checked fixture.** `packages/core/reports.test.ts`
works one balance sheet out on paper — ten accounts, in taka, in a comment — and
every assertion refers to it. The API suite then repeats the exercise end to end
over a month of transactions. The check that matters most is that cash flow's
closing figure equals the balance sheet's liquid total: if a query ever misses
an entry, those two stop agreeing.

**Categories are exactly two levels deep.** Deeper nesting makes a report
unreadable and a picker unusable on a phone, so a sub-category cannot have
sub-categories. A report folds children into their parent by default —
"যাতায়াত ৳১,০০০" rather than four lines the reader has to add up — and keeps
the parent's own direct spending as a separate figure, or a parent would look
like it had none. A parent whose money is entirely in its children still
appears, otherwise that money would vanish from the report. Drilling into a
parent includes its children, so the total on screen matches the slice tapped.

**A quiet month is a zero, not a gap.** `buildTrend` fills months with no
activity. Omitting them makes a chart draw a straight line across the gap and
invent a trend that never happened.

**Charts are fed poisha, never taka.** Converting to a float and back would
round money, which nothing in this codebase does. The axis divides for display
only and that number never returns to the ledger — the ESLint rule caught the
first attempt.

**Recharts loads after the numbers.** It is larger than the rest of the reports
page put together, so it sits behind `next/dynamic`: the route went from 270 kB
to 155 kB of first-load JS and the cards above the fold render immediately.

**Cascading deletes.** `LedgerEntry.account` originally had no `onDelete`, so
Postgres refused to delete a `User` — the cascade stopped at the ledger. Spec §9
requires full account deletion to work, and both app stores demand it, so
`LedgerEntry.account` now cascades and `category`/`person`/`parent` set null.
Found by trying to delete the post-deploy smoke user on the live box, not in
review. A test now creates a user with a full ledger, deletes the row and
asserts every table is empty.

**A fixed shell, not a scrolling page.** The document is `overflow: hidden`
and a single `<main>` owns scrolling. The title bar and tab bar therefore never
move, the way a native navigation bar and tab bar do not. Browser
pull-to-refresh is off (`overscroll-behavior: none`) because in a standalone
PWA it reloads the shell, which reads as a crash; a rubber-band gesture of our
own replaces it. Everything outside the shell — login, signup, offline — needs
its own `app-scroll` container as a result.

**Keypad instead of the OS keyboard for amounts.** On a coarse pointer the
amount field is `inputMode="none"` and a large keypad renders below it. The
field stays a real labelled input, so assistive technology and tests are
unaffected, but the sheet never gets shoved off-screen mid-entry.

**Undo rather than confirm.** Swipe-left deletes with no dialog, backed by
`POST /v1/transactions/:id/restore` and an eight-second snackbar. A
confirmation would tax every deliberate delete to guard against the rare
accident; an undo does the opposite.

**Tailwind v4 centres with the CSS `translate` property.** It composes with
`transform` instead of replacing it, so a keyframe that also translated -50%
pushed the desktop dialog a full width and height off-screen. Keyframes that
run on positioned elements must animate `transform` only for scale and opacity.
Caught by the e2e suite; the dialog was genuinely unreachable in a real browser.

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
- Audit writes are fire-and-forget, so one can be in flight when a workspace is
  deleted, and Postgres then refuses the delete. Harmless today (deletion is not
  exposed), but M34's deletion pipeline must clear `AuditEvent` inside the same
  transaction rather than racing it.

---

## Plan

The v3 SaaS extension and the Telegram credit-card reminders are reconciled with
v2 in [docs/PLAN.md](./docs/PLAN.md), which is now the authority on ordering and
on the eight points where v2 and v3 disagree. The headline change: **M23
(workspaces) runs before M5**, because M5–M11 add about ten tenant-scoped tables
that would otherwise need migrating twice.

## Questions for the product owner (spec §11)

Superseded by §6 of [docs/PLAN.md](./docs/PLAN.md), which adds the billing,
mailbox-credential and Telegram decisions. Kept here for reference:

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

## Deployment state — LIVE

**https://takatracker.com** — Ubuntu 24.04 at `SERVER_IP`, certificate
valid to 2026-11-04, HTTP redirects to HTTPS, HSTS on.

An earlier target (`OLD_SERVER_IP`) was abandoned: its sshd accepts publickey
only and no usable key was available.

### What else lives on this box

The server is shared, so every choice below exists to keep these untouched:

| Neighbour                           | Where                                     |
| ----------------------------------- | ----------------------------------------- |
| n8n (Docker, compose project `n8n`) | `127.0.0.1:5678` → `automation.example.com` |
| x-ui / xray VPN panel               | its own ports → `vpn.example.com`  |
| `other-bot` (pm2, `/root/other-bot`) | `0.0.0.0:3000`                            |

Verified after the release: system Node still v20.20.2, `other-bot` online
with **0 restarts**, the n8n container never restarted, x-ui active with all
three ports listening, all three nginx vhosts present, and the neighbours'
certificates untouched.

### What Hishab added, and nothing else

| Resource              | Value                                                                |
| --------------------- | -------------------------------------------------------------------- |
| Unix user / directory | `hishab` / `/opt/hishab`                                             |
| Node runtime          | **private** Node 22.17.0 at `/opt/hishab/node`                       |
| Postgres 16 + Redis 7 | Docker compose project `hishab`, `127.0.0.1:5433` / `127.0.0.1:6380` |
| API / web             | `127.0.0.1:4600` / `127.0.0.1:3600`, loopback only                   |
| systemd               | `hishab-api.service`, `hishab-web.service`                           |
| nginx                 | `/etc/nginx/sites-available/takatracker.com`                         |
| TLS                   | `certbot --cert-name takatracker.com`                                |

Two decisions were forced by what was already running:

**Private Node.** The box runs Node v20.20.2 system-wide and the pm2 app
`other-bot` depends on it. Installing Node 22 from NodeSource would have
replaced it and could have taken that app down, so Hishab unpacks its own Node
under `/opt/hishab/node` (checksum-verified official tarball) and the systemd
units point at it. `/usr/bin/node` is never touched.

**Dockerised database.** No Postgres or Redis existed on the host. Rather than
add two more system services, Hishab runs them as its own compose project with
its own named volumes, bound to loopback on non-default ports. `docker compose
-f /opt/hishab/stack/docker-compose.yml down -v` removes them completely and
cannot affect the n8n project.

`www.takatracker.com` has no DNS record, so the certificate covers the apex
only. Add the A record and re-run `30-tls.sh` to include it.

### Pre-deploy backup

`/root/backups-before-hishab/` on the server holds the nginx tree, the systemd
directory, the docker process list and the pm2 dump taken immediately before
provisioning.

### Operating it

```bash
systemctl status hishab-api hishab-web
journalctl -u hishab-api -f
docker compose -f /opt/hishab/stack/docker-compose.yml ps

./infra/deploy/20-release.sh root@SERVER_IP   # ship a new version
```

Releases are timestamped under `/opt/hishab/releases/` with `current` as a
symlink; the last five are kept. Rolling back is repointing the symlink and
restarting the two units.

The production database is empty: the post-deploy smoke user was removed after
the checks, which is also how the cascade fix was verified live.
