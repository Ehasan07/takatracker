import { Injectable, Logger } from '@nestjs/common';
import { DEFAULT_FEATURES, featureLabel, type FeatureKind, type MeterPeriod } from '@hishab/core';
import { PrismaService } from '../prisma/prisma.service';

/**
 * One row of the catalogue, as the rest of the API wants to read it.
 *
 * `label` is the Bengali string and `labelEn` the English one, which is the
 * opposite way round from the column names: `Feature.labelBn` holds the
 * Bengali, `Feature.label` the English. Flipping it here rather than at every
 * call site means nothing downstream has to remember which column a user is
 * allowed to see.
 */
export interface CatalogueFeature {
  key: string;
  /** Bengali. Shown to users — 402 bodies, the plan comparison table. */
  label: string;
  /** English. Admin screens and logs. */
  labelEn: string;
  kind: FeatureKind;
  unit: string;
  period: MeterPeriod;
  category: string;
  isActive: boolean;
  sortOrder: number;
}

/**
 * How long a cached catalogue is trusted.
 *
 * The catalogue is read on nearly every entitlement check and changes about
 * once a quarter, so querying it per request would be a pointless round trip.
 * Thirty seconds is short enough that a super admin who adds a feature sees it
 * without anyone restarting a process, and a *miss* refreshes immediately
 * (below), so the only thing this delay affects is a label edit.
 */
const CACHE_TTL_MS = 30_000;

/**
 * The feature catalogue, which lives in the `Feature` table.
 *
 * It used to be a `const` tuple in `packages/core`, so adding a sellable
 * feature meant a deployment and a super admin could never assemble a Custom
 * package — the thing packages exist for. The code now holds only the defaults
 * and seeds them at boot; everything that asks "what features are there?" asks
 * this service, and this service asks the database.
 */
@Injectable()
export class FeatureCatalogueService {
  private readonly logger = new Logger(FeatureCatalogueService.name);

  private cache: { at: number; byKey: Map<string, CatalogueFeature> } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Upsert the shipped defaults.
   *
   * Called from `EntitlementsService.onModuleInit` *before* the plans are
   * seeded, because `PlanFeature.featureKey` is a foreign key to `Feature.key`
   * and a plan cannot grant a feature that does not exist yet.
   *
   * It deliberately does not deactivate or delete anything it did not write. A
   * feature a super admin created last week is not in this build's defaults and
   * must survive the next deploy — pruning here would wipe the catalogue clean
   * every time the process restarted, which is the exact failure this whole
   * change exists to prevent. Retiring a feature is `isActive: false`, set by a
   * human, so plans that already grant it keep it and nothing new sells it.
   */
  async seed(): Promise<void> {
    for (const definition of DEFAULT_FEATURES) {
      const row = {
        // Column names are English-first; the product is Bengali-first. See
        // CatalogueFeature above.
        label: definition.labelEn,
        labelBn: definition.label,
        kind: definition.kind,
        // The column is NOT NULL; a definition that omits the unit means "a
        // plain count", which is what every renderer already falls back to.
        unit: definition.unit ?? 'count',
        period: definition.period,
        category: definition.category,
        sortOrder: definition.sortOrder,
      };

      await this.prisma.feature.upsert({
        where: { key: definition.key },
        // `isActive` is only ever set on create. If an operator retired a
        // shipped feature by hand, a redeploy must not quietly sell it again.
        create: { key: definition.key, isActive: definition.isActive, ...row },
        update: row,
      });
    }

    this.invalidate();
  }

  /** Drop the cache. Call after writing to `Feature` from anywhere else. */
  invalidate(): void {
    this.cache = null;
  }

  /** The whole catalogue, retired entries included, in display order. */
  async all(): Promise<CatalogueFeature[]> {
    const byKey = await this.load();
    return [...byKey.values()].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key),
    );
  }

  /** Only what a new package may still be built from. */
  async active(): Promise<CatalogueFeature[]> {
    return (await this.all()).filter((f) => f.isActive);
  }

  /**
   * One entry, or undefined.
   *
   * A miss on a cache that is not brand new forces one refresh, so a feature
   * created seconds ago is usable at once. The age check is what stops a
   * genuinely unknown key — a typo in a call site — from costing a query on
   * every request.
   */
  async find(key: string): Promise<CatalogueFeature | undefined> {
    const hit = (await this.load()).get(key);
    if (hit) return hit;

    const age = this.cache ? Date.now() - this.cache.at : Infinity;
    if (age < 1_000) return undefined;

    this.invalidate();
    return (await this.load()).get(key);
  }

  /**
   * Which bucket this feature's meter writes into.
   *
   * LIFETIME for anything unknown: a counter that never resets can only ever
   * over-report, and over-reporting a limit is a support ticket while
   * under-reporting one is a feature given away.
   */
  async periodOf(key: string): Promise<MeterPeriod> {
    return (await this.find(key))?.period ?? 'LIFETIME';
  }

  /**
   * The Bengali label for a 402 body.
   *
   * Falls back to the shipped defaults, then to the key itself, so a limit
   * message is never blank — a paywall that cannot name what it blocked is
   * worse than the block.
   */
  async labelOf(key: string): Promise<string> {
    return (await this.find(key))?.label ?? featureLabel(key);
  }

  private async load(): Promise<Map<string, CatalogueFeature>> {
    const cached = this.cache;
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.byKey;

    const rows = await this.prisma.feature.findMany();
    const byKey = new Map<string, CatalogueFeature>(
      rows.map((r) => [
        r.key,
        {
          key: r.key,
          label: r.labelBn,
          labelEn: r.label,
          kind: r.kind,
          unit: r.unit,
          period: r.period,
          category: r.category,
          isActive: r.isActive,
          sortOrder: r.sortOrder,
        },
      ]),
    );

    if (byKey.size === 0) {
      // Not fatal — `seed()` runs at boot and will fill it — but a catalogue
      // with nothing in it means every plan resolves to nothing, and that is
      // worth seeing in the log rather than diagnosing from a blank pricing page.
      this.logger.warn('The Feature catalogue is empty; no plan can grant anything');
    }

    this.cache = { at: Date.now(), byKey };
    return byKey;
  }
}
