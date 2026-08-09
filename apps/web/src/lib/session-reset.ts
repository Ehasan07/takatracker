'use client';

import type { QueryClient } from '@tanstack/react-query';
import { clearSessionOwner } from './offline-queue';

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
  /* First, because it is the only step that changes what may be replayed. The
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
