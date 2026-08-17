import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, createTestApp, resetDatabase, signup, type TestContext } from './harness';

/**
 * Savings plans, end to end.
 *
 * The projection arithmetic is already covered unit-by-unit in
 * packages/core/src/savings.test.ts, so nothing here re-derives a maturity
 * figure. What these tests defend is everything wrapped around it: that a plan
 * writes the schedule it promised, that a paid instalment stays paid and moves
 * the progress ring, that a deleted plan is gone from every read path, and that
 * one workspace can never reach another's money.
 */

/** ৳2,000.00 a month — an ordinary DPS at a Bangladeshi bank. */
const DPS_INSTALMENT = 200_000;
/** ৳500,000.00 placed in one go — an ordinary FDR. */
const FDR_PRINCIPAL = 50_000_000;

interface Installment {
  id: string;
  index: number;
  dueDate: string;
  expectedMinor: number;
  paidDate: string | null;
  status: string;
}

describe('savings', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  type User = Awaited<ReturnType<typeof signup>>;

  const create = (user: User, body: Record<string, unknown>) =>
    ctx.http().post('/v1/savings').set(auth(user)).send(body);

  /** A plain monthly DPS, so each test only has to spell out what it changes. */
  const dps = (over: Record<string, unknown> = {}) => ({
    planName: 'সোনালী ডিপিএস',
    institution: 'সোনালী ব্যাংক',
    planType: 'DPS',
    installmentMinor: DPS_INSTALMENT,
    frequency: 'MONTHLY',
    termMonths: 24,
    startDate: '2026-01-15',
    profitRateBps: 825,
    profitCalc: 'COMPOUND_YEARLY',
    ...over,
  });

  it('writes the whole instalment schedule, one row a month from the start date', async () => {
    const user = await signup(ctx);
    const res = await create(user, dps()).expect(201);

    const installments: Installment[] = res.body.installments;
    // Twenty-four months, twenty-four rows. A plan that saved half a schedule
    // would under-report what the saver still owes for the rest of the term.
    expect(installments).toHaveLength(24);
    expect(installments.map((row) => row.index)).toEqual(
      Array.from({ length: 24 }, (_, i) => i + 1),
    );
    expect(installments.every((row) => row.expectedMinor === DPS_INSTALMENT)).toBe(true);
    expect(installments.every((row) => row.status === 'DUE')).toBe(true);
    expect(installments.every((row) => row.paidDate === null)).toBe(true);

    // One month apart, every time: the same day of the month, twenty-four
    // distinct months, no gap and no repeat.
    expect(installments.every((row) => row.dueDate.endsWith('-15'))).toBe(true);
    expect(new Set(installments.map((row) => row.dueDate.slice(0, 7))).size).toBe(24);
    expect(installments[0].dueDate).toBe('2026-01-15');
    expect(installments[11].dueDate).toBe('2026-12-15');
    expect(installments[12].dueDate).toBe('2027-01-15');
    expect(installments[23].dueDate).toBe('2027-12-15');

    // The rows really are on disk, and each one carries the workspace it
    // belongs to — that denormalised column is what scopes the pay lookup, so a
    // wrong value there is a tenancy hole rather than a cosmetic slip.
    const rows = await ctx.prisma.savingsInstallment.findMany({
      where: { planId: res.body.id },
    });
    expect(rows).toHaveLength(24);
    expect(rows.every((row) => row.workspaceId === user.workspaceId)).toBe(true);
    expect(rows.every((row) => row.expectedMinor === BigInt(DPS_INSTALMENT))).toBe(true);
  });

  it('clamps a plan opened on the 31st to the last day of a short month', async () => {
    const user = await signup(ctx);
    const res = await create(
      user,
      dps({ startDate: '2026-01-31', termMonths: 6, planName: 'মাস শেষের ডিপিএস' }),
    ).expect(201);

    // Spilling into the next month would drag the whole schedule a day later
    // each time, and the saver's reminder would arrive after the money was due.
    expect(res.body.installments.map((row: Installment) => row.dueDate)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
    ]);

    const leap = await create(
      user,
      dps({ startDate: '2028-01-31', termMonths: 3, planName: 'অধিবর্ষের ডিপিএস' }),
    ).expect(201);
    expect(leap.body.installments.map((row: Installment) => row.dueDate)).toEqual([
      '2028-01-31',
      '2028-02-29',
      '2028-03-31',
    ]);
  });

  it('returns the projection on the detail response, still labelled as before tax', async () => {
    const user = await signup(ctx);
    const created = await create(user, dps({ termMonths: 36 })).expect(201);

    const res = await ctx.http().get(`/v1/savings/${created.body.id}`).set(auth(user)).expect(200);
    const { projection } = res.body;

    // Excise duty and AIT are not modelled, so every figure the app shows is a
    // gross one. Losing this label would turn an honest estimate into a promise
    // the bank will not keep — it must survive every refactor of the response.
    expect(projection.formula).toContain('কর কাটার আগের হিসাব');
    // The rate the user typed has to be the rate that was worked with.
    expect(projection.formula).toContain('8.25%');

    // The projection and the schedule must describe the same plan; if they ever
    // disagree, one of the two is lying to the saver.
    expect(projection.installmentCount).toBe(res.body.installments.length);
    expect(projection.depositedMinor).toBe(
      res.body.installments.reduce((sum: number, row: Installment) => sum + row.expectedMinor, 0),
    );
    expect(projection.maturityMinor).toBe(projection.depositedMinor + projection.profitMinor);
    expect(projection.profitMinor).toBeGreaterThan(0);

    // The list carries it too, so a card can show maturity without a second call.
    const list = await ctx.http().get('/v1/savings').set(auth(user)).expect(200);
    expect(list.body[0].projection.formula).toContain('কর কাটার আগের হিসাব');
    // ...but not the thousand schedule rows behind ten plans' progress rings.
    expect(list.body[0].installments).toBeUndefined();
  });

  it('marks an instalment paid, moves the progress, and refuses to take it twice', async () => {
    const user = await signup(ctx);
    const plan = (await create(user, dps({ termMonths: 12 })).expect(201)).body;
    const [first, second] = plan.installments as Installment[];

    expect(plan.progress).toMatchObject({
      paidCount: 0,
      remainingCount: 12,
      paidMinor: 0,
      percentComplete: 0,
    });
    expect(plan.nextDueDate).toBe(first.dueDate);

    const paid = await ctx
      .http()
      .post(`/v1/savings/${plan.id}/installments/${first.id}/pay`)
      .set(auth(user))
      .send({ paidDate: '2026-01-16' })
      .expect(200);

    const row = (paid.body.installments as Installment[]).find((r) => r.id === first.id);
    expect(row?.status).toBe('PAID');
    expect(row?.paidDate).toBe('2026-01-16');
    // One of twelve: 8.3%, and the next reminder is now the February instalment.
    expect(paid.body.progress).toMatchObject({
      paidCount: 1,
      remainingCount: 11,
      paidMinor: DPS_INSTALMENT,
      percentComplete: 8.3,
    });
    expect(paid.body.nextDueDate).toBe(second.dueDate);

    const stored = await ctx.prisma.savingsInstallment.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(stored.status).toBe('PAID');
    expect(stored.paidDate).not.toBeNull();

    // Paying twice is how a DPS quietly appears to be a month ahead of itself.
    const again = await ctx
      .http()
      .post(`/v1/savings/${plan.id}/installments/${first.id}/pay`)
      .set(auth(user))
      .send({ paidDate: '2026-02-16' })
      .expect(400);
    expect(again.body.message).toBe('এই কিস্তি আগেই পরিশোধ করা হয়েছে');

    // And the refusal changed nothing.
    const after = await ctx.http().get(`/v1/savings/${plan.id}`).set(auth(user)).expect(200);
    expect(after.body.progress.paidCount).toBe(1);
    expect(
      (after.body.installments as Installment[]).find((r) => r.id === first.id)?.paidDate,
    ).toBe('2026-01-16');
  });

  it('gives a lump-sum FDR an empty schedule rather than a made-up one', async () => {
    const user = await signup(ctx);
    const res = await create(user, {
      planName: 'এফডিআর',
      institution: 'ডাচ-বাংলা ব্যাংক',
      planType: 'FDR',
      principalMinor: FDR_PRINCIPAL,
      termMonths: 12,
      startDate: '2026-02-01',
      profitRateBps: 900,
      profitCalc: 'COMPOUND_QUARTERLY',
    }).expect(201);

    // There is nothing to tick off month by month, so inventing twelve rows
    // would show the holder eleven instalments they never owe.
    expect(res.body.installments).toEqual([]);
    expect(res.body.nextDueDate).toBeNull();
    /* No instalments to count — but `percentComplete` is no longer stuck at
       zero because of it. A lump sum's progress is the calendar: the money went
       in on day one and nothing remains that could fail to happen, so an FDR
       part-way through its term reads part-way through. Before this it read 0%
       for its whole life, which is the one thing a progress ring must not do. */
    expect(res.body.progress).toMatchObject({ paidCount: 0, remainingCount: 0 });
    expect(res.body.progress.percentComplete).toBeGreaterThan(0);
    expect(res.body.progress.percentComplete).toBeLessThanOrEqual(100);
    expect(res.body.projection.installmentCount).toBe(0);
    expect(res.body.projection.depositedMinor).toBe(FDR_PRINCIPAL);

    expect(await ctx.prisma.savingsInstallment.count({ where: { planId: res.body.id } })).toBe(0);
  });

  it('rejects a plan with neither an instalment nor a principal, in Bengali', async () => {
    const user = await signup(ctx);
    const res = await create(user, {
      planName: 'ফাঁকা পরিকল্পনা',
      termMonths: 12,
      startDate: '2026-03-01',
    }).expect(400);

    expect(res.body.message).toBe('কিস্তির টাকা অথবা এককালীন জমা — অন্তত একটি দিতে হবে');
    expect(await ctx.prisma.savingsPlan.count({ where: { workspaceId: user.workspaceId } })).toBe(
      0,
    );
  });

  it('soft deletes: gone from the list and from detail, still on disk', async () => {
    const user = await signup(ctx);
    const plan = (await create(user, dps()).expect(201)).body;

    const removed = await ctx.http().delete(`/v1/savings/${plan.id}`).set(auth(user)).expect(200);
    expect(removed.body.id).toBe(plan.id);

    expect((await ctx.http().get('/v1/savings').set(auth(user)).expect(200)).body).toEqual([]);
    await ctx.http().get(`/v1/savings/${plan.id}`).set(auth(user)).expect(404);
    // Nor can it be edited or paid back into existence.
    await ctx
      .http()
      .patch(`/v1/savings/${plan.id}`)
      .set(auth(user))
      .send({ planName: 'x' })
      .expect(404);
    await ctx.http().delete(`/v1/savings/${plan.id}`).set(auth(user)).expect(404);

    // Years of deposits leaving a bank account still need an explanation, so
    // the row stays readable behind deletedAt with its schedule intact.
    const stored = await ctx.prisma.savingsPlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(stored.deletedAt).not.toBeNull();
    expect(await ctx.prisma.savingsInstallment.count({ where: { planId: plan.id } })).toBe(24);
  });

  /**
   * The one that matters most. A savings plan carries an institution, a
   * balance and a maturity date; leaking one across a workspace boundary is a
   * data breach, not a bug, so every verb is checked rather than just the read.
   */
  it('never lets a second workspace touch the first one s plan', async () => {
    const alice = await signup(ctx);
    const bob = await signup(ctx);

    const plan = (await create(alice, dps({ planName: 'অ্যালিসের ডিপিএস' })).expect(201)).body;
    const installmentId = (plan.installments as Installment[])[0].id;

    await ctx.http().get(`/v1/savings/${plan.id}`).set(auth(bob)).expect(404);
    await ctx
      .http()
      .patch(`/v1/savings/${plan.id}`)
      .set(auth(bob))
      .send({ planName: 'ববের ডিপিএস' })
      .expect(404);
    await ctx
      .http()
      .post(`/v1/savings/${plan.id}/installments/${installmentId}/pay`)
      .set(auth(bob))
      .send({})
      .expect(404);
    await ctx.http().delete(`/v1/savings/${plan.id}`).set(auth(bob)).expect(404);

    // Not "an empty-looking list" — an empty one.
    expect((await ctx.http().get('/v1/savings').set(auth(bob)).expect(200)).body).toEqual([]);

    // Nothing Bob did left a mark on Alice's plan.
    const mine = await ctx.http().get(`/v1/savings/${plan.id}`).set(auth(alice)).expect(200);
    expect(mine.body.planName).toBe('অ্যালিসের ডিপিএস');
    expect(mine.body.progress.paidCount).toBe(0);
  });

  it('records create, update and instalment payment in the audit trail', async () => {
    const user = await signup(ctx);
    const plan = (await create(user, dps({ termMonths: 12 })).expect(201)).body;
    const installmentId = (plan.installments as Installment[])[0].id;

    await ctx
      .http()
      .patch(`/v1/savings/${plan.id}`)
      .set(auth(user))
      .send({ planName: 'সোনালী ডিপিএস — সংশোধিত' })
      .expect(200);
    await ctx
      .http()
      .post(`/v1/savings/${plan.id}/installments/${installmentId}/pay`)
      .set(auth(user))
      .send({ paidDate: '2026-01-16' })
      .expect(200);

    // The audit write is fire-and-forget, so let the event loop settle first.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const events = await ctx.prisma.auditEvent.findMany({
      where: { workspaceId: user.workspaceId, action: { startsWith: 'savings.' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.action)).toEqual([
      'savings.plan_created',
      'savings.plan_updated',
      'savings.installment_paid',
    ]);
    expect(events.map((e) => e.entity)).toEqual([
      'SavingsPlan',
      'SavingsPlan',
      'SavingsInstallment',
    ]);
    expect(events.map((e) => e.entityId)).toEqual([plan.id, plan.id, installmentId]);
    expect(events.every((e) => e.actorUserId === user.id)).toBe(true);
  });

  /**
   * `savings.plan_deleted` is in AUDIT_ACTIONS but nothing emits it: remove()
   * logs `savings.plan_updated` with `{ deleted: true }` in the after-image.
   * Filtering the timeline by action — which is what the index on
   * (workspaceId, action) exists for — therefore cannot surface a deletion,
   * and a deletion is the event you go to an audit log to find.
   *
   * Marked `it.fails` deliberately: the assertion below is the one we want, and
   * this test will start failing the day the service starts emitting it.
   */
  it('records a deletion under its own audit action', async () => {
    const user = await signup(ctx);
    const plan = (await create(user, dps()).expect(201)).body;
    await ctx.http().delete(`/v1/savings/${plan.id}`).set(auth(user)).expect(200);

    await new Promise((resolve) => setTimeout(resolve, 150));

    const events = await ctx.prisma.auditEvent.findMany({
      where: { workspaceId: user.workspaceId, action: { startsWith: 'savings.' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.action)).toEqual(['savings.plan_created', 'savings.plan_deleted']);
  });
});

