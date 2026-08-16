import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, createTestApp, resetDatabase, signup, type TestContext } from './harness';

/**
 * Income tax: what the app will and will not say.
 *
 * The arithmetic is covered slab by slab in packages/core/src/tax.test.ts, so
 * nothing here re-derives a tax figure by hand except where a test's whole point
 * is that the figure travelled the length of the wire intact. What these defend
 * is the boundary around it:
 *
 *  - **a year nobody has checked produces no number, ever.** Three ways to fail
 *    that check are tested — no row at all, a row that is not verified, and a
 *    verified year existing for a *different* year of the same country. The last
 *    is the one that matters most: falling back to another year's slabs is the
 *    failure mode docs/RENEWALS-AND-TAX.md §3.5 exists to forbid, because a
 *    figure computed on stale rates looks exactly like one computed on current
 *    rates and nobody carrying it to their practitioner can tell.
 *  - **the shipped Bangladeshi rows refuse.** The migration seeds FY 2025-26 and
 *    2026-27 with every rate column null, because the feasibility report states
 *    no rates and nothing may be filled in from memory. If somebody ever marks
 *    one verified without transcribing the gazette, this test is what notices.
 *  - **the July–June boundary.** A 30 June and a 1 July transaction belong to
 *    different years, and getting that wrong moves a whole month of salary into
 *    the wrong return.
 *  - **the worksheet works when the calculator does not**, which is the entire
 *    argument of §3.7 for shipping stage 1 first.
 *
 * ## Why the rates in this file are obviously fake
 *
 * The verified regime below belongs to country `ZZ` — the ISO 3166 code reserved
 * for private use — and its slabs are round numbers chosen to make arithmetic
 * checkable by eye. Nothing here is a Bangladeshi rate, nothing here is copied
 * from an Act, and nothing here can be mistaken for one. Testing against real
 * slabs would be the same mistake the whole feature is shaped to prevent: a
 * plausible number, in the repository, that nobody verified.
 */

/** A synthetic country, so no test can ever leave a rate on a real one. */
const TEST_COUNTRY = 'ZZ';

/* Poisha, and round on purpose:
 *
 *   tax free            0 – ৳50,000
 *   10%           ৳50,000 – ৳150,000
 *   20%          ৳150,000 and up
 *
 * On ৳120,000 of salary: (120,000 − 50,000) × 10% = ৳7,000 → 700,000 poisha,
 * and the second band is never reached. */
const THRESHOLD = 5_000_000;
const SALARY = 12_000_000;
const EXPECTED_GROSS_TAX = 700_000;

/** Two ৳5,000 instalments inside the year. */
const DPS_INSTALMENT = 500_000;

const VERIFIED_FIGURES = {
  slabs: [
    { fromMinor: 0, rateBps: 0 },
    { fromMinor: THRESHOLD, rateBps: 1000 },
    { fromMinor: 15_000_000, rateBps: 2000 },
  ],
  thresholdByCategory: { general: THRESHOLD, female: 6_000_000 },
  /* `capShareOfIncomeBps` is deliberately the binding one at these figures:
     15% of ৳10,000 invested is ৳1,500, 1% of ৳120,000 of income is ৳1,200, and
     the absolute cap is ৳10,000. A naive implementation that returned the
     investment percentage would pass every other test in this file and fail the
     one that asks which cap bound it. */
  rebate: { rateOfInvestmentBps: 1500, capShareOfIncomeBps: 100, capAbsoluteMinor: 1_000_000 },
  minimumTaxByArea: { elsewhere: 300_000, dhakaChattogramCity: 500_000 },
  /* Far above anything these tests build, so the surcharge stays out of the way
     of the assertions that are about something else. */
  surchargeBands: [{ fromMinor: 400_000_000_000, rateBps: 1000 }],
};

