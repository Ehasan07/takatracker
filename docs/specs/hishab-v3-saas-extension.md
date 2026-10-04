# HISHAB — v3 EXTENSION: SaaS Conversion, Private SMS, Mailbox Ingestion

> **This is an extension, not a replacement.** It assumes the v2 codebase is
> already built and running. Do not rewrite v2 — migrate it.
> Give this document to the agent alongside v2, then work through Part F's
> milestones one at a time.

---

## PART 0 — WHAT CHANGES AND WHY

Three shifts from v2:

1. **Single-user → multi-tenant SaaS.** Self-serve signup, plans, billing,
   admin back-office, audit trail, per-tenant observability.
2. **SMS ingestion leaves the public product.** It stays as an owner-only
   feature in a private build. The store apps ship without SMS permissions at
   all, so no Play Permissions Declaration is needed.
3. **Email ingestion gains a mailbox connector.** Users authorise their own
   mailbox and Hishab reads matching messages directly, in addition to the
   existing forwarding alias.

**Terminology correction the agent must not get wrong:** SMTP _sends_ mail. To
_read_ a mailbox you need **IMAP** or a provider API (Gmail API, Microsoft
Graph). Every "connect your email" flow in this document is IMAP or OAuth.
There is no SMTP read path.

---

## PART A — MULTI-TENANCY REFACTOR (do this first, it touches everything)

### A1. Workspace layer

```
Workspace(id, name, ownerUserId, planId, status, currency, timezone,
          trialEndsAt, createdAt, deletedAt)
  status: TRIALING | ACTIVE | PAST_DUE | SUSPENDED | CANCELLED

Membership(id, workspaceId, userId, role, invitedBy, joinedAt, status)
  role: OWNER | ADMIN | MEMBER | VIEWER

Invitation(id, workspaceId, email, role, tokenHash, expiresAt, acceptedAt)
```

**Migration:** add `workspaceId` to every tenant-scoped table
(`Account`, `Transaction`, `LedgerEntry`, `Category`, `Budget`, `Person`,
`Loan`, `SavingsPlan`, `InsurancePolicy`, `Asset`, `Liability`,
`IngestSource`, `InboundMessage`, `ParsedDraft`, `MerchantMapping`,
`AiReport`, `ChangeLog`, `NetWorthSnapshot`). Backfill by creating one
workspace per existing user and setting `workspaceId` accordingly. Keep
`userId` on rows that record _who_ did something; `workspaceId` is what scoping
uses from now on.

- Move the tenant guard from `userId` to `workspaceId` in the repository layer.
- Add a compound index `(workspaceId, <primary sort column>)` on every large table.
- **Rewrite the isolation test:** a member of workspace A must not read any row
  of workspace B — by ID, by search, by export, by AI query, by webhook.
- The JWT carries `activeWorkspaceId`; switching workspace reissues the token.
- v1 of the SaaS ships **one workspace per account**; the model exists so
  household/team sharing is a feature flag later, not a migration.

### A2. Entitlements

```
Plan(id, code, name, priceMinor, currency, interval, isPublic, sortOrder)
PlanFeature(id, planId, featureKey, limitValue)   // null = unlimited
WorkspaceFeatureOverride(id, workspaceId, featureKey, limitValue, expiresAt, note)
```

Feature keys to define now:
`accounts.max`, `transactions.monthly.max`, `ingest.channels`,
`ingest.messages.monthly.max`, `ai.tokens.monthly.max`, `ai.reports.enabled`,
`export.enabled`, `attachments.storage.mb`, `members.max`,
`email.connections.max`, `sms.channel` (default `false` for every public plan).

Single source of truth: `packages/core/entitlements.ts` with
`can(workspace, featureKey)` and `remaining(workspace, featureKey)`. Both the
API and the UI call it — never duplicate the rules in the frontend.
When a limit is hit, return `402` with a machine-readable
`{ featureKey, limit, used, upgradeUrl }` so the client can show a real message
rather than a generic error.

### A3. Audit log

```
AuditEvent(id, workspaceId, actorUserId?, actorType, action, entity, entityId,
           before(JSON)?, after(JSON)?, ip, userAgent, createdAt)
  actorType: USER | SYSTEM | SUPPORT | INTEGRATION
```

Log at minimum: login, failed login, password change, member invite/remove,
plan change, ingest source created/rotated/revoked, **email connection added or
removed**, retention setting changed, bulk approve, export, account deletion,
and every support-impersonation session. Append-only; never exposed cross-tenant.

---

