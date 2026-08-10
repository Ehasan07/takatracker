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
 */
export const TENANT_LIST_VIEWED = 'admin.tenant_list_viewed' as AuditAction;
export const TENANT_VIEWED = 'admin.tenant_viewed' as AuditAction;
export const PLAN_ASSIGNED = 'admin.plan_assigned' as AuditAction;
export const FEATURE_OVERRIDDEN = 'admin.feature_overridden' as AuditAction;
export const TENANT_SUSPENDED = 'admin.tenant_suspended' as AuditAction;
export const TENANT_REACTIVATED = 'admin.tenant_reactivated' as AuditAction;
export const OVERVIEW_VIEWED = 'admin.overview_viewed' as AuditAction;
export const AUDIT_VIEWED = 'admin.audit_viewed' as AuditAction;

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
