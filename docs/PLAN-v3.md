# Taka Tracker — plan v3

**14 August 2026.** Supersedes the ordering in `docs/PLAN.md` and the milestone
table in `PROGRESS.md`, both of which are now behind what is live. Where this
document and those disagree, believe this one.

Two things drive v3:

1. **The books must satisfy an accountant, not just a household.** The ledger
   already does; the _statements_ do not. Six gaps, listed in §2.
2. **Shared and pooled spending.** People do not spend alone. Splitting a bill
   is not a new kind of bookkeeping — it is the loan ledger this product already
   has, reached from a different screen. §3.

---

## 1. Where the project actually stands

`PROGRESS.md` still lists M12–M14 as "not started". They are live. The honest
picture, as of today:

| Area                                                           | State                                        |
| -------------------------------------------------------------- | -------------------------------------------- |
| Double-entry engine, enforced by a database constraint trigger | live                                         |
| Accounts of every class, incl. `ASSET` and `LIABILITY`         | live                                         |
| Transactions, categories, sub-categories, tags                 | live                                         |
| People, loans, party ledger, loan statements                   | live                                         |
| Savings/DPS, insurance policies and premiums                   | live                                         |
| Reports: by category, by tag, trend, balance sheet, cash flow  | live                                         |
| Statement sharing by link, printable, no account needed        | live                                         |
| Workspaces, entitlements, plans, audit log                     | live                                         |
| Auth: password, OTP, mobile number, breach checks, device list | live                                         |
| PWA with self-updating service worker, offline queue           | live                                         |
| Bengali/English switch                                         | live for the main screens; ~720 strings left |
| Mailbox ingestion, draft inbox                                 | live                                         |
| CSV/Excel import (M6)                                          | **not built**                                |
| Mobile app (M15)                                               | **not built** — the PWA carries phones today |

### What is verified, and by what

- Debits equal credits **per transaction, at COMMIT**, by a deferred constraint
  trigger. No import, worker, sync or `psql` session can write a lopsided entry.
- Entry amounts are positive; `direction` carries the sign.
- Balance sheet reconciles: assets − liabilities = net worth.
- Cash flow closes exactly on the liquid balance — a test asserts the two.
- The dashboard's headline figures come from the same `buildBalanceSheet` the
  balance sheet uses, so the two cannot drift.
- Money is integer minor units everywhere; `Math.round` is banned by ESLint.

That foundation is why the rest of this plan is presentation work rather than
re-plumbing.

---

## 2. The six accounting gaps

Fixed today, before this document was written: the dashboard added land to cash
and called it "মোট ব্যালেন্স", while omitting money lent out, which lives in a
hidden control account. One line of arithmetic, wrong in both directions. It is
now two figures — spendable money, and net worth — both from `buildBalanceSheet`.

The rest, in the order they should be built:

### M40 — Cash flow in three sections (IAS 7)

The largest gap. Today the cash-flow report is one opening → inflow → outflow →
closing figure. IAS 7 requires **operating, investing and financing** to be told
apart, and it is the first thing anybody assessing creditworthiness looks at:
salary and borrowing currently arrive in the same number.

The classification data already exists — `TransactionType` distinguishes
`INCOME`, `EXPENSE`, `TRANSFER`, `LOAN_GIVEN`, `BORROWED`, `SAVINGS_DEPOSIT`,
`PREMIUM_PAID` and the rest. The mapping belongs in `packages/core` beside
`ACCOUNT_CLASS`, as a pure function with its own tests:

| Section       | What lands there                                                             |
| ------------- | ---------------------------------------------------------------------------- |
| **Operating** | income, everyday expenses, premiums, interest received or paid               |
| **Investing** | buying or selling an `ASSET` account's holding, savings deposits/withdrawals |
| **Financing** | money borrowed, loans repaid, money lent, loans recovered                    |

The existing test that closing equals the liquid balance stays and gains a
second: the three sections must sum to the same net movement.

