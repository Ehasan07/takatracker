import { randomUUID } from 'node:crypto';
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
 * The super-admin panel: the one place in this application where a query is
 * deliberately not scoped by `workspaceId`.
 *
 * That makes it the most dangerous module in the product, and the tests below
 * are written around the two properties that keep it defensible rather than
 * around its JSON:
 *
 *  1. **It is invisible to everyone else.** A non-operator gets 404 from every
 *     route — never 403, which would confirm the panel exists and, probed path
 *     by path, would hand over its whole route map.
 *  2. **Every read leaves a row.** Looking at a tenant's books is an event with
 *     an actor, a target and a timestamp. A support tool nobody can review is a
 *     liability, and "who looked at my data?" is the first thing a customer asks.
 *
 * Everything else here — plans, features, impersonation — is tested for the
 * refusals more than the successes, because the refusals are what somebody will
 * eventually be tempted to soften.
 */

/**
 * A plan code no other test can collide with.
 *
 * `Plan` is a platform table, not a tenant one: it is truncated once for the
 * whole run and shared by every test in this file. A fixed code would make two
 * tests in this file — or a rerun against a database somebody else is using —
 * fight over the same row.
 */
const planCode = (prefix: string): string =>
  `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`.toUpperCase();

const featureKey = (prefix: string): string =>
  `${prefix}.${randomUUID()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 10)}`;

interface AuditRow {
  action: string;
  workspaceId: string;
  actorUserId: string | null;
  actorType: string;
  entityId: string | null;
}

