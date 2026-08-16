import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromLocalDateString, toLocalDateString } from '@hishab/shared';
import {
  auth,
  createTestApp,
  unlimit,
  resetDatabase,
  signup,
  type SignedUpUser,
  type TestContext,
} from './harness';

const TZ = 'Asia/Dhaka';
const month = toLocalDateString(new Date(), TZ).slice(0, 7);
const day = (d: string) => `${month}-${d}`;

/**
 * The last day of the month before this one, in Dhaka.
 *
 * Every fixture below that says "opening" dates its opening balance here. An
 * opening balance is a dated `OPENING_BALANCE` transaction against equity now,
 * not a column that counted on every date ever, so "৳1,000 was already in the
 * wallet when the month started" has to be said as a day — and it is a
 * different statement from "৳1,000 arrived this month", which is what an
 * undated one would have become. Reached through the calendar rather than by
 * subtracting a day's worth of milliseconds from a string.
 */
const beforeMonth = toLocalDateString(
  new Date(fromLocalDateString(day('01'), TZ).getTime() - 86_400_000),
  TZ,
);

/**
 * A month worked out by hand, then asserted end to end through the API.
 *
 *   opening: নগদ ৳1,000.00, ব্যাংক ৳50,000.00        → liquid ৳51,000.00
 *   income   বেতন            ৳80,000.00  → ব্যাংক
 *   expense  বাসা ভাড়া        ৳18,000.00  ← ব্যাংক
 *   expense  খাবার ও বাজার     ৳ 6,500.00  ← নগদ
 *   expense  খাবার ও বাজার     ৳ 3,500.00  ← নগদ   (same category, two entries)
 *   expense  যাতায়াত          ৳ 2,000.00  ← নগদ
 *
 *   income  = ৳80,000.00                    → 8,000,000 poisha
 *   expense = 18,000 + 6,500 + 3,500 + 2,000
 *           = ৳30,000.00                    → 3,000,000 poisha
 *   net     = ৳50,000.00                    → 5,000,000 poisha
 *   খাবার ও বাজার = ৳10,000.00 → a third of the expense, 33.3%
 *   liquid closing = 51,000 + 80,000 − 30,000 = ৳101,000.00 → 10,100,000
 */
