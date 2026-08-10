'use client';

/**
 * Every request the tag screens make, and the one invalidation rule that keeps
 * the rest of the app honest.
 *
 * `?q=` is sent to the server rather than filtered in the browser on purpose:
 * the matcher behind it transliterates, so `poribar` finds পরিবার and `romjan`
 * finds রমজান. Filtering the fetched list here with `String.includes` would
 * quietly delete that — the two strings share no characters at all.
 */

import type { QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { TagDto } from './types';

export const tagKeys = {
  all: ['tags'] as const,
  /** `q` is part of the key: a search is a different answer, not a stale one. */
  list: (q: string) => ['tags', 'list', q] as const,
};

export function fetchTags(q = ''): Promise<TagDto[]> {
  const trimmed = q.trim();
  return api<TagDto[]>(`/tags${trimmed ? `?q=${encodeURIComponent(trimmed)}` : ''}`);
}

/**
 * What goes stale when a tag changes.
 *
 * A tag is not a label sitting on its own. Creating one changes the picker;
 * renaming or recolouring one changes every chip already drawn in the khata;
 * deleting or merging one moves join rows, so the ledger, the by-tag report and
 * the counts on the tag list itself are all wrong until they are refetched.
 * `['transactions']` covers the khata's infinite list because its key begins
 * there, and `['reports']` covers by-tag alongside by-category.
 *
 * Tagging a *transaction* is the same set seen from the other side, which is
 * why the quick-add sheet's blanket invalidation already reaches all of it.
 */
export function invalidateTagData(queryClient: QueryClient): void {
  for (const key of [['tags'], ['transactions'], ['reports'], ['summary']]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}
