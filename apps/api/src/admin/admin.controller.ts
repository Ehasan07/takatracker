import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { cuid } from '@hishab/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { zodPipe } from '../common/zod.pipe';
import type { AdminActor } from './admin-audit';
import { AdminBroadcastService } from './admin-broadcast.service';
import { AdminCatalogueService } from './admin-catalogue.service';
import { AdminImpersonationService } from './admin-impersonation.service';
import { AdminService } from './admin.service';
import { SuperAdminGuard } from './super-admin.guard';

/* Mirrors of the Prisma enums, kept local for the same reason loans.controller
 * keeps its own: a Zod schema cannot read a Prisma enum, and @hishab/shared has
 * no home for a platform-operations vocabulary yet. */
const WORKSPACE_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED'] as const;
const BILLING_INTERVALS = ['MONTHLY', 'YEARLY'] as const;
const FEATURE_KINDS = ['LIMIT', 'FLAG', 'QUOTA'] as const;
const METER_PERIODS = ['LIFETIME', 'MONTHLY', 'DAILY'] as const;

/**
 * A cleared filter arrives as `?status=` — an empty string, not an absent key.
 * Treating that as "no filter" is the difference between a working "সব" chip
 * and a 400 the operator cannot explain. Same helper, same reason, as
 * loans.controller.ts.
 */
const optionalQuery = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === '' || value === null ? undefined : value), schema.optional());

const listTenantsQuerySchema = z.object({
  /** Matches the workspace name or the owner's email, case-insensitively. */
  q: optionalQuery(z.string().max(200)),
  status: optionalQuery(z.enum(WORKSPACE_STATUSES)),
  planCode: optionalQuery(z.string().max(60)),
  limit: optionalQuery(z.coerce.number().int().min(1).max(100)),
  cursor: optionalQuery(z.string().max(200)),
});
export type ListTenantsQuery = z.infer<typeof listTenantsQuerySchema>;

const assignPlanSchema = z.object({
  planCode: z.string().min(1).max(60),
  /** Why. Optional here, required on an override — a package change is visible
   * on the tenant's own bill, a silent limit grant is not. */
  note: z.string().max(500).optional(),
});
export type AssignPlanInput = z.infer<typeof assignPlanSchema>;

/**
 * Set or clear one override.
 *
 * A discriminated union rather than a nullable `limitValue`, because `null`
 * already means *unlimited* throughout the entitlement code. Inferring "clear"
 * from a null would make "give this tenant unlimited transactions" and "take
 * the grant away" the same request body — two opposite operations behind one
 * shape is a support tool that eventually does the wrong one.
 *
 * `note` is required on both arms. An override is an off-books promise to one
 * customer; six months later the only person who can explain it is whoever
 * reads this sentence.
 */
const setFeatureOverrideSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('set'),
    /** `null` = unlimited. `0` = switched off. Anything else is the ceiling. */
    limitValue: z.number().int().min(0).max(1_000_000_000).nullable(),
    /** Absent or null = no expiry. A grant with an end date lapses on its own. */
    expiresAt: optionalQuery(z.string().datetime()).nullable().optional(),
    note: z.string().min(3).max(500),
  }),
  z.object({
    action: z.literal('clear'),
    note: z.string().min(3).max(500),
  }),
]);
export type SetFeatureOverrideInput = z.infer<typeof setFeatureOverrideSchema>;

const suspendSchema = z.object({
  /** Recorded on the audit row. Suspension logs every member out mid-session. */
  reason: z.string().max(500).optional(),
});
export type SuspendInput = z.infer<typeof suspendSchema>;

const platformAuditQuerySchema = z.object({
  workspaceId: optionalQuery(cuid),
  actorId: optionalQuery(cuid),
  action: optionalQuery(z.string().max(120)),
  limit: optionalQuery(z.coerce.number().int().min(1).max(100)),
  cursor: optionalQuery(z.string().max(200)),
});
export type PlatformAuditQuery = z.infer<typeof platformAuditQuerySchema>;

const startImpersonationSchema = z.object({
  /** Defaults to the workspace owner. Must be an active member either way. */
  userId: cuid.optional(),
  /** Not optional. A support session with no stated reason is unreviewable. */
  reason: z.string().min(5).max(500),
});
export type StartImpersonationInput = z.infer<typeof startImpersonationSchema>;

// --- the package editor ------------------------------------------------------

/**
 * A plan code, normalised to upper case.
 *
 * `Plan.code` is a **case-sensitive** unique index and the string
 * `AuthService.signup` looks the free tier up by. Without normalising, `pro` and
 * `PRO` are two different packages that look identical in a list, and a tenant
 * assigned to the wrong one is a support ticket nobody can see the cause of.
 * Applied to the path parameter too, so `/admin/plans/pro` reaches PRO.
 */
