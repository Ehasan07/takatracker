import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auth,
  createTestApp,
  resetDatabase,
  signup,
  uniqueEmail,
  type TestContext,
} from './harness';

describe('auth', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  /**
   * Verification by six digits.
   *
   * The code is read out of the database rather than an inbox because there is
   * no SMTP host configured in test (or, today, in production) — the mail
   * service writes to the log. What is being tested is the exchange, not the
   * delivery.
   */
  describe('email verification by code', () => {
    /**
     * Plant a known code on the newest outstanding token.
     *
     * The plaintext never leaves `issue()` — that is the point of hashing it —
     * so a test either brute-forces a million candidates against the stored
     * hash (a million queries; it timed out) or writes a hash it already knows.
     * What is under test is the exchange and the attempt cap, not the RNG,
     * which has its own assertion below.
     */
    /**
     * The verification token signup issues.
     *
     * Polled, because `AuthService.signup` sends the mail fire-and-forget: an
     * SMTP host that is slow or down must not slow down or fail a signup, so
     * the row appears a moment after the response. Waiting for it here is the
     * test acknowledging that design rather than working around it.
     */
    const awaitToken = async (userId: string) => {
      for (let i = 0; i < 50; i += 1) {
        const row = await ctx.prisma.emailToken.findFirst({
          where: { userId, purpose: 'VERIFY_EMAIL' },
          orderBy: { createdAt: 'desc' },
        });
        if (row) return row;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('signup never issued a verification token');
    };

    const plantCode = async (userId: string, code: string): Promise<string> => {
      const { createHash } = await import('node:crypto');
      const row = await awaitToken(userId);
      await ctx.prisma.emailToken.update({
        where: { id: row.id },
        data: { codeHash: createHash('sha256').update(code).digest('hex') },
      });
      return code;
    };

    it('verifies with the digits from the email', async () => {
      /* No `verify/send` call: signing up already issues one and mails it, and
         a second request inside the minute is refused by the resend cooldown.
         That is the real flow — the code is in the inbox before the person has
         finished looking at the dashboard. */
      const user = await signup(ctx);

      const row = await awaitToken(user.id);
      expect(row.codeHash).toBeTruthy();

      // Typed the way a person types it: spaced, out of the email.
      const code = await plantCode(user.id, '042931');
      const res = await ctx
        .http()
        .post('/v1/auth/verify/code')
        .set(auth(user))
        .send({ code: `${code.slice(0, 3)} ${code.slice(3)}` })
        .expect(200);
      expect(res.body.verified).toBe(true);

      const me = await ctx.http().get('/v1/auth/me').set(auth(user)).expect(200);
      expect(me.body.emailVerifiedAt).toBeTruthy();
    });

    it('burns the code after five wrong guesses', async () => {
      const user = await signup(ctx);
      const code = await plantCode(user.id, '314159');
      const wrong = '000000';

      /* Six digits is a million values — plenty against a person, very little
         against a script. The cap is what makes a short numeric code safe to
         offer at all, so it is the assertion that matters most here. */
      for (let i = 0; i < 5; i += 1) {
        const res = await ctx
          .http()
          .post('/v1/auth/verify/code')
          .set(auth(user))
          .send({ code: wrong })
          .expect(400);
        expect(res.body.attemptsLeft).toBe(4 - i);
      }

      // Burnt: even the right code no longer works.
      const locked = await ctx
        .http()
        .post('/v1/auth/verify/code')
        .set(auth(user))
        .send({ code })
        .expect(400);
      expect(locked.body.code).toBe('CODE_LOCKED');

      const me = await ctx.http().get('/v1/auth/me').set(auth(user)).expect(200);
      expect(me.body.emailVerifiedAt).toBeNull();
    });

    it('refuses another account’s code, even though six digits collide', async () => {
      /* Six digits is a million values, so two accounts really do share a code
         from time to time. The lookup is therefore by user and never by hash —
         a hash lookup would occasionally hand back somebody else's row and
         verify the wrong address. */
      const owner = await signup(ctx);
      const code = await plantCode(owner.id, '271828');

      const neighbour = await signup(ctx);
      await plantCode(neighbour.id, code);
      await ctx.http().post('/v1/auth/verify/code').set(auth(neighbour)).send({ code }).expect(200);
      const theirs = await ctx.http().get('/v1/auth/me').set(auth(neighbour)).expect(200);
      // Their own row carries the same digits, so this must succeed for them…
      expect(theirs.body.emailVerifiedAt).toBeTruthy();
      // …and the owner's address must still be unproven.
      const mine = await ctx.http().get('/v1/auth/me').set(auth(owner)).expect(200);
      expect(mine.body.emailVerifiedAt).toBeNull();
    });

    it('issues six digits, with leading zeros kept', async () => {
      /* `randomInt`, not `Math.random()` — this is the whole secret for the
         code path. Padding matters too: "042931" is a valid code and dropping
         the zero would both shrink the space and confuse the typist. */
      const { EmailTokenService } = await import('../src/auth/email-token.service');
      const seen = new Set<string>();
      for (let i = 0; i < 500; i += 1) {
        const code = EmailTokenService.sixDigits();
        expect(code).toMatch(/^\d{6}$/);
        seen.add(code);
      }
      // 500 draws from a million values collide vanishingly rarely.
      expect(seen.size).toBeGreaterThan(490);
    });
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

/**
 * The other half of the password rule.
 *
 * Eight characters was the whole of it, so `password` — eight characters, and
 * the single most-breached string there is — opened a real account on the live
 * site. NIST 800-63B asks for both halves: length instead of composition rules,
 * *and* a check against known-compromised secrets.
 *
 * The suite runs with `HIBP_DISABLED=1`, so what is exercised here is the local
 * refusal list and the fact that all three password paths consult it. The range
 * API itself has its own unit test with `fetch` stubbed.
 */
describe('breached passwords', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('refuses to open an account on a password from a breach list', async () => {
    const res = await ctx
      .http()
      .post('/v1/auth/signup')
      .send({
        email: uniqueEmail('breach'),
        password: 'password',
        name: 'পরীক্ষা',
        locale: 'bn',
      })
      .expect(400);

    /* Names the reason rather than inventing a rule. "Must contain a symbol"
       teaches somebody to append `!` to the password they already reuse. */
    expect(JSON.stringify(res.body)).toContain('ফাঁস');
  });

  it('still accepts an ordinary password of the same length', async () => {
    /* The check must refuse *breached* passwords, not short or simple ones —
       adding composition rules is the failure mode this is meant to avoid. */
    await ctx
      .http()
      .post('/v1/auth/signup')
      .send({
        email: uniqueEmail('fine'),
        password: 'amar khatar chabi',
        name: 'পরীক্ষা',
        locale: 'bn',
      })
      .expect(201);
  });

  it('refuses one on the way through a password change, too', async () => {
    /* A change or a reset is exactly when somebody reaches for the password
       they use everywhere else. Checking only at signup would leave the widest
       door open. */
    const user = await signup(ctx);
    await ctx
      .http()
      .post('/v1/auth/password/change')
      .set(auth(user))
      .send({ currentPassword: 'hishab1234', newPassword: '12345678' })
      .expect(400);
  });
});
