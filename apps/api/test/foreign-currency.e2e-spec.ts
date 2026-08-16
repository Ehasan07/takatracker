import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auth,
  createTestApp,
  resetDatabase,
  signup,
  unlimit,
  type SignedUpUser,
  type TestContext,
} from './harness';

/**
 * A foreign-currency account is fenced off, not converted.
 *
 * `Account.currency` has existed since the first migration and until now not a
 * single balance, report or dashboard query read it. Every balance in this
 * system is an integer in the smallest unit of *its own* account's currency, so
 * a USD account holding $500 — stored as 50,000 cents — was added into a taka
 * net worth as ৳500. Wrong by roughly the exchange rate, in a figure that gave
 * no sign of it, and wrong in the direction that flatters the reader.
 *
 * Converting it properly is IAS 21 and is not what these tests are about:
 * 21.21 records a transaction at the spot rate on its own date, 21.23(a)
 * retranslates monetary balances at the closing rate, and 21.28 puts the
 * difference that falls out through profit or loss. That needs stored rates —
 * `LedgerEntry.fxRate` is an `Int` that cannot hold 121.50 and that every
 * writer sets to 1 — and a place to book the exchange difference. Neither
 * exists.
 *
 * So the rule these tests pin down is the interim one: a total covers the
 * accounts kept in the workspace's own currency and nothing else, and the
 * foreign account keeps working on its own terms beside it.
 */
const today = new Date().toISOString().slice(0, 10);

interface Summary {
  liquidMinor: number;
  netWorthMinor: number;
  assetsMinor: number;
  liabilitiesMinor: number;
}

