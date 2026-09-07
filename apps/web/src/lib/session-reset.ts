'use client';

import type { QueryClient } from '@tanstack/react-query';
import { clearSessionOwner } from './offline-queue';
import { clearSupportSession } from './support-session';

/**
 * Everything a sign-out has to take off this device.
 *
 * `apps/api/src/main.ts` stamps `Cache-Control: no-store` on every API response
 * with the comment "Balances must never come from a cache" — and the Cache
 * Storage API does not consult that header at all, so `public/sw.js` was
 * quietly keeping API reads in an origin-wide cache that outlived the session.
 * Two files stated opposite intents. The API's intent wins: the data cache is
 * narrowed in the worker and purged here, the moment the session ends.
 *
 * Sign-out is the only event that means "this device is no longer this
 * person's", which is why this lives in one function called from there rather
 * than being spread through the API layer.
 */

/** Must match `DATA_CACHE` in public/sw.js. */
const DATA_CACHE = 'hishab-v1-data';

/** The message `public/sw.js` listens for. */
const SESSION_ENDED = 'hishab:session-ended';

export async function resetSessionForSignOut(queryClient: QueryClient): Promise<void> {
  /* Before anything else, because it is the only thing here that decides *whose
   * credentials leave this tab on the next request*.
   *
   * A support envelope lives in `sessionStorage`, which survives a sign-out —
   * it is scoped to the tab, and signing out does not close the tab. So an
   * operator who ends their own session while acting as a customer would leave
   * a live bearer token for that customer's ledger sitting in the tab; whoever
   * signed in next on this machine would have `lib/api.ts` attach it to every
   * request and would be looking at somebody else's books under their own
   * name. Fifteen minutes is a short window and not a small one. */
  clearSupportSession();

  /* Then the queue, because it is the only step that changes what may be
   * replayed. The
   * offline queue rows are kept, not deleted: each one records who wrote it, so
   * dropping the owner is enough to make every one of them unmatchable by the
   * next session, and the author gets their entries back — into their own
   * ledger — the next time they sign in on this browser. Deleting them here
   * would throw away transactions someone was told had been saved. */
  clearSessionOwner();

  /* Balances, transactions, /auth/me: all still in memory, and React Query will
   * happily hand them to the next render before the new session's fetches
   * resolve. */
  await queryClient.cancelQueries().catch(() => undefined);
  queryClient.clear();

  await purgeCachedData();
}

/**
 * Drop every cached API read, in this page and in the worker that serves the
 * other tabs.
 *
 * Sign-out is not the only moment this is needed. Starting and ending a support
 * session swaps whose data the screens are showing without anybody signing in
 * or out, and the caches are keyed by URL — `/api/v1/accounts` is one entry, so
 * the operator's copy and the customer's copy are the same key. The worker
 * refuses to cache an impersonated read at all (see the `authorization` check
 * in `public/sw.js`), and this clears whatever was already there on the way in
 * and on the way out.
 */
export async function purgeCachedData(): Promise<void> {
  await Promise.all([clearDataCache(), notifyServiceWorker()]);
}

async function clearDataCache(): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const names = await caches.keys();
    /* The current cache plus any older version of it, so a client that has not
     * yet picked up a new worker cannot keep one alive behind our back. */
    const stale = names.filter((name) => name === DATA_CACHE || name.endsWith('-data'));
    await Promise.all(stale.map((name) => caches.delete(name)));
  } catch {
    // Storage being blocked must never be a reason to stay signed in.
  }
}

async function notifyServiceWorker(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    /* One worker serves every tab of this origin, so telling it directly is
     * what stops a second tab left open on the dashboard from being served the
     * previous user's balances the next time it goes offline.
     *
     * `getRegistrations()` rather than `ready`: `ready` never settles when no
     * worker is registered — a first visit, or dev — and would hang sign-out. */
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) {
      (registration.active ?? registration.waiting)?.postMessage({ type: SESSION_ENDED });
    }
  } catch {
    // Same rule: nothing here may keep the user signed in.
  }
}
