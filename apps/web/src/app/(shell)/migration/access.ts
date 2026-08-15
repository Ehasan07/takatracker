'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * Whether this account may move a chart of accounts in from another product.
 *
 * Not a plan feature — an allowlist of one, held in the server's environment.
 * The screen asks a person to paste a live credential to another finance app,
 * and that is a thing to offer one person who asked for it, not a thing to put
 * in every customer's menu.
 *
 * Like `useIsOperator`, this authorises nothing: every migration route re-reads
 * the allowlist server-side, so a browser that lies to itself gets a menu item
 * leading to a 403.
 */
export const MIGRATION_HREF = '/migration';

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
