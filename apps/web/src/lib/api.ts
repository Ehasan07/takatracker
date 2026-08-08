'use client';

import { enqueueMutation } from './offline-queue';

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

/** Thrown when a mutation was parked in the offline queue instead of being sent. */
export class QueuedOfflineError extends Error {
  constructor() {
    super('অফলাইন — পরিবর্তন সংরক্ষিত হয়েছে, সংযোগ ফিরলে পাঠানো হবে');
    this.name = 'QueuedOfflineError';
  }
}

let refreshInFlight: Promise<boolean> | null = null;

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

  if (
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
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  let res: Response;
  try {
    res = await doFetch();
  } catch {
    if (queueWhenOffline && method !== 'GET') {
      await enqueueMutation({ path, method, body });
      throw new QueuedOfflineError();
    }
    throw new ApiError(0, 'সংযোগ পাওয়া যাচ্ছে না');
  }

  // The 15-minute access token expired; rotate once and retry.
  if (res.status === 401 && !path.startsWith('/auth/')) {
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
  type: string;
  currency: string;
  openingBalance: number;
  balanceMinor: number;
  institution: string | null;
  accountNumberMasked: string | null;
  matchHints: string[];
  isArchived: boolean;
  sortOrder: number;
  icon: string | null;
  color: string | null;
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
  createdAt: string;
  balanceAfterMinor?: number;
}

export interface SummaryDto {
  from: string;
  to: string;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
  expenseByCategory: { categoryId: string | null; name: string; totalMinor: number }[];
}

export interface EntitlementsDto {
  entitlements: Record<string, number | null>;
  usage: Record<string, number>;
  remaining: Record<string, number | null>;
  plan: { code: string; name: string; priceMinor: number } | null;
}

export const endpoints = {
  entitlements: () => api<EntitlementsDto>('/entitlements'),
  me: () => api<{ id: string; email: string; name: string; locale: string }>('/auth/me'),
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
