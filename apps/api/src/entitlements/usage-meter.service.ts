import { Injectable, Logger } from '@nestjs/common';
import { usagePeriodKey } from '@hishab/core';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FeatureCatalogueService } from './feature-catalogue.service';

const logger = new Logger('UsageMeterService');

/**
 * Enough of a Prisma client to write a meter.
 *
 * Typed as the narrow slice rather than `PrismaClient` so a caller can hand in
 * its own `$transaction` client and have the meter land atomically with the
 * work it is measuring. Counting a message that was rolled back is a slow leak
 * that nobody notices until somebody is billed for it.
 */
export type MeterClient = Pick<Prisma.TransactionClient, 'usageMeter'>;

export interface MeterOptions {
  /** Defaults to now. Injectable so a backfill can post into a past period. */
  now?: Date;
  /** Join the caller's transaction instead of writing on its own. */
  tx?: MeterClient;
}

/**
 * Bytes counted, messages ingested, tokens spent.
 *
 * Nine of the twelve features could not be enforced because nothing counted
 * them, and a limit nobody measures is a promise rather than a control. This is
 * the write side of the fix.
 *
 * WHAT DOES NOT BELONG HERE. Anything that can be recounted from the rows it
 * describes — accounts, monthly transactions, members, live mailbox
 * connections, attachment bytes on disk — stays a `COUNT(*)` or a `SUM()` in
 * `EntitlementsService.usage()`. A counter drifts: one missed decrement on a
 * delete, one write that lands outside a rolled-back transaction, and a
 * workspace is permanently locked out of something it is paying for, with no
 * way to repair the number short of a manual UPDATE. A COUNT cannot drift,
 * because it is derived from the truth every time it is asked. Meters are only
 * for consumption that leaves no row behind to count.
 */
@Injectable()
export class UsageMeterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalogue: FeatureCatalogueService,
  ) {}

  /**
   * Which bucket a write lands in: 'lifetime', '2026-08' or '2026-08-10'.
   *
   * Derived from the feature's own `period` and resolved in the *workspace's*
   * timezone. A Dhaka month turns over at 18:00 UTC on the last day of the
   * previous month; a server that used its own clock would give six hours of
   * September's traffic to August, and would do it differently depending on
   * which region the container happened to run in.
   */
  async periodKeyFor(featureKey: string, timezone: string, now = new Date()): Promise<string> {
    return usagePeriodKey(await this.catalogue.periodOf(featureKey), now, timezone);
  }

  /**
   * Add `by` to a meter and return the new total.
   *
   * `by` may be negative to give consumption back, but think twice: a
   * decrement is the drift the doc comment above warns about. If the thing can
   * be recounted, recount it instead.
   */
  async increment(
    workspaceId: string,
    featureKey: string,
    by: number,
    timezone: string,
    options: MeterOptions = {},
  ): Promise<number> {
    if (!Number.isSafeInteger(by)) {
      throw new TypeError(`Usage must be a whole number of units, got ${by} for ${featureKey}`);
    }
    if (by === 0) return this.read(workspaceId, featureKey, timezone, options.now);

    const periodKey = await this.periodKeyFor(featureKey, timezone, options.now);
    const client = options.tx ?? this.prisma;
    const where = { workspaceId_featureKey_periodKey: { workspaceId, featureKey, periodKey } };

    try {
      const row = await client.usageMeter.upsert({
        where,
        create: { workspaceId, featureKey, periodKey, value: BigInt(by) },
        update: { value: { increment: BigInt(by) } },
        select: { value: true },
      });
      return UsageMeterService.toJsonNumber(row.value);
    } catch (err) {
      /* Two writers hitting a period's first unit at the same instant both see
       * no row and both try to create one. The unique index picks a winner; the
       * loser increments what the winner wrote rather than losing its unit. */
      if (UsageMeterService.isUniqueViolation(err)) {
        const row = await client.usageMeter.update({
          where,
          data: { value: { increment: BigInt(by) } },
          select: { value: true },
        });
        return UsageMeterService.toJsonNumber(row.value);
      }
      throw err;
    }
  }

  /** The current value of one meter. Zero when nothing has been counted yet. */
  async read(
    workspaceId: string,
    featureKey: string,
    timezone: string,
    now = new Date(),
  ): Promise<number> {
    const periodKey = await this.periodKeyFor(featureKey, timezone, now);
    const row = await this.prisma.usageMeter.findUnique({
      where: { workspaceId_featureKey_periodKey: { workspaceId, featureKey, periodKey } },
      select: { value: true },
    });
    return row ? UsageMeterService.toJsonNumber(row.value) : 0;
  }

  /**
   * Several meters in one query.
   *
   * The snapshot endpoint needs every metered feature at once, and each one can
   * sit in a different bucket — a monthly meter in '2026-08' next to a lifetime
   * one. Every requested key comes back, zero included, so a caller never has
   * to tell "not measured" apart from "not present".
   */
  async readMany(
    workspaceId: string,
    featureKeys: readonly string[],
    timezone: string,
    now = new Date(),
  ): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    if (featureKeys.length === 0) return out;

    const pairs = await Promise.all(
      featureKeys.map(async (featureKey) => ({
        featureKey,
        periodKey: await this.periodKeyFor(featureKey, timezone, now),
      })),
    );
    for (const { featureKey } of pairs) out[featureKey] = 0;

    const rows = await this.prisma.usageMeter.findMany({
      where: { workspaceId, OR: pairs },
      select: { featureKey: true, value: true },
    });
    for (const row of rows) out[row.featureKey] = UsageMeterService.toJsonNumber(row.value);

    return out;
  }

  /**
   * BigInt in the column, a JSON number out.
   *
   * The column is BigInt so a byte total cannot overflow the 2^31 an `Int`
   * would give it. JSON has no integer type wider than 2^53, so the conversion
   * is exact for anything a workspace can plausibly consume — roughly nine
   * petabytes of attachments — and a value past that is clamped and shouted
   * about rather than silently rounded into a wrong limit decision.
   */
  private static toJsonNumber(value: bigint): number {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      logger.error(`Usage meter value ${value} exceeds Number.MAX_SAFE_INTEGER; reporting the cap`);
      return Number.MAX_SAFE_INTEGER;
    }
    if (value < BigInt(Number.MIN_SAFE_INTEGER)) return Number.MIN_SAFE_INTEGER;
    return Number(value);
  }

  private static isUniqueViolation(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
  }
}