const planCodeSchema = z
  .string()
  .trim()
  .min(2, { message: 'কোড অন্তত ২ অক্ষরের হতে হবে' })
  .max(60)
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z][A-Z0-9_]*$/.test(value), {
    message: 'কোডে শুধু ইংরেজি বড় হাতের অক্ষর, সংখ্যা আর আন্ডারস্কোর চলবে',
  });

/**
 * A feature key. Lower case, dot-separated, the shape every existing key has
 * (`accounts.max`, `ai.tokens.monthly.max`). Enforced because the key is a
 * foreign key that can never be edited afterwards — see `updateFeature`.
 */
const featureKeySchema = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .refine((value) => /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/.test(value), {
    message: 'ফিচার কী ছোট হাতের ইংরেজি অক্ষর, সংখ্যা আর ডট দিয়ে লিখতে হবে',
  });

/** `null` = unlimited, `0` = off. Both meaningful, and different. */
const limitValueSchema = z.number().int().min(0).max(1_000_000_000).nullable();

/**
 * A whole plan's limits.
 *
 * Keys are checked against the live catalogue in the service, not here — a Zod
 * schema compiled last week cannot know about a feature created this morning,
 * which is the entire reason the catalogue moved into the database.
 */
const featureMapSchema = z
  .record(limitValueSchema)
  .refine((map) => Object.keys(map).length <= 200, { message: 'একসাথে এত ফিচার দেওয়া যাবে না' });

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const categoryAnalyticsQuerySchema = z.object({
  from: z.string().regex(ISO_DAY).optional(),
  to: z.string().regex(ISO_DAY).optional(),
  kind: z.enum(['INCOME', 'EXPENSE']).optional(),
  planCode: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * A broadcast.
 *
 * `dryRun` first, always, from the screen: telling somebody how many phones a
 * message is about to reach *before* it reaches them is the difference between
 * a tool and an accident.
 */
const broadcastSchema = z.object({
  message: z.string().trim().min(1).max(3_000),
  workspaceIds: z.array(z.string().min(1).max(64)).max(500).optional(),
  planCode: z.string().trim().max(40).optional(),
  dryRun: z.boolean().optional(),
});

const createPlanSchema = z.object({
  code: planCodeSchema,
  name: z.string().trim().min(1).max(120),
  /** Integer minor units, like every other amount in the system. */
  priceMinor: z.number().int().min(0).max(1_000_000_000_000).default(0),
  /** The same bundle billed yearly. Omit or null for a monthly-only plan. */
  priceYearlyMinor: z.number().int().min(0).max(1_000_000_000_000).nullish(),
  interval: z.enum(BILLING_INTERVALS).default('MONTHLY'),
  /**
   * Defaults to **not** public. A package half-built in a form must not appear
   * on the pricing page because somebody hit save to come back to it later.
   */
  isPublic: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
  /** Omitted means a package that grants nothing yet. */
  features: featureMapSchema.default({}),
});
export type CreatePlanInput = z.infer<typeof createPlanSchema>;

/**
 * `.strict()`, so sending `code` is a 400 rather than a silent no-op. The code
 * is immutable — tenants and audit rows point at it — and an operator who
 * submits a rename must be told it did not happen.
 */
const updatePlanSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    priceMinor: z.number().int().min(0).max(1_000_000_000_000).optional(),
    /* `nullish` rather than `optional`: an operator has to be able to withdraw
     * a yearly price, and omitting the field means "leave it alone". */
    priceYearlyMinor: z.number().int().min(0).max(1_000_000_000_000).nullish(),
    interval: z.enum(BILLING_INTERVALS).optional(),
    isPublic: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'কোনো পরিবর্তন দেওয়া হয়নি' });
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;

const setPlanFeaturesSchema = z.object({
  features: featureMapSchema,
  /**
   * Compute the over-limit warning and write nothing. The screen asks for this
   * first so an operator sees "১২টি ওয়ার্কস্পেস এই সীমার উপরে" before they
   * commit, not after.
   */
  dryRun: z.boolean().default(false),
});
export type SetPlanFeaturesInput = z.infer<typeof setPlanFeaturesSchema>;

/**
 * `label` is English and `labelBn` is Bengali — the `Feature` column names,
 * which are the reverse of `CatalogueFeature`'s. The admin API speaks the
 * columns so an operator editing a row sees the two fields the database has.
 */
const createFeatureSchema = z.object({
  key: featureKeySchema,
  label: z.string().trim().min(1).max(120),
  labelBn: z.string().trim().min(1).max(120),
  kind: z.enum(FEATURE_KINDS),
  unit: z.string().trim().min(1).max(40).default('count'),
  period: z.enum(METER_PERIODS).default('LIFETIME'),
  category: z.string().trim().min(1).max(40).default('core'),
  isActive: z.boolean().default(true),
  /** Omitted lands it at the end of the catalogue rather than on top of row 0. */
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});
export type CreateFeatureInput = z.infer<typeof createFeatureSchema>;

