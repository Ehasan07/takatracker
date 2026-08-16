import { Injectable, UnauthorizedException } from '@nestjs/common';

/**
 * Reading somebody's BudgetBakers Wallet account, once.
 *
 * ## The token is never stored
 *
 * It arrives in the body of the request that starts a pull, is used for the
 * handful of calls that pull needs, and is gone when the method returns. There
 * is no column for it and there should not be: a migration tool that keeps a
 * working credential to somebody's other finance account is a liability long
 * after the migration is done, and the migration is a one-afternoon job.
 *
 * ## Shapes verified against the live API, not against documentation
 *
 * Wallet publishes none, so these were read off real responses on 15 August
 * 2026. Every field this depends on is optional in the type, because the next
 * thing to change will be a field name and a pull that throws is worse than a
 * pull that leaves a cell blank.
 */

const BASE_URL = 'https://rest.budgetbakers.com/wallet/v1/api';
const PAGE = 200;
/** Enough pages for any personal account, and a stop against a bad loop. */
const MAX_PAGES = 200;

/**
 * The date filter that means "everything".
 *
 * `/records` without one is **not** every record: it silently applies the last
 * three months. Measured on 16 August 2026 — 436 rows came back where the
 * accounts' own `recordCount` totals 7,215. An import that trusted the default
 * would look like it worked and bring six per cent of somebody's history, which
 * is worse than failing. The syntax is the API's own: `recordDate=gte.<iso>`.
 */
const SINCE_EVERYTHING = 'recordDate=gte.2000-01-01T00:00:00.000Z';

export interface WalletAccount {
  id: string;
  name?: string;
  accountType?: string;
  currencyCode?: string;
  archived?: boolean;
  bankAccountNumber?: string;
  recordStats?: { recordCount?: number };
}

export interface WalletCategory {
  id: string;
  name?: string;
  group?: { id?: string; name?: string };
  customCategory?: boolean;
  archived?: boolean;
}

/**
 * One record, as it really comes back.
 *
 * `amount.value` is a float — `-601.66` — and this codebase bans float
 * arithmetic on money, so it must be converted through its string form.
 *
 * `transfer` is null on an ordinary record and, on a transfer, carries the
 * other side with it: `{ type, transferId, mirrorRecord: { id, amount,
 * accountId } }`. That is what makes pairing possible without holding the whole
 * history in memory — each side already names its partner.
 */
export interface WalletRecord {
  id: string;
  accountId?: string;
  amount?: { value?: number; currencyCode?: string };
  recordDate?: string;
  category?: { id?: string; name?: string };
  recordType?: string;
  recordState?: string;
  note?: string;
  payee?: string;
  transfer?: {
    type?: string;
    transferId?: string;
    mirrorRecord?: { id?: string; accountId?: string; amount?: { value?: number } };
  } | null;
}

@Injectable()
export class WalletClient {
  private async page<T>(
    token: string,
    path: string,
    offset: number,
    query = '',
  ): Promise<{ rows: T[]; nextOffset: number | null }> {
    const controller = new AbortController();
    /* Twenty seconds. A pull is a person waiting at a screen, and a third-party
       API having a slow morning must not hold a request open past the point
       they have given up and pressed it again. */
    const timer = setTimeout(() => controller.abort(), 20_000);

    try {
      const url = `${BASE_URL}/${path}?limit=${PAGE}&offset=${offset}${query ? `&${query}` : ''}`;
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: controller.signal,
      });

      /* One message for every refusal. Whether the token is wrong, expired or
         revoked is not something this can tell apart, and guessing at it in the
         error would send somebody looking in the wrong place. */
      if (res.status === 401 || res.status === 403) {
        throw new UnauthorizedException('Wallet টোকেনটি কাজ করছে না — নতুন করে নিয়ে আসুন।');
      }
      if (!res.ok) throw new Error(`Wallet ${path} answered ${res.status}`);

      const body = (await res.json()) as Record<string, unknown>;
      const rows = body[path];
      const next = body.nextOffset;
      return {
        rows: Array.isArray(rows) ? (rows as T[]) : [],
        nextOffset: typeof next === 'number' ? next : null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Every page of one collection.
   *
   * Follows `nextOffset` rather than guessing from the row count: the API
   * answers a short page in the middle of a run, and stopping on one would end
   * the import early with no error and no way to tell. The absent `nextOffset`
   * is the end, and `MAX_PAGES` is only there so a server that always sends one
   * cannot loop for ever.
   */
  private async all<T>(token: string, path: string, query = ''): Promise<T[]> {
    const out: T[] = [];
    let offset = 0;

    for (let i = 0; i < MAX_PAGES; i += 1) {
      const page = await this.page<T>(token, path, offset, query);
      out.push(...page.rows);
      if (page.nextOffset === null || page.rows.length === 0) break;
      /* Only ever forwards. A server repeating an offset would otherwise pull
         the same page until MAX_PAGES, quietly importing it dozens of times. */
      if (page.nextOffset <= offset) break;
      offset = page.nextOffset;
    }
    return out;
  }

  accounts(token: string): Promise<WalletAccount[]> {
    return this.all<WalletAccount>(token, 'accounts');
  }

  categories(token: string): Promise<WalletCategory[]> {
    return this.all<WalletCategory>(token, 'categories');
  }

  /** Every record there has ever been — see `SINCE_EVERYTHING`. */
  records(token: string): Promise<WalletRecord[]> {
    return this.all<WalletRecord>(token, 'records', SINCE_EVERYTHING);
  }

  /**
   * One page of records, and where the next one starts.
   *
   * Records are paged by the caller rather than read whole like accounts and
   * categories, and the reason is the size: 9,625 rows written inside one HTTP
   * request is a request that can time out half way through a ledger. A page at
   * a time makes the worst case one page asked for twice, which deduplication
   * already answers for.
   *
   * `nextOffset` is passed back untouched and treated as opaque — it is the
   * server's own bookmark, not a row count — and its absence, never a short
   * page, is what means the end.
   */
  async recordsPage(
    token: string,
    offset: number,
  ): Promise<{ rows: WalletRecord[]; nextOffset: number | null }> {
    const from = Math.max(0, Math.trunc(offset));
    const page = await this.page<WalletRecord>(token, 'records', from, SINCE_EVERYTHING);
    return {
      rows: page.rows,
      /* Only ever forwards, for the same reason `all()` refuses to go back: an
         offset that repeats itself would import one page over and over until
         the caller's own page cap stopped it. */
      nextOffset: page.nextOffset !== null && page.nextOffset > from ? page.nextOffset : null,
    };
  }
}
