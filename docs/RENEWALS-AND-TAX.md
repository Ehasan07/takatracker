# Renewals and income tax — a feasibility report

**15 August 2026.** Two features the owner asked for, assessed against what is
already built. They look like one request — "add reminders and add tax" — and
they are not. One is a week of ordinary work with almost no risk. The other is
the first feature in this product where being wrong has a cost outside the app.

Read §1 for the short answer, then whichever half you care about.

---

## 1. The short answer

|                          | Renewals                                                     | Income tax                                      |
| ------------------------ | ------------------------------------------------------------ | ----------------------------------------------- |
| Feasible?                | Yes                                                          | Yes, with a hard boundary                       |
| Foundations in place?    | Most of them                                                 | More than expected                              |
| Main work                | CRUD, a date calculator, wiring to the existing sweep        | A versioned rate table and a pure calculator    |
| Main risk                | Somebody misses a deadline because we sent the reminder late | Somebody files a return on a number we produced |
| Can it be wrong quietly? | No — the person sees the date                                | **Yes.** This is the whole problem              |
| Rough effort             | 3–5 days                                                     | 3–4 weeks, staged                               |

The renewals feature should be built more or less as asked. The tax feature
should be built in stages, and the first stage should not compute tax at all.
§3.7 explains why that is a feature rather than a delay.

---

## 2. Asset renewals

### 2.1 What was asked for

Assets carry recurring obligations that have nothing to do with the money
already recorded against them. A car needs a fitness certificate and a tax token
every year. Land carries khajna. A flat carries holding tax. A business carries
a trade licence. Miss one and the penalty is a fine, an impounded vehicle, or a
mutation that will not go through.

None of this is bookkeeping. It is a calendar with money attached.

### 2.2 What already exists

More than half of it, which is why this is cheap:

- **`Account` with `type: ASSET`** — the car, the land and the flat are already
  rows in the chart of accounts, with a name and a value.
- **`ReminderScheduler`** — an hourly sweep that already fires at 09:00 in each
  workspace's own timezone.
- **`CardReminderCycle`** — the pattern for "remind once per period, and let a
  person mute this one". Its idempotency guard (a `YYYY-MM-DD` stamp of the day
  it last sent) is the thing worth copying: it is what makes a restart, an
  overlap or a second instance unable to send twice.
- **Telegram delivery**, working, with the message templates already Bengali.
- **`InsurancePolicy`** — the same shape, one obligation-kind hard-coded. It is
  effectively a prototype of what this feature generalises.

### 2.3 What has to be built

**One model.** `AssetObligation`:

| Field                  | Why                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `accountId` (nullable) | The asset it belongs to. Nullable because a passport and a trade licence belong to a person, not an asset                             |
| `kind`                 | `FITNESS`, `TAX_TOKEN`, `ROUTE_PERMIT`, `DRIVING_LICENCE`, `KHAJNA`, `HOLDING_TAX`, `TRADE_LICENCE`, `PASSPORT`, `INSURANCE`, `OTHER` |
| `title`                | Free text, because the list above will always be missing one                                                                          |
| `dueDate`              | The next one                                                                                                                          |
| `recurrence`           | `YEARLY`, `HALF_YEARLY`, `QUARTERLY`, `MONTHLY`, `ONE_OFF`                                                                            |
| `reminderLeadDays`     | Default 30. A fitness renewal needs more warning than a card bill                                                                     |
| `estimatedCostMinor`   | So the year ahead can be totalled                                                                                                     |
| `lastCompletedOn`      | What rolls the date forward                                                                                                           |
| `documentRef`          | Registration number, licence number, plot number — masked like `accountNumberMasked` is                                               |
| `attachmentIds`        | The scan of the paper                                                                                                                 |

**One calculator**, pure and unit-tested: given a recurrence and the day it was
completed, what is the next due date. The hard cases are the ones the credit
card code already met — the 31st in a 30-day month, and a leap year.

**Reminder wiring**: the existing sweep gains a second query. Sending goes
through the same Telegram path, and through push once §4 lands.

**Recording the payment**: when somebody marks a renewal done, offer to book the
fee as an expense — khajna and a fitness fee are real money and belong in the
ledger. Offer, not assume: somebody clearing a backlog of five years of khajna
does not want five transactions dated today.

### 2.4 Bangladesh defaults worth seeding

A generic obligation list is a blank form. These are the ones that actually
recur here, and seeding them turns the feature from "define your own reminder"
into "tick the ones you have":

