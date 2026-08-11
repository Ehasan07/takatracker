import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, resetDatabase, signup, uniqueEmail, type TestContext } from './harness';

describe('auth', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('remembers the language and the currency chosen at signup', async () => {
    const email = uniqueEmail();
    const res = await ctx
      .http()
      .post('/v1/auth/signup')
      .send({ email, password: 'hishab1234', name: 'Yen User', locale: 'en', currency: 'JPY' })
      .expect(201);

    const me = await ctx
      .http()
      .get('/v1/auth/me')
      .set({ Authorization: `Bearer ${res.body.accessToken}` })
      .expect(200);

    /* The currency is a property of the ledger, not a display preference: it
       decides how many minor units a stored integer represents. A yen has
       none, so 500 means ¥500 — under the old hardcoded 100 it would have
       rendered as ¥5. */
    expect(me.body.workspace.currency).toBe('JPY');
    expect(me.body.workspace.locale).toBe('en');
  });

  it('refuses a currency the catalogue has never heard of', async () => {
    /* Not pedantry. An unknown code would be stored, silently fall back to
       taka's 100 at render time, and make every figure in that workspace wrong
       by a factor nobody could see. */
    await ctx
      .http()
      .post('/v1/auth/signup')
      .send({ email: uniqueEmail(), password: 'hishab1234', name: 'x', currency: 'ZZZ' })
      .expect(400);
  });

  it('defaults to taka and Bangla when neither is given', async () => {
    const res = await ctx
      .http()
      .post('/v1/auth/signup')
      .send({ email: uniqueEmail(), password: 'hishab1234', name: 'x' })
      .expect(201);
    const me = await ctx
      .http()
      .get('/v1/auth/me')
      .set({ Authorization: `Bearer ${res.body.accessToken}` })
      .expect(200);
    expect(me.body.workspace.currency).toBe('BDT');
    expect(me.body.workspace.locale).toBe('bn');
  });

  it('signs up, seeds categories and system accounts, and returns tokens', async () => {
    const email = uniqueEmail('signup');
    const res = await ctx
      .http()
      .post('/v1/auth/signup')
      .send({ email, password: 'hishab1234', name: 'রহিম' })
      .expect(201);

    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.email).toBe(email);

    // Signup creates the tenant, not just the person.
    const workspaceId = res.body.workspace.id as string;
    const userId = res.body.user.id as string;
    expect(workspaceId).toBeTruthy();
    expect(res.body.workspace.currency).toBe('BDT');

    const membership = await ctx.prisma.membership.findUniqueOrThrow({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    expect(membership.role).toBe('OWNER');
    expect(membership.status).toBe('ACTIVE');

    const categories = await ctx.prisma.category.count({ where: { workspaceId } });
    expect(categories).toBeGreaterThanOrEqual(20);

    const systemAccounts = await ctx.prisma.account.count({
      where: { workspaceId, systemKey: { not: null } },
    });
    expect(systemAccounts).toBe(3);
  });

  it('rejects a duplicate email', async () => {
    const email = uniqueEmail('dupe');
    await ctx
      .http()
      .post('/v1/auth/signup')
      .send({ email, password: 'hishab1234', name: 'করিম' })
      .expect(201);
    await ctx
      .http()
      .post('/v1/auth/signup')
      .send({ email, password: 'hishab1234', name: 'করিম' })
      .expect(409);
  });

  it('rejects a short password before touching the database', async () => {
    await ctx
      .http()
      .post('/v1/auth/signup')
      .send({ email: uniqueEmail('short'), password: 'abc', name: 'ক' })
      .expect(400);
  });

  it('logs in and rejects a wrong password', async () => {
    const email = uniqueEmail('login');
    await ctx
      .http()
      .post('/v1/auth/signup')
      .send({ email, password: 'hishab1234', name: 'সালমা' })
      .expect(201);

    await ctx.http().post('/v1/auth/login').send({ email, password: 'hishab1234' }).expect(200);
    await ctx.http().post('/v1/auth/login').send({ email, password: 'wrong-one' }).expect(401);
  });

  it('never returns the password hash', async () => {
    const user = await signup(ctx);
    const res = await ctx
      .http()
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    expect(JSON.stringify(res.body)).not.toContain('$argon2');
    expect(res.body.passwordHash).toBeUndefined();
  });

  it('rotates refresh tokens and revokes the family when one is replayed', async () => {
    const user = await signup(ctx);

    const first = await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: user.refreshToken })
      .expect(200);
    const rotated = first.body.refreshToken as string;
    expect(rotated).not.toBe(user.refreshToken);

    // Replaying the original token is the stolen-token signal.
    await ctx.http().post('/v1/auth/refresh').send({ refreshToken: user.refreshToken }).expect(401);

    // …and it takes the whole family down with it.
    await ctx.http().post('/v1/auth/refresh').send({ refreshToken: rotated }).expect(401);
  });

  it('refuses unauthenticated access to /me', async () => {
    await ctx.http().get('/v1/auth/me').expect(401);
  });

  it('returns the active workspace and role from /me', async () => {
    const user = await signup(ctx);
    const res = await ctx
      .http()
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    expect(res.body.workspace.id).toBe(user.workspaceId);
    expect(res.body.role).toBe('OWNER');
  });

  /* A signed token is not enough. Suspending a membership must lock the session
   * out on the next request, not fifteen minutes later when the token expires. */
  it('rejects a valid token once the membership is suspended', async () => {
    const user = await signup(ctx);
    await ctx
      .http()
      .get('/v1/accounts')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    await ctx.prisma.membership.update({
      where: { workspaceId_userId: { workspaceId: user.workspaceId, userId: user.id } },
      data: { status: 'SUSPENDED' },
    });

    await ctx
      .http()
      .get('/v1/accounts')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(401);
  });

  it('rejects a valid token once the workspace is suspended', async () => {
    const user = await signup(ctx);
    await ctx.prisma.workspace.update({
      where: { id: user.workspaceId },
      data: { status: 'SUSPENDED' },
    });
    await ctx
      .http()
      .get('/v1/accounts')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(401);
  });
});
