# AGENTIC BUILD PROMPT v2 — "Hishab" Personal Finance Platform

> Paste this whole file as the opening instruction to your coding agent
> (Claude Code, Cursor, Codex). Then work milestone by milestone.
> This supersedes v1. Self-contained — no other document needed.

---

## 0. ROLE & OPERATING RULES

You are a senior full-stack engineer building a production-grade, cross-platform
personal finance application called **Hishab**, shipping as a responsive web app
(installable PWA), an iOS app, and an Android app.

**Rules you must follow throughout:**

1. Work in **milestones** (Section 12). Finish, test, and commit one milestone
   before starting the next. Never skip ahead.
2. Before writing code for a milestone, print a short plan (files you will
   create/modify) and wait for approval.
3. **Never invent business logic.** If a rule is ambiguous (interest formula,
   rounding, timezone, tax), stop and ask. Section 11 lists known unknowns.
4. Money is stored as **integers in the smallest unit** (poisha). No floats
   anywhere in the stack, including JSON payloads.
5. Every schema change goes through a migration. No manual DB edits.
6. Write tests as you go for: ledger balancing, loan amortisation, DPS
   projection, Excel import mapping, **message parsing**, **cross-channel
   duplicate detection**, and sync conflict resolution.
7. No secrets in the repo. `.env` + `.env.example` only.
8. Do not add a dependency without stating why in one line.
9. Conventional commits (`feat:`, `fix:`, `chore:`).
10. Above ~70% context usage, write `PROGRESS.md` handoff notes before continuing.
11. **Nothing in the ingestion pipeline ever writes a real transaction
    automatically.** Every inbound message becomes a _draft_ the user approves.
    This rule has no exceptions in v1.

---

## 1. PRODUCT SUMMARY

A private, offline-first personal accounting app for one user (household sharing
later). It tracks income, expenses, money lent to and borrowed from people,
DPS / recurring savings schemes, insurance policies, and assets vs. liabilities —
and produces AI-written monthly analytics in **Bengali and English**.

It also **ingests transactions automatically** from bank webhooks, Android SMS,
and email alerts, placing each one in a **Draft Inbox** for one-tap approval.

**Primary market:** Bangladesh. Default currency **BDT (৳)**. Must feel native to
bKash / Nagad / Rocket / bank-account users.

**Non-goals (v1):** no direct bank API/open-banking integration, no credit
products, no multi-tenant SaaS billing, no brokerage sync.

---

## 2. TECH STACK (FIXED — do not substitute)

**Monorepo:** pnpm workspaces + Turborepo

```
hishab/
├─ apps/
│  ├─ api/          NestJS 10 (REST) + Prisma + PostgreSQL 16
│  ├─ web/          Next.js 15 (App Router) + Tailwind + shadcn/ui  [PWA]
│  ├─ mobile/       Expo (React Native, expo-router) — iOS + Android
│  └─ worker/       BullMQ workers (parsing, recurring, reports, reminders)
├─ packages/
│  ├─ shared/       TS types, Zod schemas, money & date utils
│  ├─ core/         Pure business logic (ledger, loans, DPS, projections)
│  ├─ parsers/      Message normalisation + template engine + extractors
│  └─ ui/           Design tokens shared by web and mobile
└─ infra/           docker-compose, migrations, deploy scripts
```

- **DB:** PostgreSQL 16 (server), SQLite via `expo-sqlite` (mobile), IndexedDB (web PWA)
- **ORM:** Prisma (server)
- **Data layer:** TanStack Query on web and mobile
- **Auth:** JWT access (15 min) + rotating refresh (30 d), Argon2id, biometric/PIN unlock
- **Queue:** BullMQ + Redis
- **AI:** Anthropic API, **server-side only**. No key ever reaches a client.
- **Charts:** Recharts (web), `react-native-gifted-charts` (mobile)
- **i18n:** `i18next`, locales `bn` (default) and `en`
- **Testing:** Vitest, Supertest, Playwright (web incl. mobile viewports), Maestro (mobile)