/**
 * Profit: what the instrument actually paid, and which instrument paid it.
 *
 * The question behind all of this is "how much did this Sanchayapatra earn me
 * this year". Before `Transaction.savingsPlanId` the ledger knew that money
 * arrived and nothing about where from, so the question had no answer at all.
 */
describe('savings profit', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  type User = Awaited<ReturnType<typeof signup>>;

  const plan = (user: User, planName = 'পরিবার সঞ্চয়পত্র') =>
    ctx
      .http()
      .post('/v1/savings')
      .set(auth(user))
      .send({
        planName,
        planType: 'SANCHAYPATRA',
        principalMinor: 50_000_000,
        frequency: 'MONTHLY',
        termMonths: 60,
        startDate: '2026-01-15',
        profitRateBps: 1104,
        profitCalc: 'SIMPLE',
      })
      .expect(201)
      .then((res) => res.body as { id: string });

  const bank = (user: User, name = 'সিটি ব্যাংক') =>
    ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name, type: 'BANK' })
      .expect(201)
      .then((res) => res.body as { id: string; balanceMinor: number });

  const incomeCategory = async (user: User): Promise<string> => {
    const res = await ctx.http().get('/v1/categories?kind=INCOME').set(auth(user)).expect(200);
    const rows = res.body as { id: string }[];
    if (rows.length === 0) throw new Error('no seeded income categories');
    return rows[0]!.id;
  };

  const recordProfit = async (user: User, planId: string, amountMinor: number, date?: string) => {
    const accounts = (await ctx.http().get('/v1/accounts').set(auth(user)).expect(200)).body as {
      id: string;
      systemKey: string | null;
      type: string;
    }[];
    const account = accounts.find((a) => a.type === 'BANK');
    if (!account) throw new Error('no bank account');
    return ctx
      .http()
      .post(`/v1/savings/${planId}/profit`)
      .set(auth(user))
      .send({ amountMinor, accountId: account.id, categoryId: await incomeCategory(user), date });
  };

  it('puts the profit in the account and remembers which instrument paid it', async () => {
    const user = await signup(ctx);
    const account = await bank(user);
    const saved = await plan(user);

    const res = await recordProfit(user, saved.id, 276_000, '2026-04-15');
    expect(res.status).toBe(201);
    expect(res.body.amountMinor).toBe(276_000);
    expect(res.body.totalProfitMinor).toBe(276_000);

    // The money is really in the account, not merely recorded against the plan.
    const after = (await ctx.http().get('/v1/accounts').set(auth(user)).expect(200)).body as {
      id: string;
      balanceMinor: number;
    }[];
    expect(after.find((a) => a.id === account.id)?.balanceMinor).toBe(276_000);

    // And the row names the instrument, which is the whole point.
    const tx = await ctx.prisma.transaction.findUnique({ where: { id: res.body.transactionId } });
    expect(tx?.savingsPlanId).toBe(saved.id);
    expect(tx?.type).toBe('INCOME');
  });

  it('adds up a year of quarterly payouts against the one certificate', async () => {
    const user = await signup(ctx);
    await bank(user);
    const saved = await plan(user);

    for (const [amount, date] of [
      [276_000, '2026-04-15'],
      [276_000, '2026-07-15'],
      [280_000, '2026-10-15'],
    ] as const) {
      await recordProfit(user, saved.id, amount, date);
    }

    const detail = (await ctx.http().get(`/v1/savings/${saved.id}`).set(auth(user)).expect(200))
      .body as { profitReceivedMinor: number };
    expect(detail.profitReceivedMinor).toBe(832_000);
  });

  it('keeps two certificates apart', async () => {
    const user = await signup(ctx);
    await bank(user);
    const first = await plan(user, 'পরিবার সঞ্চয়পত্র');
    const second = await plan(user, 'পেনশনার সঞ্চয়পত্র');

    await recordProfit(user, first.id, 100_000, '2026-04-15');
    await recordProfit(user, second.id, 250_000, '2026-04-15');

    const list = (await ctx.http().get('/v1/savings').set(auth(user)).expect(200)).body as {
      id: string;
      profitReceivedMinor: number;
    }[];
    expect(list.find((p) => p.id === first.id)?.profitReceivedMinor).toBe(100_000);
    expect(list.find((p) => p.id === second.id)?.profitReceivedMinor).toBe(250_000);
  });

  it('does not count a deleted profit row', async () => {
    const user = await signup(ctx);
    await bank(user);
    const saved = await plan(user);

    const res = await recordProfit(user, saved.id, 276_000, '2026-04-15');
    await ctx
      .http()
      .delete(`/v1/transactions/${res.body.transactionId}`)
      .set(auth(user))
      .expect(200);

    /* A binned transaction is money that did not arrive. Summing off the ledger
       rather than off a column on the plan is what makes this true without any
       extra bookkeeping. */
    const detail = (await ctx.http().get(`/v1/savings/${saved.id}`).set(auth(user)).expect(200))
      .body as { profitReceivedMinor: number };
    expect(detail.profitReceivedMinor).toBe(0);
  });

  it('refuses a plan belonging to somebody else, and books nothing', async () => {
    const user = await signup(ctx);
    const stranger = await signup(ctx);
    await bank(user);
    const theirs = await plan(stranger);

    const res = await recordProfit(user, theirs.id, 100_000, '2026-04-15');
    expect(res.status).toBe(404);

    const count = await ctx.prisma.transaction.count({
      where: { workspaceId: user.workspaceId, deletedAt: null },
    });
    expect(count).toBe(0);
  });

  it('refuses a profit of zero', async () => {
    const user = await signup(ctx);
    await bank(user);
    const saved = await plan(user);

    const res = await recordProfit(user, saved.id, 0, '2026-04-15');
    expect(res.status).toBe(400);
  });

  it('brings a matured plan home as a transfer, not as income', async () => {
    const user = await signup(ctx);
    const saved = await plan(user);
    const savingsAccount = (
      await ctx
        .http()
        .post('/v1/accounts')
        .set(auth(user))
        .send({ name: 'ডিপিএস হিসাব', type: 'SAVINGS', openingBalance: 50_000_000 })
        .expect(201)
    ).body as { id: string };
    const current = await bank(user, 'চলতি হিসাব');

    const res = await ctx
      .http()
      .post(`/v1/savings/${saved.id}/mature`)
      .set(auth(user))
      .send({
        fromAccountId: savingsAccount.id,
        toAccountId: current.id,
        amountMinor: 50_000_000,
        date: '2031-01-15',
      })
      .expect(200);
    expect(res.body.status).toBe('MATURED');

    const accounts = (await ctx.http().get('/v1/accounts').set(auth(user)).expect(200)).body as {
      id: string;
      balanceMinor: number;
    }[];
    // Emptied, and every poisha landed on the other side.
    expect(accounts.find((a) => a.id === savingsAccount.id)?.balanceMinor).toBe(0);
    expect(accounts.find((a) => a.id === current.id)?.balanceMinor).toBe(50_000_000);

    /* The whole reason it is a transfer: the depositor's own money coming back
       is not earnings, and an income statement that said otherwise would be
       wrong by the size of the deposit. */
    const detail = (await ctx.http().get(`/v1/savings/${saved.id}`).set(auth(user)).expect(200))
      .body as { profitReceivedMinor: number; status: string };
    expect(detail.profitReceivedMinor).toBe(0);
    expect(detail.status).toBe('MATURED');
  });

  it('refuses to move a matured plan into the account it came from', async () => {
    const user = await signup(ctx);
    const saved = await plan(user);
    const account = await bank(user);

    await ctx
      .http()
      .post(`/v1/savings/${saved.id}/mature`)
      .set(auth(user))
      .send({ fromAccountId: account.id, toAccountId: account.id, amountMinor: 100_000 })
      .expect(400);
  });

  it('records the payout in the audit trail', async () => {
    const user = await signup(ctx);
    await bank(user);
    const saved = await plan(user);
    await recordProfit(user, saved.id, 276_000, '2026-04-15');

    await new Promise((resolve) => setTimeout(resolve, 150));

    const events = await ctx.prisma.auditEvent.findMany({
      where: { workspaceId: user.workspaceId, action: 'savings.profit_recorded' },
    });
    expect(events).toHaveLength(1);
  });
});