describe('reports', () => {
  let ctx: TestContext;
  let user: SignedUpUser;
  let cashId: string;
  let bankId: string;
  let foodId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    user = await signup(ctx);
    /* Four accounts, and the free plan grants two. This suite is about what the
       reports say, not about what a plan sells. */
    await unlimit(ctx, user.workspaceId);

    const post = (path: string, body: Record<string, unknown>) =>
      ctx.http().post(path).set(auth(user)).send(body).expect(201);

    cashId = (
      await post('/v1/accounts', {
        name: 'নগদ',
        type: 'CASH',
        openingBalance: 100_000,
        openingBalanceDate: beforeMonth,
      })
    ).body.id;
    bankId = (
      await post('/v1/accounts', {
        name: 'ব্যাংক',
        type: 'BANK',
        openingBalance: 5_000_000,
        openingBalanceDate: beforeMonth,
      })
    ).body.id;
    await post('/v1/accounts', {
      name: 'জমি',
      type: 'ASSET',
      openingBalance: 50_000_000,
      openingBalanceDate: beforeMonth,
    });
    await post('/v1/accounts', {
      name: 'গাড়ির ঋণ',
      type: 'LIABILITY',
      openingBalance: -15_000_000,
      openingBalanceDate: beforeMonth,
    });

    const cats = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    const byName = (n: string) => cats.body.find((c: { nameBn: string }) => c.nameBn === n).id;
    foodId = byName('খাবার ও বাজার');

    await post('/v1/transactions', {
      date: day('02'),
      type: 'INCOME',
      amountMinor: 8_000_000,
      accountId: bankId,
      categoryId: byName('বেতন'),
    });
    await post('/v1/transactions', {
      date: day('03'),
      type: 'EXPENSE',
      amountMinor: 1_800_000,
      accountId: bankId,
      categoryId: byName('বাসা ভাড়া'),
    });
    await post('/v1/transactions', {
      date: day('05'),
      type: 'EXPENSE',
      amountMinor: 650_000,
      accountId: cashId,
      categoryId: foodId,
    });
    await post('/v1/transactions', {
      date: day('06'),
      type: 'EXPENSE',
      amountMinor: 350_000,
      accountId: cashId,
      categoryId: foodId,
    });
    await post('/v1/transactions', {
      date: day('07'),
      type: 'EXPENSE',
      amountMinor: 200_000,
      accountId: cashId,
      categoryId: byName('যাতায়াত'),
    });
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  const get = (path: string) => ctx.http().get(path).set(auth(user));

  it('totals expense by category and merges repeats of the same one', async () => {
    // flat=1 is the every-line view; the default folds sub-categories into
    // their parent, which this fixture does not use.
    const res = await get('/v1/reports/by-category?kind=EXPENSE&flat=1').expect(200);
    expect(res.body.total).toBe(3_000_000);

    const food = res.body.rows.find((r: { name: string }) => r.name === 'খাবার ও বাজার');
    // Two separate transactions, one line.
    expect(food.totalMinor).toBe(1_000_000);
    expect(food.sharePercent).toBe(33.3);

    // Largest first.
    expect(res.body.rows[0].name).toBe('বাসা ভাড়া');
  });

  it('totals income by category', async () => {
    const res = await get('/v1/reports/by-category?kind=INCOME&flat=1').expect(200);
    expect(res.body.total).toBe(8_000_000);
    expect(res.body.rows[0].name).toBe('বেতন');
  });

  it('folds the tail into one line without losing a poisha', async () => {
    const res = await get('/v1/reports/by-category?kind=EXPENSE&top=2').expect(200);
    expect(res.body.rows).toHaveLength(3);
    expect(res.body.rows.at(-1).name).toBe('অন্যান্য');
    expect(
      res.body.rows.reduce((s: number, r: { totalMinor: number }) => s + r.totalMinor, 0),
    ).toBe(3_000_000);
  });

  it('returns a contiguous trend with this month s figures at the end', async () => {
    const res = await get('/v1/reports/trend?months=6').expect(200);
    expect(res.body).toHaveLength(6);

    const current = res.body.at(-1);
    expect(current.month).toBe(month);
    expect(current.incomeMinor).toBe(8_000_000);
    expect(current.expenseMinor).toBe(3_000_000);
    expect(current.netMinor).toBe(5_000_000);

    // Quiet months are present as zeros, not missing.
    expect(res.body[0].incomeMinor).toBe(0);
  });

  it('builds a balance sheet that reconciles', async () => {
    const res = await get('/v1/reports/balance-sheet').expect(200);

    // নগদ 1,000 − 12,000 spent = −11,000; ব্যাংক 50,000 + 80,000 − 18,000 = 112,000;
    // জমি 500,000. Assets = −11,000 + 112,000 + 500,000 = ৳601,000.00
    expect(res.body.assetsMinor).toBe(60_100_000);
    expect(res.body.liabilitiesMinor).toBe(15_000_000);
    expect(res.body.netWorthMinor).toBe(45_100_000);
    expect(res.body.assetsMinor - res.body.liabilitiesMinor).toBe(res.body.netWorthMinor);

    // Never a bare number.
    expect(res.body.assets.length).toBeGreaterThan(0);
    expect(res.body.liabilities[0].name).toBe('গাড়ির ঋণ');
    // The hidden system accounts must not appear.
    expect(JSON.stringify(res.body)).not.toContain('SYSTEM_');
  });

  it('says what basis it is prepared on, and that depreciation is not tracked', async () => {
    /* The screen prints a basis-of-preparation block; this is the same fact for
       whoever has the JSON and no screen. A statement that does not say what
       basis it is on cannot be checked, and a reader who knows business
       accounting sees a car at what it cost and assumes somebody forgot to
       depreciate it — so the policy is stated rather than left to be guessed. */
    const res = await get('/v1/reports/balance-sheet').expect(200);
    expect(res.body.basis).toBe('CASH');
    expect(res.body.notes.some((n: string) => n.includes('অবচয়'))).toBe(true);

    // Every shape this endpoint returns, not only the undated one.
    const dated = await get(`/v1/reports/balance-sheet?asOf=${day('28')}`).expect(200);
    expect(dated.body.basis).toBe('CASH');
    expect(dated.body.notes).toHaveLength(res.body.notes.length);

    const compared = await get(
      `/v1/reports/balance-sheet?asOf=${day('28')}&compareTo=${day('01')}`,
    ).expect(200);
    expect(compared.body.basis).toBe('CASH');
    expect(compared.body.comparison).toBeDefined();
  });

  it('states the same basis on all four statements', async () => {
    /* One literal, four statements. Two of them used to carry it and two did
       not, which is the version of "stated" that lets a consumer read a balance
       sheet and never learn what it is. */
    const [sheet, cash, income, netWorth] = await Promise.all([
      get('/v1/reports/balance-sheet').expect(200),
      get('/v1/reports/cash-flow').expect(200),
      get('/v1/reports/income-statement').expect(200),
      get('/v1/reports/net-worth-changes').expect(200),
    ]);

    for (const res of [sheet, cash, income, netWorth]) {
      expect(res.body.basis).toBe('CASH');
    }
  });

  it('gives the dashboard the same two figures the balance sheet does', async () => {
    /* The dashboard used to add up `GET /accounts` and call it "মোট ব্যালেন্স".
       That summed a ৳500,000 plot of land with ৳3,600 of cash — telling
       somebody they had half a million to spend — while leaving out the money
       they had lent, which lives in a hidden control account. Wrong in both
       directions from one line of arithmetic on a screen.

       This is the assertion that stops it coming back: the headline figures
       come from `buildBalanceSheet`, so the dashboard and the balance sheet
       cannot disagree about whether land is money. */
    const summary = await get('/v1/transactions/summary').expect(200);
    const sheet = await get('/v1/reports/balance-sheet').expect(200);

    expect(summary.body.liquidMinor).toBe(sheet.body.liquidMinor);
    expect(summary.body.netWorthMinor).toBe(sheet.body.netWorthMinor);

    // And the two are genuinely different numbers here, or the test proves nothing.
    expect(summary.body.liquidMinor).not.toBe(summary.body.netWorthMinor);
    // Land is worth ৳500,000 and is not spendable balance.
    expect(summary.body.liquidMinor).toBeLessThan(50_000_000);
  });

  it('closes the cash flow exactly on the liquid balance', async () => {
    const res = await get('/v1/reports/cash-flow').expect(200);
    expect(res.body.openingMinor).toBe(5_100_000);
    expect(res.body.inflowMinor).toBe(8_000_000);
    expect(res.body.outflowMinor).toBe(3_000_000);
    expect(res.body.closingMinor).toBe(10_100_000);

    // The check that catches a query missing an entry: closing must equal the
    // liquid accounts' balance on the balance sheet.
    const sheet = await get('/v1/reports/balance-sheet').expect(200);
    expect(sheet.body.liquidMinor).toBe(res.body.closingMinor);
  });

  it('splits the cash flow into operating, investing and financing', async () => {
    /* IAS 7's whole point: ৳80,000 of salary and ৳80,000 borrowed are the same
       number and completely different facts. A lender reads the operating line
       to see whether somebody lives within their means. */
    const res = await get('/v1/reports/cash-flow').expect(200);

    /* Salary in, rent and groceries and transport out. The land was bought
       before this fixture's window opened, so investing is quiet here. */
    expect(res.body.operatingMinor).toBe(5_000_000);
    expect(res.body.investingMinor).toBe(0);
    expect(res.body.financingMinor).toBe(0);
  });

  it('the three sections reconcile with the closing balance', async () => {
    /* The check that makes it a report rather than arithmetic: opening plus the
       three sections has to land exactly on what the accounts actually hold. A
       movement classified into nothing, or counted twice, fails here. */
    const res = await get('/v1/reports/cash-flow').expect(200);
    expect(
      res.body.openingMinor +
        res.body.operatingMinor +
        res.body.investingMinor +
        res.body.financingMinor,
    ).toBe(res.body.closingMinor);
  });

  it('publishes its own verdict on whether it reconciles', async () => {
    /* The server does the check and says so, rather than leaving every client
       to redo the arithmetic — and one day to redo it differently. Present on
       a healthy statement too: a field that only appears when things are broken
       is a field no client remembers to read. */
    const res = await get('/v1/reports/cash-flow').expect(200);
    expect(res.body.reconciled).toBe(true);
    expect(res.body.discrepancyMinor).toBe(0);
    expect(res.body.basis).toBe('CASH');
  });

  it('files buying land as investing, not as spending', async () => {
    /* A transfer from a bank account to a land account is an investing outflow;
       a transfer between two bank accounts is not a cash flow at all. Same
       transaction type, different sections — which is why the classification
       reads the account on the other side rather than the type. */
    const land = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'নতুন জমি', type: 'ASSET' })
      .expect(201);

    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        type: 'TRANSFER',
        date: day('20'),
        amountMinor: 1_000_000,
        accountId: cashId,
        counterAccountId: land.body.id,
        description: 'জমির কিস্তি',
      })
      .expect(201);

    const res = await get('/v1/reports/cash-flow').expect(200);
    expect(res.body.investingMinor).toBe(-1_000_000);
    /* Spending is untouched: land is not consumed, it is still yours. */
    expect(res.body.operatingMinor).toBe(5_000_000);
    expect(
      res.body.openingMinor +
        res.body.operatingMinor +
        res.body.investingMinor +
        res.body.financingMinor,
    ).toBe(res.body.closingMinor);
  });

  it('files lending money as financing', async () => {
    const person = await ctx
      .http()
      .post('/v1/loans')
      .set(auth(user))
      .send({
        direction: 'LENT',
        personName: 'নগদ ধার',
        principalMinor: 500_000,
        loanDate: day('21'),
        accountId: cashId,
      })
      .expect(201);
    expect(person.body.loan.id).toBeTruthy();

    const res = await get('/v1/reports/cash-flow').expect(200);
    expect(res.body.financingMinor).toBe(-500_000);
    expect(
      res.body.openingMinor +
        res.body.operatingMinor +
        res.body.investingMinor +
        res.body.financingMinor,
    ).toBe(res.body.closingMinor);
  });

  it('gives an income statement with both sides and a comparative column', async () => {
    const res = await get(
      `/v1/reports/income-statement?from=${day('01')}&to=${day('28')}&compareFrom=${day('01')}&compareTo=${day('02')}`,
    ).expect(200);

    expect(res.body.incomeMinor).toBe(8_000_000);
    expect(res.body.expenseMinor).toBe(3_000_000);
    expect(res.body.surplusMinor).toBe(5_000_000);
    /* ৳50,000 kept out of ৳80,000 earned: 62.5%, which is the single figure a
       lender reads before any of the detail. */
    expect(res.body.savingsRateBps).toBe(6250);

    /* IAS 1 requires comparatives, and a period with nothing beside it tells a
       reader the numbers but not the direction. */
    expect(res.body.comparison.incomeMinor).toBe(8_000_000);
    expect(res.body.comparison.expenseMinor).toBe(0);

    /* A statement handed to a bank has to say what basis it is on. */
    expect(res.body.basis).toBe('CASH');
  });

  it('agrees with the by-category report it is built from', async () => {
    const statement = await get(
      `/v1/reports/income-statement?from=${day('01')}&to=${day('28')}`,
    ).expect(200);
    const byCategory = await get('/v1/reports/by-category?kind=EXPENSE&flat=1').expect(200);
    expect(statement.body.expenseMinor).toBe(byCategory.body.total);
  });

  it('splits the balance sheet into current and non-current (IAS 1.60)', async () => {
    const res = await get('/v1/reports/balance-sheet').expect(200);

    /* By the time this runs the two tests above have moved ৳10,000 into a land
       account and lent ৳5,000, so:
         cash   −11,000 − 10,000 − 5,000 = −26,000
         bank    112,000
         owed      5,000  (current: a loan to a relative is collected on demand)
         current  86,000 + 5,000 = ৳91,000
         land    500,000 + 10,000 = ৳510,000, none of it current */
    expect(res.body.currentAssetsMinor).toBe(9_100_000);
    expect(res.body.nonCurrentAssetsMinor).toBe(51_000_000);
    expect(res.body.currentAssetsMinor + res.body.nonCurrentAssetsMinor).toBe(res.body.assetsMinor);

    /* The car loan is long-term, so working capital is the whole current side. */
    expect(res.body.nonCurrentLiabilitiesMinor).toBe(15_000_000);
    expect(res.body.workingCapitalMinor).toBe(9_100_000);
  });

  it('reconciles net worth: opening + surplus + other = closing', async () => {
    /* The check that makes the other three statements answerable to each other.
       An income statement and a balance sheet can each be internally consistent
       and still disagree, and nothing on either page would say so. */
    const res = await get(`/v1/reports/net-worth-changes?from=${day('01')}&to=${day('28')}`).expect(
      200,
    );

    expect(res.body.openingMinor + res.body.surplusMinor + res.body.otherMinor).toBe(
      res.body.closingMinor,
    );
    expect(res.body.movementMinor).toBe(res.body.closingMinor - res.body.openingMinor);
    expect(res.body.surplusMinor).toBe(5_000_000);
  });

  it('revalues an asset without inventing income', async () => {
    /* Land bought at ৳500,000 is now worth ৳700,000. Net worth rises ৳200,000
       and the household earned nothing — which is exactly the case the
       statement of changes in net worth exists to explain, and exactly the case
       a report that folded it into the surplus would get wrong. */
    const accounts = await get('/v1/accounts').expect(200);
    const land = accounts.body.find((a: { name: string }) => a.name === 'জমি');

    const before = await get('/v1/reports/balance-sheet').expect(200);
    const beforeIncome = await get(
      `/v1/reports/income-statement?from=${day('01')}&to=${day('28')}`,
    ).expect(200);
    const beforeFlow = await get('/v1/reports/cash-flow').expect(200);

    const res = await ctx
      .http()
      .post(`/v1/accounts/${land.id}/revalue`)
      .set(auth(user))
      .send({ valueMinor: 70_000_000, date: day('22'), note: 'বাজারদর অনুযায়ী' })
      .expect(201);
    expect(res.body.deltaMinor).toBe(20_000_000);

    const after = await get('/v1/reports/balance-sheet').expect(200);
    expect(after.body.netWorthMinor).toBe(before.body.netWorthMinor + 20_000_000);
    /* Land is not current, so a revaluation must not make anybody look liquid. */
    expect(after.body.currentAssetsMinor).toBe(before.body.currentAssetsMinor);

    /* Not income, and not a cash flow. Both fall out of posting against equity,
       and both are what the revaluation model requires. */
    const afterIncome = await get(
      `/v1/reports/income-statement?from=${day('01')}&to=${day('28')}`,
    ).expect(200);
    expect(afterIncome.body.incomeMinor).toBe(beforeIncome.body.incomeMinor);
    expect(afterIncome.body.surplusMinor).toBe(beforeIncome.body.surplusMinor);

    const afterFlow = await get('/v1/reports/cash-flow').expect(200);
    expect(afterFlow.body.closingMinor).toBe(beforeFlow.body.closingMinor);
    expect(afterFlow.body.investingMinor).toBe(beforeFlow.body.investingMinor);
  });

  it('shows the revaluation on the line that explains net worth', async () => {
    const res = await get(`/v1/reports/net-worth-changes?from=${day('01')}&to=${day('28')}`).expect(
      200,
    );

    /* `otherMinor` is the balancing figure and its job is to be visible: this is
       where a reader looks when net worth moved and no income did. */
    expect(res.body.otherMinor).toBe(20_000_000);
    expect(res.body.openingMinor + res.body.surplusMinor + res.body.otherMinor).toBe(
      res.body.closingMinor,
    );
  });

  it('keeps the history of what an asset was worth', async () => {
    const accounts = await get('/v1/accounts').expect(200);
    const land = accounts.body.find((a: { name: string }) => a.name === 'জমি');
    const history = await get(`/v1/accounts/${land.id}/revaluations`).expect(200);

    expect(history.body).toHaveLength(1);
    expect(history.body[0].deltaMinor).toBe(20_000_000);
    expect(history.body[0].note).toBe('বাজারদর অনুযায়ী');
  });

  it('refuses to revalue cash, which does not appreciate', async () => {
    /* If a wallet disagrees with the ledger one of them is wrong, and the fix is
       a reconciliation. Offering a revaluation here would let a bookkeeping
       error be filed as a market gain. */
    const res = await ctx
      .http()
      .post(`/v1/accounts/${cashId}/revalue`)
      .set(auth(user))
      .send({ valueMinor: 999_999, date: day('22') })
      .expect(400);
    expect(res.body.message).toMatch(/সমন্বয়/);
  });

  it('drills into one category and lists what is behind it', async () => {
    const res = await get(`/v1/reports/category/${foodId}`).expect(200);
    expect(res.body.category.name).toBe('খাবার ও বাজার');
    expect(res.body.totalMinor).toBe(1_000_000);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].date >= res.body.items[1].date).toBe(true);
  });

  it('honours an explicit date range', async () => {
    const narrow = await get(
      `/v1/reports/by-category?kind=EXPENSE&flat=1&from=${day('05')}&to=${day('06')}`,
    ).expect(200);
    // Only the two food entries fall inside.
    expect(narrow.body.total).toBe(1_000_000);

    // The upper bound is inclusive.
    const single = await get(
      `/v1/reports/by-category?kind=EXPENSE&flat=1&from=${day('07')}&to=${day('07')}`,
    ).expect(200);
    expect(single.body.total).toBe(200_000);
  });

  it('rejects a malformed date instead of guessing', async () => {
    await get('/v1/reports/by-category?from=07-08-2026').expect(400);
  });

  it('never reports across a workspace boundary', async () => {
    const bob = await signup(ctx);
    const sheet = await ctx.http().get('/v1/reports/balance-sheet').set(auth(bob)).expect(200);
    expect(sheet.body.netWorthMinor).toBe(0);

    const byCat = await ctx
      .http()
      .get('/v1/reports/by-category?kind=EXPENSE&flat=1')
      .set(auth(bob))
      .expect(200);
    expect(byCat.body.total).toBe(0);

    await ctx.http().get(`/v1/reports/category/${foodId}`).set(auth(bob)).expect(404);
  });
});

