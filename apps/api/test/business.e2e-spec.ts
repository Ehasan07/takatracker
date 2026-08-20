import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessCategoryCount } from '@hishab/core';
import { toLocalDateString } from '@hishab/shared';
import {
  auth,
  createTestApp,
  resetDatabase,
  signup,
  unlimit,
  type SignedUpUser,
  type TestContext,
} from './harness';

const TZ = 'Asia/Dhaka';
const month = toLocalDateString(new Date(), TZ).slice(0, 7);
const day = (d: string) => `${month}-${d}`;

/**
 * A shop kept inside a household's books.
 *
 * ## The month this suite works out by hand
 *
 *   opening stock          ৳ 40,000   (opening balance on মজুদ পণ্য)
 *   bought stock           ৳ 120,000  (a transfer, not a cost)
 *   sold                   ৳ 180,000  (income, tagged)
 *   counted at month end   ৳ 50,000
 *
 *   cost of goods sold = 40,000 + 120,000 − 50,000 = ৳ 110,000
 *   profit             = 180,000 − 110,000        = ৳ 70,000
 *
 * The figure that matters is the last one, and it is only reachable because
 * buying stock was not treated as spending it.
 */
describe('a personal business', () => {
  let ctx: TestContext;
  let user: SignedUpUser;
  let walletId: string;
  let stockId: string;
  let tagId: string;
  let salesId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    user = await signup(ctx);
    await unlimit(ctx, user.workspaceId);

    const post = (path: string, body: Record<string, unknown>) =>
      ctx.http().post(path).set(auth(user)).send(body).expect(201);

    walletId = (
      await post('/v1/accounts', {
        name: 'বিকাশ',
        type: 'MOBILE_WALLET',
        openingBalance: 20_000_000,
        openingBalanceDate: day('01'),
      })
    ).body.id;
    stockId = (
      await post('/v1/accounts', {
        name: 'মজুদ পণ্য',
        type: 'ASSET',
        assetKind: 'OTHER',
        openingBalance: 4_000_000,
        openingBalanceDate: day('01'),
      })
    ).body.id;

    /* Opt-in, and the server is where that is enforced. Most households have no
       business, and eighteen categories arriving in one that never asked for
       them would be a feature turning up by URL. */
    await ctx
      .http()
      .patch('/v1/workspace/settings')
      .set(auth(user))
      .send({ businessEnabled: true })
      .expect(200);

    const setup = await ctx
      .http()
      .post('/v1/business/setup')
      .set(auth(user))
      .send({ name: 'দোকান' })
      .expect(201);
    tagId = setup.body.tagId;

    const cats = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    salesId = cats.body.find((c: { nameBn: string }) => c.nameBn === 'পণ্য বিক্রি').id;

    /* Bought stock: a transfer, so the money changes form rather than leaving. */
    await post('/v1/transactions', {
      date: day('05'),
      type: 'TRANSFER',
      amountMinor: 12_000_000,
      accountId: walletId,
      counterAccountId: stockId,
      tagIds: [tagId],
    });
    await post('/v1/transactions', {
      date: day('10'),
      type: 'INCOME',
      amountMinor: 18_000_000,
      accountId: walletId,
      categoryId: salesId,
      tagIds: [tagId],
    });
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  describe('setting it up', () => {
    it('builds the whole tree in one press', async () => {
      const cats = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
      const names = cats.body.map((c: { nameBn: string }) => c.nameBn);
      expect(names).toContain('ব্যবসার আয়');
      expect(names).toContain('ব্যবসার খরচ');
      expect(names).toContain('বিক্রীত পণ্যের ব্যয়');
      expect(names).toContain('শেয়ার বিক্রয়ে ক্ষতি');
    });

    it('hangs every line under its own parent', async () => {
      /* A flat list of eighteen names is not a tree, and the income statement
         folds to parents — so a child with no parent prints as its own heading
         beside the one it belongs under. */
      const cats = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
      const byName = (n: string) => cats.body.find((c: { nameBn: string }) => c.nameBn === n);
      expect(byName('পণ্য বিক্রি').parentId).toBe(byName('ব্যবসার আয়').id);
      expect(byName('দোকান ভাড়া').parentId).toBe(byName('ব্যবসার খরচ').id);
    });

    it('can be pressed twice without doubling anything', async () => {
      /* Somebody who is not sure whether it worked will press it again. */
      const again = await ctx
        .http()
        .post('/v1/business/setup')
        .set(auth(user))
        .send({ name: 'দোকান' })
        .expect(201);

      expect(again.body.tagId).toBe(tagId);
      expect(again.body.createdCategories).toBe(0);
      expect(again.body.existingCategories).toBe(businessCategoryCount());

      const tags = await ctx.http().get('/v1/tags').set(auth(user)).expect(200);
      expect(tags.body.filter((t: { name: string }) => t.name === 'দোকান')).toHaveLength(1);
    });
  });

  describe('the month-end count', () => {
    it('says what the books hold before anybody contradicts them', async () => {
      const res = await ctx
        .http()
        .get(`/v1/business/stock-count?accountId=${stockId}&date=${day('28')}`)
        .set(auth(user))
        .expect(200);

      /* Opening ৳40,000 plus ৳1,20,000 bought in. Nothing has left yet. */
      expect(res.body.ledgerMinor).toBe(16_000_000);
    });

    it('turns one counted number into the cost of what was sold', async () => {
      const res = await ctx
        .http()
        .post('/v1/business/stock-count')
        .set(auth(user))
        .send({ accountId: stockId, date: day('28'), countedMinor: 5_000_000, tagId })
        .expect(201);

      expect(res.body.ledgerMinor).toBe(16_000_000);
      expect(res.body.costOfGoodsSoldMinor).toBe(11_000_000);
      expect(res.body.transactionId).toBeTruthy();

      /* And the stock account now says exactly what was counted. */
      const after = await ctx
        .http()
        .get(`/v1/business/stock-count?accountId=${stockId}&date=${day('28')}`)
        .set(auth(user))
        .expect(200);
      expect(after.body.ledgerMinor).toBe(5_000_000);
    });

    it('lands on the business statement as the profit for the month', async () => {
      const res = await ctx
        .http()
        .get(`/v1/reports/income-statement?from=${day('01')}&to=${day('28')}&tagId=${tagId}`)
        .set(auth(user))
        .expect(200);

      expect(res.body.incomeMinor).toBe(18_000_000);
      expect(res.body.expenseMinor).toBe(11_000_000);
      expect(res.body.surplusMinor).toBe(7_000_000);
    });

    it('refuses to invent income when more was counted than bought', async () => {
      /* Counting more than the books hold means a purchase was never recorded.
         Writing the difference as income would turn a missing purchase into
         profit, which is the one direction this must never round. */
      const res = await ctx
        .http()
        .post('/v1/business/stock-count')
        .set(auth(user))
        .send({ accountId: stockId, date: day('28'), countedMinor: 9_000_000, tagId })
        .expect(400);

      expect(res.body.message).toContain('ক্রয়');
    });

    it('says so plainly when nothing sold', async () => {
      const res = await ctx
        .http()
        .post('/v1/business/stock-count')
        .set(auth(user))
        .send({ accountId: stockId, date: day('28'), countedMinor: 5_000_000, tagId })
        .expect(400);

      expect(res.body.message).toContain('সমান');
    });

    it('never counts another workspace’s stock', async () => {
      const stranger = await signup(ctx);
      await ctx
        .http()
        .patch('/v1/workspace/settings')
        .set(auth(stranger))
        .send({ businessEnabled: true })
        .expect(200);

      await ctx
        .http()
        .get(`/v1/business/stock-count?accountId=${stockId}&date=${day('28')}`)
        .set(auth(stranger))
        .expect(404);
      await ctx
        .http()
        .post('/v1/business/stock-count')
        .set(auth(stranger))
        .send({ accountId: stockId, date: day('28'), countedMinor: 0 })
        .expect(404);
    });
  });

  describe('until somebody asks for it', () => {
    /* The switch is what says these books have a business in them at all. A
       household that never asked must not acquire eighteen categories, and
       hiding the link is not the same as refusing the write. */
    it('refuses every business endpoint', async () => {
      const plain = await signup(ctx);
      const settings = await ctx.http().get('/v1/workspace/settings').set(auth(plain)).expect(200);
      expect(settings.body.businessEnabled).toBe(false);

      await ctx
        .http()
        .post('/v1/business/setup')
        .set(auth(plain))
        .send({ name: 'দোকান' })
        .expect(403);

      const cats = await ctx.http().get('/v1/categories').set(auth(plain)).expect(200);
      expect(cats.body.map((c: { nameBn: string }) => c.nameBn)).not.toContain('ব্যবসার আয়');
    });

    it('lets it be switched on, and off again', async () => {
      const plain = await signup(ctx);
      const on = await ctx
        .http()
        .patch('/v1/workspace/settings')
        .set(auth(plain))
        .send({ businessEnabled: true })
        .expect(200);
      expect(on.body.businessEnabled).toBe(true);

      await ctx
        .http()
        .post('/v1/business/setup')
        .set(auth(plain))
        .send({ name: 'শেয়ার' })
        .expect(201);

      const off = await ctx
        .http()
        .patch('/v1/workspace/settings')
        .set(auth(plain))
        .send({ businessEnabled: false })
        .expect(200);
      expect(off.body.businessEnabled).toBe(false);

      /* Switching off hides the screens; it never deletes what was recorded.
         The categories and their transactions are the owner's books. */
      const cats = await ctx.http().get('/v1/categories').set(auth(plain)).expect(200);
      expect(cats.body.map((c: { nameBn: string }) => c.nameBn)).toContain('ব্যবসার আয়');
    });
  });
});