describe('foreign currency', () => {
  let ctx: TestContext;
  let user: SignedUpUser;
  let takaBankId: string;
  let dollarBankId: string;
  let yuanAssetId: string;
  let dollarCardId: string;
  let foodCategoryId: string;
  let salaryCategoryId: string;

  const summary = async (): Promise<Summary> => {
    const res = await ctx.http().get('/v1/transactions/summary').set(auth(user)).expect(200);
    return res.body as Summary;
  };

  const addAccount = async (body: Record<string, unknown>): Promise<string> => {
    const res = await ctx.http().post('/v1/accounts').set(auth(user)).send(body).expect(201);
    return res.body.id as string;
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    user = await signup(ctx);
    // Four accounts against a free plan's two. The subject here is currency.
    await unlimit(ctx, user.workspaceId);

    /* The workspace is BDT — signup's default, and what nearly every real one
       is. ৳10,000 in the bank. */
    takaBankId = await addAccount({
      name: 'ব্যাংক',
      type: 'BANK',
      openingBalance: 1_000_000,
    });

    // $500. Fifty thousand cents, which is the number that used to be added to
    // the taka figure above as if it were ৳500.
    dollarBankId = await addAccount({
      name: 'ডলার অ্যাকাউন্ট',
      type: 'BANK',
      currency: 'USD',
      openingBalance: 50_000,
    });

    // ¥2,000 of something owned. An asset, so it lands in `assetsMinor`.
    yuanAssetId = await addAccount({
      name: 'চীনা সম্পদ',
      type: 'ASSET',
      currency: 'CNY',
      openingBalance: 200_000,
    });

    // A dollar card carrying $300 owed, so `liabilitiesMinor` is tested too.
    dollarCardId = await addAccount({
      name: 'ডলার কার্ড',
      type: 'CREDIT_CARD',
      currency: 'USD',
      openingBalance: -30_000,
      creditLimitMinor: 100_000,
    });

    const cats = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    foodCategoryId = cats.body.find((c: { nameBn: string }) => c.nameBn === 'খাবার ও বাজার').id;
    salaryCategoryId = cats.body.find((c: { nameBn: string }) => c.nameBn === 'বেতন').id;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('counts only the workspace currency in the opening position', async () => {
    const position = await summary();

    /* ৳10,000 and nothing else. Before the fence this was 1,000,000 + 50,000 +
       200,000 = 1,250,000 — a quarter of a lakh of taka that does not exist,
       assembled out of dollars and yuan at an implied rate of 1.00. */
    expect(position.liquidMinor).toBe(1_000_000);
    expect(position.assetsMinor).toBe(1_000_000);
    expect(position.liabilitiesMinor).toBe(0);
    expect(position.netWorthMinor).toBe(1_000_000);
  });

  it('does not move liquid or net worth when money leaves a USD account', async () => {
    const before = await summary();

    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: today,
        type: 'EXPENSE',
        amountMinor: 20_000,
        accountId: dollarBankId,
        categoryId: foodCategoryId,
        description: 'ডলারে বাজার',
      })
      .expect(201);

    const after = await summary();
    expect(after.liquidMinor).toBe(before.liquidMinor);
    expect(after.netWorthMinor).toBe(before.netWorthMinor);
    expect(after.assetsMinor).toBe(before.assetsMinor);

    // The entry is real and the account's own balance moved: $500 − $200.
    const accounts = await ctx.http().get('/v1/accounts').set(auth(user)).expect(200);
    const dollar = accounts.body.find((a: { id: string }) => a.id === dollarBankId);
    expect(dollar.balanceMinor).toBe(30_000);
  });

  it('does move liquid and net worth when the same money lands in a BDT account', async () => {
    const before = await summary();

    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: today,
        type: 'INCOME',
        amountMinor: 20_000,
        accountId: takaBankId,
        categoryId: salaryCategoryId,
      })
      .expect(201);

    const after = await summary();
    expect(after.liquidMinor).toBe(before.liquidMinor + 20_000);
    expect(after.netWorthMinor).toBe(before.netWorthMinor + 20_000);
  });

  it('keeps a foreign asset out of assets and a foreign card out of liabilities', async () => {
    const position = await summary();

    /* The ¥2,000 asset and the $300 card are both excluded, and the card is the
       one worth naming: a liability left in would have made the workspace look
       *poorer* by ৳300 rather than richer, so this is not a bug that only ever
       flattered. Neither direction is a rate anybody chose. */
    expect(position.assetsMinor).toBe(position.liquidMinor);
    expect(position.liabilitiesMinor).toBe(0);
    expect(position.netWorthMinor).toBe(position.liquidMinor);
  });

  it('still lists every foreign account, with its own currency and balance', async () => {
    const res = await ctx.http().get('/v1/accounts').set(auth(user)).expect(200);
    const byId = new Map<string, { currency: string; balanceMinor: number }>(
      res.body.map((a: { id: string; currency: string; balanceMinor: number }) => [a.id, a]),
    );

    // Excluded from the totals is not hidden from the screen.
    expect(byId.size).toBe(4);
    expect(byId.get(dollarBankId)).toMatchObject({ currency: 'USD', balanceMinor: 30_000 });
    expect(byId.get(yuanAssetId)).toMatchObject({ currency: 'CNY', balanceMinor: 200_000 });
    expect(byId.get(dollarCardId)).toMatchObject({ currency: 'USD', balanceMinor: -30_000 });
    expect(byId.get(takaBankId)?.currency).toBe('BDT');
  });

  it('counts an account whose currency is written in lower case', async () => {
    /* `Account.currency` is a free three-character string and nothing
       upper-cases it on the way in, so `bdt` is the workspace's own money
       spelled quietly. A case-sensitive comparison would fence off an account
       that belongs in the total — the failure that costs a user real taka
       rather than merely omitting foreign ones. */
    const before = await summary();
    await addAccount({
      name: 'ছোট হাতের নগদ',
      type: 'CASH',
      currency: 'bdt',
      openingBalance: 5_000,
    });

    const after = await summary();
    expect(after.liquidMinor).toBe(before.liquidMinor + 5_000);
    expect(after.netWorthMinor).toBe(before.netWorthMinor + 5_000);
  });

  it('leaves a workspace with no foreign account exactly as it was', async () => {
    /* The fence must be invisible to nearly everybody. A second workspace with
       only taka accounts gets the same figures it always did — the filter is a
       no-op when there is nothing to filter. */
    const plain = await signup(ctx);
    await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(plain))
      .send({ name: 'নগদ', type: 'CASH', openingBalance: 750_000 })
      .expect(201);

    const res = await ctx.http().get('/v1/transactions/summary').set(auth(plain)).expect(200);
    expect(res.body.liquidMinor).toBe(750_000);
    expect(res.body.netWorthMinor).toBe(750_000);
  });
});
