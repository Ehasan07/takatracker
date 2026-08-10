'use client';

import type { QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { adminKeys } from '../queries';
import { toAdminCatalogue, type AdminFeatureCatalogue, type LabelOrientation } from './types';

/**
 * The feature catalogue as an operator sees it.
 *
 * `/v1/entitlements/features` returns the same rows and any signed-in user may
 * read it, but it cannot create one and it hides nothing — so the admin screens
 * read the admin endpoint, which is also the one that answers 404 to a
 * non-operator and keeps this whole subtree behaving like a subtree that is not
 * there.
 */

/**
 * Under the `['admin']` prefix, so one write invalidates the overview, the
 * tenant that was just changed, the plans and this — see `adminKeys`. Not under
 * `['admin', 'catalogue']`, which the panel already uses for the *tenant-facing*
 * shape of these same rows: one key with two fetchers behind it renders
 * whichever shape happened to be fetched first.
 */
export const featureCatalogueKeys = {
  all: ['admin', 'feature-catalogue'] as const,
  list: () => ['admin', 'feature-catalogue', 'list'] as const,
};

export async function fetchAdminCatalogue(): Promise<AdminFeatureCatalogue> {
  return toAdminCatalogue(await api<unknown>('/admin/features'));
}

/** What the two forms collect, before it is bent into whatever the API calls it. */
export interface FeatureInput {
  key: string;
  labelBn: string;
  labelEn: string;
  kind: string;
  unit: string;
  period: string;
  category: string;
  sortOrder: number;
  isActive: boolean;
}

/**
 * The two label fields, filled in for whichever dialect the server speaks.
 *
 * The shipped API speaks the columns — `label` is English, `labelBn` Bengali —
 * and says so in its schema's own comment. This still reads the orientation off
 * the `GET` rather than hard-coding it, because the same two words mean the
 * opposite thing one module away in `FeatureCatalogueService`, and a screen
 * that guessed wrong would write an English string into the Bengali column and
 * the mistake would first surface in a 402 body, in front of a customer.
 *
 * When nothing came back to read — an empty catalogue on a fresh install — it
 * follows the column names, because that is what the write endpoint validates
 * against.
 */
function labelFields(
  input: FeatureInput,
  orientation: LabelOrientation,
): { label: string; labelBn: string } {
  return {
    label: orientation === 'catalogue' ? input.labelBn : input.labelEn,
    labelBn: input.labelBn,
  };
}

export function createFeature(
  input: FeatureInput,
  orientation: LabelOrientation,
): Promise<unknown> {
  return api<unknown>('/admin/features', {
    method: 'POST',
    body: {
      key: input.key,
      ...labelFields(input, orientation),
      kind: input.kind,
      unit: input.unit,
      period: input.period,
      category: input.category,
      sortOrder: input.sortOrder,
      isActive: input.isActive,
    },
  });
}

/**
 * The six fields a feature can still change after it exists.
 *
 * `key`, `kind` and `period` are absent on purpose, and not merely disabled in
 * the form: the endpoint's schema is `.strict()`, so sending any of them is a
 * 400 rather than a silent no-op — which is the right server behaviour and the
 * wrong thing to show an operator. `kind` reinterprets every number already
 * stored against the feature in every package and every override; `period`
 * moves which bucket a meter counts into, so yesterday's usage would be read
 * out of a bucket nobody wrote to.
 *
 * `labelEn` is not sent either, for the plainer reason that it is not a column:
 * the admin API speaks the `Feature` table's own names, where `label` is the
 * English one. `labelFields` is trimmed to the two the schema allows.
 */
export function updateFeature(
  key: string,
  input: FeatureInput,
  orientation: LabelOrientation,
): Promise<unknown> {
  const { label, labelBn } = labelFields(input, orientation);
  return api<unknown>(`/admin/features/${encodeURIComponent(key)}`, {
    method: 'PATCH',
    body: {
      label,
      labelBn,
      unit: input.unit,
      category: input.category,
      sortOrder: input.sortOrder,
      isActive: input.isActive,
    },
  });
}

/**
 * Everything a catalogue or package write can have invalidated.
 *
 * Two namespaces, because these rows are read through two different front
 * doors. `['admin']` is the operator panel — the overview's near-limit sweep,
 * the tenant detail's limit table, the plan picker on it, and these screens.
 * `['entitlements']` is the *customer* side: the snapshot every screen greys
 * its buttons from, and the public pricing table, both of which are computed
 * from the very rows that just changed. Missing the second one is how an
 * operator raises a limit, sees it applied on the admin screen, and is told by
 * the customer that nothing happened.
 *
 * `adminKeys.probe()` deliberately sits outside `['admin']` and so is not
 * refetched here: it costs a request and an audit row to re-learn something
 * that cannot have changed.
 */
export function invalidatePlatformCaches(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: adminKeys.all });
  void queryClient.invalidateQueries({ queryKey: ['entitlements'] });
}
