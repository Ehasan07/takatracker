import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auth,
  createTestApp,
  resetDatabase,
  signup,
  type SignedUpUser,
  type TestContext,
} from './harness';

const today = new Date().toISOString().slice(0, 10);

describe('ledger', () => {
  let ctx: TestContext;
  let user: SignedUpUser;
  let cashId: string;
  let bankId: string;
  let foodCategoryId: string;
  let salaryCategoryId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    user = await signup(ctx);

    const cash = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'নগদ', type: 'CASH' })
      .expect(201);
    cashId = cash.body.id;

    const bank = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'ব্যাংক', type: 'BANK', openingBalance: 1000000 })
      .expect(201);
    bankId = bank.body.id;

    const cats = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    foodCategoryId = cats.body.find((c: { nameBn: string }) => c.nameBn === 'খাবার ও বাজার').id;
    salaryCategoryId = cats.body.find((c: { nameBn: string }) => c.nameBn === 'বেতন').id;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('hides system accounts from the account list', async () => {
    const res = await ctx.http().get('/v1/accounts').set(auth(user)).expect(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((a: { name: string }) => a.name !== 'আয়')).toBe(true);
  });

  it('books an expense and moves the balance down', async () => {
    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: today,
        type: 'EXPENSE',
        amountMinor: 25000,
        accountId: cashId,
        categoryId: foodCategoryId,
        description: 'বাজার',
      })
      .expect(201);

    const accounts = await ctx.http().get('/v1/accounts').set(auth(user)).expect(200);
    const cash = accounts.body.find((a: { id: string }) => a.id === cashId);
    expect(cash.balanceMinor).toBe(-25000);
  });

  it('books income and keeps the double entry balanced in the database', async () => {
    const res = await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: today,
        type: 'INCOME',
        amountMinor: 5000000,
        accountId: bankId,
        categoryId: salaryCategoryId,
      })
      .expect(201);

    const entries = await ctx.prisma.ledgerEntry.findMany({
      where: { transactionId: res.body.id },
    });
    const debits = entries
      .filter((e) => e.direction === 'DEBIT')
      .reduce((s, e) => s + e.amountMinor, 0n);
    const credits = entries
      .filter((e) => e.direction === 'CREDIT')
      .reduce((s, e) => s + e.amountMinor, 0n);
    expect(debits).toBe(credits);
    expect(debits).toBe(5000000n);
  });

  it('includes the opening balance in the account balance', async () => {
    const accounts = await ctx.http().get('/v1/accounts').set(auth(user)).expect(200);
    const bank = accounts.body.find((a: { id: string }) => a.id === bankId);
    // 10,000.00 opening + 50,000.00 salary
    expect(bank.balanceMinor).toBe(1000000 + 5000000);
  });

  it('moves money between accounts on a transfer without changing the total', async () => {
    const before = await ctx.http().get('/v1/accounts').set(auth(user)).expect(200);
    const total = before.body.reduce(
      (s: number, a: { balanceMinor: number }) => s + a.balanceMinor,
      0,
    );

    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: today,
        type: 'TRANSFER',
        amountMinor: 100000,
        accountId: bankId,
        counterAccountId: cashId,
      })
      .expect(201);

    const after = await ctx.http().get('/v1/accounts').set(auth(user)).expect(200);
    const totalAfter = after.body.reduce(
      (s: number, a: { balanceMinor: number }) => s + a.balanceMinor,
      0,
    );
    expect(totalAfter).toBe(total);
  });

  it('rejects a transfer with no destination', async () => {
    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({ date: today, type: 'TRANSFER', amountMinor: 100, accountId: bankId })
      .expect(400);
  });

  it('rejects a fractional amount — money is integer poisha', async () => {
    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: today,
        type: 'EXPENSE',
        amountMinor: 100.5,
        accountId: cashId,
        categoryId: foodCategoryId,
      })
      .expect(400);
  });

  it('rejects an unbalanced transaction at the database level', async () => {
    // Bypass the service entirely: this is the DB trigger's job.
    const system = await ctx.prisma.account.findFirstOrThrow({
      where: { userId: user.id, systemKey: 'SYSTEM_EXPENSE' },
    });

    await expect(
      ctx.prisma.transaction.create({
        data: {
          userId: user.id,
          date: new Date(),
          type: 'EXPENSE',
          entries: {
            create: [
              { accountId: system.id, amountMinor: 5000n, direction: 'DEBIT' },
              { accountId: cashId, amountMinor: 4999n, direction: 'CREDIT' },
            ],
          },
        },
      }),
    ).rejects.toThrow(/Unbalanced transaction/);
  });

  it('rejects a single-sided transaction at the database level', async () => {
    await expect(
      ctx.prisma.transaction.create({
        data: {
          userId: user.id,
          date: new Date(),
          type: 'EXPENSE',
          entries: { create: [{ accountId: cashId, amountMinor: 5000n, direction: 'DEBIT' }] },
        },
      }),
    ).rejects.toThrow(/at least two/);
  });

  it('reconciles by booking the difference as an adjustment', async () => {
    const before = await ctx.http().get(`/v1/accounts/${cashId}`).set(auth(user)).expect(200);

    const target = before.body.balanceMinor + 12345;
    const res = await ctx
      .http()
      .post(`/v1/accounts/${cashId}/reconcile`)
      .set(auth(user))
      .send({ date: today, actualBalanceMinor: target })
      .expect(201);

    expect(res.body.delta).toBe(12345);

    const after = await ctx.http().get(`/v1/accounts/${cashId}`).set(auth(user)).expect(200);
    expect(after.body.balanceMinor).toBe(target);
  });

  it('soft-deletes a transaction and reverses its effect on the balance', async () => {
    const before = await ctx.http().get(`/v1/accounts/${cashId}`).set(auth(user)).expect(200);

    const created = await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: today,
        type: 'EXPENSE',
        amountMinor: 7700,
        accountId: cashId,
        categoryId: foodCategoryId,
      })
      .expect(201);

    await ctx.http().delete(`/v1/transactions/${created.body.id}`).set(auth(user)).expect(200);

    const after = await ctx.http().get(`/v1/accounts/${cashId}`).set(auth(user)).expect(200);
    expect(after.body.balanceMinor).toBe(before.body.balanceMinor);
  });

  it('restores a deleted transaction and its effect on the balance', async () => {
    const before = await ctx.http().get(`/v1/accounts/${cashId}`).set(auth(user)).expect(200);

    const created = await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: today,
        type: 'EXPENSE',
        amountMinor: 4200,
        accountId: cashId,
        categoryId: foodCategoryId,
      })
      .expect(201);

    await ctx.http().delete(`/v1/transactions/${created.body.id}`).set(auth(user)).expect(200);
    const deleted = await ctx.http().get(`/v1/accounts/${cashId}`).set(auth(user)).expect(200);
    expect(deleted.body.balanceMinor).toBe(before.body.balanceMinor);

    // Undo — the swipe gesture on a phone is easy to trigger by accident.
    await ctx
      .http()
      .post(`/v1/transactions/${created.body.id}/restore`)
      .set(auth(user))
      .expect(201);

    const restored = await ctx.http().get(`/v1/accounts/${cashId}`).set(auth(user)).expect(200);
    expect(restored.body.balanceMinor).toBe(before.body.balanceMinor - 4200);

    // Restoring twice is a 404, not a duplicate.
    await ctx
      .http()
      .post(`/v1/transactions/${created.body.id}/restore`)
      .set(auth(user))
      .expect(404);

    // Leave the ledger as the later tests expect it.
    await ctx.http().delete(`/v1/transactions/${created.body.id}`).set(auth(user)).expect(200);
  });

  it('reports a running balance when the list is filtered to one account', async () => {
    const res = await ctx
      .http()
      .get('/v1/transactions')
      .query({ accountId: cashId, limit: 50 })
      .set(auth(user))
      .expect(200);

    expect(res.body.items.length).toBeGreaterThan(0);
    const account = await ctx.http().get(`/v1/accounts/${cashId}`).set(auth(user)).expect(200);
    expect(res.body.items[0].balanceAfterMinor).toBe(account.body.balanceMinor);
  });

  it('summarises the month with income, expense and net', async () => {
    const res = await ctx.http().get('/v1/transactions/summary').set(auth(user)).expect(200);
    expect(res.body.incomeMinor).toBeGreaterThan(0);
    expect(res.body.expenseMinor).toBeGreaterThan(0);
    expect(res.body.netMinor).toBe(res.body.incomeMinor - res.body.expenseMinor);
    expect(Array.isArray(res.body.expenseByCategory)).toBe(true);
  });
});

