import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MembershipRole } from '@prisma/client';
import {
  auth,
  createTestApp,
  resetDatabase,
  signup,
  type SignedUpUser,
  type TestContext,
} from './harness';

/**
 * The party due report: who owes what, across the whole workspace.
 *
 * Two locks guard it and both are tested here, because either one alone is the
 * bug: a feature flag with no role check hands every shop assistant the
 * customer list, and a role check with no flag gives it to workspaces nobody
 * sold it to.
 */
describe('party due report', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  const daysAgo = (n: number): string =>
    new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  /** Turn the feature on for one workspace, the way a super admin would. */
  async function grantReport(workspaceId: string): Promise<void> {
    await ctx.prisma.workspaceFeatureOverride.upsert({
      where: { workspaceId_featureKey: { workspaceId, featureKey: 'party.due.report' } },
      create: { workspaceId, featureKey: 'party.due.report', limitValue: 1 },
      update: { limitValue: 1 },
    });
  }

  async function setRole(user: SignedUpUser, role: MembershipRole): Promise<void> {
    await ctx.prisma.membership.updateMany({
      where: { userId: user.id, workspaceId: user.workspaceId },
      data: { role },
    });
  }

  /** A workspace with cash, one customer owing, and one supplier owed. */
  async function shopWithBooks(): Promise<{ user: SignedUpUser; cashId: string }> {
    const user = await signup(ctx);
    const cash = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'নগদ', type: 'CASH', openingBalance: 50_000_000 })
      .expect(201);
    const cashId = cash.body.id as string;

    // A customer took ৳1,00,000 on credit and has paid ৳40,000 back.
    const lent = await ctx
      .http()
      .post('/v1/loans')
      .set(auth(user))
      .send({
        personName: 'Karim Store',
        personPhone: '01711000001',
        direction: 'LENT',
        principalMinor: 10_000_000,
        interestType: 'NONE',
        loanDate: daysAgo(30),
        accountId: cashId,
      })
      .expect(201);

    await ctx
      .http()
      .post(`/v1/loans/${lent.body.loan.id}/payments`)
      .set(auth(user))
      .send({ date: daysAgo(10), amountMinor: 4_000_000, method: 'CASH', accountId: cashId })
      .expect(201);

    // A supplier is owed ৳60,000, nothing paid.
    await ctx
      .http()
      .post('/v1/loans')
      .set(auth(user))
      .send({
        personName: 'Meghna Distribution',
        personPhone: '01711000002',
        direction: 'BORROWED',
        principalMinor: 6_000_000,
        interestType: 'NONE',
        loanDate: daysAgo(20),
        accountId: cashId,
      })
      .expect(201);

    return { user, cashId };
  }

  it('refuses a workspace the feature was never granted to', async () => {
    const { user } = await shopWithBooks();

    const res = await ctx.http().get('/v1/reports/party-dues').set(auth(user)).expect(402);
    expect(res.body.featureKey ?? res.body.message).toBeTruthy();
  });

  it('splits the two directions and totals each side', async () => {
    const { user } = await shopWithBooks();
    await grantReport(user.workspaceId);

    const res = await ctx.http().get('/v1/reports/party-dues').set(auth(user)).expect(200);

    expect(res.body.customers).toHaveLength(1);
    expect(res.body.suppliers).toHaveLength(1);

    const customer = res.body.customers[0];
    expect(customer.name).toBe('Karim Store');
    expect(customer.code).toMatch(/^P-\d{4}$/);
    expect(customer.customer.totalMinor).toBe(10_000_000);
    expect(customer.customer.paidMinor).toBe(4_000_000);
    expect(customer.customer.outstandingMinor).toBe(6_000_000);
    /* The supplier side of a customer's row is empty rather than absent: the
       two halves are kept apart so netting them is impossible by accident. */
    expect(customer.supplier.outstandingMinor).toBe(0);

    const supplier = res.body.suppliers[0];
    expect(supplier.name).toBe('Meghna Distribution');
    expect(supplier.supplier.outstandingMinor).toBe(6_000_000);

    expect(res.body.customerTotals.outstandingMinor).toBe(6_000_000);
    expect(res.body.supplierTotals.outstandingMinor).toBe(6_000_000);
  });

  it('agrees with the party ledger screen, figure for figure', async () => {
    const { user } = await shopWithBooks();
    await grantReport(user.workspaceId);

    const report = await ctx.http().get('/v1/reports/party-dues').set(auth(user)).expect(200);
    const row = report.body.customers[0];

    const ledger = await ctx
      .http()
      .get(`/v1/loans/people/${row.personId}/ledger`)
      .set(auth(user))
      .expect(200);

    expect(ledger.body.receivableMinor).toBe(row.customer.outstandingMinor);
  });

  it('leaves cancelled loans out, exactly as the dashboard does', async () => {
    const { user, cashId } = await shopWithBooks();
    await grantReport(user.workspaceId);

    const extra = await ctx
      .http()
      .post('/v1/loans')
      .set(auth(user))
      .send({
        personName: 'Nadia Traders',
        direction: 'LENT',
        principalMinor: 1_000_000,
        interestType: 'NONE',
        loanDate: daysAgo(5),
        accountId: cashId,
      })
      .expect(201);

    const before = await ctx.http().get('/v1/reports/party-dues').set(auth(user)).expect(200);
    expect(before.body.customers).toHaveLength(2);

    await ctx
      .http()
      .post(`/v1/loans/${extra.body.loan.id}/cancel`)
      .set(auth(user))
      .send({})
      .expect(200);

    const after = await ctx.http().get('/v1/reports/party-dues').set(auth(user)).expect(200);
    expect(after.body.customers).toHaveLength(1);
    expect(after.body.customerTotals.outstandingMinor).toBe(6_000_000);
  });

  it('puts somebody who trades both ways on both lists, unnetted', async () => {
    const { user, cashId } = await shopWithBooks();
    await grantReport(user.workspaceId);

    const people = await ctx.http().get('/v1/people').set(auth(user)).expect(200);
    const karim = (people.body as { id: string; name: string }[]).find(
      (p) => p.name === 'Karim Store',
    );

    await ctx
      .http()
      .post('/v1/loans')
      .set(auth(user))
      .send({
        personId: karim?.id,
        direction: 'BORROWED',
        principalMinor: 2_000_000,
        interestType: 'NONE',
        loanDate: daysAgo(3),
        accountId: cashId,
      })
      .expect(201);

    const res = await ctx.http().get('/v1/reports/party-dues').set(auth(user)).expect(200);

    const asCustomer = res.body.customers.find((r: { name: string }) => r.name === 'Karim Store');
    const asSupplier = res.body.suppliers.find((r: { name: string }) => r.name === 'Karim Store');

    expect(asCustomer.customer.outstandingMinor).toBe(6_000_000);
    expect(asSupplier.supplier.outstandingMinor).toBe(2_000_000);
    // Not ৳40,000 net. Netting would hide a supplier who is also behind.
    expect(asCustomer.customer.outstandingMinor - asSupplier.supplier.outstandingMinor).toBe(
      4_000_000,
    );
  });

  it('refuses a member and a viewer even when the feature is on', async () => {
    const { user } = await shopWithBooks();
    await grantReport(user.workspaceId);

    for (const role of ['MEMBER', 'VIEWER'] as const) {
      await setRole(user, role);
      await ctx.http().get('/v1/reports/party-dues').set(auth(user)).expect(403);
      await ctx.http().get('/v1/reports/party-dues.xlsx').set(auth(user)).expect(403);
    }

    // And an admin is not a member: the same token, one column different.
    await setRole(user, 'ADMIN');
    await ctx.http().get('/v1/reports/party-dues').set(auth(user)).expect(200);
  });

  it('hands back a workbook with both sheets, and files an audit row', async () => {
    const { user } = await shopWithBooks();
    await grantReport(user.workspaceId);

    const res = await ctx
      .http()
      .get('/v1/reports/party-dues.xlsx')
      .set(auth(user))
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('party-dues-');
    // A .xlsx is a zip; the first two bytes say so. Anything else is an error
    // page saved under a spreadsheet's name.
    expect((res.body as Buffer).subarray(0, 2).toString('latin1')).toBe('PK');

    const row = await ctx.prisma.auditEvent.findFirst({
      where: { workspaceId: user.workspaceId, action: 'report.party_dues_downloaded' },
    });
    expect(row).not.toBeNull();
  });
});
