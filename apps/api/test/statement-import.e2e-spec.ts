import { makeStatementPdf, makeXlsx, type FixtureCell } from '@hishab/parsers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, createTestApp, resetDatabase, signup, type TestContext } from './harness';

/**
 * Reading a statement in whatever format it arrived, and warning about rows
 * that might already be in the books.
 *
 * Two things are being defended, and the second is the one that matters.
 *
 * **That the file opens at all.** A `.xlsx` and a real PDF are posted at the
 * endpoint and are expected to come back as the same rows a CSV of the same
 * data would. Both fixtures are built byte by byte in `@hishab/parsers` rather
 * than checked in, so what is in them is visible in the test.
 *
 * **That a possible duplicate is reported and never acted on.** A transaction
 * is recorded first, the statement carrying the same transaction is uploaded,
 * and the row comes back flagged *with the existing entry attached* — and then
 * committing it anyway writes it, because the person approving that row is the
 * only one who knows whether they withdrew ৳500 once or twice.
 */

const s = (value: string): FixtureCell => ({ kind: 's', value });
const num = (value: string): FixtureCell => ({ kind: 'n', value });
const day = (value: string): FixtureCell => ({ kind: 'd', value });

/** 46204 is 1 July 2026; the serials below run on from it. */
const WORKBOOK = [
  [s('হিসাব বিবরণী — জুলাই ২০২৬'), s(''), s(''), s('')],
  [s(''), s(''), s(''), s('')],
  [s('তারিখ'), s('বিবরণ'), s('জমা'), s('খরচ')],
  [day('46204'), s('বেতন'), num('50000'), num('')],
  [day('46206'), s('বাজার'), num(''), num('1250.5')],
  [day('46208'), s('রিকশা ভাড়া'), num(''), num('60')],
];

const PDF = makeStatementPdf({
  preamble: ['SONALI BANK LIMITED', 'Motijheel Branch, Dhaka', 'Statement for July 2026'],
  header: ['Date', 'Description', 'Debit', 'Credit'],
  rows: [
    ['01/07/2026', 'SALARY CREDIT', '', '50,000.00'],
    ['03/07/2026', 'BKASH SEND MONEY', '1,250.50', ''],
    ['05/07/2026', 'ATM WITHDRAWAL', '60.00', ''],
  ],
  columns: [40, 130, 340, 440],
});

