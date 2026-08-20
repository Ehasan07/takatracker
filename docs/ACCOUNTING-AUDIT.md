# Where this product stands against accounting practice — and what is left

**16 August 2026.** Written after reading the code rather than the plans, so
every claim below has a file behind it. Two questions are answered: which
accounting principles are not being followed, and what remains to build.

It is a personal-finance product, so the bar is not a listed company's annual
report. The bar is: **no figure on any screen should be false, and every
deliberate simplification should be visible to the person relying on it.** By
that bar there were four real defects and a set of honest omissions.

**Revised the same evening: all four defects are now closed.** Section 2 keeps
each one on the record — the fault as found, then the fix as it shipped —
because a defect that is quietly deleted from an audit teaches nobody anything,
and the next person to touch these files needs to know why the code looks the
way it does.

---

## 1. What is already right

Worth stating, because it is most of the foundation and the defects below are
narrow by comparison.

|                                                                                                                                                                                                                | Where                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Double entry, enforced twice** — in code and by a deferrable Postgres constraint trigger, so no import, worker or manual `psql` can write a lopsided transaction                                             | `packages/core/src/ledger.ts:79`, `migrations/20260806134800_ledger_balance_trigger` |
| **Four statements** — income, balance sheet, cash flow, changes in net worth                                                                                                                                   | `apps/api/src/reports/reports.service.ts:487,562,777,850`                            |
| **Current vs non-current** on the balance sheet (IAS 1.60)                                                                                                                                                     | `packages/core/src/reports.ts:92`                                                    |
| **Cash flow in three sections**, bucketed by the _counter account's_ type rather than by what the transaction was called — buying land is investing, a card repayment is financing (IAS 7.10)                  | `packages/core/src/cash-flow-sections.ts:52`                                         |
| **Revaluation goes to equity, never to income** (IAS 16.39) — and never touches a liquid account, so it stays out of the cash flow too                                                                         | `apps/api/src/transactions/transactions.service.ts:777`                              |
| **Reconciliation is distinct from revaluation** — a counting error and a market movement are different events and are booked differently                                                                       | `transactions.service.ts:864` vs `:777`                                              |
| **Split expenses** — only the owner's share reaches the expense nominal; the rest is a receivable, so somebody else's dinner never inflates your spending (IFRS 15 principal-vs-agent, applied to a household) | `apps/api/src/split/split.service.ts:666`                                            |
| **Audit trail** with before/after, actor, IP                                                                                                                                                                   | `apps/api/src/audit/audit.service.ts`                                                |

---

## 2. The four defects — all four closed

### 2.1 A USD account is added to a BDT total — silently

**The most urgent one, and it lands on the owner's own data.** The Wallet
migration brings across two USD accounts and one CNY account.

`Account.currency` is stored and echoed back, and **never read by any balance,
report or balance-sheet query**. `LedgerEntry.fxRate` is declared `Int`, so it
cannot hold a rate like 121.50 even if something wanted to; every writer passes
`1`. The `fx` service is a cached proxy to an external rate API that returns a
suggestion and persists nothing.

So `USD 500` and `৳500` are added together as five hundred.

**IAS 21.21** requires a foreign-currency transaction to be recorded at the spot
rate on the transaction date; **IAS 21.23(a)** requires monetary balances to be
retranslated at the closing rate. Neither happens.

Three honest ways out, cheapest first:

1. **Refuse it.** Only allow accounts in the workspace currency, and say so.
   Correct, and loses three of the owner's accounts.
2. **Fence it.** Keep the accounts, exclude non-BDT ones from every total, and
   show them in their own block labelled "converted at your own rate".
3. **Do it properly.** A rate table, a decimal `fxRate`, retranslation at the
   period end, and the gain or loss to income (IAS 21.28). Weeks, not days.

Recommended: **(2) now, (3) only if it is ever really needed.** Anything is
better than the current silence.

`schema.prisma:1611`, `apps/api/src/fx/fx.service.ts:30`, `packages/shared/src/schemas.ts:213`

**Fixed — (2), the fence.** `AccountsService.position` sums only accounts held
in the workspace's own currency; system accounts stay in regardless, because
they are denominated in the home currency by construction
(`accounts.service.ts:473`). The three foreign accounts survive, keep their own
balances, and are shown apart rather than added in. Option (3) — a rate table, a
decimal `fxRate`, retranslation at the closing rate — remains unbuilt, and
should stay unbuilt until somebody actually needs a translated statement.

### 2.2 The cash flow is never checked against itself

`assertReconciles` and `buildSectionedCashFlow` exist in
`packages/core/src/cash-flow-sections.ts:122,156` and **are called from
nowhere**. `reports.service.ts:663` documents them as running — _"`assertReconciles`
throws if they do not"_ — and they do not.

