'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * Whether this account may pull straight from the other product's API.
 *
 * Not a plan feature — an allowlist held in the server's environment. It covers
 * exactly one thing: the box that asks somebody to paste a live credential to
 * another finance app. That is a thing to offer one person who asked for it,
 * not a thing to put in every customer's menu.
 *
 * The screen itself is open to everybody, because the other half of it — a
 * spreadsheet of headings — asks for nothing at all.
 *
 * Like `useIsOperator`, this authorises nothing: the pull route re-reads the
 * allowlist server-side, so a browser that lies to itself gets a 403.
 */

export function useMigrationAllowed(): boolean {
  const allowed = useQuery({
    queryKey: ['migration', 'availability'],
    queryFn: () => api<{ allowed: boolean }>('/migration/availability'),
    staleTime: 5 * 60_000,
    retry: false,
    networkMode: 'always',
  });
  return allowed.data?.allowed === true;
}
