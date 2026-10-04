import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LoanInterestAccrualService } from '../src/loans/loan-interest-accrual.service';
import { auth, createTestApp, resetDatabase, signup, type TestContext } from './harness';

/**
 * The loan ledger, end to end.
 *
 * The point of most of these tests is not that the loan module returns the
 * right JSON — it is that the *ledger* agrees with it. A loan module that
 * reports ৳55,000 outstanding while the balance sheet says something else is
 * worse than no loan module at all, so nearly every case below cross-checks
 * against `/reports/balance-sheet` or `/reports/cash-flow`.
 */

/**
 * Calendar dates in Asia/Dhaka, the workspace's timezone, because that is the
 * day the API counts from. Neither the UTC day nor the machine's own day will
 * do: for the first six hours after midnight in Dhaka the UTC day is still
 * yesterday, and CI runs in UTC — so "15 days ago" would arrive as 16 and every
 * overdue count would be off by one.
 */
const dhakaDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' });
const shiftDays = (n: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return dhakaDay.format(d);
};
const daysAgo = (n: number): string => shiftDays(-n);
const daysAhead = (n: number): string => shiftDays(n);

interface Bucket {
  totalMinor: number;
  repaidMinor: number;
  outstandingMinor: number;
  overdueMinor: number;
  upcomingMinor: number;
  count: number;
}

