# Hishab — consolidated plan (v2 + v3 + Telegram reminders)

One plan, reconciling three inputs:

- `hishab-agentic-build-prompt-v2_1.md` — the product and technical spec (M0–M22)
- the v3 SaaS extension — multi-tenancy, private SMS, mailbox ingestion (M23–M35)
- credit-card due reminders over Telegram (M36, specified below)

**Where they disagree, this document is the authority.** Section 1 lists every
conflict and how it is resolved, so neither source is followed blindly.

Status: **M0–M4 built, tested and live at https://takatracker.com.** Nothing
from M5 onward exists yet — which changes the ordering, see §4.

---

## 1. Conflicts between v2 and v3, and how they are resolved

| #   | v2 says                                                                          | v3 says                                               | Resolution                                                                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | §1 non-goals: "no multi-tenant SaaS billing" in v1                               | Part 0: single-user → multi-tenant SaaS               | **v3 wins.** v2's non-goal is superseded. But v3 A1 also says one workspace per account ships first: the _model_ is multi-tenant, the _UX_ stays single-workspace until a flag turns sharing on.                                                                                                                |
| 2   | §11 open question: "does a spouse share one dataset in v1?"                      | A1: model exists, sharing is a later feature flag     | **Question closed.** Build `Membership` now, expose no invite UI until the flag.                                                                                                                                                                                                                                |
| 3   | M19 + §13: ship Android SMS, budget 1–3 weeks for a Play Permissions Declaration | Part B: SMS leaves the public product entirely        | **v3 wins.** v2's M19 is replaced by v3's M26 (build split) + M27 (automation replacements). No Play declaration is ever filed.                                                                                                                                                                                 |
| 4   | §3.1 `User.baseCurrency`, `User.timezone`                                        | A1 `Workspace.currency`, `Workspace.timezone`         | **Split by meaning.** Workspace owns `currency` and `timezone` — they scope money and define the ledger day. User keeps `locale` (display language) and gains `notifyTimezone` for when reminders are sent. Concrete impact: `TransactionsService` currently reads `user.timezone`; it must read the workspace. |
| 5   | §7: per-**user** monthly AI token budget                                         | D4: per-**workspace** metering                        | **v3 wins.** The budget is an entitlement (`ai.tokens.monthly.max`) on the workspace.                                                                                                                                                                                                                           |
| 6   | §9: "every query filtered by `userId`; test that user A cannot read user B"      | A1: filter by `workspaceId`; wider test surface       | **v3 wins.** The existing isolation test is rewritten, not deleted — see §3.                                                                                                                                                                                                                                    |
| 7   | §13: "any paid tier must use In-App Purchase"                                    | D1: sell on the web only, app never mentions purchase | **Both are true and it is a business decision.** Web-only selling avoids the commission and the IAP build; it also means the app may not link to pricing at all. Listed as a decision in §6.                                                                                                                    |
| 8   | §4.4: "do not build Gmail API in v1"                                             | Part C: IMAP app-password now, OAuth later            | **Compatible.** v2 forbade OAuth, not IMAP. Tier 1 (forwarding alias) stays the default; Tier 2 (IMAP) is opt-in and marked "উন্নত".                                                                                                                                                                            |

Nothing else conflicts. v3 Part E's freeze list — double-entry engine, integer
minor units, draft-inbox approval, ledger visual language, offline sync,
Bengali-first — is already how the built code works and stays untouched.

---

## 2. New in this plan: Telegram credit-card due reminders (M36)

Not in either source document. Specified here in full.

### 2.1 What it does

A user configures their own Telegram bot and chat. When an account of type
`CREDIT_CARD` has a due day recorded, Hishab sends that chat a reminder **every
day**, starting a configurable number of days before the due date, until the
user stops it from inside the app. Stopping silences **that billing cycle
only**; the next month's cycle starts reminding again on its own.

### 2.2 Model

```
TelegramConnection(id, workspaceId, userId, label,
                   botTokenRef, chatId, botUsername?,
                   isEnabled, verifiedAt?, status,
                   failureCount, lastError?, lastSentAt?,
                   createdAt, revokedAt?)
  status: PENDING | ACTIVE | AUTH_FAILED | DISABLED | REVOKED
```

- One row per member, so each person in a shared workspace gets their own chat.
- `botTokenRef` points at the secret store. **The bot token is a credential and
  is handled exactly like an IMAP password (v3 §C6):** envelope-encrypted,
  write-only through the API, masked in every response, redacted from every log,
  error and AI prompt, with a test asserting it cannot appear in a serialised
  error.
