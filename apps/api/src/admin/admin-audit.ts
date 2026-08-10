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
 * TODO(main): `AUDIT_ACTIONS` in audit/audit.service.ts does not carry these
 * yet, and that file belongs to another change, so each string is asserted here
 * rather than edited in there. Nothing is wrong with the rows that get written —
 * `AuditEvent.action` is a plain `String` column, no enum and no migration.
 * Delete the assertions once these are in the union:
 *
 *   admin.tenant_viewed
 *   admin.tenant_list_viewed
 *   admin.plan_assigned
 *   admin.feature_overridden
 *   admin.tenant_suspended
 *   admin.tenant_reactivated
 *   admin.overview_viewed
 *   admin.audit_viewed        <- NOT in the brief's list. Added because reading
 *                                the cross-tenant audit log is itself a read of
 *                                tenant data and the same rule applies to it.
 *                                Reuse of one of the others would have filed it
 *                                under a name that means something else.
 *   admin.plan_created
 *   admin.plan_updated
 *   admin.plan_features_updated
 *   admin.plan_retired
 *   admin.plan_unretired      <- NOT in the brief's list either, and for the
 *                                same reason as admin.audit_viewed: filing the
 *                                act of putting a package back on sale under
 *                                `admin.plan_retired` would name it as its own
 *                                inverse, and `admin.plan_updated` would bury
 *                                it among price edits. "When did this plan go
 *                                back on sale?" has to be one query.
 *   admin.feature_created
 *   admin.feature_updated
 */
export const TENANT_LIST_VIEWED = 'admin.tenant_list_viewed' as AuditAction;
export const TENANT_VIEWED = 'admin.tenant_viewed' as AuditAction;
export const PLAN_ASSIGNED = 'admin.plan_assigned' as AuditAction;
export const FEATURE_OVERRIDDEN = 'admin.feature_overridden' as AuditAction;
export const TENANT_SUSPENDED = 'admin.tenant_suspended' as AuditAction;
export const TENANT_REACTIVATED = 'admin.tenant_reactivated' as AuditAction;
export const OVERVIEW_VIEWED = 'admin.overview_viewed' as AuditAction;
export const AUDIT_VIEWED = 'admin.audit_viewed' as AuditAction;

/* The package editor. Every one of these changes what somebody can be sold or
 * what they are allowed to do, across every tenant at once, so all six are
 * awaited rather than emitted — see `AdminService.assignPlan` for why a write's
 * audit row is not fire-and-forget. */
export const PLAN_CREATED = 'admin.plan_created' as AuditAction;
export const PLAN_UPDATED = 'admin.plan_updated' as AuditAction;
export const PLAN_FEATURES_UPDATED = 'admin.plan_features_updated' as AuditAction;
export const PLAN_RETIRED = 'admin.plan_retired' as AuditAction;
export const PLAN_UNRETIRED = 'admin.plan_unretired' as AuditAction;
export const FEATURE_CREATED = 'admin.feature_created' as AuditAction;
export const FEATURE_UPDATED = 'admin.feature_updated' as AuditAction;

/* These two are already in the union and nothing emitted them until now. No
 * assertion: the annotation proves they exist, so a rename upstream is a
 * compile error here rather than a silently orphaned string. */
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