`packages/core` and `packages/parsers` must have **zero framework imports** so the
same code runs on server, web, and mobile.

---

## 3. DATA MODEL

Double-entry ledger at the core. The UI hides double-entry; the engine enforces it.

### 3.1 Identity & accounts

```
User(id, email, phone, passwordHash, name, locale='bn',
     baseCurrency='BDT', timezone='Asia/Dhaka', createdAt)

Account(id, userId, name, type, currency, openingBalance, institution,
        accountNumberMasked, matchHints[], isArchived, sortOrder, icon, color)
  type: CASH | BANK | MOBILE_WALLET | CREDIT_CARD | SAVINGS
      | RECEIVABLE | PAYABLE | ASSET | LIABILITY | EQUITY
```

`matchHints[]` holds last-4 digits, wallet numbers, and sender IDs used to route
an inbound message to the right account.

### 3.2 Ledger

```
Transaction(id, userId, date, type, description, notes, payee, personId?,
            projectTag?, attachmentIds[], source, sourceDraftId?, externalRef,
            createdAt, updatedAt, deletedAt)
  type: INCOME | EXPENSE | TRANSFER | LOAN_GIVEN | LOAN_REPAID | BORROWED
      | BORROW_REPAID | SAVINGS_DEPOSIT | SAVINGS_WITHDRAWAL | PREMIUM_PAID
      | ADJUSTMENT | OPENING_BALANCE
  source: MANUAL | SMS | EMAIL | WEBHOOK | OCR | IMPORT | RECURRING

LedgerEntry(id, transactionId, accountId, categoryId?, amountMinor,
            direction, currency, fxRate)
  direction: DEBIT | CREDIT
```

**Hard invariant:** per transaction, `SUM(debits) === SUM(credits)` in base
currency. Enforce in a DB constraint/trigger **and** in `packages/core`. Add a
test that writes an unbalanced transaction and expects failure.

### 3.3 Categories & budgets

```
Category(id, userId, name, nameBn, parentId?, kind, icon, color, isSystem, sortOrder)
  kind: INCOME | EXPENSE
Budget(id, userId, categoryId, period, amountMinor, startDate, rollover)
```

Seed a Bangladesh-appropriate default tree —
Income: বেতন, ব্যবসা, ফ্রিল্যান্স, বাড়ি ভাড়া, মুনাফা/সুদ, উপহার, অন্যান্য.
Expense: খাবার ও বাজার, বাসা ভাড়া, ইউটিলিটি, মোবাইল/ইন্টারনেট, যাতায়াত, স্বাস্থ্য,
শিক্ষা, পোশাক, পরিবার ও সহায়তা, দান/যাকাত, মেরামত, বিনোদন, ব্যাংক চার্জ, অন্যান্য.

### 3.4 People & lending

```
Person(id, userId, name, phone, relation, note, photoUri)
Loan(id, userId, personId, direction, principalMinor, disbursedDate, dueDate?,
     interestType, interestRate?, note, status)
  direction: LENT | BORROWED
  interestType: NONE | SIMPLE | FLAT_MONTHLY
  status: ACTIVE | SETTLED | WRITTEN_OFF
LoanSchedule(id, loanId, dueDate, expectedMinor, status)
LoanPayment(id, loanId, transactionId, date, amountMinor, kind)
```

Derived per loan: outstanding, total repaid, days overdue, next due.
Derived per person: net position.
Reminder feature generates a Bengali message and opens the OS share sheet —
**the app never sends it automatically.**

### 3.5 DPS / savings

```
SavingsPlan(id, userId, institution, planName, planType, installmentMinor,
            frequency, termMonths, startDate, maturityDate, profitRate,
            profitCalc, linkedAccountId, status)
  planType: DPS | FDR | SANCHAYPATRA | RECURRING_DEPOSIT | GOAL_SAVINGS
  profitCalc: SIMPLE | COMPOUND_MONTHLY | COMPOUND_QUARTERLY | COMPOUND_YEARLY
SavingsInstallment(id, planId, dueDate, expectedMinor, paidDate?,
                   transactionId?, status)
```