- `isEnabled` is the explicit opt-in tick. It cannot be set until `verifiedAt`
  is set, and `verifiedAt` is only set by a **successful test message** — a
  typed chat ID that nobody checked is the easiest way to send someone else's
  card details to a stranger.

Added to `Account` (only meaningful when `type = CREDIT_CARD`):

```
statementDayOfMonth  Int?   // 1–31, when the bill is generated (optional)
dueDayOfMonth        Int?   // 1–31, when payment is due
reminderLeadDays     Int?   // null = fall back to the workspace default
```

Workspace default: `creditCardReminderLeadDays` (default 7, allowed 1–28).

Per-cycle state, which is what makes "stop for this month" work:

```
CardReminderCycle(id, workspaceId, accountId, cycleMonth, dueDate,
                  mutedAt?, mutedByUserId?, lastSentOn?, sentCount)
  @@unique([accountId, cycleMonth])       // cycleMonth is 'YYYY-MM'
```

Muting writes `mutedAt` on the current cycle row. Next month is a different
`cycleMonth`, so a new row is created and reminders resume with no user action —
which is exactly the requested behaviour, and it needs no scheduled un-mute.

### 2.3 Due-date arithmetic

- The due date for cycle `YYYY-MM` is day `dueDayOfMonth` of that month,
  **clamped to the last day of the month**. A card due on the 31st is due on
  28 February, not 3 March.
- All dates are computed in the workspace timezone (`Asia/Dhaka` by default),
  reusing `packages/shared/src/date.ts`. No new date logic.
- The reminder window is `dueDate − leadDays … dueDate` inclusive. Whether it
  continues _past_ the due date is a decision — see §6.

### 2.4 Worker

A BullMQ repeatable job, once an hour, sending to each workspace at 09:00 in its
own timezone:

1. Load credit-card accounts that are not archived and have `dueDayOfMonth` set.
2. Compute the current cycle and due date; upsert the `CardReminderCycle` row.
3. Skip if muted, if `lastSentOn` is already today (this is the idempotency
   guard — a worker restart must never double-send), or if today is outside the
   window.
4. Skip if the member has no `ACTIVE`, enabled, verified connection.
5. Send, then set `lastSentOn` and increment `sentCount`.

Message (Bengali), carrying the numbers so the user can act without opening the
app:

```
💳 ক্রেডিট কার্ড পেমেন্ট বাকি

কার্ড:      ব্র্যাক ব্যাংক ****4521
বকেয়া:     ৳৪২,৩৫০.০০
শেষ তারিখ:  ১২ আগস্ট ২০২৬ (আর ৫ দিন)

অ্যাপে গিয়ে পেমেন্ট লিখলে বা এই মাসের রিমাইন্ডার বন্ধ করলে
আর মনে করিয়ে দেওয়া হবে না।
https://takatracker.com/accounts
```

**Failure handling.** Telegram returns `403` when the user blocks the bot and
`400` for a bad chat ID; both set `AUTH_FAILED`, stop sending and raise an
in-app notice. `429` is honoured via `retry_after` with backoff. Three
consecutive failed days set `DISABLED`. Never a tight retry loop.

### 2.5 Settings screen

Under Settings → **টেলিগ্রাম নোটিফিকেশন**, with the tutorial inline (no external
link) because this is the step users get stuck on:

1. Open `@BotFather` in Telegram → `/newbot` → copy the token.
2. Send your new bot any message (a bot cannot start a conversation).
3. Get your chat ID — a "how" expander showing the `getUpdates` URL.
4. Paste both, press **পরীক্ষা করুন** — a real test message is sent.
5. Only after the test succeeds does the **নোটিফিকেশন চালু** tick become
   available.

Also on the screen: how many days before the due date to remind (workspace
default, overridable per card), the connection's current status, when the last
message was sent, and **সংযোগ বিচ্ছিন্ন করুন** which revokes and deletes the
stored token in one action.

### 2.6 Where it sits in the plan

- Entitlement key `notifications.telegram` (v3 §A2), so plans can gate it.
- Audit events for connect, test, revoke and mute (v3 §A3).
- v2's M18 "notifications" stays as in-app and device push; Telegram is a
  separate channel, not a replacement.
- **Build it after M23**, so the tables are born with `workspaceId` rather than
  being migrated twice.

---

## 3. M23 — the table-by-table migration (v3 Part G, item 1)

v3 assumes the whole v2 codebase exists. It does not: only M0–M4 are built, so
today's migration touches **five** tables instead of eighteen. Everything v3
lists that does not yet exist must simply be **created with `workspaceId` from
the start** — that rule matters more than the migration itself.

