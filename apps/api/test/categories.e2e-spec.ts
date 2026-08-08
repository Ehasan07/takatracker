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

describe('sub-categories', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  const add = (user: Awaited<ReturnType<typeof signup>>, body: unknown) =>
    ctx.http().post('/v1/categories').set(auth(user)).send(body);

  it('nests one level and reports the parent name', async () => {
    const user = await signup(ctx);
    const cats = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    const transport = cats.body.find((c: { nameBn: string }) => c.nameBn === 'যাতায়াত');

    const child = await add(user, {
      name: 'রিকশা',
      nameBn: 'রিকশা',
      kind: 'EXPENSE',
      parentId: transport.id,
    }).expect(201);
    expect(child.body.parentId).toBe(transport.id);

    const listed = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    const found = listed.body.find((c: { id: string }) => c.id === child.body.id);
    expect(found.parentName).toBe('যাতায়াত');
  });

  it('refuses a third level', async () => {
    const user = await signup(ctx);
    const cats = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    const parent = cats.body.find((c: { nameBn: string }) => c.nameBn === 'যাতায়াত');

    const child = await add(user, {
      name: 'রিকশা',
      nameBn: 'রিকশা',
      kind: 'EXPENSE',
      parentId: parent.id,
    }).expect(201);

    // Deeper nesting makes a report unreadable and a picker unusable on a phone.
    const refused = await add(user, {
      name: 'সিএনজি',
      nameBn: 'সিএনজি',
      kind: 'EXPENSE',
      parentId: child.body.id,
    }).expect(400);
    expect(refused.body.message).toContain('উপ-খাত');
  });

  it('refuses a parent of the other kind', async () => {
    const user = await signup(ctx);
    const cats = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    const income = cats.body.find((c: { nameBn: string }) => c.nameBn === 'বেতন');

    await add(user, {
      name: 'বোনাস',
      nameBn: 'বোনাস',
      kind: 'EXPENSE',
      parentId: income.id,
    }).expect(400);
  });

  it('allows the same name under different parents but not as siblings', async () => {
    const user = await signup(ctx);
    const cats = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    const transport = cats.body.find((c: { nameBn: string }) => c.nameBn === 'যাতায়াত');
    const business = cats.body.find((c: { nameBn: string }) => c.nameBn === 'মেরামত');

    await add(user, {
      name: 'ভাড়া',
      nameBn: 'ভাড়া',
      kind: 'EXPENSE',
      parentId: transport.id,
    }).expect(201);
    // Different parent, same word — a real distinction, so allowed.
    await add(user, {
      name: 'ভাড়া',
      nameBn: 'ভাড়া',
      kind: 'EXPENSE',
      parentId: business.id,
    }).expect(201);
    // Same parent twice — ambiguous in a picker, so refused.
    await add(user, {
      name: 'ভাড়া',
      nameBn: 'ভাড়া',
      kind: 'EXPENSE',
      parentId: transport.id,
    }).expect(400);
  });

  it('refuses to delete a parent that still has children', async () => {
    const user = await signup(ctx);
    const cats = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    const parent = cats.body.find((c: { nameBn: string }) => c.nameBn === 'যাতায়াত');
    await add(user, {
      name: 'রিকশা',
      nameBn: 'রিকশা',
      kind: 'EXPENSE',
      parentId: parent.id,
    }).expect(201);

    const refused = await ctx
      .http()
      .delete(`/v1/categories/${parent.id}`)
      .set(auth(user))
      .expect(400);
    expect(refused.body.message).toContain('উপ-ক্যাটাগরি');
  });

  it('rolls child spending into the parent and still drills down correctly', async () => {
    const user = await signup(ctx);
    const account = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'নগদ', type: 'CASH' })
      .expect(201);

    const cats = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    const transport = cats.body.find((c: { nameBn: string }) => c.nameBn === 'যাতায়াত');
    const rickshaw = (
      await add(user, {
        name: 'রিকশা',
        nameBn: 'রিকশা',
        kind: 'EXPENSE',
        parentId: transport.id,
      }).expect(201)
    ).body;
    const bus = (
      await add(user, {
        name: 'বাস',
        nameBn: 'বাস',
        kind: 'EXPENSE',
        parentId: transport.id,
      }).expect(201)
    ).body;

    const spend = (categoryId: string, amountMinor: number) =>
      ctx
        .http()
        .post('/v1/transactions')
        .set(auth(user))
        .send({ date: today, type: 'EXPENSE', amountMinor, accountId: account.body.id, categoryId })
        .expect(201);

    await spend(transport.id, 50_000); // ৳500 directly on যাতায়াত
    await spend(rickshaw.id, 30_000); // ৳300
    await spend(bus.id, 20_000); // ৳200

    const report = await ctx
      .http()
      .get('/v1/reports/by-category?kind=EXPENSE')
      .set(auth(user))
      .expect(200);

    const node = report.body.nodes.find(
      (n: { categoryId: string }) => n.categoryId === transport.id,
    );
    expect(node.totalMinor).toBe(50_000); // its own
    expect(node.rolledUpMinor).toBe(100_000); // with both children
    expect(node.children).toHaveLength(2);

    // The flat view still lists every line separately.
    const flat = await ctx
      .http()
      .get('/v1/reports/by-category?kind=EXPENSE&flat=1')
      .set(auth(user))
      .expect(200);
    expect(flat.body.rows).toHaveLength(3);

    // Tapping the parent must show what its children hold, or the drill-down
    // total would not match the slice that was tapped.
    const drill = await ctx
      .http()
      .get(`/v1/reports/category/${transport.id}`)
      .set(auth(user))
      .expect(200);
    expect(drill.body.totalMinor).toBe(100_000);
    expect(drill.body.items).toHaveLength(3);
  });
});