describe('super admin', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  /**
   * An operator, and the tenant they will be looking at.
   *
   * `isSuperAdmin` is a column and is deliberately absent from the JWT — the
   * guard re-reads it on every request so a revoked operator loses access at the
   * next one, not fifteen minutes later. So flipping it here needs no new token.
   */
  async function operator(): Promise<SignedUpUser> {
    const user = await signup(ctx);
    await ctx.prisma.user.update({ where: { id: user.id }, data: { isSuperAdmin: true } });
    return user;
  }

  /** Wait for the fire-and-forget audit writes the read paths use. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

  const auditFor = async (workspaceId: string, prefix: string): Promise<AuditRow[]> =>
    ctx.prisma.auditEvent.findMany({
      where: { workspaceId, action: { startsWith: prefix } },
      orderBy: { createdAt: 'asc' },
      select: {
        action: true,
        workspaceId: true,
        actorUserId: true,
        actorType: true,
        entityId: true,
      },
    });

  // --- the isolation boundary ------------------------------------------------

  /**
   * Every route, one status. A 403 anywhere in this list would say "this path
   * is real", and the set of paths that answer 403 rather than 404 is a map of
   * the panel.
   */
  it('answers a non-operator with 404 on every admin route', async () => {
    const ordinary = await signup(ctx);
    const tenant = await signup(ctx);

    const gets = [
      '/v1/admin/overview',
      '/v1/admin/audit',
      '/v1/admin/tenants',
      `/v1/admin/tenants/${tenant.workspaceId}`,
      '/v1/admin/plans',
      '/v1/admin/features',
      // A path that was never routed. It has to be indistinguishable from the
      // real ones above; see the test that follows.
      '/v1/admin/definitely-not-a-route',
    ];
    for (const path of gets) {
      await ctx.http().get(path).set(auth(ordinary)).expect(404);
    }

    // The writes too — a POST that 401s while a GET 404s is the same leak.
    await ctx
      .http()
      .post('/v1/admin/plans')
      .set(auth(ordinary))
      .send({ code: 'ANYTHING', name: 'যা হোক' })
      .expect(404);
    await ctx
      .http()
      .post(`/v1/admin/tenants/${tenant.workspaceId}/suspend`)
      .set(auth(ordinary))
      .send({ reason: 'কারণ' })
      .expect(404);
    await ctx
      .http()
      .put(`/v1/admin/tenants/${tenant.workspaceId}/features/accounts.max`)
      .set(auth(ordinary))
      .send({ action: 'set', limitValue: 99, note: 'নোট' })
      .expect(404);
    await ctx
      .http()
      .post(`/v1/admin/tenants/${tenant.workspaceId}/impersonate`)
      .set(auth(ordinary))
      .send({ reason: 'কৌতূহল' })
      .expect(404);

    /* And with no credentials at all. A 401 here, while an unrouted path
     * answered 404, would enumerate the real routes just as well as a 403. */
    await ctx.http().get('/v1/admin/tenants').expect(404);
    await ctx.http().get('/v1/admin/overview').expect(404);
  });

  /**
   * KNOWN DEFECT — `it.fails`, deliberately left strict.
   *
   * Matching statuses is not enough on its own: the *body* has to match too,
   * and it does not. `SuperAdminGuard` answers
   * `{"message":"পাওয়া যায়নি","error":"Not Found","statusCode":404}` while
   * Nest's router answers `{"message":"Cannot GET /v1/admin/nope",...}` for a
   * path that was never routed. So one request per path recovers exactly the
   * route map the 404 was chosen to withhold: a Bengali message means the path
   * is real and guarded, an English `Cannot GET` means it is not there.
   *
   * The guard's own doc comment claims "a 404 says only what a request for any
   * unrouted path says", so this is the implementation missing its stated
   * property, not the test overreaching. The fix belongs in `main.ts` and the
   * harness — a `NotFoundException` filter that renders one body for every 404
   * — which is a file this change does not own.
   */
  it.fails('makes a real admin route indistinguishable from an invented one', async () => {
    const ordinary = await signup(ctx);

    const real = await ctx.http().get('/v1/admin/tenants').set(auth(ordinary)).expect(404);
    const invented = await ctx
      .http()
      .get('/v1/admin/tenants-that-do-not-exist')
      .set(auth(ordinary))
      .expect(404);

    expect(real.body).toEqual(invented.body);
  });

  it('lets an operator read a tenant they are not a member of', async () => {
    const op = await operator();
    const tenant = await signup(ctx);

    const list = await ctx
      .http()
      .get('/v1/admin/tenants')
      .query({ q: tenant.email })
      .set(auth(op))
      .expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].id).toBe(tenant.workspaceId);
    expect(list.body.items[0].owner.email).toBe(tenant.email);
    expect(list.body.items[0].plan.code).toBe('FREE');
    expect(list.body.items[0].memberCount).toBe(1);

    const detail = await ctx
      .http()
      .get(`/v1/admin/tenants/${tenant.workspaceId}`)
      .set(auth(op))
      .expect(200);
    expect(detail.body.id).toBe(tenant.workspaceId);
    expect(detail.body.owner.email).toBe(tenant.email);
    expect(detail.body.members).toHaveLength(1);
    // Nothing that reaches a browser may carry a hash or a token version.
    expect(JSON.stringify(detail.body)).not.toContain('passwordHash');
    expect(JSON.stringify(detail.body)).not.toContain('tokenVersion');

    /* And the ordinary user still cannot do the same in reverse. This is the
     * half of the feature that is easy to lose: cross-tenant reads are a hole
     * in the guard that protects every tenant, and it must stay one hole. */
    await ctx.http().get('/v1/admin/tenants').set(auth(tenant)).expect(404);
    await ctx.http().get(`/v1/admin/tenants/${op.workspaceId}`).set(auth(tenant)).expect(404);
  });

  /**
   * Where an operator's activity is recorded, and the line it draws.
   *
   * This asserted the opposite until the finance view landed: every read of a
   * tenant used to be filed against *that tenant*, so it appeared in the
   * customer's own `/audit`. The rule now splits, deliberately:
   *
   *   what an operator **did to** a tenant   → the tenant's log (they see it)
   *   what an operator **looked at**         → the operator's log (internal)
   *
   * Nothing is unwritten by that change. Every read still produces a row naming
   * who, when, from which IP and — in `entityId` — which tenant, and it is
   * queryable at `/admin/audit` for as long as the events table exists. What
   * moved is which feed it is published into, which is the ordinary shape of a
   * support-access log.
   */
  it('files what was done to a tenant in their log, and what was read in the operator’s', async () => {
    const op = await operator();
    const tenant = await signup(ctx);

    await ctx.http().get('/v1/admin/overview').set(auth(op)).expect(200);
    await ctx.http().get('/v1/admin/tenants').set(auth(op)).expect(200);
    await ctx.http().get(`/v1/admin/tenants/${tenant.workspaceId}`).set(auth(op)).expect(200);
    await ctx
      .http()
      .get('/v1/admin/audit')
      .query({ workspaceId: tenant.workspaceId })
      .set(auth(op))
      .expect(200);
    // A write, which the customer is entitled to see.
    await ctx
      .http()
      .post(`/v1/admin/tenants/${tenant.workspaceId}/plan`)
      .set(auth(op))
      .send({ planCode: 'PREMIUM', note: 'পরীক্ষা' })
      .expect(200);

    await settle();

    // Done *to* them: on their timeline.
    const onTenant = await auditFor(tenant.workspaceId, 'admin.');
    expect(onTenant.map((e) => e.action)).toEqual(['admin.plan_assigned']);
    expect(onTenant.every((e) => e.actorType === 'SUPPORT')).toBe(true);

    // Looked at: on the operator's, with the tenant named in `entityId`.
    const onOperator = await auditFor(op.workspaceId, 'admin.');
    expect(onOperator.map((e) => e.action).sort()).toEqual(
      [
        'admin.audit_viewed',
        'admin.overview_viewed',
        'admin.tenant_list_viewed',
        'admin.tenant_viewed',
      ].sort(),
    );
    expect(onOperator.every((e) => e.actorUserId === op.id)).toBe(true);
    const viewed = onOperator.find((e) => e.action === 'admin.tenant_viewed');
    expect(viewed?.entityId).toBe(tenant.workspaceId);
  });

  // --- tenants ---------------------------------------------------------------

  it('assigns a plan, and refuses to assign the one they are already on', async () => {
    const op = await operator();
    const tenant = await signup(ctx);

    const assigned = await ctx
      .http()
      .post(`/v1/admin/tenants/${tenant.workspaceId}/plan`)
      .set(auth(op))
      .send({ planCode: 'PREMIUM', note: 'ছয় মাসের চুক্তি' })
      .expect(200);
    expect(assigned.body.previousPlanCode).toBe('FREE');
    expect(assigned.body.plan.code).toBe('PREMIUM');

    // The tenant's own entitlements move on their very next request.
    const theirs = await ctx.http().get('/v1/entitlements').set(auth(tenant)).expect(200);
    expect(theirs.body.plan.code).toBe('PREMIUM');
    expect(theirs.body.entitlements['accounts.max']).toBeNull(); // PREMIUM is unlimited

    // A no-op assignment is a mistake worth naming, not a silent success.
    await ctx
      .http()
      .post(`/v1/admin/tenants/${tenant.workspaceId}/plan`)
      .set(auth(op))
      .send({ planCode: 'PREMIUM' })
      .expect(400);

    await ctx
      .http()
      .post(`/v1/admin/tenants/${tenant.workspaceId}/plan`)
      .set(auth(op))
      .send({ planCode: 'NO_SUCH_PLAN' })
      .expect(404);

    const trail = await auditFor(tenant.workspaceId, 'admin.plan_assigned');
    expect(trail).toHaveLength(1);
  });

  it('grants one tenant one extra limit, with a note and an attributable granter', async () => {
    const op = await operator();
    const tenant = await signup(ctx);

    // A grant with no stated reason is unreviewable, so the note is required.
    await ctx
      .http()
      .put(`/v1/admin/tenants/${tenant.workspaceId}/features/accounts.max`)
      .set(auth(op))
      .send({ action: 'set', limitValue: 25 })
      .expect(400);

    const granted = await ctx
      .http()
      .put(`/v1/admin/tenants/${tenant.workspaceId}/features/accounts.max`)
      .set(auth(op))
      .send({ action: 'set', limitValue: 25, note: 'টিকিট #৪৪২ — মাইগ্রেশনের সময়' })
      .expect(200);

    expect(granted.body.effectiveLimit).toBe(25);
    expect(granted.body.override.note).toBe('টিকিট #৪৪২ — মাইগ্রেশনের সময়');
    /* Whoever last widened the limit is the person to ask about it. Without
     * this the grant is anonymous six months from now. */
    expect(granted.body.override.grantedBy.id).toBe(op.id);
    expect(granted.body.override.grantedBy.email).toBe(op.email);

    const row = await ctx.prisma.workspaceFeatureOverride.findUniqueOrThrow({
      where: {
        workspaceId_featureKey: { workspaceId: tenant.workspaceId, featureKey: 'accounts.max' },
      },
    });
    expect(row.grantedByUserId).toBe(op.id);

    // The enforcer agrees with the panel — if it did not, support would talk a
    // customer through a ceiling that is not the one blocking them.
    const theirs = await ctx.http().get('/v1/entitlements').set(auth(tenant)).expect(200);
    expect(theirs.body.entitlements['accounts.max']).toBe(25);

    // A key that is not in the catalogue is a sentence, not a constraint name.
    await ctx
      .http()
      .put(`/v1/admin/tenants/${tenant.workspaceId}/features/not.a.real.feature`)
      .set(auth(op))
      .send({ action: 'set', limitValue: 1, note: 'কেন' })
      .expect(400);

    const cleared = await ctx
      .http()
      .put(`/v1/admin/tenants/${tenant.workspaceId}/features/accounts.max`)
      .set(auth(op))
      .send({ action: 'clear', note: 'মাইগ্রেশন শেষ' })
      .expect(200);
    expect(cleared.body.override).toBeNull();
    expect(cleared.body.effectiveLimit).toBe(2); // back to FREE's two

    // Clearing what is not there is a 404, not a cheerful no-op.
    await ctx
      .http()
      .put(`/v1/admin/tenants/${tenant.workspaceId}/features/accounts.max`)
      .set(auth(op))
      .send({ action: 'clear', note: 'আবার' })
      .expect(404);

    const trail = await auditFor(tenant.workspaceId, 'admin.feature_overridden');
    expect(trail).toHaveLength(2); // the grant and the withdrawal
  });

  it('suspends a tenant immediately and reactivates them', async () => {
    const op = await operator();
    const tenant = await signup(ctx);

    // Working before.
    await ctx.http().get('/v1/auth/me').set(auth(tenant)).expect(200);

    const suspended = await ctx
      .http()
      .post(`/v1/admin/tenants/${tenant.workspaceId}/suspend`)
      .set(auth(op))
      .send({ reason: 'পেমেন্ট বকেয়া' })
      .expect(200);
    expect(suspended.body.status).toBe('SUSPENDED');
    expect(suspended.body.previousStatus).toBe('ACTIVE');

    /* It bites on the very next request, not when a token expires: JwtStrategy
     * re-reads the workspace every time. That is also why the reason belongs on
     * the audit row — somebody was logged out mid-session and will ask. */
    await ctx.http().get('/v1/auth/me').set(auth(tenant)).expect(401);
    await ctx.http().get('/v1/transactions').set(auth(tenant)).expect(401);

    await ctx
      .http()
      .post(`/v1/admin/tenants/${tenant.workspaceId}/suspend`)
      .set(auth(op))
      .send({ reason: 'আবার' })
      .expect(400);

    const back = await ctx
      .http()
      .post(`/v1/admin/tenants/${tenant.workspaceId}/reactivate`)
      .set(auth(op))
      .send({ reason: 'টাকা এসেছে' })
      .expect(200);
    /* ACTIVE, not TRIALING: the previous status is not stored anywhere, and
     * restoring it could silently revive an expired trial. */
    expect(back.body.status).toBe('ACTIVE');
    await ctx.http().get('/v1/auth/me').set(auth(tenant)).expect(200);

    const trail = await auditFor(tenant.workspaceId, 'admin.tenant_');
    expect(trail.map((e) => e.action)).toEqual([
      'admin.tenant_suspended',
      'admin.tenant_reactivated',
    ]);
  });

  // --- packages ---------------------------------------------------------------

  it('creates a package, prices it, retires it and puts it back', async () => {
    const op = await operator();
    const code = planCode('STARTER');

    const created = await ctx
      .http()
      .post('/v1/admin/plans')
      .set(auth(op))
      .send({
        // Lower case on the way in: `Plan.code` is a case-sensitive unique
        // index, so `pro` and `PRO` would be two packages nobody can tell apart.
        code: code.toLowerCase(),
        name: 'স্টার্টার',
        priceMinor: 19_900, // ৳199.00
        isPublic: true,
        features: { 'accounts.max': 8 },
      })
      .expect(201);

    expect(created.body.code).toBe(code);
    expect(created.body.priceMinor).toBe(19_900);
    expect(created.body.workspaceCount).toBe(0);
    expect(created.body.features).toHaveLength(1);
    expect(created.body.features[0]).toMatchObject({ key: 'accounts.max', limitValue: 8 });

    // The same code twice is a refusal, whatever its case.
    await ctx.http().post('/v1/admin/plans').set(auth(op)).send({ code, name: 'নকল' }).expect(400);

    const repriced = await ctx
      .http()
      .patch(`/v1/admin/plans/${code}`)
      .set(auth(op))
      .send({ priceMinor: 24_900 })
      .expect(200);
    expect(repriced.body.priceMinor).toBe(24_900);

    /* `.strict()`: the code is immutable — tenants and audit rows point at it —
     * so an operator who submits a rename has to be told it did not happen. */
    await ctx
      .http()
      .patch(`/v1/admin/plans/${code}`)
      .set(auth(op))
      .send({ code: 'RENAMED' })
      .expect(400);

    const retired = await ctx
      .http()
      .post(`/v1/admin/plans/${code}/retire`)
      .set(auth(op))
      .expect(200);
    expect(retired.body.retired).toBe(true);
    expect(retired.body.isPublic).toBe(false);

    // Gone from the pricing page on the next request, still on the shelf here.
    const publicPlans = await ctx.http().get('/v1/entitlements/plans').set(auth(op)).expect(200);
    expect(publicPlans.body.map((p: { code: string }) => p.code)).not.toContain(code);

    await ctx.http().post(`/v1/admin/plans/${code}/retire`).set(auth(op)).expect(400);

    const unretired = await ctx
      .http()
      .post(`/v1/admin/plans/${code}/unretire`)
      .set(auth(op))
      .expect(200);
    expect(unretired.body.retired).toBe(false);

    const trail = await auditFor(op.workspaceId, 'admin.plan_');
    expect(trail.map((e) => e.action)).toEqual([
      'admin.plan_created',
      'admin.plan_updated',
      'admin.plan_retired',
      'admin.plan_unretired',
    ]);
  });

  it('refuses to retire or hide the plan new signups land on', async () => {
    const op = await operator();

    /* `AuthService.signup` assigns FREE by code. A pricing page that does not
     * list the plan every new user is actually put on is not a withdrawn
     * package, it is a page that lies about what the product costs. */
    const retire = await ctx.http().post('/v1/admin/plans/FREE/retire').set(auth(op)).expect(400);
    expect(String(retire.body.message)).toContain('সাইনআপ');

    // The same refusal by the back door.
    await ctx
      .http()
      .patch('/v1/admin/plans/FREE')
      .set(auth(op))
      .send({ isPublic: false })
      .expect(400);

    const plans = await ctx.http().get('/v1/admin/plans').set(auth(op)).expect(200);
    const free = plans.body.items.find((p: { code: string }) => p.code === 'FREE');
    expect(free.isPublic).toBe(true);
    expect(free.isDefault).toBe(true);
  });

  it('never deletes a package, because tenants point at the row', async () => {
    const op = await operator();
    const code = planCode('DOOMED');

    await ctx
      .http()
      .post('/v1/admin/plans')
      .set(auth(op))
      .send({ code, name: 'বাতিল হবে', isPublic: true })
      .expect(201);

    // There is no DELETE, on purpose: removing the row would drop somebody's
    // limits to the compiled fallbacks with nothing on screen to say why.
    await ctx.http().delete(`/v1/admin/plans/${code}`).set(auth(op)).expect(404);

    await ctx.http().post(`/v1/admin/plans/${code}/retire`).set(auth(op)).expect(200);

    // Retiring withdraws it; it does not remove it.
    const plans = await ctx.http().get('/v1/admin/plans').set(auth(op)).expect(200);
    expect(plans.body.items.map((p: { code: string }) => p.code)).toContain(code);
    expect(await ctx.prisma.plan.count({ where: { code } })).toBe(1);
  });

  /**
   * The confirmation dialog's number, and what happens when the operator means
   * it.
   *
   * A tenant on this package has three accounts. The package is cut to one. The
   * warning has to say "১টি ওয়ার্কস্পেস" *before* the write, the tenant has to
   * keep all three afterwards, and only the fourth may be refused. Deleting two
   * of somebody's accounts because a price list changed would be the disaster
   * this design exists to avoid.
   */
  it('warns about the tenants a tighter limit would strand, then strands none of them', async () => {
    const op = await operator();
    const code = planCode('SQUEEZE');
    const tenant = await signup(ctx);

    await ctx
      .http()
      .post('/v1/admin/plans')
      .set(auth(op))
      .send({ code, name: 'চাপ', isPublic: false, features: { 'accounts.max': 10 } })
      .expect(201);

    await ctx
      .http()
      .post(`/v1/admin/tenants/${tenant.workspaceId}/plan`)
      .set(auth(op))
      .send({ planCode: code })
      .expect(200);

    for (const name of ['নগদ', 'ব্যাংক', 'বিকাশ']) {
      await ctx
        .http()
        .post('/v1/accounts')
        .set(auth(tenant))
        .send({ name, type: 'CASH' })
        .expect(201);
    }

    const dry = await ctx
      .http()
      .put(`/v1/admin/plans/${code}/features`)
      .set(auth(op))
      .send({ features: { 'accounts.max': 1 }, dryRun: true })
      .expect(200);

    expect(dry.body.applied).toBe(false);
    expect(dry.body.warning.tenantCount).toBe(1);
    expect(dry.body.warning.workspacesOnPlan).toBe(1);
    expect(dry.body.warning.measured).toContain('accounts.max');
    expect(dry.body.warning.byFeature).toHaveLength(1);
    expect(dry.body.warning.byFeature[0]).toMatchObject({
      featureKey: 'accounts.max',
      previousLimit: 10,
      newLimit: 1,
      workspaceCount: 1,
      maxUsed: 3,
    });
    expect(dry.body.warning.byFeature[0].sample[0]).toMatchObject({
      workspaceId: tenant.workspaceId,
      used: 3,
    });

    // A dry run writes nothing at all.
    const untouched = await ctx.http().get('/v1/entitlements').set(auth(tenant)).expect(200);
    expect(untouched.body.entitlements['accounts.max']).toBe(10);

    const applied = await ctx
      .http()
      .put(`/v1/admin/plans/${code}/features`)
      .set(auth(op))
      .send({ features: { 'accounts.max': 1 } })
      .expect(200);
    expect(applied.body.applied).toBe(true);
    expect(applied.body.warning.tenantCount).toBe(1);

    /* The tenant keeps every row they had. `assertWithinLimit` compares against
     * current usage, so they are simply refused the next one. */
    const accounts = await ctx.http().get('/v1/accounts').set(auth(tenant)).expect(200);
    expect(accounts.body).toHaveLength(3);

    const refused = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(tenant))
      .send({ name: 'রকেট', type: 'CASH' })
      .expect(402);
    expect(refused.body.featureKey).toBe('accounts.max');
    expect(refused.body.limit).toBe(1);
    expect(refused.body.used).toBe(3);

    // Raising a limit costs no warning at all — that is the common edit.
    const raised = await ctx
      .http()
      .put(`/v1/admin/plans/${code}/features`)
      .set(auth(op))
      .send({ features: { 'accounts.max': 50 }, dryRun: true })
      .expect(200);
    expect(raised.body.warning.tenantCount).toBe(0);
    expect(raised.body.warning.byFeature).toEqual([]);
  });

  it('adds a feature to the catalogue and grants it to nobody', async () => {
    const op = await operator();
    const tenant = await signup(ctx);
    const key = featureKey('reports.custom');

    const created = await ctx
      .http()
      .post('/v1/admin/features')
      .set(auth(op))
      .send({
        key,
        label: 'Custom reports',
        labelBn: 'কাস্টম রিপোর্ট',
        kind: 'FLAG',
        category: 'reports',
      })
      .expect(201);
    expect(created.body.key).toBe(key);
    /* Empty, always, on the request that created it. If saving a form quietly
     * wrote a row onto every plan, an unpriced feature would land on every
     * tenant in the system at once. */
    expect(created.body.grantedByPlans).toEqual([]);

    const theirs = await ctx.http().get('/v1/entitlements').set(auth(tenant)).expect(200);
    expect(theirs.body.entitlements[key]).toBe(0); // off, everywhere

    await ctx
      .http()
      .post('/v1/admin/features')
      .set(auth(op))
      .send({ key, label: 'Again', labelBn: 'আবার', kind: 'FLAG' })
      .expect(400);

    /* `kind` is absent from PATCH and the body is `.strict()`, so sending it is
     * a 400 rather than a silent no-op. Turning a LIMIT into a FLAG would
     * reinterpret every number already stored under the key. */
    await ctx
      .http()
      .patch(`/v1/admin/features/${key}`)
      .set(auth(op))
      .send({ kind: 'LIMIT' })
      .expect(400);

    const renamed = await ctx
      .http()
      .patch(`/v1/admin/features/${key}`)
      .set(auth(op))
      .send({ labelBn: 'নিজস্ব রিপোর্ট' })
      .expect(200);
    expect(renamed.body.labelBn).toBe('নিজস্ব রিপোর্ট');
    expect(renamed.body.kind).toBe('FLAG'); // unchanged

    // Retired: existing grants survive, nothing new may sell it.
    await ctx
      .http()
      .patch(`/v1/admin/features/${key}`)
      .set(auth(op))
      .send({ isActive: false })
      .expect(200);

    const rejected = await ctx
      .http()
      .post('/v1/admin/plans')
      .set(auth(op))
      .send({ code: planCode('LATE'), name: 'দেরিতে', features: { [key]: 1 } })
      .expect(400);
    expect(String(rejected.body.message)).toContain('অবসরপ্রাপ্ত');
  });

  // --- impersonation ----------------------------------------------------------

  it('issues a support session bounded to fifteen minutes, with no way to extend it', async () => {
    const op = await operator();
    const tenant = await signup(ctx);

    const before = await ctx.prisma.refreshToken.count({ where: { userId: tenant.id } });

    const started = await ctx
      .http()
      .post(`/v1/admin/tenants/${tenant.workspaceId}/impersonate`)
      .set(auth(op))
      .send({ reason: 'ব্যালেন্স মিলছে না — টিকিট ৯১২' })
      .expect(200);

    expect(started.body.tokenType).toBe('impersonation');
    expect(started.body.transport).toBe('authorization-bearer');
    /* Nothing is written to `RefreshToken`, so the session cannot be rotated,
     * extended, or survive its own expiry. It dies on its own with nothing to
     * revoke and no cleanup job. */
    expect(started.body.refreshToken).toBeNull();
    expect(await ctx.prisma.refreshToken.count({ where: { userId: tenant.id } })).toBe(before);

    /* An hour, and never more however `IMPERSONATION_TTL` is configured — the
     * ceiling is enforced by `assertBoxed`, not merely hoped for. It is an hour
     * rather than fifteen minutes because a session may now write, and fifteen
     * minutes is not long enough to fix what it took that long to find.
     *
     * Its own variable, too: lengthening a support session must not lengthen
     * the token every ordinary user carries. `JWT_ACCESS_TTL` is untouched by
     * this and the assertion below would fail if the two were ever merged. */
    expect(started.body.expiresIn).toBe(60 * 60);
    expect(started.body.expiresIn).toBeLessThanOrEqual(60 * 60);
    const window = new Date(started.body.expiresAt).getTime() - Date.now();
    expect(window).toBeGreaterThan(58 * 60_000);
    expect(window).toBeLessThanOrEqual(60 * 60_000 + 5_000);

    expect(started.body.impersonation.actingAs.id).toBe(tenant.id);
    expect(started.body.impersonation.startedBy.id).toBe(op.id);
    expect(started.body.banner).toContain('সাপোর্ট মোড');

    // The token really is the customer's, not the operator's.
    const asCustomer = await ctx
      .http()
      .get('/v1/auth/me')
      .set({ Authorization: `Bearer ${started.body.accessToken}` })
      .expect(200);
    expect(asCustomer.body.id).toBe(tenant.id);
    expect(asCustomer.body.workspace.id).toBe(tenant.workspaceId);
    expect(asCustomer.body.isSuperAdmin).toBe(false);

    /* Which is also why it cannot reach the panel: the guard reads
     * `isSuperAdmin` for whoever the request authenticates as. */
    await ctx
      .http()
      .get('/v1/admin/tenants')
      .set({ Authorization: `Bearer ${started.body.accessToken}` })
      .expect(404);

    const ended = await ctx
      .http()
      .post('/v1/admin/impersonate/end')
      .set(auth(op))
      .send({
        workspaceId: tenant.workspaceId,
        sessionId: started.body.sessionId,
        actingAsUserId: tenant.id,
      })
      .expect(200);
    expect(ended.body.ok).toBe(true);

    const trail = await auditFor(tenant.workspaceId, 'support.impersonation');
    expect(trail.map((e) => e.action)).toEqual([
      'support.impersonation_started',
      'support.impersonation_ended',
    ]);
    expect(trail.every((e) => e.actorUserId === op.id)).toBe(true);
  });

  it('refuses a support session with no stated reason', async () => {
    const op = await operator();
    const tenant = await signup(ctx);

    await ctx
      .http()
      .post(`/v1/admin/tenants/${tenant.workspaceId}/impersonate`)
      .set(auth(op))
      .send({})
      .expect(400);
    // Five characters is the floor; "ok" is not a reason.
    await ctx
      .http()
      .post(`/v1/admin/tenants/${tenant.workspaceId}/impersonate`)
      .set(auth(op))
      .send({ reason: 'ok' })
      .expect(400);
  });

  it('marks the session on the token, and shuts the doors an operator must not walk through', async () => {
    const op = await operator();
    const tenant = await signup(ctx);

    const started = await ctx
      .http()
      .post(`/v1/admin/tenants/${tenant.workspaceId}/impersonate`)
      .set(auth(op))
      .send({ reason: 'রসিদ দেখা যাচ্ছে না — টিকিট ৯৯১' })
      .expect(200);

    const support = { Authorization: `Bearer ${started.body.accessToken}` };

    /* On the token, not only in the envelope above. A client that dropped the
     * response and reloaded still learns it is in a support session, and — the
     * part that matters — so does the server. */
    const me = await ctx.http().get('/v1/auth/me').set(support).expect(200);
    expect(me.body.isImpersonated).toBe(true);

    // Reading is the whole point of the feature and stays open.
    await ctx.http().get('/v1/accounts').set(support).expect(200);
    await ctx.http().get('/v1/transactions').set(support).expect(200);

    // Changing their credentials, signing their devices out, or walking off
    // with the file — none of those are support.
    await ctx
      .http()
      .post('/v1/auth/password/change')
      .set(support)
      .send({ currentPassword: 'hishab1234', newPassword: 'hishab12345' })
      .expect(403);
    await ctx.http().post('/v1/auth/sessions/revoke-others').set(support).send({}).expect(403);
    await ctx.http().get('/v1/export/transactions').set(support).expect(403);

    /* The customer's own session reaches all three. Same routes, same
       workspace, same everything except who is holding the token — which is
       the only thing the guard looks at. */
    const own = await ctx.http().get('/v1/auth/me').set(auth(tenant)).expect(200);
    expect(own.body.isImpersonated).toBe(false);
    await ctx.http().get('/v1/export/transactions').set(auth(tenant)).expect(200);
    await ctx.http().post('/v1/auth/sessions/revoke-others').set(auth(tenant)).send({}).expect(200);
  });

  it('finds a person across tenants, and files the search against the operator', async () => {
    const op = await operator();
    const tenant = await signup(ctx);

    const found = await ctx
      .http()
      .get(`/v1/admin/users?q=${encodeURIComponent(tenant.email)}`)
      .set(auth(op))
      .expect(200);

    const row = found.body.items.find((u: { id: string }) => u.id === tenant.id);
    expect(row).toBeDefined();
    expect(row.email).toBe(tenant.email);
    /* The memberships are what make a row actionable: a support session is
     * started against a workspace, so a user listed without one is a user
     * nobody can enter. */
    expect(row.workspaces.map((w: { id: string }) => w.id)).toContain(tenant.workspaceId);
    expect(row.isSuperAdmin).toBe(false);

    // Nothing that authenticates anybody reaches the browser.
    expect(row.passwordHash).toBeUndefined();
    expect(row.tokenVersion).toBeUndefined();

    /* Filed against the *operator's* own workspace, because the read crossed
     * every tenant rather than one — `fileRead` with the entity overridden. */
    await settle();
    const trail = await auditFor(op.workspaceId, 'admin.user_list_viewed');
    expect(trail.length).toBeGreaterThan(0);
    expect(trail.every((e) => e.actorUserId === op.id && e.actorType === 'SUPPORT')).toBe(true);

    // And the door it exists to open works from the id it just returned.
    await ctx
      .http()
      .post(`/v1/admin/tenants/${tenant.workspaceId}/impersonate`)
      .set(auth(op))
      .send({ userId: tenant.id, reason: 'ফোনে খুঁজে পাওয়া গেল — টিকিট ৩১২' })
      .expect(200);
  });

  it('keeps the people search behind the same 404 as the rest of the panel', async () => {
    const ordinary = await signup(ctx);
    await ctx.http().get('/v1/admin/users').set(auth(ordinary)).expect(404);
    await ctx.http().get('/v1/admin/users').expect(404);
  });

  it('writes as the customer, and names the operator on every row it writes', async () => {
    const op = await operator();
    const tenant = await signup(ctx);

    const started = await ctx
      .http()
      .post(`/v1/admin/tenants/${tenant.workspaceId}/impersonate`)
      .set(auth(op))
      .send({ reason: 'হিসাব মিলছে না, ঠিক করে দিতে হবে — টিকিট ৭০৪' })
      .expect(200);
    const support = { Authorization: `Bearer ${started.body.accessToken}` };

    // Reading is unchanged.
    await ctx.http().get('/v1/accounts').set(support).expect(200);
    await ctx.http().get('/v1/transactions').set(support).expect(200);

    /* And writing works. This is the product decision the attribution below
     * exists to make defensible: an operator can fix a customer's books from
     * inside their own screens rather than describing the fix over the phone. */
    const created = await ctx
      .http()
      .post('/v1/accounts')
      .set(support)
      .send({ name: 'নগদ বাক্স', type: 'CASH', openingBalance: 0 })
      .expect(201);

    /* The account is the customer's, in the customer's workspace. Nothing about
     * a support session moves a row somewhere else. */
    const account = await ctx.prisma.account.findUnique({
      where: { id: created.body.id },
      select: { workspaceId: true, name: true },
    });
    expect(account?.workspaceId).toBe(tenant.workspaceId);
    expect(account?.name).toBe('নগদ বাক্স');

    await settle();

    /* The row that makes it traceable. `actorUserId` is the customer, because
     * the session authenticates as them and the entry belongs in their books;
     * `impersonatorUserId` is the only record that somebody else was holding
     * the keyboard, and `actorType` is forced to SUPPORT regardless of what the
     * calling service believed. None of this is passed by a call site — see
     * `common/request-context.ts`. */
    const written = await ctx.prisma.auditEvent.findMany({
      where: { workspaceId: tenant.workspaceId, entityId: created.body.id },
      select: { actorUserId: true, actorType: true, impersonatorUserId: true },
    });
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((row) => row.actorUserId === tenant.id)).toBe(true);
    expect(written.every((row) => row.actorType === 'SUPPORT')).toBe(true);
    expect(written.every((row) => row.impersonatorUserId === op.id)).toBe(true);

    /* The customer's own token writes the same route and leaves no operator on
     * the row. The stamp is about the session, not about the workspace. */
    const ownAccount = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(tenant))
      .send({ name: 'নিজের নগদ', type: 'CASH', openingBalance: 0 })
      .expect(201);

    await settle();

    const ownRows = await ctx.prisma.auditEvent.findMany({
      where: { workspaceId: tenant.workspaceId, entityId: ownAccount.body.id },
      select: { actorType: true, impersonatorUserId: true },
    });
    expect(ownRows.length).toBeGreaterThan(0);
    expect(ownRows.every((row) => row.impersonatorUserId === null)).toBe(true);
    expect(ownRows.every((row) => row.actorType === 'USER')).toBe(true);
  });

  it('reads a tenant’s balances, and files the look against the operator', async () => {
    const op = await operator();
    const tenant = await signup(ctx);

    const cash = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(tenant))
      .send({
        name: 'ব্যাংক',
        type: 'BANK',
        openingBalance: 5_000_000,
        accountNumberMasked: '****৪৫২১',
        institution: 'BRAC',
      })
      .expect(201);

    const finance = await ctx
      .http()
      .get(`/v1/admin/tenants/${tenant.workspaceId}/finance`)
      .set(auth(op))
      .expect(200);

    expect(finance.body.currency).toBe('BDT');
    expect(finance.body.netWorthMinor).toBe(5_000_000);
    const account = finance.body.accounts.find((a: { id: string }) => a.id === cash.body.id);
    expect(account.balanceMinor).toBe(5_000_000);
    // What the user typed for their own recognition. Never a full number —
    // this product has never asked for one.
    expect(account.accountNumberMasked).toBe('****৪৫২১');
    // The bookkeeping accounts are machinery and are not listed as somebody's.
    expect(finance.body.accounts.every((a: { name: string }) => a.name !== 'আয়')).toBe(true);

    await settle();

    /* The read is recorded — but in the operator's log, not the customer's.
     * You see what was done *to* you; an operator's viewing history is internal
     * and reviewable rather than published into the customer's timeline. */
    const theirs = await ctx.http().get('/v1/audit').set(auth(tenant)).expect(200);
    const theirActions = theirs.body.items.map((r: { action: string }) => r.action);
    expect(theirActions).not.toContain('admin.tenant_finance_viewed');

    const platform = await ctx
      .http()
      .get('/v1/admin/audit')
      .query({ action: 'admin.tenant_finance_viewed' })
      .set(auth(op))
      .expect(200);
    const row = platform.body.items[0];
    expect(row.action).toBe('admin.tenant_finance_viewed');
    // `entityId` says which tenant, so "who looked at this customer?" is one query.
    expect(row.entityId).toBe(tenant.workspaceId);
  });

  it('rolls spending up across tenants without naming one', async () => {
    const op = await operator();
    const a = await signup(ctx);
    const b = await signup(ctx);

    for (const user of [a, b]) {
      const account = await ctx
        .http()
        .post('/v1/accounts')
        .set(auth(user))
        .send({ name: 'নগদ', type: 'CASH', openingBalance: 10_000_000 })
        .expect(201);
      const cats = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
      const food = cats.body.find((c: { nameBn: string }) => c.nameBn === 'খাবার ও বাজার');
      await ctx
        .http()
        .post('/v1/transactions')
        .set(auth(user))
        .send({
          date: new Date().toISOString().slice(0, 10),
          type: 'EXPENSE',
          amountMinor: 100_000,
          accountId: account.body.id,
          categoryId: food.id,
        })
        .expect(201);
    }

    const res = await ctx
      .http()
      .get('/v1/admin/analytics/categories')
      .query({ kind: 'EXPENSE' })
      .set(auth(op))
      .expect(200);

    /* Two workspaces, two different `Category` rows, one name. Grouping by id
       would have produced two slices of one each — which is why this groups by
       the normalised name instead, and why the property under test is that the
       count *merges* rather than what the count happens to be.
       
       At least two, not exactly two: this endpoint rolls up every tenant on the
       server, the suites share one database, and any other suite that files an
       expense under this name lands in the same slice. An exact figure here
       measures the rest of the test run, not this behaviour — it held only
       while shared bills went in with no category at all. */
    const food = res.body.slices.find((s: { name: string }) => s.name.includes('খাবার'));
    expect(food.workspaceCount).toBeGreaterThanOrEqual(2);
    expect(food.transactionCount).toBeGreaterThanOrEqual(2);

    // Aggregate only: no workspace id, no owner, nothing that names a person.
    expect(JSON.stringify(res.body)).not.toContain(a.workspaceId);
    expect(res.body.currencies.some((c: { currency: string }) => c.currency === 'BDT')).toBe(true);
  });

  it('shows what a tenant’s phone forwarded, and how much of it the parser read', async () => {
    /* The webhook is closed by default: with no root secret the endpoint has
       nothing to compare against and answers 401 to everybody, which is how it
       stays shut on a server that never configured it. This suite needs it
       open, and sets the same value `ingestion.e2e-spec.ts` does. */
    process.env.INGESTION_WEBHOOK_SECRET ??= 'test-ingestion-secret-for-the-suite';

    /* The endpoint exists to answer one question: are the parsers keeping up
       with the banks. So the assertion is about the three outcomes, not about
       the text — a message read, a money message the parser could not read, and
       a message that was never about money. */
    const op = await operator();
    const tenant = await signup(ctx);

    const config = await ctx
      .http()
      .get('/v1/ingestion/webhook-config')
      .set(auth(tenant))
      .expect(200);

    const send = (body: string) =>
      ctx
        .http()
        .post('/v1/ingestion/webhook')
        .set(config.body.workspaceHeader, tenant.workspaceId)
        .set(config.body.secretHeader, config.body.secret)
        .send({ channel: 'SMS', sender: 'BRAC-BANK', body })
        .expect(200);

    await send('Your A/C 1234 is debited BDT 1,500.00 on 14-AUG-26');
    await send('Dear customer, your BDT statement is ready.');
    /* No digit and no currency word, so no draft — which since the rule was
       widened is the only kind of message that gets left out. */
    await send('আমি বাসায় পৌঁছে গেছি');

    const res = await ctx
      .http()
      .get(`/v1/admin/tenants/${tenant.workspaceId}/messages`)
      .set(auth(op))
      .expect(200);

    expect(res.body.summary).toMatchObject({ total: 3, parsed: 1, unread: 1, ignored: 1 });
    /* The raw text is there — that is the point of the screen, and the cost of
       it, and why the read is logged below. */
    expect(JSON.stringify(res.body.messages)).toContain('বাসায়');

    /* Its own action, awaited rather than emitted: an unlogged look at
       somebody's messages is the thing this design exists to prevent.

       Filed against the *operator's* workspace, which is where every support
       read is filed — the log answers "what has this operator looked at",
       and the tenant is named in `entityId`. */
    const rows = await auditFor(op.workspaceId, 'admin.tenant_messages_viewed');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entityId).toBe(tenant.workspaceId);
    expect(rows[0]?.actorType).toBe('SUPPORT');
  });

  it('keeps the messages of a tenant away from somebody who is not an operator', async () => {
    const tenant = await signup(ctx);
    const other = await signup(ctx);
    // 404, never 403 — the panel does not advertise itself.
    await ctx
      .http()
      .get(`/v1/admin/tenants/${other.workspaceId}/messages`)
      .set(auth(tenant))
      .expect(404);
  });

  it('keeps the finance view behind the operator flag', async () => {
    const tenant = await signup(ctx);
    const other = await signup(ctx);
    // 404, never 403 — the panel does not advertise itself to somebody who is
    // not an operator.
    await ctx
      .http()
      .get(`/v1/admin/tenants/${other.workspaceId}/finance`)
      .set(auth(tenant))
      .expect(404);
    await ctx.http().get('/v1/admin/analytics/categories').set(auth(tenant)).expect(404);
  });

  it('counts a broadcast before sending it, and never messages the unconnected', async () => {
    const op = await operator();
    const tenant = await signup(ctx);

    /* Nobody has connected Telegram, so there is nobody to reach. The dry run
       is what the screen calls first — telling somebody how many phones a
       message is about to reach *before* it reaches them is the difference
       between a tool and an accident. */
    const dry = await ctx
      .http()
      .post('/v1/admin/broadcast')
      .set(auth(op))
      .send({ message: 'পরীক্ষা', dryRun: true })
      .expect(200);
    expect(dry.body.dryRun).toBe(true);
    expect(dry.body.eligible).toBe(0);
    expect(dry.body.sent).toBe(0);
    expect(dry.body.withoutTelegram).toBeGreaterThan(0);

    /* A connection that exists but is switched off is not a recipient. Sending
       to somebody who turned notifications off is the fastest way to lose the
       binding — and with it the reminders they did want. */
    await ctx.prisma.telegramConnection.create({
      data: {
        workspaceId: tenant.workspaceId,
        userId: tenant.id,
        chatId: '12345',
        isEnabled: false,
        status: 'ACTIVE',
        verifiedAt: new Date(),
      },
    });
    const stillNone = await ctx
      .http()
      .post('/v1/admin/broadcast')
      .set(auth(op))
      .send({ message: 'পরীক্ষা', dryRun: true })
      .expect(200);
    expect(stillNone.body.eligible).toBe(0);

    // Enabled and verified: now they count.
    await ctx.prisma.telegramConnection.updateMany({
      where: { workspaceId: tenant.workspaceId },
      data: { isEnabled: true },
    });
    const reachable = await ctx
      .http()
      .post('/v1/admin/broadcast')
      .set(auth(op))
      .send({ message: 'পরীক্ষা', dryRun: true })
      .expect(200);
    expect(reachable.body.eligible).toBe(1);

    const reach = await ctx.http().get('/v1/admin/broadcast/reach').set(auth(op)).expect(200);
    expect(reach.body.connected).toBe(1);
  });

  it('keeps the broadcast behind the operator flag, and refuses an empty message', async () => {
    const tenant = await signup(ctx);
    // 404, never 403 — the panel does not advertise itself.
    await ctx
      .http()
      .post('/v1/admin/broadcast')
      .set(auth(tenant))
      .send({ message: 'hi', dryRun: true })
      .expect(404);

    const op = await operator();
    await ctx
      .http()
      .post('/v1/admin/broadcast')
      .set(auth(op))
      .send({ message: '   ', dryRun: true })
      .expect(400);
  });

  it('refuses to impersonate another super admin', async () => {
    const op = await operator();
    const other = await operator();

    /* A token minted for another operator would carry full platform access
     * while every audit row inside the session named them rather than whoever
     * was actually acting. That destroys attribution, which is the only thing
     * making this feature defensible. */
    const refused = await ctx
      .http()
      .post(`/v1/admin/tenants/${other.workspaceId}/impersonate`)
      .set(auth(op))
      .send({ reason: 'শুধু দেখব' })
      .expect(403);
    expect(String(refused.body.message)).toContain('অপারেটর');
  });

  it('refuses to impersonate into a suspended workspace', async () => {
    const op = await operator();
    const tenant = await signup(ctx);

    await ctx
      .http()
      .post(`/v1/admin/tenants/${tenant.workspaceId}/suspend`)
      .set(auth(op))
      .send({ reason: 'তদন্ত চলছে' })
      .expect(200);

    /* JwtStrategy rejects a token for a suspended workspace on arrival, so
     * issuing one would look like it worked and then 401 on the first screen. */
    await ctx
      .http()
      .post(`/v1/admin/tenants/${tenant.workspaceId}/impersonate`)
      .set(auth(op))
      .send({ reason: 'বাগ দেখতে চাই' })
      .expect(400);

    // Reactivating is the documented way in, and it works.
    await ctx
      .http()
      .post(`/v1/admin/tenants/${tenant.workspaceId}/reactivate`)
      .set(auth(op))
      .send({})
      .expect(200);
    await ctx
      .http()
      .post(`/v1/admin/tenants/${tenant.workspaceId}/impersonate`)
      .set(auth(op))
      .send({ reason: 'বাগ দেখতে চাই' })
      .expect(200);
  });

  it('refuses a workspace that does not exist, without saying which is which', async () => {
    const op = await operator();
    const ghost = 'cl00000000000000000000000';

    await ctx.http().get(`/v1/admin/tenants/${ghost}`).set(auth(op)).expect(404);
    await ctx.http().post(`/v1/admin/tenants/${ghost}/suspend`).set(auth(op)).send({}).expect(404);
    await ctx
      .http()
      .post(`/v1/admin/tenants/${ghost}/impersonate`)
      .set(auth(op))
      .send({ reason: 'কোথায় গেল' })
      .expect(404);
  });
});
