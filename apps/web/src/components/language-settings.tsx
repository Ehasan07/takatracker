'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Languages } from 'lucide-react';
import * as React from 'react';
import { LOCALES, type Locale } from '@hishab/shared';
import { ApiError, api } from '@/lib/api';
import { setActiveLocale } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import { fetchWorkspaceSettings, workspaceSettingsKey } from '@/lib/workspace-units';

/**
 * The books' language.
 *
 * ## Why it reloads
 *
 * The number and date formatters read a module-level locale rather than React
 * state — the reasoning is in `lib/format.ts`, and it comes down to a hundred
 * and seventy call sites, many of them in plain functions that are not
 * components. Nothing subscribes to that variable, so switching it in place
 * would leave every already-rendered date in the previous language until each
 * screen happened to re-render. A reload is a fair price for an action taken
 * once, and a screen showing two languages at once is not.
 *
 * The value is written to localStorage before the reload, so the next load
 * applies it before the first paint rather than flashing the old one.
 *
 * ## Why it is the workspace's and not the reader's
 *
 * Two people sharing one set of books must not see two different names for the
 * same category — a report one of them mails the other would not agree with
 * itself. It is stated on the screen, because "language" on a settings page
 * usually means *mine*.
 */

const LABELS: Record<Locale, { name: string; note: string }> = {
  bn: { name: 'বাংলা', note: 'সংখ্যা, তারিখ ও খাতের নাম বাংলায়' },
  en: { name: 'English', note: 'Numbers, dates and category names in English' },
};

export function LanguageSettings() {
  const queryClient = useQueryClient();
  const [error, setError] = React.useState<string | null>(null);

  const settings = useQuery({
    queryKey: workspaceSettingsKey,
    queryFn: fetchWorkspaceSettings,
    staleTime: 30 * 60_000,
    retry: false,
  });

  /**
   * `undefined` until the server has answered, and deliberately not `'bn'`.
   *
   * Defaulting to Bengali drew the Bengali button as the current choice
   * whatever the workspace actually reads in — and because the handler returns
   * early on the button that is already selected, pressing it did nothing at
   * all. On a slow connection somebody switching *back* to Bengali tapped a
   * live-looking button and watched nothing happen.
   */
  const current = settings.data?.locale;
  const loading = settings.isPending;

  const save = useMutation({
    mutationFn: (locale: Locale) =>
      api<{ locale: Locale }>('/workspace/settings', { method: 'PATCH', body: { locale } }),
    onSuccess: (data) => {
      haptic('success');
      /* Written before the reload so the next load's synchronous seed is right
         and the first paint is already in the new language. */
      setActiveLocale(data.locale);
      /* The cache is about to be thrown away by the reload; this only matters
         if the reload is blocked. */
      queryClient.setQueryData(workspaceSettingsKey, {
        ...(settings.data ?? { quantityUnits: [] }),
        locale: data.locale,
      });
      window.location.reload();
    },
    onError: (err) => {
      haptic('warn');
      setError(err instanceof ApiError ? err.message : 'ভাষা বদলানো যায়নি');
    },
  });

  return (
    <section className="rounded-card border-rule bg-surface border p-4">
      <h2 className="text-ink-muted flex items-center gap-2 text-sm font-medium">
        <Languages className="h-4 w-4" aria-hidden />
        ভাষা / Language
      </h2>

      <div className="mt-3 grid grid-cols-2 gap-2" role="group" aria-label="ভাষা">
        {LOCALES.map((locale) => {
          const on = current === locale;
          return (
            <button
              key={locale}
              type="button"
              onClick={() => {
                if (on || save.isPending) return;
                setError(null);
                save.mutate(locale);
              }}
              aria-pressed={on}
              /* Nothing is pressable until it is known which one is already
                 chosen; otherwise one of the two is a button that silently
                 does nothing. */
              disabled={loading || save.isPending}
              className={
                on
                  ? 'border-brand bg-brand-tint text-brand min-h-11 rounded-md border text-sm font-semibold'
                  : 'border-rule text-ink min-h-11 rounded-md border text-sm disabled:opacity-50'
              }
            >
              {LABELS[locale].name}
            </button>
          );
        })}
      </div>

      <p className="text-ink-muted mt-2 text-xs">{current ? LABELS[current].note : '…'}</p>

      {/* Said plainly. "Language" on a settings page normally means the reader's
          own, and this one is the books'. */}
      <p className="text-ink-muted mt-1 text-xs">
        এটি এই হিসাবের ভাষা — একই হিসাব যাঁরা ভাগ করে ব্যবহার করেন, সবাই একই ভাষায় দেখবেন। বদলালে
        পাতাটি একবার নতুন করে লোড হবে।
      </p>

      {save.isPending ? <p className="text-ink-muted mt-2 text-sm">বদলানো হচ্ছে…</p> : null}
      {error ? (
        <p role="alert" className="text-expense mt-2 text-sm">
          {error}
        </p>
      ) : null}
    </section>
  );
}