### M41 — Income statement for any period

Income by category, expenses by category, net surplus, for an arbitrary date
range, with a comparative column. The pieces exist (`by-category`, `trend`,
`summary`); what does not exist is the statement.

Comparatives are not decoration — IAS 1 requires them, and a period with nothing
to compare against tells a reader nothing about direction.

### M42 — Balance sheet: current vs non-current (IAS 1.60)

Assets and liabilities are one flat list each today. They must split:

- **Current assets** — cash, bank, mobile wallet, receivables due within a year
- **Non-current** — land, gold, vehicles, savings locked beyond a year
- **Current liabilities** — credit cards, payables due within a year
- **Non-current liabilities** — long-term borrowing

This is the same distinction the dashboard fix made, applied one level deeper,
and it is what made the dashboard bug possible in the first place.

### M43 — Statement of changes in net worth

The reconciliation that keeps the other three honest:

```
opening net worth + income − expenses ± revaluations = closing net worth
```

Without it, the income statement and the balance sheet can disagree and nobody
finds out. With it, disagreement is a failing arithmetic check on screen. This
is the personal equivalent of a statement of changes in equity, and it is the
single most valuable report for proving the books are internally consistent.

### M44 — Asset revaluation

Land bought at ৳10,00,000 stays at ৳10,00,000 forever today. IFRS permits either
the cost model or the revaluation model — but **requires that the report say
which**, and this product currently offers neither mechanism.

Design: a revaluation is a dated transaction against the asset account and a
`REVALUATION` nominal account, so it never masquerades as income and never
enters the cash flow. History is kept: what it was, what it became, when, and
the note explaining why.

**Depreciation is deliberately not built.** Depreciating a household car is an
artefact of business accounting; revaluing it to market is simpler, more honest,
and how personal financial statements are prepared everywhere. This decision is
recorded so it is not re-litigated.

### M45 — Basis of preparation, printed on every statement

These are **cash-basis** personal accounts. That is the right choice for a
household — accruals would mean recording an electricity bill nobody has paid —
but a report handed to a bank has to say so, along with the currency, the
period, the reporting date and whether assets are held at cost or revalued.

One footer component, on all four statements and on the shared link.

---

## 3. Shared and pooled spending (M46–M48)

Prompted by BudgetBakers' ShareCost. The feature is worth having; the way it
usually ships is not, because most splitting apps keep a private ledger of
"who owes whom" that never reaches anybody's real books.

**The insight that makes this cheap: a shared expense is already a loan.**

I pay ৳3,000 for a dinner for four. My share is ৳750. The other ৳2,250 is not my
expense — it is money three people owe me. In entries:

```
DEBIT   Expense (category: খাবার)        ৳750      ← only my share is an expense
DEBIT   ঋণ পাওনা  (receivable)            ৳2,250    ← what they owe me
CREDIT  নগদ / ব্যাংক                       ৳3,000
```

Balanced, and every receivable is already tracked per person by the party ledger
built for loans. When somebody else pays and I owe my share:

```
DEBIT   Expense (my share)               ৳750
CREDIT  ঋণ দেনা  (payable)                ৳750
```

No cash moves until settlement, which is an ordinary repayment:

```
DEBIT   ঋণ দেনা                            ৳750
CREDIT  নগদ                                ৳750
```

So splitting needs no new accounting. It needs a group, a split calculator, and
a screen.

### M46 — Groups and splitting, inside one workspace

- **Group**: a name, a currency, a purpose (trip, flat, office lunch), members.
- **Members are `Person` rows.** Your friend does not need an account for you to
  keep an honest record of what they owe you. This is the whole of tier 1 and it
  ships first.
- **Split methods**: equally, by exact amounts, by percentage, by shares
  (weights — "Karim eats double").
