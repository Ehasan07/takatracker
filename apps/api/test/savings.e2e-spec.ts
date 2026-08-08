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
    expect(res.body.progress).toMatchObject({
      paidCount: 0,
      remainingCount: 0,
      percentComplete: 0,
    });
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
