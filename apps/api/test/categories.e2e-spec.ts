import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, createTestApp, resetDatabase, signup, type TestContext } from './harness';

const today = new Date().toISOString().slice(0, 10);

describe('categories', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('seeds the Bangladeshi default tree and reports usage', async () => {
    const user = await signup(ctx);
    const res = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);

    expect(res.body.length).toBeGreaterThanOrEqual(20);
    expect(res.body.some((c: { nameBn: string }) => c.nameBn === 'খাবার ও বাজার')).toBe(true);
    expect(res.body.every((c: { usageCount: number }) => c.usageCount === 0)).toBe(true);
  });

  it('adds, renames and removes one of the user s own', async () => {
    const user = await signup(ctx);

    const created = await ctx
      .http()
      .post('/v1/categories')
      .set(auth(user))
      .send({ name: 'গাড়ির তেল', nameBn: 'গাড়ির তেল', kind: 'EXPENSE' })
      .expect(201);

    const renamed = await ctx
      .http()
      .patch(`/v1/categories/${created.body.id}`)
      .set(auth(user))
      .send({ name: 'জ্বালানি', nameBn: 'জ্বালানি' })
      .expect(200);
    expect(renamed.body.nameBn).toBe('জ্বালানি');

    await ctx.http().delete(`/v1/categories/${created.body.id}`).set(auth(user)).expect(200);

    const after = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    expect(after.body.some((c: { id: string }) => c.id === created.body.id)).toBe(false);
  });

  it('refuses a duplicate name within the same kind', async () => {
    const user = await signup(ctx);
    await ctx
      .http()
      .post('/v1/categories')
      .set(auth(user))
      .send({ name: 'যাতায়াত', nameBn: 'যাতায়াত', kind: 'EXPENSE' })
      .expect(400);

    // The same word is fine on the other side of the ledger.
    await ctx
      .http()
      .post('/v1/categories')
      .set(auth(user))
      .send({ name: 'যাতায়াত', nameBn: 'যাতায়াত', kind: 'INCOME' })
      .expect(201);
  });

  /** A category with history cannot vanish, or the ledger stops making sense. */
  it('refuses to delete a category that has transactions, and says how many', async () => {
    const user = await signup(ctx);
    const account = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'নগদ', type: 'CASH' })
      .expect(201);

    const cats = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    const category = cats.body.find((c: { nameBn: string }) => c.nameBn === 'খাবার ও বাজার');

    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: today,
        type: 'EXPENSE',
        amountMinor: 1000,
        accountId: account.body.id,
        categoryId: category.id,
      })
      .expect(201);

    const refused = await ctx
      .http()
      .delete(`/v1/categories/${category.id}`)
      .set(auth(user))
      .expect(400);
    expect(refused.body.message).toContain('লেনদেন');

    const listed = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    const withUse = listed.body.find((c: { id: string }) => c.id === category.id);
    expect(withUse.usageCount).toBe(1);
  });

  it('keeps categories inside their workspace', async () => {
    const alice = await signup(ctx);
    const bob = await signup(ctx);

    const created = await ctx
      .http()
      .post('/v1/categories')
      .set(auth(alice))
      .send({ name: 'অ্যালিসের খাত', nameBn: 'অ্যালিসের খাত', kind: 'EXPENSE' })
      .expect(201);

    await ctx
      .http()
      .patch(`/v1/categories/${created.body.id}`)
      .set(auth(bob))
      .send({ name: 'x' })
      .expect(404);
    await ctx.http().delete(`/v1/categories/${created.body.id}`).set(auth(bob)).expect(404);

    const bobs = await ctx.http().get('/v1/categories').set(auth(bob)).expect(200);
    expect(bobs.body.some((c: { id: string }) => c.id === created.body.id)).toBe(false);
  });

  it('accepts asset and liability accounts', async () => {
    const user = await signup(ctx);
    for (const type of ['ASSET', 'LIABILITY', 'RECEIVABLE', 'PAYABLE']) {
      await ctx
        .http()
        .post('/v1/accounts')
        .set(auth(user))
        .send({ name: `acct-${type}`, type })
        .expect(201);
    }

    const accounts = await ctx.http().get('/v1/accounts').set(auth(user)).expect(200);
    expect(accounts.body.map((a: { type: string }) => a.type)).toEqual(
      expect.arrayContaining(['ASSET', 'LIABILITY', 'RECEIVABLE', 'PAYABLE']),
    );
  });
});
