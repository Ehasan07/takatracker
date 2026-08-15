# Bringing a Wallet account across — a plan

**15 August 2026.** The owner has years of books in BudgetBakers Wallet and
wants them here: every account, every category, and ideally every record —
staged as drafts, approved before anything is created, and with a way to say
"this category is really a savings plan" during the approval.

This is written after calling their API rather than reading about it, so the
numbers below are what is actually there.

---

## 1. What is actually in the account

Probed read-only on 15 August 2026 with the owner's own token:

|               | Count     | Notes                                                                      |
| ------------- | --------- | -------------------------------------------------------------------------- |
| Accounts      | **20**    | 17 BDT, 2 USD, 1 CNY. 2 archived                                           |
| Account types | 7 kinds   | General, CurrentAccount, Cash, CreditCard, SavingAccount, Investment, Loan |
| Categories    | **200**   | 147 of them the owner's own, none archived                                 |
| Records       | **7,215** | across all accounts                                                        |

Category groups, as Wallet organises them: Financial expenses, Food & Drinks,
Housing, Income, Investments, Life & Entertainment, Others.

The API is `https://rest.budgetbakers.com/wallet/v1/api`, bearer token, and it
pages with `?limit=&offset=` returning `nextOffset`. All three collections
answered 200.

### The shapes, as they really come back

```
account   id, name, accountType, currencyCode, balance, archived,
          bankAccountNumber, recordStats{recordCount, recordDate{min,max}}

category  id, name, group{id,name}, systemId, customCategory, archived, enabled

record    id, accountId, amount{value, currencyCode}, recordDate,
          category{id,name,group}, recordType, recordState, transfer, labels
```

---

## 2. What maps cleanly, and what does not

### Accounts — clean, once the type is chosen

| Wallet                  | Here          |
| ----------------------- | ------------- |
| Cash                    | `CASH`        |
| General, CurrentAccount | `BANK`        |
| CreditCard              | `CREDIT_CARD` |
| SavingAccount           | `SAVINGS`     |
| Investment              | `ASSET`       |
| Loan                    | `LIABILITY`   |

A guess the person can override on the review screen, which is the point of
staging it.

### Categories — 200 is the problem, not the mapping

This product seeds 21 categories. Importing 200 would replace a usable list with
an unusable one, and most of the 147 custom ones are probably specific to one
year of one person's life.

So the review screen offers four choices per category, not two:

- **Create as a category** — the ordinary case
- **Merge into an existing one** — "Public transport" into যাতায়াত
- **Create as a savings plan** — what the owner asked for: Wallet had no concept
  of a DPS, so a DPS became a category, and here it should become the thing it
  actually is
- **Create as an insurance policy** — same reasoning
- **Skip**

The default offered should be "merge" where a name matches something seeded, and
"create" otherwise, with the whole list sorted by how many records use it —
because a category with 400 records deserves a decision and one with two does
not.

### The three things that genuinely do not map

**Multi-currency.** Two USD accounts and one CNY account, against a workspace
that is BDT throughout. Nothing in this product converts, and inventing a rate
for four years of history would produce figures nobody can check. The honest
options are to import those three accounts with their names and a zero opening
balance and let the person enter what they are worth today, or to skip them.
Not: silently treat 500 USD as ৳500.

**Amounts arrive as floating point.** `{"value": -601.66}`. This codebase bans
float arithmetic on money for good reason, and `601.66 * 100` is `60165.999…`.
The conversion has to go through the string form — `parseMoneyToMinor(String(v))`
— which is exact because JavaScript prints the shortest round-trip
representation. This is a one-line detail and it is the single most likely place
for the import to be quietly wrong by a poisha across 7,215 rows.

**Transfers.** Wallet records carry a `transfer` field; a transfer is one record
on each side. Imported naively they become an expense and an income, which
inflates both totals — the exact mistake the tutorial page spends a paragraph
on. They have to be paired by that field and written as one `TRANSFER`.

---

## 3. How it should work

### Staged, because 7,215 rows is not something to undo by hand

Three phases, each approved before the next runs, and each reversible.

**Phase A — accounts.** Pull 20, show them with a suggested type and the record
count, let the person set the type, rename, or skip. Opening balances left at
zero: the owner said they will enter those, and `balance` from Wallet is today's
figure rather than the opening one, so using it would be wrong anyway.

**Phase B — categories.** Pull 200, sorted by usage, with the four-way choice
above. Nothing is created until the whole list has been decided, because
choosing one at a time across 200 rows is how somebody abandons a migration
half-done.

**Phase C — records.** Only after A and B, because every record needs an account
and a category that now exists here. Written in batches of a few hundred through
the existing `ImportBatch`, which already supports undoing a whole batch in one
press — the thing that makes importing 7,215 rows a decision somebody can take
back.

### Nothing is created until it is approved

Every phase writes to a staging table first — `WalletImportItem`, holding the
source id, the proposed mapping, and the decision. That is what makes "draft
until I confirm" literal rather than a promise, and it is also what makes the
import resumable: a browser closed halfway through 200 categories loses nothing.

### Run twice, get one copy

Every created row carries the Wallet id in `externalRef`, which
`Transaction` already has and which the CSV importer already uses for exactly
this. A second run finds the id, skips the row, and reports it as skipped rather
than creating a duplicate.

---

## 4. What this cannot do

- **It cannot bring the balances honestly.** Wallet's `balance` is today's, not
  the opening one. Once the records are in, the opening balance is whatever
  makes today's figure match — the person enters it and the ledger arrives at
  the right place. Importing `balance` as an opening balance would double-count
  the entire history.
