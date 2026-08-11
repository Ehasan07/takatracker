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

  it('records every cross-tenant read against somebody', async () => {
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

    await settle();

    /* Anything about *one* tenant is filed against that tenant — the person
     * whose timeline was read is the person entitled to see that it was. */
    const onTenant = await auditFor(tenant.workspaceId, 'admin.');
    expect(onTenant.map((e) => e.action).sort()).toEqual(
      ['admin.audit_viewed', 'admin.tenant_viewed'].sort(),
    );
    expect(onTenant.every((e) => e.actorUserId === op.id)).toBe(true);
    expect(onTenant.every((e) => e.actorType === 'SUPPORT')).toBe(true);

    /* Anything about the platform is filed against the operator's own
     * workspace — the only one they have standing in, and the place a review of
     * "what did this operator do?" reads back complete. */
    const onOperator = await auditFor(op.workspaceId, 'admin.');
    expect(onOperator.map((e) => e.action).sort()).toEqual(
      ['admin.overview_viewed', 'admin.tenant_list_viewed'].sort(),
    );
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

    // Fifteen minutes, and never more however the platform TTL is configured.
    expect(started.body.expiresIn).toBe(15 * 60);
    expect(started.body.expiresIn).toBeLessThanOrEqual(15 * 60);
    const window = new Date(started.body.expiresAt).getTime() - Date.now();
    expect(window).toBeGreaterThan(13 * 60_000);
    expect(window).toBeLessThanOrEqual(15 * 60_000 + 5_000);

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
