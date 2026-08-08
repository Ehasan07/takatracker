import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, createTestApp, resetDatabase, signup, type TestContext } from './harness';

/**
 * Spreadsheet import and export.
 *
 * Two things are being defended here. First, that a preview writes nothing —
 * somebody looking at a file must be able to change their mind. Second, that
 * importing the same statement twice does not double anybody's books, which is
 * the mistake this feature would otherwise make easy.
 */

const CSV = [
  'তারিখ,বিবরণ,জমা,খরচ,রেফারেন্স',
  '01/07/2026,বেতন,50000.00,,SAL-07',
  '03/07/2026,বাজার,,1250.50,',
  '05/07/2026,রিকশা ভাড়া,,60.00,',
].join('\n');

describe('import', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  async function workspaceWithCash() {
    const user = await signup(ctx);
    const cash = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'নগদ', type: 'CASH', openingBalance: 0 })
      .expect(201);
    return { user, cashId: cash.body.id as string };
  }

  const preview = (user: Awaited<ReturnType<typeof signup>>, body = CSV, query = '') =>
    ctx
      .http()
      .post(`/v1/import/preview?filename=july.csv${query}`)
      .set(auth(user))
      .set('content-type', 'text/csv')
      .send(body);

  it('reads a Bengali-headed file and guesses the columns', async () => {
    const { user } = await workspaceWithCash();
    const res = await preview(user).expect(200);

    expect(res.body.headers).toHaveLength(5);
    expect(res.body.mapping.date).toBeTruthy();
    expect(res.body.mapping.credit).toBeTruthy();
    expect(res.body.mapping.debit).toBeTruthy();
    expect(res.body.totalRows).toBe(3);
    expect(res.body.errorRows).toBe(0);

    // ৳1,250.50 must survive as poisha exactly, not as a float.
    const bazar = res.body.sample.find((r: { description: string }) => r.description === 'বাজার');
    expect(bazar.amountMinor).toBe(125_050);
    expect(bazar.direction).toBe('OUT');
  });

  it('writes nothing while previewing', async () => {
    const { user } = await workspaceWithCash();
    await preview(user).expect(200);

    const txns = await ctx.http().get('/v1/transactions').set(auth(user)).expect(200);
    expect(txns.body.items ?? txns.body).toHaveLength(0);
    expect(await ctx.prisma.importBatch.count({ where: { workspaceId: user.workspaceId } })).toBe(
      0,
    );
  });

  it('commits the rows and moves the balance', async () => {
    const { user, cashId } = await workspaceWithCash();
    const previewed = await preview(user).expect(200);

    const res = await ctx
      .http()
      .post('/v1/import/commit')
      .set(auth(user))
      .send({
        filename: 'july.csv',
        fileHash: previewed.body.fileHash,
        accountId: cashId,
        datePreference: 'DMY',
        rows: previewed.body.sample,
      })
      .expect(201);

    expect(res.body.importedCount).toBe(3);
    expect(res.body.skippedCount).toBe(0);

    const accounts = await ctx.http().get('/v1/accounts').set(auth(user)).expect(200);
    const cash = accounts.body.find((a: { id: string }) => a.id === cashId);
    // 50,000 in, 1,250.50 + 60 out.
    expect(cash.balanceMinor).toBe(5_000_000 - 125_050 - 6_000);
  });

  it('skips rows it has already imported rather than doubling them', async () => {
    const { user, cashId } = await workspaceWithCash();
    const first = await preview(user).expect(200);
    await ctx
      .http()
      .post('/v1/import/commit')
      .set(auth(user))
      .send({
        filename: 'july.csv',
        fileHash: first.body.fileHash,
        accountId: cashId,
        datePreference: 'DMY',
        rows: first.body.sample,
      })
      .expect(201);

    // The same statement offered again — the mistake this must not make.
    const second = await preview(user).expect(200);
    expect(second.body.duplicateRows).toBe(3);
    expect(second.body.alreadyImported).not.toBeNull();

    /* Committing anyway is refused rather than quietly returning "imported 0".
     * The user pressed a button expecting something to happen; being told
     * plainly that all three rows are already in the books is the useful
     * answer, and the message names the count so they can check. */
    const again = await ctx
      .http()
      .post('/v1/import/commit')
      .set(auth(user))
      .send({
        filename: 'july.csv',
        accountId: cashId,
        datePreference: 'DMY',
        rows: second.body.sample,
      })
      .expect(400);
    expect(String(again.body.message)).toContain('৩');

    const accounts = await ctx.http().get('/v1/accounts').set(auth(user)).expect(200);
    const cash = accounts.body.find((a: { id: string }) => a.id === cashId);
    expect(cash.balanceMinor).toBe(5_000_000 - 125_050 - 6_000);
  });

  it('undoes a whole batch in one action', async () => {
    const { user, cashId } = await workspaceWithCash();
    const previewed = await preview(user).expect(200);
    const committed = await ctx
      .http()
      .post('/v1/import/commit')
      .set(auth(user))
      .send({
        filename: 'july.csv',
        accountId: cashId,
        datePreference: 'DMY',
        rows: previewed.body.sample,
      })
      .expect(201);

    const reverted = await ctx
      .http()
      .post(`/v1/import/batches/${committed.body.batchId as string}/revert`)
      .set(auth(user))
      .send({})
      .expect(200);
    expect(reverted.body.revertedCount).toBe(3);

    const accounts = await ctx.http().get('/v1/accounts').set(auth(user)).expect(200);
    expect(accounts.body.find((a: { id: string }) => a.id === cashId).balanceMinor).toBe(0);
  });

  it('refuses to read a date the file cannot prove', async () => {
    // 31/07 cannot be month-first, so under MDY the row is rejected rather than
    // silently flipped — a parser that flips only the rows it cannot otherwise
    // explain lands the rest months out with nothing on screen to say so.
    const { user } = await workspaceWithCash();
    const res = await preview(user, CSV.replace('01/07/2026', '31/07/2026'), '&datePreference=MDY');
    expect(res.status).toBe(200);
    expect(res.body.errorRows).toBeGreaterThan(0);
    expect(res.body.errors[0].lineNumber).toBeGreaterThan(0);
  });

  it('never lets one workspace revert another s batch', async () => {
    const { user, cashId } = await workspaceWithCash();
    const previewed = await preview(user).expect(200);
    const committed = await ctx
      .http()
      .post('/v1/import/commit')
      .set(auth(user))
      .send({
        filename: 'july.csv',
        accountId: cashId,
        datePreference: 'DMY',
        rows: previewed.body.sample,
      })
      .expect(201);

    const stranger = await signup(ctx);
    await ctx
      .http()
      .post(`/v1/import/batches/${committed.body.batchId as string}/revert`)
      .set(auth(stranger))
      .send({})
      .expect(404);
    expect(
      (await ctx.http().get('/v1/import/batches').set(auth(stranger)).expect(200)).body,
    ).toHaveLength(0);
  });
});

