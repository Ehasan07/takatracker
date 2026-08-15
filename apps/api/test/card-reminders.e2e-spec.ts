import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CardRemindersService } from '../src/notifications/card-reminders.service';
import { TelegramClient } from '../src/notifications/telegram.client';
import { auth, createTestApp, resetDatabase, signup, type TestContext } from './harness';

const today = new Date().toISOString().slice(0, 10);

describe('a card limit', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('reports what is drawn and what is left, and adds neither to anything', async () => {
    /* IAS 7.6 keeps cash to what is held, and an undrawn limit is money the
       bank still has and may withdraw — the Conceptual Framework would not call
       it a controlled resource, and no past event has occurred. IAS 7.50(a):
       disclosed, never recognised. Adding it to net worth would make somebody
       a lakh richer for being handed a card. */
    const user = await signup(ctx);
    const card = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({
        name: 'সিটি কার্ড',
        type: 'CREDIT_CARD',
        creditLimitMinor: 100_000_00,
        openingBalance: 0,
      })
      .expect(201);

    const category = await ctx.prisma.category.findFirstOrThrow({
      where: { workspaceId: user.workspaceId, kind: 'EXPENSE', deletedAt: null },
    });
    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        type: 'EXPENSE',
        date: '2026-08-16',
        amountMinor: 20_000_00,
        accountId: card.body.id,
        categoryId: category.id,
      })
      .expect(201);

    const accounts = await ctx.http().get('/v1/accounts').set(auth(user)).expect(200);
    const row = accounts.body.find((a: { id: string }) => a.id === card.body.id);

    expect(row.creditLimitMinor).toBe(100_000_00);
    expect(row.drawnMinor).toBe(20_000_00);
    expect(row.undrawnMinor).toBe(80_000_00);
    /* Only what was spent is owed. */
    expect(row.balanceMinor).toBe(-20_000_00);

    /* And the eighty thousand is nowhere near the balance sheet: net worth is
       the twenty thousand owed, and nothing can be spent from a card that has
       not been drawn on. */
    const summary = await ctx.http().get('/v1/transactions/summary').set(auth(user)).expect(200);
    expect(summary.body.netWorthMinor).toBe(-20_000_00);
    expect(summary.body.liquidMinor).toBe(0);
  });

  it('never reports room left below zero on a card that is over its limit', async () => {
    /* Over the limit is a fact about the debt, not spare room, and a negative
       "left to spend" would read as one. */
    const user = await signup(ctx);
    const card = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'ছোট কার্ড', type: 'CREDIT_CARD', creditLimitMinor: 5_000_00 })
      .expect(201);

    const category = await ctx.prisma.category.findFirstOrThrow({
      where: { workspaceId: user.workspaceId, kind: 'EXPENSE', deletedAt: null },
    });
    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        type: 'EXPENSE',
        date: '2026-08-16',
        amountMinor: 7_000_00,
        accountId: card.body.id,
        categoryId: category.id,
      })
      .expect(201);

    const accounts = await ctx.http().get('/v1/accounts').set(auth(user)).expect(200);
    const row = accounts.body.find((a: { id: string }) => a.id === card.body.id);
    expect(row.drawnMinor).toBe(7_000_00);
    expect(row.undrawnMinor).toBe(0);
  });

  it('reports no limit on anything that is not a card', async () => {
    const user = await signup(ctx);
    const bank = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'ব্যাংক', type: 'BANK', creditLimitMinor: 50_000_00 })
      .expect(201);

    const accounts = await ctx.http().get('/v1/accounts').set(auth(user)).expect(200);
    const row = accounts.body.find((a: { id: string }) => a.id === bank.body.id);
    expect(row.creditLimitMinor).toBe(0);
    expect(row.undrawnMinor).toBe(0);
  });
});