/**
 * Instalments reaching the books.
 *
 * The whole feature turns on one accounting fact: **putting money into a DPS is
 * not an expense**. Nothing is consumed and nobody is owed — one asset becomes
 * another — so the row this writes is a `TRANSFER`, and if it ever stops being
 * one, net worth is understated by every poisha the household has ever saved
 * and every one of those months looks like a month they overspent.
 *
 * The second thing these tests defend is that it stays optional. Marking an
 * instalment paid moved no money for as long as the endpoint has existed, and a
 * plan with no linked account — or a linked plan whose caller did not name a
 * source — must behave exactly as it did before any of this.
 */
describe('savings instalment deposits', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  type User = Awaited<ReturnType<typeof signup>>;

  /** ৳2,000.00 a month, twelve months — an ordinary DPS. */
  const INSTALMENT = 200_000;

  const account = (user: User, name: string, type: string, openingBalance = 0) =>
    ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name, type, openingBalance })
      .expect(201)
      .then((res) => res.body as { id: string; balanceMinor: number });

  const dpsPlan = (user: User, over: Record<string, unknown> = {}) =>
    ctx
      .http()
      .post('/v1/savings')
      .set(auth(user))
      .send({
        planName: 'ব্র্যাক ডিপিএস',
        planType: 'DPS',
        installmentMinor: INSTALMENT,
        frequency: 'MONTHLY',
        termMonths: 12,
        startDate: '2026-01-10',
        profitRateBps: 800,
        ...over,
      });

  const balances = async (user: User): Promise<Map<string, number>> => {
    const res = await ctx.http().get('/v1/accounts').set(auth(user)).expect(200);
    return new Map(
      (res.body as { id: string; balanceMinor: number }[]).map((a) => [a.id, a.balanceMinor]),
    );
  };

  it('books the instalment as a transfer, not as an expense', async () => {
    const user = await signup(ctx);
    const current = await account(user, 'চলতি হিসাব', 'BANK', 5_000_000);
    const savings = await account(user, 'ডিপিএস হিসাব', 'SAVINGS');
    const plan = (await dpsPlan(user, { linkedAccountId: savings.id }).expect(201)).body;
    const first = (plan.installments as Installment[])[0];

    const paid = await ctx
      .http()
      .post(`/v1/savings/${plan.id}/installments/${first.id}/pay`)
      .set(auth(user))
      .send({ fromAccountId: current.id, paidDate: '2026-01-10' })
      .expect(200);

    expect(paid.body.deposit).toMatchObject({ booked: true, amountMinor: INSTALMENT });
    expect(paid.body.deposit.transactionId).toEqual(expect.any(String));

    /* The money is really in the savings account and really gone from the
       current one — which is the sentence the whole feature exists to make
       true. Before this, ten plans and ৳31,000 of savings. */
    const after = await balances(user);
    expect(after.get(savings.id)).toBe(INSTALMENT);
    expect(after.get(current.id)).toBe(5_000_000 - INSTALMENT);

    /* A TRANSFER, and this is the assertion that matters most. An EXPENSE here
       would understate net worth by the deposit and overstate January's
       spending by the same figure, both in the direction that flatters
       nothing. */
    const tx = await ctx.prisma.transaction.findUniqueOrThrow({
      where: { id: paid.body.deposit.transactionId },
    });
    expect(tx.type).toBe('TRANSFER');
    expect(tx.savingsPlanId).toBe(plan.id);

    // Nothing touched the income statement, in either direction.
    const summary = await ctx
      .http()
      .get('/v1/transactions/summary?month=2026-01')
      .set(auth(user))
      .expect(200);
    expect(summary.body.expenseMinor).toBe(0);
    expect(summary.body.incomeMinor).toBe(0);

    // And the tick remembers which row moved the money.
    const stored = await ctx.prisma.savingsInstallment.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(stored.status).toBe('PAID');
    expect(stored.transactionId).toBe(paid.body.deposit.transactionId);
  });

  it('moves nothing when no account is named, on a plan that has a link', async () => {
    const user = await signup(ctx);
    const current = await account(user, 'চলতি হিসাব', 'BANK', 5_000_000);
    const savings = await account(user, 'ডিপিএস হিসাব', 'SAVINGS');
    const plan = (await dpsPlan(user, { linkedAccountId: savings.id }).expect(201)).body;
    const first = (plan.installments as Installment[])[0];

    const paid = await ctx
      .http()
      .post(`/v1/savings/${plan.id}/installments/${first.id}/pay`)
      .set(auth(user))
      .send({ paidDate: '2026-01-10' })
      .expect(200);

    /* `null`, not `{ booked: false }`. Nothing failed — nothing was asked for,
       which is the behaviour this endpoint has always had and the reason the
       link alone is never enough to move money. */
    expect(paid.body.deposit).toBeNull();
    expect(paid.body.progress.paidCount).toBe(1);

    const after = await balances(user);
    expect(after.get(savings.id)).toBe(0);
    expect(after.get(current.id)).toBe(5_000_000);
    expect(
      await ctx.prisma.transaction.count({
        where: { workspaceId: user.workspaceId, type: 'TRANSFER', deletedAt: null },
      }),
    ).toBe(0);
  });

  it('keeps an unlinked plan exactly as it was', async () => {
    const user = await signup(ctx);
    const current = await account(user, 'চলতি হিসাব', 'BANK', 5_000_000);
    const plan = (await dpsPlan(user).expect(201)).body;
    const first = (plan.installments as Installment[])[0];

    const paid = await ctx
      .http()
      .post(`/v1/savings/${plan.id}/installments/${first.id}/pay`)
      .set(auth(user))
      .send({})
      .expect(200);
    expect(paid.body.deposit).toBeNull();
    expect((await balances(user)).get(current.id)).toBe(5_000_000);

    /* Asking for a transfer on a plan with nowhere to put it is refused rather
       than quietly ignored: ignoring it would tick the instalment and leave
       somebody believing their money had moved. */
    const second = (plan.installments as Installment[])[1];
    const refused = await ctx
      .http()
      .post(`/v1/savings/${plan.id}/installments/${second.id}/pay`)
      .set(auth(user))
      .send({ fromAccountId: current.id })
      .expect(400);
    expect(refused.body.message).toContain('যুক্ত নেই');

    // The refusal wrote nothing at all — not the tick, not a transaction.
    const stored = await ctx.prisma.savingsInstallment.findUniqueOrThrow({
      where: { id: second.id },
    });
    expect(stored.status).toBe('DUE');
    expect(
      await ctx.prisma.transaction.count({
        where: { workspaceId: user.workspaceId, type: 'TRANSFER', deletedAt: null },
      }),
    ).toBe(0);
  });

  it('books what was actually paid when that is not the scheduled figure', async () => {
    const user = await signup(ctx);
    const current = await account(user, 'চলতি হিসাব', 'BANK', 5_000_000);
    const savings = await account(user, 'ডিপিএস হিসাব', 'SAVINGS');
    const plan = (await dpsPlan(user, { linkedAccountId: savings.id }).expect(201)).body;
    const first = (plan.installments as Installment[])[0];

    // A late instalment with the bank's penalty on the same debit.
    await ctx
      .http()
      .post(`/v1/savings/${plan.id}/installments/${first.id}/pay`)
      .set(auth(user))
      .send({ fromAccountId: current.id, amountMinor: 210_000, paidDate: '2026-01-20' })
      .expect(200);

    expect((await balances(user)).get(savings.id)).toBe(210_000);
  });

  it('refuses to move an instalment into the account it came from', async () => {
    const user = await signup(ctx);
    const savings = await account(user, 'ডিপিএস হিসাব', 'SAVINGS', 100_000);
    const plan = (await dpsPlan(user, { linkedAccountId: savings.id }).expect(201)).body;
    const first = (plan.installments as Installment[])[0];

    await ctx
      .http()
      .post(`/v1/savings/${plan.id}/installments/${first.id}/pay`)
      .set(auth(user))
      .send({ fromAccountId: savings.id })
      .expect(400);
  });

  it('only links to a savings account, and can be unlinked again', async () => {
    const user = await signup(ctx);
    const current = await account(user, 'চলতি হিসাব', 'BANK', 5_000_000);
    const savings = await account(user, 'ডিপিএস হিসাব', 'SAVINGS');

    /* The current account is not where a DPS is held, and allowing it would let
       somebody transfer money from an account into itself month after month
       and wonder why nothing accumulated. */
    const refused = await dpsPlan(user, { linkedAccountId: current.id }).expect(400);
    expect(refused.body.message).toContain('সঞ্চয়');

    const plan = (await dpsPlan(user, { linkedAccountId: savings.id }).expect(201)).body;
    expect(plan.linkedAccountId).toBe(savings.id);

    const unlinked = await ctx
      .http()
      .patch(`/v1/savings/${plan.id}`)
      .set(auth(user))
      .send({ linkedAccountId: null })
      .expect(200);
    expect(unlinked.body.linkedAccountId).toBeNull();

    // And an edit that says nothing about the link leaves it alone.
    const relinked = await ctx
      .http()
      .patch(`/v1/savings/${plan.id}`)
      .set(auth(user))
      .send({ linkedAccountId: savings.id })
      .expect(200);
    expect(relinked.body.linkedAccountId).toBe(savings.id);
    const renamed = await ctx
      .http()
      .patch(`/v1/savings/${plan.id}`)
      .set(auth(user))
      .send({ planName: 'ব্র্যাক ডিপিএস — ২' })
      .expect(200);
    expect(renamed.body.linkedAccountId).toBe(savings.id);
  });

  it('never lets a second workspace pay an instalment out of the first one s account', async () => {
    const alice = await signup(ctx);
    const bob = await signup(ctx);
    const savings = await account(alice, 'ডিপিএস হিসাব', 'SAVINGS');
    const bobsBank = await account(bob, 'ববের ব্যাংক', 'BANK', 5_000_000);
    const plan = (await dpsPlan(alice, { linkedAccountId: savings.id }).expect(201)).body;
    const first = (plan.installments as Installment[])[0];

    await ctx
      .http()
      .post(`/v1/savings/${plan.id}/installments/${first.id}/pay`)
      .set(auth(bob))
      .send({ fromAccountId: bobsBank.id })
      .expect(404);

    /* And Alice cannot reach Bob's wallet either: the ledger's own ownership
       check refuses the account, and because the tick lands first, the
       instalment is paid with the failure reported rather than swallowed. */
    const crossed = await ctx
      .http()
      .post(`/v1/savings/${plan.id}/installments/${first.id}/pay`)
      .set(auth(alice))
      .send({ fromAccountId: bobsBank.id })
      .expect(200);
    expect(crossed.body.deposit).toMatchObject({ booked: false, transactionId: null });
    expect(crossed.body.deposit.message).toBe('অ্যাকাউন্ট পাওয়া যায়নি');
    expect((await balances(bob)).get(bobsBank.id)).toBe(5_000_000);
  });
});