describe('statement import', () => {
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

  async function expenseCategoryId(user: Awaited<ReturnType<typeof signup>>): Promise<string> {
    const res = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    return res.body.find((c: { kind: string }) => c.kind === 'EXPENSE').id as string;
  }

  const upload = (
    user: Awaited<ReturnType<typeof signup>>,
    body: Buffer,
    name: string,
    query = '',
  ) =>
    ctx
      .http()
      .post(`/v1/import/statement?filename=${name}${query}`)
      .set(auth(user))
      .set('content-type', 'application/octet-stream')
      .send(body);

  // --- the formats -----------------------------------------------------------

  it('reads an Excel workbook the app used to refuse outright', async () => {
    const { user } = await workspaceWithCash();
    const res = await upload(user, makeXlsx(WORKBOOK), 'july.xlsx').expect(200);

    expect(res.body.format).toBe('XLSX');
    expect(res.body.parsedRows).toBe(3);
    expect(res.body.errorRows).toBe(0);
    // Two title lines above the table, so the heading is row index 2.
    expect(res.body.headerRow).toBe(2);
    expect(res.body.headers).toEqual(['তারিখ', 'বিবরণ', 'জমা', 'খরচ']);
    expect(res.body.preamble[0]).toContain('জুলাই');
  });

  it('reads a spreadsheet date without ever having to guess day-first or month-first', async () => {
    /* The quiet win of reading the workbook rather than a CSV of it: Excel
     * stores a date as a number with a format, so `03/04/2026` never arises. */
    const { user } = await workspaceWithCash();
    const res = await upload(user, makeXlsx(WORKBOOK), 'july.xlsx').expect(200);

    const grid = res.body.grid as string[][];
    expect(grid[1]?.[0]).toBe('2026-07-01');
    expect(grid[2]?.[0]).toBe('2026-07-03');
  });

  it('keeps a spreadsheet amount exact to the poisha', async () => {
    const { user } = await workspaceWithCash();
    const res = await upload(user, makeXlsx(WORKBOOK), 'july.xlsx').expect(200);

    const rows = await parsedRows(user, res.body);
    const bazar = rows.find((row) => row.description === 'বাজার');
    expect(bazar?.amountMinor).toBe(125_050);
    expect(bazar?.direction).toBe('OUT');
  });

  it('reads a PDF, letterhead and all', async () => {
    const { user } = await workspaceWithCash();
    const res = await upload(user, PDF, 'july.pdf').expect(200);

    expect(res.body.format).toBe('PDF');
    expect(res.body.pageCount).toBe(1);
    // Three lines of bank address above the table, found and stepped over.
    expect(res.body.headerRow).toBe(3);
    expect(res.body.headers).toEqual(['Date', 'Description', 'Debit', 'Credit']);
    expect(res.body.parsedRows).toBe(3);

    const grid = res.body.grid as string[][];
    // The description must survive as one cell, not be split at its own spaces.
    expect(grid[2]?.[1]).toBe('BKASH SEND MONEY');
  });

  it('refuses a photograph out loud, and says what to send instead', async () => {
    const { user } = await workspaceWithCash();
    // A one-pixel PNG is enough: the refusal is decided from the first bytes.
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489',
      'hex',
    );
    const res = await upload(user, png, 'photo.png').expect(415);
    expect(String(res.body.message)).toContain('পিডিএফ');
  });

  it('names the old binary .xls rather than saying the file is broken', async () => {
    const { user } = await workspaceWithCash();
    const ole2 = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(64)]);
    const res = await upload(user, ole2, 'old.xls').expect(415);
    expect(String(res.body.message)).toContain('.xls');
  });

  it('writes nothing while reading', async () => {
    const { user } = await workspaceWithCash();
    await upload(user, makeXlsx(WORKBOOK), 'july.xlsx').expect(200);

    const txns = await ctx.http().get('/v1/transactions').set(auth(user)).expect(200);
    expect(txns.body.items ?? txns.body).toHaveLength(0);
    expect(await ctx.prisma.importBatch.count({ where: { workspaceId: user.workspaceId } })).toBe(
      0,
    );
  });

  // --- the duplicate warning -------------------------------------------------

  it('flags a row that matches something already recorded, and says which one', async () => {
    const { user, cashId } = await workspaceWithCash();

    /* The situation this whole feature exists for: the bank sent an SMS for the
     * rickshaw fare and it was recorded that day. The statement, weeks later,
     * carries it again along with two the SMS never mentioned. */
    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: '2026-07-05',
        type: 'EXPENSE',
        amountMinor: 6_000,
        accountId: cashId,
        categoryId: await expenseCategoryId(user),
        description: 'রিকশা',
      })
      .expect(201);

    const res = await upload(user, makeXlsx(WORKBOOK), 'july.xlsx', `&accountId=${cashId}`).expect(
      200,
    );

    expect(res.body.duplicates.scope).toBe('ACCOUNT');
    expect(res.body.duplicates.flaggedRows).toBe(1);

    const [flagged] = res.body.duplicates.rows;
    expect(flagged.matches).toHaveLength(1);
    // Everything the ⓘ has to show: what it was, where, and where it came from.
    expect(flagged.matches[0].amountMinor).toBe(6_000);
    expect(flagged.matches[0].date).toBe('2026-07-05');
    expect(flagged.matches[0].description).toBe('রিকশা');
    expect(flagged.matches[0].accountName).toBe('নগদ');
    expect(flagged.matches[0].source).toBe('MANUAL');
  });

  it('says so when it had no account to narrow the comparison to', async () => {
    const { user, cashId } = await workspaceWithCash();
    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: '2026-07-05',
        type: 'EXPENSE',
        amountMinor: 6_000,
        accountId: cashId,
        categoryId: await expenseCategoryId(user),
      })
      .expect(201);

    const res = await upload(user, makeXlsx(WORKBOOK), 'july.xlsx').expect(200);
    /* No account was chosen, so every real account was compared against. That
     * can only ever raise more questions, never fewer — but the screen has to
     * be able to say which comparison it made. */
    expect(res.body.duplicates.scope).toBe('ALL_ACCOUNTS');
    expect(res.body.duplicates.flaggedRows).toBe(1);
  });

  it('does not flag the same amount on a different day', async () => {
    const { user, cashId } = await workspaceWithCash();
    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: '2026-07-04',
        type: 'EXPENSE',
        amountMinor: 6_000,
        accountId: cashId,
        categoryId: await expenseCategoryId(user),
      })
      .expect(201);

    /* The date is exact and stays exact. A day either side would flag every
     * ৳60 rickshaw fare in the month against its neighbours. */
    const res = await upload(user, makeXlsx(WORKBOOK), 'july.xlsx', `&accountId=${cashId}`).expect(
      200,
    );
    expect(res.body.duplicates.flaggedRows).toBe(0);
  });

  it('does not flag the same amount and day in another account', async () => {
    const { user, cashId } = await workspaceWithCash();
    const bank = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'ব্যাংক', type: 'BANK', openingBalance: 0 })
      .expect(201);

    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: '2026-07-05',
        type: 'EXPENSE',
        amountMinor: 6_000,
        accountId: bank.body.id,
        categoryId: await expenseCategoryId(user),
      })
      .expect(201);

    const res = await upload(user, makeXlsx(WORKBOOK), 'july.xlsx', `&accountId=${cashId}`).expect(
      200,
    );
    expect(res.body.duplicates.flaggedRows).toBe(0);
  });

  it('never looks into another workspace for a match', async () => {
    const { user, cashId } = await workspaceWithCash();
    const stranger = await workspaceWithCash();
    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(stranger.user))
      .send({
        date: '2026-07-05',
        type: 'EXPENSE',
        amountMinor: 6_000,
        accountId: stranger.cashId,
        categoryId: await expenseCategoryId(stranger.user),
      })
      .expect(201);

    const res = await upload(user, makeXlsx(WORKBOOK), 'july.xlsx', `&accountId=${cashId}`).expect(
      200,
    );
    expect(res.body.duplicates.flaggedRows).toBe(0);
  });

  it('re-checks against a different account without the file being sent again', async () => {
    const { user, cashId } = await workspaceWithCash();
    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: '2026-07-05',
        type: 'EXPENSE',
        amountMinor: 6_000,
        accountId: cashId,
        categoryId: await expenseCategoryId(user),
      })
      .expect(201);

    const res = await ctx
      .http()
      .post('/v1/import/statement/duplicates')
      .set(auth(user))
      .send({
        accountId: cashId,
        rows: [
          { lineNumber: 4, date: '2026-07-05', amountMinor: 6_000 },
          { lineNumber: 5, date: '2026-07-06', amountMinor: 6_000 },
        ],
      })
      .expect(200);

    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].lineNumber).toBe(4);
  });

  // --- approving a flagged row ----------------------------------------------

  it('writes a flagged row when the person approving it says to', async () => {
    const { user, cashId } = await workspaceWithCash();

    /* Somebody really can pay ৳60 twice on the same day. The app surfaces the
     * suspicion; the person who was there decides, and their decision holds. */
    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: '2026-07-05',
        type: 'EXPENSE',
        amountMinor: 6_000,
        accountId: cashId,
        categoryId: await expenseCategoryId(user),
        description: 'রিকশা ভাড়া',
      })
      .expect(201);

    const res = await ctx
      .http()
      .post('/v1/import/commit')
      .set(auth(user))
      .send({
        filename: 'july.xlsx',
        accountId: cashId,
        datePreference: 'DMY',
        rows: [
          {
            lineNumber: 6,
            date: '2026-07-05',
            description: 'রিকশা ভাড়া',
            amountMinor: 6_000,
            direction: 'OUT',
            acceptDuplicate: true,
          },
        ],
      })
      .expect(201);

    expect(res.body.importedCount).toBe(1);
    expect(res.body.skippedCount).toBe(0);

    const accounts = await ctx.http().get('/v1/accounts').set(auth(user)).expect(200);
    expect(accounts.body.find((a: { id: string }) => a.id === cashId).balanceMinor).toBe(-12_000);
  });

  it('still skips a duplicate nobody has approved', async () => {
    /* The plain CSV path is untouched. Nothing on that screen shows a row
     * beside the entry it matched, so nobody has decided anything, and skipping
     * is still the only safe default there. */
    const { user, cashId } = await workspaceWithCash();
    const row = {
      lineNumber: 2,
      date: '2026-07-05',
      description: 'রিকশা ভাড়া',
      amountMinor: 6_000,
      direction: 'OUT' as const,
    };

    await ctx
      .http()
      .post('/v1/import/commit')
      .set(auth(user))
      .send({ filename: 'a.csv', accountId: cashId, datePreference: 'DMY', rows: [row] })
      .expect(201);

    const again = await ctx
      .http()
      .post('/v1/import/commit')
      .set(auth(user))
      .send({ filename: 'a.csv', accountId: cashId, datePreference: 'DMY', rows: [row] })
      .expect(400);
    expect(String(again.body.message)).toContain('আগে থেকেই');
  });

  it('lands the reviewed rows in a batch that can still be taken back in one press', async () => {
    const { user, cashId } = await workspaceWithCash();
    const previewed = await upload(user, PDF, 'july.pdf', `&accountId=${cashId}`).expect(200);
    const rows = await parsedRows(user, previewed.body);

    const committed = await ctx
      .http()
      .post('/v1/import/commit')
      .set(auth(user))
      .send({
        filename: 'july.pdf',
        fileHash: previewed.body.fileHash,
        accountId: cashId,
        datePreference: previewed.body.datePreference,
        rows,
      })
      .expect(201);
    expect(committed.body.importedCount).toBe(3);

    const reverted = await ctx
      .http()
      .post(`/v1/import/batches/${committed.body.batchId as string}/revert`)
      .set(auth(user))
      .send({})
      .expect(200);
    expect(reverted.body.revertedCount).toBe(3);
  });

  it('refuses an upload past the size cap', async () => {
    const { user } = await workspaceWithCash();
    const enormous = Buffer.alloc(9 * 1024 * 1024, 0x2c);
    await upload(user, enormous, 'big.csv').expect(413);
  });
});

/**
 * The rows the review screen would build, derived the same way it does.
 *
 * The endpoint hands back the grid and the mapping rather than finished rows,
 * because the screen re-parses live as the user corrects a column. Rebuilding
 * them here keeps the test honest about what the client actually has to do.
 */
async function parsedRows(
  _user: Awaited<ReturnType<typeof signup>>,
  preview: {
    grid: string[][];
    mapping: Record<string, { index: number; header: string; confidence: number }>;
    datePreference: 'DMY' | 'MDY';
  },
): Promise<
  {
    lineNumber: number;
    date: string;
    description: string;
    amountMinor: number;
    direction: 'IN' | 'OUT';
  }[]
> {
  const { buildRows } = await import('@hishab/core');
  return buildRows(preview.grid, preview.mapping, {
    datePreference: preview.datePreference,
  }).rows;
}