Display: total deposited, projected maturity, profit to date, missed
instalments, months remaining. Show the formula in a tooltip so the user can
verify it. Do not hardcode any tax/AIT rule — ask.

### 3.6 Insurance, assets, liabilities

```
InsurancePolicy(id, userId, insurer, policyNumberMasked, policyType,
                sumAssuredMinor, premiumMinor, frequency, startDate,
                maturityDate, nomineeName, status)
PremiumPayment(id, policyId, dueDate, paidDate?, transactionId?, amountMinor, status)

Asset(id, userId, name, category, acquiredDate, costMinor, currentValueMinor,
      valuationDate, note)
  category: LAND | PROPERTY | VEHICLE | GOLD | ELECTRONICS | BUSINESS_SHARE | OTHER
Liability(id, userId, name, kind, principalMinor, outstandingMinor,
          interestRate, startDate, endDate, emiMinor)
NetWorthSnapshot(id, userId, asOfDate, assetsMinor, liabilitiesMinor, netMinor)
```

**Net worth = cash & bank + savings plans + assets + receivables − liabilities −
payables.** Always show the breakdown, never a bare number.

### 3.7 INGESTION MODEL (new in v2 — the core of this release)

```
IngestSource(id, userId, channel, label, isActive, createdAt, lastSeenAt,
             config(JSON), secretHash?, defaultAccountId?)
  channel: WEBHOOK | SMS_ANDROID | EMAIL | SHORTCUT | MANUAL_PASTE

InboundMessage(id, userId, sourceId, channel, receivedAt, senderId, subject?,
               bodyRaw(encrypted), bodyRedacted, contentHash, providerMessageId?,
               status, purgeAfter)
  status: RECEIVED | PARSED | UNPARSEABLE | DUPLICATE | DISCARDED

ParsedDraft(id, userId, inboundMessageIds[], proposed(JSON), confidence,
            matchedRuleId?, extractor, status, reviewedAt, transactionId?,
            rejectionReason?, createdAt)
  extractor: TEMPLATE | LLM | HYBRID | WEBHOOK_STRUCTURED
  status: PENDING | NEEDS_REVIEW | APPROVED | REJECTED | MERGED | EXPIRED

ParseRule(id, userId?, provider, channel, pattern, fieldMap(JSON), priority,
          isSystem, isActive, successCount, failCount)

MerchantMapping(id, userId, matchText, matchType, categoryId, accountId?,
                personId?, autoApprove, hitCount)
  matchType: EXACT | CONTAINS | REGEX
```

`proposed` JSON is validated by a Zod schema and holds exactly what a
transaction needs: `{ date, amountMinor, direction, accountId, categoryId,
payee, description, personId?, reference, currency }`.

---

## 4. INGESTION PIPELINE — DETAILED SPEC

This is the highest-value and highest-risk module. Build it exactly as written.

### 4.1 Flow

```
   ┌── Bank/other webhook (HTTPS POST, HMAC-signed)
   ├── Android SMS listener  ──┐
   ├── Email alias (inbound)   ├──▶ InboundMessage (raw stored encrypted)
   └── Manual paste / Shortcut ┘
                                        │
                                        ▼
                          ┌── normalise (trim, unicode, digits, currency)
                          ├── route to account via matchHints / sender
                          ├── TEMPLATE match (ParseRule regex library)
                          ├── if no match or low confidence → LLM extractor
                          ├── apply MerchantMapping → category guess
                          ├── cross-channel DEDUPE / MERGE
                          └── confidence score
                                        │
                                        ▼
                              ParsedDraft (PENDING)
                                        │
                          user approves / edits / rejects
                                        │
                                        ▼
                         Transaction + balanced LedgerEntries
```

### 4.2 Channel A — Webhook (works on every platform, build first)

