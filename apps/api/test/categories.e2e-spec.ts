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

  it('accepts asset and liability accounts, but not receivable or payable', async () => {
    const user = await signup(ctx);
    // One account per type; the free plan sells two in total.
    await unlimit(ctx, user.workspaceId);
    for (const type of ['ASSET', 'LIABILITY']) {
      await ctx
        .http()
        .post('/v1/accounts')
        .set(auth(user))
        .send({ name: `acct-${type}`, type })
        .expect(201);
    }

    /* RECEIVABLE and PAYABLE are what the loan control accounts are made of,
       and ঋণ makes those itself — against a person, in a direction, with
       instalments. A hand-made one beside a loan of the same name is one debt
       written twice. */
    for (const type of ['RECEIVABLE', 'PAYABLE']) {
      await ctx
        .http()
        .post('/v1/accounts')
        .set(auth(user))
        .send({ name: `acct-${type}`, type })
        .expect(400);
    }

    const accounts = await ctx.http().get('/v1/accounts').set(auth(user)).expect(200);
    const types = accounts.body.map((a: { type: string }) => a.type);
    expect(types).toEqual(expect.arrayContaining(['ASSET', 'LIABILITY']));
    expect(types).not.toContain('RECEIVABLE');
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
 * `POST /categories/:id/move` — re-filing a whole খাত at once.
 *
 * The endpoint `DELETE` has been pointing at for as long as it has existed: its
 * refusal says "আগে সেগুলো অন্য ক্যাটাগরিতে সরান" and until now there was no way
 * to do that but one transaction at a time.
 *
 * Two of the assertions below are the ones that matter, and neither is about
 * categories. **No account balance may change** — the operation touches one
 * foreign key and a bulk tool that quietly adjusted a balance would be found
 * months later, by which time the books are wrong and nobody knows when they
 * started being wrong. And **the income statement must gain on the target
 * exactly what it lost on the source** — the money did not appear, disappear or
 * change sides, it is filed under a different heading.
 */
describe('moving a category’s transactions', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  interface Cat {
    id: string;
    kind: string;
    nameBn: string | null;
    usageCount: number;
  }

  const list = async (user: Awaited<ReturnType<typeof signup>>): Promise<Cat[]> =>
    (await ctx.http().get('/v1/categories').set(auth(user)).expect(200)).body as Cat[];

  const byName = async (user: Awaited<ReturnType<typeof signup>>, nameBn: string): Promise<Cat> => {
    const found = (await list(user)).find((c) => c.nameBn === nameBn);
    if (!found) throw new Error(`no seeded category named ${nameBn}`);
    return found;
  };

  const account = async (user: Awaited<ReturnType<typeof signup>>, name = 'নগদ') =>
    (await ctx.http().post('/v1/accounts').set(auth(user)).send({ name, type: 'CASH' }).expect(201))
      .body as { id: string };

  const spend = (
    user: Awaited<ReturnType<typeof signup>>,
    accountId: string,
    categoryId: string,
    amountMinor: number,
    type: 'EXPENSE' | 'INCOME' = 'EXPENSE',
  ) =>
    ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({ date: today, type, amountMinor, accountId, categoryId })
      .expect(201);

  const move = (
    user: Awaited<ReturnType<typeof signup>>,
    id: string,
    body: Record<string, unknown>,
  ) => ctx.http().post(`/v1/categories/${id}/move`).set(auth(user)).send(body);

  /** Every account's balance, keyed by id — the figure that must not move. */
  const balances = async (
    user: Awaited<ReturnType<typeof signup>>,
  ): Promise<Record<string, number>> => {
    const res = await ctx.http().get('/v1/accounts').set(auth(user)).expect(200);
    const out: Record<string, number> = {};
    for (const a of res.body as { id: string; balanceMinor: number }[]) {
      out[a.id] = a.balanceMinor;
    }
    return out;
  };

  it('moves every transaction and reports the count it moved', async () => {
    const user = await signup(ctx);
    const cash = await account(user);
    const from = await byName(user, 'যাতায়াত');
    const to = await byName(user, 'খাবার ও বাজার');

    await spend(user, cash.id, from.id, 30_000);
    await spend(user, cash.id, from.id, 20_000);
    await spend(user, cash.id, to.id, 10_000);

    const res = await move(user, from.id, { toCategoryId: to.id }).expect(201);
    expect(res.body.movedCount).toBe(2);
    expect(res.body.deleted).toBe(false);

    const after = await list(user);
    expect(after.find((c) => c.id === from.id)?.usageCount).toBe(0);
    /* Its own one plus the two that arrived. The count the list reports and the
       count the endpoint returns are the same number by construction — the
       sheet quotes the first before the press and the second after it. */
    expect(after.find((c) => c.id === to.id)?.usageCount).toBe(3);

    /* Not deleted, because nobody asked for it to be. An emptied খাত is still a
       খাত somebody may want to keep using. */
    expect(after.some((c) => c.id === from.id)).toBe(true);
  });

  it('leaves every account balance exactly where it was', async () => {
    const user = await signup(ctx);
    const cash = await account(user);
    const from = await byName(user, 'যাতায়াত');
    const to = await byName(user, 'খাবার ও বাজার');

    await spend(user, cash.id, from.id, 45_000);
    await spend(user, cash.id, from.id, 5_500);
    await spend(user, cash.id, to.id, 12_000, 'INCOME');

    const before = await balances(user);
    const res = await move(user, from.id, { toCategoryId: to.id }).expect(201);
    expect(res.body.movedCount).toBe(2);

    /* The whole promise of this endpoint, asserted rather than asserted-in-a-
       comment: one foreign key changed and the money is where it was. Not just
       the wallet — every account in the workspace, the nominal ones included,
       so a change of sign would show up here too. */
    expect(await balances(user)).toEqual(before);
  });

  it('grows the target on the income statement by exactly what the source held', async () => {
    const user = await signup(ctx);
    const cash = await account(user);
    const from = await byName(user, 'যাতায়াত');
    const to = await byName(user, 'খাবার ও বাজার');

    await spend(user, cash.id, from.id, 30_000);
    await spend(user, cash.id, from.id, 20_000);
    await spend(user, cash.id, to.id, 70_000);

    const statement = async () =>
      (await ctx.http().get('/v1/reports/income-statement').set(auth(user)).expect(200)).body as {
        expenseMinor: number;
        expenses: { categoryId: string; totalMinor: number; rolledUpMinor: number }[];
      };

    const before = await statement();
    const sourceBefore = before.expenses.find((n) => n.categoryId === from.id)?.rolledUpMinor ?? 0;
    const targetBefore = before.expenses.find((n) => n.categoryId === to.id)?.rolledUpMinor ?? 0;
    expect(sourceBefore).toBe(50_000);
    expect(targetBefore).toBe(70_000);

    await move(user, from.id, { toCategoryId: to.id }).expect(201);

    const after = await statement();
    const targetAfter = after.expenses.find((n) => n.categoryId === to.id)?.rolledUpMinor ?? 0;
    expect(targetAfter).toBe(targetBefore + sourceBefore);
    /* The source is gone from the report because it holds nothing, not because
       anything was deleted — and the period's total is untouched, which is the
       arithmetic proof that the money was re-labelled rather than moved. */
    expect(after.expenses.some((n) => n.categoryId === from.id)).toBe(false);
    expect(after.expenseMinor).toBe(before.expenseMinor);
  });

  it('empties and retires the source when asked to', async () => {
    const user = await signup(ctx);
    const cash = await account(user);
    const from = await byName(user, 'যাতায়াত');
    const to = await byName(user, 'খাবার ও বাজার');

    await spend(user, cash.id, from.id, 30_000);

    const res = await move(user, from.id, { toCategoryId: to.id, deleteAfter: true }).expect(201);
    expect(res.body).toMatchObject({ movedCount: 1, deleted: true });

    const after = await list(user);
    expect(after.some((c) => c.id === from.id)).toBe(false);
    expect(after.find((c) => c.id === to.id)?.usageCount).toBe(1);

    /* Soft-deleted, so the transactions are still readable — they simply answer
       with the খাত they were moved to. */
    const txns = await ctx.http().get('/v1/transactions').set(auth(user)).expect(200);
    const rows = txns.body.items as { categoryId: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.categoryId).toBe(to.id);
  });

  it('refuses to move an income khat’s transactions into an expense one', async () => {
    const user = await signup(ctx);
    const cash = await account(user);
    const salary = await byName(user, 'বেতন');
    const food = await byName(user, 'খাবার ও বাজার');

    await spend(user, cash.id, salary.id, 500_000, 'INCOME');

    /* The refusal that is about money rather than tidiness: the entry's sign
       lives on the entry, so re-filing income under an expense heading leaves
       the ledger balanced and the income statement rewritten. */
    const refused = await move(user, salary.id, { toCategoryId: food.id }).expect(400);
    expect(refused.body.message).toContain('ধরন');

    const after = await list(user);
    expect(after.find((c) => c.id === salary.id)?.usageCount).toBe(1);
    expect(after.find((c) => c.id === food.id)?.usageCount).toBe(0);
  });

  it('404s on a target belonging to somebody else, and moves nothing', async () => {
    const alice = await signup(ctx);
    const bob = await signup(ctx);
    const cash = await account(alice);
    const from = await byName(alice, 'যাতায়াত');
    const bobs = await byName(bob, 'খাবার ও বাজার');

    await spend(alice, cash.id, from.id, 30_000);

    /* A 404 and not a 403: the shape of the refusal must not tell Alice that
       Bob's category id is a real row somewhere. */
    await move(alice, from.id, { toCategoryId: bobs.id }).expect(404);
    /* And the other direction — Bob cannot reach into Alice's books either. */
    await move(bob, from.id, { toCategoryId: bobs.id }).expect(404);

    expect((await list(alice)).find((c) => c.id === from.id)?.usageCount).toBe(1);
    expect((await list(bob)).find((c) => c.id === bobs.id)?.usageCount).toBe(0);
  });

  it('refuses a source that still has sub-khat, in the same words as delete', async () => {
    const user = await signup(ctx);
    const cash = await account(user);
    const parent = await byName(user, 'যাতায়াত');
    const to = await byName(user, 'খাবার ও বাজার');

    await ctx
      .http()
      .post('/v1/categories')
      .set(auth(user))
      .send({ name: 'রিকশা', nameBn: 'রিকশা', kind: 'EXPENSE', parentId: parent.id })
      .expect(201);
    await spend(user, cash.id, parent.id, 30_000);

    /* Never silently re-parented. Where the children belong is a second decision
       this endpoint was not told how to make. */
    const refused = await move(user, parent.id, { toCategoryId: to.id }).expect(400);
    expect(refused.body.message).toContain('উপ-খাত');

    expect((await list(user)).find((c) => c.id === parent.id)?.usageCount).toBe(1);
  });

  it('refuses a khat moved into itself, and a target that is already gone', async () => {
    const user = await signup(ctx);
    const from = await byName(user, 'যাতায়াত');
    const to = await byName(user, 'খাবার ও বাজার');

    await move(user, from.id, { toCategoryId: from.id }).expect(400);

    await ctx.http().delete(`/v1/categories/${to.id}`).set(auth(user)).expect(200);
    await move(user, from.id, { toCategoryId: to.id }).expect(404);
    /* And a deleted source cannot be the one moved from either. */
    await move(user, to.id, { toCategoryId: from.id }).expect(404);
  });

  it('records the merge against the surviving khat', async () => {
    const user = await signup(ctx);
    const cash = await account(user);
    const from = await byName(user, 'যাতায়াত');
    const to = await byName(user, 'খাবার ও বাজার');

    await spend(user, cash.id, from.id, 30_000);
    await move(user, from.id, { toCategoryId: to.id, deleteAfter: true }).expect(201);

    /* Fire-and-forget by design, so the row may land a beat after the response. */
    await new Promise((resolve) => setTimeout(resolve, 150));

    const events = await ctx.prisma.auditEvent.findMany({
      where: { workspaceId: user.workspaceId, action: 'category.merged' },
    });
    expect(events).toHaveLength(1);
    /* Filed against the survivor: an entityId pointing at a খাত that no longer
       appears in any list would answer nothing. */
    expect(events[0]?.entityId).toBe(to.id);
    expect(events[0]?.before).toMatchObject({ id: from.id });
    expect(events[0]?.after).toMatchObject({ movedCount: 1, deleted: true });
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
