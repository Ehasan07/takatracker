import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMMON_QUANTITY_UNITS, MAX_CUSTOM_UNITS } from '@hishab/shared';
import { auth, createTestApp, resetDatabase, signup, type TestContext } from './harness';

/**
 * The units a workspace adds to the quantity field's suggestions.
 *
 * The field itself is free text and stays free text — a unit typed straight
 * into the entry sheet saves whether or not it is in this list. What is tested
 * here is the list that *feeds the dropdown*: that it is private to one
 * workspace, that it refuses to hold two spellings of the same unit, and that
 * removing one leaves the transactions already recorded in it untouched.
 */
describe('workspace settings: quantity units', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('starts empty — the shipped units are in the client, not the column', async () => {
    const user = await signup(ctx);
    const res = await ctx.http().get('/v1/workspace/settings').set(auth(user)).expect(200);
    expect(res.body.quantityUnits).toEqual([]);
  });

  it('keeps what was added, in the order it was given', async () => {
    const user = await signup(ctx);

    const saved = await ctx
      .http()
      .patch('/v1/workspace/settings')
      .set(auth(user))
      .send({ quantityUnits: ['তোলা', 'খাঁচা', 'ফাইল'] })
      .expect(200);
    expect(saved.body.quantityUnits).toEqual(['তোলা', 'খাঁচা', 'ফাইল']);

    const read = await ctx.http().get('/v1/workspace/settings').set(auth(user)).expect(200);
    expect(read.body.quantityUnits).toEqual(['তোলা', 'খাঁচা', 'ফাইল']);
  });

  it('refuses a second spelling of a unit the build already ships', async () => {
    /* Otherwise the dropdown shows কেজি twice and only one of them can be
       removed from the screen that manages the workspace's own list. */
    const user = await signup(ctx);
    const res = await ctx
      .http()
      .patch('/v1/workspace/settings')
      .set(auth(user))
      .send({ quantityUnits: [' কেজি ', COMMON_QUANTITY_UNITS[0], 'তোলা'] })
      .expect(200);
    expect(res.body.quantityUnits).toEqual(['তোলা']);
  });

  it('refuses a repeat within one submission', async () => {
    const user = await signup(ctx);
    const res = await ctx
      .http()
      .patch('/v1/workspace/settings')
      .set(auth(user))
      .send({ quantityUnits: ['তোলা', 'তোলা', ' তোলা'] })
      .expect(200);
    expect(res.body.quantityUnits).toEqual(['তোলা']);
  });

  it('caps the list rather than letting the dropdown grow past a screen', async () => {
    const user = await signup(ctx);
    const many = Array.from({ length: MAX_CUSTOM_UNITS + 5 }, (_, i) => `একক${i}`);
    const res = await ctx
      .http()
      .patch('/v1/workspace/settings')
      .set(auth(user))
      .send({ quantityUnits: many })
      .expect(200);
    expect(res.body.quantityUnits).toHaveLength(MAX_CUSTOM_UNITS);
  });

  it('rejects a unit longer than the transaction column accepts', async () => {
    /* Refused at the edge rather than trimmed: a unit silently cut to twenty
       characters would never match the one on the saved rows. */
    const user = await signup(ctx);
    await ctx
      .http()
      .patch('/v1/workspace/settings')
      .set(auth(user))
      .send({ quantityUnits: ['অ'.repeat(40)] })
      .expect(400);
  });

  it('is private to one workspace', async () => {
    const mine = await signup(ctx);
    const theirs = await signup(ctx);

    await ctx
      .http()
      .patch('/v1/workspace/settings')
      .set(auth(mine))
      .send({ quantityUnits: ['তোলা'] })
      .expect(200);

    const other = await ctx.http().get('/v1/workspace/settings').set(auth(theirs)).expect(200);
    expect(other.body.quantityUnits).toEqual([]);
  });

  it('an empty array clears the list', async () => {
    const user = await signup(ctx);
    await ctx
      .http()
      .patch('/v1/workspace/settings')
      .set(auth(user))
      .send({ quantityUnits: ['তোলা'] })
      .expect(200);

    const cleared = await ctx
      .http()
      .patch('/v1/workspace/settings')
      .set(auth(user))
      .send({ quantityUnits: [] })
      .expect(200);
    expect(cleared.body.quantityUnits).toEqual([]);
  });

  it('an omitted field leaves the list alone', async () => {
    /* A PATCH that carries nothing must not be read as "remove them all". */
    const user = await signup(ctx);
    await ctx
      .http()
      .patch('/v1/workspace/settings')
      .set(auth(user))
      .send({ quantityUnits: ['তোলা'] })
      .expect(200);

    const untouched = await ctx
      .http()
      .patch('/v1/workspace/settings')
      .set(auth(user))
      .send({})
      .expect(200);
    expect(untouched.body.quantityUnits).toEqual(['তোলা']);
  });

  it('removing a unit leaves transactions already recorded in it alone', async () => {
    const user = await signup(ctx);
    await ctx
      .http()
      .patch('/v1/workspace/settings')
      .set(auth(user))
      .send({ quantityUnits: ['তোলা'] })
      .expect(200);

    /* A fresh signup has the seeded categories but no accounts — the first one
       is the point of the first-run card, not something signup creates. */
    const account = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'নগদ', type: 'CASH', openingBalance: 100_000 })
      .expect(201);
    const categories = await ctx
      .http()
      .get('/v1/categories?kind=EXPENSE')
      .set(auth(user))
      .expect(200);
    const accountId = account.body.id;
    const categoryId = categories.body[0].id;

    const txn = await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        type: 'EXPENSE',
        date: '2026-08-13',
        amountMinor: 45_000,
        accountId,
        categoryId,
        description: 'কাপড়',
        quantityMilli: 3_000,
        quantityUnit: 'তোলা',
      })
      .expect(201);

    await ctx
      .http()
      .patch('/v1/workspace/settings')
      .set(auth(user))
      .send({ quantityUnits: [] })
      .expect(200);

    /* The suggestion list is gone; the fact recorded in it is not. */
    const after = await ctx
      .http()
      .get(`/v1/transactions/${txn.body.id}`)
      .set(auth(user))
      .expect(200);
    expect(after.body.quantityUnit).toBe('তোলা');
    expect(after.body.quantityMilli).toBe(3_000);

    const report = await ctx
      .http()
      .get('/v1/reports/by-quantity?from=2026-08-01&to=2026-08-31')
      .set(auth(user))
      .expect(200);
    expect(report.body.units.some((row: { unit: string }) => row.unit === 'তোলা')).toBe(true);
  });

  it('requires a signed-in user', async () => {
    await ctx.http().get('/v1/workspace/settings').expect(401);
    await ctx.http().patch('/v1/workspace/settings').send({ quantityUnits: [] }).expect(401);
  });
});
