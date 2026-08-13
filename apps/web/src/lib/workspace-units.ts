'use client';

import { useQuery } from '@tanstack/react-query';
import { unitSuggestions } from '@hishab/shared';
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
}

export const workspaceSettingsKey = ['workspace', 'settings'] as const;

export function fetchWorkspaceSettings(): Promise<WorkspaceSettingsDto> {
  return api<WorkspaceSettingsDto>('/workspace/settings');
}

/** Shipped units first, then the workspace's own, in the order it chose. */
export function useQuantityUnits(): string[] {
  const settings = useQuery({
    queryKey: workspaceSettingsKey,
    queryFn: fetchWorkspaceSettings,
    /* Half an hour. Somebody who just added a unit gets it immediately through
       the invalidation in the settings screen; everybody else is reading a list
       that changes a few times a year. */
    staleTime: 30 * 60_000,
    retry: false,
  });

  return unitSuggestions(settings.data?.quantityUnits);
}