So nothing proves that `opening + operating + investing + financing = closing`.
A misclassified counter account, or the pro-rata apportionment of a multi-leg
transaction, would produce a statement that looks complete and does not add up.
There is no test file for the module either.

This is the cheapest fix on the list: call the function, and write the test that
catches a deliberately broken classification.

**Fixed.** `assertReconciles` now runs on every cash-flow build
(`reports.service.ts:781`), and the response carries `reconciled` and
`discrepancyMinor` so a caller can see the proof rather than trust it.
`cash-flow-sections.test.ts` covers it with 16 cases, including a deliberately
misclassified counter account.

Wiring it up immediately earned its keep: it failed on real data, and the cause
was a genuine misclassification — equity movements were bucketed `INTERNAL`
when **IAS 7.17** puts them in financing. The check found a bug on its first
run, which is the entire argument for having it.

### 2.3 Opening balances exist twice, and one of them has no date

Two mechanisms:

- `Account.openingBalance` — a **column**, added straight into the balance map
  with no ledger entry and **no date** (`accounts.service.ts:243`).
- An `OPENING_BALANCE` **transaction**, which correctly posts against
  `SYSTEM_EQUITY` (`packages/core/src/ledger.ts:208`).

The column has no date, so a balance sheet dated last January shows an opening
balance for an account opened in June. Comparatives between two periods are
therefore not comparable, which is what **IAS 1.38** is about.

The fix is to keep one: turn the column into a dated `OPENING_BALANCE`
transaction when an account is created, and let the ledger be the only source of
a balance.

**Fixed.** The column is gone
(`migrations/20260816230000_opening_balance_to_ledger`, and `schema.prisma:626`
now carries a comment saying why it must not come back). Creating an account
with a balance writes a dated `OPENING_BALANCE` transaction against
`SYSTEM_EQUITY`, stamped `externalRef = 'opening-balance:<accountId>'` so the
one entry that represents the opening jer can always be found and edited rather
than duplicated. The API still accepts and returns `openingBalance` on the
account payload — the screens did not have to change — but it is now a view over
that transaction, not a second store of the same fact.

The migration converts the existing rows, dating each at the account's own
opening date or its first transaction, whichever is earlier, so no balance is
stranded after an entry that depends on it.

A balance sheet dated last January no longer shows a June account's opening
balance. That is **IAS 1.38** satisfied, and it is also the difference between
comparatives that mean something and comparatives that merely exist.

### 2.4 Loan interest never enters the books

Interest is _derived_ for display (`packages/core/src/loans.ts:95`) and only
_posted_ when a payment is made (`loans.service.ts:1241`). Until then the
receivable control account understates what is owed, and the loan statement
shows an interest row with no entry behind it.

For an interest-free family loan — most of what this product records — the
difference is zero and the design is right. For the owner's DPS-backed and
bank loans it is not.

**IFRS 9 / the effective-interest method** would accrue it. A pragmatic middle
is to accrue only where `interestType ≠ NONE`, monthly, through the existing
reminder sweep.

**Fixed — the pragmatic middle.** `LoanInterestAccrualService` posts monthly
interest for loans that charge it and leaves interest-free family loans exactly
as they were, which is the common case and was never wrong. The receivable now
states what is owed on the day it is read, not what was owed at the last
payment.

Accrual is the kind of job that must never double-post, so it is guarded three
times over: the amount is computed as a difference against what has already been
accrued, not as a fresh period calculation; `LoanInterestAccrual.throughDate` is
a local-date watermark; and a unique index on `(loanId, throughDate)` stops two
sweeps that race past the first two guards. Running it twice in one day changes
nothing — which is what makes it safe to run hourly.

Not done, and deliberately: the **effective-interest method** itself. Interest
is accrued on the outstanding principal at the stated rate. For a household
loan at a flat rate that is the same number; for anything with fees rolled into
the yield it is not, and this product has no such instrument.

---

## 3. Deliberate omissions — correct for personal books, but say so

These are not defects. Each is a legitimate simplification, and the standard's
own answer is usually "disclose the choice", which is mostly already done.

| Omitted                                 | Standard               | Verdict                                                                                                                                                                                             |
| --------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Depreciation**                        | IAS 16.43              | Right call. A household does not depreciate its car; revaluation carries the same information with less invention. Documented in `PLAN-v3.md:130`, and now said on the statements footer too.       |
| **Accruals and prepayments**            | IAS 1.27 accrual basis | The books are **cash basis**. All four statement responses now carry `basis`, from one shared constant, so an API consumer cannot miss it and a second basis could only ever be added in one place. |
| **Period close / retained earnings**    | —                      | No statutory year-end for a person. Back-dating is a feature here, not a hole. Nothing to do.                                                                                                       |
| **Equity section on the balance sheet** | IAS 1.54(r)            | Net worth is presented as assets − liabilities, which is the same number by definition. Fine for a person.                                                                                          |
| **Budgets**                             | not a standard         | A product decision, not an accounting one.                                                                                                                                                          |

