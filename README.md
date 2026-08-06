# হিসাব — Hishab

A private, offline-first personal accounting app for Bangladesh. Income,
expenses, money lent and borrowed, DPS/savings, insurance, assets vs.
liabilities — with AI-written monthly analytics in Bengali and English.

Ships as a responsive installable PWA (this repo), with iOS and Android to
follow from the same business-logic packages.

Production: **https://takatracker.com** — live, M0–M4 deployed.

---

## Status

Milestones **M0–M4** are complete: monorepo, auth, the double-entry engine, the
transaction API, full manual bookkeeping on the web, and the responsive PWA
shell. See [PROGRESS.md](./PROGRESS.md) for exactly what is done, what is next
and the decisions taken along the way.

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

```bash
pnpm test        # 60 tests: money, ledger engine, parsers, API integration
pnpm test:e2e    # 36 Playwright tests at 320 / 390 / 768 / 1280 px
pnpm lint
pnpm typecheck
```

The e2e suite runs against its own database (`hishab_e2e`) and truncates it
before each run:

```bash
cd apps/api && DATABASE_URL="postgresql://hishab:hishab@localhost:5433/hishab_e2e?schema=public" pnpm exec prisma migrate deploy
```

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

- [PROGRESS.md](./PROGRESS.md) — milestone status, decisions, open questions
- [hishab-agentic-build-prompt-v2_1.md](./hishab-agentic-build-prompt-v2_1.md) — the full product and technical specification
