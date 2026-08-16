import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, createTestApp, resetDatabase, signup, unlimit, type TestContext } from './harness';

/**
 * Expenses that cover a period, and the month-by-month view of them.
 *
 * The arithmetic is covered unit-by-unit in `src/transactions/prepaid.spec.ts`,
 * so nothing here re-derives a monthly share. What these tests defend is the
 * promise the feature is built on: **it changes nothing**. Marking a ৳12,000
 * premium as a year's cover must leave the ledger byte-for-byte as it was — the
 * whole expense on the day it was paid, no monthly rows generated, the income
 * statement untouched — because every statement this app serves declares
 * `basis: 'CASH'` and an accrual booked quietly behind that makes it false.
 *
 * The second thing they defend is the tenancy, which is the ordinary reason.
 */

/** ৳12,000.00 — a year of car insurance, the case this exists for. */
const PREMIUM = 1_200_000;

describe('prepaid expenses', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  type User = Awaited<ReturnType<typeof signup>>;

  const bank = (user: User) =>
    ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'সিটি ব্যাংক', type: 'BANK', openingBalance: 10_000_000 })
      .expect(201)
      .then((res) => res.body as { id: string });

  const expenseCategory = async (user: User): Promise<string> => {
    const res = await ctx.http().get('/v1/categories?kind=EXPENSE').set(auth(user)).expect(200);
    const rows = res.body as { id: string }[];
    if (rows.length === 0) throw new Error('no seeded expense categories');
    return rows[0]!.id;
  };

  const spend = async (user: User, over: Record<string, unknown> = {}): Promise<{ id: string }> => {
    const account = await bank(user);
    const res = await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: '2026-04-10',
        type: 'EXPENSE',
        amountMinor: PREMIUM,
        accountId: account.id,
        categoryId: await expenseCategory(user),
        description: 'গাড়ির বীমা',
        ...over,
      })
      .expect(201);
    return res.body as { id: string };
  };

  const mark = (user: User, id: string, body: Record<string, unknown>) =>
    ctx.http().patch(`/v1/transactions/${id}/prepaid`).set(auth(user)).send(body);

  it('spreads a year of insurance across twelve months and books not one poisha', async () => {
    const user = await signup(ctx);
    const txn = await spend(user);

    const before = await ctx.prisma.transaction.count({
      where: { workspaceId: user.workspaceId, deletedAt: null },
    });

    await mark(user, txn.id, { startDate: '2026-04-01', months: 12 }).expect(200);

    /* The one assertion the whole feature rests on: marking generated nothing.
       A monthly amortisation row would make these books mixed-basis while four
       statement responses go on saying they are not. */
    expect(
      await ctx.prisma.transaction.count({
        where: { workspaceId: user.workspaceId, deletedAt: null },
      }),
    ).toBe(before);

    // April's expense is still the whole premium, not a twelfth of it.
    const april = await ctx
      .http()
      .get('/v1/transactions/summary?month=2026-04')
      .set(auth(user))
      .expect(200);
    expect(april.body.expenseMinor).toBe(PREMIUM);
    // And May's is still nothing.
    const may = await ctx
      .http()
      .get('/v1/transactions/summary?month=2026-05')
      .set(auth(user))
      .expect(200);
    expect(may.body.expenseMinor).toBe(0);

    const spread = await ctx
      .http()
      .get('/v1/transactions/prepaid/spread?from=2026-04&months=12')
      .set(auth(user))
      .expect(200);

    expect(spread.body.months).toHaveLength(12);
    expect(spread.body.months.map((m: { totalMinor: number }) => m.totalMinor)).toEqual(
      Array.from({ length: 12 }, () => 100_000),
    );
    // Twelve months of it and no more: the shares add up to what was paid.
    expect(spread.body.windowTotalMinor).toBe(PREMIUM);
    expect(spread.body.items).toHaveLength(1);
    expect(spread.body.items[0]).toMatchObject({
      transactionId: txn.id,
      totalMinor: PREMIUM,
      startMonth: '2026-04',
      endMonth: '2027-03',
      months: 12,
      perMonthMinor: 100_000,
    });
  });

  it('shows the period on the transaction itself, and takes it back when cleared', async () => {
    const user = await signup(ctx);
    const txn = await spend(user);
    await mark(user, txn.id, { startDate: '2026-04-01', months: 12 }).expect(200);

    const read = await ctx.http().get(`/v1/transactions/${txn.id}`).set(auth(user)).expect(200);
    expect(read.body.prepaidStartDate).toBe('2026-04-01');
    expect(read.body.prepaidMonths).toBe(12);

    await mark(user, txn.id, { startDate: null, months: null }).expect(200);

    const cleared = await ctx.http().get(`/v1/transactions/${txn.id}`).set(auth(user)).expect(200);
    expect(cleared.body.prepaidStartDate).toBeNull();
    expect(cleared.body.prepaidMonths).toBeNull();

    const spread = await ctx
      .http()
      .get('/v1/transactions/prepaid/spread?from=2026-04&months=12')
      .set(auth(user))
      .expect(200);
    expect(spread.body.items).toEqual([]);
  });

  it('leaves the marking alone when the transaction is edited', async () => {
    const user = await signup(ctx);
    const txn = await spend(user);
    await mark(user, txn.id, { startDate: '2026-04-01', months: 12 }).expect(200);

    const account = (await ctx.http().get('/v1/accounts').set(auth(user)).expect(200)).body.find(
      (a: { type: string }) => a.type === 'BANK',
    ) as { id: string };

    /* An ordinary edit does not mention the two columns, so they must survive
       it: somebody correcting a typo in the description has not said anything
       about how many months the premium covered. */
    await ctx
      .http()
      .patch(`/v1/transactions/${txn.id}`)
      .set(auth(user))
      .send({
        date: '2026-04-10',
        type: 'EXPENSE',
        amountMinor: PREMIUM,
        accountId: account.id,
        categoryId: await expenseCategory(user),
        description: 'গাড়ির বীমা — নবায়ন',
      })
      .expect(200);

    const read = await ctx.http().get(`/v1/transactions/${txn.id}`).set(auth(user)).expect(200);
    expect(read.body.prepaidMonths).toBe(12);
  });

  it('drops a deleted payment out of the spread', async () => {
    const user = await signup(ctx);
    const txn = await spend(user);
    await mark(user, txn.id, { startDate: '2026-04-01', months: 12 }).expect(200);
    await ctx.http().delete(`/v1/transactions/${txn.id}`).set(auth(user)).expect(200);

    // A payment that did not happen bought no months.
    const spread = await ctx
      .http()
      .get('/v1/transactions/prepaid/spread?from=2026-04&months=12')
      .set(auth(user))
      .expect(200);
    expect(spread.body.items).toEqual([]);
    expect(spread.body.windowTotalMinor).toBe(0);
  });

  it('refuses anything that is not an expense, and a nonsense term', async () => {
    const user = await signup(ctx);
    /* Three accounts, and the free plan grants two. The subject here is what a
       period may be set on, not what a plan costs. */
    await unlimit(ctx, user.workspaceId);
    const account = await bank(user);
    const other = (
      await ctx
        .http()
        .post('/v1/accounts')
        .set(auth(user))
        .send({ name: 'নগদ', type: 'CASH' })
        .expect(201)
    ).body as { id: string };

    /* A transfer buys no months — moving your own money between two of your own
       accounts is not a period of anything. */
    const transfer = (
      await ctx
        .http()
        .post('/v1/transactions')
        .set(auth(user))
        .send({
          date: '2026-04-10',
          type: 'TRANSFER',
          amountMinor: 100_000,
          accountId: account.id,
          counterAccountId: other.id,
        })
        .expect(201)
    ).body as { id: string };

    await mark(user, transfer.id, { startDate: '2026-04-01', months: 12 }).expect(400);

    const txn = await spend(user);
    await mark(user, txn.id, { startDate: '2026-04-01', months: 1 }).expect(400);
    await mark(user, txn.id, { startDate: '2026-04-01', months: 500 }).expect(400);
    // A start with no count says nothing about how long. Both or neither.
    await mark(user, txn.id, { startDate: '2026-04-01', months: null }).expect(400);
  });

  it('never lets one workspace mark or read another one s rows', async () => {
    const alice = await signup(ctx);
    const bob = await signup(ctx);
    const txn = await spend(alice);
    await mark(alice, txn.id, { startDate: '2026-04-01', months: 12 }).expect(200);

    await mark(bob, txn.id, { startDate: '2026-04-01', months: 6 }).expect(404);

    // Not "an empty-looking spread" — an empty one.
    const spread = await ctx
      .http()
      .get('/v1/transactions/prepaid/spread?from=2026-04&months=12')
      .set(auth(bob))
      .expect(200);
    expect(spread.body.items).toEqual([]);
    expect(spread.body.windowTotalMinor).toBe(0);

    // And Alice's is untouched.
    const mine = await ctx.http().get(`/v1/transactions/${txn.id}`).set(auth(alice)).expect(200);
    expect(mine.body.prepaidMonths).toBe(12);
  });
});