describe('export', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  async function categoryId(user: Awaited<ReturnType<typeof signup>>): Promise<string> {
    const res = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    return res.body.find((c: { kind: string }) => c.kind === 'EXPENSE').id as string;
  }

  it('writes a CSV Excel can open in Bengali', async () => {
    const user = await signup(ctx);
    const cash = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'নগদ', type: 'CASH', openingBalance: 1_000_000 })
      .expect(201);
    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: new Date().toISOString().slice(0, 10),
        type: 'EXPENSE',
        amountMinor: 125_050,
        accountId: cash.body.id,
        categoryId: await categoryId(user),
        description: 'বাজার',
      })
      .expect(201);

    const res = await ctx.http().get('/v1/export/transactions').set(auth(user)).expect(200);
    // Without the BOM Excel renders every Bengali character as mojibake.
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    expect(res.text).toContain('বাজার');
    expect(res.headers['content-disposition']).toContain('attachment');
  });

  it('defuses a description that Excel would treat as a formula', async () => {
    const user = await signup(ctx);
    const cash = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'নগদ', type: 'CASH', openingBalance: 1_000_000 })
      .expect(201);
    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: new Date().toISOString().slice(0, 10),
        type: 'EXPENSE',
        amountMinor: 100,
        accountId: cash.body.id,
        categoryId: await categoryId(user),
        description: '=cmd|/c calc',
      })
      .expect(201);

    const res = await ctx.http().get('/v1/export/transactions').set(auth(user)).expect(200);
    // A leading = would execute on open. It must arrive as text.
    expect(res.text).not.toMatch(/(^|,)"?=cmd/m);
    expect(res.text).toContain('cmd|/c calc');
  });

  it('hands over everything the workspace owns', async () => {
    const user = await signup(ctx);
    const res = await ctx.http().get('/v1/export/full').set(auth(user)).expect(200);

    // Spec §9 promises the user can take their data and leave. That promise is
    // only kept if the dump actually contains every table.
    for (const key of [
      'workspace',
      'accounts',
      'categories',
      'people',
      'transactions',
      'loans',
      'savingsPlans',
      'insurancePolicies',
      'auditEvents',
    ]) {
      expect(res.body, `missing ${key}`).toHaveProperty(key);
    }
  });
});
