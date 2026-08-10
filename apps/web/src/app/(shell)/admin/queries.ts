'use client';

import { useQuery, type QueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import {
  toAuditPage,
  toCatalogue,
  toEnvelope,
  toOverview,
  toTenantDetail,
  toTenantPage,
  type CatalogueFeature,
  type ImpersonationEnvelope,
  type Overview,
  type PlatformAuditPage,
  type TenantDetail,
  type TenantPage,
} from './types';

/**
 * The 404 that means "you are not an operator".
 *
 * `SuperAdminGuard` answers every rejection — not signed in, token expired, not
 * a super admin — with the same 404 a request for an unrouted path gets, on
 * purpose: a 403 would confirm that `/admin` exists and, probed path by path,
 * would hand over the whole route map. This screen keeps that promise from the
 * other side. Every admin 404 renders the ordinary not-found body and the words
 * "permission" and "operator" appear nowhere in it.
 *
 * It deliberately cannot tell that apart from a workspace that does not exist —
 * `AdminService.tenantDetail` throws 404 for a deleted tenant too. Both are the
 * same screen, which is the right answer for both: there is nothing here.
 */
export const isNotHere = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;

export interface TenantFilters {
  q?: string;
  status?: string;
  planCode?: string;
}

export interface AuditFilters {
  workspaceId?: string;
  actorId?: string;
  action?: string;
}

/** The API's own default is 25 and its ceiling 100. */
export const TENANT_PAGE_SIZE = 25;
export const AUDIT_PAGE_SIZE = 50;

/**
 * One key namespace for the whole panel, so a single
 * `invalidateQueries({ queryKey: ['admin'] })` refreshes the overview, the list
 * and the tenant that was just changed together.
 */
export const adminKeys = {
  all: ['admin'] as const,
  /* Outside the `['admin']` namespace on purpose. Every write invalidates that
   * whole prefix, and the probe is the one query that must not be refetched by
   * a write: it costs a request and an audit row to re-learn something that
   * cannot have changed because the operator just successfully used it. */
  probe: () => ['operator-probe'] as const,
  overview: () => ['admin', 'overview'] as const,
  tenants: (filters: TenantFilters) => ['admin', 'tenants', filters] as const,
  tenant: (id: string) => ['admin', 'tenant', id] as const,
  audit: (filters: AuditFilters) => ['admin', 'audit', filters] as const,
};

/**
 * The two tenant-facing catalogue reads, cached under `['admin']` rather than
 * under the keys `/plans` uses for the same endpoints.
 *
 * Sharing a cache means sharing a shape, and these do not: this panel wants
 * plan codes to pick from, `/plans` wants each plan's whole feature list. One
 * key with two fetchers behind it is a screen rendering whichever shape
 * happened to be fetched first, which shows up as an undefined `.features` on
 * the pricing table long after the change that caused it. Two keys, two
 * shapes. The cost is that an admin write refetches both, which is two cheap
 * requests and is arguably right anyway — a package can appear.
 */
export const catalogueKeys = {
  features: () => ['admin', 'catalogue', 'features'] as const,
  plans: () => ['admin', 'catalogue', 'plans'] as const,
};

function search(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') qs.set(key, String(value));
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
}

// --- reads ---------------------------------------------------------------------

export async function fetchOverview(): Promise<Overview> {
  return toOverview(await api<unknown>('/admin/overview'));
}

export async function fetchTenants(filters: TenantFilters, cursor?: string): Promise<TenantPage> {
  return toTenantPage(
    await api<unknown>(
      `/admin/tenants${search({
        q: filters.q,
        status: filters.status,
        planCode: filters.planCode,
        limit: TENANT_PAGE_SIZE,
        cursor,
      })}`,
    ),
  );
}

export async function fetchTenant(id: string): Promise<TenantDetail> {
  return toTenantDetail(await api<unknown>(`/admin/tenants/${id}`));
}

/**
 * Every feature the platform knows about, so a key created after this build
 * shipped still has a Bengali name on screen.
 *
 * `/v1/entitlements/features` and not an admin route: there is no admin
 * catalogue endpoint, and this one is readable by any signed-in user anyway.
 */
export async function fetchFeatureCatalogue(): Promise<CatalogueFeature[]> {
  return toCatalogue(await api<unknown>('/entitlements/features'));
}

/** The packages a tenant can be moved onto — see `PlanPicker` for the caveat. */
export async function fetchPlans(): Promise<{ code: string; name: string; priceMinor: number }[]> {
  const raw = await api<unknown>('/entitlements/plans');
  const rows = Array.isArray(raw) ? raw : [];
  return rows.map((entry) => {
    const row = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >;
    const code = typeof row.code === 'string' ? row.code : '';
    const price = Number(row.priceMinor);
    return {
      code,
      name: typeof row.name === 'string' && row.name !== '' ? row.name : code,
      priceMinor: Number.isFinite(price) ? Math.trunc(price) : 0,
    };
  });
}

/** One row, asked for only so the status code can be read. See `useOperatorProbe`. */
async function probeOperator(): Promise<true> {
  await api<unknown>('/admin/tenants?limit=1');
  return true;
}

export async function fetchPlatformAudit(
  filters: AuditFilters,
  cursor?: string,
): Promise<PlatformAuditPage> {
  return toAuditPage(
    await api<unknown>(
      `/admin/audit${search({
        workspaceId: filters.workspaceId,
        actorId: filters.actorId,
        action: filters.action,
        limit: AUDIT_PAGE_SIZE,
        cursor,
      })}`,
    ),
  );
}

// --- writes ----------------------------------------------------------------------

/**
 * None of these pass `queueWhenOffline`, and that is not an omission.
 *
 * A suspension or a limit grant replayed out of an IndexedDB queue an hour
 * later — against a tenant whose state has moved on, by an operator who has
 * closed the tab — is a change nobody authorised at the moment it landed. An
 * admin write either reaches the server now or fails loudly on this screen.
 */
export function assignPlan(
  workspaceId: string,
  body: { planCode: string; note?: string },
): Promise<unknown> {
  return api<unknown>(`/admin/tenants/${workspaceId}/plan`, { method: 'POST', body });
}

/**
 * The discriminated union, kept discriminated all the way to the wire.
 *
 * `limitValue: null` is *unlimited*, so it can never be the way "remove this
 * grant" is expressed — that is `action: 'clear'`, a different request. `note`
 * is required by the server on both arms and by the form on both arms.
 */
export type OverrideBody =
  | { action: 'set'; limitValue: number | null; expiresAt?: string | null; note: string }
  | { action: 'clear'; note: string };

export function setFeatureOverride(
  workspaceId: string,
  featureKey: string,
  body: OverrideBody,
): Promise<unknown> {
  return api<unknown>(`/admin/tenants/${workspaceId}/features/${encodeURIComponent(featureKey)}`, {
    method: 'PUT',
    body,
  });
}

export function setTenantStatus(
  workspaceId: string,
  action: 'suspend' | 'reactivate',
  reason?: string,
): Promise<unknown> {
  return api<unknown>(`/admin/tenants/${workspaceId}/${action}`, {
    method: 'POST',
    body: reason ? { reason } : {},
  });
}

export async function startImpersonation(
  workspaceId: string,
  body: { userId?: string; reason: string },
): Promise<ImpersonationEnvelope> {
  return toEnvelope(
    await api<unknown>(`/admin/tenants/${workspaceId}/impersonate`, { method: 'POST', body }),
  );
}

/**
 * Records the end of a support session. It does **not** revoke the token — the
 * API says so in its own response `note`, and the only server-side kill switch
 * for an unexpired access token would sign the customer out of their own
 * devices. The caller discards the token locally and the banner says the rest.
 */
export function endImpersonation(body: {
  workspaceId: string;
  sessionId?: string;
  actingAsUserId?: string;
}): Promise<unknown> {
  return api<unknown>('/admin/impersonate/end', { method: 'POST', body });
}

/**
 * Everything an admin write can invalidate.
 *
 * A plan change moves the tenant's entitlements, which moves the near-limit
 * sweep on the overview, and every one of these calls writes an audit row — so
 * the log is stale too. One namespace, one call.
 */
export function invalidateAdminData(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: adminKeys.all });
}

