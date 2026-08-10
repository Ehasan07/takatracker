# Enterprise SaaS architecture

The brief: super-admin control of subscription packages, per-tenant email and
SMS integration, domain-based configuration, hard tenant isolation, global
super-admin visibility, multi-language category search, and no shortcuts — the
core should not need reshaping to add a module later.

This document says what already satisfies that, what does not, what cannot be
built as described and why, and the order to build the rest in. It is written to
be argued with: every "cannot" below names the constraint rather than the
preference.

The database may be reset — the user has said so — so the schema work below is
free to change shapes rather than migrate around them.

---

## 1. What the brief asks for that already exists

Saying this plainly matters, because rebuilding a working foundation is the most
expensive way to satisfy a brief.

### Tenant isolation (§4) — done, and it is the load-bearing property

`workspaceId` is the guard on every query in the application. Not `userId`:
a person can belong to several workspaces, and scoping by the person is the
mistake that leaks one tenant's books into another's.

- The JWT carries `ws`; `JwtStrategy` re-reads membership from the database on
  every request, so revoking somebody takes effect immediately rather than when
  their token expires.
- `LedgerEntry.workspaceId` is denormalised **with a database trigger** asserting
  it equals its transaction's. A row cannot be written into the wrong tenant even
  by a bug in the service layer.
- Every module's e2e spec includes "another workspace's id returns 404, and its
  list is empty". That is not decoration: it is the test that fails first if
  somebody adds an unguarded query.

What the brief lists under §4 — transactions, contacts, reports, settings — is
already covered. SMS and email are covered for the ingestion inbox that exists;
the mailbox connector in §2 is new and must inherit the same rule.

### Subscription packages (§1) — the engine exists, the panel does not

`Plan` → `PlanFeature` → `WorkspaceFeatureOverride` is exactly the shape the
brief describes: named packages, a limit per feature, and a per-tenant override
for "enable this one thing for this one customer". A breach returns 402 with
`{featureKey, limit, used, upgradeUrl}` rather than a generic failure.

Two gaps, both real:

- **No super-admin surface.** Packages are defined in `packages/core/entitlements.ts`
  and upserted at boot. Changing a tier is a deployment, not an action.
- **Nine of twelve feature keys report zero.** `accounts.max`,
  `transactions.monthly.max` and `members.max` are measured; storage, AI, email,
  SMS and API usage are not, because those subsystems do not exist yet. The
  limits are enforceable the day the meter exists, and not before — a limit
  nobody counts against is a promise, not a control.

### Multi-language search (§6) — built, one piece missing

Categories already carry both `name` (English) and `nameBn`. The matcher in
`packages/core/src/search.ts` transliterates Bengali to the Latin spellings a
Bangladeshi would actually type, as a _set_ per word rather than one canonical
form, because the mapping is many-to-many in both directions: ভ is `bh` or `v`,
জ and য are both `j` or `z`, শ ষ স are all `s` or `sh`.

Measured: 84 of 84 seeded categories found by Bengali, English and Banglish; 81
at rank 1; all 14 same-sound pairs (`bajar`/`bazar`, `vara`/`bhara`,
`shastho`/`sastho`/`swastho`) rank first. English-dictionary false positives sit
at 0.75%.

**What is missing is exactly what the brief names: aliases.** Transliteration
cannot get from `restaurant` to `খাবার ও বাজার`, because they are not the same
word — they are synonyms. That needs a stored list per category, which is item
B below.

---

## 2. What cannot be built as described

These are platform constraints, not scoping decisions. Each is stated with what
_can_ be done instead.

### Reading a user's SMS from the server is impossible

There is no API, on Android or iOS, that lets a server read somebody's SMS. The
only routes are on the device:

|         | Inbox                              | Sent                                    |
| ------- | ---------------------------------- | --------------------------------------- |
| Android | a forwarder app (works today)      | possible, but needs our own Android app |
| iOS     | Shortcuts automation (works today) | **never** — Apple exposes no API        |

"SMS Sent" on iOS is not a roadmap item; it is a thing that cannot exist. An
Android companion app could read both, and that is a real project — a Play Store
listing, the `READ_SMS` permission, and Google's Permissions Declaration review,
which rejects most applicants.

### Reading a user's email needs OAuth, and OAuth needs Google's approval

The brief says "if a user configures their email, read their inbox". The obvious
implementation — IMAP with a password — is closing:

- **Microsoft 365 disabled IMAP basic auth.** It is not a setting; those users
  cannot be served this way at all.
- **Google restricts app passwords** and is narrowing them further.

