import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { isSupportedCurrency } from '@hishab/shared';

/**
 * Today's exchange rates, fetched once and shared by everybody.
 *
 * ## Why this is on the server
 *
 * The obvious implementation is a `fetch` from the browser. It is the wrong one
 * for three reasons, and the third is the one that matters here: a public rate
 * API has no CORS guarantee, every open tab would hit it separately, and a
 * phone on a slow connection would wait on a third-party host before it could
 * show a form. One server-side fetch, cached, means the browser asks its own
 * origin for a few hundred bytes and nothing else changes.
 *
 * ## What it is for, and what it is not
 *
 * It is a *suggestion*. The user confirms or overrides the rate before the
 * entry is written, and what they confirm is what gets recorded — so the number
 * in the books is their declared rate, not our guess at one. That distinction
 * is why this can be a free daily-updated feed rather than a paid intraday one:
 * nothing here is authoritative and nothing pretends to be.
 *
 * A failure is therefore not an error worth stopping for. If the provider is
 * down the endpoint says so and the form asks the user to type the rate, which
 * is the same thing they could always do.
 */

/** Free, no key, daily updates, CC-BY. See `open.er-api.com`. */
const PROVIDER_URL = (base: string) => `https://open.er-api.com/v6/latest/${base}`;

/**
 * Six hours.
 *
 * The feed updates once a day, so a shorter window buys nothing and a longer
 * one risks holding a stale rate through a devaluation — the one event where a
 * household actually notices. Also bounds how often an outage is retried.
 */
const TTL_MS = 6 * 60 * 60 * 1000;

/** Refuse to hang a request on a third party. */
const TIMEOUT_MS = 4_000;

export interface RateTable {
  base: string;
  /** ISO 4217 → units of that currency per one unit of `base`. */
  rates: Record<string, number>;
  /** When the provider says it last updated, not when we fetched. */
  asOf: string;
  provider: string;
}

interface CacheEntry {
  at: number;
  table: RateTable;
}

@Injectable()
export class FxService {
  private readonly logger = new Logger(FxService.name);
  private readonly cache = new Map<string, CacheEntry>();
  /** In-flight requests per base, so a cold cache under load fetches once. */
  private readonly inflight = new Map<string, Promise<RateTable>>();

  async table(baseRaw: string): Promise<RateTable> {
    const base = baseRaw.toUpperCase();
    if (!isSupportedCurrency(base)) {
      throw new ServiceUnavailableException('এই মুদ্রার রেট পাওয়া যায়নি');
    }

    const hit = this.cache.get(base);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.table;

    const existing = this.inflight.get(base);
    if (existing) return existing;

    const request = this.fetchTable(base)
      .then((table) => {
        this.cache.set(base, { at: Date.now(), table });
        return table;
      })
      .catch((err: unknown) => {
        /* A stale table beats no table: a rate from this morning is a better
         * suggestion than an empty field, and the user is confirming it either
         * way. Only a cold cache surfaces the failure. */
        if (hit) {
          this.logger.warn(
            `Rate refresh for ${base} failed, serving ${new Date(hit.at).toISOString()}: ${
              (err as Error).message
            }`,
          );
          return hit.table;
        }
        this.logger.warn(`Rate lookup for ${base} failed: ${(err as Error).message}`);
        throw new ServiceUnavailableException('এই মুহূর্তে রেট আনা যাচ্ছে না — হাতে লিখে দিন');
      })
      .finally(() => this.inflight.delete(base));

    this.inflight.set(base, request);
    return request;
  }

  /** One pair, which is all a transaction form needs. */
  async rate(from: string, to: string): Promise<{ rate: number; asOf: string; provider: string }> {
    const table = await this.table(from);
    const rate = table.rates[to.toUpperCase()];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      throw new ServiceUnavailableException('এই জোড়ার রেট পাওয়া যায়নি — হাতে লিখে দিন');
    }
    return { rate, asOf: table.asOf, provider: table.provider };
  }

  private async fetchTable(base: string): Promise<RateTable> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(PROVIDER_URL(base), { signal: controller.signal });
      if (!res.ok) throw new Error(`provider answered ${res.status}`);

      const body = (await res.json()) as {
        result?: string;
        rates?: Record<string, unknown>;
        time_last_update_utc?: string;
      };
      if (body.result !== 'success' || !body.rates) throw new Error('provider returned no rates');

      /* Filtered to currencies this build knows, and to finite positive
       * numbers. The response is a third party's JSON on the request path of a
       * form that writes to a ledger; nothing in it is trusted by shape. */
      const rates: Record<string, number> = {};
      for (const [code, value] of Object.entries(body.rates)) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
          if (isSupportedCurrency(code)) rates[code.toUpperCase()] = value;
        }
      }
      if (Object.keys(rates).length === 0) throw new Error('no usable rates in response');

      return {
        base,
        rates,
        asOf: body.time_last_update_utc ?? new Date().toISOString(),
        provider: 'open.er-api.com',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