- `POST /v1/ingest/webhook/:sourceId`
- Auth: `X-Hishab-Signature: sha256=<hmac>` over the raw body using the source
  secret. Reject unsigned, bad-signature, or >5-minute-old timestamps.
- Accept two body shapes:
  1. **Structured:** `{ occurredAt, amount, currency, direction, accountRef,
description, reference, balanceAfter? }` → `extractor = WEBHOOK_STRUCTURED`,
     confidence 1.0.
  2. **Raw text:** `{ receivedAt, sender, text }` → same parsing path as SMS.
- Idempotency: `Idempotency-Key` header or `contentHash`; same payload twice
  creates one draft.
- Per-source rate limit (e.g. 60/min) and a payload size cap (32 KB).
- Respond `202 Accepted` immediately; parse in the worker queue.
- Settings screen: show the URL, let the user **generate/rotate/revoke** the
  secret, show last 20 deliveries with status for debugging.

### 4.3 Channel B — Android SMS

- `BroadcastReceiver` on `SMS_RECEIVED` + a headless JS task that writes to the
  local queue, then syncs up.
- **Filter before storing:** only messages from senders in a configurable
  allowlist (bKash, NAGAD, Rocket, upay, BRAC BANK, CITY BANK, DBBL, EBL, IBBL,
  SCB, MTB, and user-added). Never store personal SMS.
- Runtime permission screen must explain in Bengali exactly what is read, that
  it never leaves the device unencrypted, and that nothing is posted anywhere.
  Include an explicit "শুধু নির্বাচিত প্রেরক" toggle.
- Provide a **backfill** action: scan the last N days of the SMS inbox once,
  with a progress bar and a cancel button.
- Works offline: parse locally with `packages/parsers`, queue drafts, sync later.
- **iOS has no equivalent and never will** — compile the feature out on iOS,
  don't stub it. iOS users get webhook + email.

### 4.4 Channel C — Email

Default approach: **inbound email alias** (no OAuth, no Google review).

- Give each user a unique address, e.g. `u-<random>@in.hishab.app`, generated on
  demand and rotatable.
- The user sets a forwarding rule in Gmail ("from: alerts@bank → forward").
- Receive via an inbound-parse provider (Postmark/Mailgun/SendGrid) or
  Cloudflare Email Workers → `POST /v1/ingest/email` with the same HMAC scheme.
- Verify SPF/DKIM pass on the original sender; drop mail that fails, and drop
  mail whose original sender is not in the user's allowlist.
- Strip HTML to text, take the first 4 KB, discard images and attachments except
  PDF statements (queue those for a later OCR path — v1.1).
- Optional later: Gmail API with `gmail.readonly`. **Do not build this in v1** —
  it triggers Google's restricted-scope security assessment.

### 4.5 Parsing engine (`packages/parsers`)

- **Stage 1 — normalise:** collapse whitespace, convert Bengali digits to ASCII
  for arithmetic (keep the original for display), normalise `Tk`, `BDT`, `৳`,
  `TK.`, thousands separators, and `Fee`/`Charge` lines.
- **Stage 2 — template match:** ordered `ParseRule` regexes per provider with
  named capture groups (`amount`, `balance`, `fee`, `ref`, `counterparty`,
  `datetime`, `direction`). Ship a seed rule set for bKash, Nagad, Rocket, and
  3–4 major banks. Each rule declares which fields it can fill.
- **Stage 3 — LLM fallback:** only when no template matches or a required field
  is missing. Send the **redacted** body (account numbers masked, phone numbers
  masked) with a strict system prompt demanding JSON only. Validate with Zod.
  Reject and mark `NEEDS_REVIEW` if validation fails. Cap LLM calls per user
  per day; never retry more than twice.
- **Stage 4 — enrich:** account routing via `matchHints`, category via
  `MerchantMapping`, person detection for known phone numbers.