## PART B — SMS BECOMES OWNER-ONLY

### B1. Build separation

Two Expo build variants driven by `app.config.ts` and EAS profiles:

| Profile      | Distribution                          | SMS              |
| ------------ | ------------------------------------- | ---------------- |
| `production` | App Store + Play Store                | **compiled out** |
| `personal`   | internal / sideloaded APK, owner only | enabled          |

- The public Android manifest must contain **no** `READ_SMS`, `RECEIVE_SMS`, or
  `RECEIVE_MMS`. Not commented out — absent. Add a CI check that greps the
  generated `AndroidManifest.xml` of the `production` build and fails if any SMS
  permission appears. This check is what keeps Play review clean.
- All SMS code sits behind `process.env.EXPO_PUBLIC_ENABLE_SMS === 'true'` and
  lives in `apps/mobile/src/features/sms/` so it can be excluded at bundle time.
- Play Store listing and data-safety form: remove every SMS reference.
- iOS is unaffected — it never had SMS.

### B2. Server side

- `channel: SMS_ANDROID` remains in the schema and parser, but creating an
  `IngestSource` with that channel requires `sms.channel = true` on the
  workspace. Reject with `403` otherwise.
- Grant that override only to the owner's own workspace, via
  `WorkspaceFeatureOverride`, with a note recording why.

### B3. What public users get instead

Document these in the app's ingestion settings, because they replace SMS
without any permission from you:

1. **Webhook + automation app (Android).** The user runs Tasker / MacroDroid /
   Automate, matches SMS from their bank, and POSTs the text to their personal
   Hishab webhook URL. The permission lives in _their_ automation app, not
   yours. Ship a one-tap "copy my webhook URL" and a ready-made MacroDroid
   template file.
2. **iOS Shortcuts automation.** A "When I receive a message from <sender>"
   automation that posts the text to the webhook. Ship a downloadable shortcut.
3. **Email forwarding alias** (already built in v2).
4. **Mailbox connection** (Part C).
5. **Manual paste.** A "বার্তা পেস্ট করুন" box in the draft inbox that runs the
   same parser. Cheap to build, and it is the fallback that always works.

Add `channel: AUTOMATION` as a labelled variant of `WEBHOOK` so the UI can show
the user which of their sources is which.

---

## PART C — MAILBOX INGESTION (IMAP)

### C1. Three tiers — build in this order

| Tier | Method                              | Works with                                                          | Credential risk | Status             |
| ---- | ----------------------------------- | ------------------------------------------------------------------- | --------------- | ------------------ |
| 1    | Forwarding alias                    | everything                                                          | none            | already built (v2) |
| 2    | **IMAP + app password**             | Gmail (with 2FA), Yahoo, Zoho, cPanel/custom domains, most BD hosts | high            | build now          |
| 3    | OAuth (Gmail API / Microsoft Graph) | Gmail, Outlook/M365                                                 | low             | later, see C5      |

Keep Tier 1 as the **default** in the UI. Present Tier 2 as "উন্নত" with a plain
explanation of what access is granted. Most users should never need Tier 2.

### C2. Model

```
EmailConnection(id, workspaceId, label, provider, host, port, security,
                username, credentialRef, authType, folder, senderAllowlist[],
                sinceDate, pollIntervalSec, lastSyncAt, lastUid, status,
                failureCount, lastError, createdAt, revokedAt)
  provider: GMAIL | YAHOO | ZOHO | OUTLOOK | CUSTOM_IMAP
  authType: APP_PASSWORD | OAUTH
  security: SSL_TLS | STARTTLS
  status: PENDING | ACTIVE | AUTH_FAILED | DISABLED | REVOKED
```

`credentialRef` points at the secret store — **the password itself never lives
in this table and never appears in any API response, log, error message, or
AI prompt.**

### C3. Connection flow

1. User picks a provider. For Gmail, show the exact steps: enable 2-Step
   Verification → create an App Password → paste it. State plainly that a
   regular Gmail password will not work.
2. **Sender allowlist is mandatory** — the connection cannot be saved with an
   empty allowlist. Pre-fill common BD bank and wallet sender domains, and let
   the user add more.
3. Optional folder/label scope, default `INBOX`. Recommend in-copy that the
   user create a Gmail filter that labels bank mail and point Hishab at that
   label only.
4. "Test connection" runs a read-only login, confirms the folder exists, and
   reports how many allowlisted messages exist in the last 30 days — then
   disconnects. Nothing is imported yet.
5. Backfill is explicit and bounded: the user chooses 7 / 30 / 90 days, sees a
   progress bar, and can cancel.