- গাড়ি — ফিটনেস, ট্যাক্স টোকেন, রুট পারমিট, ইনস্যুরেন্স
- জমি — খাজনা (ভূমি উন্নয়ন কর)
- ফ্ল্যাট/বাড়ি — হোল্ডিং ট্যাক্স, সার্ভিস চার্জ
- ব্যবসা — ট্রেড লাইসেন্স, ভ্যাট রিটার্ন
- ব্যক্তিগত — পাসপোর্ট, ড্রাইভিং লাইসেন্স, আয়কর রিটার্ন (§3)

### 2.5 What it cannot do

- **Know the real deadline.** The app knows what somebody typed. It cannot read
  a BRTA record or a land office register; there is no public API for either.
- **Renew anything.** It reminds. Every one of these is an in-person or
  department-portal process.
- **Be authoritative about penalty amounts.** Those change and vary by district.
  Show the person's own estimate, never a figure the app invented.

### 2.6 Effort

Three to five days, most of it screens. No new infrastructure, no external
dependency, nothing legally sensitive. The riskiest part is the date calculator,
and it is fifty lines with twenty tests.

---

## 3. Income tax

### 3.1 What was asked for

One click, from books that already hold a person's whole financial year, to an
estimate of what they owe. Country-specific, Bangladesh first, and correct for
the fiscal year in question because the rules change every year.

It is a genuinely good idea and this product is unusually well placed for it —
see §3.3. It is also the first feature here where a wrong number leaves the app
and reaches a government form.

### 3.2 What Bangladesh actually requires

Stated so the design can be judged against it, not as tax advice:

- **A July–June fiscal year**, with the assessment year following it. Every
  figure has to be bucketed on that boundary, not on the calendar year.
- **Heads of income**, each with its own rules: salaries, income from house
  property, business or profession, agricultural income, capital gains, income
  from financial assets, and income from other sources.
- **Progressive slabs**, with a tax-free threshold that is _not_ the same for
  everybody — it differs for women and taxpayers over 65, for taxpayers with a
  disability, for gazetted freedom fighters, and for third-gender taxpayers.
- **An investment rebate** against eligible investments — DPS, life insurance
  premium, savings certificates, provident fund, listed shares — computed as the
  lower of a set of caps rather than a flat percentage.
- **A minimum tax** that depends on where the taxpayer lives, payable by
  somebody required to file even in a year they made nothing.
- **A surcharge** on net wealth above a threshold, itself progressive.
- **Credit for tax already deducted at source**, which is where most salaried
  people's tax has in fact already gone.
- **Tax Day**, the filing deadline for individuals.

**Every number in that list is set by the Finance Act and changes.** That single
fact drives the whole design in §3.5.

### 3.3 What this product already has, and it is a lot

This is the part that makes the feature attractive rather than speculative.

**The heads of income are already the income categories.** The seven seeded
income categories map almost one-to-one:

| Seeded category | Head of income               |
| --------------- | ---------------------------- |
| বেতন            | Salaries                     |
| ব্যবসা          | Business or profession       |
| ফ্রিল্যান্স     | Business or profession       |
| বাড়ি ভাড়া     | Income from house property   |
| মুনাফা/সুদ      | Income from financial assets |
| উপহার           | Income from other sources    |
| অন্যান্য        | Income from other sources    |

Nobody has to re-enter a year of income. It is already there, already dated,
already categorised — and where it is miscategorised, the tax screen is exactly
the place that will surface it.

**The rebate-eligible investments are already modelled.** `SavingsPlan` holds
DPS and savings certificates with their instalments; `InsurancePolicy` holds
premiums with dates. Both already know what was actually _paid_ in a window,
which is the number the rebate is computed on.

**Net wealth for the surcharge is already computed.** The balance sheet does it,
with assets and liabilities split, and it already handles land and gold at
revalued amounts.

**The fiscal year is already a solved problem.** Every report in the product
takes an arbitrary date range in the workspace's own timezone, and the statement
work already established that a July–June window is just another range.

**Tax deducted at source is a transaction the person already records** when a
bank credits interest net of tax — provided there is a category for it, which
there is not yet. One seeded category fixes that.

### 3.4 What it can honestly produce

A **tax worksheet**, not a return:

1. Income by head, for the fiscal year, each line clickable through to the
   transactions behind it.
2. Rebate-eligible investment, itemised from the savings and insurance already
   recorded.
3. Net wealth as at the year end, from the balance sheet.
4. The slab computation, shown line by line rather than as a total.
5. Rebate applied, minimum tax floor applied, surcharge added.
6. Tax already deducted, subtracted.
7. **An estimate**, with every input visible and every rate cited.

That document is worth real money to somebody who currently arrives at their
practitioner with a carrier bag of receipts. It is worth it _because_ it shows
its working, not despite it.

