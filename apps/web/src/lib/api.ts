'use client';

import type { AccountType } from '@hishab/shared';
import { enqueueMutation } from './offline-queue';
import { activeSupportSession, clearSupportSession } from './support-session';

/**
 * Every browser request goes to our own origin at /api/* and Next proxies it to
 * the API. Cookies are therefore first-party and there is no CORS preflight.
 */
export const API_BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * A 402 from the entitlement layer. Carries what the plan allows and what has
 * been used, so the UI can say something true rather than "request failed".
 */
export class FeatureLimitError extends ApiError {
  constructor(
    message: string,
    readonly featureKey: string,
    readonly limit: number,
    readonly used: number,
    readonly upgradeUrl: string,
  ) {
    super(402, message);
    this.name = 'FeatureLimitError';
  }
}

/**
 * Thrown when a support session tried to write while offline.
 *
 * Not a refusal of the write itself — a session may write, and that is the
 * point of it. It is a refusal to *park* one. The offline queue replays a
 * parked row later under whatever cookie this browser then holds, which for an
 * operator is their own: the entry would land in the operator's workspace,
 * under the operator's name, in a workspace that has no idea what it means.
 * Better to fail now, while the person who typed it is still looking.
 */
export class SupportOfflineError extends ApiError {
  constructor() {
    super(0, 'সাপোর্ট সেশনে অফলাইনে কিছু জমা রাখা যায় না — সংযোগ ফিরলে আবার চেষ্টা করুন');
    this.name = 'SupportOfflineError';
  }
}

/** Thrown when the support token ran out mid-session. */
export class SupportSessionExpiredError extends ApiError {
  constructor() {
    super(401, 'সাপোর্ট সেশনের মেয়াদ শেষ — দেখতে হলে নতুন করে সেশন চালু করুন');
    this.name = 'SupportSessionExpiredError';
  }
}

/** Thrown when a mutation was parked in the offline queue instead of being sent. */
export class QueuedOfflineError extends Error {
  constructor() {
    super('অফলাইন — পরিবর্তন সংরক্ষিত হয়েছে, সংযোগ ফিরলে পাঠানো হবে');
    this.name = 'QueuedOfflineError';
  }
}

let refreshInFlight: Promise<boolean> | null = null;

/**
 * True while a token rotation is on the wire.
 *
 * The mutex above is per *page load*, which is enough for the case it was
 * written for — several 401s at once — and not enough for a reload. A refresh
 * that is cancelled halfway leaves the server having already spent the token
 * while the browser still holds the old one in its cookie; the next load
 * presents it, and the server correctly reads that as a replay and revokes the
 * whole family. The person is signed out of their own books by an update.
 *
 * Anything that deliberately reloads the page has to wait for this to be
 * false. See `adoptUpdates` in `service-worker-registrar.tsx`.
 */
export function isRefreshing(): boolean {
  return refreshInFlight !== null;
}

async function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      // Let the next 401 try again rather than caching a stale answer.
      setTimeout(() => {
        refreshInFlight = null;
      }, 0);
    }
  })();
  return refreshInFlight;
}

