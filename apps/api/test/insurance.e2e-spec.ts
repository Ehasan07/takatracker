import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, createTestApp, resetDatabase, signup, type TestContext } from './harness';

/**
 * Insurance policies, end to end.
 *
 * A policy is mostly a promise about dates: when it matures, and when the next
 * premium is owed. These tests hold the HTTP layer to that promise — the term
 * is derived exactly once and from what the holder actually supplied, the
 * schedule matches the frequency they pay at, a premium that was paid stays
 * paid at the figure the insurer really took, and nothing about the policy is
 * visible from another workspace.
 */

/** ৳500,000.00 sum assured — an ordinary endowment policy. */
const SUM_ASSURED = 50_000_000;
/** ৳25,000.00 a year. */
const YEARLY_PREMIUM = 2_500_000;

interface Premium {
  id: string;
  index: number;
  dueDate: string;
  amountMinor: number;
  paidDate: string | null;
  status: string;
}

describe('insurance', () => {
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
    ctx.http().post('/v1/insurance').set(auth(user)).send(body);

  /** A plain yearly endowment, so each test only spells out what it changes. */
  const policy = (over: Record<string, unknown> = {}) => ({
    insurer: 'মেটলাইফ বাংলাদেশ',
    policyType: 'এনডাওমেন্ট',
    sumAssuredMinor: SUM_ASSURED,
    premiumMinor: YEARLY_PREMIUM,
    frequency: 'YEARLY',
    startDate: '2026-04-01',
    termMonths: 24,
    nomineeName: 'রেহানা বেগম',
    ...over,
  });

  it('derives maturity from the term, keeps a maturity typed off the document, and insists on one of the two', async () => {
    const user = await signup(ctx);

    // Twenty years from the start date.
    const derived = await create(user, policy({ termMonths: 240 })).expect(201);
    expect(derived.body.startDate).toBe('2026-04-01');
    expect(derived.body.maturityDate).toBe('2046-04-01');
    expect(derived.body.premiums).toHaveLength(20);

    // A date copied off the policy document wins, and the term is read back out
    // of it — twenty years again, so twenty yearly premiums.
    const explicit = await create(
      user,
      policy({ termMonths: undefined, maturityDate: '2046-04-01' }),
    ).expect(201);
    expect(explicit.body.maturityDate).toBe('2046-04-01');
    expect(explicit.body.premiums).toHaveLength(20);

    // Neither one: there is no honest way to guess a term, so it is refused
    // rather than silently defaulted to something the holder never agreed to.
    const refused = await create(
      user,
      policy({ termMonths: undefined, maturityDate: undefined }),
    ).expect(400);
    expect(refused.body.message).toBe('মেয়াদ (মাস) অথবা মেয়াদপূর্তির তারিখ — একটি দিতে হবে');
  });

  it('builds a premium schedule that matches the frequency', async () => {
    const user = await signup(ctx);

    // Twenty-four months, paid four different ways. The start is the 1st, so
    // every due date is simply the 1st of a later month.
    const monthly = Array.from({ length: 24 }, (_, i) => {
      const zeroBased = 2026 * 12 + 3 + i; // April 2026 is month zero of the term
      return `${Math.floor(zeroBased / 12)}-${String((zeroBased % 12) + 1).padStart(2, '0')}-01`;
    });

    const cases = [
      { frequency: 'YEARLY', dueDates: ['2026-04-01', '2027-04-01'] },
      {
        frequency: 'HALF_YEARLY',
        dueDates: ['2026-04-01', '2026-10-01', '2027-04-01', '2027-10-01'],
      },
      {
        frequency: 'QUARTERLY',
        dueDates: [
          '2026-04-01',
          '2026-07-01',
          '2026-10-01',
          '2027-01-01',
          '2027-04-01',
          '2027-07-01',
          '2027-10-01',
          '2028-01-01',
        ],
      },
      { frequency: 'MONTHLY', dueDates: monthly },
    ];

    for (const { frequency, dueDates } of cases) {
      const res = await create(
        user,
        policy({ frequency, premiumMinor: 250_000, insurer: `বীমা — ${frequency}` }),
      ).expect(201);

      const premiums: Premium[] = res.body.premiums;
      expect(premiums.map((row) => row.dueDate)).toEqual(dueDates);
      expect(res.body.premiumCount).toBe(dueDates.length);
      expect(premiums.map((row) => row.index)).toEqual(
        Array.from({ length: dueDates.length }, (_, i) => i + 1),
      );
      expect(premiums.every((row) => row.amountMinor === 250_000)).toBe(true);
      expect(premiums.every((row) => row.status === 'DUE')).toBe(true);

      const stored = await ctx.prisma.premiumPayment.findMany({
        where: { policyId: res.body.id },
      });
      expect(stored).toHaveLength(dueDates.length);
      expect(stored.every((row) => row.workspaceId === user.workspaceId)).toBe(true);
    }

    // A policy kept only for its sum assured has nothing to pay, so it gets no
    // rows rather than a term's worth of zero-taka reminders.
    const noPremium = await create(
      user,
      policy({ premiumMinor: 0, insurer: 'শুধু কভারেজ' }),
    ).expect(201);
    expect(noPremium.body.premiums).toEqual([]);
    expect(noPremium.body.nextDue).toBeNull();
  });

  it('points nextDue at the earliest unpaid premium on the list, and at nothing once all are paid', async () => {
    const user = await signup(ctx);
    const created = (await create(user, policy()).expect(201)).body;
    const [first, second] = created.premiums as Premium[];

    const listed = async () => {
      const res = await ctx.http().get('/v1/insurance').set(auth(user)).expect(200);
      return res.body.find((row: { id: string }) => row.id === created.id);
    };

    // The list is what the reminder card reads, so it has to name the row that
    // is actually owed — not the first row in the schedule.
    expect((await listed()).nextDue).toMatchObject({ id: first.id, dueDate: first.dueDate });

    const pay = (premiumId: string, paidDate: string) =>
      ctx
        .http()
        .post(`/v1/insurance/${created.id}/premiums/${premiumId}/pay`)
        .set(auth(user))
        .send({ paidDate })
        .expect(200);

    await pay(first.id, '2026-04-03');
    const afterFirst = await listed();
    expect(afterFirst.nextDue).toMatchObject({ id: second.id, dueDate: second.dueDate });
    expect(afterFirst.paidCount).toBe(1);
    expect(afterFirst.paidMinor).toBe(YEARLY_PREMIUM);

    await pay(second.id, '2027-04-02');
    const settled = await listed();
    // Nothing is owed, so the card must show nothing rather than the last row
    // it happened to find.
    expect(settled.nextDue).toBeNull();
    expect(settled.paidCount).toBe(2);
    expect(settled.paidMinor).toBe(YEARLY_PREMIUM * 2);
  });

  it('records what the insurer actually took, not what the schedule expected', async () => {
    const user = await signup(ctx);
    const created = (await create(user, policy()).expect(201)).body;
    const [first, second] = created.premiums as Premium[];

    // ৳26,000: the yearly premium plus a late fee the insurer added.
    const overridden = 2_600_000;
    const res = await ctx
      .http()
      .post(`/v1/insurance/${created.id}/premiums/${first.id}/pay`)
      .set(auth(user))
      .send({ paidDate: '2026-05-11', amountMinor: overridden })
      .expect(200);

    const rows = res.body.premiums as Premium[];
    expect(rows.find((r) => r.id === first.id)).toMatchObject({
      status: 'PAID',
      paidDate: '2026-05-11',
      amountMinor: overridden,
    });
    // The premium that has not been paid yet still expects the scheduled figure.
    expect(rows.find((r) => r.id === second.id)?.amountMinor).toBe(YEARLY_PREMIUM);
    // What went out of the bank account is what the total has to show.
    expect(res.body.paidMinor).toBe(overridden);
    expect(res.body.premiumMinor).toBe(YEARLY_PREMIUM);

    const stored = await ctx.prisma.premiumPayment.findUniqueOrThrow({ where: { id: first.id } });
    expect(stored.amountMinor).toBe(BigInt(overridden));
    expect(stored.status).toBe('PAID');
  });

  it('refuses to take the same premium twice', async () => {
    const user = await signup(ctx);
    const created = (await create(user, policy()).expect(201)).body;
    const first = (created.premiums as Premium[])[0];

    await ctx
      .http()
      .post(`/v1/insurance/${created.id}/premiums/${first.id}/pay`)
      .set(auth(user))
      .send({ paidDate: '2026-04-03', amountMinor: YEARLY_PREMIUM })
      .expect(200);

    // Otherwise a double tap doubles the year's outgoings on the balance sheet.
    const again = await ctx
      .http()
      .post(`/v1/insurance/${created.id}/premiums/${first.id}/pay`)
      .set(auth(user))
      .send({ paidDate: '2026-04-04', amountMinor: YEARLY_PREMIUM })
      .expect(400);
    expect(again.body.message).toBe('এই প্রিমিয়াম আগেই পরিশোধ করা হয়েছে');

    const after = await ctx.http().get(`/v1/insurance/${created.id}`).set(auth(user)).expect(200);
    expect(after.body.paidCount).toBe(1);
    expect(after.body.paidMinor).toBe(YEARLY_PREMIUM);
  });

  it('stores the policy number exactly as masked and never echoes a full one', async () => {
    const user = await signup(ctx);
    const masked = '••••-••••-4321';
    // A policy number is enough to impersonate the holder over the phone, so
    // the API has no field for the whole thing at all. Sending one anyway must
    // drop it on the floor rather than quietly persist it.
    const full = 'METLIFE-9988-7766-4321';

    const created = await create(
      user,
      policy({ policyNumberMasked: masked, policyNumber: full }),
    ).expect(201);

    // Byte for byte, including the bullets — this string goes straight onto a
    // card, and a re-masking pass would mangle whatever convention the user used.
    expect(created.body.policyNumberMasked).toBe(masked);

    const detail = await ctx
      .http()
      .get(`/v1/insurance/${created.body.id}`)
      .set(auth(user))
      .expect(200);
    const list = await ctx.http().get('/v1/insurance').set(auth(user)).expect(200);

    for (const body of [created.body, detail.body, list.body]) {
      expect(JSON.stringify(body)).not.toContain(full);
    }

    const stored = await ctx.prisma.insurancePolicy.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(stored.policyNumberMasked).toBe(masked);
    expect(
      JSON.stringify(stored, (_k, v) => (typeof v === 'bigint' ? String(v) : v)),
    ).not.toContain(full);
  });

  it('soft deletes: gone from the list and from detail, still on disk', async () => {
    const user = await signup(ctx);
    const created = (await create(user, policy()).expect(201)).body;

    const removed = await ctx
      .http()
      .delete(`/v1/insurance/${created.id}`)
      .set(auth(user))
      .expect(200);
    expect(removed.body.id).toBe(created.id);

    expect((await ctx.http().get('/v1/insurance').set(auth(user)).expect(200)).body).toEqual([]);
    await ctx.http().get(`/v1/insurance/${created.id}`).set(auth(user)).expect(404);
    await ctx
      .http()
      .patch(`/v1/insurance/${created.id}`)
      .set(auth(user))
      .send({ insurer: 'x' })
      .expect(404);
    await ctx.http().delete(`/v1/insurance/${created.id}`).set(auth(user)).expect(404);

    // Years of premiums leaving a bank account still need an explanation, so
    // the row stays readable behind deletedAt with its schedule intact.
    const stored = await ctx.prisma.insurancePolicy.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(stored.deletedAt).not.toBeNull();
    expect(await ctx.prisma.premiumPayment.count({ where: { policyId: created.id } })).toBe(2);
  });

  /**
   * The one that matters most. A policy carries a nominee, a sum assured and an
   * insurer; leaking one across a workspace boundary is a data breach, not a
   * bug, so every verb is checked rather than just the read.
   */
  it('never lets a second workspace touch the first one s policy', async () => {
    const alice = await signup(ctx);
    const bob = await signup(ctx);

    const created = (await create(alice, policy({ insurer: 'অ্যালিসের বীমা' })).expect(201)).body;
    const premiumId = (created.premiums as Premium[])[0].id;

    await ctx.http().get(`/v1/insurance/${created.id}`).set(auth(bob)).expect(404);
    await ctx
      .http()
      .patch(`/v1/insurance/${created.id}`)
      .set(auth(bob))
      .send({ nomineeName: 'বব' })
      .expect(404);
    await ctx
      .http()
      .post(`/v1/insurance/${created.id}/premiums/${premiumId}/pay`)
      .set(auth(bob))
      .send({})
      .expect(404);
    await ctx.http().delete(`/v1/insurance/${created.id}`).set(auth(bob)).expect(404);

    // Not "an empty-looking list" — an empty one.
    expect((await ctx.http().get('/v1/insurance').set(auth(bob)).expect(200)).body).toEqual([]);

    // Nothing Bob did left a mark on Alice's policy.
    const mine = await ctx.http().get(`/v1/insurance/${created.id}`).set(auth(alice)).expect(200);
    expect(mine.body.insurer).toBe('অ্যালিসের বীমা');
    expect(mine.body.nomineeName).toBe('রেহানা বেগম');
    expect(mine.body.paidCount).toBe(0);
  });

  it('records create, update and premium payment in the audit trail', async () => {
    const user = await signup(ctx);
    const created = (await create(user, policy()).expect(201)).body;
    const premiumId = (created.premiums as Premium[])[0].id;

    await ctx
      .http()
      .patch(`/v1/insurance/${created.id}`)
      .set(auth(user))
      .send({ status: 'LAPSED' })
      .expect(200);
    await ctx
      .http()
      .post(`/v1/insurance/${created.id}/premiums/${premiumId}/pay`)
      .set(auth(user))
      .send({ paidDate: '2026-04-03' })
      .expect(200);

    // The audit write is fire-and-forget, so let the event loop settle first.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const events = await ctx.prisma.auditEvent.findMany({
      where: { workspaceId: user.workspaceId, action: { startsWith: 'insurance.' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.action)).toEqual([
      'insurance.policy_created',
      'insurance.policy_updated',
      'insurance.premium_paid',
    ]);
    expect(events.map((e) => e.entity)).toEqual([
      'InsurancePolicy',
      'InsurancePolicy',
      'PremiumPayment',
    ]);
    expect(events.map((e) => e.entityId)).toEqual([created.id, created.id, premiumId]);
    expect(events.every((e) => e.actorUserId === user.id)).toBe(true);
  });

  /**
   * `insurance.policy_deleted` is in AUDIT_ACTIONS but nothing emits it:
   * remove() logs `insurance.policy_updated` with `{ deleted: true }` in the
   * after-image. Filtering the timeline by action — which is what the index on
   * (workspaceId, action) exists for — therefore cannot surface a deletion, and
   * a deletion is the event you go to an audit log to find.
   *
   * Marked `it.fails` deliberately: the assertion below is the one we want, and
   * this test will start failing the day the service starts emitting it.
   */
  it('records a deletion under its own audit action', async () => {
    const user = await signup(ctx);
    const created = (await create(user, policy()).expect(201)).body;
    await ctx.http().delete(`/v1/insurance/${created.id}`).set(auth(user)).expect(200);

    await new Promise((resolve) => setTimeout(resolve, 150));

    const events = await ctx.prisma.auditEvent.findMany({
      where: { workspaceId: user.workspaceId, action: { startsWith: 'insurance.' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.action)).toEqual([
      'insurance.policy_created',
      'insurance.policy_deleted',
    ]);
  });
});
