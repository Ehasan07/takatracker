import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toLocalDateString } from '@hishab/shared';
import {
  auth,
  createTestApp,
  resetDatabase,
  signup,
  type SignedUpUser,
  type TestContext,
} from './harness';

const TZ = 'Asia/Dhaka';
const month = toLocalDateString(new Date(), TZ).slice(0, 7);
const day = (d: string) => `${month}-${d}`;

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

    const post = (path: string, body: Record<string, unknown>) =>
      ctx.http().post(path).set(auth(user)).send(body).expect(201);

    cashId = (await post('/v1/accounts', { name: 'নগদ', type: 'CASH', openingBalance: 100_000 }))
      .body.id;
    bankId = (
      await post('/v1/accounts', { name: 'ব্যাংক', type: 'BANK', openingBalance: 5_000_000 })
    ).body.id;
    await post('/v1/accounts', { name: 'জমি', type: 'ASSET', openingBalance: 50_000_000 });
    await post('/v1/accounts', {
      name: 'গাড়ির ঋণ',
      type: 'LIABILITY',
      openingBalance: -15_000_000,
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