/**
 * `.strict()` again, and this one matters more: `kind` and `period` are absent
 * on purpose, and silently dropping them would let an operator believe they had
 * converted a LIMIT into a FLAG. See `AdminCatalogueService.updateFeature`.
 */
const updateFeatureSchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    labelBn: z.string().trim().min(1).max(120).optional(),
    unit: z.string().trim().min(1).max(40).optional(),
    category: z.string().trim().min(1).max(40).optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'কোনো পরিবর্তন দেওয়া হয়নি' });
export type UpdateFeatureInput = z.infer<typeof updateFeatureSchema>;

const endImpersonationSchema = z.object({
  workspaceId: cuid,
  /** Echoed from the start response, so the two audit rows can be paired. */
  sessionId: z.string().max(120).optional(),
  actingAsUserId: cuid.optional(),
});
export type EndImpersonationInput = z.infer<typeof endImpersonationSchema>;

/**
 * The super-admin spine.
 *
 * Every route here reads across the tenant boundary, which is why they all live
 * behind one prefix, one guard and one module — see the essay on
 * `SuperAdminGuard`. Nothing in this file is reachable from an ordinary
 * service, and no ordinary service checks a flag to decide whether it is
 * allowed to skip a `workspaceId` filter.
 *
 * There is no `ValidationPipe` in this app: every body and query below is
 * parsed by an explicit Zod pipe, exactly as in loans.controller.ts.
 */