### 3.5 The data model, and the one rule that matters

**`TaxRegime`** — one row per country per fiscal year:

| Field                                         | Why                                                                   |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `country`, `fiscalYearStart`, `fiscalYearEnd` | `BD`, `2025-07-01`, `2026-06-30`                                      |
| `slabs`                                       | Ordered bands: threshold and rate                                     |
| `thresholdsByCategory`                        | General, women, 65+, disabled, freedom fighter, third gender          |
| `rebateRule`                                  | The caps and percentages, as data                                     |
| `minimumTaxByArea`                            | Dhaka/Chattogram city corporation, other city corporations, elsewhere |
| `surchargeBands`                              | Net wealth thresholds and rates                                       |
| `sourceCitation`                              | "Finance Act 2025, s.—" — printed on the worksheet                    |
| `verifiedAt`, `verifiedByUserId`              | A human checked this against the gazette                              |

**`TaxProfile`** — one per workspace: country, taxpayer category, area, whether
they are required to file, TIN (masked, never whole).

**A `headOfIncome` column on `Category`**, so the mapping is data a person can
correct rather than a hard-coded table that is wrong for somebody.

**The rule that matters, and it is not negotiable:**

> If there is no `verifiedAt` regime row for the fiscal year being asked about,
> the app refuses to compute and says why.

Not "falls back to last year". Not "uses the most recent". A tax estimate
computed on last year's slabs is wrong in a way that looks exactly like being
right, and the person carrying it to their practitioner has no way to tell. The
refusal is the feature — it is what makes every number the screen _does_ show
trustworthy.

### 3.6 What it cannot do, and must never claim to

- **It cannot file.** NBR's e-return has no public API. Anything else would be
  scraping somebody's tax portal with their credentials, which this product will
  not do.
- **It cannot be a return.** Perquisite valuation, depreciation schedules,
  capital gains with holding-period rules, exempted income, foreign income,
  spouse and minor income clubbing — each is a body of rules, several are
  judgement calls, and none belongs in a household ledger.
- **It cannot know unrecorded income.** Cash income nobody typed is invisible,
  and the estimate will be confidently low. The worksheet must say so.
- **It must not be called tax advice**, in any language, on any screen. The
  wording is "আপনার লেখা হিসাব অনুযায়ী আনুমানিক" and it appears beside the
  figure, not in a footer nobody reads.
- **It must not round in the app's favour or the taxpayer's.** Integer poisha,
  the same as everywhere else, and the rounding rule the Act specifies.

### 3.7 Staging, and why stage 1 computes nothing

**Stage 1 — the worksheet, no tax.** Income by head, investments, net wealth,
TDS, all for a July–June window, printable and shareable through the machinery
that already exists. No slabs, no estimate.

This is worth shipping on its own. It is the part with no legal exposure, it is
80% of the tedium a person faces at filing time, and — the real reason — it is
how the _inputs_ get corrected. Every miscategorised salary and missing rent
receipt surfaces here, months before anybody trusts a number computed from them.
Build the calculator first and it computes tax on data nobody has checked.

**Stage 2 — the slab engine.** Pure, in `packages/core`, no database, tested
against worked examples from NBR's own guidance. One verified regime row for the
current fiscal year, entered by hand.

**Stage 3 — rebate, minimum tax, surcharge.** Each with its own tests and its
own line on the worksheet.

**Stage 4 — TDS credits, and a second country.** The regime table already makes
a second country a data exercise; only the heads-of-income mapping is new.

### 3.8 Effort and the honest risk

Three to four weeks across the stages, of which the calculator is maybe four
days and the rest is screens, mapping and tests.

The risk is not technical. It is that a Bangladeshi taxpayer files on a figure
this app produced, is assessed differently, and blames the product — or worse,
underpays and is penalised. Three things contain that:

1. Refusing to compute without a verified regime for the year.
2. Showing every input and every rate, cited, so the number is checkable.
3. Calling it an estimate in the same breath as showing it, every time.

None of those is a disclaimer bolted on afterwards. They are the design.

---

## 4. Where these sit against the rest of the queue

Ahead of both: the Play Store build and push notifications, which are in flight.

Renewals should come next. It is small, it has no legal surface, it makes the
asset accounts worth opening, and it exercises the reminder path that push
notifications will land on.

Tax stage 1 should follow, timed so the worksheet is in people's hands well
before Tax Day rather than during the week they need it.

Tax stages 2–4 need one thing this document cannot supply: somebody who will
read the Finance Act each year and mark the regime row verified. Until that
person exists, the app should ship stage 1 and refuse the rest — which is
exactly what the rule in §3.5 makes it do.
