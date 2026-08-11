'use client';

import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { api } from '@/lib/api';
import { useWorkspaceSettings } from '@/lib/workspace-settings';

/**
 * Every visible string, in the reader's language, with the workspace's own
 * corrections on top.
 *
 * ## Three layers, resolved in this order
 *
 *   1. the workspace's correction for this key, if it has made one
 *   2. the shipped translation for the active language
 *   3. the Bengali written inline at the call site
 *
 * ## Why the Bengali is passed in rather than looked up
 *
 * `t('nav.dashboard', 'ড্যাশবোর্ড')` — the source string lives at the call
 * site, exactly where it lives today as JSX text. Three things follow, and they
 * are the reason this design was chosen over a conventional catalogue:
 *
 * - **A Bengali reader downloads no catalogue at all.** The string is already
 *   in the component's own chunk. Nearly every user is a Bengali reader, so the
 *   common path costs zero extra bytes — which was the requirement.
 * - **A missing key can never render as `nav.dashboard`.** The worst failure is
 *   the original Bengali, which is what the screen says today.
 * - **The extraction is reviewable.** A diff shows a key added next to the
 *   sentence it names, rather than a sentence disappearing into a JSON file.
 *
 * ## Weight
 *
 * The English catalogue is a separate module, imported dynamically and only
 * when the language is English. The corrections are one request that usually
 * answers `{}`. Nothing here is fetched for a Bengali reader who has changed
 * nothing, which is almost everybody.
 */

export type Translate = (key: string, bengali: string) => string;

type Catalogue = Record<string, string>;

/** Loaded once per session, and never for a Bengali reader. */
let englishPromise: Promise<Catalogue> | null = null;
function loadEnglish(): Promise<Catalogue> {
  englishPromise ??= import('./en').then((m) => m.EN);
  return englishPromise;
}

export function useT(): { t: Translate; locale: 'bn' | 'en'; ready: boolean } {
  const { locale } = useWorkspaceSettings();
  const [english, setEnglish] = React.useState<Catalogue | null>(null);

  React.useEffect(() => {
    if (locale !== 'en') return;
    let alive = true;
    void loadEnglish().then((c) => {
      if (alive) setEnglish(c);
    });
    return () => {
      alive = false;
    };
  }, [locale]);

  /* The workspace's own corrections. One request, cached for the session, and
     `{}` for anybody who has never edited a string. `networkMode: always` so a
     reader who is offline falls straight through to the shipped strings rather
     than suspending on a request that cannot be made. */
  const overrides = useQuery({
    queryKey: ['translations', locale],
    queryFn: () => api<Catalogue>(`/translations?locale=${locale}`),
    staleTime: 30 * 60_000,
    retry: false,
    networkMode: 'always',
  });

  const table = overrides.data;
  const t = React.useCallback<Translate>(
    (key, bengali) => table?.[key] ?? (locale === 'en' ? (english?.[key] ?? bengali) : bengali),
    [table, english, locale],
  );

  return {
    t,
    locale,
    /* True once nothing further can change the answer. Only useful to a caller
       that must not render a string twice — most callers should just render,
       because the fallback is the correct Bengali rather than a placeholder. */
    ready: locale === 'bn' || english !== null,
  };
}