---

## 4. What is missing that a personal-finance product should have

Beyond the defects, ordered by how much a real user would feel it.

1. ~~**Transaction history from the old app**~~ — **the door is built.**
   `POST /migration/batches/:id/records` takes the history a page at a time,
   after two paging traps that would between them have lost 94% of it: the
   Wallet API silently applies a three-month filter unless asked for everything,
   and it can return a short page that is not the last page. Both are handled and
   both are documented in `WALLET-MIGRATION.md`. Running it against the owner's
   9,625 records is a decision, not a build.
2. **Income tax** — **the tab exists**; the rates do not. `TaxRegime` is global,
   versioned, and carries a `verified` flag, with every rate column nullable and
   seeded `NULL`. `GET /tax/worksheet` works, and `POST /tax/estimate` still
   refuses to produce a number.

   There is deliberately **no screen for entering rates**, which is the one place
   in this product where a missing feature is the feature. A rate box invites a
   guess, a guess produces a figure that looks computed, and somebody files it.
   The slabs get transcribed from the Finance Act by hand, into a version-2 row
   marked verified, and only then does the estimate appear. Until that happens
   the worksheet shows the inputs and declines the answer.

3. ~~**Recording the renewal fee**~~ — done. Completing an obligation offers the
   payment, prefilled from the estimate but booked at whatever figure is typed,
   because an estimate is not a receipt. Amount, account and category arrive
   together or not at all — a half-filled instruction is not something this
   endpoint should be guessing the rest of. Omitting it keeps the original
   behaviour: roll the date, touch no money, which is what somebody clearing five
   years of back khajna in one sitting actually wants.
4. **Prepaid annual expenses** — insurance premiums and licence fees paid once
   for twelve months. Cash basis says expense it on payment; a _spread_ view
   would tell somebody what a month really costs. Presentation, not posting.
5. **Attachments on renewals** — the scan of the paper. The `Attachment` model
   already exists; `AssetObligation.attachmentIds` does not.
6. **Push notifications (OneSignal)** and **the Play Store build** — planned,
   not started, and **deferred by the owner** on 16 August 2026.

---

## 5. One infrastructure fault worth fixing first

**The deploy depends on Google Fonts being reachable from the VPS.** The release
of 15 August 2026 failed on exactly this:

```
NextFontError: Failed to fetch `Anek Bangla` from Google Fonts.
```

Nothing was broken — the previous release kept serving — but a deploy that can
fail because a third party is unreachable is a deploy that will fail at the
worst moment. Self-hosting the font with `next/font/local` removes the
dependency and makes the build reproducible offline.

**Fixed.** Five woff2 files, 234KB, in `apps/web/src/app/fonts/`, loaded through
`next/font/local` with `adjustFontFallback: false`. The build no longer reaches
the network for a typeface.

---

## 5a. A personal business inside household books — August 2026

Shipped 20 Aug 2026: `Workspace.businessEnabled`, a tag-defined segment, a
one-press category tree, a month-end stock count, and a segment income
statement at `/reports/segment`. This section is the honest ledger of what that
does and does not honour, because a business raises standards a household never
has to answer to.

### What it honours

| Principle                                                                                                            | How                                                                                                                                                  | Where                                            |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Business entity** — the venture's books are separable from the owner's even where the law says they are one person | A tag on every business row; the income statement narrows to it. A sole proprietorship with no bank account of its own is the case this is built for | `reports.service.ts` `incomeStatement(…, tagId)` |
| **Segment disclosure** (IFRS 8.5)                                                                                    | The statement carries the segment's name, so a printed page cannot be mistaken for the household's                                                   | `StatementSegment` on the response               |
| **Inventory is an asset until it sells** (IAS 2.34)                                                                  | Buying stock is a transfer into an `ASSET` account; the month-end count posts the difference as `বিক্রীত পণ্যের ব্যয়`                               | `business.service.ts` `stockCount`               |
| **Periodic inventory is a permitted method** (IAS 2, cost formulas)                                                  | Opening + purchases − closing, from one counted number, because the account already holds the first two terms                                        | same                                             |
| **Owner contributions and distributions are not income** (IAS 1.109)                                                 | Capital and drawings are transfers, and a transfer carries no category, so neither can reach the income statement even by accident                   | ledger, by construction                          |
| **A financial asset is not an expense** (IFRS 9.5.1.1)                                                               | A share purchase is a transfer into an `INVESTMENT` account; only the disposal difference reaches income                                             | `transactions.service.ts` `sell`                 |
| **Prudence on a stock count**                                                                                        | Counting _more_ than the books hold is refused rather than written as income — a missing purchase must not become profit                             | `stockCount`, `cost < 0`                         |
| **Disclosure of basis**                                                                                              | Cash basis stated on the segment screen and behind a ⓘ, not in a footnote elsewhere                                                                  | `note.cashBasis`                                 |

