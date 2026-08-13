'use client';

import { EN } from '@/i18n/en';
import { getActiveLocale } from '@/lib/format';

/**
 * Every visible string, in the language the books are read in.
 *
 * ## Three layers, resolved in this order
 *
 *   1. the workspace's own correction for this key, if it has made one
 *   2. the shipped English for the active language
 *   3. the Bengali written inline at the call site
 *
 * ## Why the Bengali is passed in rather than looked up
 *
 * `t('nav.dashboard', 'ড্যাশবোর্ড')` — the source string stays exactly where it
 * lives today, as text at the call site. Three things follow:
 *
 * - **A missing key can never render as `nav.dashboard`.** The worst failure is
 *   the original Bengali, which is what the screen says now.
 * - **The extraction is reviewable.** A diff shows a key added beside the
 *   sentence it names, rather than a sentence vanishing into a JSON file.
 * - **It can be done screen by screen** without the app ever being half broken.
 *
 * ## Why a plain function and not a hook
 *
 * `useT` was the first shape of this and it could only be called from a
 * component. Half the strings worth translating are not in components at all —
 * the navigation model, the label tables in `loans/labels.ts`,
 * `audit/labels.ts` and six others, the report presets. Threading a translator
 * into every one of those meant changing every call site *and* every signature
 * between it and a component.
 *
 * So the locale lives in one module variable, in `lib/format.ts`, and both the
 * number formatters and this read it. The usual objection — React will not
 * re-render when it changes — is answered the same way: the language switch
 * reloads the page. The full reasoning is in `lib/format.ts`.
 *
 * ## Why the catalogue is a static import
 *
 * The earlier design loaded it dynamically so a Bengali reader downloaded no
 * catalogue at all. That saving is real and it is about four kilobytes gzipped,
 * and paying it buys a synchronous `t()` that works in a module-level constant
 * — which is what makes the navigation and the nine label files translatable at
 * all. Four kilobytes against the shared chunk's hundred is not the trade to
 * optimise.
 */

type Catalogue = Record<string, string>;

/**
 * The workspace's own corrections, fetched once by `LocaleSync`.
 *
 * Empty for almost everybody. It is a module variable for the same reason the
 * locale is: `t()` has to work outside React.
 */
let overrides: Catalogue = {};

export function setTranslationOverrides(next: Catalogue): void {
  overrides = next;
}

export function t(key: string, bengali: string): string {
  const override = overrides[key];
  if (override) return override;
  if (getActiveLocale() === 'bn') return bengali;
  return EN[key] ?? bengali;
}
