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
import { MAX_SMS_PER_DAY } from '../src/auth/email-token.service';

/**
 * Signing in with a code emailed to the address on the account.
 *
 * The code path itself — six digits, hashed at rest, five attempts, a cooldown
 * — is the one the verification and reset flows already use and already test.
 * What is asserted here is what is *different* about handing out a session
 * rather than a link: that the route cannot be used to find out who has an
 * account, that a code is single-use, and that the sign-in leaves a mark the
 * owner can find.
 */
describe('signing in with an emailed code', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  /**
   * Put a known code on the account.
   *
   * The real one only exists inside an email. Rather than brute-force six
   * digits — an earlier test did, and took thirty seconds — the row is written
   * with a hash of a code we choose, exactly as `issue()` would have.
   */
  const plantCode = async (userId: string, code: string): Promise<void> => {
    await ctx.prisma.emailToken.deleteMany({ where: { userId, purpose: 'SIGN_IN' } });
    await ctx.prisma.emailToken.create({
      data: {
        userId,
        purpose: 'SIGN_IN',
        tokenHash: createHash('sha256').update(`tok-${userId}-${code}`).digest('hex'),
        codeHash: createHash('sha256').update(code).digest('hex'),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
  };

  it('answers the same whether or not the address has an account', async () => {
    /* The whole point of the route. A different status, body or shape for a
       known address turns the form into a way of finding out who banks here. */
    const user = await signup(ctx);

    const known = await ctx
      .http()
      .post('/v1/auth/otp/request')
      .send({ email: user.email })
      .expect(200);
    const unknown = await ctx
      .http()
      .post('/v1/auth/otp/request')
      .send({ email: uniqueEmail('nobody') })
      .expect(200);

    expect(known.body).toEqual(unknown.body);
  });

  it('trades a valid code for a working session', async () => {
    const user = await signup(ctx);
    await plantCode(user.id, '123456');

    const res = await ctx
      .http()
      .post('/v1/auth/otp/verify')
      .send({ identifier: user.email, code: '123456' })
      .expect(200);

    expect(res.body.accessToken).toBeTruthy();

    /* Not just a token-shaped string — one the guard actually accepts. */
    const me = await ctx
      .http()
      .get('/v1/auth/me')
      .set({ Authorization: `Bearer ${res.body.accessToken}` })
      .expect(200);
    expect(me.body.email).toBe(user.email);
  });

  it('accepts a code pasted with the spaces a mail client adds', async () => {
    const user = await signup(ctx);
    await plantCode(user.id, '246810');
    await ctx
      .http()
      .post('/v1/auth/otp/verify')
      .send({ identifier: user.email, code: ' 246 810 ' })
      .expect(200);
  });

  it('burns the code, so the same one cannot be used twice', async () => {
    const user = await signup(ctx);
    await plantCode(user.id, '112233');

    await ctx
      .http()
      .post('/v1/auth/otp/verify')
      .send({ identifier: user.email, code: '112233' })
      .expect(200);
    await ctx
      .http()
      .post('/v1/auth/otp/verify')
      .send({ identifier: user.email, code: '112233' })
      .expect(401);
  });

  it('refuses an expired code', async () => {
    const user = await signup(ctx);
    await plantCode(user.id, '445566');
    await ctx.prisma.emailToken.updateMany({
      where: { userId: user.id, purpose: 'SIGN_IN' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await ctx
      .http()
      .post('/v1/auth/otp/verify')
      .send({ identifier: user.email, code: '445566' })
      .expect(401);
  });

  it('says the same thing for a wrong code and an unknown address', async () => {
    /* Otherwise the verify route gives back exactly the enumeration oracle the
       request route refuses to be. */
    const user = await signup(ctx);
    await plantCode(user.id, '778899');

    const wrong = await ctx
      .http()
      .post('/v1/auth/otp/verify')
      .send({ identifier: user.email, code: '000000' })
      .expect(401);
    const stranger = await ctx
      .http()
      .post('/v1/auth/otp/verify')
      .send({ identifier: uniqueEmail('nobody'), code: '000000' })
      .expect(401);

    expect(wrong.body.message).toBe(stranger.body.message);
  });

  it('burns the code after five wrong guesses', async () => {
    const user = await signup(ctx);
    await plantCode(user.id, '135790');

    for (let i = 0; i < 5; i += 1) {
      await ctx
        .http()
        .post('/v1/auth/otp/verify')
        .send({ identifier: user.email, code: '000000' })
        .expect(401);
    }

    /* Six digits is a million values, which is plenty against a person and not
       much against a script. This is the bound that makes a short numeric code
       safe to offer at all — so the *right* code stops working too. */
    await ctx
      .http()
      .post('/v1/auth/otp/verify')
      .send({ identifier: user.email, code: '135790' })
      .expect(401);
  });

  it('refuses a code issued for a different purpose', async () => {
    /* A verification code is mailed on signup and is worth far less than a
       session. If `SIGN_IN` accepted it, every new account would be one
       old email away from being signed into. */
    const user = await signup(ctx);
    await ctx.prisma.emailToken.deleteMany({ where: { userId: user.id } });
    await ctx.prisma.emailToken.create({
      data: {
        userId: user.id,
        purpose: 'VERIFY_EMAIL',
        tokenHash: createHash('sha256').update(`verify-${user.id}`).digest('hex'),
        codeHash: createHash('sha256').update('999111').digest('hex'),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });

    await ctx
      .http()
      .post('/v1/auth/otp/verify')
      .send({ identifier: user.email, code: '999111' })
      .expect(401);
  });

  it('leaves a mark the owner can find', async () => {
    /* The reason this is not filed as `auth.login`. Whoever can read the inbox
       could already have reset the password — but a reset stops the owner's own
       password working, and they notice. A code sign-in does not, so the
       activity log is the only place it shows up at all. */
    const user = await signup(ctx);
    await plantCode(user.id, '314159');
    await ctx
      .http()
      .post('/v1/auth/otp/verify')
      .send({ identifier: user.email, code: '314159' })
      .expect(200);

    const log = await ctx.http().get('/v1/audit?limit=50').set(auth(user)).expect(200);
    const actions = log.body.items.map((row: { action: string }) => row.action);
    expect(actions).toContain('auth.signin_code');
    /* And not disguised as an ordinary password login. */
    expect(actions).not.toContain('auth.login');
  });

  it('counts reading the code as proving the address', async () => {
    /* Typing back a code that was mailed to an address *is* the proof the
       verification flow asks for. Leaving the nag up would ask somebody to
       prove a thing they just proved. */
    const user = await signup(ctx);
    const before = await ctx.http().get('/v1/auth/me').set(auth(user)).expect(200);
    expect(before.body.emailVerifiedAt).toBeNull();

    await plantCode(user.id, '271828');
    const session = await ctx
      .http()
      .post('/v1/auth/otp/verify')
      .send({ identifier: user.email, code: '271828' })
      .expect(200);

    const after = await ctx
      .http()
      .get('/v1/auth/me')
      .set({ Authorization: `Bearer ${session.body.accessToken}` })
      .expect(200);
    expect(after.body.emailVerifiedAt).not.toBeNull();
  });

  it('refuses anything that is not six digits', async () => {
    const user = await signup(ctx);
    await ctx
      .http()
      .post('/v1/auth/otp/verify')
      .send({ identifier: user.email, code: '12345' })
      .expect(400);
    /* An identifier that is neither an email nor a BD mobile still gets the
       identical 200 — the route must not become a way of asking "is this a
       valid account shape here?" any more than "does this account exist?". */
    await ctx.http().post('/v1/auth/otp/request').send({ email: 'not-an-address' }).expect(200);
    await ctx.http().post('/v1/auth/otp/request').send({ email: '' }).expect(400);
  });

  it('sends by email unless a text is asked for', async () => {
    /* Not a preference — a cost. Email is free and unmetered; a text costs
       money per message and lands on a lock screen. A caller that says nothing
       must never be charged for one. */
    const user = await signup(ctx);
    await ctx.http().post('/v1/auth/otp/request').send({ identifier: user.email }).expect(200);

    const rows = await ctx.prisma.emailToken.findMany({
      where: { userId: user.id, purpose: 'SIGN_IN' },
      select: { channel: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channel).toBe('EMAIL');
  });

  it('never sends a text when no gateway is configured', async () => {
    /* The suite sets no `SMS_API_KEY`. Asking for a text must then be a silent
       no-op rather than an error, so the screen behaves the same whether or not
       the operator has bought a gateway. */
    const user = await signup(ctx);
    await ctx
      .http()
      .post('/v1/auth/otp/request')
      .send({ identifier: user.email, channel: 'sms' })
      .expect(200);

    const count = await ctx.prisma.emailToken.count({
      where: { userId: user.id, channel: 'SMS' },
    });
    expect(count).toBe(0);
  });

  it('caps texts at three a day, counted from what was issued', async () => {
    /* The ceiling protects the account holder's evening as much as the bill: a
       script pointed at somebody's number must not be able to keep their phone
       buzzing. Counted from the rows actually issued, so the number cannot
       drift away from what was sent. */
    const user = await signup(ctx);
    for (let i = 0; i < MAX_SMS_PER_DAY; i += 1) {
      await ctx.prisma.emailToken.create({
        data: {
          userId: user.id,
          purpose: 'SIGN_IN',
          channel: 'SMS',
          tokenHash: createHash('sha256').update(`sms-${user.id}-${i}`).digest('hex'),
          codeHash: createHash('sha256').update(`00000${i}`).digest('hex'),
          expiresAt: new Date(Date.now() + 10 * 60_000),
        },
      });
    }

    await ctx
      .http()
      .post('/v1/auth/otp/request')
      .send({ identifier: user.email, channel: 'sms' })
      .expect(200);

    const count = await ctx.prisma.emailToken.count({
      where: { userId: user.id, channel: 'SMS' },
    });
    expect(count).toBe(MAX_SMS_PER_DAY);
  });

  it('finds the account by mobile number as well as by email', async () => {
    const user = await signup(ctx);
    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    await ctx.http().post('/v1/auth/otp/request').send({ identifier: row.phone }).expect(200);
    const issued = await ctx.prisma.emailToken.count({
      where: { userId: user.id, purpose: 'SIGN_IN' },
    });
    expect(issued).toBe(1);
  });
});
