import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auth,
  createTestApp,
  resetDatabase,
  signup,
  type SignedUpUser,
  type TestContext,
} from './harness';

/**
 * Tags, and the by-tag report.
 *
 * A tag says *who the money was for* — পরিবার, রমজান, শ্বশুরবাড়ি — and a
 * transaction may carry several. That single sentence is where every number in
 * the report comes from, and it is also why the report deliberately does not
 * balance: ৳৫০০ of groceries tagged both পরিবার and রমজান is ৳৫০০ of family
 * spending *and* ৳৫০০ of Ramadan spending. Most of this file exists to stop
 * somebody "fixing" that into wrongness — by splitting a transaction between its
 * tags, or by keeping only the first one. Both would make two true answers false.
 *
 * Every test signs up its own workspace, so no figure below depends on anything
 * another test did.
 */

/**
 * A window wide enough that the local day boundary cannot move a row out of it.
 *
 * The report's period is resolved in the workspace's timezone (Asia/Dhaka) and
 * the runner's clock is not, so "today" alone would be a flaky report on the
 * first of a month. Three days either side is not a fudge — the period is not
 * what any of these tests is about.
 */
const localDay = (offsetDays: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const today = localDay(0);
const PERIOD = { from: localDay(-3), to: localDay(3) };

interface TagView {
  id: string;
  name: string;
  nameBn: string | null;
  searchAliases: string[];
  transactionCount: number;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
}

interface TagRow {
  tagId: string | null;
  name: string;
  totalMinor: number;
  transactionCount: number;
  sharePercent: number;
}

interface TagReport {
  totalMinor: number;
  transactionCount: number;
  taggedMinor: number;
  untaggedMinor: number;
  attributedMinor: number;
  overlapMinor: number;
  rows: TagRow[];
}

describe('tags', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  /** A workspace with cash, an expense category and an income category. */
  async function workspace(): Promise<{
    user: SignedUpUser;
    cashId: string;
    expenseCategoryId: string;
    incomeCategoryId: string;
  }> {
    const user = await signup(ctx);
    const cash = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'নগদ', type: 'CASH', openingBalance: 10_000_000 })
      .expect(201);

    const cats = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    const expense = cats.body.find((c: { kind: string }) => c.kind === 'EXPENSE');
    const income = cats.body.find((c: { kind: string }) => c.kind === 'INCOME');

    return {
      user,
      cashId: cash.body.id as string,
      expenseCategoryId: expense.id as string,
      incomeCategoryId: income.id as string,
    };
  }

  const makeTag = async (user: SignedUpUser, name: string, extra = {}): Promise<TagView> => {
    const res = await ctx
      .http()
      .post('/v1/tags')
      .set(auth(user))
      .send({ name, ...extra })
      .expect(201);
    return res.body as TagView;
  };

  it('puts several tags on one transaction and filters the ledger by one of them', async () => {
    const { user, cashId, expenseCategoryId } = await workspace();

    const family = await makeTag(user, 'পরিবার');
    const ramadan = await makeTag(user, 'রমজান');
    const car = await makeTag(user, 'গাড়ি');

    const iftar = await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: today,
        type: 'EXPENSE',
        amountMinor: 50_000, // ৳500
        accountId: cashId,
        categoryId: expenseCategoryId,
        description: 'ইফতারের বাজার',
        tagIds: [family.id, ramadan.id],
      })
      .expect(201);

    // Both tags come back on the row, ready to render as chips, so a client
    // needs no second request — and a later edit knows what it would replace.
    expect((iftar.body.tags as { id: string }[]).map((t) => t.id).sort()).toEqual(
      [family.id, ramadan.id].sort(),
    );

    const fuel = await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: today,
        type: 'EXPENSE',
        amountMinor: 30_000, // ৳300
        accountId: cashId,
        categoryId: expenseCategoryId,
        description: 'পেট্রোল',
        tagIds: [car.id],
      })
      .expect(201);

    const byFamily = await ctx
      .http()
      .get('/v1/transactions')
      .query({ tagId: family.id })
      .set(auth(user))
      .expect(200);
    expect((byFamily.body.items as { id: string }[]).map((i) => i.id)).toEqual([iftar.body.id]);

    const byCar = await ctx
      .http()
      .get('/v1/transactions')
      .query({ tagId: car.id })
      .set(auth(user))
      .expect(200);
    expect((byCar.body.items as { id: string }[]).map((i) => i.id)).toEqual([fuel.body.id]);

    // The counts on the list are what make it usable — a word with no number
    // next to it cannot be judged safe to delete or worth merging.
    const tags = await ctx.http().get('/v1/tags').set(auth(user)).expect(200);
    const byId = new Map((tags.body as TagView[]).map((t) => [t.id, t]));
    expect(byId.get(family.id)?.transactionCount).toBe(1);
    expect(byId.get(family.id)?.expenseMinor).toBe(50_000);
    expect(byId.get(car.id)?.netMinor).toBe(-30_000); // spending, so net is negative
  });

  it('never lets one workspace reach another workspace’s tag', async () => {
    const { user, cashId, expenseCategoryId } = await workspace();
    const mine = await makeTag(user, 'গোপন');

    const stranger = await workspace();

    // Their list does not contain it, and neither does any route that names it.
    const theirs = await ctx.http().get('/v1/tags').set(auth(stranger.user)).expect(200);
    expect(theirs.body).toHaveLength(0);

    await ctx
      .http()
      .patch(`/v1/tags/${mine.id}`)
      .set(auth(stranger.user))
      .send({ name: 'চুরি' })
      .expect(404);
    await ctx.http().delete(`/v1/tags/${mine.id}`).set(auth(stranger.user)).expect(404);

    // A foreign tag on a create is a 404, not a silently ignored field: a
    // transaction that quietly lost its label would be worse than a refusal.
    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(stranger.user))
      .send({
        date: today,
        type: 'EXPENSE',
        amountMinor: 1_000,
        accountId: stranger.cashId,
        categoryId: stranger.expenseCategoryId,
        tagIds: [mine.id],
      })
      .expect(404);

    // And filtering by it 404s rather than returning an empty page, which would
    // read as "that tag exists and has nothing on it".
    await ctx
      .http()
      .get('/v1/transactions')
      .query({ tagId: mine.id })
      .set(auth(stranger.user))
      .expect(404);

    // A merge across the boundary, from either side, is the same 404.
    const hers = await makeTag(stranger.user, 'তার নিজের');
    await ctx
      .http()
      .post(`/v1/tags/${hers.id}/merge`)
      .set(auth(stranger.user))
      .send({ intoTagId: mine.id })
      .expect(404);

    // The owner is unaffected by any of it.
    const still = await ctx.http().get('/v1/tags').set(auth(user)).expect(200);
    expect((still.body as TagView[]).map((t) => t.id)).toEqual([mine.id]);
    expect(cashId).toBeTruthy();
    expect(expenseCategoryId).toBeTruthy();
  });

  /**
   * The arithmetic, with figures small enough to check by hand.
   *
   *   ইফতার   ৳৫০০   পরিবার + রমজান
   *   বাজার   ৳৩০০   পরিবার
   *   রিকশা   ৳২০০   (no tag)
   *
   * Spent in the period: ৳১,০০০. পরিবার saw ৳৮০০ of it, রমজান ৳৫০০, and ৳২০০
   * carried no label at all. The ৳৫০০ iftar bill is counted under both tags,
   * which is why the rows add to ৳১,৩০০ against a ৳১,০০০ month.
   */
  it('reports each tag in full, counts the month once, and names the overlap', async () => {
    const { user, cashId, expenseCategoryId } = await workspace();
    const family = await makeTag(user, 'পরিবার');
    const ramadan = await makeTag(user, 'রমজান');

    const spend = (amountMinor: number, description: string, tagIds: string[]) =>
      ctx
        .http()
        .post('/v1/transactions')
        .set(auth(user))
        .send({
          date: today,
          type: 'EXPENSE',
          amountMinor,
          accountId: cashId,
          categoryId: expenseCategoryId,
          description,
          tagIds,
        })
        .expect(201);

    await spend(50_000, 'ইফতার', [family.id, ramadan.id]);
    await spend(30_000, 'বাজার', [family.id]);
    await spend(20_000, 'রিকশা', []);

    const res = await ctx
      .http()
      .get('/v1/reports/by-tag')
      .query({ kind: 'EXPENSE', ...PERIOD })
      .set(auth(user))
      .expect(200);
    const report = res.body as TagReport;

    // 1. A transaction with two tags appears under both, in full.
    const rows = new Map(report.rows.map((r) => [r.tagId, r]));
    expect(rows.get(family.id)?.totalMinor).toBe(80_000); // ৳৫০০ + ৳৩০০
    expect(rows.get(family.id)?.transactionCount).toBe(2);
    expect(rows.get(ramadan.id)?.totalMinor).toBe(50_000); // the whole iftar bill
    expect(rows.get(ramadan.id)?.transactionCount).toBe(1);

    // 2. `totalMinor` counts each transaction exactly once, however many labels
    //    it carries. This is the figure that must agree with by-category.
    expect(report.totalMinor).toBe(100_000);
    expect(report.transactionCount).toBe(3);
    const byCategory = await ctx
      .http()
      .get('/v1/reports/by-category')
      .query({ kind: 'EXPENSE', ...PERIOD })
      .set(auth(user))
      .expect(200);
    expect(byCategory.body.total).toBe(report.totalMinor);

    // 3. attributedMinor exceeds totalMinor by exactly overlapMinor, and the
    //    overlap is exactly the doubly-tagged bill.
    expect(report.attributedMinor).toBe(130_000); // 80,000 + 50,000
    expect(report.taggedMinor).toBe(80_000); // ৳৫০০ + ৳৩০০, each once
    expect(report.untaggedMinor).toBe(20_000);
    expect(report.overlapMinor).toBe(50_000);
    expect(report.attributedMinor - report.overlapMinor).toBe(report.taggedMinor);

    // 4. Shares are of the month, not of the rows, so they may exceed 100%.
    expect(rows.get(family.id)?.sharePercent).toBe(80);
    expect(rows.get(ramadan.id)?.sharePercent).toBe(50);
    expect(rows.get(null)?.sharePercent).toBe(20);
    const tagShare = report.rows
      .filter((r) => r.tagId !== null)
      .reduce((sum, r) => sum + r.sharePercent, 0);
    expect(tagShare).toBe(130);
    expect(tagShare).toBeGreaterThan(100);
  });

  it('emits the untagged row even when everything is tagged', async () => {
    const { user, cashId, expenseCategoryId } = await workspace();
    const family = await makeTag(user, 'পরিবার');

    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: today,
        type: 'EXPENSE',
        amountMinor: 40_000,
        accountId: cashId,
        categoryId: expenseCategoryId,
        tagIds: [family.id],
      })
      .expect(201);

    const res = await ctx
      .http()
      .get('/v1/reports/by-tag')
      .query({ kind: 'EXPENSE', ...PERIOD })
      .set(auth(user))
      .expect(200);
    const report = res.body as TagReport;

    /* Present at zero, not omitted. "Everything this month is tagged" is worth
     * saying out loud; a missing row is indistinguishable from a bug. */
    const untagged = report.rows.find((r) => r.tagId === null);
    expect(untagged).toBeDefined();
    expect(untagged?.name).toBe('ট্যাগবিহীন');
    expect(untagged?.totalMinor).toBe(0);
    expect(untagged?.transactionCount).toBe(0);
    expect(report.untaggedMinor).toBe(0);
    expect(report.overlapMinor).toBe(0); // one tag each, so nothing is double-counted
  });

  it('merges one tag into another, moving what moved and counting what did not', async () => {
    const { user, cashId, expenseCategoryId } = await workspace();

    /* সংসার is deliberately nothing like `poribar`: after the merge the only
     * thing that can reach it from that query is the dead tag's name, kept as
     * an alias. If the alias were dropped, this test is the one that says so. */
    const source = await makeTag(user, 'পরিবার');
    const target = await makeTag(user, 'সংসার');

    const before = await ctx
      .http()
      .get('/v1/tags')
      .query({ q: 'poribar' })
      .set(auth(user))
      .expect(200);
    expect((before.body as TagView[]).map((t) => t.id)).not.toContain(target.id);

    const spend = async (amountMinor: number, tagIds: string[]): Promise<string> => {
      const res = await ctx
        .http()
        .post('/v1/transactions')
        .set(auth(user))
        .send({
          date: today,
          type: 'EXPENSE',
          amountMinor,
          accountId: cashId,
          categoryId: expenseCategoryId,
          tagIds,
        })
        .expect(201);
      return res.body.id as string;
    };

    const bothAlready = await spend(60_000, [source.id, target.id]);
    const onlySource = await spend(40_000, [source.id]);

    const merged = await ctx
      .http()
      .post(`/v1/tags/${source.id}/merge`)
      .set(auth(user))
      .send({ intoTagId: target.id })
      .expect(201);

    /* One row genuinely moved. The other already carried both tags — which is
     * the *common* case, because being used interchangeably is why somebody
     * merges — and reporting it as moved would overstate what happened. */
    expect(merged.body.movedTransactionCount).toBe(1);
    expect(merged.body.alreadyTaggedCount).toBe(1);
    expect(merged.body.from.name).toBe('পরিবার');
    expect(merged.body.into.name).toBe('সংসার');

    // The source is gone and the survivor holds both transactions.
    const list = await ctx.http().get('/v1/tags').set(auth(user)).expect(200);
    expect((list.body as TagView[]).map((t) => t.id)).toEqual([target.id]);
    expect((list.body as TagView[])[0]?.transactionCount).toBe(2);
    expect((list.body as TagView[])[0]?.expenseMinor).toBe(100_000);

    const filtered = await ctx
      .http()
      .get('/v1/transactions')
      .query({ tagId: target.id })
      .set(auth(user))
      .expect(200);
    expect((filtered.body.items as { id: string }[]).map((i) => i.id).sort()).toEqual(
      [bothAlready, onlySource].sort(),
    );

    // The dead word still finds the money. Somebody has been typing `poribar`
    // for a year and a merge must not take that away from them.
    expect((list.body as TagView[])[0]?.searchAliases).toContain('পরিবার');
    const after = await ctx
      .http()
      .get('/v1/tags')
      .query({ q: 'poribar' })
      .set(auth(user))
      .expect(200);
    expect((after.body as TagView[]).map((t) => t.id)).toContain(target.id);
  });

  it('refuses to merge a tag into itself', async () => {
    const { user } = await workspace();
    const tag = await makeTag(user, 'একা');
    await ctx
      .http()
      .post(`/v1/tags/${tag.id}/merge`)
      .set(auth(user))
      .send({ intoTagId: tag.id })
      .expect(400);
  });

  it('detaches a deleted tag without destroying a single transaction', async () => {
    const { user, cashId, expenseCategoryId } = await workspace();
    const tag = await makeTag(user, 'ভুল');

    const txn = await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: today,
        type: 'EXPENSE',
        amountMinor: 12_000,
        accountId: cashId,
        categoryId: expenseCategoryId,
        tagIds: [tag.id],
      })
      .expect(201);

    const removed = await ctx.http().delete(`/v1/tags/${tag.id}`).set(auth(user)).expect(200);
    expect(removed.body.detachedTransactionCount).toBe(1);
    expect(removed.body.deletedTransactionCount).toBe(0);

    // The money is exactly where it was; only the label is gone. `amountMinor`
    // is signed on the way out, so an expense reads negative.
    const still = await ctx
      .http()
      .get(`/v1/transactions/${txn.body.id}`)
      .set(auth(user))
      .expect(200);
    expect(still.body.amountMinor).toBe(-12_000);
    expect(still.body.tags).toEqual([]);
  });

  /**
   * `@@unique([workspaceId, name])` counts tombstones, so the delete leaves a
   * row squatting on the word. Without `releaseName` the user who deletes রমজান
   * in April cannot create it again next Ramadan — the insert fails on a row
   * they cannot see and have no endpoint to reach. This was a real bug.
   */
  it('lets a deleted tag’s name be used again', async () => {
    const { user } = await workspace();

    const first = await makeTag(user, 'রমজান');
    await ctx.http().delete(`/v1/tags/${first.id}`).set(auth(user)).expect(200);

    const second = await makeTag(user, 'রমজান');
    expect(second.id).not.toBe(first.id);

    const list = await ctx.http().get('/v1/tags').set(auth(user)).expect(200);
    expect((list.body as TagView[]).map((t) => t.id)).toEqual([second.id]);
  });

  it('still refuses a name a live tag already holds, in either language', async () => {
    const { user } = await workspace();
    await makeTag(user, 'family', { nameBn: 'পরিবার' });

    await ctx.http().post('/v1/tags').set(auth(user)).send({ name: 'family' }).expect(400);
    // The Bengali label counts too: a picker showing পরিবার twice is ambiguous
    // whatever the underlying columns say.
    await ctx.http().post('/v1/tags').set(auth(user)).send({ name: 'পরিবার' }).expect(400);
  });

  it('finds পরিবার from `poribar`, which no SQL LIKE ever could', async () => {
    const { user } = await workspace();
    const family = await makeTag(user, 'পরিবার');
    await makeTag(user, 'যাতায়াত');

    for (const q of ['poribar', 'poribaar', 'পরিবার']) {
      const res = await ctx.http().get('/v1/tags').query({ q }).set(auth(user)).expect(200);
      expect((res.body as TagView[])[0]?.id, `search for ${q}`).toBe(family.id);
    }

    // An alias reaches what transliteration cannot: `family` and পরিবার are two
    // different words that happen to mean the same thing.
    await ctx
      .http()
      .patch(`/v1/tags/${family.id}`)
      .set(auth(user))
      .send({ searchAliases: 'family, ammu' })
      .expect(200);

    const byAlias = await ctx
      .http()
      .get('/v1/tags')
      .query({ q: 'family' })
      .set(auth(user))
      .expect(200);
    expect((byAlias.body as TagView[])[0]?.id).toBe(family.id);
  });

  it('writes an audit row for every tag movement', async () => {
    const { user } = await workspace();
    const source = await makeTag(user, 'পুরনো');
    const target = await makeTag(user, 'নতুন');

    await ctx.http().patch(`/v1/tags/${target.id}`).set(auth(user)).send({ color: '#123456' });
    await ctx
      .http()
      .post(`/v1/tags/${source.id}/merge`)
      .set(auth(user))
      .send({ intoTagId: target.id })
      .expect(201);

    // The audit write is fire-and-forget, so let the event loop settle first.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const events = await ctx.prisma.auditEvent.findMany({
      where: { workspaceId: user.workspaceId, action: { startsWith: 'tag.' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.action)).toEqual([
      'tag.created',
      'tag.created',
      'tag.updated',
      'tag.merged',
    ]);
    /* Filed against the survivor. "What happened to পুরনো?" is the question
     * this row exists to answer, and an entityId pointing at a tag that no
     * longer appears anywhere answers nothing. */
    expect(events.at(-1)?.entityId).toBe(target.id);
  });
});
