import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, createTestApp, resetDatabase, signup, type TestContext, unlimit } from './harness';

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
    // One account per type; the free plan sells two in total.
    await unlimit(ctx, user.workspaceId);
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

  const add = (user: Awaited<ReturnType<typeof signup>>, body: Record<string, unknown>) =>
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

/**
 * `GET /categories?q=` — the endpoint the entry sheet's খাত search reads.
 *
 * The ranking itself is @hishab/core's and tested there. What is asserted here
 * is the contract the picker depends on and would break silently without: that
 * a matched child arrives with its parent's name attached, that a parent pulled
 * in only for context is flagged so the flat list can drop it, that Banglish
 * finds a Bengali row, and that the family somebody searched for is first.
 */
describe('category search', () => {
  let ctx: TestContext;
  let user: Awaited<ReturnType<typeof signup>>;
  let transportId: string;
  let rickshawId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    user = await signup(ctx);

    const cats = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    transportId = cats.body.find((c: { nameBn: string }) => c.nameBn === 'যাতায়াত').id;

    const child = await ctx
      .http()
      .post('/v1/categories')
      .set(auth(user))
      .send({ name: 'Rickshaw', nameBn: 'রিকশা', kind: 'EXPENSE', parentId: transportId })
      .expect(201);
    rickshawId = child.body.id;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  const search = (q: string, kind = 'EXPENSE') =>
    ctx
      .http()
      .get(`/v1/categories?kind=${kind}&q=${encodeURIComponent(q)}`)
      .set(auth(user));

  it('finds a sub-category and names the খাত it sits under', async () => {
    const res = await search('রিকশা').expect(200);
    const hit = res.body.find((c: { id: string }) => c.id === rickshawId);
    expect(hit).toBeDefined();
    expect(hit.matched).toBe(true);
    /* The picker prints `যাতায়াত › রিকশা` from this field. Without it a flat
       result list shows a bare "রিকশা" — the exact ambiguity the two-select
       picker exists to remove. */
    expect(hit.parentName).toBe('যাতায়াত');
  });

  it('flags a parent it pulled in only for context', async () => {
    /* A খাত of the workspace's own, so no seeded alias can match it. The
       default যাতায়াত is not usable for this: it ships `Rickshaw` in its
       aliases, so a search for রিকশা matches the parent for real. */
    const gym = await ctx
      .http()
      .post('/v1/categories')
      .set(auth(user))
      .send({ name: 'Gymkhana', nameBn: 'জিমখানা', kind: 'EXPENSE' })
      .expect(201);
    const court = await ctx
      .http()
      .post('/v1/categories')
      .set(auth(user))
      .send({
        name: 'Badminton court',
        nameBn: 'ব্যাডমিন্টন কোর্ট',
        kind: 'EXPENSE',
        parentId: gym.body.id,
      })
      .expect(201);

    const res = await search('ব্যাডমিন্টন').expect(200);
    const child = res.body.find((c: { id: string }) => c.id === court.body.id);
    expect(child.matched).toBe(true);

    const parent = res.body.find((c: { id: string }) => c.id === gym.body.id);
    expect(parent).toBeDefined();
    /* Present so a tree renderer has something to hang the child under, and
       `false` so the picker's flat list — which prints the parent as a prefix
       on the child's own row — knows to drop the redundant line. */
    expect(parent.matched).toBe(false);
  });

  it('finds a Bengali row from Banglish', async () => {
    /* The whole reason this goes through the API. `rickshaw` and রিকশা share no
       characters, so a client-side filter over the fetched array cannot do it. */
    const res = await search('rickshaw').expect(200);
    expect(res.body.some((c: { id: string }) => c.id === rickshawId)).toBe(true);
  });

  it('puts the family that was searched for first', async () => {
    /* Families are ordered by their best-ranked member and the parent is
       printed above its children, so "first" means the family — not necessarily
       the single highest-scoring row. Here both really match: রিকশা by name,
       যাতায়াত through the `Rickshaw` alias it ships with. */
    const res = await search('রিকশা').expect(200);
    const top = res.body.slice(0, 2).map((c: { id: string }) => c.id);
    expect(top).toContain(rickshawId);
    expect(res.body[0].id).toBe(transportId);
  });

  it('does not drag a parent’s children in when the parent is what matched', async () => {
    const res = await search('যাতায়াত').expect(200);
    expect(res.body.some((c: { id: string }) => c.id === transportId)).toBe(true);
    expect(res.body.some((c: { id: string }) => c.id === rickshawId)).toBe(false);
  });

  it('never returns the other side of the ledger', async () => {
    /* An income sheet offering খরচের খাত saves a transaction nobody can read
       back. `kind` scopes the rows before anything is matched. */
    const res = await search('রিকশা', 'INCOME').expect(200);
    expect(res.body.every((c: { kind: string }) => c.kind === 'INCOME')).toBe(true);
  });

  it('is private to one workspace', async () => {
    const stranger = await signup(ctx);
    const res = await ctx
      .http()
      .get('/v1/categories?kind=EXPENSE&q=rickshaw')
      .set(auth(stranger))
      .expect(200);
    expect(res.body.some((c: { id: string }) => c.id === rickshawId)).toBe(false);
  });
});