describe('loans', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  /** A workspace with one cash account holding ৳200,000. */
  async function workspaceWithCash(): Promise<{
    user: Awaited<ReturnType<typeof signup>>;
    cashId: string;
  }> {
    const user = await signup(ctx);
    const cash = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'নগদ', type: 'CASH', openingBalance: 20_000_000 })
      .expect(201);
    return { user, cashId: cash.body.id as string };
  }

  /**
   * Everything ever credited to the workspace's income nominal, poisha.
   *
   * Read off the account rather than from `/transactions/summary`, which windows
   * to one calendar month. Interest is recognised on the day it was *earned*, so
   * a monthly window would silently miss an accrual dated two months back and
   * the test would pass by looking in the wrong place.
   */
  async function incomeMinor(workspaceId: string): Promise<number> {
    const nominal = await ctx.prisma.account.findFirst({
      where: { workspaceId, systemKey: 'SYSTEM_INCOME' },
      select: { id: true },
    });
    const total = await ctx.prisma.ledgerEntry.aggregate({
      where: {
        workspaceId,
        accountId: nominal?.id ?? '',
        transaction: { deletedAt: null },
      },
      _sum: { amountMinor: true },
    });
    return Number(total._sum.amountMinor ?? 0n);
  }

  it('records a borrowed loan as a liability, not as income', async () => {
    const { user, cashId } = await workspaceWithCash();

    const created = await ctx
      .http()
      .post('/v1/loans')
      .set(auth(user))
      .send({
        personName: 'করিম',
        personPhone: '01711000000',
        direction: 'BORROWED',
        principalMinor: 10_000_000, // ৳100,000
        interestType: 'NONE',
        loanDate: daysAgo(10),
        dueDate: daysAhead(20),
        accountId: cashId,
      })
      .expect(201);

    expect(created.body.loan.loanNumber).toBe('L-0001');
    expect(created.body.progress.outstandingMinor).toBe(10_000_000);

    // The cash actually arrived.
    const accounts = await ctx.http().get('/v1/accounts').set(auth(user)).expect(200);
    const cash = accounts.body.find((a: { id: string }) => a.id === cashId);
    expect(cash.balanceMinor).toBe(30_000_000); // 200,000 + 100,000

    // And it is a liability, not income. This is the requirement that matters.
    const sheet = await ctx.http().get('/v1/reports/balance-sheet').set(auth(user)).expect(200);
    expect(sheet.body.liabilitiesMinor).toBe(10_000_000);
    expect(sheet.body.netWorthMinor).toBe(20_000_000); // unchanged: borrowing makes nobody richer

    const summary = await ctx.http().get('/v1/transactions/summary').set(auth(user)).expect(200);
    expect(summary.body.incomeMinor).toBe(0);
    expect(summary.body.expenseMinor).toBe(0);
  });

  it('walks the user s own worked example down to ৳55,000', async () => {
    const { user, cashId } = await workspaceWithCash();

    const loan = await ctx
      .http()
      .post('/v1/loans')
      .set(auth(user))
      .send({
        personName: 'রহিম',
        direction: 'BORROWED',
        principalMinor: 10_000_000,
        interestType: 'NONE',
        loanDate: daysAgo(30),
        accountId: cashId,
      })
      .expect(201);
    const loanId = loan.body.loan.id as string;

    const pay = async (amountMinor: number, when: string) =>
      ctx
        .http()
        .post(`/v1/loans/${loanId}/payments`)
        .set(auth(user))
        .send({ date: when, amountMinor, method: 'CASH', accountId: cashId })
        .expect(201);

    expect((await pay(2_000_000, daysAgo(20))).body.progress.outstandingMinor).toBe(8_000_000);
    expect((await pay(1_500_000, daysAgo(15))).body.progress.outstandingMinor).toBe(6_500_000);
    const third = await pay(1_000_000, daysAgo(5));
    expect(third.body.progress.outstandingMinor).toBe(5_500_000);
    expect(third.body.progress.paidMinor).toBe(4_500_000);
    expect(third.body.loan.status).toBe('ACTIVE');

    // The running balance the user will actually read, row by row.
    const balances = third.body.statement.map((r: { balanceMinor: number }) => r.balanceMinor);
    expect(balances).toEqual([10_000_000, 8_000_000, 6_500_000, 5_500_000]);

    // The ledger says the same thing, independently.
    const sheet = await ctx.http().get('/v1/reports/balance-sheet').set(auth(user)).expect(200);
    expect(sheet.body.liabilitiesMinor).toBe(5_500_000);
  });

  it('settles to zero and completes itself', async () => {
    const { user, cashId } = await workspaceWithCash();
    const loan = await ctx
      .http()
      .post('/v1/loans')
      .set(auth(user))
      .send({
        personName: 'সালমা',
        direction: 'BORROWED',
        principalMinor: 5_000_000,
        interestType: 'NONE',
        loanDate: daysAgo(40),
        accountId: cashId,
      })
      .expect(201);

    const done = await ctx
      .http()
      .post(`/v1/loans/${loan.body.loan.id}/payments`)
      .set(auth(user))
      .send({ date: daysAgo(1), amountMinor: 5_000_000, method: 'BANK', accountId: cashId })
      .expect(201);

    expect(done.body.progress.outstandingMinor).toBe(0);
    expect(done.body.progress.isSettled).toBe(true);
    expect(done.body.loan.status).toBe('COMPLETED');

    const sheet = await ctx.http().get('/v1/reports/balance-sheet').set(auth(user)).expect(200);
    expect(sheet.body.liabilitiesMinor).toBe(0);
  });

  it('refuses a payment larger than what is left', async () => {
    const { user, cashId } = await workspaceWithCash();
    const loan = await ctx
      .http()
      .post('/v1/loans')
      .set(auth(user))
      .send({
        personName: 'জামাল',
        direction: 'LENT',
        principalMinor: 1_000_000,
        interestType: 'NONE',
        loanDate: daysAgo(3),
        accountId: cashId,
      })
      .expect(201);

    const res = await ctx
      .http()
      .post(`/v1/loans/${loan.body.loan.id}/payments`)
      .set(auth(user))
      .send({ date: daysAgo(1), amountMinor: 1_500_000, method: 'CASH', accountId: cashId })
      .expect(400);
    // The message has to name the figure, or the user cannot act on it.
    expect(String(res.body.message)).toMatch(/১০,০০০|10,000|10000/);
  });

  it('lends money as a receivable, and collecting it is not income', async () => {
    const { user, cashId } = await workspaceWithCash();

    const loan = await ctx
      .http()
      .post('/v1/loans')
      .set(auth(user))
      .send({
        personName: 'ফরিদ',
        direction: 'LENT',
        principalMinor: 6_000_000,
        interestType: 'NONE',
        loanDate: daysAgo(10),
        accountId: cashId,
      })
      .expect(201);

    let sheet = await ctx.http().get('/v1/reports/balance-sheet').set(auth(user)).expect(200);
    // Lending moves money between two assets; net worth does not budge.
    expect(sheet.body.netWorthMinor).toBe(20_000_000);
    expect(sheet.body.liquidMinor).toBe(14_000_000);

    await ctx
      .http()
      .post(`/v1/loans/${loan.body.loan.id}/payments`)
      .set(auth(user))
      .send({
        date: daysAgo(2),
        amountMinor: 2_000_000,
        method: 'MOBILE_WALLET',
        accountId: cashId,
      })
      .expect(201);

    sheet = await ctx.http().get('/v1/reports/balance-sheet').set(auth(user)).expect(200);
    expect(sheet.body.liquidMinor).toBe(16_000_000);
    expect(sheet.body.netWorthMinor).toBe(20_000_000);

    const summary = await ctx.http().get('/v1/transactions/summary').set(auth(user)).expect(200);
    expect(summary.body.incomeMinor).toBe(0); // getting your own money back is not earning
  });

  it('keeps the ledger and the agreement in step on an interest-bearing loan', async () => {
    const { user, cashId } = await workspaceWithCash();

    const loan = await ctx
      .http()
      .post('/v1/loans')
      .set(auth(user))
      .send({
        personName: 'নাসিমা',
        direction: 'LENT',
        principalMinor: 10_000_000,
        interestType: 'FIXED',
        interestMinor: 500_000, // ৳5,000 agreed
        loanDate: daysAgo(60),
        accountId: cashId,
      })
      .expect(201);
    const loanId = loan.body.loan.id as string;

    expect(loan.body.progress.totalPayableMinor).toBe(10_500_000);

    const settled = await ctx
      .http()
      .post(`/v1/loans/${loanId}/payments`)
      .set(auth(user))
      .send({ date: daysAgo(1), amountMinor: 10_500_000, method: 'CASH', accountId: cashId })
      .expect(201);
    expect(settled.body.progress.outstandingMinor).toBe(0);

    // No phantom receivable left behind: the two views of the same loan agree.
    const statement = await ctx
      .http()
      .get(`/v1/loans/${loanId}/statement?preset=thisYear`)
      .set(auth(user))
      .expect(200);
    expect(statement.body.closingMinor).toBe(0);

    const sheet = await ctx.http().get('/v1/reports/balance-sheet').set(auth(user)).expect(200);
    expect(sheet.body.liquidMinor).toBe(20_500_000);

    /* The interest — and only the interest — is income, and exactly once.
     *
     * It reaches the books through the accrual now, not through the repayment:
     * `addPayment` recognises whatever the terms have earned by the payment's
     * own date *before* posting the money, and the repayment itself then books
     * no income at all. A flat fee is owed in full from day one, so the entry is
     * dated beside the disbursement rather than at the moment somebody paid —
     * which is why this is read off the account and not out of a month's
     * summary. */
    expect(await incomeMinor(user.workspaceId)).toBe(500_000);
  });

  it('marks a loan overdue once its due date has passed', async () => {
    const { user, cashId } = await workspaceWithCash();
    await ctx
      .http()
      .post('/v1/loans')
      .set(auth(user))
      .send({
        personName: 'হাসান',
        direction: 'LENT',
        principalMinor: 3_000_000,
        interestType: 'NONE',
        loanDate: daysAgo(90),
        dueDate: daysAgo(15),
        accountId: cashId,
      })
      .expect(201);

    const list = await ctx.http().get('/v1/loans').set(auth(user)).expect(200);
    expect(list.body[0].status).toBe('OVERDUE');
    expect(list.body[0].progress.daysOverdue).toBe(15);

    const dash = await ctx.http().get('/v1/loans/dashboard').set(auth(user)).expect(200);
    const lent = dash.body.lent as Bucket;
    expect(lent.overdueMinor).toBe(3_000_000);
    expect(lent.upcomingMinor).toBe(0);
  });

  it('adds up the dashboard for both directions', async () => {
    const { user, cashId } = await workspaceWithCash();
    const make = (direction: string, principalMinor: number, dueDate: string) =>
      ctx
        .http()
        .post('/v1/loans')
        .set(auth(user))
        .send({
          personName: `${direction}-${principalMinor}`,
          direction,
          principalMinor,
          interestType: 'NONE',
          loanDate: daysAgo(20),
          dueDate,
          accountId: cashId,
        })
        .expect(201);

    await make('BORROWED', 4_000_000, daysAhead(10));
    await make('BORROWED', 2_000_000, daysAhead(200));
    const lent = await make('LENT', 3_000_000, daysAhead(5));

    await ctx
      .http()
      .post(`/v1/loans/${lent.body.loan.id}/payments`)
      .set(auth(user))
      .send({ date: daysAgo(1), amountMinor: 1_000_000, method: 'CASH', accountId: cashId })
      .expect(201);

    const dash = await ctx.http().get('/v1/loans/dashboard').set(auth(user)).expect(200);
    expect(dash.body.borrowed as Bucket).toMatchObject({
      totalMinor: 6_000_000,
      outstandingMinor: 6_000_000,
      count: 2,
      upcomingMinor: 4_000_000, // only the one due inside 30 days
    });
    expect(dash.body.lent as Bucket).toMatchObject({
      totalMinor: 3_000_000,
      repaidMinor: 1_000_000,
      outstandingMinor: 2_000_000,
      count: 1,
    });
  });

  it('finds a loan by number, name, phone and reference', async () => {
    const { user, cashId } = await workspaceWithCash();
    const loan = await ctx
      .http()
      .post('/v1/loans')
      .set(auth(user))
      .send({
        personName: 'মিজানুর রহমান',
        personPhone: '01912345678',
        direction: 'LENT',
        principalMinor: 7_500_000,
        interestType: 'NONE',
        loanDate: daysAgo(5),
        accountId: cashId,
        note: 'দোকানের জন্য',
      })
      .expect(201);

    await ctx
      .http()
      .post(`/v1/loans/${loan.body.loan.id}/payments`)
      .set(auth(user))
      .send({
        date: daysAgo(1),
        amountMinor: 500_000,
        method: 'BANK',
        accountId: cashId,
        referenceNumber: 'CHQ-8842',
      })
      .expect(201);

    for (const q of ['L-0001', 'মিজান', '01912345678', 'দোকান', 'CHQ-8842', '75000']) {
      const res = await ctx
        .http()
        .get(`/v1/loans?q=${encodeURIComponent(q)}`)
        .set(auth(user))
        .expect(200);
      expect(res.body, `search for ${q}`).toHaveLength(1);
    }

    const miss = await ctx.http().get('/v1/loans?q=কেউ-না').set(auth(user)).expect(200);
    expect(miss.body).toHaveLength(0);
  });

  it('consolidates every loan with one person into a party ledger', async () => {
    const { user, cashId } = await workspaceWithCash();

    const first = await ctx
      .http()
      .post('/v1/loans')
      .set(auth(user))
      .send({
        personName: 'আফরোজা',
        direction: 'LENT',
        principalMinor: 4_000_000,
        interestType: 'NONE',
        loanDate: daysAgo(40),
        accountId: cashId,
      })
      .expect(201);
    const personId = first.body.person.id as string;

    await ctx
      .http()
      .post('/v1/loans')
      .set(auth(user))
      .send({
        personId,
        direction: 'LENT',
        principalMinor: 1_000_000,
        interestType: 'NONE',
        loanDate: daysAgo(20),
        accountId: cashId,
      })
      .expect(201);

    await ctx
      .http()
      .post(`/v1/loans/${first.body.loan.id}/payments`)
      .set(auth(user))
      .send({ date: daysAgo(10), amountMinor: 1_500_000, method: 'CASH', accountId: cashId })
      .expect(201);

    const ledger = await ctx
      .http()
      .get(`/v1/loans/people/${personId}/ledger?preset=thisYear`)
      .set(auth(user))
      .expect(200);

    expect(ledger.body.loans).toHaveLength(2);
    expect(ledger.body.receivableMinor).toBe(3_500_000);
    expect(ledger.body.closingMinor).toBe(ledger.body.receivableMinor);
    // Every movement is present, in date order, with a running balance.
    expect(ledger.body.rows).toHaveLength(3);
    expect(ledger.body.rows.at(-1).balanceMinor).toBe(3_500_000);
  });

  it('reverses the ledger when a payment is deleted', async () => {
    const { user, cashId } = await workspaceWithCash();
    const loan = await ctx
      .http()
      .post('/v1/loans')
      .set(auth(user))
      .send({
        personName: 'তানভীর',
        direction: 'BORROWED',
        principalMinor: 2_000_000,
        interestType: 'NONE',
        loanDate: daysAgo(10),
        accountId: cashId,
      })
      .expect(201);

    const paid = await ctx
      .http()
      .post(`/v1/loans/${loan.body.loan.id}/payments`)
      .set(auth(user))
      .send({ date: daysAgo(2), amountMinor: 800_000, method: 'CASH', accountId: cashId })
      .expect(201);
    const paymentId = paid.body.payments[0].id as string;

    const after = await ctx
      .http()
      .delete(`/v1/loans/${loan.body.loan.id}/payments/${paymentId}`)
      .set(auth(user))
      .expect(200);

    expect(after.body.progress.paidMinor).toBe(0);
    expect(after.body.progress.outstandingMinor).toBe(2_000_000);

    const sheet = await ctx.http().get('/v1/reports/balance-sheet').set(auth(user)).expect(200);
    expect(sheet.body.liabilitiesMinor).toBe(2_000_000);
    expect(sheet.body.liquidMinor).toBe(22_000_000);
  });

  it('clears the balance sheet when a loan is cancelled', async () => {
    const { user, cashId } = await workspaceWithCash();
    const loan = await ctx
      .http()
      .post('/v1/loans')
      .set(auth(user))
      .send({
        personName: 'ভুল এন্ট্রি',
        direction: 'BORROWED',
        principalMinor: 9_000_000,
        interestType: 'NONE',
        loanDate: daysAgo(1),
        accountId: cashId,
      })
      .expect(201);

    const cancelled = await ctx
      .http()
      .post(`/v1/loans/${loan.body.loan.id}/cancel`)
      .set(auth(user))
      .send({})
      .expect(200);
    expect(cancelled.body.loan.status).toBe('CANCELLED');

    // A cancelled loan must not leave a debt hanging on the balance sheet.
    const sheet = await ctx.http().get('/v1/reports/balance-sheet').set(auth(user)).expect(200);
    expect(sheet.body.liabilitiesMinor).toBe(0);
    expect(sheet.body.liquidMinor).toBe(20_000_000);
  });

  it('refuses to cancel a loan that has been partly repaid', async () => {
    const { user, cashId } = await workspaceWithCash();
    const loan = await ctx
      .http()
      .post('/v1/loans')
      .set(auth(user))
      .send({
        personName: 'শাহীন',
        direction: 'BORROWED',
        principalMinor: 3_000_000,
        interestType: 'NONE',
        loanDate: daysAgo(10),
        accountId: cashId,
      })
      .expect(201);

    await ctx
      .http()
      .post(`/v1/loans/${loan.body.loan.id}/payments`)
      .set(auth(user))
      .send({ date: daysAgo(1), amountMinor: 500_000, method: 'CASH', accountId: cashId })
      .expect(201);

    await ctx
      .http()
      .post(`/v1/loans/${loan.body.loan.id}/cancel`)
      .set(auth(user))
      .send({})
      .expect(400);
  });

  it('never shows one workspace a loan belonging to another', async () => {
    const { user: mine, cashId } = await workspaceWithCash();
    const loan = await ctx
      .http()
      .post('/v1/loans')
      .set(auth(mine))
      .send({
        personName: 'গোপন',
        direction: 'LENT',
        principalMinor: 1_000_000,
        interestType: 'NONE',
        loanDate: daysAgo(2),
        accountId: cashId,
      })
      .expect(201);

    const stranger = await signup(ctx);
    await ctx.http().get(`/v1/loans/${loan.body.loan.id}`).set(auth(stranger)).expect(404);
    await ctx
      .http()
      .post(`/v1/loans/${loan.body.loan.id}/payments`)
      .set(auth(stranger))
      .send({ date: daysAgo(1), amountMinor: 100, method: 'CASH', accountId: cashId })
      .expect(404);

    const theirs = await ctx.http().get('/v1/loans').set(auth(stranger)).expect(200);
    expect(theirs.body).toHaveLength(0);
  });

  it('writes an audit trail for every loan movement', async () => {
    const { user, cashId } = await workspaceWithCash();
    const loan = await ctx
      .http()
      .post('/v1/loans')
      .set(auth(user))
      .send({
        personName: 'অডিট',
        direction: 'LENT',
        principalMinor: 1_000_000,
        interestType: 'NONE',
        loanDate: daysAgo(2),
        accountId: cashId,
      })
      .expect(201);

    await ctx
      .http()
      .post(`/v1/loans/${loan.body.loan.id}/payments`)
      .set(auth(user))
      .send({ date: daysAgo(1), amountMinor: 400_000, method: 'CASH', accountId: cashId })
      .expect(201);

    // The audit write is fire-and-forget, so let the event loop settle first.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const events = await ctx.prisma.auditEvent.findMany({
      where: { workspaceId: user.workspaceId, action: { startsWith: 'loan.' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.action)).toEqual(['loan.created', 'loan.payment_added']);
    expect(events.every((e) => e.actorUserId === user.id)).toBe(true);
  });

  /* -------------------------------------------------------------------------
   * Interest accrual.
   *
   * The defect: interest was derived for display and only *posted* when somebody
   * paid, so a receivable understated what was owed for as long as nobody did.
   *
   * Fixed dates throughout, and a fixed `now` handed to the sweep, so the
   * figures below are the same on any day the suite is run. Every one of them is
   * checkable on paper: ৳100,000 at 12% is ৳32.8767 a day, so thirty days is
   * ৳986.30, and 1 January to 31 March is 89 days — ৳2,926.02.
   * ---------------------------------------------------------------------- */
  describe('interest accrual', () => {
    /** Mid-April in Asia/Dhaka, so the last complete month is March 2026. */
    const SWEEP_NOW = new Date('2026-04-10T06:00:00Z');
    const LOAN_DATE = '2026-01-01';
    const PRINCIPAL = 10_000_000; // ৳100,000

    /** loanInterestMinor at 12% on ৳100,000, from 1 January. */
    const EARNED_BY_31_JAN = 98_630;
    const EARNED_BY_31_MAR = 292_602;
    const EARNED_BY_5_APR = 309_041;
    const EARNED_BY_10_FEB = 131_506;

    const sweep = () => ctx.app.get(LoanInterestAccrualService).runSweep(SWEEP_NOW);

    async function lend(
      user: Awaited<ReturnType<typeof signup>>,
      cashId: string,
      body: Record<string, unknown>,
    ): Promise<string> {
      const res = await ctx
        .http()
        .post('/v1/loans')
        .set(auth(user))
        .send({
          personName: 'ব্যাংক',
          direction: 'LENT',
          principalMinor: PRINCIPAL,
          loanDate: LOAN_DATE,
          dueDate: '2026-12-31',
          accountId: cashId,
          ...body,
        })
        .expect(201);
      return res.body.loan.id as string;
    }

    const accrualsFor = (loanId: string) =>
      ctx.prisma.loanInterestAccrual.findMany({
        where: { loanId },
        orderBy: { throughDate: 'asc' },
      });

    /** The ঋণ পাওনা control account as the balance sheet reports it. */
    async function receivableMinor(user: Awaited<ReturnType<typeof signup>>): Promise<number> {
      const sheet = await ctx.http().get('/v1/reports/balance-sheet').set(auth(user)).expect(200);
      const line = (sheet.body.assets as { type: string; amountMinor: number }[]).find(
        (a) => a.type === 'RECEIVABLE',
      );
      return line?.amountMinor ?? 0;
    }

    it('leaves an interest-free loan completely alone', async () => {
      const { user, cashId } = await workspaceWithCash();
      const loanId = await lend(user, cashId, { interestType: 'NONE' });

      await sweep();

      /* Not "accrues zero" — accrues *nothing*. Most household lending here
         carries no interest, the derived figure is already exactly right, and a
         row saying so would be a row somebody has to explain. */
      expect(await accrualsFor(loanId)).toHaveLength(0);
      expect(await incomeMinor(user.workspaceId)).toBe(0);
      expect(await receivableMinor(user)).toBe(PRINCIPAL);

      const sheet = await ctx.http().get('/v1/reports/balance-sheet').set(auth(user)).expect(200);
      expect(sheet.body.netWorthMinor).toBe(20_000_000);
    });

    it('grows the receivable by exactly one month of a 12% loan', async () => {
      const { user, cashId } = await workspaceWithCash();
      const loanId = await lend(user, cashId, { interestType: 'PERCENT', interestRateBps: 1200 });

      expect(await receivableMinor(user)).toBe(PRINCIPAL);

      await sweep();

      /* One entry per month end, not one lump dated today: a lump would make
         today's balance sheet right by making January's and February's wrong. */
      const rows = await accrualsFor(loanId);
      expect(rows.map((r) => r.throughDate)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
      expect(Number(rows[0]?.amountMinor)).toBe(EARNED_BY_31_JAN);
      expect(rows.reduce((sum, r) => sum + Number(r.amountMinor), 0)).toBe(EARNED_BY_31_MAR);

      // The receivable grew by exactly the interest, and by nothing else.
      expect(await receivableMinor(user)).toBe(PRINCIPAL + EARNED_BY_31_MAR);
      expect(await incomeMinor(user.workspaceId)).toBe(EARNED_BY_31_MAR);

      const sheet = await ctx.http().get('/v1/reports/balance-sheet').set(auth(user)).expect(200);
      expect(sheet.body.netWorthMinor).toBe(20_000_000 + EARNED_BY_31_MAR);
      // Interest earned is not interest received: no cash has moved.
      expect(sheet.body.liquidMinor).toBe(10_000_000);
    });

    it('posts once when the sweep runs twice in the same month', async () => {
      const { user, cashId } = await workspaceWithCash();
      const loanId = await lend(user, cashId, { interestType: 'PERCENT', interestRateBps: 1200 });

      await sweep();
      await sweep();
      await sweep();

      expect(await accrualsFor(loanId)).toHaveLength(3);
      expect(await receivableMinor(user)).toBe(PRINCIPAL + EARNED_BY_31_MAR);
      expect(await incomeMinor(user.workspaceId)).toBe(EARNED_BY_31_MAR);
    });

    it('does not count the interest again when a payment arrives after it', async () => {
      const { user, cashId } = await workspaceWithCash();
      const loanId = await lend(user, cashId, { interestType: 'PERCENT', interestRateBps: 1200 });

      await sweep();
      expect(await incomeMinor(user.workspaceId)).toBe(EARNED_BY_31_MAR);

      /* Exactly the interest owed on 5 April, so the whole payment is the
         interest allocation and nothing at all is principal — the worst case for
         a double count, because the old code booked the entire amount to
         income on top of whatever had already accrued. */
      await ctx
        .http()
        .post(`/v1/loans/${loanId}/payments`)
        .set(auth(user))
        .send({
          date: '2026-04-05',
          amountMinor: EARNED_BY_5_APR,
          method: 'BANK',
          accountId: cashId,
        })
        .expect(201);

      /* Income is the interest earned by the 5th and not a poisha more. The
         payment recognised nothing: it found the first ৳2,926.02 already in the
         control account, and `addPayment` accrued the remaining five days
         before posting the money. */
      expect(await incomeMinor(user.workspaceId)).toBe(EARNED_BY_5_APR);

      // The debt is back to the bare principal, and the cash actually arrived.
      expect(await receivableMinor(user)).toBe(PRINCIPAL);
      const sheet = await ctx.http().get('/v1/reports/balance-sheet').set(auth(user)).expect(200);
      expect(sheet.body.liquidMinor).toBe(10_000_000 + EARNED_BY_5_APR);
      expect(sheet.body.netWorthMinor).toBe(20_000_000 + EARNED_BY_5_APR);

      // And the loan card agrees with the ledger, which is the real requirement.
      const detail = await ctx.http().get(`/v1/loans/${loanId}`).set(auth(user)).expect(200);
      expect(detail.body.progress.paidMinor).toBe(EARNED_BY_5_APR);

      // A later sweep finds the month already covered past its own cut-off.
      await sweep();
      expect(await incomeMinor(user.workspaceId)).toBe(EARNED_BY_5_APR);
    });

    it('accrues nothing on a settled loan', async () => {
      const { user, cashId } = await workspaceWithCash();
      const loanId = await lend(user, cashId, { interestType: 'PERCENT', interestRateBps: 1200 });

      const settled = await ctx
        .http()
        .post(`/v1/loans/${loanId}/payments`)
        .set(auth(user))
        .send({
          date: '2026-02-10',
          amountMinor: PRINCIPAL + EARNED_BY_10_FEB,
          method: 'BANK',
          accountId: cashId,
        })
        .expect(201);
      expect(settled.body.progress.isSettled).toBe(true);

      const before = await accrualsFor(loanId);
      expect(before.reduce((sum, r) => sum + Number(r.amountMinor), 0)).toBe(EARNED_BY_10_FEB);

      await sweep();

      /* A debt that has been cleared cannot go on earning. Core freezes the
         interest clock on the settlement day and the payment accrued through
         that day on the way in, so the books already hold the whole of the
         frozen figure. */
      expect(await accrualsFor(loanId)).toHaveLength(before.length);
      expect(await incomeMinor(user.workspaceId)).toBe(EARNED_BY_10_FEB);
      expect(await receivableMinor(user)).toBe(0);

      const sheet = await ctx.http().get('/v1/reports/balance-sheet').set(auth(user)).expect(200);
      expect(sheet.body.netWorthMinor).toBe(20_000_000 + EARNED_BY_10_FEB);
    });

    it('takes the accrued interest back out when the loan is cancelled', async () => {
      const { user, cashId } = await workspaceWithCash();
      const loanId = await lend(user, cashId, { interestType: 'PERCENT', interestRateBps: 1200 });

      await sweep();
      expect(await receivableMinor(user)).toBe(PRINCIPAL + EARNED_BY_31_MAR);

      await ctx.http().post(`/v1/loans/${loanId}/cancel`).set(auth(user)).send({}).expect(200);

      /* A loan the two people called off earned nothing. Leaving the accrual
         would keep both an uncollectable receivable and the income that grew it
         on the balance sheet for good. */
      const sheet = await ctx.http().get('/v1/reports/balance-sheet').set(auth(user)).expect(200);
      expect(sheet.body.netWorthMinor).toBe(20_000_000);
      expect(await receivableMinor(user)).toBe(0);
      expect(await incomeMinor(user.workspaceId)).toBe(0);
    });

    it('accrues a borrowed loan as an expense and a growing payable', async () => {
      const { user, cashId } = await workspaceWithCash();
      const created = await ctx
        .http()
        .post('/v1/loans')
        .set(auth(user))
        .send({
          personName: 'ব্যাংক',
          direction: 'BORROWED',
          principalMinor: PRINCIPAL,
          interestType: 'PERCENT',
          interestRateBps: 1200,
          loanDate: LOAN_DATE,
          dueDate: '2026-12-31',
          accountId: cashId,
        })
        .expect(201);

      await sweep();

      const sheet = await ctx.http().get('/v1/reports/balance-sheet').set(auth(user)).expect(200);
      // Interest we owe makes us poorer, and the payable is what it is owed on.
      expect(sheet.body.liabilitiesMinor).toBe(PRINCIPAL + EARNED_BY_31_MAR);
      expect(sheet.body.netWorthMinor).toBe(20_000_000 - EARNED_BY_31_MAR);
      expect(await incomeMinor(user.workspaceId)).toBe(0);

      const rows = await accrualsFor(created.body.loan.id as string);
      expect(rows.reduce((sum, r) => sum + Number(r.amountMinor), 0)).toBe(EARNED_BY_31_MAR);
    });
  });

  it('does not spend a plan slot on a loan s control account', async () => {
    const { user, cashId } = await workspaceWithCash();
    const before = await ctx.http().get('/v1/entitlements').set(auth(user)).expect(200);

    await ctx
      .http()
      .post('/v1/loans')
      .set(auth(user))
      .send({
        personName: 'কোটা',
        direction: 'LENT',
        principalMinor: 1_000_000,
        interestType: 'NONE',
        loanDate: daysAgo(1),
        accountId: cashId,
      })
      .expect(201);

    const after = await ctx.http().get('/v1/entitlements').set(auth(user)).expect(200);
    expect(after.body.usage['accounts.max']).toBe(before.body.usage['accounts.max']);
  });
});