- **Rounding is a correctness problem, not a detail.** ৳1,000 split three ways
  is 33333, 33333, 33334 poisha. The remainder is distributed one poisha at a
  time in a stable member order, and the sum of the parts must equal the whole —
  asserted by a property test over many amounts and member counts. A lost poisha
  here would be rejected by the balance trigger at COMMIT, which is the right
  failure but a terrible experience.
- **Group ledger**: running balance per member, plus the group's own history.
- **Settlement suggestions**: the minimum set of payments that clears the group.
  Suggested only — never posted without confirmation, because simplifying debts
  changes _who owes whom_, and that is not a transformation software should
  apply to somebody's ledger silently.

### M47 — Inviting somebody who does have an account

The mirror-image entry in their books, and the reason this is a separate
milestone: **nothing may be written into another person's ledger without their
say-so.** An invitation creates a _draft_ in their inbox — the same principle the
mailbox ingestion already follows ("nothing reaches your books unasked"). They
accept, and it posts as their expense and their payable. They decline, and your
side keeps the receivable exactly as if they had no account.

Conflicts (both sides editing the same shared expense) are resolved by the payer
being the owner of the record; everybody else holds a copy that follows it.

### M48 — Pooled funds

Different from splitting, and asked for separately: a group where members
contribute to a common pot — a family fund, an office samity, a trip kitty —
and spending comes out of the pot rather than out of one person's pocket.

Accounting: the pot is a real account of type `ASSET`, held by whoever holds the
money, with each member's contribution a payable to that member. Spending from
the pot reduces the pot and is apportioned per the group's rules. This is a
committee ledger, which is a well-understood shape and, in Bangladesh, an
extremely common one.

---

## 4. Everything else outstanding

Carried forward, so nothing quietly disappears:

| Item                                                | Note                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| Share buttons on savings and insurance screens      | the API already serves both kinds; only the buttons are missing    |
| Bengali/English: ~720 web strings, 191 API messages | the switch works; the coverage is partial                          |
| CSV/Excel import with a mapping UI (M6)             | still the biggest missing convenience                              |
| Mobile app (M15)                                    | the PWA carries phones today; a store build is a separate decision |
| Ador Noirrit woff2                                  | licensed, not on Google Fonts — needs the file to drop in          |
| A dedicated Taka Tracker Telegram bot               | reminders currently share a bot                                    |
| Privacy page naming what an operator can see        | overdue; the operator can read tenant data and users are not told  |
| Rotate the mram SMS key and the ZeptoMail token     | **owed by you** — both were pasted into a chat                     |
| Gmail dot-normalising                               | recommendation stands: do not; mobile login already solves it      |

---

## 5. Order, and why

```
M40  cash flow in three sections      ← largest standards gap, data already exists
M41  income statement for any period  ← the statement people ask for first
M42  balance sheet current/non-current
M43  changes in net worth             ← makes M40–M42 provably consistent
M45  basis of preparation footer      ← cheap, and M41–M43 are not presentable without it
M44  asset revaluation                ← needs M43 to have somewhere to show the movement
M46  groups and splitting             ← no new accounting; reuses the loan ledger
M47  invitations and mirrored drafts
M48  pooled funds
```

M40–M43 land as a **new "আর্থিক বিবৃতি" section in Reports**, beside the existing
screens rather than replacing them. The current reports answer "where did the
money go this month"; these answer "what is my position". Both are wanted, and
the second must not push the first out of the way.

Every statement is printable and shareable through the link mechanism already
built, which is what makes them worth having: a report you cannot hand to a bank
is a report you did not need.

---

## 6. Standing rules for all of it

Unchanged from `docs/PLAN.md` §7, restated because they are what keeps the ledger
trustworthy:

- Integer minor units. No floats, no `Math.round`.
- Every write balanced, and proved balanced by the database, not by hope.
- Every query scoped by `workspaceId`.
- Dates are calendar days in the workspace's timezone, never resolved instants.
- Nothing enters somebody's books without them asking for it.
- A number on a screen always has its breakdown within reach.
- Tests before the deploy, and the deploy before the claim that it works.