- **Stage 5 — score confidence** (0–1):
  amount found `+0.4`, direction found `+0.2`, account matched `+0.2`,
  date parsed `+0.1`, category mapped `+0.1`.
  `≥0.8` → `PENDING` (one-tap approve). `<0.8` → `NEEDS_REVIEW` (fields the user
  must fill are highlighted).
- **Stage 6 — dedupe/merge:** the same real payment often arrives by SMS _and_
  email _and_ webhook. Merge when **same account + same amount + timestamps
  within 10 minutes + (same reference OR similar counterparty)**. The merged
  draft keeps all `inboundMessageIds` as evidence and takes the highest-
  confidence field values. Also check against already-approved transactions in a
  ±3-day window to avoid double entry after a manual add.
- **Stage 7 — learn:** when the user edits a draft before approving, update or
  create a `MerchantMapping`, and increment `failCount` on the rule that got it
  wrong. Show a low-key "এই ধরনের লেনদেন সব সময় ‘যাতায়াত’ ধরব?" toggle.

### 4.6 Draft Inbox UX (this screen decides whether the feature succeeds)

- A badge on the tab bar shows the pending count.
- Grouped: **যাচাই দরকার** (needs review) first, then **অনুমোদনের অপেক্ষায়**.
- Each row shows: proposed amount (mono, right-aligned), payee, guessed
  category, account, source badge (SMS / ইমেইল / ওয়েবহুক), and a confidence dot.
- Interactions: swipe right = approve, swipe left = reject, tap = edit sheet.
  Approve must be **one tap with no confirmation dialog** — and reversible for
  10 seconds via an undo snackbar.
- "সব অনুমোদন করুন" bulk action, but only for the high-confidence group, and it
  shows a count and total before running.
- Every draft has a **"মূল বার্তা দেখুন"** expander showing the raw SMS/email
  text with account numbers masked. Trust comes from being able to check.
- Rejecting asks a one-tap reason (ডুপ্লিকেট / আমার নয় / ভুল পার্স) — this feeds
  rule quality metrics.
- Empty state: "সব হালনাগাদ" plus a link to ingestion settings.
- Optional per-mapping **auto-approve** (off by default). If the user enables it
  for a specific merchant, still write the transaction with `source` set and
  show it in a "স্বয়ংক্রিয়ভাবে যোগ হয়েছে" filter for 7 days so it can be undone.

### 4.7 Ingestion privacy rules (non-negotiable)

- `bodyRaw` encrypted at rest (app-level envelope encryption, key in KMS/env).
- `bodyRedacted` is what any LLM ever sees. Write a test asserting that an
  unredacted body cannot reach the LLM client.
- Default retention: purge `InboundMessage` bodies **90 days** after the draft is
  resolved; user-configurable 7/30/90/forever, with a "সব বার্তা মুছুন" button.
- Ingestion is **opt-in per channel**, with an obvious global kill switch.
- Never store SMS from senders outside the allowlist, not even temporarily.
- Log ingestion events without bodies.

---

## 5. RESPONSIVE WEB / PWA REQUIREMENTS

The browser must be a genuine substitute for the native app.

- **Breakpoints:** 320–479 (small phone), 480–767 (phone), 768–1023 (tablet),
  1024+ (desktop). Design mobile-first; desktop is the enhancement.
- **Navigation:** bottom tab bar ≤767 px (matching the native app), left sidebar
  ≥768 px. Same information architecture in both.
- **Layout:** single column on phone; two-column dashboard on tablet; three-column
  with a persistent detail pane on desktop. No horizontal scrolling ever at
  320 px, tables included — collapse tables to stacked cards below 768 px.
- **Touch:** minimum 44×44 px targets; no hover-only affordances; swipe actions
  on the draft inbox and transaction rows must work with pointer events.
- **Safe areas:** honour `env(safe-area-inset-*)`; `100dvh` not `100vh`;
  `viewport-fit=cover`.
- **Input:** correct `inputmode="decimal"` on money fields, `enterkeyhint`, and a
  keyboard-avoiding layout for the quick-add sheet.