describe('credit-card reminders', () => {
  let ctx: TestContext;
  let reminders: CardRemindersService;
  let telegram: TelegramClient;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    reminders = ctx.app.get(CardRemindersService);
    telegram = ctx.app.get(TelegramClient);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  const addCard = (user: Awaited<ReturnType<typeof signup>>, dueDayOfMonth: number) =>
    ctx.http().post('/v1/accounts').set(auth(user)).send({
      name: 'ব্র্যাক কার্ড',
      type: 'CREDIT_CARD',
      accountNumberMasked: '****4521',
      dueDayOfMonth,
    });

  /** Pretend the workspace is bound to a chat, without touching Telegram. */
  async function bindChat(workspaceId: string, userId: string): Promise<void> {
    await ctx.prisma.telegramConnection.upsert({
      where: { workspaceId_userId: { workspaceId, userId } },
      create: {
        workspaceId,
        userId,
        chatId: '1681829800',
        isEnabled: true,
        verifiedAt: new Date(),
        status: 'ACTIVE',
      },
      update: { chatId: '1681829800', isEnabled: true, verifiedAt: new Date(), status: 'ACTIVE' },
    });
  }

  it('stores a due day on a credit card and hands it back', async () => {
    const user = await signup(ctx);
    const card = await addCard(user, 12).expect(201);
    expect(card.body.dueDayOfMonth).toBe(12);

    const list = await ctx.http().get('/v1/accounts').set(auth(user)).expect(200);
    expect(list.body[0].dueDayOfMonth).toBe(12);
  });

  it('rejects a due day outside a month', async () => {
    const user = await signup(ctx);
    await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'কার্ড', type: 'CREDIT_CARD', dueDayOfMonth: 45 })
      .expect(400);
  });

  it('reports the connection without ever exposing a chat id or a token', async () => {
    const user = await signup(ctx);
    await bindChat(user.workspaceId, user.id);

    const res = await ctx.http().get('/v1/notifications/telegram').set(auth(user)).expect(200);
    expect(res.body.connection.chatIdMasked).toBe('****9800');

    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain('1681829800');
    expect(serialised.toLowerCase()).not.toContain('token');
  });

  it('refuses to enable notifications for a chat nobody verified', async () => {
    const user = await signup(ctx);
    await ctx.prisma.telegramConnection.create({
      data: { workspaceId: user.workspaceId, userId: user.id, chatId: '999', status: 'PENDING' },
    });

    await ctx
      .http()
      .post('/v1/notifications/telegram/enabled')
      .set(auth(user))
      .send({ enabled: true })
      .expect(400);
  });

  it('sends one reminder a day, however often the sweep runs', async () => {
    const user = await signup(ctx);
    await bindChat(user.workspaceId, user.id);
    const card = await addCard(user, 12).expect(201);

    const send = vi.spyOn(telegram, 'sendMessage').mockResolvedValue({ ok: true });
    vi.spyOn(telegram, 'sharedBotToken', 'get').mockReturnValue('test-token');

    // Backdate the card so its cycle is not "before it existed".
    await ctx.prisma.account.update({
      where: { id: card.body.id },
      data: { createdAt: new Date('2020-01-01') },
    });

    const inWindow = new Date();
    const cycle = await ctx.prisma.cardReminderCycle.findFirst({
      where: { accountId: card.body.id },
    });
    expect(cycle).toBeNull(); // nothing created until the sweep runs

    await reminders.runDueReminders(inWindow, true);
    await reminders.runDueReminders(inWindow, true);
    await reminders.runDueReminders(inWindow, true);

    const row = await ctx.prisma.cardReminderCycle.findFirstOrThrow({
      where: { accountId: card.body.id },
    });
    // Three sweeps, one message: the per-day guard is what makes a restart safe.
    expect(row.sentCount).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);

    send.mockRestore();
    vi.restoreAllMocks();
  });

  it('stops for the rest of the cycle once muted, and says which cycle', async () => {
    const user = await signup(ctx);
    await bindChat(user.workspaceId, user.id);
    const card = await addCard(user, 12).expect(201);
    await ctx.prisma.account.update({
      where: { id: card.body.id },
      data: { createdAt: new Date('2020-01-01') },
    });

    const send = vi.spyOn(telegram, 'sendMessage').mockResolvedValue({ ok: true });
    vi.spyOn(telegram, 'sharedBotToken', 'get').mockReturnValue('test-token');

    const muted = await ctx
      .http()
      .post(`/v1/cards/${card.body.id}/mute-reminders`)
      .set(auth(user))
      .expect(200);
    expect(muted.body.cycleMonth).toMatch(/^\d{4}-\d{2}$/);

    await reminders.runDueReminders(new Date(), true);
    expect(send).not.toHaveBeenCalled();

    const row = await ctx.prisma.cardReminderCycle.findFirstOrThrow({
      where: { accountId: card.body.id },
    });
    expect(row.mutedReason).toBe('MANUAL');

    send.mockRestore();
    vi.restoreAllMocks();
  });

  it('mutes the cycle automatically when the card is paid', async () => {
    const user = await signup(ctx);
    await bindChat(user.workspaceId, user.id);
    const card = await addCard(user, 12).expect(201);
    const cash = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'ব্যাংক', type: 'BANK', openingBalance: 10_000_000 })
      .expect(201);

    await ctx.prisma.account.update({
      where: { id: card.body.id },
      data: { createdAt: new Date('2020-01-01') },
    });

    // Spend on the card, so there is something to pay.
    const cats = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    const categoryId = cats.body.find((c: { kind: string }) => c.kind === 'EXPENSE').id;
    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: today,
        type: 'EXPENSE',
        amountMinor: 500_000,
        accountId: card.body.id,
        categoryId,
      })
      .expect(201);

    // Pay it off: money moves from the bank into the card.
    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: today,
        type: 'TRANSFER',
        amountMinor: 500_000,
        accountId: cash.body.id,
        counterAccountId: card.body.id,
      })
      .expect(201);

    // The auto-mute runs outside the request, so give it a moment.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const row = await ctx.prisma.cardReminderCycle.findFirst({
      where: { accountId: card.body.id },
    });
    expect(row?.mutedReason).toBe('PAID');
  });

  it('disables the connection when the user blocks the bot', async () => {
    const user = await signup(ctx);
    await bindChat(user.workspaceId, user.id);

    vi.spyOn(telegram, 'sharedBotToken', 'get').mockReturnValue('test-token');
    vi.spyOn(telegram, 'sendMessage').mockResolvedValue({ ok: false, failure: 'BLOCKED' });

    await ctx.http().post('/v1/notifications/telegram/test').set(auth(user)).expect(200);

    const connection = await ctx.prisma.telegramConnection.findUniqueOrThrow({
      where: { workspaceId_userId: { workspaceId: user.workspaceId, userId: user.id } },
    });
    // Blocking is permanent; retrying it would just get our IP throttled.
    expect(connection.status).toBe('AUTH_FAILED');
    expect(connection.isEnabled).toBe(false);

    vi.restoreAllMocks();
  });

  it('keeps reminders inside their own workspace', async () => {
    const alice = await signup(ctx);
    const bob = await signup(ctx);
    const card = await addCard(alice, 12).expect(201);

    await ctx.http().post(`/v1/cards/${card.body.id}/mute-reminders`).set(auth(bob)).expect(404);
  });

  it('rejects a webhook without the shared secret', async () => {
    await ctx
      .http()
      .post('/v1/telegram/webhook')
      .send({ message: { text: '/start x' } })
      .expect(401);
  });
});