/**
 * Quantities get their own workspace.
 *
 * The suite above builds one fixture in `beforeAll` and every test in it
 * asserts that fixture's totals — three extra transactions moved all of them at
 * once. A feature that needs its own rows needs its own books.
 */
describe('quantity reporting', () => {
  let ctx: TestContext;
  let user: SignedUpUser;
  let cashId: string;
  let foodId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    user = await signup(ctx);

    const cash = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({
        name: 'নগদ',
        type: 'CASH',
        openingBalance: 1_000_000,
        openingBalanceDate: beforeMonth,
      })
      .expect(201);
    cashId = cash.body.id;

    const cats = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    foodId = cats.body.find((c: { nameBn: string }) => c.nameBn === 'খাবার ও বাজার').id;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('totals how much of a thing was bought, never mixing units', async () => {
    /* The question money cannot answer: "৳12,000 on fuel" is already on every
       report, and "340 litres" is the one somebody acts on — a price rise and a
       habit change look identical in taka and completely different in litres. */
    const buy = (amountMinor: number, quantityMilli: number, quantityUnit: string) =>
      ctx
        .http()
        .post('/v1/transactions')
        .set(auth(user))
        .send({
          date: day('15'),
          type: 'EXPENSE',
          amountMinor,
          accountId: cashId,
          categoryId: foodId,
          quantityMilli,
          quantityUnit,
        })
        .expect(201);

    await buy(50_000, 2_000, 'লিটার'); // 2 L
    await buy(30_000, 1_500, 'লিটার'); // 1.5 L
    await buy(120_000, 5_000, 'কেজি'); // 5 kg

    const res = await ctx.http().get('/v1/reports/by-quantity').set(auth(user)).expect(200);
    const litres = res.body.units.find((u: { unit: string }) => u.unit === 'লিটার');
    const kilos = res.body.units.find((u: { unit: string }) => u.unit === 'কেজি');

    // 3.5 litres, in thousandths. Kilos are their own row and are never added in.
    expect(litres.totalMilli).toBe(3_500);
    expect(litres.transactionCount).toBe(2);
    expect(kilos.totalMilli).toBe(5_000);
    expect(litres.categories[0].name).toBe('খাবার ও বাজার');
  });

  it('refuses a quantity with no unit, and a unit with no quantity', async () => {
    /* A number with no unit cannot be read back, and a unit with no number says
       nothing. Both or neither — the same rule the currency pair follows. */
    const base = {
      date: day('15'),
      type: 'EXPENSE',
      amountMinor: 10_000,
      accountId: cashId,
      categoryId: foodId,
    };
    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({ ...base, quantityMilli: 1_000 })
      .expect(400);
    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({ ...base, quantityUnit: 'কেজি' })
      .expect(400);
  });
});

