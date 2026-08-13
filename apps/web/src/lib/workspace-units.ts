'use client';

import { useQuery } from '@tanstack/react-query';
import { commonUnits, normaliseUnitList, unitGroups } from '@hishab/shared';
import { api } from '@/lib/api';

/**
 * The units the quantity field offers: the eight the build ships, then whatever
 * this workspace added.
 *
 * ## Why the field is still free text
 *
 * Nothing here constrains what can be saved. A unit typed and never added to
 * the list saves exactly as it always did — the list is a keyboard shortcut, and
 * turning it into a whitelist would break the one property that made the field
 * usable in the first place: that it never has to say "no" to a real unit
 * because nobody anticipated it.
 *
 * ## Why the query is allowed to fail quietly
 *
 * `retry: false` and no error surface. If this request fails the dropdown falls
 * back to the shipped eight, which is what it offered last week — a degraded
 * shortcut, not a broken form. Blocking the quantity field on a settings fetch
 * would be trading a working entry for a complete one.
 */

interface WorkspaceSettingsDto {
  quantityUnits: string[];
  /** The books' language. Read by the language switch; see `language-settings.tsx`. */
  locale: 'bn' | 'en';
}

export const workspaceSettingsKey = ['workspace', 'settings'] as const;

export function fetchWorkspaceSettings(): Promise<WorkspaceSettingsDto> {
  return api<WorkspaceSettingsDto>('/workspace/settings');
}

function useSettings() {
  return useQuery({
    queryKey: workspaceSettingsKey,
    queryFn: fetchWorkspaceSettings,
    /* Half an hour. Somebody who just added a unit gets it immediately through
       the invalidation in the settings screen; everybody else is reading a list
       that changes a few times a year. */
    staleTime: 30 * 60_000,
    retry: false,
  });
}

/**
 * Everything the unit picker shows, in the workspace's language.
 *
 * The language comes from the workspace rather than from the display locale,
 * because the answer is *stored*: it becomes the string a report groups by for
 * as long as the row exists. A person reading their books in English while the
 * workspace is Bengali should still be adding to the same কেজি total everybody
 * else is, not starting a parallel one.
 */
export function useUnitOptions(): {
  common: string[];
  groups: { label: string; units: string[] }[];
  custom: string[];
  /** What the field starts on when somebody opens it: the first shortcut. */
  fallback: string;
} {
  const settings = useSettings();
  /* Bengali until the answer lands. The fetch is allowed to fail — see above —
     and a picker offering the shipped catalogue is a working picker. */
  const locale = settings.data?.locale === 'en' ? 'en' : 'bn';

  const common = commonUnits(locale);
  return {
    common,
    groups: unitGroups(locale),
    custom: normaliseUnitList(settings.data?.quantityUnits ?? []),
    fallback: common[0] ?? 'কেজি',
  };
}