- **It cannot convert currencies**, per §2.
- **It cannot bring attachments, budgets, or Wallet's own goals.** The API
  exposes records, accounts and categories; the rest is not offered.
- **It cannot un-invent a category that should have been a savings plan.**
  Phase B asks; the person answers. There is no way to work it out from the
  name, and guessing would put a DPS in the spending report for another year.

---

## 5. Effort, and what I would build first

| Phase            | Work                                                          |
| ---------------- | ------------------------------------------------------------- |
| A — accounts     | 1 day. 20 rows, a type map, a review screen                   |
| B — categories   | 1½ days. The four-way choice is most of it                    |
| C — records      | 2 days. Pairing transfers, batching, the float-to-poisha care |
| Staging + resume | 1 day. One table, one screen shell both phases share          |

About a week, and it is worth building in that order because **phase A alone is
already useful**: twenty correctly-typed accounts is the tedious half of setting
this product up, and the person can start recording against them the same day
while deciding what to do about 200 categories at their own pace.

---

## 5a. What the account really holds — measured again, properly, 16 August 2026

The table in §1 was taken from `recordStats` and one page of records. Counting
every row over the whole history gives different, larger figures:

|                     | §1 said | Really                                   |
| ------------------- | ------- | ---------------------------------------- |
| Accounts            | 20      | **24**                                   |
| Categories          | 200     | **296** — 62 of them never used once     |
| Records             | 7,215   | **9,625**                                |
| Of those, transfers | unknown | **2,625** records, i.e. ~1,312 transfers |

### The trap that produced the smaller number

`GET /records` **without a date filter silently returns only the last three
months.** It answers 200, it pages normally, and it says so only in an
`appliedRecordDateFilters` field nobody reads:

```
["gte.2026-05-15T08:20:21.344Z","lt.2026-08-16T08:20:21.344Z"]
```

436 rows came back where the history holds 9,625. An import that trusted the
default would look like it worked and bring six per cent of somebody's books —
worse than failing, because nothing says anything is missing. The filter that
means everything is `recordDate=gte.2000-01-01T00:00:00.000Z`; `from`/`to`,
`dateFrom`, and `filter=` are all 400s.

Paging has a second trap: a short page is **not** the last page. Follow
`nextOffset`, and treat its absence as the end.

### What a transfer actually looks like

Each side carries the other with it, so pairing needs no lookup table:

```json
"transfer": {
  "type": "paired",
  "transferId": "2386A2C2-5AB7-4D8B-926F-1E501605FF7A",
  "mirrorRecord": { "id": "…", "accountId": "…", "amount": { "value": 4500 } }
}
```

Write one `TRANSFER` per `transferId` — from the negative side's account to
`mirrorRecord.accountId` — and skip the mirror when it comes round.

---

## 5b. What is built, as of 15 August 2026

Phases A and B, and the spreadsheet round trip. Phase C — the 7,215 records —
is not built.

| Piece                                            | Where                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| Decisions, type map, name guesses, CSV both ways | `packages/core/src/migration.ts`                                  |
| Staging tables                                   | `MigrationBatch`, `MigrationItem`                                 |
| The other product's API                          | `apps/api/src/migration/wallet.client.ts`                         |
| Pull, decide, apply, roll back                   | `apps/api/src/migration/migration.service.ts`                     |
| The screen                                       | `apps/web/src/app/(shell)/migration` → আরও → আগের সফটওয়্যার থেকে |

Endpoints, all under `/v1/migration` and all workspace-scoped:

```
POST   wallet/pull              stage accounts + categories; creates nothing
GET    batches                  every batch, newest first
GET    batches/:id              one batch and its rows
PATCH  batches/:id/items/:item  one decision
GET    batches/:id/csv          the spreadsheet, BOM first
POST   batches/:id/csv          the spreadsheet back
POST   batches/:id/apply        create what the decisions say
POST   batches/:id/rollback     undo exactly what apply created
DELETE batches/:id              discard a draft
```

**It is off for everybody by default.** This is not a plan feature — it is one
person's tool for leaving another product, and it asks that person to paste a
live credential into a form. `MIGRATION_ALLOWED_EMAILS` in
`/etc/hishab/hishab.env` names who may see it: full addresses, or a whole domain
written `@example.com`. Empty or unset means nobody, so a deploy that loses the
variable closes the door rather than opening it. Everybody else finds no link,
no search result, and a sentence instead of a form.

Four things worth knowing before using it:

- **A category can become a savings plan or an insurance policy, and it arrives
  empty.** Wallet held no instalment, term or rate, so the plan is created with
  zeros and a note saying what to fill in. Inventing a term would produce a
  number nobody knows is invented.
- **Apply never aborts part-way.** Each row is attempted on its own; a failure
  is written to that row as text and the batch finishes. What went in and what
  did not is a list on the screen.
- **Rollback keeps whatever has been used.** An account with a transaction
  against it, a plan with a paid instalment — kept, with the reason. It is a
  soft delete, so nothing is destroyed either way.
- **Usage counts are real for accounts, zero for categories.** Wallet reports
  `recordCount` per account and nothing per category; counting categories would
  mean paging all 7,215 records inside one request. The category list is sorted
  by name instead, and the spreadsheet is the answer for two hundred rows.

## 6. Before any of it

The token pasted into chat is a live credential carrying the owner's email and
an expiry in 2027. It should be revoked in Wallet's settings and reissued, and
the new one should reach the server as an environment variable rather than a
message — the same rule the ingest secret and the mail token already follow.

For the import itself the token is needed once, at the moment somebody presses
"connect". It should be held in memory for that run and never written to a
column: a migration tool that stores a working credential to somebody else's
finance account is a liability long after the migration is done.
