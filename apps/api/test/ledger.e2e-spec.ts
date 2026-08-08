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
      where: { workspaceId: user.workspaceId, systemKey: 'SYSTEM_EXPENSE' },
    });

    await expect(
      ctx.prisma.transaction.create({
        data: {
          workspaceId: user.workspaceId,
          date: new Date(),
          type: 'EXPENSE',
          entries: {
            create: [
              {
                workspaceId: user.workspaceId,
                accountId: system.id,
                amountMinor: 5000n,
                direction: 'DEBIT',
              },
              {
                workspaceId: user.workspaceId,
                accountId: cashId,
                amountMinor: 4999n,
                direction: 'CREDIT',
              },
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
          workspaceId: user.workspaceId,
          date: new Date(),
          type: 'EXPENSE',
          entries: {
            create: [
              {
                workspaceId: user.workspaceId,
                accountId: cashId,
                amountMinor: 5000n,
                direction: 'DEBIT',
              },
            ],
          },
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

describe('workspace isolation', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  /**
   * Spec §9 / v3 §A1. The guard is `workspaceId`, and it has to hold on every
   * surface that returns data — not just a fetch by ID. Each new surface
   * (export, AI query, sync pull, webhook ingest) gets a case here as it lands.
   */
  it('a member of one workspace cannot reach another by ID, list, search or write', async () => {
    const alice = await signup(ctx);
    const bob = await signup(ctx);

    expect(alice.workspaceId).not.toBe(bob.workspaceId);

    const account = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(alice))
      .send({ name: 'অ্যালিসের নগদ', type: 'CASH' })
      .expect(201);

    const aliceCats = await ctx.http().get('/v1/categories').set(auth(alice)).expect(200);
    const categoryId = aliceCats.body.find((c: { kind: string }) => c.kind === 'EXPENSE').id;

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
        description: 'গোপন লেনদেন',
      })
      .expect(201);

    // --- read by ID
    await ctx.http().get(`/v1/accounts/${account.body.id}`).set(auth(bob)).expect(404);
    await ctx.http().get(`/v1/transactions/${txn.body.id}`).set(auth(bob)).expect(404);

    // --- write and delete by ID
    await ctx.http().delete(`/v1/transactions/${txn.body.id}`).set(auth(bob)).expect(404);
    await ctx.http().post(`/v1/transactions/${txn.body.id}/restore`).set(auth(bob)).expect(404);
    await ctx
      .http()
      .patch(`/v1/accounts/${account.body.id}`)
      .set(auth(bob))
      .send({ name: 'hijacked' })
      .expect(404);
    await ctx.http().delete(`/v1/accounts/${account.body.id}`).set(auth(bob)).expect(404);

    // --- reconcile
    await ctx
      .http()
      .post(`/v1/accounts/${account.body.id}/reconcile`)
      .set(auth(bob))
      .send({ date: today, actualBalanceMinor: 999999 })
      .expect(404);

    // --- lists
    const bobAccounts = await ctx.http().get('/v1/accounts').set(auth(bob)).expect(200);
    expect(bobAccounts.body).toHaveLength(0);

    const bobList = await ctx.http().get('/v1/transactions').set(auth(bob)).expect(200);
    expect(bobList.body.items).toHaveLength(0);

    // --- search: the filter must not become a way around the guard
    const bobSearch = await ctx
      .http()
      .get('/v1/transactions')
      .query({ q: 'গোপন' })
      .set(auth(bob))
      .expect(200);
    expect(bobSearch.body.items).toHaveLength(0);

    // --- filtering by another workspace's account id returns nothing
    const bobFiltered = await ctx
      .http()
      .get('/v1/transactions')
      .query({ accountId: account.body.id })
      .set(auth(bob))
      .expect(200);
    expect(bobFiltered.body.items).toHaveLength(0);

    // --- aggregates must not leak totals
    const bobSummary = await ctx.http().get('/v1/transactions/summary').set(auth(bob)).expect(200);
    expect(bobSummary.body.expenseMinor).toBe(0);
    expect(bobSummary.body.incomeMinor).toBe(0);
    expect(bobSummary.body.expenseByCategory).toHaveLength(0);

    // --- categories are per workspace, and Alice's ID is not usable by Bob
    const bobCats = await ctx.http().get('/v1/categories').set(auth(bob)).expect(200);
    expect(bobCats.body.some((c: { id: string }) => c.id === categoryId)).toBe(false);

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
        type: 'EXPENSE',
        amountMinor: 500,
        accountId: bobAccount.body.id,
        categoryId,
      })
      .expect(404);

    // --- a transfer is the sneakiest path into another tenant's account
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

    // Alice still has exactly what she started with.
    const aliceList = await ctx.http().get('/v1/transactions').set(auth(alice)).expect(200);
    expect(aliceList.body.items).toHaveLength(1);
  });

  /* The denormalised LedgerEntry.workspaceId is only safe because the database
   * refuses to let it disagree with its transaction. */
  it('the database rejects a ledger entry whose workspace differs from its transaction', async () => {
    const alice = await signup(ctx);
    const bob = await signup(ctx);

    const account = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(alice))
      .send({ name: 'নগদ', type: 'CASH' })
      .expect(201);

    const system = await ctx.prisma.account.findFirstOrThrow({
      where: { workspaceId: alice.workspaceId, systemKey: 'SYSTEM_EXPENSE' },
    });

    await expect(
      ctx.prisma.transaction.create({
        data: {
          workspaceId: alice.workspaceId,
          date: new Date(),
          type: 'EXPENSE',
          entries: {
            create: [
              {
                workspaceId: alice.workspaceId,
                accountId: system.id,
                amountMinor: 100n,
                direction: 'DEBIT',
              },
              {
                // Wrong tenant on one line only.
                workspaceId: bob.workspaceId,
                accountId: account.body.id,
                amountMinor: 100n,
                direction: 'CREDIT',
              },
            ],
          },
        },
      }),
    ).rejects.toThrow(/does not match its transaction workspace/);
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
  it('deleting a workspace removes its accounts, categories, transactions and entries', async () => {
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

    /* Audit writes are fire-and-forget, so one can still be in flight here. An
     * insert landing mid-delete makes Postgres refuse the delete — rare in
     * practice, but M34's deletion pipeline must clear the audit rows inside
     * the same transaction rather than racing them. */
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Deleting the person takes the workspace they own, and everything in it.
    await expect(ctx.prisma.user.delete({ where: { id: user.id } })).resolves.toBeTruthy();

    for (const count of [
      ctx.prisma.workspace.count({ where: { id: user.workspaceId } }),
      ctx.prisma.membership.count({ where: { userId: user.id } }),
      ctx.prisma.account.count({ where: { workspaceId: user.workspaceId } }),
      ctx.prisma.category.count({ where: { workspaceId: user.workspaceId } }),
      ctx.prisma.transaction.count({ where: { workspaceId: user.workspaceId } }),
      ctx.prisma.refreshToken.count({ where: { userId: user.id } }),
    ]) {
      expect(await count).toBe(0);
    }
    expect(await ctx.prisma.ledgerEntry.count()).toBe(0);
  });
});