So production-grade means OAuth, and Gmail's mailbox scopes are **restricted**:
a Google Cloud project, an OAuth consent screen, a security assessment by a
third-party assessor, and a review that takes weeks and recurs annually.

The build plan therefore puts a provider abstraction in front, ships IMAP first
for the providers where it still works (and says so honestly in the UI), and
leaves OAuth as a second provider behind the same interface. **Starting Google's
verification is on the user, not on me** — it needs a company identity, a privacy
policy at a public URL, and a demo video.

### Billing information without a payment gateway

The brief lists "Billing Information" under super-admin visibility, and the user
previously said billing was not needed. Both can be true: usage metering,
package assignment, invoices as _records_ and a billing history are buildable
now. **Taking money** is a separate decision — bKash, SSLCommerz and Stripe each
need a merchant account and a different integration. Until one is chosen, the
super admin can see and set what a tenant owes; the system cannot collect it.

---

## 3. The build, in order

Each phase is independently shippable and leaves the system working. The order
is chosen so that nothing later forces a change to something earlier — which is
what §7 actually asks for.

### Phase A — the tenancy and identity spine

The one phase that must come first, because everything else hangs off it.

1. **A `SUPER_ADMIN` role that is not a workspace role.** Global access is a
   deliberate hole in the guard that protects every tenant. It gets its own
   module, its own guard, and its own controller prefix — never a branch inside
   an ordinary service, because the day somebody adds `if (isAdmin)` to a shared
   code path is the day a normal user finds their way through it.
2. **Every super-admin read is audited.** Looking at a tenant's data is an event
   with an actor, a target and a timestamp. A support tool nobody can review is a
   liability, and it is what a customer will ask about first.
3. **Impersonation is explicit and time-boxed** — the audit action strings
   already exist (`support.impersonation_started`/`_ended`) and nothing emits
   them yet.

### Phase B — packages and metering

4. **Feature keys become data, not a TypeScript union.** Today adding a feature
   means editing `packages/core/entitlements.ts` and deploying. For the super
   admin to create a Custom package at runtime, the catalogue must live in the
   database with the code holding only the _defaults_. This is the single change
   that most decides whether §7 is satisfied.
5. **Meters for the things packages sell**: storage bytes, API calls, email sends,
   SMS sends, AI tokens. Each is a counter with a reset period, written where the
   work happens, and read by the same `assertWithinLimit` that already works.
6. **The super-admin panel**: list tenants, see usage against limits, assign a
   package, override one feature for one tenant, suspend, and read the audit.
7. **Category aliases** — `searchAliases String[]`, editable per category, fed
   into the existing matcher as an extra candidate set. Seeded with the obvious
   ones (`Khabar`, `Restaurant`, `Poribohon`, `Transport`) and extensible by the
   user, which is what makes it survive words nobody anticipated.

### Phase C — domains

8. **Subdomains behind the existing nginx**: `api.takatracker.com`,
   `sms.takatracker.com`, `mail.takatracker.com`, each with its own certificate.
   The current `takatracker.com/api` keeps working — breaking a live path to
   tidy a URL is not an improvement.
9. **Per-tenant custom domains** need a wildcard certificate or per-domain ACME,
   plus a hostname → workspace lookup at the edge. Designed in Phase C, built
   when a tenant asks.

### Phase D — the connectors

10. **A `MailAccount` model and a provider interface**, IMAP first, OAuth second.
    Credentials encrypted at rest with a key that is _not_ in the same backup as
    the database — the current backups deliberately exclude the env file for
    exactly this reason.
11. **A sync worker**, not a request-time fetch. Reading a mailbox is slow and
    rate-limited; doing it inside an HTTP request means a screen that hangs.
12. **SMS gateway per tenant** for _sending_ (the gateways sell that). Receiving
    stays device-side, per §2 above.

### Phase E — scale

13. **Postgres row-level security** as a second wall behind the application
    guard. The application is already correct; RLS makes a future bug in it
    non-fatal rather than catastrophic.
14. **Per-tenant rate limits** — the throttler currently buckets by IP, which
    behind a proxy and a carrier NAT is the wrong axis.
15. **Read replicas and connection pooling** when the numbers justify them, not
    before.

---

## 4. What "no shortcuts" costs, honestly

Item 4 above — moving the feature catalogue from code into the database — will
touch the entitlements engine, every `assertWithinLimit` call site, and the
plans screen. It is the right change and it is not small. Doing it _now_, while
the database can be reset, is far cheaper than doing it after tenants exist.

Everything else in Phase B builds on it. That is why it is item 4 and not item 14.