- **PWA:** web app manifest (name, icons 192/512/maskable, `display:standalone`,
  theme color), service worker with app-shell precache + stale-while-revalidate
  for data, offline fallback page, and an "হোম স্ক্রিনে যোগ করুন" prompt
  (custom, shown once, dismissible).
- **Offline on web:** queue mutations in IndexedDB and replay on reconnect using
  the same sync protocol as mobile. Show a persistent "অফলাইন — ৩টি পরিবর্তন
  অপেক্ষমাণ" bar.
- **Performance budget:** LCP < 2.5 s on a mid-range Android over 4G, JS bundle
  < 250 KB gzipped for the initial route, route-level code splitting, virtualised
  transaction list.
- Test with Playwright at 320 px, 390 px, 768 px, and 1280 px on every milestone.

---

## 6. FEATURE SPEC BY SCREEN

1. **Dashboard** — month income/expense/net vs. last month; net worth card with
   breakdown and sparkline; top 5 expense categories; upcoming dues (30 days);
   who owes me / I owe strip; AI insight card; **pending drafts badge**.
2. **Draft Inbox** — per Section 4.6.
3. **Transactions (খাতা)** — infinite list grouped by date, running balance,
   filters (date, account, category, type, person, amount, text, source),
   bulk re-categorise, swipe edit/delete.
4. **Quick add** — big numeric keypad, recent-category chips, one-tap repeat of a
   recent transaction, optional photo and person tag. Target **under 5 seconds**.
5. **Accounts** — balances, transfers, reconcile (enter real balance → creates an
   `ADJUSTMENT`), archive, `matchHints` editor.
6. **People & Loans** — net position per person; loan detail with repayment
   timeline, outstanding, overdue badge; record repayment; generate reminder text.
7. **Savings (DPS/FDR)** — progress ring, projected maturity, next due,
   instalment history, mark-paid creates a real transaction.
8. **Insurance** — policies, premium calendar, paid/unpaid.
9. **Assets & Liabilities** — values, revaluation history, net worth trend.
10. **Reports** — income by category, expense by category, monthly trend, income
    vs. expense, category drill-down, cash-flow statement, balance sheet, yearly
    summary; export any report to PDF/Excel.
11. **Import / Export** — xlsx/csv upload → preview → **column mapping UI** →
    duplicate detection → atomic commit; full export to xlsx (sheet per entity)
    and JSON backup.
