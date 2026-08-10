'use client';

import { useQuery } from '@tanstack/react-query';
import { endpoints } from '@/lib/api';

/**
 * Whether to draw the operator link in the navigation.
 *
 * This used to probe an admin endpoint and latch the answer in `localStorage`,
 * because `isSuperAdmin` was on no response the client could see. That worked,
 * but it meant an operator had to type `/admin` once per browser before the
 * link appeared, and a revoked one kept the link until they followed it.
 *
 * `/auth/me` now returns the flag, so the question is simply answered. It
 * authorises nothing: `SuperAdminGuard` re-reads it from the database on every
 * admin request, so forging this buys a menu item that leads to a 404.
 */
export function useIsOperator(): boolean {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: endpoints.me,
    staleTime: 5 * 60_000,
    retry: false,
    networkMode: 'always',
  });
  return me.data?.isSuperAdmin === true;
}
