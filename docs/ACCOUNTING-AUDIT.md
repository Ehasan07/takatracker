# Where this product stands against accounting practice — and what is left

**16 August 2026.** Written after reading the code rather than the plans, so
every claim below has a file behind it. Two questions are answered: which
accounting principles are not being followed, and what remains to build.

It is a personal-finance product, so the bar is not a listed company's annual
report. The bar is: **no figure on any screen should be false, and every
deliberate simplification should be visible to the person relying on it.** By
that bar there are four real defects and a set of honest omissions.

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

## 2. The four defects

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

---

## 3. Deliberate omissions — correct for personal books, but say so

These are not defects. Each is a legitimate simplification, and the standard's
own answer is usually "disclose the choice", which is mostly already done.

| Omitted                                 | Standard               | Verdict                                                                                                                                                                                                         |
| --------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Depreciation**                        | IAS 16.43              | Right call. A household does not depreciate its car; revaluation carries the same information with less invention. Already documented in `PLAN-v3.md:130`. **Add one line to the statements footer saying so.** |
| **Accruals and prepayments**            | IAS 1.27 accrual basis | The books are **cash basis**, which is stated on two of the four statements and in the screen footer. **Put `basis` on the balance sheet and cash-flow responses too**, so an API consumer cannot miss it.      |
| **Period close / retained earnings**    | —                      | No statutory year-end for a person. Back-dating is a feature here, not a hole. Nothing to do.                                                                                                                   |
| **Equity section on the balance sheet** | IAS 1.54(r)            | Net worth is presented as assets − liabilities, which is the same number by definition. Fine for a person.                                                                                                      |
| **Budgets**                             | not a standard         | A product decision, not an accounting one.                                                                                                                                                                      |

---

## 4. What is missing that a personal-finance product should have

Beyond the defects, ordered by how much a real user would feel it.

1. **Transaction history from the old app** — 9,625 records sit in
   `~/Desktop/taka-tracker-migration/`, none of them imported. Everything else
   about the migration is done. **This is the biggest single gap.**
2. **Income tax** — `packages/core/src/tax.ts` computes; there is no settings
   tab, no rate table for the year, and `estimateTax` refuses to run until a
   verified regime is supplied. Deliberate: the first release should not compute
   a number somebody files.
3. **Recording the renewal fee** — marking khajna done rolls the date forward
   but offers no way to book the payment. One button, prefilled.
4. **Prepaid annual expenses** — insurance premiums and licence fees paid once
   for twelve months. Cash basis says expense it on payment; a _spread_ view
   would tell somebody what a month really costs. Presentation, not posting.
5. **Attachments on renewals** — the scan of the paper. The `Attachment` model
   already exists; `AssetObligation.attachmentIds` does not.
6. **Push notifications (OneSignal)** and **the Play Store build** — planned,
   not started.

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

---

## 6. The order I would work in

| #   | Work                                                     | Why first                                           |
| --- | -------------------------------------------------------- | --------------------------------------------------- |
| 1   | Self-host the font                                       | Half an hour, and every later deploy depends on it  |
| 2   | Call `assertReconciles`, and test it                     | The safety net that was documented but absent       |
| 3   | Fence off non-BDT accounts                               | The owner's own net worth is wrong until this lands |
| 4   | Opening balance → one dated mechanism                    | Makes every dated balance sheet honest              |
| 5   | Import the 9,625 records                                 | The migration's last mile                           |
| 6   | Basis on all four statement responses; depreciation note | An hour, and closes the disclosure gaps             |
| 7   | Renewal fee → offer to book it                           | Small, and completes a feature shipped today        |
| 8   | Accrue loan interest where the rate is not zero          | Correctness, but only for a few rows                |
| 9   | Income tax tab                                           | Weeks, and the riskiest thing here                  |
| 10  | OneSignal, Play Store                                    | Product, not accounting                             |

Still owed by the owner and not a code change: **rotate the Wallet, OpenAI,
Gemini, ZeptoMail and mram credentials** that were pasted into chat.
