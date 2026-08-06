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

    const userId = res.body.user.id as string;
    const categories = await ctx.prisma.category.count({ where: { userId } });
    expect(categories).toBeGreaterThanOrEqual(20);

    const systemAccounts = await ctx.prisma.account.count({
      where: { userId, systemKey: { not: null } },
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
});
