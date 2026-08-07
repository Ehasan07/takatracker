import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auth,
  createTestApp,
  resetDatabase,
  signup,
  type SignedUpUser,
  type TestContext,
} from './harness';

const today = new Date().toISOString().slice(0, 10);

/** Narrow one feature for one workspace, the way support or a downgrade would. */
async function setLimit(
  ctx: TestContext,
  workspaceId: string,
  featureKey: string,
  limitValue: number | null,
  expiresAt?: Date,
): Promise<void> {
  await ctx.prisma.workspaceFeatureOverride.upsert({
    where: { workspaceId_featureKey: { workspaceId, featureKey } },
    create: { workspaceId, featureKey, limitValue, expiresAt },
    update: { limitValue, expiresAt: expiresAt ?? null },
  });
}

const addAccount = (ctx: TestContext, user: SignedUpUser, name: string) =>
  ctx.http().post('/v1/accounts').set(auth(user)).send({ name, type: 'CASH' });

describe('entitlements', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('puts every new workspace on the free plan', async () => {
    const user = await signup(ctx);
    const res = await ctx.http().get('/v1/entitlements').set(auth(user)).expect(200);

    expect(res.body.plan.code).toBe('FREE');
    expect(res.body.entitlements['accounts.max']).toBe(5);
    expect(res.body.entitlements['export.enabled']).toBe(0);
    // Three system accounts exist but are hidden, and must not eat the quota.
    expect(res.body.usage['accounts.max']).toBe(0);
    expect(res.body.remaining['accounts.max']).toBe(5);
  });

  it('publishes the plan comparison from the same definition it enforces', async () => {
    const user = await signup(ctx);
    const res = await ctx.http().get('/v1/entitlements/plans').set(auth(user)).expect(200);
    const codes = res.body.map((p: { code: string }) => p.code);
    expect(codes).toContain('FREE');
    expect(codes).toContain('PRO');

    // v3 §B2: no public plan may ever unlock the SMS channel.
    for (const plan of res.body) {
      const sms = plan.features.find((f: { key: string }) => f.key === 'sms.channel');
      expect(sms.limitValue).toBe(0);
    }
  });

  /** The milestone's acceptance criterion: a downgrade visibly restricts. */
  it('refuses the account over the limit with a 402 that says what to do', async () => {
    const user = await signup(ctx);
    await setLimit(ctx, user.workspaceId, 'accounts.max', 2);

    await addAccount(ctx, user, 'নগদ').expect(201);
    await addAccount(ctx, user, 'ব্যাংক').expect(201);

    const blocked = await addAccount(ctx, user, 'বিকাশ').expect(402);
    expect(blocked.body.featureKey).toBe('accounts.max');
    expect(blocked.body.limit).toBe(2);
    expect(blocked.body.used).toBe(2);
    expect(blocked.body.upgradeUrl).toContain('http');
    expect(blocked.body.message).toContain('আপগ্রেড');

    // The snapshot agrees with the refusal, so the UI can grey the button out
    // rather than letting the user discover the wall by hitting it.
    const snapshot = await ctx.http().get('/v1/entitlements').set(auth(user)).expect(200);
    expect(snapshot.body.remaining['accounts.max']).toBe(0);
  });

  it('lets the same request through once the limit is raised', async () => {
    const user = await signup(ctx);
    await setLimit(ctx, user.workspaceId, 'accounts.max', 1);
    await addAccount(ctx, user, 'নগদ').expect(201);
    await addAccount(ctx, user, 'ব্যাংক').expect(402);

    await setLimit(ctx, user.workspaceId, 'accounts.max', null); // unlimited
    await addAccount(ctx, user, 'ব্যাংক').expect(201);
  });

  it('frees a slot when an account is archived rather than deleted', async () => {
    const user = await signup(ctx);
    await setLimit(ctx, user.workspaceId, 'accounts.max', 1);

    const first = await addAccount(ctx, user, 'নগদ').expect(201);
    await addAccount(ctx, user, 'ব্যাংক').expect(402);

    await ctx.http().delete(`/v1/accounts/${first.body.id}`).set(auth(user)).expect(200);

    // Archiving keeps the history and returns the quota.
    await addAccount(ctx, user, 'ব্যাংক').expect(201);
  });

  it('stops honouring an override once it expires, falling back to the plan', async () => {
    const user = await signup(ctx);
    const limitNow = async (): Promise<number | null> => {
      const res = await ctx.http().get('/v1/entitlements').set(auth(user)).expect(200);
      return res.body.entitlements['accounts.max'];
    };

    expect(await limitNow()).toBe(5); // the FREE plan

    await setLimit(ctx, user.workspaceId, 'accounts.max', 20, new Date(Date.now() + 3_600_000));
    expect(await limitNow()).toBe(20);

    // An expired grant lapses on its own — no job has to clean it up.
    await setLimit(ctx, user.workspaceId, 'accounts.max', 20, new Date(Date.now() - 1_000));
    expect(await limitNow()).toBe(5);
  });

  it('enforces the plan ceiling once an override lapses', async () => {
    const user = await signup(ctx);
    await setLimit(ctx, user.workspaceId, 'accounts.max', 2, new Date(Date.now() - 1_000));
    await setLimit(ctx, user.workspaceId, 'accounts.max', 1, new Date(Date.now() - 1_000));

    // Back on FREE's five, so five succeed and the sixth does not.
    for (const name of ['ক', 'খ', 'গ', 'ঘ', 'ঙ']) {
      await addAccount(ctx, user, name).expect(201);
    }
    const blocked = await addAccount(ctx, user, 'চ').expect(402);
    expect(blocked.body.limit).toBe(5);
  });

  it('meters transactions by the month and still allows edits at the ceiling', async () => {
    const user = await signup(ctx);
    const account = await addAccount(ctx, user, 'নগদ').expect(201);
    const cats = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    const categoryId = cats.body.find((c: { kind: string }) => c.kind === 'EXPENSE').id;

    const post = (amountMinor: number) =>
      ctx.http().post('/v1/transactions').set(auth(user)).send({
        date: today,
        type: 'EXPENSE',
        amountMinor,
        accountId: account.body.id,
        categoryId,
      });

    await setLimit(ctx, user.workspaceId, 'transactions.monthly.max', 1);

    const first = await post(1000).expect(201);
    const blocked = await post(2000).expect(402);
    expect(blocked.body.featureKey).toBe('transactions.monthly.max');

    // Correcting the books must never be paywalled.
    await ctx
      .http()
      .patch(`/v1/transactions/${first.body.id}`)
      .set(auth(user))
      .send({
        date: today,
        type: 'EXPENSE',
        amountMinor: 1500,
        accountId: account.body.id,
        categoryId,
      })
      .expect(200);

    await ctx.http().delete(`/v1/transactions/${first.body.id}`).set(auth(user)).expect(200);
    await ctx.http().post(`/v1/transactions/${first.body.id}/restore`).set(auth(user)).expect(201);
  });

  it('keeps limits per workspace', async () => {
    const restricted = await signup(ctx);
    const roomy = await signup(ctx);

    await setLimit(ctx, restricted.workspaceId, 'accounts.max', 1);
    await addAccount(ctx, restricted, 'নগদ').expect(201);
    await addAccount(ctx, restricted, 'ব্যাংক').expect(402);

    // The neighbour is untouched by someone else's downgrade.
    for (const name of ['নগদ', 'ব্যাংক', 'বিকাশ']) {
      await addAccount(ctx, roomy, name).expect(201);
    }
  });
});
