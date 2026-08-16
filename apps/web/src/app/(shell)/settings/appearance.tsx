'use client';

import { Check } from 'lucide-react';
import { Money } from '@/components/money';
import { haptic } from '@/lib/haptics';
import { t } from '@/lib/t';
import { MODES, THEMES, useAppearance, type Mode, type Theme } from '@/lib/theme';

/**
 * How the app looks, on one screen.
 *
 * Four palettes and, separately, light or dark. The reasoning for each palette
 * is in `packages/ui/src/tokens.css`, beside its colours; the reasoning for
 * splitting the two axes is in `lib/theme.ts`. This file is only the buttons.
 *
 * ## Why there is a sample of money on it
 *
 * Because the one thing a person actually needs to know before committing to a
 * palette is whether they will still be able to tell an amount coming in from
 * an amount going out — and in the black-and-white theme the answer is a rule
 * under the outgoing figure rather than a colour, which is not something a
 * swatch can show. Two real rows, rendered by the same `Money` component every
 * screen uses, answer it in place. It costs eight lines and it is the only part
 * of this screen that changes when you press a button.
 */

const THEME_LABELS: Record<Theme, { name: () => string; note: () => string }> = {
  default: {
    name: () => t('theme.default', 'রঙিন'),
    note: () => t('theme.default.note', 'অ্যাপের চেনা চেহারা — আয় সবুজ, খরচ লাল'),
  },
  mono: {
    name: () => t('theme.mono', 'সাদা-কালো'),
    note: () => t('theme.mono.note', 'কোনো রং নেই; খরচের অঙ্কের নিচে দাগ থাকে'),
  },
  contrast: {
    name: () => t('theme.contrast', 'গাঢ়'),
    note: () => t('theme.contrast.note', 'কড়া রোদে ও কম আলোয় পড়ার জন্য সবচেয়ে স্পষ্ট'),
  },
  calm: {
    name: () => t('theme.calm', 'শান্ত'),
    note: () => t('theme.calm.note', 'নরম, উষ্ণ রং — চোখে আরাম'),
  },
};

const MODE_LABELS: Record<Mode, () => string> = {
  system: () => t('theme.mode.system', 'ফোন অনুযায়ী'),
  light: () => t('theme.mode.light', 'আলো'),
  dark: () => t('theme.mode.dark', 'অন্ধকার'),
};

export function AppearanceSettings() {
  const { theme, mode, ready, setTheme, setMode } = useAppearance();

  return (
    <section className="rounded-card border-rule bg-surface border p-4">
      <h2 className="text-ink-muted text-sm font-medium">{t('theme.title', 'চেহারা')}</h2>
      <p className="text-ink-muted mt-1 text-sm">
        {t('theme.blurb', 'রং আর আলো — শুধু এই ফোনের জন্য, হিসাবের কিছু বদলায় না')}
      </p>

      {/* Two columns from 380px, which is every phone but the smallest. At 320
          a two-column grid puts each note on four lines and pushes the money
          sample — the one part of this screen worth scrolling to — off the
          bottom. */}
      <div
        className="mt-3 grid grid-cols-1 gap-2 min-[380px]:grid-cols-2"
        role="group"
        aria-label={t('theme.title', 'চেহারা')}
      >
        {THEMES.map((option) => {
          const on = ready && theme === option;
          return (
            <button
              key={option}
              type="button"
              data-testid={`theme-${option}`}
              onClick={() => {
                if (theme === option) return;
                haptic('tap');
                setTheme(option);
              }}
              aria-pressed={on}
              className={
                on
                  ? 'border-brand bg-brand-tint text-ink flex min-h-11 flex-col justify-center gap-0.5 rounded-md border px-3 py-2 text-left'
                  : 'press border-rule text-ink flex min-h-11 flex-col justify-center gap-0.5 rounded-md border px-3 py-2 text-left'
              }
            >
              <span className="flex items-center gap-1.5 text-sm font-semibold">
                {/* The tick, not just the tint — the selected state cannot be a
                    colour on the one screen whose job is changing the colours,
                    and in the black-and-white palette a tint is nearly nothing. */}
                {on ? <Check className="text-brand h-4 w-4 shrink-0" aria-hidden /> : null}
                {THEME_LABELS[option].name()}
              </span>
              <span className="text-ink-muted text-xs">{THEME_LABELS[option].note()}</span>
            </button>
          );
        })}
      </div>

      <h3 className="text-ink-muted mt-4 text-sm font-medium">
        {t('theme.mode', 'আলো না অন্ধকার')}
      </h3>
      <div
        className="mt-2 grid grid-cols-3 gap-2"
        role="group"
        aria-label={t('theme.mode', 'আলো না অন্ধকার')}
      >
        {MODES.map((option) => {
          const on = ready && mode === option;
          return (
            <button
              key={option}
              type="button"
              data-testid={`mode-${option}`}
              onClick={() => {
                if (mode === option) return;
                haptic('tap');
                setMode(option);
              }}
              aria-pressed={on}
              className={
                on
                  ? 'border-brand bg-brand-tint text-ink min-h-11 rounded-md border px-2 text-sm font-semibold'
                  : 'press border-rule text-ink min-h-11 rounded-md border px-2 text-sm'
              }
            >
              {MODE_LABELS[option]()}
            </button>
          );
        })}
      </div>
      <p className="text-ink-muted mt-2 text-xs">
        {t('theme.mode.note', 'কিছু না বাছলে ফোনের সেটিং অনুযায়ী নিজে থেকেই বদলাবে')}
      </p>

      {/* `bg-paper` rather than nothing: the sample is standing in for a page,
          and a transparent box would show the card it is sitting on instead. */}
      <div className="border-rule bg-paper mt-4 rounded-md border p-3" data-testid="theme-preview">
        <p className="text-ink-muted text-xs">{t('theme.preview', 'দেখতে যেমন হবে')}</p>
        <dl className="mt-2 flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink text-sm">{t('theme.preview.in', 'আয়')}</dt>
            <dd data-testid="theme-preview-in">
              <Money minor={1250000} colored signed />
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink text-sm">{t('theme.preview.out', 'খরচ')}</dt>
            <dd data-testid="theme-preview-out">
              <Money minor={-486050} colored signed />
            </dd>
          </div>
        </dl>
        {/* Said in words, because the sample above is the argument for it: the
            direction is in the sign and in the label, and the colour — or, in
            the black-and-white theme, the rule — is only there to make it
            quicker to see. */}
        <p className="text-ink-muted mt-2 text-xs">
          {t('theme.preview.note', 'সব থিমেই আয় ও খরচ চিহ্ন আর নাম দিয়ে আলাদা করা থাকে')}
        </p>
      </div>
    </section>
  );
}
