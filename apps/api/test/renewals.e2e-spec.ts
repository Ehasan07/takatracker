import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RenewalReminderService } from '../src/renewals/renewal-reminder.service';
import { auth, createTestApp, resetDatabase, signup, type TestContext } from './harness';

/**
 * Papers that expire.
 *
 * The date arithmetic is covered unit-by-unit in packages/core/src/renewals.test.ts,
 * so nothing here re-derives a due date. What these defend is the behaviour
 * around it: that marking one done counts from the day it was done, that a
 * one-off closes rather than repeating for ever, that an overdue obligation
 * keeps asking, and that nobody is told the same thing twice in one day.
 *
 * The last three are about the optional fee: that it lands on the day it was
 * paid rather than today, that leaving it out still leaves the ledger empty,
 * and — the one that matters most — that a fee the ledger refuses cannot take
 * the completion down with it.
 */

describe('renewals', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  type User = Awaited<ReturnType<typeof signup>>;

  const create = (user: User, body: Record<string, unknown>) =>
    ctx
      .http()
      .post('/v1/renewals')
      .set(auth(user))
      .send({ kind: 'KHAJNA', title: 'বসিলার জমির খাজনা', dueDate: '2026-12-31', ...body });

  const list = (user: User) => ctx.http().get('/v1/renewals').set(auth(user));

  /* Dates are compared in the workspace's own timezone, so the test has to
     count from the same "today" the API does — Dhaka is six hours ahead of UTC
     and `toISOString()` is a different day for a quarter of the clock. */
  const dhakaToday = (): string =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());

  const dhakaPlus = (days: number): string => {
    const [y, m, d] = dhakaToday().split('-').map(Number);
    const at = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
    at.setUTCDate(at.getUTCDate() + days);
    return at.toISOString().slice(0, 10);
  };

  it('keeps the deadline out of the ledger', async () => {
    /* Khajna is owed whether or not it has been paid, and the payment when it
       comes is an ordinary expense. Writing the obligation as a transaction
       would put money in the books that has not moved. */
    const user = await signup(ctx);
    await create(user, { estimatedCostMinor: 250_000 }).expect(201);

    const entries = await ctx.prisma.ledgerEntry.count({
      where: { workspaceId: user.workspaceId },
    });
    expect(entries).toBe(0);
  });

  it('says how long is left, so no screen has to work it out', async () => {
    const user = await signup(ctx);
    await create(user, { dueDate: dhakaPlus(10), reminderLeadDays: 30 }).expect(201);
    const rows = (await list(user).expect(200)).body;

    expect(rows[0].daysLeft).toBe(10);
    expect(rows[0].urgency).toBe('DUE_SOON');
  });

  it('rolls forward from the day it was done, not the day it was due', async () => {
    /* A fitness certificate issued three weeks late is valid for a year from
       issue. Counting from the missed deadline would shorten every following
       period and keep somebody permanently behind. */
    const user = await signup(ctx);
    const created = await create(user, {
      kind: 'FITNESS',
      title: 'গাড়ির ফিটনেস',
      dueDate: '2026-04-01',
      recurrence: 'YEARLY',
    }).expect(201);

    const done = await ctx
      .http()
      .post(`/v1/renewals/${created.body.id}/complete`)
      .set(auth(user))
      .send({ completedOn: '2026-04-21' })
      .expect(200);

    expect(done.body.dueDate).toBe('2027-04-21');
    expect(done.body.lastCompletedOn).toBe('2026-04-21');
    expect(done.body.status).toBe('ACTIVE');
  });

  it('closes a one-off instead of repeating it for ever', async () => {
    const user = await signup(ctx);
    const created = await create(user, {
      kind: 'PASSPORT',
      title: 'পাসপোর্ট',
      recurrence: 'ONE_OFF',
    }).expect(201);

    const done = await ctx
      .http()
      .post(`/v1/renewals/${created.body.id}/complete`)
      .set(auth(user))
      .send({})
      .expect(200);

    expect(done.body.status).toBe('DONE');
  });

  it('can hang a renewal on the asset it belongs to, and survives the asset going', async () => {
    /* Selling the car does not un-happen its fitness renewals. */
    const user = await signup(ctx);
    const car = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'গাড়ি', type: 'ASSET', openingBalance: 0 })
      .expect(201);

    const created = await create(user, {
      kind: 'FITNESS',
      title: 'ফিটনেস',
      accountId: car.body.id,
    }).expect(201);
    expect((await list(user)).body[0].accountName).toBe('গাড়ি');

    await ctx.prisma.account.delete({ where: { id: car.body.id } });

    const after = await ctx.prisma.assetObligation.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(after.accountId).toBeNull();
  });

  it('reminds once a day and not twice, however often the sweep runs', async () => {
    /* The guard is a local-date stamp rather than a timestamp plus a duration,
       so a restart or an overlapping sweep cannot send a second time. */
    const user = await signup(ctx);
    await create(user, { dueDate: dhakaToday(), reminderLeadDays: 30 }).expect(201);

    /* A connection that looks live, so the send path is actually walked. */
    await ctx.prisma.telegramConnection.create({
      data: {
        workspaceId: user.workspaceId,
        userId: user.id,
        chatId: '424242',
        isEnabled: true,
        status: 'ACTIVE',
      },
    });

    /* The sender bails out when there is no bot token, which in a test there
       is not — so one is set for the length of this test only. */
    const hadToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';

    const reminders = ctx.app.get(RenewalReminderService);
    let calls = 0;
    const telegram = (reminders as unknown as { telegram: { sendMessage: unknown } }).telegram;
    (telegram as { sendMessage: unknown }).sendMessage = async () => {
      calls += 1;
      return { ok: true };
    };

    try {
      await reminders.runDueReminders(new Date(), true);
      await reminders.runDueReminders(new Date(), true);
    } finally {
      if (hadToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = hadToken;
    }
    expect(calls).toBe(1);
  });

  it('keeps reminding after the date has gone', async () => {
    /* Going quiet at the moment the fine starts accruing would be the worst
       possible behaviour. */
    const user = await signup(ctx);
    await create(user, { dueDate: dhakaPlus(-40) }).expect(201);

    const rows = (await list(user).expect(200)).body;
    expect(rows[0].urgency).toBe('OVERDUE');
    expect(rows[0].daysLeft).toBeLessThan(0);
  });

  /* A wallet to pay out of and a category to file it under — the two things a
     fee needs before it can be booked at all. */
  const payFrom = async (user: User): Promise<{ accountId: string; categoryId: string }> => {
    const wallet = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'নগদ', type: 'CASH', openingBalance: 0 })
      .expect(201);

    const categories = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    const expense = categories.body.find((c: { kind: string }) => c.kind === 'EXPENSE');

    return { accountId: wallet.body.id, categoryId: expense.id };
  };

  const ledgerEntries = (user: User): Promise<number> =>
    ctx.prisma.ledgerEntry.count({ where: { workspaceId: user.workspaceId } });

  it('books the fee on the day it was paid, for the amount that was typed', async () => {
    /* Both halves of the offer at once: the expense is dated `completedOn` and
       not today, and the amount is the one that was sent — not the estimate the
       screen prefilled the box with. An estimate is not a receipt. */
    const user = await signup(ctx);
    const { accountId, categoryId } = await payFrom(user);
    const created = await create(user, {
      dueDate: '2026-04-01',
      estimatedCostMinor: 250_000,
    }).expect(201);

    const done = await ctx
      .http()
      .post(`/v1/renewals/${created.body.id}/complete`)
      .set(auth(user))
      .send({
        completedOn: '2026-04-21',
        // The office wanted ৳3,120, not the ৳2,500 that was guessed a year ago.
        payment: { amountMinor: 312_000, accountId, categoryId },
      })
      .expect(200);

    expect(done.body.dueDate).toBe('2027-04-21');
    expect(done.body.fee.booked).toBe(true);
    expect(done.body.fee.message).toBeNull();

    const tx = await ctx
      .http()
      .get(`/v1/transactions/${done.body.fee.transactionId}`)
      .set(auth(user))
      .expect(200);

    expect(tx.body.date).toBe('2026-04-21');
    expect(tx.body.type).toBe('EXPENSE');
    // Signed from the user's point of view: money left.
    expect(tx.body.amountMinor).toBe(-312_000);
    expect(tx.body.accountId).toBe(accountId);
    expect(tx.body.categoryId).toBe(categoryId);
    // The paper's own name, so the row is recognisable in the khata a year on.
    expect(tx.body.description).toBe('বসিলার জমির খাজনা');
  });

  it('touches nothing in the ledger when no fee is offered', async () => {
    /* The behaviour renewals shipped with, and still the default. Somebody
       clearing five years of back khajna in one sitting does not want five
       transactions dated today. */
    const user = await signup(ctx);
    await payFrom(user);
    const created = await create(user, {
      dueDate: '2026-04-01',
      estimatedCostMinor: 250_000,
    }).expect(201);

    const done = await ctx
      .http()
      .post(`/v1/renewals/${created.body.id}/complete`)
      .set(auth(user))
      .send({ completedOn: '2026-04-21' })
      .expect(200);

    expect(done.body.dueDate).toBe('2027-04-21');
    // Null, not a `booked: false` — nothing was attempted, so nothing failed.
    expect(done.body.fee).toBeNull();
    expect(await ledgerEntries(user)).toBe(0);
  });

  it('still rolls the date forward when the fee cannot be booked', async () => {
    /* The half that must never take the other half down with it. A category
       deleted between the screen loading and the button being pressed, a plan
       ceiling, a wallet that is somebody else's — the khajna was still paid,
       and losing that fact to a bookkeeping refusal would be the worst outcome
       this endpoint has. */
    const user = await signup(ctx);
    const { accountId } = await payFrom(user);
    const created = await create(user, { dueDate: '2026-04-01' }).expect(201);

    const done = await ctx
      .http()
      .post(`/v1/renewals/${created.body.id}/complete`)
      .set(auth(user))
      .send({
        completedOn: '2026-04-21',
        payment: { amountMinor: 250_000, accountId, categoryId: 'cat_gone_missing' },
      })
      .expect(200);

    expect(done.body.dueDate).toBe('2027-04-21');
    expect(done.body.lastCompletedOn).toBe('2026-04-21');
    expect(done.body.fee.booked).toBe(false);
    expect(done.body.fee.transactionId).toBeNull();
    // Says so in Bengali, rather than leaving the screen to guess from a 200.
    expect(done.body.fee.message).toContain('ক্যাটাগরি');
    // And no half-written entry left behind.
    expect(await ledgerEntries(user)).toBe(0);
  });

  it('will not show one workspace another one’s papers', async () => {
    const mine = await signup(ctx);
    const theirs = await signup(ctx);
    const created = await create(mine, {}).expect(201);

    expect((await list(theirs)).body).toEqual([]);
    expect(
      (
        await ctx
          .http()
          .patch(`/v1/renewals/${created.body.id}`)
          .set(auth(theirs))
          .send({ title: 'চুরি' })
      ).status,
    ).toBe(404);
  });
});