### What it does not — and what each costs

Ordered by what a real shopkeeper would feel first.

1. **Accrual, which a business needs and a household does not** (IAS 1.27).
   Credit sales and credit purchases stay out of the segment profit until the
   cash moves. For a household that is the right simplification; for a shop that
   sells বাকিতে it is the difference between a month that looks bad and a month
   that was good. The receivable _is_ recorded — on the ধার screen — so nothing
   is lost, but it does not reach the profit figure. **This is the largest gap.**

2. **Depreciation on business fixed assets** (IAS 16.43). Omitting it is
   defensible for a household — §3 argues exactly that — and is _not_ defensible
   for a business: a shop's fridge, its vehicle and its shelving genuinely wear
   out against the takings they help produce, and profit is overstated by
   whatever that is worth. The household argument was "a depreciation figure
   nobody can verify is an invention"; a business asset has a cost, a life and a
   residual, and all three are knowable.

3. **The segment has no balance sheet.** Only income and expense carry the tag,
   so "what is the shop worth" and "how much is stuck in customer credit" cannot
   be answered from it. Segment reporting normally covers assets too. The pieces
   exist — the inventory account, the receivables — but nothing groups them.

4. **Loans are not part of any segment.** `Loan` carries no tag, and interest
   accruals post to auto-resolved categories with no tag either — so interest on
   a shop's borrowing, which is a business cost, lands in the household's
   income statement and not the shop's. Principal never reaches either
   statement, so the gap is exactly the interest.

5. **No quantity ledger.** `Transaction.quantityMilli` and `quantityUnit` exist
   and `GET /reports/by-quantity` sums them, but that report has no tag filter
   and does not separate what came in from what went out — so "how many did I
   buy, how many did I sell, how many are left" is not answerable in units, only
   in taka. There is no item or product model; the shop's stock is a single
   money balance.

6. **The share cost basis is the owner's arithmetic, not the software's.**
   Weighted average is what the guide teaches, and nothing enforces it or carries
   it between disposals, so consistency (IAS 2.25 in spirit) rests on the person.

7. **No period close and no separation of owner equity from accumulated
   profit.** Correct for a person — §3 — and a business that ever needs a
   statutory year-end has outgrown one workspace.

### The rule these all point at

A workspace with a shop in it is still a household's book with a label on some
of its rows. That is the right shape for a proprietor whose takings and whose
family's groceries share one bKash, and it stops being the right shape the day
the business gets its own bank account, its own VAT return and its own
year-end — at which point the answer is a second workspace, not another column
here. Worth saying out loud on the screen before somebody grows into it.

---

## 6. The work order, and where it ended

| #   | Work                                                     | Status                                           |
| --- | -------------------------------------------------------- | ------------------------------------------------ |
| 1   | Self-host the font                                       | **Done** — 5 woff2, no network in the build      |
| 2   | Call `assertReconciles`, and test it                     | **Done** — and it found a real misclassification |
| 3   | Fence off non-BDT accounts                               | **Done** — totals sum the home currency only     |
| 4   | Opening balance → one dated mechanism                    | **Done** — the column is dropped                 |
| 5   | Import the 9,625 records                                 | **Door built**; the run is the owner's call      |
| 6   | Basis on all four statement responses; depreciation note | **Done**                                         |
| 7   | Renewal fee → offer to book it                           | **Done**                                         |
| 8   | Accrue loan interest where the rate is not zero          | **Done** — monthly, guarded three ways           |
| 9   | Income tax tab                                           | **Tab done, rates not transcribed** — see §4.2   |
| 10  | OneSignal, Play Store                                    | **Deferred by the owner**                        |

### What is actually left

1. **Transcribe the Finance Act slabs** into a verified `TaxRegime` version-2
   row. Hand work, checked against the gazette, and the only thing standing
   between the worksheet and a usable estimate.
2. **Run the history import** for the owner's 9,625 records.
3. **Prepaid annual expenses**, **renewal attachments** — §4.4 and §4.5, neither
   urgent.
4. **Foreign currency, properly** — §2.1 option (3). Do not start this until
   somebody needs it.

Still owed by the owner and not a code change: **rotate the Wallet, OpenAI,
Gemini, ZeptoMail and mram credentials** that were pasted into chat. This has
been outstanding since they were pasted, and every day it stays open is a day
those keys are live in a chat log.
