/**
 * The `/v1/admin/features` contract, mirrored on the client.
 *
 * Read defensively for the same reason `../types.ts` is: a payload shape this
 * build has never seen must render as best it can rather than throw inside a
 * render and take away the operator's only view of the catalogue.
 *
 * ## The label flip
 *
 * There are two label orientations alive in this system and they are mirror
 * images of one another:
 *
 *   the columns      `label` is English, `labelBn` is Bengali
 *                    — `Feature` in Prisma, and the admin tenant payload
 *   the catalogue    `label` is Bengali, `labelEn` is English
 *                    — `FeatureCatalogueService`, `/v1/entitlements/features`
 *
 * `FeatureCatalogueService` explains why: the columns are named English-first
 * and the product is Bengali-first. Which one `GET /admin/features` speaks was
 * not settled when this screen was written, so it is not guessed — it is
 * *detected*, from whichever of `labelBn` / `labelEn` the rows carry, and the
 * create and edit forms write back in the same orientation they read. A screen
 * that guessed wrong would save an English string into the Bengali column and
 * the mistake would surface months later, in a 402 body, in front of a customer.
 */

export type JsonObject = { [key: string]: unknown };

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const obj = (value: unknown): JsonObject => (isObject(value) ? value : {});
const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;
const bool = (value: unknown): boolean => value === true;
const num = (value: unknown, fallback = 0): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * A list that may have arrived wrapped.
 *
 * `GET /admin/plans` and `GET /admin/features` are both documented as returning
 * "every row", which in this API is sometimes a bare array and sometimes
 * `{ items }` with a cursor beside it. Both are accepted so that a paginated
 * answer renders its first page instead of rendering nothing.
 */
export function unwrapList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const row = obj(raw);
  for (const key of ['items', 'features', 'plans', 'data', 'results']) {
    const value = row[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

/** Which way round the server names its label columns. See the essay above. */
export type LabelOrientation = 'columns' | 'catalogue' | 'unknown';

/** One package that grants this feature, and what it grants. */
export interface FeatureGrant {
  code: string;
  /** `null` unlimited, `0` off. */
  limitValue: number | null;
}

export interface AdminFeature {
  key: string;
  /** Bengali. What every screen in this product prints. */
  labelBn: string;
  /** English. Logs, and the admin list's second line. */
  labelEn: string;
  /** Widened past the Prisma enum: a kind added server-side must still print. */
  kind: string;
  unit: string;
  period: string;
  category: string;
  /** False is retired: plans that already grant it keep it, nothing new sells it. */
  isActive: boolean;
  sortOrder: number;
  /**
   * Which packages price it.
   *
   * This is what turns retiring a feature from a guess into a decision: it is
   * the list of packages that keep the feature after the catalogue stops
   * offering it. Empty means nothing sells it, which for a feature that has
   * been in the catalogue a while usually means it was never finished.
   */
  grantedByPlans: FeatureGrant[];
}

export interface AdminFeatureCatalogue {
  items: AdminFeature[];
  /** How to address the labels when writing back. */
  orientation: LabelOrientation;
}

function toFeature(raw: unknown, index: number): AdminFeature {
  const row = obj(raw);
  const key = str(row.key) !== '' ? str(row.key) : `feature-${index}`;

  const hasBn = typeof row.labelBn === 'string';
  const hasEn = typeof row.labelEn === 'string';
  const plain = str(row.label);

  /* With both siblings present, `label` is redundant and is ignored. With only
   * one, the *other* orientation tells us what the bare `label` must be. With
   * neither, the row is too old or too new to place, and the same string is
   * used for both rather than inventing an empty Bengali name. */
  const labelBn = hasBn ? str(row.labelBn) : hasEn ? plain : plain;
  const labelEn = hasEn ? str(row.labelEn) : hasBn ? plain : plain;

  return {
    key,
    labelBn,
    labelEn,
    kind: str(row.kind, 'LIMIT'),
    unit: str(row.unit, 'count'),
    period: str(row.period, 'LIFETIME'),
    category: str(row.category, 'core'),
    // Absent is treated as active: an older API that never sent the column must
    // not paint the whole catalogue as retired.
    isActive: row.isActive === undefined ? true : bool(row.isActive),
    sortOrder: num(row.sortOrder),
    grantedByPlans: (Array.isArray(row.grantedByPlans) ? row.grantedByPlans : []).flatMap(
      (entry): FeatureGrant[] => {
        const grant = obj(entry);
        const code = str(grant.code);
        if (code === '') return [];
        // `null` is unlimited and must not become a zero on the way in.
        const raw = grant.limitValue;
        const value = raw === null || raw === undefined ? null : Number(raw);
        return [
          { code, limitValue: value !== null && Number.isFinite(value) ? Math.trunc(value) : null },
        ];
      },
    ),
  };
}

export function toAdminCatalogue(raw: unknown): AdminFeatureCatalogue {
  const rows = unwrapList(raw);

  let orientation: LabelOrientation = 'unknown';
  for (const entry of rows) {
    const row = obj(entry);
    if (typeof row.labelBn === 'string') {
      orientation = 'columns';
      break;
    }
    if (typeof row.labelEn === 'string') {
      orientation = 'catalogue';
      break;
    }
  }

  const items = rows.map(toFeature);
  items.sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      a.sortOrder - b.sortOrder ||
      a.key.localeCompare(b.key),
  );

  return { items, orientation };
}

/** What to print for a feature: Bengali, then English, then the bare key. */
export const featureTitle = (feature: AdminFeature): string =>
  feature.labelBn !== '' ? feature.labelBn : feature.labelEn !== '' ? feature.labelEn : feature.key;
