# Taka Tracker

**হিসাব** — a private, offline-first personal accounting app for Bangladesh.
Income, expenses, money lent and borrowed, DPS/savings, insurance, assets vs.
liabilities — with AI-written monthly analytics in Bengali and English.

Ships as a responsive installable PWA (this repo), with iOS and Android to
follow from the same business-logic packages. Inside the code the product is
called Hishab, which is why every package is `@hishab/*`.

Live at **[takatracker.com](https://takatracker.com)**.

<p>
  <img src="docs/screenshots/desktop.png" alt="Taka Tracker home page on a laptop" width="74%">
  <img src="docs/screenshots/mobile.png" alt="Taka Tracker home page on a phone" width="21%">
</p>

---

## Status

Shipped: **M0–M7**, **M12**, **M13**, **M23–M25**, **M30** and **M36** —
monorepo and infrastructure, auth and account lifecycle, the double-entry
engine, the transaction API, manual bookkeeping and the responsive PWA shell on
the web, reports and filters, spreadsheet import/export, inbound ingestion,
people and loans, savings and insurance, workspaces, entitlements, the
append-only audit log, and Telegram credit-card due reminders.

Next: **M8–M11** (parser templates, the draft inbox, dedupe, the email channel),
**M14** (assets and net worth), then **M15+** (mobile, sync, AI).

See [PROGRESS.md](./PROGRESS.md) for exactly what is done, what is next and the
decisions taken along the way.

## Layout

```
hishab/
├─ apps/
│  ├─ api/       NestJS 10 + Prisma + PostgreSQL 16   (REST under /v1)
│  ├─ web/       Next.js 15 App Router + Tailwind v4  (installable PWA)
│  ├─ worker/    BullMQ workers (parsing, recurring, reports, reminders)
│  └─ mobile/    Expo — reserved, lands in M15
├─ packages/
│  ├─ shared/    TS types, Zod schemas, money & date utils
│  ├─ core/      Pure business logic (double-entry ledger, category seed)
│  ├─ parsers/   Message normalisation and redaction (templates land in M8)
│  └─ ui/        Design tokens shared by web and mobile
└─ infra/        docker-compose for local Postgres/Redis, deploy scripts
```

`packages/core` and `packages/parsers` have **zero framework imports**, so the
same code runs on the server, in the browser and in React Native.

## Money

Money is an **integer number of poisha** (1/100 BDT) everywhere: in Postgres
(`BIGINT`), in TypeScript, and in JSON. No float touches an amount at any layer.
`packages/shared/src/money.ts` is the only place that parses or formats it, and
ESLint fails the build on `Math.round`.

## Getting started

```bash
cp .env.example .env          # ports here are deliberately non-default
pnpm install
pnpm db:up                    # Postgres 16 on :5433, Redis 7 on :6380
pnpm db:migrate               # creates the schema + the balance trigger
pnpm db:seed                  # optional: demo@takatracker.com / hishab1234
pnpm dev                      # api :4000, web :3000, worker
```

Open http://localhost:3000.

The browser only ever talks to its own origin: `/api/*` is proxied to the API by
`apps/web/src/app/api/[...path]/route.ts`, so session cookies are first-party
and there is no CORS preflight. In production nginx short-circuits `/api/`
straight to the API.

### Tests

Both suites truncate every table in the database they are pointed at, so each
has its own throwaway database. Create and migrate them once — `migrate deploy`
creates the database if it does not exist:

```bash
cd apps/api
DATABASE_URL="postgresql://hishab:hishab@localhost:5433/hishab_test?schema=public" pnpm exec prisma migrate deploy
DATABASE_URL="postgresql://hishab:hishab@localhost:5433/hishab_e2e?schema=public"  pnpm exec prisma migrate deploy
```

Then, from the repo root:

```bash
pnpm test        # 558 tests in 24 files
pnpm test:e2e    # 84 Playwright tests: 21 specs × 320 / 390 / 768 / 1280 px
pnpm lint
pnpm typecheck
```

Of those 558: 381 in `packages/core` (ledger, reports, loans, savings, import,
ingestion, entitlements, card reminders), 16 money in `packages/shared`, 7 in
`packages/parsers`, 5 import-parsing in `apps/web`, and 149 API integration
tests across 13 suites in `apps/api`. Of the 84 Playwright tests, 3 skip by
design — one loan spec only means anything at 320 px.

**The API suite will not run against a database whose name is not
`hishab_test`, `hishab_e2e` or something ending `_test`.** `pnpm test` truncates
every table, and `apps/api/src/app.module.ts` loads the repo-root `.env` — so
without that guard a bare `pnpm test` after `pnpm db:seed` would destroy your
working data. `apps/api/vitest.config.ts` defaults `DATABASE_URL` to
`hishab_test`; `apps/api/test/harness.ts` refuses anything that overrides it
with a non-test name.

The e2e suite works the same way: `apps/web/playwright.config.ts` defaults to
`hishab_e2e`, override it with `E2E_DATABASE_URL`, and `e2e/global-setup.ts`
truncates it before the run and fails the run outright if it cannot reach it.
It needs `psql` on `PATH`.

CI (`.github/workflows/ci.yml`) runs exactly these commands against Postgres on
5433 and Redis on 6380 — the same ports as `pnpm db:up`, so a green CI run and a
green laptop run mean the same thing.

## The double-entry invariant

Every transaction satisfies `SUM(debits) = SUM(credits)` in base currency. This
is enforced **twice**:

1. in `packages/core` (`assertBalanced`) before anything is written, and
2. by a deferred constraint trigger in Postgres
   (`apps/api/prisma/migrations/*_ledger_balance_trigger`), so no code path —
   import, worker, sync, or a human at `psql` — can write a lopsided
   transaction.

Both are covered by tests, including one that bypasses the service layer
entirely and expects the database to refuse the write.

The UI never shows debits and credits. Three hidden nominal accounts
(`SYSTEM_INCOME`, `SYSTEM_EXPENSE`, `SYSTEM_EQUITY`) created at signup absorb
the other side of every entry, and `expandSimpleTransaction` turns what the user
typed into balanced lines.

## Deployment

See [infra/deploy/README.md](./infra/deploy/README.md). The scripts are written
for a **shared server**: they only ever create `hishab-*` resources and a single
`takatracker.com` nginx vhost, and they refuse to overwrite anything they did
not create.

## Documentation

- [docs/PLAN.md](./docs/PLAN.md) — **the consolidated plan.** v2 + the v3 SaaS
  extension + Telegram credit-card reminders, with every conflict between them
  resolved. Read this before the source specs.
- [PROGRESS.md](./PROGRESS.md) — milestone status, decisions, open questions
- [docs/SAAS-ARCHITECTURE.md](./docs/SAAS-ARCHITECTURE.md) — tenant isolation, packages and super-admin control
- [docs/ACCOUNTING-AUDIT.md](./docs/ACCOUNTING-AUDIT.md) — where the ledger stands against accounting practice
- [docs/specs/](./docs/specs/) — the original v2 specification and the v3 SaaS extension

## Security

Found a vulnerability? Please report it privately, not in a public issue. See
[SECURITY.md](./SECURITY.md).