@Controller('admin')
@UseGuards(SuperAdminGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly catalogue: AdminCatalogueService,
    private readonly broadcast: AdminBroadcastService,
    private readonly impersonation: AdminImpersonationService,
  ) {}

  // --- platform --------------------------------------------------------------

  /* Declared before `tenants/:workspaceId` and friends purely out of habit —
   * these live on different path roots, but Nest matches in declaration order
   * and putting literals first is the rule that keeps that from mattering. */
  @Get('overview')
  overview(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.admin.overview(actorFrom(user, req));
  }

  @Get('audit')
  audit(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Query(zodPipe(platformAuditQuerySchema)) query: PlatformAuditQuery,
  ) {
    return this.admin.platformAudit(actorFrom(user, req), query);
  }

  // --- tenants ---------------------------------------------------------------

  @Get('tenants')
  listTenants(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Query(zodPipe(listTenantsQuerySchema)) query: ListTenantsQuery,
  ) {
    return this.admin.listTenants(actorFrom(user, req), query);
  }

  @Get('tenants/:workspaceId')
  tenantDetail(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
  ) {
    return this.admin.tenantDetail(actorFrom(user, req), workspaceId);
  }

  /**
   * `GET /v1/admin/tenants/:id/finance` — a tenant's balances and positions.
   *
   * Its own route rather than more fields on `tenantDetail`, for two reasons
   * that are really one: an operator opening a plan page should not read
   * somebody's bank balances as a side effect, and the audit row for "looked at
   * the money" has to be distinguishable from "looked at the plan". A separate
   * route makes both true by construction.
   */
  @Get('tenants/:workspaceId/finance')
  tenantFinance(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
  ) {
    return this.admin.tenantFinance(actorFrom(user, req), workspaceId);
  }

  /**
   * `GET /v1/admin/analytics/categories` — spending across every tenant.
   *
   * Aggregate only: names of categories and their totals, never a row, never a
   * workspace id. It answers "what does the customer base spend on" without
   * opening anybody's books.
   */
  @Get('analytics/categories')
  categoryAnalytics(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Query(zodPipe(categoryAnalyticsQuerySchema))
    query: z.infer<typeof categoryAnalyticsQuerySchema>,
  ) {
    return this.admin.categoryAnalytics(actorFrom(user, req), query);
  }

  /** How many phones a broadcast could reach right now. */
  @Get('broadcast/reach')
  broadcastReach() {
    return this.broadcast.reach();
  }

  /**
   * `POST /v1/admin/broadcast` — a Telegram message to customers.
   *
   * Only to people who connected Telegram themselves and left it enabled: the
   * binding *is* the consent, and there is no separate list to be on. Every
   * send writes an audit row carrying the message itself, so "what did we tell
   * them?" is answerable months later.
   */
  @Post('broadcast')
  @HttpCode(200)
  sendBroadcast(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Body(zodPipe(broadcastSchema)) body: z.infer<typeof broadcastSchema>,
  ) {
    return this.broadcast.send(actorFrom(user, req), body);
  }

  @Post('tenants/:workspaceId/plan')
  @HttpCode(200)
  assignPlan(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(assignPlanSchema)) body: AssignPlanInput,
  ) {
    return this.admin.assignPlan(actorFrom(user, req), workspaceId, body);
  }

  /* PUT, not PATCH: the body describes the whole state of one override, and
   * sending it twice leaves the same row. */
  @Put('tenants/:workspaceId/features/:featureKey')
  setFeatureOverride(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Param('featureKey') featureKey: string,
    @Body(zodPipe(setFeatureOverrideSchema)) body: SetFeatureOverrideInput,
  ) {
    return this.admin.setFeatureOverride(actorFrom(user, req), workspaceId, featureKey, body);
  }

  @Post('tenants/:workspaceId/suspend')
  @HttpCode(200)
  suspend(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(suspendSchema)) body: SuspendInput,
  ) {
    return this.admin.suspend(actorFrom(user, req), workspaceId, body);
  }

  @Post('tenants/:workspaceId/reactivate')
  @HttpCode(200)
  reactivate(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(suspendSchema)) body: SuspendInput,
  ) {
    return this.admin.reactivate(actorFrom(user, req), workspaceId, body);
  }

  // --- packages --------------------------------------------------------------

  /* Nothing under `/admin/plans` can delete a plan, and that is deliberate:
   * `Workspace.planId` points at the row, so removing one would drop somebody's
   * limits with nothing on screen or in the log to say why. Withdrawing a
   * package is `retire` below. */

  @Get('plans')
  listPlans() {
    return this.catalogue.listPlans();
  }

  @Post('plans')
  createPlan(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Body(zodPipe(createPlanSchema)) body: CreatePlanInput,
  ) {
    return this.catalogue.createPlan(actorFrom(user, req), body);
  }

  @Patch('plans/:code')
  updatePlan(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Param('code', zodPipe(planCodeSchema)) code: string,
    @Body(zodPipe(updatePlanSchema)) body: UpdatePlanInput,
  ) {
    return this.catalogue.updatePlan(actorFrom(user, req), code, body);
  }

  /* PUT, not PATCH: the body is the plan's *whole* limit map. A package is one
   * commercial statement and has to be saved as one, or the world can stop in a
   * state where half the new prices are live. */
  @Put('plans/:code/features')
  setPlanFeatures(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Param('code', zodPipe(planCodeSchema)) code: string,
    @Body(zodPipe(setPlanFeaturesSchema)) body: SetPlanFeaturesInput,
  ) {
    return this.catalogue.setPlanFeatures(actorFrom(user, req), code, body);
  }

  @Post('plans/:code/retire')
  @HttpCode(200)
  retirePlan(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Param('code', zodPipe(planCodeSchema)) code: string,
  ) {
    return this.catalogue.retirePlan(actorFrom(user, req), code);
  }

  @Post('plans/:code/unretire')
  @HttpCode(200)
  unretirePlan(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Param('code', zodPipe(planCodeSchema)) code: string,
  ) {
    return this.catalogue.unretirePlan(actorFrom(user, req), code);
  }

  @Get('features')
  listFeatures() {
    return this.catalogue.listFeatures();
  }

  @Post('features')
  createFeature(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Body(zodPipe(createFeatureSchema)) body: CreateFeatureInput,
  ) {
    return this.catalogue.createFeature(actorFrom(user, req), body);
  }

  @Patch('features/:key')
  updateFeature(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Param('key', zodPipe(featureKeySchema)) key: string,
    @Body(zodPipe(updateFeatureSchema)) body: UpdateFeatureInput,
  ) {
    return this.catalogue.updateFeature(actorFrom(user, req), key, body);
  }

  // --- impersonation ---------------------------------------------------------

  @Post('tenants/:workspaceId/impersonate')
  @HttpCode(200)
  impersonate(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(startImpersonationSchema)) body: StartImpersonationInput,
  ) {
    return this.impersonation.start(actorFrom(user, req), workspaceId, body);
  }

  /* Not under `tenants/:workspaceId` — the workspace arrives in the body,
   * because the client ending a session has the envelope it was handed and
   * should send it back whole rather than reassembling a path from it. */
  @Post('impersonate/end')
  @HttpCode(200)
  endImpersonation(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Body(zodPipe(endImpersonationSchema)) body: EndImpersonationInput,
  ) {
    return this.impersonation.end(actorFrom(user, req), body);
  }
}

/**
 * The operator, for the audit row.
 *
 * `req.ip` is the address nginx actually saw — `main.ts` sets `trust proxy` to
 * exactly one hop for that reason, so this cannot be forged by a header.
 */
const actorFrom = (user: AuthUser, req: Request): AdminActor => ({
  id: user.id,
  email: user.email,
  workspaceId: user.workspaceId,
  ip: req.ip ?? null,
  userAgent: req.header('user-agent') ?? null,
});
