import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
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
import { AdminImpersonationService } from './admin-impersonation.service';
import { AdminService } from './admin.service';
import { SuperAdminGuard } from './super-admin.guard';

/* Mirrors of the Prisma enum, kept local for the same reason loans.controller
 * keeps its own: a Zod schema cannot read a Prisma enum, and @hishab/shared has
 * no home for a platform-operations vocabulary yet. */
const WORKSPACE_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED'] as const;

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
