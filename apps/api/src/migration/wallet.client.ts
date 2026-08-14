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
/** Wallet caps a page well below this; the loop follows `nextOffset` anyway. */
const PAGE = 200;
/** Enough pages to cover any personal account, and a stop against a bad loop. */
const MAX_PAGES = 50;

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

@Injectable()
export class WalletClient {
  private async page<T>(token: string, path: string, offset: number): Promise<T[]> {
    const controller = new AbortController();
    /* Twenty seconds. A pull is a person waiting at a screen, and a third-party
       API having a slow morning must not hold a request open past the point
       they have given up and pressed it again. */
    const timer = setTimeout(() => controller.abort(), 20_000);

    try {
      const res = await fetch(`${BASE_URL}/${path}?limit=${PAGE}&offset=${offset}`, {
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
      return Array.isArray(rows) ? (rows as T[]) : [];
    } finally {
      clearTimeout(timer);
    }
  }

  /** Every page of one collection, following the API's own paging. */
  private async all<T>(token: string, path: string): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < MAX_PAGES; i += 1) {
      const rows = await this.page<T>(token, path, out.length);
      out.push(...rows);
      /* A short page is the last page. Wallet also sends `nextOffset`, but a
         count that never grows is the condition that cannot loop for ever. */
      if (rows.length < PAGE) break;
    }
    return out;
  }

  accounts(token: string): Promise<WalletAccount[]> {
    return this.all<WalletAccount>(token, 'accounts');
  }

  categories(token: string): Promise<WalletCategory[]> {
    return this.all<WalletCategory>(token, 'categories');
  }
}
