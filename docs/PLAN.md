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

| 9 | — | — | **New in this plan:** credit-card due reminders over Telegram (§2), and the decision to run one official bot rather than store a bot token per user. |

Nothing else conflicts. v3 Part E's freeze list — double-entry engine, integer
minor units, draft-inbox approval, ledger visual language, offline sync,
Bengali-first — is already how the built code works and stays untouched.

---

## 2. New in this plan: credit-card due reminders over Telegram (M36)

Not in either source document. Specified here in full.

### 2.1 What it does

A user configures their own Telegram bot and chat. When an account of type
`CREDIT_CARD` has a due day recorded, Hishab sends that chat a reminder **every
day**, starting a configurable number of days before the due date, until the
user stops it from inside the app. Stopping silences **that billing cycle
only**; the next month's cycle starts reminding again on its own.

### 2.2 Delivery: one official bot, not one bot per user

**Decision: Hishab runs a single official bot and users bind their chat to it
with one tap. Bringing your own bot stays available as an advanced option.**

This reverses the original sketch, for one reason that outweighs the rest:

> Asking every user for a bot token means **operating a store of thousands of
> live credentials**. A Telegram bot token is not a chat address — it is full
> control of that bot: read everything sent to it, send as it, reconfigure it.
> A breach of that table hands an attacker every one of those bots. With the
> official bot we store a `chat_id`, which is an address rather than a secret,
> and the single token we do hold sits in KMS under our control and can be
> rotated in one action.

The rest follows from that:

|                           | Official bot (default)                                                   | User's own bot (advanced)                             |
| ------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------- |
| Setup                     | tap a link, press Start                                                  | BotFather, `/newbot`, copy token, find chat ID, paste |
| What we store             | `chatId` — an address                                                    | a live credential, one per user                       |
| If our database leaks     | attacker can message our users _from our bot_ — phishing, no data access | attacker controls every user's bot                    |
| Mute from inside Telegram | yes, inline button                                                       | no — a bot has one webhook and it is theirs           |
| Suits                     | everyone                                                                 | the privacy-conscious and self-hosters                |

The honest cost of the official bot: one token that can message every customer.
That is a phishing risk, not a data-access risk — the bot can only send, and it
never holds ledger data. It is a smaller exposure than N user credentials, and
it is one secret to guard instead of a table of them.

```
TelegramConnection(id, workspaceId, userId, mode, chatId?,
                   botTokenRef?, botUsername?,
                   bindingTokenHash?, bindingExpiresAt?,
                   isEnabled, verifiedAt?, status,
                   failureCount, lastError?, lastSentAt?,
                   createdAt, revokedAt?)
  mode:   SHARED_BOT | OWN_BOT
  status: PENDING | ACTIVE | AUTH_FAILED | DISABLED | REVOKED
```

- One row per member, so each person in a shared workspace gets their own chat.
- `botTokenRef` is null in `SHARED_BOT` mode. In `OWN_BOT` mode it points at the
  secret store and **the token is treated exactly like an IMAP password (v3
  §C6):** envelope-encrypted, write-only through the API, masked in every
  response, redacted from every log, error and AI prompt, with a test asserting
  it cannot appear in a serialised error.
- `isEnabled` is the explicit opt-in tick and cannot be set until `verifiedAt`
  is. Verification is the binding handshake in shared mode, or a successful test
  message in own-bot mode. **A chat ID nobody checked is the easiest way to send
  someone else's card balance to a stranger.**

**Binding handshake (shared mode).** The app opens
`https://t.me/<HishabBot>?start=<binding-token>`. That token is opaque,
single-use, hashed at rest and expires in fifteen minutes. Telegram delivers
`/start <token>` to our webhook; we match it, store the `chat_id`, mark the
connection verified and reply with a confirmation. Nothing is typed. The webhook
is guarded by Telegram's `secret_token` header, rate-limited, and accepts
nothing beyond `/start`, `/stop` and the mute callback.

### 2.3 Card fields and cycle state

Added to `Account`, meaningful only when `type = CREDIT_CARD`:

```
statementDayOfMonth  Int?   // 1–31, when the bill is generated (optional)
dueDayOfMonth        Int?   // 1–31, when payment is due
reminderLeadDays     Int?   // null = fall back to the workspace default
```

Workspace defaults: `creditCardReminderLeadDays` (7, allowed 1–28) and
`autoMuteOnCardPayment` (**true**, see §2.5).

```
CardReminderCycle(id, workspaceId, accountId, cycleMonth, dueDate,
                  windowStart, windowEnd,
                  mutedAt?, mutedByUserId?, mutedReason?,
                  lastSentOn?, sentCount)
  mutedReason: MANUAL | PAID
  @@unique([accountId, cycleMonth])       // cycleMonth is 'YYYY-MM'
```