### C4. Sync worker

- Poll every `pollIntervalSec` (default 900 s; minimum 300 s), or use IMAP IDLE
  where the server supports it. Track `lastUid` per folder for incremental fetch.
- **Fetch headers first.** Discard anything whose sender is not in the allowlist
  _before_ downloading the body. Never store non-matching mail, not even briefly.
- Fetch `text/plain` only; if absent, strip the HTML server-side. Cap at 8 KB.
  Ignore attachments in v1.
- Verify the message is not a forward of something already ingested — reuse the
  v2 dedupe rules, keyed on `Message-ID` as well.
- Feed the body into the existing parse pipeline; the resulting `ParsedDraft`
  is identical in every way to a webhook or SMS draft. **The draft inbox does
  not change.**
- Never mark messages read, never move, never delete. Open the mailbox read-only.
- On auth failure: retry twice, then set `AUTH_FAILED`, stop polling, and
  notify the user in-app and by email. After 3 consecutive failed days, set
  `DISABLED`. Never retry in a tight loop — providers will block the IP.
- Per-workspace concurrency limit of 1, and a global connection pool cap, so one
  large mailbox cannot starve the queue.

### C5. Why OAuth is deferred

- Gmail's `gmail.readonly` is a **restricted scope**: it requires an annual
  third-party CASA security assessment with real recurring cost, plus a
  verification review that takes weeks.
- Microsoft removed Basic Auth for IMAP in Exchange Online, so **Outlook/M365
  users cannot use Tier 2 at all** — they must use the forwarding alias until
  Microsoft Graph OAuth is built. Say this in the UI rather than letting them
  fail at connection time.
- Plan Tier 3 for after the product has paying users. Design `EmailConnection`
  now so `authType: OAUTH` slots in without a migration.

### C6. Non-negotiable security rules

- Envelope encryption: a per-workspace data key wrapped by a master key held in
  KMS or an env-injected secret, never in the database.
- Credentials are write-only through the API. `GET` returns a masked stub.
- Redact credentials in every log, Sentry frame, and error payload. Write a test
  that asserts a credential string cannot appear in a serialized error.
- Show the user, on the connection screen: what Hishab reads, what it never
  reads, retention period, and a one-tap **"সংযোগ বিচ্ছিন্ন করুন ও সব বার্তা মুছুন"**
  that revokes and purges in the same action.
- Log every connection create/revoke/auth-failure to `AuditEvent`.
- Document in the privacy policy that mailbox credentials are stored encrypted,
  and name the subprocessors involved.

> Blunt note for the product owner, to be surfaced in the agent's plan: an app
> password grants access to the **entire mailbox**, not just bank mail. The
> allowlist is enforced by your code, not by the provider. That makes a breach
> of this table far more damaging than a breach of the transaction data itself.
> Treat this connector as the highest-risk component in the system, and consider
> making it a paid-tier-only feature so the blast radius stays small.

---

## PART D — COMMERCIAL LAYER

### D1. Billing

- **Bangladesh:** SSLCommerz or bKash Merchant / ShurjoPay for BDT.
- **International:** Stripe (Bangladesh entities usually cannot hold a direct
  Stripe account — check before assuming; Paddle as merchant-of-record is the
  common workaround and also handles VAT).
- Model: `Subscription`, `Invoice`, `PaymentAttempt`, `WebhookEvent` (idempotent
  by provider event ID). Never derive entitlement from a client claim — always
  from a verified provider webhook.
- Dunning: 3 retries, then `PAST_DUE` (read-only access), then `SUSPENDED` after
  14 days, then export-only for 30 days before deletion.

**App-store rule that changes the design:** selling a subscription _inside_ the
iOS app requires In-App Purchase and its commission. The simplest compliant
path is to sell only on the web, and have the mobile app sign in to an existing
account without mentioning purchase, prices, or upgrade links anywhere in the
app. If you want in-app upgrade later, implement IAP + `StoreKit` and reconcile
receipts server-side. Decide this before building the paywall UI.

### D2. Accounts & onboarding

Email verification, password reset, session list with revoke, optional 2FA
(TOTP), workspace creation on signup, guided setup (create accounts → choose
categories → connect an ingest source → import Excel), sample-data mode so a new
user sees a populated dashboard before entering anything real.

### D3. Admin back-office (separate app or a guarded route)

Workspace search, plan and override management, subscription state, ingestion
health per workspace, parse-failure inspection, support impersonation that is
**time-boxed, consent-gated, audit-logged, and visibly banner-marked in the UI**,
refunds, abuse suspension, and a global kill switch per ingest channel.

