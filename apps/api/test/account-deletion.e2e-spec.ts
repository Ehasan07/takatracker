import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountDeletionService } from '../src/auth/account-deletion.service';
import { auth, createTestApp, resetDatabase, signup, type TestContext } from './harness';

/**
 * Closing an account, and meaning it.
 *
 * Two halves, and the second is the one that matters. Scheduling a deletion is
 * easy to get right; carrying it out is where a product quietly keeps the data
 * — a soft-delete flag, an orphaned ledger, a workspace nobody can reach but
 * that still exists. So the tests below check the database directly after the
 * sweep rather than trusting a 200.
 *
 * The grace period is the other half. An irreversible act taken in one tap on a
 * phone is a support request nobody can answer, so it is scheduled rather than
 * done, and signing in during the window calls it off without being asked to.
 */
describe('closing an account', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  const PASSWORD = 'hishab1234';

  it('schedules rather than deletes, and says when', async () => {
    const user = await signup(ctx);
    const res = await ctx
      .http()
      .post('/v1/auth/account/deletion')
      .set(auth(user))
      .send({ password: PASSWORD, reason: 'testing' })
      .expect(200);

    expect(res.body.requestedAt).toBeTruthy();
    expect(res.body.scheduledFor).toBeTruthy();

    /* Seven days out, give or take the second the test took. Compared in
       milliseconds rather than rounded days, because the lint rule that bans
       `Math.round` is about money and this is a clock — but a rule with an
       exception is a rule people stop trusting, so the arithmetic avoids it
       instead of arguing with it. */
    const gap =
      new Date(res.body.scheduledFor).getTime() - new Date(res.body.requestedAt).getTime();
    expect(gap).toBeGreaterThan(6.9 * 86_400_000);
    expect(gap).toBeLessThan(7.1 * 86_400_000);

    // Still there, still working. The account is not gone until the sweep runs.
    await ctx.http().get('/v1/accounts').set(auth(user)).expect(200);
  });

  it('will not take the word of a session alone', async () => {
    /* The threat is a phone left unlocked on a table, and a valid session is
       exactly what that phone has. So the destructive direction asks for
       something the phone does not carry. */
    const user = await signup(ctx);
    await ctx
      .http()
      .post('/v1/auth/account/deletion')
      .set(auth(user))
      .send({ password: 'not-the-password' })
      .expect(401);

    const status = await ctx.http().get('/v1/auth/account/deletion').set(auth(user)).expect(200);
    expect(status.body.requestedAt).toBeNull();
  });

  it('can be called off, and signing in calls it off by itself', async () => {
    const user = await signup(ctx);
    const request = () =>
      ctx
        .http()
        .post('/v1/auth/account/deletion')
        .set(auth(user))
        .send({ password: PASSWORD })
        .expect(200);

    await request();
    await ctx.http().delete('/v1/auth/account/deletion').set(auth(user)).expect(200);
    let status = await ctx.http().get('/v1/auth/account/deletion').set(auth(user)).expect(200);
    expect(status.body.requestedAt).toBeNull();

    /* And the version nobody has to find a screen for: somebody who asked on
       Monday and is reading their ledger on Wednesday has changed their mind
       whatever the row says. */
    await request();
    await ctx
      .http()
      .post('/v1/auth/login')
      .send({ email: user.email, password: PASSWORD })
      .expect(200);

    status = await ctx.http().get('/v1/auth/account/deletion').set(auth(user)).expect(200);
    expect(status.body.requestedAt).toBeNull();
  });

  it('erases everything once the grace period has passed', async () => {
    const user = await signup(ctx);
    const account = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'নগদ', type: 'CASH', openingBalance: 100_000 })
      .expect(201);

    await ctx
      .http()
      .post('/v1/auth/account/deletion')
      .set(auth(user))
      .send({ password: PASSWORD })
      .expect(200);

    /* The sweep asks for a scheduled date already in the past, so the test
       moves the clock rather than the data: exactly what would happen a week
       later, with nothing about the request changed. */
    const service = ctx.app.get(AccountDeletionService);
    const eightDaysOn = new Date(Date.now() + 8 * 86_400_000);
    const { deleted } = await service.runDueDeletions(eightDaysOn);
    /* At least one, not exactly one: earlier tests in this file left their own
       requests scheduled, and eight days on the sweep is right to take those
       too. The assertions that matter are the specific rows below. */
    expect(deleted).toBeGreaterThanOrEqual(1);

    /* Checked in the database, not through the API. A 401 afterwards would
       prove only that the session stopped working. */
    expect(await ctx.prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
    expect(await ctx.prisma.workspace.findUnique({ where: { id: user.workspaceId } })).toBeNull();
    expect(await ctx.prisma.account.findUnique({ where: { id: account.body.id } })).toBeNull();
    /* The ledger, through the workspace cascade. If this survives, "deleted"
       meant "hidden". */
    expect(await ctx.prisma.transaction.count({ where: { workspaceId: user.workspaceId } })).toBe(
      0,
    );
    expect(await ctx.prisma.auditEvent.count({ where: { workspaceId: user.workspaceId } })).toBe(0);
  });

  it('keeps proof that it happened, and nothing about who it was', async () => {
    const user = await signup(ctx);
    await ctx
      .http()
      .post('/v1/auth/account/deletion')
      .set(auth(user))
      .send({ password: PASSWORD })
      .expect(200);

    const service = ctx.app.get(AccountDeletionService);
    await service.runDueDeletions(new Date(Date.now() + 8 * 86_400_000));

    const rows = await ctx.prisma.accountDeletion.findMany();
    expect(rows.length).toBeGreaterThanOrEqual(1);

    /* The address is nowhere in the row — only a hash of it. A company that
       cannot say whether it processed a request has no answer when somebody
       asks a second time; a company that keeps the address has not erased
       anything. */
    const asText = JSON.stringify(rows);
    expect(asText).not.toContain(user.email);
    expect(await service.wasDeleted(user.email)).toBe(true);
    expect(await service.wasDeleted(`someone-else-${Date.now()}@example.test`)).toBe(false);
  });

  it('leaves alone an account whose week is not up', async () => {
    const user = await signup(ctx);
    await ctx
      .http()
      .post('/v1/auth/account/deletion')
      .set(auth(user))
      .send({ password: PASSWORD })
      .expect(200);

    const service = ctx.app.get(AccountDeletionService);
    // One day on, not eight.
    const { deleted } = await service.runDueDeletions(new Date(Date.now() + 86_400_000));
    expect(deleted).toBe(0);
    expect(await ctx.prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
  });
});