/**
 * The reconciliation guard, against the movement that used to defeat it.
 *
 * Its own workspace, for the same reason quantities have one: this suite books
 * an adjustment and an opening-balance entry, and either would move every total
 * the fixture above asserts.
 */
describe('a cash flow that has to add up', () => {
  let ctx: TestContext;
  let user: SignedUpUser;
  let cashId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    user = await signup(ctx);

    const cash = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({
        name: 'নগদ',
        type: 'CASH',
        openingBalance: 1_000_000,
        openingBalanceDate: beforeMonth,
      })
      .expect(201);
    cashId = cash.body.id;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  const flow = async () =>
    (await ctx.http().get('/v1/reports/cash-flow').set(auth(user)).expect(200)).body;

  const reconciles = (body: {
    openingMinor: number;
    operatingMinor: number;
    investingMinor: number;
    financingMinor: number;
    closingMinor: number;
  }) =>
    body.openingMinor + body.operatingMinor + body.investingMinor + body.financingMinor ===
    body.closingMinor;

  it('keeps a reconciliation adjustment in the statement instead of losing it', async () => {
    /* The defect the guard was written for, reached from a button any user can
       press. `POST /accounts/:id/reconcile` books the difference against the
       workspace's equity account; equity movements used to be filed as
       INTERNAL, so ৳500 landed in the closing balance and in no section, and
       every line of the statement still looked plausible.

       Financing rather than operating: IAS 7.17 puts cash arising from equity
       there, and operating is the line a lender reads as "does this household
       live within its means" — a found difference is not earning. */
    await ctx
      .http()
      .post(`/v1/accounts/${cashId}/reconcile`)
      .set(auth(user))
      .send({ date: day('10'), actualBalanceMinor: 1_050_000 })
      .expect(201);

    const body = await flow();
    expect(body.financingMinor).toBe(50_000);
    expect(body.closingMinor).toBe(1_050_000);
    expect(body.reconciled).toBe(true);
    expect(body.discrepancyMinor).toBe(0);
    expect(reconciles(body)).toBe(true);
  });

  it('keeps an opening-balance entry dated inside the period in the statement', async () => {
    /* The other equity movement a real workspace produces: an opening figure
       entered as a dated transaction rather than as the account's opening
       balance. The money was arguably always there, but the *period* did not
       start with it — `openingMinor` is the liquid position the day before the
       window — so the statement has to explain where it came from or fail to
       add up. */
    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: day('11'),
        type: 'OPENING_BALANCE',
        amountMinor: 200_000,
        accountId: cashId,
        description: 'প্রারম্ভিক জের',
      })
      .expect(201);

    const body = await flow();
    expect(body.financingMinor).toBe(250_000);
    expect(body.closingMinor).toBe(1_250_000);
    expect(body.reconciled).toBe(true);
    expect(reconciles(body)).toBe(true);
  });

  it('still reconciles with all three sections in play', async () => {
    const cats = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    const salary = cats.body.find((c: { nameBn: string }) => c.nameBn === 'বেতন').id;

    const gold = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'স্বর্ণ', type: 'ASSET', openingBalance: 0 })
      .expect(201);

    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: day('12'),
        type: 'INCOME',
        amountMinor: 3_000_000,
        accountId: cashId,
        categoryId: salary,
      })
      .expect(201);

    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: day('13'),
        type: 'TRANSFER',
        amountMinor: 800_000,
        accountId: cashId,
        counterAccountId: gold.body.id,
      })
      .expect(201);

    const body = await flow();
    expect(body.operatingMinor).toBe(3_000_000);
    expect(body.investingMinor).toBe(-800_000);
    expect(body.financingMinor).toBe(250_000);
    expect(body.closingMinor).toBe(3_450_000);
    expect(body.reconciled).toBe(true);
    expect(reconciles(body)).toBe(true);

    // And the closing figure is still the liquid balance the accounts hold.
    const sheet = await ctx.http().get('/v1/reports/balance-sheet').set(auth(user)).expect(200);
    expect(sheet.body.liquidMinor).toBe(body.closingMinor);
  });
});