describe('tenant isolation', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('user A cannot read, edit or delete user B rows by ID', async () => {
    const alice = await signup(ctx);
    const bob = await signup(ctx);

    const account = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(alice))
      .send({ name: 'অ্যালিসের নগদ', type: 'CASH' })
      .expect(201);

    const cats = await ctx.http().get('/v1/categories').set(auth(alice)).expect(200);
    const categoryId = cats.body[0].id;

    const txn = await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(alice))
      .send({
        date: today,
        type: 'EXPENSE',
        amountMinor: 1000,
        accountId: account.body.id,
        categoryId,
      })
      .expect(201);

    await ctx.http().get(`/v1/accounts/${account.body.id}`).set(auth(bob)).expect(404);
    await ctx.http().get(`/v1/transactions/${txn.body.id}`).set(auth(bob)).expect(404);
    await ctx.http().delete(`/v1/transactions/${txn.body.id}`).set(auth(bob)).expect(404);
    await ctx
      .http()
      .patch(`/v1/accounts/${account.body.id}`)
      .set(auth(bob))
      .send({ name: 'hijacked' })
      .expect(404);

    // Bob cannot post a transaction into Alice's account either.
    const bobAccount = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(bob))
      .send({ name: 'ববের নগদ', type: 'CASH' })
      .expect(201);

    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(bob))
      .send({
        date: today,
        type: 'TRANSFER',
        amountMinor: 500,
        accountId: bobAccount.body.id,
        counterAccountId: account.body.id,
      })
      .expect(404);

    const bobList = await ctx.http().get('/v1/transactions').set(auth(bob)).expect(200);
    expect(bobList.body.items).toHaveLength(0);
  });
});

describe('account deletion', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  /* Spec §9: "Full data export and full account deletion must work" — both
   * stores require it. Deleting the User row must take the whole ledger with
   * it, which only happens if every foreign key cascades. */
  it('deleting a user removes their accounts, categories, transactions and entries', async () => {
    const user = await signup(ctx);

    const account = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'নগদ', type: 'CASH' })
      .expect(201);

    const cats = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);

    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: today,
        type: 'EXPENSE',
        amountMinor: 1234,
        accountId: account.body.id,
        categoryId: cats.body.find((c: { kind: string }) => c.kind === 'EXPENSE').id,
      })
      .expect(201);

    await expect(ctx.prisma.user.delete({ where: { id: user.id } })).resolves.toBeTruthy();

    for (const count of [
      ctx.prisma.account.count({ where: { userId: user.id } }),
      ctx.prisma.category.count({ where: { userId: user.id } }),
      ctx.prisma.transaction.count({ where: { userId: user.id } }),
      ctx.prisma.refreshToken.count({ where: { userId: user.id } }),
    ]) {
      expect(await count).toBe(0);
    }
    expect(await ctx.prisma.ledgerEntry.count()).toBe(0);
  });
});
