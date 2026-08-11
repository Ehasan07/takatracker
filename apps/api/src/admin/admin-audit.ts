import type { AuditAction } from '../audit/audit.service';

/**
 * The audit strings this module writes.
 *
 * Global access is the one place in this codebase where a query is not scoped
 * by `workspaceId`, so **every** call — reads included — leaves a row. Looking
 * at a tenant's books is an event with an actor, a target and a timestamp; a
 * support tool nobody can review is a liability, and "who looked at my data?"
 * is the first thing a customer asks.
 *
 * Annotated, never `as AuditAction`. A cast compiles whatever string is on the
 * right of it, so a typo would ship a row under an action name no query looks
 * for; the annotation makes the union the authority and a rename upstream a
 * compile error here.
 *
 * Two of these were not in the brief's list and are their own strings anyway:
 *
 *   admin.audit_viewed    reading the cross-tenant audit log is itself a read
 *                         of tenant data, and reusing one of the others would
 *                         file it under a name that means something else.
 *   admin.plan_unretired  putting a package back on sale filed under
 *                         `admin.plan_retired` would name an event as its own
 *                         inverse, and `admin.plan_updated` would bury it among
 *                         price edits. "When did this plan go back on sale?"
 *                         has to be one query.
 */
export const TENANT_LIST_VIEWED: AuditAction = 'admin.tenant_list_viewed';
export const TENANT_VIEWED: AuditAction = 'admin.tenant_viewed';
export const PLAN_ASSIGNED: AuditAction = 'admin.plan_assigned';
export const FEATURE_OVERRIDDEN: AuditAction = 'admin.feature_overridden';
export const TENANT_SUSPENDED: AuditAction = 'admin.tenant_suspended';
export const TENANT_REACTIVATED: AuditAction = 'admin.tenant_reactivated';
export const OVERVIEW_VIEWED: AuditAction = 'admin.overview_viewed';
export const AUDIT_VIEWED: AuditAction = 'admin.audit_viewed';

/* The package editor. Every one of these changes what somebody can be sold or
 * what they are allowed to do, across every tenant at once, so all six are
 * awaited rather than emitted — see `AdminService.assignPlan` for why a write's
 * audit row is not fire-and-forget. */
export const PLAN_CREATED: AuditAction = 'admin.plan_created';
export const PLAN_UPDATED: AuditAction = 'admin.plan_updated';
export const PLAN_FEATURES_UPDATED: AuditAction = 'admin.plan_features_updated';
export const PLAN_RETIRED: AuditAction = 'admin.plan_retired';
export const PLAN_UNRETIRED: AuditAction = 'admin.plan_unretired';
export const FEATURE_CREATED: AuditAction = 'admin.feature_created';
export const FEATURE_UPDATED: AuditAction = 'admin.feature_updated';

export const IMPERSONATION_STARTED: AuditAction = 'support.impersonation_started';
export const IMPERSONATION_ENDED: AuditAction = 'support.impersonation_ended';

/**
 * Who is doing the looking.
 *
 * `workspaceId` is the **operator's own** workspace, not the tenant's. It is
 * the fallback target for the handful of actions that concern no single tenant
 * — see `AdminService.fileAgainst`.
 */
export interface AdminActor {
  id: string;
  email: string;
  workspaceId: string;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Where a cross-tenant action is recorded.
 *
 * `AuditEvent.workspaceId` is not nullable and is a foreign key, so there is no
 * such thing as a row belonging to no tenant. Anything about one tenant is filed
 * against that tenant. Anything about the platform — the tenant list, the
 * overview, a package edit — is filed against the **operator's own** workspace:
 * the only workspace they have standing in, and the one place a review of "what
 * did this operator do?" reads back complete.
 */
export const fileAgainst = (actor: AdminActor, workspaceId?: string) => ({
  workspaceId: workspaceId ?? actor.workspaceId,
  actorUserId: actor.id,
  actorType: 'SUPPORT' as const,
  ip: actor.ip,
  userAgent: actor.userAgent,
});
