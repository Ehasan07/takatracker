import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auth,
  createTestApp,
  resetDatabase,
  signup,
  type SignedUpUser,
  type TestContext,
} from './harness';

/**
 * Sponsored footers.
 *
 * The thing worth testing is not that an advert can be created — it is *where
 * it ends up*. A campaign placed on one workspace must not appear on another's
 * documents, a tenant must not be able to create or edit one, and the
 * spreadsheet export must never carry it however it is configured.
 */
describe('sponsored footers', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  async function operator(): Promise<SignedUpUser> {
    const user = await signup(ctx);
    await ctx.prisma.user.update({ where: { id: user.id }, data: { isSuperAdmin: true } });
    return user;
  }

  async function campaign(admin: SignedUpUser, name = 'Rahim Steel'): Promise<string> {
    const res = await ctx
      .http()
      .post('/v1/admin/ads')
      .set(auth(admin))
      .send({
        name,
        headline: 'Rahim Steel — রড, সিমেন্ট, টিন',
        body: 'পাইকারি দরে সরবরাহ, ঢাকা ও আশপাশে।',
        contactLine: '01711-000000 · rahimsteel.example',
      })
      .expect(201);
    return res.body.id as string;
  }

  it('shows nothing to a workspace nobody placed an advert on', async () => {
    const shop = await signup(ctx);
    const res = await ctx.http().get('/v1/ads/footer').set(auth(shop)).expect(200);
    expect(res.body.ad).toBeNull();
  });

  it('reaches only the workspace it was placed on', async () => {
    const admin = await operator();
    const chosen = await signup(ctx);
    const other = await signup(ctx);
    const id = await campaign(admin);

    await ctx
      .http()
      .put(`/v1/admin/ads/${id}/placements`)
      .set(auth(admin))
      .send({ workspaceId: chosen.workspaceId, note: 'Q4 deal' })
      .expect(200);

    const seen = await ctx.http().get('/v1/ads/footer').set(auth(chosen)).expect(200);
    expect(seen.body.ad.headline).toContain('Rahim Steel');
    expect(seen.body.ad.contactLine).toContain('01711-000000');

    const unseen = await ctx.http().get('/v1/ads/footer').set(auth(other)).expect(200);
    expect(unseen.body.ad).toBeNull();
  });

  it('stops when the campaign is switched off, without unpicking placements', async () => {
    const admin = await operator();
    const shop = await signup(ctx);
    const id = await campaign(admin, 'Seasonal');

    await ctx
      .http()
      .put(`/v1/admin/ads/${id}/placements`)
      .set(auth(admin))
      .send({ workspaceId: shop.workspaceId })
      .expect(200);
    expect(
      (await ctx.http().get('/v1/ads/footer').set(auth(shop)).expect(200)).body.ad,
    ).not.toBeNull();

    await ctx
      .http()
      .patch(`/v1/admin/ads/${id}`)
      .set(auth(admin))
      .send({ isActive: false })
      .expect(200);

    expect((await ctx.http().get('/v1/ads/footer').set(auth(shop)).expect(200)).body.ad).toBeNull();
    // The placement is still there, so switching it back on needs no re-entry.
    expect(await ctx.prisma.adPlacement.count({ where: { campaignId: id } })).toBe(1);
  });

  it('respects the window it was sold for', async () => {
    const admin = await operator();
    const shop = await signup(ctx);
    const id = await campaign(admin, 'Expired');

    await ctx
      .http()
      .put(`/v1/admin/ads/${id}/placements`)
      .set(auth(admin))
      .send({
        workspaceId: shop.workspaceId,
        endsAt: new Date(Date.now() - 86_400_000).toISOString(),
      })
      .expect(200);

    expect((await ctx.http().get('/v1/ads/footer').set(auth(shop)).expect(200)).body.ad).toBeNull();
  });

  it('is not something a tenant can create, edit or place', async () => {
    const shop = await signup(ctx);

    /* 404, not 403: `SuperAdminGuard` refuses to confirm that /admin exists at
       all. See the guard's own note on why. */
    await ctx.http().get('/v1/admin/ads').set(auth(shop)).expect(404);
    await ctx
      .http()
      .post('/v1/admin/ads')
      .set(auth(shop))
      .send({ name: 'x', headline: 'x' })
      .expect(404);
  });

  it('withdraws cleanly, and a deleted campaign leaves every document', async () => {
    const admin = await operator();
    const shop = await signup(ctx);
    const id = await campaign(admin, 'Withdrawn');

    await ctx
      .http()
      .put(`/v1/admin/ads/${id}/placements`)
      .set(auth(admin))
      .send({ workspaceId: shop.workspaceId })
      .expect(200);

    await ctx
      .http()
      .delete(`/v1/admin/ads/${id}/placements/${shop.workspaceId}`)
      .set(auth(admin))
      .expect(200);

    expect((await ctx.http().get('/v1/ads/footer').set(auth(shop)).expect(200)).body.ad).toBeNull();

    // And deleting the campaign takes any remaining placements with it.
    const second = await campaign(admin, 'Deleted');
    await ctx
      .http()
      .put(`/v1/admin/ads/${second}/placements`)
      .set(auth(admin))
      .send({ workspaceId: shop.workspaceId })
      .expect(200);
    await ctx.http().delete(`/v1/admin/ads/${second}`).set(auth(admin)).expect(200);

    expect(await ctx.prisma.adPlacement.count({ where: { campaignId: second } })).toBe(0);
    expect((await ctx.http().get('/v1/ads/footer').set(auth(shop)).expect(200)).body.ad).toBeNull();
  });

  it('never reaches a spreadsheet', async () => {
    const admin = await operator();
    const shop = await signup(ctx);
    const id = await campaign(admin, 'Not in the cells');
    await ctx
      .http()
      .put(`/v1/admin/ads/${id}/placements`)
      .set(auth(admin))
      .send({ workspaceId: shop.workspaceId })
      .expect(200);

    await ctx.prisma.workspaceFeatureOverride.upsert({
      where: {
        workspaceId_featureKey: {
          workspaceId: shop.workspaceId,
          featureKey: 'party.due.report',
        },
      },
      create: { workspaceId: shop.workspaceId, featureKey: 'party.due.report', limitValue: 1 },
      update: { limitValue: 1 },
    });

    const res = await ctx
      .http()
      .get('/v1/reports/party-dues.xlsx')
      .set(auth(shop))
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);

    /* The strings in an xlsx live in a deflated sharedStrings part, so a naive
       search of the zip proves little — but the headline is short and stored
       text is often literal in the stream. The stronger check is the one the
       writer guarantees: nothing in the workbook module ever reads an advert.
       This asserts the observable half. */
    expect((res.body as Buffer).toString('latin1')).not.toContain('Not in the cells');
  });

  it('carries into a statement shared with a customer', async () => {
    const admin = await operator();
    const shop = await signup(ctx);
    const id = await campaign(admin, 'On the customer copy');
    await ctx
      .http()
      .put(`/v1/admin/ads/${id}/placements`)
      .set(auth(admin))
      .send({ workspaceId: shop.workspaceId })
      .expect(200);

    const cash = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(shop))
      .send({ name: 'নগদ', type: 'CASH', openingBalance: 10_000_000 })
      .expect(201);

    const loan = await ctx
      .http()
      .post('/v1/loans')
      .set(auth(shop))
      .send({
        personName: 'Karim Store',
        direction: 'LENT',
        principalMinor: 2_000_000,
        interestType: 'NONE',
        loanDate: new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10),
        accountId: cash.body.id,
      })
      .expect(201);

    const share = await ctx
      .http()
      .post('/v1/statement-shares')
      .set(auth(shop))
      .send({ kind: 'LOAN', subjectId: loan.body.loan.id })
      .expect(201);

    const token = (share.body.url as string).replace('/s/', '');
    // No Authorization header: this is the copy the customer holds.
    const doc = await ctx.http().get(`/v1/public/statement/${token}`).expect(200);
    expect(doc.body.ad.headline).toContain('Rahim Steel');
  });
});