### Tables that exist today

| Table          | Fate                                              | Why                                                                                                                                                                                                                                                                   |
| -------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `User`         | unchanged, global                                 | Identity. A person may later belong to several workspaces.                                                                                                                                                                                                            |
| `RefreshToken` | keeps `userId` only                               | A session belongs to a person, not a tenant.                                                                                                                                                                                                                          |
| `Account`      | `userId` → `workspaceId`                          | Tenant data. Index `(workspaceId, isArchived, sortOrder)`.                                                                                                                                                                                                            |
| `Category`     | `userId` → `workspaceId`                          | Tenant data. Index `(workspaceId, kind, sortOrder)`.                                                                                                                                                                                                                  |
| `Person`       | `userId` → `workspaceId`                          | Tenant data.                                                                                                                                                                                                                                                          |
| `Transaction`  | gains `workspaceId`; `userId` → `createdByUserId` | Scoped by workspace, but _who entered it_ matters once a workspace has several members. Index `(workspaceId, date desc)`.                                                                                                                                             |
| `LedgerEntry`  | gains `workspaceId` (denormalised)                | v3 lists it. Balance aggregation currently joins through `Transaction`; a direct column removes that join. **Risk:** it can drift from its transaction, so a DB trigger enforces equality — the same belt-and-braces approach already used for the balance invariant. |

### Tables not yet built — created with `workspaceId` on day one

`Budget`, `Loan`, `LoanSchedule`, `LoanPayment`, `SavingsPlan`,
`SavingsInstallment`, `InsurancePolicy`, `PremiumPayment`, `Asset`, `Liability`,
`NetWorthSnapshot`, `IngestSource`, `InboundMessage`, `ParsedDraft`,
`ParseRule` (user rules), `MerchantMapping`, `AiReport`, `ChangeLog`,
`SyncCursor`, plus v3's `EmailConnection` and this plan's `TelegramConnection`
and `CardReminderCycle`.

### Also in M23

- `Workspace`, `Membership`, `Invitation` per v3 §A1.
- Backfill: one workspace per existing user, `OWNER` membership, every row
  assigned. Production currently holds **1 user and 0 transactions**, so the
  backfill is trivial — another reason to do this now.
- Repository guard moves from `userId` to `workspaceId`.
- JWT gains `activeWorkspaceId`; refresh rotation preserves it; switching
  workspace reissues both tokens.
- `Workspace.currency` and `Workspace.timezone` become the source of truth;
  `TransactionsService.timezone()` stops reading `user.timezone`.

### Isolation test, rewritten

The existing test proves user A cannot reach user B's rows by ID. It is
rewritten to workspaces and extended to every surface **that exists**, with the
rest added as each is built:

| Surface                             | Now                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------ |
| REST by ID (accounts, transactions) | covered today, port to workspaces                                        |
| List and search (`q`, filters)      | add                                                                      |
| Category and reconcile endpoints    | add                                                                      |
| Export                              | when M6 lands                                                            |
| AI query                            | when M17 lands                                                           |
| Sync pull                           | when M16 lands                                                           |
| Webhook ingestion                   | when M7 lands                                                            |
| Telegram send                       | when M36 lands — a reminder must never quote another workspace's balance |

---

## 4. Revised milestone order

v2 suggested M0–M11 + M15 + M22 for v1. v3's minimum sellable slice is M23, M24,
M25, M26, M30, M31, M33, M34. Interleaving them, one ordering constraint
dominates everything else:

> **M23 must come before M5.** M5–M11 introduce roughly ten new tenant-scoped
> tables. Built first, every one of them needs migrating a second time, and the
> isolation test gets rewritten twice. Done now — with one user and no
> transactions in production — the migration is nearly free.

| Phase    | Milestones                 | Rationale                                                                                                                                           |
| -------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Done** | M0–M4                      | Live.                                                                                                                                               |
| **Next** | **M23**                    | Workspaces, before anything else adds tables.                                                                                                       |
| A        | M24, M25                   | Entitlements and audit — every later feature registers against them.                                                                                |
| B        | M5, M6                     | Reports and Excel import: the two things that make the app useful enough to charge for.                                                             |
| C        | M30                        | Signup, verification, password reset, sessions, onboarding.                                                                                         |
| D        | **M36**                    | Telegram + credit-card reminders. Small, self-contained, visibly valuable, and it exercises the worker before the ingestion pipeline depends on it. |
| E        | M7–M9                      | Ingestion core, parser, draft inbox — the highest-value feature in the product.                                                                     |
| F        | M26, M27                   | SMS build split and the automation replacements. Pairs naturally with ingestion.                                                                    |
| G        | M31, M33, M34              | Billing, observability, legal and backups. Sellable from here.                                                                                      |
| H        | M10, M11                   | Dedupe/LLM fallback, email alias channel.                                                                                                           |
| I        | M15, M16                   | Mobile app and sync.                                                                                                                                |
| J        | M28, M29                   | IMAP mailbox connector — deliberately last of the ingestion work, see §6.                                                                           |
| K        | M12–M14, M17–M22, M32, M35 | Loans, savings, net worth, AI, polish, store prep, admin, launch.                                                                                   |

