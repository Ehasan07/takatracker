import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, createTestApp, resetDatabase, signup, type TestContext } from './harness';

/**
 * A workspace's corrections to the interface's wording.
 *
 * The shipped strings are a starting point. The English half was written by
 * people whose first language it is not, and no wording survives contact with
 * what a particular household actually calls things — so the test that matters
 * is that a correction sticks, is private to the workspace that made it, and
 * can be taken back.
 */
describe('wording overrides', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('starts empty, keeps what you set, and puts it back when you clear it', async () => {
    const user = await signup(ctx);

    // Nobody has changed anything, so the client fetches nothing to merge.
    const empty = await ctx.http().get('/v1/translations?locale=en').set(auth(user)).expect(200);
    expect(empty.body).toEqual({});

    await ctx
      .http()
      .put('/v1/translations/nav.accounts')
      .set(auth(user))
      .send({ locale: 'en', value: 'Wallets' })
      .expect(200);

    const set = await ctx.http().get('/v1/translations?locale=en').set(auth(user)).expect(200);
    expect(set.body['nav.accounts']).toBe('Wallets');

    /* A correction is per language: fixing the English must not silently
       rewrite the Bengali the same key renders in. */
    const bengali = await ctx.http().get('/v1/translations?locale=bn').set(auth(user)).expect(200);
    expect(bengali.body['nav.accounts']).toBeUndefined();

    /* Empty clears rather than storing a blank — "put it back to what it said"
       is the common second act of editing a string, and a stored empty string
       would render the interface with a hole in it. */
    await ctx
      .http()
      .put('/v1/translations/nav.accounts')
      .set(auth(user))
      .send({ locale: 'en', value: '' })
      .expect(200);
    const cleared = await ctx.http().get('/v1/translations?locale=en').set(auth(user)).expect(200);
    expect(cleared.body).toEqual({});
  });

  it('keeps one workspace’s wording out of another’s', async () => {
    const mine = await signup(ctx);
    const theirs = await signup(ctx);

    await ctx
      .http()
      .put('/v1/translations/nav.loans')
      .set(auth(mine))
      .send({ locale: 'bn', value: 'ধার-দেনা' })
      .expect(200);

    const neighbour = await ctx
      .http()
      .get('/v1/translations?locale=bn')
      .set(auth(theirs))
      .expect(200);
    expect(neighbour.body).toEqual({});
  });

  it('refuses an unsupported language and an over-long value', async () => {
    const user = await signup(ctx);
    await ctx
      .http()
      .put('/v1/translations/nav.loans')
      .set(auth(user))
      .send({ locale: 'fr', value: 'Prêts' })
      .expect(400);
    await ctx
      .http()
      .put('/v1/translations/nav.loans')
      .set(auth(user))
      .send({ locale: 'bn', value: 'ক'.repeat(501) })
      .expect(400);
  });

  it('records a wording change on the workspace’s own timeline', async () => {
    const user = await signup(ctx);
    await ctx
      .http()
      .put('/v1/translations/dashboard.title')
      .set(auth(user))
      .send({ locale: 'bn', value: 'আমার খাতা' })
      .expect(200);

    await new Promise((resolve) => setTimeout(resolve, 250));
    const audit = await ctx.http().get('/v1/audit').set(auth(user)).expect(200);
    expect(audit.body.items.map((r: { action: string }) => r.action)).toContain(
      'translation.changed',
    );
  });
});
