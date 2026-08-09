'use client';

import { api, endpoints } from '@/lib/api';

export interface CatalogueFeature {
  key: string;
  label: string;
  /** `null` is unlimited. For a FLAG, 0 is off. */
  limitValue: number | null;
}

export interface CataloguePlan {
  code: string;
  name: string;
  /** Integer poisha. A placeholder until pricing is decided — see the screen. */
  priceMinor: number;
  interval: string;
  features: CatalogueFeature[];
}

/**
 * `['entitlements']` is the key the rest of the app already uses for the
 * snapshot, so this screen shares that cache instead of opening a second one,
 * and the catalogue sits under the same prefix — one
 * `invalidateQueries({ queryKey: ['entitlements'] })` refreshes both.
 */
export const planKeys = {
  snapshot: () => ['entitlements'] as const,
  catalogue: () => ['entitlements', 'plans'] as const,
};

export const fetchSnapshot = endpoints.entitlements;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `priceMinor` reaches `<Money>`, and `formatMinor` throws on a non-integer. */
function minor(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function limit(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export async function fetchCatalogue(): Promise<CataloguePlan[]> {
  const raw = await api<unknown>('/entitlements/plans');
  const list = Array.isArray(raw) ? raw : [];

  return list.map((entry) => {
    const row = isRecord(entry) ? entry : {};
    const features = Array.isArray(row.features) ? row.features : [];
    return {
      code: typeof row.code === 'string' ? row.code : '',
      name: typeof row.name === 'string' ? row.name : '',
      priceMinor: minor(row.priceMinor),
      interval: typeof row.interval === 'string' ? row.interval : 'MONTHLY',
      features: features.map((item) => {
        const feature = isRecord(item) ? item : {};
        return {
          key: typeof feature.key === 'string' ? feature.key : '',
          label: typeof feature.label === 'string' ? feature.label : '',
          limitValue: limit(feature.limitValue),
        };
      }),
    };
  });
}
