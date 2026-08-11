'use client';

import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import {
  DEFAULT_CURRENCY,
  currencyOf,
  formatMinor,
  parseMoneyToMinor,
  type CurrencyInfo,
  type FormatMoneyOptions,
  type Locale,
} from '@hishab/shared';
import { endpoints } from '@/lib/api';

/**
 * The two workspace-level choices every screen has to respect: which currency
 * the books are kept in, and which language they are read in.
 *
 * Both are made once at signup and stored on the workspace, and both come back
 * on `/auth/me` — the same cached `['me']` query the greeting and the operator
 * flag already read, so this costs no extra request.
 *
 * ## Why the currency cannot be a constant
 *
 * Every amount in this system is an integer in the currency's smallest unit,
 * and until now the divisor was hardcoded at 100. That is right for taka and
 * wrong for a fifth of the world: a yen has no minor unit, a dinar has a
 * thousand fils. A workspace on either, rendered with 100, is out by two or
 * three orders of magnitude everywhere at once — and *consistently*, which is
 * what makes it invisible. `useMoney()` below binds the workspace's currency to
 * both halves of the conversion so a screen cannot use one and forget the
 * other.
 *
 * ## Why the fallback is taka rather than nothing
 *
 * `['me']` is cached but not instant on a cold load. A component that rendered
 * blank until it arrived would flash on every screen with a number on it. Taka
 * is the default for a new workspace and the value for almost every existing
 * one, so the first frame is right for nearly everybody and settles for the
 * rest.
 */
export interface WorkspaceSettings {
  currency: string;
  currencyInfo: CurrencyInfo;
  locale: Locale;
  /** False until `/auth/me` has answered; use it to defer a one-shot render. */
  ready: boolean;
}

interface MeShape {
  locale?: string | null;
  workspace?: { currency?: string | null; locale?: string | null } | null;
}

export function useWorkspaceSettings(): WorkspaceSettings {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: endpoints.me,
    staleTime: 5 * 60_000,
    retry: false,
    networkMode: 'always',
  });

  const data = me.data as MeShape | undefined;
  const currency = data?.workspace?.currency ?? DEFAULT_CURRENCY;
  /* The workspace's language wins over the person's.
   *
   * `User.locale` is a preference and `Workspace.locale` is what the books are
   * written in — the categories, the report headings, the exported CSV. In a
   * shared workspace two members must not see two different sets of category
   * names for the same rows, so the ledger's own language is the authority and
   * the user's is the fallback for anything that is purely about them. */
  const locale = (
    (data?.workspace?.locale ?? data?.locale ?? 'bn') === 'en' ? 'en' : 'bn'
  ) as Locale;

  return React.useMemo(
    () => ({ currency, currencyInfo: currencyOf(currency), locale, ready: me.data !== undefined }),
    [currency, locale, me.data],
  );
}

export interface BoundMoney extends WorkspaceSettings {
  /** `formatMinor` with the workspace currency already applied. */
  format: (minor: number, opts?: Omit<FormatMoneyOptions, 'currency'>) => string;
  /** `parseMoneyToMinor` with the workspace currency already applied. */
  parse: (raw: string | number) => number;
}

/**
 * Formatting and parsing, both bound to the workspace's currency.
 *
 * Exported as a pair on purpose. The failure this prevents is a screen that
 * formats with the right divisor and parses with the wrong one — which does not
 * look like a bug, it looks like the number the user typed changing by a factor
 * of a hundred when they press save.
 */
export function useMoney(): BoundMoney {
  const settings = useWorkspaceSettings();
  const { currency } = settings;

  return React.useMemo(
    () => ({
      ...settings,
      format: (minor, opts) => formatMinor(minor, { ...opts, currency }),
      parse: (raw) => parseMoneyToMinor(raw, currency),
    }),
    [settings, currency],
  );
}
