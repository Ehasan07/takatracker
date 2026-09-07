'use client';

import type { QueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { purgeCachedData } from '@/lib/session-reset';
import {
  setSupportSession,
  subscribeToSupportSession,
  supportServerSnapshot,
  supportSnapshot,
  type ImpersonationEnvelope,
} from '@/lib/support-session';

/**
 * The React half of the support-session store.
 *
 * The store itself moved to `lib/support-session.ts` when `lib/api.ts` started
 * sending the token on every request: the request path cannot import from the
 * admin console without a cycle, and the console cannot subscribe to a store it
 * does not own. So the state lives in `lib/` and the hooks live here, next to
 * the only screens that render them.
 *
 * Everything the previous module exported is re-exported below, so nothing that
 * imported from here had to move.
 */
export {
  clearSupportSession,
  hasExpired,
  setSupportSession,
  activeSupportSession,
  isImpersonating,
  type ImpersonationEnvelope,
} from '@/lib/support-session';

/**
 * Step into a workspace, from wherever the operator started the session.
 *
 * One function because there is more than one way in — the workspace page and
 * the people search — and these four steps are a security sequence rather than
 * a convenience. Two copies would be two places to keep in step the next time a
 * cache is added, and the copy somebody forgets is the one that shows the
 * operator's own balances under the customer's name.
 *
 * The order is the whole thing:
 *
 *  1. **Store the envelope.** `lib/api.ts` reads it on every request, so from
 *     this line on the tab is acting as the customer. The banner is driven by
 *     the same object, which is why it is up before anything navigates.
 *  2. **Empty the query cache.** Not `invalidateAdminData`, which only touches
 *     the admin keys: every other key in there holds the *operator's* own
 *     accounts, dashboard and transactions, fetched under their own cookie.
 *  3. **Purge the offline copies.** The service worker keeps `/api/v1/accounts`
 *     and its neighbours for offline use, keyed by URL alone — so the
 *     operator's entry and the customer's are the same entry.
 *  4. **Go to the product.** Seeing what the customer sees is the feature, and
 *     a soft navigation keeps the support bar mounted across it so its
 *     countdown continues rather than restarting from a fresh page load.
 */
export function enterSupportSession(
  envelope: ImpersonationEnvelope,
  queryClient: QueryClient,
  router: { push: (href: string) => void },
): void {
  setSupportSession(envelope);
  queryClient.clear();
  void purgeCachedData();
  router.push('/');
}

export function useSupportSession(): ImpersonationEnvelope | null {
  return React.useSyncExternalStore(
    subscribeToSupportSession,
    supportSnapshot,
    supportServerSnapshot,
  );
}

/**
 * A clock that only ticks while something is counting down.
 *
 * The support bar shows the time left on a fifteen-minute token, and a bar that
 * says "১৪ মিনিট বাকি" for the whole session is a bar nobody believes the
 * second time.
 */
export function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
