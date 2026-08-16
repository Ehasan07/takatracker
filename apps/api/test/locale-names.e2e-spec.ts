import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auth,
  createTestApp,
  resetDatabase,
  signup,
  uniqueEmail,
  type TestContext,
} from './harness';

/**
 * A workspace whose books are kept in English reads English names.
 *
 * Both names have been stored since the seed was written — `name: 'Transport'`,
 * `nameBn: 'যাতায়াত'` — and until now every reader of the pair collapsed it the
 * same way, `nameBn ?? name`, in thirty-seven places. The English column was
 * seeded, searched against, and never once displayed.
 *
 * What is asserted here is the seam that decides it: `Workspace.locale`, read
 * onto the request by the JWT strategy and used wherever the server hands back
 * *one* string for a row that has two. Not the pickers — those get both columns
 * and choose for themselves.
 */
describe('names follow the workspace language', () => {
  let ctx: TestContext;
  let bn: Awaited<ReturnType<typeof signup>>;
  let en: Awaited<ReturnType<typeof signup>>;

  const seed = async (user: Awaited<ReturnType<typeof signup>>) => {
    const account = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'নগদ', type: 'CASH', openingBalance: 1_000_000 })
      .expect(201);

    const cats = await ctx.http().get('/v1/categories?kind=EXPENSE').set(auth(user)).expect(200);
    const transport = cats.body.find((c: { name: string }) => c.name === 'Transport');

    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        type: 'EXPENSE',
        date: '2026-08-13',
        amountMinor: 25_000,
        accountId: account.body.id,
        categoryId: transport.id,
        description: 'bus',
      })
      .expect(201);

    return { accountId: account.body.id as string, transportId: transport.id as string };
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    bn = await signup(ctx, uniqueEmail('bn'), 'bn');
    en = await signup(ctx, uniqueEmail('en'), 'en');
    await seed(bn);
    await seed(en);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('seeds both names, so the switch needs no migration', async () => {
    const cats = await ctx.http().get('/v1/categories?kind=EXPENSE').set(auth(en)).expect(200);
    const transport = cats.body.find((c: { name: string }) => c.name === 'Transport');
    expect(transport.name).toBe('Transport');
    expect(transport.nameBn).toBe('যাতায়াত');
  });

  it('gives a picker both columns whatever the language', async () => {
    /* The client chooses for itself here. The server only collapses the pair
       where it must hand back a single string. */
    for (const user of [bn, en]) {
      const cats = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
      const row = cats.body.find((c: { name: string }) => c.name === 'Transport');
      expect(row.name).toBe('Transport');
      expect(row.nameBn).toBe('যাতায়াত');
    }
  });

  it("names a transaction's category in the reader's language", async () => {
    const bnList = await ctx.http().get('/v1/transactions').set(auth(bn)).expect(200);
    const enList = await ctx.http().get('/v1/transactions').set(auth(en)).expect(200);
    /* By description, not by position: the account's opening balance is a
       transaction of its own now and it is dated today, so it sorts above an
       expense dated the 13th. Naming the row this test is about is what it
       meant all along. */
    const bus = (list: { body: { items: { description: string }[] } }) =>
      list.body.items.find((item) => item.description === 'bus') as unknown as {
        categoryName: string;
      };
    expect(bus(bnList).categoryName).toBe('যাতায়াত');
    expect(bus(enList).categoryName).toBe('Transport');
  });

  it('names a report row in the reader’s language', async () => {
    const bnReport = await ctx
      .http()
      .get('/v1/reports/by-category?kind=EXPENSE&flat=1&from=2026-08-01&to=2026-08-31')
      .set(auth(bn))
      .expect(200);
    const enReport = await ctx
      .http()
      .get('/v1/reports/by-category?kind=EXPENSE&flat=1&from=2026-08-01&to=2026-08-31')
      .set(auth(en))
      .expect(200);
    expect(bnReport.body.rows.some((r: { name: string }) => r.name === 'যাতায়াত')).toBe(true);
    expect(enReport.body.rows.some((r: { name: string }) => r.name === 'Transport')).toBe(true);
  });

  it('names the parent খাত in the reader’s language', async () => {
    /* `parentName` is the one field `/categories` collapses, because it is a
       name *about* another row. The search result list prints it as a prefix. */
    const cats = await ctx.http().get('/v1/categories?kind=EXPENSE').set(auth(en)).expect(200);
    const transport = cats.body.find((c: { name: string }) => c.name === 'Transport');

    await ctx
      .http()
      .post('/v1/categories')
      .set(auth(en))
      .send({ name: 'Rickshaw', nameBn: 'রিকশা', kind: 'EXPENSE', parentId: transport.id })
      .expect(201);

    const after = await ctx.http().get('/v1/categories?kind=EXPENSE').set(auth(en)).expect(200);
    const child = after.body.find((c: { name: string }) => c.name === 'Rickshaw');
    expect(child.parentName).toBe('Transport');
  });

  it('returns the parent name on the row it just created', async () => {
    /* This answered `parentName: null` for every row, including the ones that
       do have a parent — a view contradicting its own `parentId`. It hid behind
       the categories screen refetching after every save. */
    const cats = await ctx.http().get('/v1/categories?kind=EXPENSE').set(auth(bn)).expect(200);
    const transport = cats.body.find((c: { name: string }) => c.name === 'Transport');

    const created = await ctx
      .http()
      .post('/v1/categories')
      .set(auth(bn))
      .send({ name: 'CNG', nameBn: 'সিএনজি', kind: 'EXPENSE', parentId: transport.id })
      .expect(201);
    expect(created.body.parentName).toBe('যাতায়াত');
  });

  it('translates the buckets that are not a row in any table', async () => {
    /* Every other name on a report comes from a category or a tag. These two
       the report invents, and they are the lines most likely to need acting on
       — the money that has not been filed. */
    const enReport = await ctx
      .http()
      .get('/v1/reports/by-tag?kind=EXPENSE&from=2026-08-01&to=2026-08-31')
      .set(auth(en))
      .expect(200);
    expect(enReport.body.rows.some((r: { name: string }) => r.name === 'Untagged')).toBe(true);

    const bnReport = await ctx
      .http()
      .get('/v1/reports/by-tag?kind=EXPENSE&from=2026-08-01&to=2026-08-31')
      .set(auth(bn))
      .expect(200);
    expect(bnReport.body.rows.some((r: { name: string }) => r.name === 'ট্যাগবিহীন')).toBe(true);
  });

  it('exports a CSV whose headers and category names agree', async () => {
    /* A file whose two halves disagree — Bengali column titles over English
       category names — is worse than either one consistently. */
    const enCsv = await ctx.http().get('/v1/export/transactions').set(auth(en)).expect(200);
    const [header, ...rows] = enCsv.text.trim().split('\n');
    expect(header).toContain('Category');
    expect(header).not.toContain('ক্যাটাগরি');
    expect(rows.some((line) => line.includes('Transport'))).toBe(true);

    const bnCsv = await ctx.http().get('/v1/export/transactions').set(auth(bn)).expect(200);
    expect(bnCsv.text).toContain('ক্যাটাগরি');
    expect(bnCsv.text).toContain('যাতায়াত');
  });

  it('falls back rather than showing a blank', async () => {
    /* A খাত the user made has only what they typed. Rendering nothing for it
       would be worse than rendering the wrong language: the wrong language is
       still the row they are looking for, and a blank is one they cannot
       identify or choose. */
    const made = await ctx
      .http()
      .post('/v1/categories')
      .set(auth(en))
      .send({ name: 'গাড়ির তেল', nameBn: 'গাড়ির তেল', kind: 'EXPENSE' })
      .expect(201);

    const account = await ctx.http().get('/v1/accounts').set(auth(en)).expect(200);
    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(en))
      .send({
        type: 'EXPENSE',
        date: '2026-08-13',
        amountMinor: 5_000,
        accountId: account.body[0].id,
        categoryId: made.body.id,
      })
      .expect(201);

    const list = await ctx.http().get('/v1/transactions').set(auth(en)).expect(200);
    const row = list.body.items.find(
      (t: { categoryName: string | null }) => t.categoryName === 'গাড়ির তেল',
    );
    expect(row).toBeDefined();
  });

  it('leaves the audit log in the language it was written in', async () => {
    /* An audit entry records what happened at the time. Resolving it at read
       time would let the log's account of the past change with a setting. */
    const created = await ctx
      .http()
      .post('/v1/categories')
      .set(auth(en))
      .send({ name: 'Groceries', nameBn: 'বাজার', kind: 'EXPENSE' })
      .expect(201);

    const log = await ctx.http().get('/v1/audit?limit=50').set(auth(en)).expect(200);
    const entry = log.body.items.find(
      (e: { entityId: string; action: string }) =>
        e.entityId === created.body.id && e.action === 'category.created',
    );
    expect(entry).toBeDefined();
    expect(entry.after.name).toBe('বাজার');
  });
});