12. **AI Analytics** — monthly Bengali report; ask-your-data ("গত ৩ মাসে খাবারে
    কত খরচ?"); anomaly flags; 60-day cash-flow forecast.
13. **Settings** — language, currency, app lock, **ingestion sources** (webhook
    URL + secret, email alias, SMS allowlist, retention, kill switch), categories,
    notifications, backup, export, delete account.

Mobile-only extras: receipt OCR, home-screen widget, Android SMS listener.

---

## 7. AI LAYER RULES

- All model calls in `apps/api`. Clients call `/v1/ai/*`.
- Send **pre-aggregated metrics**, not raw transaction dumps.
- Ask-your-data: the model returns a **JSON query object** validated by Zod
  against a whitelist of dimensions and filters → server runs real SQL → results
  go back to the model for phrasing. **Never execute model-generated SQL.**
- Cache monthly reports in `AiReport`; regenerate on demand or at month close.
- Every AI answer shows the numbers behind it.
- Degrade gracefully: if AI fails, charts and totals still work.
- Per-user monthly token budget with a friendly cap message.

---

## 8. OFFLINE-FIRST SYNC

```
SyncCursor(userId, deviceId, lastPulledAt, lastPushedAt)
ChangeLog(id, userId, entity, entityId, op, payload(JSON), deviceId,
          clientUpdatedAt, serverSeq)
```

- Every mutable table has `updatedAt`, `deletedAt` (soft delete), and `clientId`
  (device-generated UUID) so offline rows keep identity.
- Push changes since `lastPushedAt`; pull server changes since `lastPulledAt`.
- Conflicts: last-write-wins per field by `clientUpdatedAt`, **except** monetary
  amounts, which flag the record for user review.
- Sync must be idempotent — replaying a batch changes nothing.
- Test: two devices edit the same record offline, then both sync.

---

## 9. SECURITY & PRIVACY

- Argon2id hashing; rate-limited auth; refresh-token rotation with reuse detection.
- App lock: PIN + biometric, auto-lock after 60 s in background (configurable).
- Sensitive fields stored masked (`accountNumberMasked`, `policyNumberMasked`).
- HTTPS only, HSTS, strict CORS allowlist, CSP on web.
- Attachments in object storage behind short-lived signed URLs.
- Every query filtered by `userId` at the repository layer — write a test proving
  user A cannot read user B's row by ID.
- Webhook endpoints: HMAC + timestamp + replay cache + rate limit + size cap.
- Full data export and full account deletion must work (store requirement).
- Encrypted local DB on mobile (SQLCipher or equivalent).

---

## 10. UI / UX REQUIREMENTS

- Design tokens live in `packages/ui`, consumed by web and mobile. One palette,
  one type scale, one spacing scale — no per-app forks.
- **Ledger aesthetic** (from the approved demo): ink `#17251E`, income `#1F6F4A`,
  expense `#A8342A`, brass `#8E6C18`, rule `#D6DED0`, paper `#FAFBF7`; alternating
  greenbar row tint; a vertical rule down the amount column.
- **All money in tabular monospace, right-aligned** in a fixed column.
- Bengali-first: `৳`, lakh/crore grouping (`১৮,৪৬,২০০`), optional Bengali numerals.
  Test long Bengali strings at 320 px for overflow.
- Dark mode from day one, system-following default.
- Accessibility: WCAG AA contrast, 44×44 targets, visible focus rings, dynamic
  type, reduced-motion respected, colour never the only signal (overdue = red +
  text + pill).
- Empty states offer a clear first action. Errors say what happened and what to
  do — never a raw code, never an apology.

---

## 11. ASK ME BEFORE ASSUMING

- DPS profit formula, and whether tax/AIT should be modelled
- Whether loans ever accrue interest, and on what basis
- Is BDT-only acceptable for v1?
- Does a second user (spouse) share one dataset in v1?
- Hosting target (own VPS vs. managed) — affects deploy and the email inbound path
- Which banks' SMS and email samples can you supply? (I need 5–10 real, redacted
  samples per provider before writing seed `ParseRule`s)
- Ship v1 with Android SMS, or defer it to v1.1 to avoid Play review delay?
- Free/private only, or a paid tier?

---

## 12. MILESTONES