/**
 * Profit that has built up against profit that has arrived.
 *
 * A **Sanchayapatra** credits a bank account every month or quarter, so
 * "মুনাফা পেয়েছি" is a real event forty-eight times over its life. A **DPS pays
 * nothing at all before maturity** — principal and profit come together at the
 * end — so a screen offering to record profit received on a running DPS is
 * inviting somebody to file income that has neither been earned nor received.
 * That overstates the year and carries into the tax worksheet.
 *
 * The response therefore says which kind of instrument it is, and how much has
 * accrued. Both are derived. Neither posts anything, and the accrued figure is
 * never income and never an asset under this ledger's cash basis.
 */
describe('savings accrued profit', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  type User = Awaited<ReturnType<typeof signup>>;

  /** Started two years ago, so a fixed date cannot make this test rot. */
  const twoYearsAgo = (): string => {
    const now = new Date();
    return `${now.getUTCFullYear() - 2}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  };

  const make = (user: User, body: Record<string, unknown>) =>
    ctx
      .http()
      .post('/v1/savings')
      .set(auth(user))
      .send(body)
      .expect(201)
      .then((res) => res.body);

  it('calls a DPS AT_MATURITY and a Sanchayapatra PERIODIC', async () => {
    const user = await signup(ctx);

    const dpsPlan = await make(user, {
      planName: 'ব্র্যাক ডিপিএস',
      planType: 'DPS',
      installmentMinor: 200_000,
      termMonths: 60,
      startDate: twoYearsAgo(),
      profitRateBps: 800,
    });
    /* The whole correction in one assertion: a DPS must never look like an
       instrument that has handed anything over. */
    expect(dpsPlan.profitPayout).toBe('AT_MATURITY');

    const certificate = await make(user, {
      planName: 'পরিবার সঞ্চয়পত্র',
      planType: 'SANCHAYPATRA',
      principalMinor: 50_000_000,
      termMonths: 60,
      startDate: twoYearsAgo(),
      profitRateBps: 1104,
      profitCalc: 'SIMPLE',
    });
    expect(certificate.profitPayout).toBe('PERIODIC');

    /* A monthly DPS is `frequency: MONTHLY` and pays out nothing monthly. The
       instalment rhythm is not a payout rhythm, and reading it as one is
       exactly the guess that would put the button back. */
    const monthly = await make(user, {
      planName: 'মাসিক এফডিআর',
      planType: 'FDR',
      principalMinor: 10_000_000,
      frequency: 'MONTHLY',
      termMonths: 12,
      startDate: twoYearsAgo(),
      profitRateBps: 900,
    });
    expect(monthly.profitPayout).toBe('AT_MATURITY');
  });

  it('accrues part of the profit as the term runs, and never more than all of it', async () => {
    const user = await signup(ctx);
    const plan = await make(user, {
      planName: 'ব্র্যাক ডিপিএস',
      planType: 'DPS',
      installmentMinor: 200_000,
      termMonths: 60,
      startDate: twoYearsAgo(),
      profitRateBps: 800,
      profitCalc: 'COMPOUND_MONTHLY',
    });

    // Two years into five: something has built up, and it is not the lot.
    expect(plan.accruedProfitMinor).toBeGreaterThan(0);
    expect(plan.accruedProfitMinor).toBeLessThan(plan.projection.profitMinor);

    /* And nothing was posted for it. Accrued profit is a number to look at; the
       moment it became a ledger row these books would be mixed-basis while
       every statement they serve still declares `basis: 'CASH'`. */
    expect(
      await ctx.prisma.transaction.count({
        where: { workspaceId: user.workspaceId, deletedAt: null },
      }),
    ).toBe(0);
    expect(plan.profitReceivedMinor).toBe(0);
  });

  it('accrues nothing on the day a plan is opened', async () => {
    const user = await signup(ctx);
    const today = new Date().toISOString().slice(0, 10);
    const plan = await make(user, {
      planName: 'আজকের ডিপিএস',
      planType: 'DPS',
      installmentMinor: 200_000,
      termMonths: 60,
      startDate: today,
      profitRateBps: 800,
    });
    // Not one poisha has been on deposit for a month.
    expect(plan.accruedProfitMinor).toBe(0);
  });

  it('stops accruing at the end of the term', async () => {
    const user = await signup(ctx);
    const plan = await make(user, {
      planName: 'পুরনো এফডিআর',
      planType: 'FDR',
      principalMinor: 10_000_000,
      termMonths: 12,
      startDate: twoYearsAgo(),
      profitRateBps: 900,
      profitCalc: 'COMPOUND_QUARTERLY',
    });
    /* A one-year FDR two years old has earned one year of profit, not two. A
       plan somebody forgot to close must not keep growing for ever. */
    expect(plan.accruedProfitMinor).toBe(plan.projection.profitMinor);
  });

  it('counts profit recorded from the khata against the certificate', async () => {
    const user = await signup(ctx);
    const account = (
      await ctx
        .http()
        .post('/v1/accounts')
        .set(auth(user))
        .send({ name: 'সিটি ব্যাংক', type: 'BANK' })
        .expect(201)
    ).body as { id: string };
    const categories = (
      await ctx.http().get('/v1/categories?kind=INCOME').set(auth(user)).expect(200)
    ).body as { id: string }[];
    const plan = await make(user, {
      planName: 'পরিবার সঞ্চয়পত্র',
      planType: 'SANCHAYPATRA',
      principalMinor: 50_000_000,
      termMonths: 60,
      startDate: twoYearsAgo(),
      profitRateBps: 1104,
      profitCalc: 'SIMPLE',
    });

    /* The ordinary income sheet, with "কোন সঞ্চয় থেকে" set — which is the
       primary way profit gets recorded now. The savings screen's own total must
       count it, or the two places disagree about the same money. */
    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: '2026-04-15',
        type: 'INCOME',
        amountMinor: 276_000,
        accountId: account.id,
        categoryId: categories[0]!.id,
        savingsPlanId: plan.id,
        description: 'সঞ্চয়পত্রের মুনাফা',
      })
      .expect(201);

    const detail = (await ctx.http().get(`/v1/savings/${plan.id}`).set(auth(user)).expect(200))
      .body as { profitReceivedMinor: number };
    expect(detail.profitReceivedMinor).toBe(276_000);
  });
});