export interface ApiOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Park this mutation in IndexedDB when offline instead of failing. */
  queueWhenOffline?: boolean;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { body, queueWhenOffline, ...init } = options;
  const method = init.method ?? 'GET';

  /**
   * Which identity this one request travels as.
   *
   * A support session is a bearer token for the customer's own user, and
   * `JwtStrategy` reads the `Authorization` header *before* the `hishab_at`
   * cookie — so attaching it is the whole mechanism. The operator's cookie is
   * still in the jar and is simply outranked; `credentials: 'omit'` below makes
   * that explicit rather than relying on the extractor order for correctness,
   * and means a request that should have been impersonated fails loudly instead
   * of quietly succeeding as the operator.
   *
   * `/admin/*` is excluded, and that exclusion is the exit door. Those routes
   * are guarded by `SuperAdminGuard`, which reads `isSuperAdmin` for whoever
   * the request authenticates as — the customer is not an operator, so sending
   * the support token to `/admin/impersonate/end` would 404 the only call that
   * closes the session. The operator's own cookie goes there, always.
   */
  const support = path.startsWith('/admin') ? null : activeSupportSession();

  /* A support session writes online or not at all. See `SupportOfflineError`. */
  if (support && method !== 'GET' && typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new SupportOfflineError();
  }

  if (
    !support &&
    queueWhenOffline &&
    method !== 'GET' &&
    typeof navigator !== 'undefined' &&
    !navigator.onLine
  ) {
    await enqueueMutation({ path, method, body });
    throw new QueuedOfflineError();
  }

  const doFetch = (): Promise<Response> =>
    fetch(`${API_BASE}${path}`, {
      ...init,
      method,
      credentials: support ? 'omit' : 'same-origin',
      headers: {
        'content-type': 'application/json',
        ...(support ? { authorization: `Bearer ${support.accessToken}` } : {}),
        ...(init.headers ?? {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  let res: Response;
  try {
    res = await doFetch();
  } catch {
    /* Same rule on a request that failed rather than one that never left: a
     * support session's write must not be parked for a later replay under the
     * operator's own cookie. */
    if (support && method !== 'GET') throw new SupportOfflineError();
    if (queueWhenOffline && method !== 'GET') {
      await enqueueMutation({ path, method, body });
      throw new QueuedOfflineError();
    }
    throw new ApiError(0, 'সংযোগ পাওয়া যাচ্ছে না');
  }

  if (res.status === 401 && !path.startsWith('/auth/')) {
    if (support) {
      /* Never rotate a support session. The refresh cookie in this browser is
       * the *operator's*, so `POST /auth/refresh` would succeed, mint a token
       * for them, and the next request would quietly go through as the operator
       * — same screens, different identity, no visible change. A support token
       * has no refresh token by design; when it is gone the session is over and
       * has to be started again with a stated reason. */
      clearSupportSession();
      throw new SupportSessionExpiredError();
    }
    // The 15-minute access token expired; rotate once and retry.
    if (await refreshSession()) res = await doFetch();
  }

  if (res.status === 204) return undefined as T;

  const payload: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    const detail = payload as {
      message?: string;
      issues?: { path: string; message: string }[];
      featureKey?: string;
      limit?: number;
      used?: number;
      upgradeUrl?: string;
    };

    if (res.status === 402 && detail?.featureKey) {
      throw new FeatureLimitError(
        detail.message ?? 'প্ল্যানের সীমা শেষ',
        detail.featureKey,
        detail.limit ?? 0,
        detail.used ?? 0,
        detail.upgradeUrl ?? '/settings',
      );
    }

    throw new ApiError(
      res.status,
      detail?.message ?? `অনুরোধ ব্যর্থ (${res.status})`,
      detail?.issues,
    );
  }

  return payload as T;
}

// --- Typed endpoints -------------------------------------------------------

export interface AccountDto {
  id: string;
  name: string;
  /* The real union, not `string`. The dashboard has to ask whether a line is
     money, an asset or a liability, and a bare string turns that question into
     a cast — which is how a screen ends up quietly classifying a type nobody
     added to it. */
  type: AccountType;
  currency: string;
  openingBalance: number;
  /* The day the opening balance was true, or null when there is none. It is a
     dated OPENING_BALANCE transaction against equity now, not a column without
     a date, so a balance sheet can tell whether it had happened yet. */
  openingBalanceDate: string | null;
  balanceMinor: number;
  institution: string | null;
  /** Branch, nominee, cheque-book series — whatever belongs in no other field. */
  note: string | null;
  /** `ASSET` accounts only: land, a car, gold, a share account. */
  assetKind: 'PROPERTY' | 'VEHICLE' | 'GOLD' | 'INVESTMENT' | 'OTHER' | null;
  /** What it cost. `balanceMinor` is the carrying amount; this is the original. */
  purchaseCostMinor: number | null;
  purchaseDate: string | null;
  accountNumberMasked: string | null;
  matchHints: string[];
  isArchived: boolean;
  sortOrder: number;
  icon: string | null;
  color: string | null;
  /** Credit cards: what the bank allows, what is drawn, what is left. */
  creditLimitMinor: number;
  drawnMinor: number;
  undrawnMinor: number;
  statementDayOfMonth: number | null;
  dueDayOfMonth: number | null;
  reminderLeadDays: number | null;
}

export interface CategoryDto {
  id: string;
  name: string;
  nameBn: string | null;
  kind: 'INCOME' | 'EXPENSE';
  icon: string | null;
  color: string | null;
  sortOrder: number;
  parentId?: string | null;
  isSystem?: boolean;
  usageCount?: number;
}

export interface TransactionDto {
  id: string;
  date: string;
  type: string;
  description: string | null;
  payee: string | null;
  notes: string | null;
  source: string;
  amountMinor: number;
  accountId: string | null;
  accountName: string | null;
  counterAccountId: string | null;
  counterAccountName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  /**
   * The খাত `categoryName` hangs off, when it hangs off one.
   *
   * The tree is two levels deep and `categoryId` is whichever of them the user
   * filed under, so `categoryName` is the leaf and this is the branch above it.
   * Null on a row filed straight under a top-level খাত — which is how the khata
   * tells "this is the খাত" from "this is a sub-খাত of one" without a second
   * request.
   *
   * Optional at the type level because a row replayed from the offline queue,
   * or one cached before the API carried the pair, has neither.
   */
  parentCategoryId?: string | null;
  parentCategoryName?: string | null;
  /** Who the money was with. A `Person` row, unlike the free-text `payee`. */
  personId: string | null;
  /** The DPS, FDR or Sanchayapatra this row belongs to, when it belongs to one. */
  savingsPlanId: string | null;
  personName: string | null;
  /**
   * The period a one-off payment covers — a year of insurance, a licence.
   *
   * Read by the prepaid spread screen and by nothing else. **Neither field
   * generates a transaction:** the whole expense posts on `date` exactly as it
   * always did, and the spread divides it for the eye at the moment it is
   * drawn. These books are cash basis and stay that way.
   */
  prepaidStartDate: string | null;
  prepaidMonths: number | null;
  /** Labels — who for, what project. Several per row, unlike the category. */
  tags: TransactionTagDto[];
  /** Receipt ids, in the order they were attached. */
  attachmentIds: string[];
  /** Thousandths of `quantityUnit`. 500 is half a kilo. */
  quantityMilli: number | null;
  quantityUnit: string | null;
  /** ISO 4217 the money was actually in, or null when it was the workspace's own. */
  fxCurrency: string | null;
  /** The amount in `fxCurrency`. The rate is `|amountMinor| / fxAmountMinor`. */
  fxAmountMinor: number | null;
  createdAt: string;
  balanceAfterMinor?: number;
}

/** One tag as it rides along on a transaction. Enough to render a chip. */
export interface TransactionTagDto {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
}

export interface SummaryDto {
  from: string;
  to: string;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
  expenseByCategory: { categoryId: string | null; name: string; totalMinor: number }[];
  /** Cash, bank and mobile wallet: what can be spent today. */
  liquidMinor: number;
  /** Every asset less every liability, control accounts included. */
  netWorthMinor: number;
  assetsMinor: number;
  liabilitiesMinor: number;
}

export interface EntitlementsDto {
  entitlements: Record<string, number | null>;
  usage: Record<string, number>;
  remaining: Record<string, number | null>;
  plan: { code: string; name: string; priceMinor: number } | null;
}

/**
 * `workspace` is what `/auth/me` has always returned; it is declared here
 * because the offline queue stamps every parked mutation with the user *and*
 * the workspace it was written under, and a user id alone would let a row
 * queued in one workspace replay into another.
 */
export interface MeDto {
  id: string;
  email: string;
  name: string;
  locale: string;
  emailVerifiedAt: string | null;
  /**
   * Platform operator. Decides whether one nav link is drawn and nothing else —
   * every byte the admin panel shows still passes `SuperAdminGuard`, which
   * re-reads this from the database on every request. Forging it here buys a
   * menu item that leads to a 404.
   */
  isSuperAdmin: boolean;
  /**
   * This person's standing in the workspace on their way in.
   *
   * Decides which screens are offered, never which are allowed: `RolesGuard`
   * re-reads the membership on every request, so a forged value here buys a
   * menu item that leads to a 403.
   */
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
  workspace: { id: string; name: string; currency: string; timezone: string };
}

export const endpoints = {
  entitlements: () => api<EntitlementsDto>('/entitlements'),
  me: () => api<MeDto>('/auth/me'),
  accounts: () => api<AccountDto[]>('/accounts'),
  categories: () => api<CategoryDto[]>('/categories'),
  summary: () => api<SummaryDto>('/transactions/summary'),
  transactions: (params: Record<string, string | number | undefined> = {}) => {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') search.set(k, String(v));
    }
    const qs = search.toString();
    return api<{ items: TransactionDto[]; nextCursor: string | null }>(
      `/transactions${qs ? `?${qs}` : ''}`,
    );
  },
};