| #   | Milestone                                                                                                | Done when                                                |
| --- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| M0  | Monorepo, Docker (Postgres+Redis), lint/format/CI, `.env.example`                                        | `pnpm dev` runs api+web+worker; `pnpm test` green        |
| M1  | Auth, User, Account CRUD, category seed                                                                  | Signup → login → create account → balance shows          |
| M2  | Double-entry engine in `packages/core` + Transaction API                                                 | Unbalanced txn rejected; unit tests pass                 |
| M3  | Web: transaction list, add/edit, accounts, transfers                                                     | Full manual bookkeeping works on web                     |
| M4  | **Responsive shell + PWA** (bottom nav ≤767, sidebar ≥768, manifest, SW, offline page)                   | Installable; passes Playwright at 320/390/768/1280       |
| M5  | Reports v1 + filters                                                                                     | Numbers match a hand-checked fixture set                 |
| M6  | Excel/CSV import with mapping UI + export                                                                | 500-row real file imports; duplicates flagged            |
| M7  | **Ingestion core:** `IngestSource`, webhook endpoint (HMAC, idempotency), `InboundMessage`, worker queue | Signed POST creates a draft; replay creates none         |
| M8  | **Parsing engine** (`packages/parsers`): normalise, templates, confidence, seed rules                    | ≥90% correct on a 100-message fixture corpus             |
| M9  | **Draft Inbox UI** (web): review, edit, approve, reject, undo, bulk, evidence view                       | Approve creates a balanced transaction; undo reverses it |
| M10 | Dedupe/merge across channels + LLM fallback extractor                                                    | Same payment via SMS+email yields one draft              |
| M11 | **Email channel:** alias generation, inbound webhook, SPF/DKIM check, allowlist                          | Forwarded bank email lands as a draft                    |
| M12 | People, Loans, repayments, reminder text                                                                 | Lend → partial repay → outstanding correct               |
| M13 | Savings plans + projections; Insurance                                                                   | Projection matches manual calc in tests                  |
| M14 | Assets, Liabilities, Net worth + monthly snapshot job                                                    | Breakdown reconciles with the ledger                     |
| M15 | Mobile app (Expo): auth, dashboard, txn list, quick add, draft inbox, local SQLite                       | Fully usable in airplane mode                            |
| M16 | Sync engine + conflict handling                                                                          | Two-device offline-edit test passes                      |
| M17 | AI layer: monthly Bengali report, ask-your-data, anomalies                                               | Report generated with verifiable numbers                 |
| M18 | Recurring rules, budgets, notifications                                                                  | Due-date notification fires on device                    |
| M19 | **Android SMS channel** + backfill + permission screens                                                  | Sample bKash SMS creates a draft offline                 |
| M20 | Receipt OCR + home-screen widget                                                                         | Photo → prefilled draft                                  |
| M21 | Polish: i18n audit, a11y, dark mode, empty states, perf budget                                           | No truncation at 320 px; LCP < 2.5 s                     |
| M22 | Store prep: icons, screenshots, policy pages, EAS builds                                                 | Signed AAB + IPA; TestFlight + internal track live       |

**Suggested slice for a usable v1:** M0–M11 + M15 + M22. Loans/DPS (M12–M14) and
SMS (M19) can ship as v1.1.

---

## 13. RELEASE / STORE REQUIREMENTS

**Both stores**

- Privacy policy + terms hosted on the web app; account deletion available
  in-app _and_ at a public URL.
- Data safety / privacy nutrition labels filled honestly — **declare the SMS and
  email ingestion accurately**, including that message content is stored.
- Icons, splash, screenshots (6.7"/6.5"/5.5" iOS; phone + 7"/10" tablet Android).

**iOS**

- Expo EAS Build, EAS-managed signing.
- No SMS reading — the feature must be compile-time excluded, not just hidden.
- Justify camera/photo permissions in `Info.plist` strings with the real purpose.
- Any paid tier must use In-App Purchase.

**Android**

- Current target API level; AAB output.
- `READ_SMS` / `RECEIVE_SMS` require a Play Console **Permissions Declaration**
  and a demo video. Budget 1–3 weeks of review risk. Ship v1 without it and add
  it as a separate v1.1 release unless told otherwise.
- Justify or avoid foreground services and exact alarms.

**Release engineering**

- EAS channels: `development`, `preview`, `production`.
- Semantic versioning, maintained `CHANGELOG.md`.
- Crash reporting with PII scrubbing on.
- API versioned under `/v1`; ingestion endpoints versioned separately and never
  broken without a deprecation window.

---

## 14. FIRST TASK

Do **M0 only**:

1. Print the exact folder/file tree you will create.
2. Scaffold the monorepo (pnpm + Turborepo) with `apps/api`, `apps/web`,
   `apps/mobile`, `apps/worker` and `packages/shared|core|parsers|ui`.
3. `infra/docker-compose.yml` with Postgres 16 + Redis 7.
4. Prisma initialised with `User` and `Account` only.
5. ESLint + Prettier + strict TypeScript + Husky pre-commit + GitHub Actions CI.
6. `README.md` with setup steps and `.env.example`.
7. Confirm `pnpm dev` and `pnpm test` run clean.

Then stop and report. Do not start M1.