### D4. Metering & cost control

Meter AI tokens, inbound messages, storage, and API calls per workspace per
month. Enforce plan limits at the entitlement layer. Template-first parsing
already keeps LLM cost low — track the template-vs-LLM ratio as a business
metric, because it is your gross margin.

### D5. Observability (this is what keeps SaaS alive)

- **Parse failure rate per provider per day**, with an alert when it moves more
  than 20% — a bank changing its SMS or email format breaks every user at once,
  and you must find out before they do.
- Ingestion lag, queue depth, IMAP auth-failure count, webhook 4xx/5xx rate.
- Uptime checks, error tracking with PII scrubbing, structured logs with
  `workspaceId` but never message bodies.
- A status page, and an in-app banner when a channel is degraded.

### D6. Legal & trust

Terms of service, privacy policy (naming what is stored, for how long, and every
subprocessor), a data-processing description, cookie/consent handling on the
marketing site, data residency statement, and a documented breach-response plan.
Public pages: `/privacy`, `/terms`, `/security`, `/delete-account`.

### D7. Backup & recovery

Nightly encrypted Postgres backups with **restore actually tested** on a
schedule, point-in-time recovery, a documented RTO/RPO, and a runbook. A finance
app that loses data has no second chance.

---

## PART E — WHAT NOT TO CHANGE

Do not touch these while doing the SaaS conversion:

- The double-entry engine and its invariants.
- Money as integer minor units.
- The draft-inbox approval model — **nothing auto-commits**, regardless of
  channel or plan.
- The ledger visual language and design tokens.
- The offline-first sync protocol.
- Bengali-first i18n.

---

## PART F — MILESTONES (continuing v2's numbering)

| #   | Milestone                                                                                               | Done when                                               |
| --- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| M23 | Workspace + Membership models, full `workspaceId` migration and backfill                                | Cross-workspace isolation test passes on every surface  |
| M24 | Entitlements engine + `402` limit responses + UI limit states                                           | Downgrading a plan visibly restricts features           |
| M25 | Audit log + admin-visible timeline                                                                      | Every action in A3 produces an event                    |
| M26 | SMS split: build variants, manifest CI check, server feature gate                                       | `production` manifest has zero SMS permissions          |
| M27 | Automation replacements: `AUTOMATION` source label, MacroDroid template, iOS Shortcut, manual-paste box | A pasted bKash SMS creates a draft                      |
| M28 | `EmailConnection` model, secret store, envelope encryption, test-connection flow                        | Credential never returned or logged; test asserts it    |
| M29 | IMAP sync worker: incremental fetch, allowlist-before-body, backfill, failure handling                  | Gmail app-password connection produces drafts           |
| M30 | Signup, verification, password reset, sessions, 2FA, guided onboarding                                  | New user reaches a populated dashboard unaided          |
| M31 | Plans, billing provider, webhooks, dunning, subscription lifecycle                                      | Paid signup → active → past due → suspended all work    |
| M32 | Admin back-office + impersonation with consent and audit                                                | Support can diagnose a parse failure without raw bodies |
| M33 | Observability: parse-failure alerting, ingestion dashboards, status page                                | A simulated format change fires an alert                |
| M34 | Legal pages, data export, deletion pipeline, backup restore drill                                       | A restore from backup is performed and documented       |
| M35 | Pricing page, marketing site, trial flow, launch checklist                                              | End-to-end signup to paid, on a real device             |

**Minimum sellable slice:** M23, M24, M25, M26, M30, M31, M33, M34.
M28–M29 (IMAP) can ship after launch — the forwarding alias already covers
email, and deferring the credential store removes the largest security exposure
from your launch.

---

## PART G — FIRST TASK FOR THE AGENT

Do **M23 only**:

1. Print every table that currently carries `userId` and state, for each,
   whether it becomes `workspaceId`-scoped, keeps `userId`, or keeps both.
2. Write the Prisma migration adding `Workspace`, `Membership`, `Invitation`,
   and `workspaceId` columns with the required compound indexes.
3. Write the backfill migration: one workspace per existing user, owner
   membership, all rows assigned.
4. Move the tenant guard in the repository layer from `userId` to
   `workspaceId`; add `activeWorkspaceId` to the JWT.
5. Rewrite the isolation test to cover REST endpoints, search, export, AI query,
   sync pull, and webhook ingestion.
6. Confirm the full existing test suite still passes.

Then stop and report. Do not start M24.
