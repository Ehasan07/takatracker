'use client';

import { api } from '@/lib/api';
import { toAdminPlans, toDryRun, type AdminPlan, type DryRunResult } from './types';

/**
 * The package endpoints.
 *
 * `GET /admin/plans` returns every package — public, private and retired — so
 * there is one read behind both screens and the detail page is a `find` over
 * the list rather than a second request that could disagree with it. The list
 * is small by nature: a SaaS with two hundred packages has a different problem.
 *
 * None of the writes pass `queueWhenOffline`, for the reason `../queries.ts`
 * gives: a price change replayed out of IndexedDB an hour later, against a
 * package whose limits have moved on, by an operator who closed the tab, is a
 * change nobody authorised at the moment it landed.
 */

/**
 * Under `['admin']` so every admin write refreshes these too, and *not* under
 * `['admin', 'catalogue']`, which the panel already uses for the tenant-facing
 * shape of the same packages. Same key, two shapes, is a screen rendering
 * whichever was fetched first.
 */
export const planAdminKeys = {
  all: ['admin', 'plan-admin'] as const,
  list: () => ['admin', 'plan-admin', 'list'] as const,
};

export async function fetchAdminPlans(): Promise<AdminPlan[]> {
  return toAdminPlans(await api<unknown>('/admin/plans'));
}

/** The whole limit map, as `POST` and `PUT` both want it. */
export type LimitMapBody = Record<string, number | null>;

export function limitBodyOf(limits: Map<string, number | null>): LimitMapBody {
  const body: LimitMapBody = {};
  for (const [key, value] of limits) body[key] = value;
  return body;
}

export interface PlanMetaInput {
  name: string;
  /** Integer poisha, parsed by `parseMoneyToMinor`. Never `x * 100`. */
  priceMinor: number;
  interval: string;
  sortOrder: number;
}

/** Creating one also decides whether it is on sale. Editing one does not — see below. */
export interface PlanCreateInput extends PlanMetaInput {
  isPublic: boolean;
}

export function createPlan(
  code: string,
  meta: PlanCreateInput,
  features: LimitMapBody,
): Promise<unknown> {
  return api<unknown>('/admin/plans', {
    method: 'POST',
    body: { code, ...meta, features },
  });
}

/**
 * Name, price, interval and sort order. Four fields, and only four.
 *
 * `code` is left out because it is immutable — workspaces are joined to their
 * package by it, so a rename would be a silent reassignment of everybody on it
 * — and because the endpoint's schema is `.strict()` and would answer a 400
 * rather than ignore it.
 *
 * `isPublic` is left out for a subtler reason. The API defines `retired` as
 * `!isPublic`: the same bit, under two names. If this form also wrote it, an
 * operator would have two controls for one value, and one of them — the quiet
 * dropdown in an edit sheet — would be able to retire a package without ever
 * saying the word. Visibility belongs to `retire` / `unretire`, which say what
 * they do and refuse to do it to the default package.
 */
export function updatePlan(code: string, meta: PlanMetaInput): Promise<unknown> {
  return api<unknown>(`/admin/plans/${encodeURIComponent(code)}`, {
    method: 'PATCH',
    body: meta,
  });
}

/**
 * Replace the whole limit map.
 *
 * The map is sent entire, not as a patch, because absence is meaningful: a key
 * left out of it is a feature this package stops pricing, which is a different
 * outcome from setting it to zero and has to be expressible. That is also why
 * the editor never sends a partial map.
 *
 * `features` is nested under a key of that name rather than being the body
 * itself, mirroring `POST /admin/plans`, so that `dryRun` cannot collide with a
 * feature called "dryRun".
 */
export function putPlanFeatures(
  code: string,
  features: LimitMapBody,
  dryRun: boolean,
): Promise<unknown> {
  return api<unknown>(`/admin/plans/${encodeURIComponent(code)}/features`, {
    method: 'PUT',
    body: dryRun ? { features, dryRun: true } : { features, dryRun: false },
  });
}

/** The same call, asked as a question. Nothing is written. */
export async function dryRunPlanFeatures(
  code: string,
  features: LimitMapBody,
): Promise<DryRunResult> {
  return toDryRun(await putPlanFeatures(code, features, true));
}

/**
 * Withdraw a package from sale, or put it back.
 *
 * There is no delete, on purpose — see `NO_DELETE`. There is no body either:
 * the endpoints take none, so there is nowhere to record a reason and the sheet
 * does not collect one. The audit row the server writes carries the operator,
 * the package and how many workspaces stayed on it, which is the fact worth
 * keeping; a note this client invented would be dropped in transit and the
 * operator would never learn that their explanation went nowhere.
 *
 * Both refuse in two cases the screens already prevent: retiring the default
 * package (new signups land on it), and retiring one that is already withdrawn.
 */
export function setPlanRetired(code: string, retired: boolean): Promise<unknown> {
  return api<unknown>(
    `/admin/plans/${encodeURIComponent(code)}/${retired ? 'retire' : 'unretire'}`,
    { method: 'POST', body: {} },
  );
}
