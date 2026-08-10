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
 * `GET /v1/transactions?q=` — the one place Banglish has to cross into SQL.
 *
 * Postgres cannot transliterate: `khabar` and `খাবার` share not one code point,
 * so no `ILIKE`, `unaccent` or trigram index will ever put them together. The
 * endpoint bridges the two by resolving the query against the workspace's
 * categories and people in memory — a few dozen rows — and filtering the ledger
 * on the ids that come back. Every case below is a query that returned an empty
 * screen before that existed.
 */
const today = new Date().toISOString().slice(0, 10);

interface Item {
  id: string;
  description: string | null;
}

describe('transaction search', () => {
  let ctx: TestContext;
  let user: SignedUpUser;
  let cashId: string;
  let foodId: string;
  let mobileId: string;

  /** ids, so an assertion names a row rather than counting anonymous ones. */
  let market: string;
  let recharge: string;
  let staples: string;
  let loanTransaction: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    user = await signup(ctx);

    const cash = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'নগদ', type: 'CASH', openingBalance: 20_000_000 })
      .expect(201);
    cashId = cash.body.id;

    const cats = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    foodId = cats.body.find((c: { nameBn: string }) => c.nameBn === 'খাবার ও বাজার').id;
    mobileId = cats.body.find((c: { nameBn: string }) => c.nameBn === 'মোবাইল/ইন্টারনেট').id;

    const expense = async (
      amountMinor: number,
      categoryId: string,
      description: string,
      payee?: string,
    ): Promise<string> => {
      const res = await ctx
        .http()
        .post('/v1/transactions')
        .set(auth(user))
        .send({
          date: today,
          type: 'EXPENSE',
          amountMinor,
          accountId: cashId,
          categoryId,
          description,
          payee,
        })
        .expect(201);
      return res.body.id as string;
    };

    // Bengali description, Bengali category — nothing Latin anywhere on the row.
    market = await expense(25_000, foodId, 'সপ্তাহের বাজার');
    recharge = await expense(30_000, mobileId, 'রিচার্জ', 'Robi');
    staples = await expense(5_000, foodId, 'chal dal');

    /* A loan books a transaction carrying `personId`, which is the only way a
     * transaction gets a counterparty today — and the only way to exercise the
     * person half of the resolution. */
    const loan = await ctx
      .http()
      .post('/v1/loans')
      .set(auth(user))
      .send({
        personName: 'আফরোজা',
        direction: 'LENT',
        principalMinor: 4_000_000,
        interestType: 'NONE',
        loanDate: today,
        accountId: cashId,
      })
      .expect(201);
    loanTransaction = loan.body.loan.transactionId as string;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  const search = async (q: string, as: SignedUpUser = user): Promise<string[]> => {
    const res = await ctx.http().get('/v1/transactions').query({ q }).set(auth(as)).expect(200);
    return (res.body.items as Item[]).map((i) => i.id);
  };

  it('finds a Bengali row from a Banglish query, through its category', async () => {
    // `khabar` and `খাবার ও বাজার` share no code points at all. Both rows are
    // filed under it; neither says anything Latin.
    const ids = await search('khabar');
    expect(ids).toContain(market);
    expect(ids).toContain(staples);
    expect(ids).not.toContain(recharge);
  });

  it('reaches the same rows from the other spelling and the other script', async () => {
    for (const q of ['bajar', 'bazar', 'খাবার']) {
      expect(await search(q), q).toContain(market);
    }
    expect(await search('mobail')).toEqual([recharge]);
  });

  it('finds a row by its counterparty, written without the inherent vowel', async () => {
    // আফরোজা transliterates to `aforoja`; `afroza` is how it is actually
    // written, and core's reserved vowel slot is what makes it a candidate.
    for (const q of ['afroza', 'aforoja', 'আফরোজা']) {
      expect(await search(q), q).toContain(loanTransaction);
    }
  });

  it('still matches the row’s own text, in either script', async () => {
    expect(await search('Robi')).toEqual([recharge]); // payee, ILIKE
    expect(await search('chal')).toEqual([staples]); // description, ILIKE
    expect(await search('রিচার্জ')).toEqual([recharge]);
  });

  it('ANDs the tokens across the two halves', async () => {
    // `khabar` is satisfied by the category id, `chal` by the description, and
    // only one row satisfies both.
    expect(await search('khabar chal')).toEqual([staples]);
    expect(await search('khabar রিচার্জ')).toEqual([]);
  });

  it('never lets a token too short to be a filter mean “every category”', async () => {
    /* `ও` is one character: core says that is not a filter, so the resolution
     * must discard the unfiltered list it gets back rather than treat every
     * category as a match. খাবার ও বাজার contains ও; মোবাইল/ইন্টারনেট does not,
     * and neither does anything on the recharge row. */
    const ids = await search('ও');
    expect(ids).not.toContain(recharge);
  });

  it('resolves ids inside the asking workspace only', async () => {
    const other = await signup(ctx);
    const otherCash = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(other))
      .send({ name: 'নগদ', type: 'CASH', openingBalance: 1_000_000 })
      .expect(201);
    const otherCats = await ctx.http().get('/v1/categories').set(auth(other)).expect(200);
    const otherFood = otherCats.body.find(
      (c: { nameBn: string }) => c.nameBn === 'খাবার ও বাজার',
    ).id;
    const theirs = await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(other))
      .send({
        date: today,
        type: 'EXPENSE',
        amountMinor: 1_000,
        accountId: otherCash.body.id,
        categoryId: otherFood,
        description: 'অন্য কারও বাজার',
      })
      .expect(201);

    /* Both workspaces seeded a খাবার ও বাজার, so the two id sets look alike and
     * only the scoping keeps them apart. */
    const mine = await search('khabar');
    expect(mine).toContain(market);
    expect(mine).not.toContain(theirs.body.id);

    const hers = await search('khabar', other);
    expect(hers).toEqual([theirs.body.id]);
  });

  it('leaves the unfiltered list exactly as it was', async () => {
    const res = await ctx.http().get('/v1/transactions').set(auth(user)).expect(200);
    const ids = (res.body.items as Item[]).map((i) => i.id);
    expect(ids).toContain(market);
    expect(ids).toContain(recharge);
    expect(ids).toContain(staples);
    expect(ids).toContain(loanTransaction);
  });
});