describe('income tax', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);

    /* `TaxRegime` is global rather than workspace-scoped and is not in the
       harness's truncation list, so these are upserted rather than created:
       the suite has to be re-runnable against a database that already holds
       them. */
    await ctx.prisma.taxRegime.upsert({
      where: {
        country_fiscalYear_version: {
          country: TEST_COUNTRY,
          fiscalYear: '2025-26',
          version: 1,
        },
      },
      create: {
        country: TEST_COUNTRY,
        fiscalYear: '2025-26',
        fiscalYearStart: '2025-07-01',
        fiscalYearEnd: '2026-06-30',
        version: 1,
        ...VERIFIED_FIGURES,
        sourceCitation: 'Synthetic Finance Act — test fixture, not a real rate',
        verified: true,
        verifiedAt: new Date('2026-01-01T00:00:00.000Z'),
        verifiedByName: 'পরীক্ষা',
      },
      update: { ...VERIFIED_FIGURES, verified: true },
    });

    /* The same country, the next year, entered but not checked. This is what
       proves the calculator does not reach sideways for a year it does have. */
    await ctx.prisma.taxRegime.upsert({
      where: {
        country_fiscalYear_version: {
          country: TEST_COUNTRY,
          fiscalYear: '2026-27',
          version: 1,
        },
      },
      create: {
        country: TEST_COUNTRY,
        fiscalYear: '2026-27',
        fiscalYearStart: '2026-07-01',
        fiscalYearEnd: '2027-06-30',
        version: 1,
        sourceCitation: 'Synthetic Finance Act — not yet transcribed',
        verified: false,
      },
      update: { verified: false, slabs: undefined },
    });
  });

  afterAll(async () => {
    await ctx.prisma.taxRegime.deleteMany({ where: { country: TEST_COUNTRY } });
    await ctx.app.close();
  });

  type User = Awaited<ReturnType<typeof signup>>;

  /** A workspace pointed at the synthetic country, with one bank account. */
  const taxpayer = async (): Promise<{ user: User; bankId: string }> => {
    const user = await signup(ctx);
    await ctx
      .http()
      .put('/v1/tax/profile')
      .set(auth(user))
      .send({ country: TEST_COUNTRY, category: 'general', area: 'elsewhere' })
      .expect(200);
    const bank = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'ব্যাংক', type: 'BANK' })
      .expect(201);
    return { user, bankId: bank.body.id as string };
  };

  const categoryId = async (user: User, nameBn: string): Promise<string> => {
    const cats = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    return (cats.body as { id: string; nameBn: string }[]).find((c) => c.nameBn === nameBn)!.id;
  };

  const earn = (user: User, bankId: string, date: string, amountMinor: number, cat: string) =>
    ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({ date, type: 'INCOME', amountMinor, accountId: bankId, categoryId: cat })
      .expect(201);

  const worksheet = (user: User, fiscalYear: string) =>
    ctx.http().get(`/v1/tax/worksheet?fiscalYear=${fiscalYear}`).set(auth(user));

  const estimate = (user: User, fiscalYear: string) =>
    ctx.http().post('/v1/tax/estimate').set(auth(user)).send({ fiscalYear });

  /* ------------------------------------------------------------------ */
  /* The refusal                                                         */
  /* ------------------------------------------------------------------ */

  it('ships the Bangladeshi years with no rates at all, and refuses to compute on them', async () => {
    /* The feasibility report states no slab, no threshold, no rebate cap, no
       minimum tax and no surcharge band. So the seeded rows carry none, and this
       test fails the day somebody fills one in from memory and ticks the box
       without transcribing the gazette. */
    const rows = await ctx.prisma.taxRegime.findMany({
      where: { country: 'BD' },
      orderBy: { fiscalYear: 'asc' },
    });

    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(row.verified).toBe(false);
      expect(row.slabs).toBeNull();
      expect(row.thresholdByCategory).toBeNull();
      expect(row.rebate).toBeNull();
      expect(row.minimumTaxByArea).toBeNull();
      expect(row.surchargeBands).toBeNull();
    }

    const bd = rows.find((row) => row.fiscalYear === '2025-26');
    expect(bd).toBeDefined();
    expect(bd!.fiscalYearStart).toBe('2025-07-01');
    expect(bd!.fiscalYearEnd).toBe('2026-06-30');

    /* A fresh workspace defaults to BD, so this is the out-of-the-box behaviour
       and not a state a test had to arrange. */
    const user = await signup(ctx);
    const refused = await estimate(user, '2025-26').expect(422);
    expect(refused.body.code).toBe('TAX_REGIME_UNVERIFIED');
    expect(refused.body.message).toContain('যাচাই করা হয়নি');
  });

  it('gives the whole worksheet for a year it will not compute, and says why it will not', async () => {
    /* §3.7: stage 1 is worth shipping on its own. Income by head is most of the
       tedium of filing and carries no legal exposure, so an unverified year must
       not take the sheet down with the figure. */
    const { user, bankId } = await taxpayer();
    await ctx.http().put('/v1/tax/profile').set(auth(user)).send({ country: 'BD' }).expect(200);
    await earn(user, bankId, '2025-09-10', SALARY, await categoryId(user, 'বেতন'));

    const sheet = (await worksheet(user, '2025-26').expect(200)).body;

    expect(sheet.totalIncomeMinor).toBe(SALARY);
    expect(sheet.regime.found).toBe(true);
    expect(sheet.regime.verified).toBe(false);
    expect(sheet.regime.refusal).toContain('যাচাই করা হয়নি');
    /* Nothing to choose from until somebody transcribes the year, which is why
       the screen cannot offer a taxpayer category for an unverified year. */
    expect(sheet.regime.categories).toEqual([]);
    expect(sheet.regime.areas).toEqual([]);
    expect(sheet.limits.length).toBeGreaterThan(0);
    /* The sheet carries every input and no tax field whatsoever. */
    expect(sheet.grossTaxMinor).toBeUndefined();
    expect(sheet.payableMinor).toBeUndefined();
  });

  it('refuses a year that has no row at all, differently and in Bengali', async () => {
    const { user } = await taxpayer();
    const refused = await estimate(user, '2019-20').expect(422);
    expect(refused.body.code).toBe('TAX_REGIME_UNVERIFIED');
    expect(refused.body.message).toContain('যোগ করা হয়নি');

    const sheet = (await worksheet(user, '2019-20').expect(200)).body;
    expect(sheet.regime.found).toBe(false);
    expect(sheet.regime.version).toBeNull();
  });

  it('never reaches for another year, even one it has verified', async () => {
    /* The failure §3.5 forbids: 2025-26 is verified for this country and 2026-27
       is not, and the second must not quietly borrow the first's slabs. */
    const { user, bankId } = await taxpayer();
    await earn(user, bankId, '2026-09-10', SALARY, await categoryId(user, 'বেতন'));

    await estimate(user, '2025-26').expect(200);

    const refused = await estimate(user, '2026-27').expect(422);
    expect(refused.body.fiscalYear).toBe('2026-27');
    expect(refused.body.message).toContain('যাচাই করা হয়নি');
  });

  /* ------------------------------------------------------------------ */
  /* The figure                                                          */
  /* ------------------------------------------------------------------ */

  it('shows the slab breakdown, band by band, once the year has been verified', async () => {
    const { user, bankId } = await taxpayer();
    await earn(user, bankId, '2025-09-10', SALARY, await categoryId(user, 'বেতন'));

    const result = (await estimate(user, '2025-26').expect(200)).body;

    expect(result.worksheet.totalIncomeMinor).toBe(SALARY);
    expect(result.estimate.taxableIncomeMinor).toBe(SALARY);
    expect(result.estimate.grossTaxMinor).toBe(EXPECTED_GROSS_TAX);
    expect(result.estimate.citation).toContain('test fixture');

    /* The breakdown, not just the total: one line for the 10% band and none for
       the 20% one, because ৳120,000 never reaches it. */
    const slabLines = (result.estimate.lines as { key: string; rateBps?: number }[]).filter(
      (line) => line.key.startsWith('slab.'),
    );
    expect(slabLines).toHaveLength(1);
    expect(slabLines[0]).toMatchObject({ key: 'slab.1000', rateBps: 1000 });

    /* The salary landed under its head, and the head names the category it came
       from — a figure nobody can trace is a figure nobody can check. */
    const salaries = (result.worksheet.heads as { head: string; amountMinor: number }[]).find(
      (head) => head.head === 'SALARIES',
    );
    expect(salaries).toMatchObject({ head: 'SALARIES', amountMinor: SALARY });
    expect(result.worksheet.heads[0].sources[0]).toMatchObject({
      name: 'বেতন',
      amountMinor: SALARY,
      mapped: true,
    });

    /* The minimum tax is a floor, and ৳5,800 of computed tax clears it. */
    expect(result.estimate.minimumTaxMinor).toBe(0);
    expect(result.estimate.surchargeMinor).toBe(0);
  });

  it('says which of the three caps bound the rebate', async () => {
    /* 15% of ৳10,000 invested is ৳1,500; 1% of ৳120,000 of income is ৳1,200; the
       absolute cap is ৳10,000. The middle one wins, and the sheet has to be able
       to say so — "your rebate was capped by your income" is the sentence that
       tells somebody whether saving more before June would help. */
    const { user, bankId } = await taxpayer();
    await earn(user, bankId, '2025-09-10', SALARY, await categoryId(user, 'বেতন'));

    const plan = (
      await ctx
        .http()
        .post('/v1/savings')
        .set(auth(user))
        .send({
          planName: 'ডিপিএস',
          institution: 'সোনালী ব্যাংক',
          planType: 'DPS',
          installmentMinor: DPS_INSTALMENT,
          frequency: 'MONTHLY',
          termMonths: 12,
          startDate: '2025-08-15',
          profitRateBps: 825,
        })
        .expect(201)
    ).body;

    const [first, second] = plan.installments as { id: string }[];
    for (const [row, paidDate] of [
      [first, '2025-08-16'],
      [second, '2025-09-16'],
    ] as const) {
      await ctx
        .http()
        .post(`/v1/savings/${plan.id}/installments/${row.id}/pay`)
        .set(auth(user))
        .send({ paidDate })
        .expect(200);
    }

    const result = (await estimate(user, '2025-26').expect(200)).body;

    expect(result.worksheet.eligibleInvestmentMinor).toBe(DPS_INSTALMENT * 2);
    expect(result.rebateBoundBy).toBe('income');
    expect(result.estimate.rebateMinor).toBe(120_000);
    expect(result.estimate.netTaxMinor).toBe(EXPECTED_GROSS_TAX - 120_000);

    /* And the itemisation behind it: two instalments, one plan, traceable. */
    const line = (result.worksheet.investments as { id: string }[]).find((l) => l.id === plan.id);
    expect(line).toMatchObject({ kind: 'SAVINGS', paidMinor: DPS_INSTALMENT * 2, payments: 2 });
  });

  it('leaves out a kind of saving the report does not call eligible, and says it did', async () => {
    /* An FDR is not on §3.2's list, and whether it qualifies is a question about
       the Act rather than about this code. It is still shown — a person can ask
       their practitioner about a figure they can see, and cannot ask about one
       the app silently dropped. */
    const { user } = await taxpayer();
    const plan = (
      await ctx
        .http()
        .post('/v1/savings')
        .set(auth(user))
        .send({
          planName: 'এফডিআর',
          planType: 'FDR',
          installmentMinor: DPS_INSTALMENT,
          frequency: 'MONTHLY',
          termMonths: 12,
          startDate: '2025-08-15',
          profitRateBps: 900,
        })
        .expect(201)
    ).body;

    const [first] = plan.installments as { id: string }[];
    await ctx
      .http()
      .post(`/v1/savings/${plan.id}/installments/${first.id}/pay`)
      .set(auth(user))
      .send({ paidDate: '2025-08-16' })
      .expect(200);

    const sheet = (await worksheet(user, '2025-26').expect(200)).body;

    expect(sheet.eligibleInvestmentMinor).toBe(0);
    expect(sheet.investments).toHaveLength(1);
    expect(sheet.investments[0]).toMatchObject({ counted: false, paidMinor: DPS_INSTALMENT });
    expect(sheet.investments[0].note).toContain('যাচাই');
  });

  /* ------------------------------------------------------------------ */
  /* The boundary                                                        */
  /* ------------------------------------------------------------------ */

  it('buckets a 30 June and a 1 July transaction into different fiscal years', async () => {
    /* The one date arithmetic that has to be right. Bangladesh runs July to
       June, so a salary paid on 1 July belongs to the year that is only just
       beginning — and getting it wrong moves a whole month into the wrong
       return. */
    const { user, bankId } = await taxpayer();
    const salary = await categoryId(user, 'বেতন');

    await earn(user, bankId, '2026-06-30', 1_000_000, salary);
    await earn(user, bankId, '2026-07-01', 2_000_000, salary);

    const closing = (await worksheet(user, '2025-26').expect(200)).body;
    expect(closing.from).toBe('2025-07-01');
    expect(closing.to).toBe('2026-06-30');
    expect(closing.totalIncomeMinor).toBe(1_000_000);

    const opening = (await worksheet(user, '2026-27').expect(200)).body;
    expect(opening.from).toBe('2026-07-01');
    expect(opening.to).toBe('2027-06-30');
    expect(opening.totalIncomeMinor).toBe(2_000_000);
  });

  /* ------------------------------------------------------------------ */
  /* Nothing recorded                                                    */
  /* ------------------------------------------------------------------ */

  it('gives a workspace with no income a zero rather than an error', async () => {
    /* Nothing recorded is a fact about the books, not a failure — and somebody
       required to file in a year they earned nothing needs exactly this sheet. */
    const { user } = await taxpayer();

    const result = (await estimate(user, '2025-26').expect(200)).body;

    expect(result.worksheet.totalIncomeMinor).toBe(0);
    expect(result.worksheet.heads).toEqual([]);
    expect(result.estimate.taxableIncomeMinor).toBe(0);
    expect(result.estimate.grossTaxMinor).toBe(0);
    expect(result.estimate.rebateMinor).toBe(0);
    /* Below the threshold, so the minimum tax floor does not bite either. */
    expect(result.estimate.minimumTaxMinor).toBe(0);
    expect(result.estimate.payableMinor).toBe(0);
  });

  /* ------------------------------------------------------------------ */
  /* Housekeeping                                                        */
  /* ------------------------------------------------------------------ */

  it('keeps the whole feature out of the ledger', async () => {
    /* A tax estimate is a statement *about* the books. The moment it could
       change them it would be circular: an estimate that posts a provision
       alters the net wealth the next estimate is computed from. */
    const { user, bankId } = await taxpayer();
    await earn(user, bankId, '2025-09-10', SALARY, await categoryId(user, 'বেতন'));

    const before = await ctx.prisma.ledgerEntry.count({ where: { workspaceId: user.workspaceId } });
    await estimate(user, '2025-26').expect(200);
    await worksheet(user, '2025-26').expect(200);
    const after = await ctx.prisma.ledgerEntry.count({ where: { workspaceId: user.workspaceId } });

    expect(after).toBe(before);
  });

  it('remembers the taxpayer, and defaults to the general one', async () => {
    const user = await signup(ctx);

    const fresh = (await ctx.http().get('/v1/tax/profile').set(auth(user)).expect(200)).body;
    expect(fresh).toMatchObject({ country: 'BD', category: 'general', area: 'elsewhere' });
    /* Reading it does not create it: a workspace that never opens this screen
       should not acquire a row asserting anything about its taxpayer. */
    expect(await ctx.prisma.taxProfile.count({ where: { workspaceId: user.workspaceId } })).toBe(0);

    await ctx
      .http()
      .put('/v1/tax/profile')
      .set(auth(user))
      .send({ category: 'female', area: 'dhakaChattogramCity', tinMasked: '••••1234' })
      .expect(200);

    const saved = (await ctx.http().get('/v1/tax/profile').set(auth(user)).expect(200)).body;
    expect(saved).toMatchObject({ category: 'female', area: 'dhakaChattogramCity' });
  });

  it("cannot see another workspace's income", async () => {
    const mine = await taxpayer();
    const theirs = await taxpayer();
    await earn(
      theirs.user,
      theirs.bankId,
      '2025-09-10',
      SALARY,
      await categoryId(theirs.user, 'বেতন'),
    );

    const sheet = (await worksheet(mine.user, '2025-26').expect(200)).body;
    expect(sheet.totalIncomeMinor).toBe(0);
  });
});
