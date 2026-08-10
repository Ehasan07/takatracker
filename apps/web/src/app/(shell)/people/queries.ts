'use client';

/**
 * Every request the person screens make, and the one invalidation rule that
 * keeps the rest of the app honest.
 *
 * `?q=` goes to the server rather than being filtered in the browser: the
 * matcher behind it transliterates, so `karim` and `korim` both find করিম, and
 * a normalised phone finds a number typed in any of its six spellings. Filtering
 * the fetched list here with `String.includes` would quietly delete all of that
 * — করিম and `karim` share no characters at all.
 */

import type { QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { PersonDto } from './types';

export const peopleKeys = {
  all: ['people'] as const,
  /** `q` is part of the key: a search is a different answer, not a stale one. */
  list: (q: string) => ['people', 'list', q] as const,
};

export function fetchPeople(q = ''): Promise<PersonDto[]> {
  const trimmed = q.trim();
  return api<PersonDto[]>(`/people${trimmed ? `?q=${encodeURIComponent(trimmed)}` : ''}`);
}

/**
 * What goes stale when a person changes.
 *
 * A person is the subject of a debt, not a label on one. Renaming one changes
 * the heading of their party ledger, the counterparty on every loan card and the
 * name on the khata's person filter. Merging moves whole loans and transactions
 * from one row to another, so the loan list, the party ledger and the
 * counterparty picker are all describing the wrong person until they refetch.
 *
 * `['loans']` covers the hub, the loan, the statement and the party ledger
 * together, because they share that key prefix. `['transactions']` covers the
 * khata's infinite list for the same reason. Money is deliberately absent:
 * nothing here moves a single poisha between accounts — a merge changes *whose*
 * money it is, never how much — so `['summary']` and `['reports']` are still
 * correct and refetching them would be work for an unchanged answer.
 */
export function invalidatePersonData(queryClient: QueryClient): void {
  for (const key of [['people'], ['loans'], ['transactions']]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}