/**
 * Selling an asset — the moment a paper gain becomes a real one.
 *
 * Revaluing and selling are opposites in the way that matters: revaluing posts
 * to equity and touches no cash (IAS 16.39), selling turns the asset into cash
 * and the gain goes to profit or loss (IAS 16.68). Getting them the wrong way
 * round puts a realised gain in equity or an unrealised one in income, and both
 * errors run in the direction that flatters.
 */
describe('selling an asset', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  type User = Awaited<ReturnType<typeof signup>>;

  const account = (user: User, name: string, type: string, openingBalance = 0) =>
    ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name, type, openingBalance, openingBalanceDate: '2026-01-01' })
      .expect(201)
      .then((res) => res.body as { id: string });

  const categoryOf = async (user: User, kind: 'INCOME' | 'EXPENSE'): Promise<string> => {
    const res = await ctx.http().get(`/v1/categories?kind=${kind}`).set(auth(user)).expect(200);
    return (res.body as { id: string }[])[0]!.id;
  };

  const balances = async (user: User): Promise<Record<string, number>> => {
    const res = await ctx
      .http()
      .get('/v1/accounts?includeArchived=true')
      .set(auth(user))
      .expect(200);
    const out: Record<string, number> = {};
    for (const a of res.body as { id: string; balanceMinor: number }[]) out[a.id] = a.balanceMinor;
    return out;
  };

  it('books only the gain over the carrying amount, not over the cost', async () => {
    const user = await signup(ctx);
    const bank = await account(user, 'সিটি ব্যাংক', 'BANK');
    // Bought at ৳8,00,000.
    const land = await account(user, 'বসিলার জমি', 'ASSET', 80_000_000);

    // Revalued to ৳9,00,000 — that first lakh went to equity, not income.
    await ctx
      .http()
      .post(`/v1/accounts/${land.id}/revalue`)
      .set(auth(user))
      .send({ valueMinor: 90_000_000, date: '2026-06-01' })
      .expect(201);

    const beforeIncome = await ctx
      .http()
      .get('/v1/reports/income-statement?from=2026-01-01&to=2026-12-31')
      .set(auth(user))
      .expect(200);

    // Sold for ৳11,00,000.
    const res = await ctx
      .http()
      .post(`/v1/accounts/${land.id}/sell`)
      .set(auth(user))
      .send({
        proceedsMinor: 110_000_000,
        destinationAccountId: bank.id,
        categoryId: await categoryOf(user, 'INCOME'),
        date: '2026-08-01',
      })
      .expect(200);

    expect(res.body.carryingMinor).toBe(90_000_000);
    /* ৳2,00,000, not ৳3,00,000. The first lakh was earned when it was revalued
       and is not earned a second time on the way out. */
    expect(res.body.gainMinor).toBe(20_000_000);

    const after = await balances(user);
    expect(after[bank.id]).toBe(110_000_000);
    expect(after[land.id]).toBe(0);

    const afterIncome = await ctx
      .http()
      .get('/v1/reports/income-statement?from=2026-01-01&to=2026-12-31')
      .set(auth(user))
      .expect(200);
    expect(afterIncome.body.incomeMinor - beforeIncome.body.incomeMinor).toBe(20_000_000);
  });

  it('books a loss as an expense when it sold for less', async () => {
    const user = await signup(ctx);
    const bank = await account(user, 'সিটি ব্যাংক', 'BANK');
    const car = await account(user, 'পালসার', 'ASSET', 15_000_000);

    const res = await ctx
      .http()
      .post(`/v1/accounts/${car.id}/sell`)
      .set(auth(user))
      .send({
        proceedsMinor: 11_000_000,
        destinationAccountId: bank.id,
        categoryId: await categoryOf(user, 'EXPENSE'),
        date: '2026-08-01',
      })
      .expect(200);

    expect(res.body.gainMinor).toBe(-4_000_000);

    const after = await balances(user);
    expect(after[car.id]).toBe(0);
    expect(after[bank.id]).toBe(11_000_000);

    const income = await ctx
      .http()
      .get('/v1/reports/income-statement?from=2026-01-01&to=2026-12-31')
      .set(auth(user))
      .expect(200);
    expect(income.body.expenseMinor).toBe(4_000_000);
  });

  it('archives the sold asset so it leaves the list of what is owned', async () => {
    const user = await signup(ctx);
    const bank = await account(user, 'সিটি ব্যাংক', 'BANK');
    const land = await account(user, 'বসিলার জমি', 'ASSET', 80_000_000);

    await ctx
      .http()
      .post(`/v1/accounts/${land.id}/sell`)
      .set(auth(user))
      .send({
        proceedsMinor: 80_000_000,
        destinationAccountId: bank.id,
        categoryId: await categoryOf(user, 'INCOME'),
        date: '2026-08-01',
      })
      .expect(200);

    /* Gone from the ordinary list, still there behind `includeArchived`. The
       sale is the last chapter of a history that has to stay readable. */
    const live = await ctx.http().get('/v1/accounts').set(auth(user)).expect(200);
    expect((live.body as { id: string }[]).some((a) => a.id === land.id)).toBe(false);

    const all = await ctx
      .http()
      .get('/v1/accounts?includeArchived=true')
      .set(auth(user))
      .expect(200);
    expect((all.body as { id: string }[]).some((a) => a.id === land.id)).toBe(true);
  });

  it('leaves the whole price as the gain when the books carried it at zero', async () => {
    const user = await signup(ctx);
    const bank = await account(user, 'সিটি ব্যাংক', 'BANK');
    // A fully written-down asset, or one that arrived with no opening balance.
    const scrap = await account(user, 'পুরনো যন্ত্র', 'ASSET');

    const res = await ctx
      .http()
      .post(`/v1/accounts/${scrap.id}/sell`)
      .set(auth(user))
      .send({
        proceedsMinor: 5_000_000,
        destinationAccountId: bank.id,
        categoryId: await categoryOf(user, 'INCOME'),
        date: '2026-08-01',
      })
      .expect(200);

    expect(res.body.carryingMinor).toBe(0);
    expect(res.body.gainMinor).toBe(5_000_000);
  });

  it('refuses an income khat on a loss, and an expense khat on a gain', async () => {
    const user = await signup(ctx);
    const bank = await account(user, 'সিটি ব্যাংক', 'BANK');
    const land = await account(user, 'বসিলার জমি', 'ASSET', 80_000_000);

    /* A gain filed under an expense head is a figure nobody looking for it
       would ever find. */
    await ctx
      .http()
      .post(`/v1/accounts/${land.id}/sell`)
      .set(auth(user))
      .send({
        proceedsMinor: 90_000_000,
        destinationAccountId: bank.id,
        categoryId: await categoryOf(user, 'EXPENSE'),
        date: '2026-08-01',
      })
      .expect(400);

    await ctx
      .http()
      .post(`/v1/accounts/${land.id}/sell`)
      .set(auth(user))
      .send({
        proceedsMinor: 70_000_000,
        destinationAccountId: bank.id,
        categoryId: await categoryOf(user, 'INCOME'),
        date: '2026-08-01',
      })
      .expect(400);

    // And nothing was booked by either attempt.
    expect((await balances(user))[land.id]).toBe(80_000_000);
  });

  it('refuses to sell cash, which is not an asset you dispose of', async () => {
    const user = await signup(ctx);
    const bank = await account(user, 'সিটি ব্যাংক', 'BANK', 10_000_000);
    const cash = await account(user, 'নগদ', 'CASH', 5_000_000);

    const res = await ctx
      .http()
      .post(`/v1/accounts/${cash.id}/sell`)
      .set(auth(user))
      .send({
        proceedsMinor: 5_000_000,
        destinationAccountId: bank.id,
        categoryId: await categoryOf(user, 'INCOME'),
        date: '2026-08-01',
      })
      .expect(400);
    expect(String(res.body.message)).toContain('স্থানান্তর');
  });

  it('refuses to put the money back into the asset being sold', async () => {
    const user = await signup(ctx);
    const land = await account(user, 'বসিলার জমি', 'ASSET', 80_000_000);

    await ctx
      .http()
      .post(`/v1/accounts/${land.id}/sell`)
      .set(auth(user))
      .send({
        proceedsMinor: 90_000_000,
        destinationAccountId: land.id,
        categoryId: await categoryOf(user, 'INCOME'),
        date: '2026-08-01',
      })
      .expect(400);
  });

  it('never reaches another workspace’s asset', async () => {
    const user = await signup(ctx);
    const stranger = await signup(ctx);
    const bank = await account(user, 'সিটি ব্যাংক', 'BANK');
    const theirs = await account(stranger, 'তাদের জমি', 'ASSET', 80_000_000);

    await ctx
      .http()
      .post(`/v1/accounts/${theirs.id}/sell`)
      .set(auth(user))
      .send({
        proceedsMinor: 90_000_000,
        destinationAccountId: bank.id,
        categoryId: await categoryOf(user, 'INCOME'),
        date: '2026-08-01',
      })
      .expect(404);
  });

  it('keeps the ledger balanced, which the trigger would refuse anyway', async () => {
    const user = await signup(ctx);
    const bank = await account(user, 'সিটি ব্যাংক', 'BANK');
    const land = await account(user, 'বসিলার জমি', 'ASSET', 80_000_000);

    await ctx
      .http()
      .post(`/v1/accounts/${land.id}/sell`)
      .set(auth(user))
      .send({
        proceedsMinor: 110_000_000,
        destinationAccountId: bank.id,
        categoryId: await categoryOf(user, 'INCOME'),
        date: '2026-08-01',
      })
      .expect(200);

    const rows = await ctx.prisma.ledgerEntry.groupBy({
      by: ['transactionId'],
      where: { workspaceId: user.workspaceId },
      _sum: { amountMinor: true },
    });
    expect(rows.length).toBeGreaterThan(0);
  });
});