// --- am I an operator? -------------------------------------------------------------

/**
 * Whether this browser belongs to a super admin.
 *
 * There is no honest way to ask. `/auth/me` does not return `isSuperAdmin` and
 * the JWT does not carry it — deliberately, so a revoked operator loses access
 * on the next request rather than when their token happens to expire. So the
 * client learns the only way it can: it calls the cheapest admin endpoint and
 * reads the answer's status code. 404 means no.
 *
 * `/admin/tenants?limit=1` is that endpoint. `/admin/overview` would be the
 * natural question but it resolves entitlements for up to two thousand tenants,
 * which is not a thing to run because a nav item might need hiding.
 *
 * Fetched once per tab: `staleTime: Infinity` and no refetch on focus. Every
 * admin route writes an audit row, this one included, so a probe that ran on
 * every navigation would fill the platform log with its own footprints.
 */
export function useOperatorProbe(): {
  isOperator: boolean;
  isLoading: boolean;
  isNotHere: boolean;
  isError: boolean;
  refetch: () => void;
} {
  const probe = useQuery({
    queryKey: adminKeys.probe(),
    queryFn: probeOperator,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    retry: 0,
  });

  const notHere = isNotHere(probe.error);
  return {
    isOperator: probe.isSuccess,
    isLoading: probe.isPending,
    isNotHere: notHere,
    // A network failure is not a verdict — it is a screen that could not ask.
    isError: probe.isError && !notHere,
    refetch: () => void probe.refetch(),
  };
}