Muting writes `mutedAt` on the current cycle row. Next month is a different
`cycleMonth`, so a fresh row appears and reminders resume on their own — no
scheduled un-mute, no state to clean up.

### 2.4 Dates and the reminder window

- The due date for cycle `YYYY-MM` is day `dueDayOfMonth` of that month,
  **clamped to the last day of the month**. A card due on the 31st is due on
  28 February, not 3 March.
- All dates are computed in the workspace timezone (`Asia/Dhaka` by default),
  reusing `packages/shared/src/date.ts`. No new date logic.
- **The window runs from `dueDate − leadDays` until the next cycle's window
  opens.** Passing the due date does not stop the reminders — an unpaid card is
  more urgent after the deadline, not less. Coverage is therefore continuous:
  the moment the next bill's window starts, the new cycle row takes over.
- Only two things end a cycle early: the user muting it, or a payment being
  recorded (§2.5).
- The wording escalates once the date passes — `আর ৫ দিন` becomes
  `৩ দিন পার হয়েছে`. The same message repeating unchanged for weeks is how a
  notification turns into background noise.

### 2.5 Stopping: by payment, or by hand

Both, and the automatic one is on by default.

**Automatically, when the bill is paid.** Money moving _into_ the card account —
a transfer from a bank or cash account, or a balance adjustment — dated inside
the current window mutes that cycle with `mutedReason = PAID`. This reads the
ledger the app already keeps; it asks the user for nothing. Governed by
`autoMuteOnCardPayment`, which can be switched off.

**By hand.** A **এই মাসের রিমাইন্ডার বন্ধ করুন** action on the account screen
sets `mutedReason = MANUAL`. In shared-bot mode the same action is an inline
button on the Telegram message, so it takes one tap without opening the app; the
callback is signed and scoped to that single cycle.

Either way the mute is per cycle. Next month reminds again.

### 2.6 Worker

A BullMQ repeatable job, hourly, firing for each workspace at 09:00 in its own
timezone:

1. Load credit-card accounts that are not archived and have `dueDayOfMonth` set.
2. Compute the current cycle and due date; upsert the `CardReminderCycle` row.
3. Skip if muted, if `lastSentOn` is already today (the idempotency guard — a
   worker restart must never double-send), or if today is outside the window.
4. Skip if the member has no `ACTIVE`, enabled, verified connection.
5. Send, then set `lastSentOn` and increment `sentCount`.

Message, carrying the numbers so the user can act without opening anything:

```
💳 ক্রেডিট কার্ড পেমেন্ট বাকি

কার্ড:      ব্র্যাক ব্যাংক ****4521
বকেয়া:     ৳৪২,৩৫০.০০
শেষ তারিখ:  ১২ আগস্ট ২০২৬ (আর ৫ দিন)

[ এই মাসের জন্য বন্ধ করুন ]      ← inline button, shared-bot mode
https://takatracker.com/accounts
```

**Failure handling.** `403` means the user blocked the bot, `400` a bad chat ID;
both set `AUTH_FAILED`, stop sending and raise an in-app notice. `429` is
honoured via `retry_after` with backoff. Three consecutive failed days set
`DISABLED`. Never a tight retry loop — Telegram blocks the IP.

### 2.7 Settings screen

Under Settings → **টেলিগ্রাম নোটিফিকেশন**:

- **Default path:** one button, **টেলিগ্রামে সংযুক্ত করুন**, opening the
  official bot with the binding token. The user presses Start and is finished.
  No tutorial, because there are no steps.
- **Advanced expander, "নিজের বট ব্যবহার করুন":** the BotFather walkthrough —
  `/newbot`, copy the token, message the bot once because a bot cannot open a
  conversation, then **পরীক্ষা করুন** sends a real test message. The
  **নোটিফিকেশন চালু** tick unlocks only once it succeeds.
- Also here: days of notice before the due date (workspace default, overridable
  per card), the auto-stop-on-payment toggle, connection status, when the last
  message went out, and **সংযোগ বিচ্ছিন্ন করুন**, which revokes and deletes any
  stored token in the same action.

### 2.8 Where it sits in the plan

- Entitlement key `notifications.telegram` (v3 §A2), so plans can gate it.
- Audit events for bind, unbind, test, revoke and mute (v3 §A3).
- The shared bot needs a webhook route on `takatracker.com`, its token in the
  secret store, and a documented rotation procedure.
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

