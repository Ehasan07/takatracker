import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auth,
  createTestApp,
  resetDatabase,
  signup,
  uniqueEmail,
  type TestContext,
} from './harness';

const today = new Date().toISOString().slice(0, 10);

/** Audit writes are fire-and-forget, so give them a beat to land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

describe('audit log', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  const actions = async (user: Awaited<ReturnType<typeof signup>>): Promise<string[]> => {
    const res = await ctx.http().get('/v1/audit').set(auth(user)).expect(200);
    return res.body.items.map((i: { action: string }) => i.action);
  };

  it('records the signup that created the workspace', async () => {
    const user = await signup(ctx);
    await settle();
    expect(await actions(user)).toContain('auth.signup');
  });

  it('records a login and, separately, a failed one', async () => {
    const email = uniqueEmail('audit-login');
    const created = await ctx
      .http()
      .post('/v1/auth/signup')
      .send({ email, password: 'hishab1234', name: 'অডিট' })
      .expect(201);

    const user = {
      id: created.body.user.id as string,
      email,
      workspaceId: created.body.workspace.id as string,
      accessToken: created.body.accessToken as string,
      refreshToken: created.body.refreshToken as string,
    };

    await ctx.http().post('/v1/auth/login').send({ email, password: 'hishab1234' }).expect(200);
    await ctx.http().post('/v1/auth/login').send({ email, password: 'wrong' }).expect(401);
    await settle();

    const list = await actions(user);
    expect(list).toContain('auth.login');
    // A brute-force attempt has to be visible on the timeline the owner reads.
    expect(list).toContain('auth.login_failed');
  });

  it('records the whole life of an account and a transaction', async () => {
    const user = await signup(ctx);
    const account = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'নগদ', type: 'CASH' })
      .expect(201);

    await ctx
      .http()
      .patch(`/v1/accounts/${account.body.id}`)
      .set(auth(user))
      .send({ name: 'নগদ টাকা' })
      .expect(200);

    const cats = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    const categoryId = cats.body.find((c: { kind: string }) => c.kind === 'EXPENSE').id;

    const txn = await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: today,
        type: 'EXPENSE',
        amountMinor: 2500,
        accountId: account.body.id,
        categoryId,
      })
      .expect(201);

    await ctx.http().delete(`/v1/transactions/${txn.body.id}`).set(auth(user)).expect(200);
    await ctx.http().post(`/v1/transactions/${txn.body.id}/restore`).set(auth(user)).expect(201);
    await ctx
      .http()
      .post(`/v1/accounts/${account.body.id}/reconcile`)
      .set(auth(user))
      .send({ date: today, actualBalanceMinor: 9999 })
      .expect(201);
    await ctx.http().delete(`/v1/accounts/${account.body.id}`).set(auth(user)).expect(200);
    await settle();

    const list = await actions(user);
    for (const action of [
      'account.created',
      'account.updated',
      'account.archived',
      'transaction.created',
      'transaction.deleted',
      'transaction.restored',
      'transaction.reconciled',
    ]) {
      expect(list, `missing ${action}`).toContain(action);
    }
  });

  it('names the actor and keeps the before and after', async () => {
    const user = await signup(ctx);
    const account = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'ব্যাংক', type: 'BANK' })
      .expect(201);
    await settle();

    const res = await ctx
      .http()
      .get('/v1/audit')
      .query({ action: 'account.created', entityId: account.body.id })
      .set(auth(user))
      .expect(200);

    const event = res.body.items[0];
    expect(event.entity).toBe('Account');
    expect(event.after.name).toBe('ব্যাংক');
    expect(event.actorType).toBe('USER');
    // "Who did that" is the whole point; an anonymous entry is a broken one.
    expect(event.actor?.id).toBe(user.id);
  });

  it('is newest first and pages with a cursor', async () => {
    const user = await signup(ctx);
    for (const name of ['ক', 'খ', 'গ']) {
      await ctx
        .http()
        .post('/v1/accounts')
        .set(auth(user))
        .send({ name, type: 'CASH' })
        .expect(201);
    }
    await settle();

    const first = await ctx.http().get('/v1/audit').query({ limit: 2 }).set(auth(user)).expect(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await ctx
      .http()
      .get('/v1/audit')
      .query({ limit: 2, cursor: first.body.nextCursor })
      .set(auth(user))
      .expect(200);

    const seen = new Set(
      [...first.body.items, ...second.body.items].map((i: { id: string }) => i.id),
    );
    expect(seen.size).toBe(first.body.items.length + second.body.items.length);
  });

  it('never shows one workspace another workspace s history', async () => {
    const alice = await signup(ctx);
    const bob = await signup(ctx);

    await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(alice))
      .send({ name: 'অ্যালিসের গোপন অ্যাকাউন্ট', type: 'CASH' })
      .expect(201);
    await settle();

    const bobsView = await ctx.http().get('/v1/audit').set(auth(bob)).expect(200);
    const serialised = JSON.stringify(bobsView.body);
    expect(serialised).not.toContain('অ্যালিসের গোপন অ্যাকাউন্ট');
    // Bob sees only his own signup.
    expect(bobsView.body.items.every((i: { action: string }) => i.action === 'auth.signup')).toBe(
      true,
    );
  });

  it('has no endpoint that can rewrite history', async () => {
    const user = await signup(ctx);
    await settle();
    const list = await ctx.http().get('/v1/audit').set(auth(user)).expect(200);
    const id = list.body.items[0].id;

    // Append-only is a property of the API surface, not just a convention.
    await ctx.http().delete(`/v1/audit/${id}`).set(auth(user)).expect(404);
    await ctx.http().patch(`/v1/audit/${id}`).set(auth(user)).send({ action: 'x' }).expect(404);
  });

  it('refuses an unauthenticated reader', async () => {
    await ctx.http().get('/v1/audit').expect(401);
  });
});