M19 is deleted; M26 and M27 replace it.

---

## 5. What is already built, and what M23 changes in it

| Built                                                           | Change needed                                                                       |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Prisma schema (7 models)                                        | 5 tables re-scoped, 3 new tables, indexes                                           |
| `AuthService` signup/login/refresh                              | Create a workspace + owner membership at signup; put `activeWorkspaceId` in the JWT |
| `JwtStrategy`                                                   | Resolve and validate the active membership, not just the user                       |
| `AccountsService`, `TransactionsService`, categories controller | Guard on `workspaceId`; read the timezone from the workspace                        |
| System accounts (`SYSTEM_INCOME` / `EXPENSE` / `EQUITY`)        | Become workspace-scoped; `@@unique([workspaceId, systemKey])`                       |
| Category seed at signup                                         | Seeds the workspace                                                                 |
| Isolation test                                                  | Rewritten per §3                                                                    |
| Cascade deletion test                                           | Deleting a workspace must clear its ledger; deleting a user must not orphan one     |
| Deploy scripts, nginx, TLS, CI                                  | No change                                                                           |

The double-entry engine, money handling, the DB balance trigger, the PWA shell
and the native mobile behaviour are all untouched by M23.

---

## 6. Decisions needed before the work they block

Carried over from v2 §11, plus new ones from v3 and the Telegram feature.
None block M23.

**Blocking billing (M31)**

1. Sell on the web only, or build iOS In-App Purchase? Web-only is cheaper and
   avoids the commission, but the app may then not mention prices at all.
2. Payment provider: SSLCommerz, bKash Merchant, ShurjoPay for BDT — and Paddle
   or Stripe for international? A Bangladeshi entity usually cannot hold a
   direct Stripe account; confirm before designing around it.
3. Plan tiers and prices, and which feature keys each tier unlocks.

**Blocking the mailbox connector (M28–M29)** 4. v3's own warning, repeated because it is the sharpest risk in the system: an
app password grants access to the **entire mailbox**, not just bank mail. The
allowlist is enforced by our code, not by the provider, so a breach of that
table is worse than a breach of the ledger. Restrict it to a paid tier, or
drop Tier 2 entirely and wait for OAuth?

**Blocking Telegram reminders (M36)** 5. Should reminders continue _after_ the due date if nothing is recorded, or
stop on the due date? (Recommendation: keep going for three days, then stop —
a missed card payment is expensive.) 6. Should recording a payment against the card auto-stop that cycle's reminders?
You specified a manual stop; auto-stop is strictly friendlier, and the manual
control stays either way. Default off unless you say otherwise. 7. One shared bot for all users, or each user brings their own? This plan
assumes **their own**, as you described. A shared Hishab bot would be far
easier for users (no BotFather steps) but puts us in the position of holding
one token that can message every customer.

**Blocking loans and savings (M12–M14)** 8. DPS profit formula, and whether tax/AIT is modelled. 9. Do loans accrue interest, and on what basis?

**Blocking the parser seed rules (M8)** 10. 5–10 real, redacted SMS and email samples per provider — bKash, Nagad,
Rocket, and the banks you actually use. Nothing useful can be written
without them.

---

## 7. Standing rules for every milestone from here

1. Every new tenant-scoped table is created with `workspaceId` and a compound
   index. No exceptions, no "migrate it later".
2. Every new surface that returns data gets a cross-workspace isolation test in
   the same commit.
3. Credentials — IMAP passwords, Telegram bot tokens, webhook secrets — are
   envelope-encrypted, write-only, masked on read, and covered by a test that
   asserts they cannot reach a log or an error payload.
4. Nothing auto-commits a transaction. Every ingested message becomes a draft
   the user approves, whatever the channel or plan (v2 rule 11, v3 Part E).
5. Money stays an integer number of poisha at every layer.
6. Both invariants stay enforced twice — in `packages/core` and in the database.