| Phase    | Milestones                 | Rationale                                                                               |
| -------- | -------------------------- | --------------------------------------------------------------------------------------- |
| **Done** | M0–M4, M23, M24, M36       | Live. Workspaces 07-08, entitlements + Telegram reminders 08-08.                        |
| **Next** | **M25**                    | Audit log — every later feature registers against it.                                   |
| A        | —                          | (M24 done; M25 is now the Next row.)                                                    |
| B        | M5, M6                     | Reports and Excel import: the two things that make the app useful enough to charge for. |
| C        | M30                        | Signup, verification, password reset, sessions, onboarding.                             |
| D        | —                          | (M36 done, brought forward: the owner supplied a bot.)                                  |
| E        | M7–M9                      | Ingestion core, parser, draft inbox — the highest-value feature in the product.         |
| F        | M26, M27                   | SMS build split and the automation replacements. Pairs naturally with ingestion.        |
| G        | M31, M33, M34              | Billing, observability, legal and backups. Sellable from here.                          |
| H        | M10, M11                   | Dedupe/LLM fallback, email alias channel.                                               |
| I        | M15, M16                   | Mobile app and sync.                                                                    |
| J        | M28, M29                   | IMAP mailbox connector — deliberately last of the ingestion work, see §6.               |
| K        | M12–M14, M17–M22, M32, M35 | Loans, savings, net worth, AI, polish, store prep, admin, launch.                       |

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

**Billing (M31) — decided 2026-08-08, defaults chosen on the owner's "go ahead"**

1. **Web-only selling.** The mobile apps sign in to an existing account and
   never mention price, purchase or upgrade — that is what keeps them outside
   Apple's In-App Purchase rule and its commission. A 402 in the app says the
   plan is exhausted and stops there; it does not link to a checkout. If in-app
   upgrade is ever wanted, it means StoreKit plus server-side receipt
   reconciliation, and it is a separate decision.
2. **SSLCommerz first for BDT**, because it settles to a Bangladeshi bank
   account and supports cards, bKash, Nagad and Rocket through one integration.
   International sale is deferred: a Bangladeshi entity generally cannot hold a
   direct Stripe account, and Paddle as merchant-of-record is the fallback when
   there is demand — it also absorbs VAT, which we otherwise would not want to
   compute per country.
3. **Two public tiers, FREE and PRO**, already live in
   `packages/core/entitlements.ts`. PRO is priced at ৳499/month as a
   placeholder. Prices are a data change, not a code change, so this can move
   without a migration.

Still genuinely open, and only when billing is actually built: annual pricing,
trial length, and whether a lapsed subscription drops to FREE or to read-only.

**Blocking the mailbox connector (M28–M29)** 4. v3's own warning, repeated because it is the sharpest risk in the system: an
app password grants access to the **entire mailbox**, not just bank mail. The
allowlist is enforced by our code, not by the provider, so a breach of that
table is worse than a breach of the ledger. Restrict it to a paid tier, or
drop Tier 2 entirely and wait for OAuth?

**Telegram reminders (M36) — decided, recorded for the record**

- Reminders continue past the due date until the next bill's window opens. Only
  a mute or a recorded payment stops them.
- Recording a payment auto-stops that cycle. On by default; the manual control
  stays.
- One official Hishab bot with tap-to-bind is the default; bring-your-own-bot is
  an advanced option. Rationale in §2.2 — it removes a store of thousands of
  live credentials.

Operational consequence of the official bot: a bot registered with BotFather
under a Hishab account, its token in KMS, a webhook endpoint on
`takatracker.com`, and a rotation runbook.

**Loans and savings (M12–M14) — decided 2026-08-08**

Follow standard Bangladeshi and international practice, and **let the user enter
the rate** rather than hardcoding one:

- **DPS / recurring deposits:** monthly instalments compounded, with the
  frequency chosen per plan — `profitCalc` already models SIMPLE,
  COMPOUND_MONTHLY, COMPOUND_QUARTERLY and COMPOUND_YEARLY. The user types the
  advertised rate; we never infer it. Every projection shows its formula in a
  tooltip so the number can be checked against the bank's own statement.
- **Loans between people:** interest is optional and **off by default**, because
  most household lending in Bangladesh carries none. When it is on, the user
  picks `NONE`, `SIMPLE` or `FLAT_MONTHLY` and types the rate.
- **Tax and AIT are not modelled.** Excise duty and AIT on profit vary by
  balance band and by year, and quietly applying the wrong deduction is worse
  than showing the gross figure. Projections are labelled as before tax, with a
  field for the user to record what their bank actually deducted.

**Still blocking the parser seed rules (M8) — deferred by the owner**

5–10 real, redacted SMS and email samples per provider: bKash, Nagad, Rocket and
the banks actually in use. Nothing useful can be written without them, so M8
waits. M7 — the ingestion core and the webhook endpoint — does not depend on
them and can proceed.

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
