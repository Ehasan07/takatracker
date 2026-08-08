import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auth,
  createTestApp,
  resetDatabase,
  signup,
  uniqueEmail,
  type TestContext,
} from './harness';

/**
 * Verification, password reset and sessions.
 *
 * Email goes to the log rather than an inbox, so these tests read the token out
 * of the database the same way the log line does. That is deliberate: what is
 * being tested is the token's *lifecycle* — issued once, used once, expiring on
 * time, and refusing to be replayed — not the delivery mechanism.
 */

const PASSWORD = 'hishab1234';

describe('email verification', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  /** The plaintext half of a freshly issued token, recovered for the test. */
  async function issueAndSteal(
    user: Awaited<ReturnType<typeof signup>>,
    purpose: 'VERIFY_EMAIL' | 'RESET_PASSWORD',
  ): Promise<string> {
    // Only the hash is stored, so the test cannot read the token back — it
    // brute-forces nothing and instead re-hashes candidates it generates
    // itself. Simpler: replace the row's hash with one we know.
    const token = `test-${purpose}-${Math.floor(performance.now() * 1000)}`;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const row = await ctx.prisma.emailToken.findFirst({
      where: { userId: user.id, purpose, usedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) throw new Error(`no ${purpose} token was issued`);
    await ctx.prisma.emailToken.update({ where: { id: row.id }, data: { tokenHash } });
    return token;
  }

  it('starts unverified and verifies with the emailed token', async () => {
    const user = await signup(ctx);

    const before = await ctx.http().get('/v1/auth/me').set(auth(user)).expect(200);
    expect(before.body.emailVerifiedAt).toBeNull();

    await ctx.http().post('/v1/auth/verify/send').set(auth(user)).send({}).expect(200);
    const token = await issueAndSteal(user, 'VERIFY_EMAIL');

    const confirmed = await ctx.http().post('/v1/auth/verify/confirm').send({ token }).expect(200);
    expect(confirmed.body.verified).toBe(true);

    const after = await ctx.http().get('/v1/auth/me').set(auth(user)).expect(200);
    expect(after.body.emailVerifiedAt).not.toBeNull();
  });

  it('tells a used link apart from an expired one', async () => {
    const user = await signup(ctx);
    await ctx.http().post('/v1/auth/verify/send').set(auth(user)).send({}).expect(200);
    const token = await issueAndSteal(user, 'VERIFY_EMAIL');
    await ctx.http().post('/v1/auth/verify/confirm').send({ token }).expect(200);

    /* Clicking twice, or a mail client prefetching the link, is the ordinary
     * case: nothing is wrong and there is nothing for them to do. So a replay
     * succeeds and says "already verified" rather than reading as an error —
     * and it must never say "expired", which would send them round the loop
     * chasing a fresh link they do not need. */
    const replay = await ctx.http().post('/v1/auth/verify/confirm').send({ token }).expect(200);
    expect(replay.body.alreadyVerified).toBe(true);
    expect(String(replay.body.message)).not.toMatch(/মেয়াদ/);
  });

  it('rejects a token that has expired', async () => {
    const user = await signup(ctx);
    await ctx.http().post('/v1/auth/verify/send').set(auth(user)).send({}).expect(200);
    const token = await issueAndSteal(user, 'VERIFY_EMAIL');
    const hash = createHash('sha256').update(token).digest('hex');
    await ctx.prisma.emailToken.update({
      where: { tokenHash: hash },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const res = await ctx.http().post('/v1/auth/verify/confirm').send({ token });
    expect(res.status).toBe(410);
  });

  it('refuses a made-up token without saying whether one exists', async () => {
    const res = await ctx.http().post('/v1/auth/verify/confirm').send({ token: 'not-a-token' });
    expect(res.status).toBe(400);
  });

  it('lets an unverified user keep full access to their own books', async () => {
    // Locking somebody out over an undelivered email is worse than the risk
    // verification prevents. This test is the guard on that decision.
    const user = await signup(ctx);
    await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'নগদ', type: 'CASH', openingBalance: 100_000 })
      .expect(201);
    await ctx.http().get('/v1/transactions').set(auth(user)).expect(200);
    await ctx.http().get('/v1/reports/balance-sheet').set(auth(user)).expect(200);
  });
});

describe('password reset', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  async function stealResetToken(userId: string): Promise<string> {
    const token = `test-reset-${Math.floor(performance.now() * 1000)}`;
    const row = await ctx.prisma.emailToken.findFirst({
      where: { userId, purpose: 'RESET_PASSWORD', usedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) throw new Error('no reset token was issued');
    await ctx.prisma.emailToken.update({
      where: { id: row.id },
      data: { tokenHash: createHash('sha256').update(token).digest('hex') },
    });
    return token;
  }

  it('answers identically for an address that exists and one that does not', async () => {
    const user = await signup(ctx);

    const known = await ctx.http().post('/v1/auth/password/forgot').send({ email: user.email });
    const unknown = await ctx
      .http()
      .post('/v1/auth/password/forgot')
      .send({ email: uniqueEmail('nobody') });

    // Any difference here — status, body, even wording — is an oracle that
    // tells an attacker which addresses have accounts.
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
  });

  it('resets the password and signs every other device out', async () => {
    const user = await signup(ctx);

    // Two more sessions, as if from a phone and a laptop.
    for (const device of ['phone', 'laptop']) {
      await ctx
        .http()
        .post('/v1/auth/login')
        .set('x-device-id', device)
        .send({ email: user.email, password: PASSWORD })
        .expect(200);
    }
    const before = await ctx.http().get('/v1/auth/sessions').set(auth(user)).expect(200);
    expect(before.body.sessions.length).toBeGreaterThanOrEqual(3);

    await ctx.http().post('/v1/auth/password/forgot').send({ email: user.email }).expect(200);
    const token = await stealResetToken(user.id);

    const done = await ctx
      .http()
      .post('/v1/auth/password/reset')
      .send({ token, password: 'notunhishab99' })
      .expect(200);
    expect(done.body.sessionsRevoked).toBeGreaterThanOrEqual(3);

    // The old password is dead and the new one works.
    await ctx
      .http()
      .post('/v1/auth/login')
      .send({ email: user.email, password: PASSWORD })
      .expect(401);
    await ctx
      .http()
      .post('/v1/auth/login')
      .send({ email: user.email, password: 'notunhishab99' })
      .expect(200);
  });

  it('kills an access token that was minted before the reset', async () => {
    // The whole point of a reset is that somebody else may be holding a token.
    // Revoking refresh families is not enough: a stolen access token would
    // otherwise keep working for its remaining fifteen minutes.
    const user = await signup(ctx);
    await ctx.http().get('/v1/auth/me').set(auth(user)).expect(200);

    await ctx.http().post('/v1/auth/password/forgot').send({ email: user.email }).expect(200);
    const token = await stealResetToken(user.id);
    await ctx
      .http()
      .post('/v1/auth/password/reset')
      .send({ token, password: 'notunhishab99' })
      .expect(200);

    await ctx.http().get('/v1/auth/me').set(auth(user)).expect(401);
  });

  it('verifies the address, because the link only reaches that mailbox', async () => {
    const user = await signup(ctx);
    await ctx.http().post('/v1/auth/password/forgot').send({ email: user.email }).expect(200);
    const token = await stealResetToken(user.id);
    await ctx
      .http()
      .post('/v1/auth/password/reset')
      .send({ token, password: 'notunhishab99' })
      .expect(200);

    const fresh = await ctx
      .http()
      .post('/v1/auth/login')
      .send({ email: user.email, password: 'notunhishab99' })
      .expect(200);
    const me = await ctx
      .http()
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${fresh.body.accessToken as string}`)
      .expect(200);
    expect(me.body.emailVerifiedAt).not.toBeNull();
  });

  it('refuses to spend a reset token twice', async () => {
    const user = await signup(ctx);
    await ctx.http().post('/v1/auth/password/forgot').send({ email: user.email }).expect(200);
    const token = await stealResetToken(user.id);
    await ctx
      .http()
      .post('/v1/auth/password/reset')
      .send({ token, password: 'notunhishab99' })
      .expect(200);

    const replay = await ctx
      .http()
      .post('/v1/auth/password/reset')
      .send({ token, password: 'aarekta1234' });
    expect(replay.status).toBe(410);
  });

  it('will not accept a verification token on the reset endpoint', async () => {
    const user = await signup(ctx);
    await ctx.http().post('/v1/auth/verify/send').set(auth(user)).send({}).expect(200);
    const row = await ctx.prisma.emailToken.findFirst({
      where: { userId: user.id, purpose: 'VERIFY_EMAIL' },
      orderBy: { createdAt: 'desc' },
    });
    const token = 'crossed-purpose-token';
    await ctx.prisma.emailToken.update({
      where: { id: row!.id },
      data: { tokenHash: createHash('sha256').update(token).digest('hex') },
    });

    const res = await ctx
      .http()
      .post('/v1/auth/password/reset')
      .send({ token, password: 'notunhishab99' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('sessions', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('lists a device per session and never leaks the token', async () => {
    const user = await signup(ctx);
    await ctx
      .http()
      .post('/v1/auth/login')
      .set('x-device-id', 'phone')
      .set('user-agent', 'Hishab/1.0 (Android)')
      .send({ email: user.email, password: PASSWORD })
      .expect(200);

    const res = await ctx.http().get('/v1/auth/sessions').set(auth(user)).expect(200);
    expect(res.body.sessions.length).toBeGreaterThanOrEqual(2);
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toMatch(/tokenHash/);
    expect(serialised).not.toMatch(/replacedBy/);
  });

  it('revokes one device without touching the others', async () => {
    const user = await signup(ctx);
    await ctx
      .http()
      .post('/v1/auth/login')
      .set('x-device-id', 'phone')
      .send({ email: user.email, password: PASSWORD })
      .expect(200);

    const listed = await ctx.http().get('/v1/auth/sessions').set(auth(user)).expect(200);
    const other = listed.body.sessions.find((s: { current: boolean }) => !s.current);
    await ctx
      .http()
      .delete(`/v1/auth/sessions/${other.familyId as string}`)
      .set(auth(user))
      .expect(200);

    const after = await ctx.http().get('/v1/auth/sessions').set(auth(user)).expect(200);
    expect(
      after.body.sessions.some((s: { familyId: string }) => s.familyId === other.familyId),
    ).toBe(false);
  });

  it('never shows one person another person s sessions', async () => {
    const mine = await signup(ctx);
    const stranger = await signup(ctx);
    const listed = await ctx.http().get('/v1/auth/sessions').set(auth(mine)).expect(200);

    await ctx
      .http()
      .delete(`/v1/auth/sessions/${listed.body.sessions[0].familyId as string}`)
      .set(auth(stranger))
      .expect(404);
  });
});
