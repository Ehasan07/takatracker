import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, createTestApp, resetDatabase, signup, unlimit, type TestContext } from './harness';

/**
 * A statement of account — the document a bank issues for one account.
 *
 * The thing under test is not "does it list transactions". It is the arithmetic
 * a statement is *for*:
 *
 *     opening + total debits − total credits = closing
 *
 * If that identity ever fails, every other number on the page is decoration.
 * So it is asserted on a bank account, on a credit card, inside a date window
 * and at the boundaries of one — because those are the four places a running
 * balance goes wrong.
 *
 * The other half is what must not appear: a deleted transaction, an entry
 * outside the window, and anything at all from another workspace.
 */
describe('a statement of account', () => {
  let ctx: TestContext;
  let user: Awaited<ReturnType<typeof signup>>;
  let bankId: string;
  let cashId: string;
  let cardId: string;
  let categoryId: string;
  let incomeCategoryId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    user = await signup(ctx);
    /* Three accounts, and the free plan allows two. This suite is about a
       statement, not about the plan ceiling — that has its own. */
    await unlimit(ctx, user.workspaceId);

    const account = async (
      name: string,
      type: string,
      openingBalance = 0,
      openingBalanceDate?: string,
    ) => {
      const made = await ctx
        .http()
        .post('/v1/accounts')
        .set(auth(user))
        .send({ name, type, openingBalance, openingBalanceDate })
        .expect(201);
      return made.body.id as string;
    };

    /* ৳10,000 opening, dated the day before this account's history starts.
       Every figure below is derived from it, so a statement that forgets the
       opening balance fails on its first assertion.

       The date is now required to make sense of the figure: an opening balance
       is an OPENING_BALANCE transaction against equity, so it belongs to a day
       like everything else on the page. Dated 28 February, it is inherited by
       every window from March onwards — which is what "opening balance" meant
       all along, said in a way a dated report can act on. */
    bankId = await account('ব্যাংক', 'BANK', 1_000_000, '2026-02-28');
    cashId = await account('নগদ', 'CASH');
    cardId = await account('ক্রেডিট কার্ড', 'CREDIT_CARD');

    const categories = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    categoryId = categories.body.find((c: { kind: string }) => c.kind === 'EXPENSE').id;
    incomeCategoryId = categories.body.find((c: { kind: string }) => c.kind === 'INCOME').id;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  const statement = (accountId: string, query = '') =>
    ctx.http().get(`/v1/accounts/${accountId}/statement${query}`).set(auth(user));

  const spend = (accountId: string, date: string, amountMinor: number, description: string) =>
    ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({ date, type: 'EXPENSE', amountMinor, accountId, categoryId, description })
      .expect(201);

  const earn = (accountId: string, date: string, amountMinor: number, description: string) =>
    ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date,
        type: 'INCOME',
        amountMinor,
        accountId,
        categoryId: incomeCategoryId,
        description,
      })
      .expect(201);

  it('opens at the opening balance and closes where the arithmetic says', async () => {
    await earn(bankId, '2026-03-05', 5_000_000, 'বেতন');
    await spend(bankId, '2026-03-10', 1_200_000, 'বাড়ি ভাড়া');
    await spend(bankId, '2026-03-20', 300_000, 'বিদ্যুৎ বিল');

    const res = await statement(bankId).expect(200);

    /* No window asked for, so the statement covers the whole life of the
       account — and the opening balance is inside that life rather than before
       it. It opens at nothing and its first row *is* the opening balance,
       dated, described and reconcilable, which is precisely what the old
       dateless column could never be: it was a number on the opening line with
       no entry anywhere to account for it. */
    expect(res.body.openingMinor).toBe(0);
    expect(res.body.rows).toHaveLength(4);
    expect(res.body.rows[0]).toMatchObject({
      date: '2026-02-28',
      description: 'প্রারম্ভিক জের',
      debitMinor: 1_000_000,
      creditMinor: 0,
      balanceMinor: 1_000_000,
    });

    /* A bank account is debit-normal: money in is a debit, money out a credit.
       Getting this backwards is the single most common way to build this
       screen, and it makes every balance on it wrong. */
    expect(res.body.debitNormal).toBe(true);
    expect(res.body.rows[1]).toMatchObject({
      date: '2026-03-05',
      debitMinor: 5_000_000,
      creditMinor: 0,
      balanceMinor: 6_000_000,
    });
    expect(res.body.rows[2]).toMatchObject({
      debitMinor: 0,
      creditMinor: 1_200_000,
      balanceMinor: 4_800_000,
    });

    expect(res.body.totalDebitMinor).toBe(6_000_000);
    expect(res.body.totalCreditMinor).toBe(1_500_000);
    expect(res.body.closingMinor).toBe(4_500_000);

    // The identity the whole document rests on.
    expect(res.body.openingMinor + res.body.totalDebitMinor - res.body.totalCreditMinor).toBe(
      res.body.closingMinor,
    );
  });

  it('carries the other side of every entry, which is what makes a row readable', async () => {
    const res = await statement(bankId).expect(200);

    /* ৳12,000 against `বাড়ি ভাড়া` is a rent payment; the same amount against
       `নগদ` would be a withdrawal. Without the contra column a reader cannot
       tell those apart, which is the whole use of a statement. */
    const rent = res.body.rows.find(
      (r: { description: string }) => r.description === 'বাড়ি ভাড়া',
    );
    expect(rent.contra).toBeTruthy();
    expect(rent.transactionId).toBeTruthy();
  });

  it('starts a windowed statement from the balance the window inherits', async () => {
    /* March is already ৳45,000 at close. April's statement must open there
       rather than at the account's ৳10,000, and it must not list March. */
    await spend(bankId, '2026-04-02', 500_000, 'এপ্রিলের বাজার');

    const res = await statement(bankId, '?from=2026-04-01&to=2026-04-30').expect(200);

    expect(res.body.openingMinor).toBe(4_500_000);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].description).toBe('এপ্রিলের বাজার');
    expect(res.body.closingMinor).toBe(4_000_000);
    expect(res.body.from).toBe('2026-04-01');
    expect(res.body.to).toBe('2026-04-30');
  });

  it('includes both edges of the window', async () => {
    /* An off-by-one at either boundary loses a real entry, and the reader has
       no way to know it is missing. The 1st and the 30th are the two dates
       that catch it. */
    await spend(cashId, '2026-05-01', 100_000, 'পয়লা');
    await spend(cashId, '2026-05-31', 200_000, 'শেষ দিন');
    await spend(cashId, '2026-06-01', 400_000, 'জুনের এক তারিখ');

    const res = await statement(cashId, '?from=2026-05-01&to=2026-05-31').expect(200);

    expect(res.body.rows.map((r: { description: string }) => r.description)).toEqual([
      'পয়লা',
      'শেষ দিন',
    ]);
    expect(res.body.closingMinor).toBe(-300_000);
  });

  it('reads a credit card the way a liability is read', async () => {
    /* Spending on a card is a credit to the card account: what you owe grows.
       The balance is negative because that is how this system signs a
       liability everywhere else — the statement must not invent a local
       convention, or it becomes the one document that disagrees with the
       balance sheet. */
    await spend(cardId, '2026-03-12', 800_000, 'কার্ডে কেনাকাটা');

    const res = await statement(cardId).expect(200);

    expect(res.body.debitNormal).toBe(false);
    expect(res.body.rows[0]).toMatchObject({ debitMinor: 0, creditMinor: 800_000 });
    expect(res.body.closingMinor).toBe(-800_000);
  });

  it('a transfer appears on both accounts, once on each and facing the other way', async () => {
    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: '2026-07-01',
        type: 'TRANSFER',
        amountMinor: 250_000,
        accountId: bankId,
        counterAccountId: cashId,
        description: 'ব্যাংক থেকে নগদে',
      })
      .expect(201);

    const fromBank = await statement(bankId, '?from=2026-07-01&to=2026-07-01').expect(200);
    const toCash = await statement(cashId, '?from=2026-07-01&to=2026-07-01').expect(200);

    expect(fromBank.body.rows).toHaveLength(1);
    expect(fromBank.body.rows[0].creditMinor).toBe(250_000);
    expect(toCash.body.rows).toHaveLength(1);
    expect(toCash.body.rows[0].debitMinor).toBe(250_000);

    /* And the two sides name each other, which is what tells a reader the money
       did not leave. */
    expect(fromBank.body.rows[0].contra).toBe('নগদ');
    expect(toCash.body.rows[0].contra).toBe('ব্যাংক');
  });

  it('forgets a deleted transaction completely, at every date', async () => {
    const doomed = await spend(cashId, '2026-08-01', 900_000, 'ভুল এন্ট্রি');
    const before = await statement(cashId).expect(200);
    expect(
      before.body.rows.some((r: { description: string }) => r.description === 'ভুল এন্ট্রি'),
    ).toBe(true);

    await ctx.http().delete(`/v1/transactions/${doomed.body.id}`).set(auth(user)).expect(200);

    /* Not "it stops appearing from today". The books say it never happened, so
       a statement for August must not show it either. */
    const after = await statement(cashId, '?from=2026-08-01&to=2026-08-31').expect(200);
    expect(after.body.rows).toHaveLength(0);
    expect(after.body.closingMinor).toBe(after.body.openingMinor);
  });

  it('is not reachable from another workspace', async () => {
    const stranger = await signup(ctx);
    await ctx.http().get(`/v1/accounts/${bankId}/statement`).set(auth(stranger)).expect(404);
  });

  it('can be shared as a link somebody without an account can open', async () => {
    const made = await ctx
      .http()
      .post('/v1/statement-shares')
      .set(auth(user))
      .send({ kind: 'ACCOUNT', subjectId: bankId, from: '2026-03-01', to: '2026-03-31' })
      .expect(201);

    const token = made.body.url.replace('/s/', '');
    // No Authorization header. That is the point of the link.
    const read = await ctx.http().get(`/v1/public/statement/${token}`).expect(200);

    expect(read.body.kind).toBe('ACCOUNT');
    expect(read.body.title).toBe('ব্যাংক');
    /* The window is the row's, not the URL's, so the reader gets March and
       March only — and the same closing figure the owner sees. */
    expect(read.body.data.openingMinor).toBe(1_000_000);
    expect(read.body.data.closingMinor).toBe(4_500_000);
    expect(read.body.data.rows).toHaveLength(3);
  });

  it('will not mint a link to an account in another workspace', async () => {
    const stranger = await signup(ctx);
    await ctx
      .http()
      .post('/v1/statement-shares')
      .set(auth(stranger))
      .send({ kind: 'ACCOUNT', subjectId: bankId })
      .expect(404);
  });
});
