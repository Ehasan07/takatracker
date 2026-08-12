/* Hishab service worker — app-shell precache + network-first, offline-fallback
 * reads for an allowlisted set of data endpoints.
 * Hand-written rather than generated: the caching rules for a finance app need
 * to be obvious and auditable, and money data must never be served stale
 * without the page knowing. */

/* Bumped with the shell precache list below: `activate` deletes every cache
 * whose key does not start with VERSION, which is how an old inventory is
 * retired rather than left to shadow the new one. */
const VERSION = 'hishab-v3';
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;

/* Every destination the bottom tab bar reaches in one tap, the আরও hub that
 * lists the other nine, and the two the desktop sidebar carries. Precaching the
 * navigation surface rather than just the entry point is the difference between
 * "the app opens offline" and "the app opens offline and you can move around
 * it" — a navigation the cache misses falls through to /offline. */
const SHELL_ASSETS = [
  '/',
  '/transactions',
  '/loans',
  '/reports',
  '/more',
  '/accounts',
  '/settings',
  '/offline',
  '/manifest.webmanifest',
];

/* Posted by src/lib/session-reset.ts when someone signs out. */
const SESSION_ENDED = 'hishab:session-ended';

/* What may enter the data cache. An explicit inventory, matched by pathname
 * prefix, replacing the old rule of "every /api/ GET that happens to succeed".
 *
 * apps/api/src/main.ts stamps `Cache-Control: no-store` on every response —
 * "Balances must never come from a cache" — and the Cache Storage API does not
 * read that header, so honouring its intent is this file's job. It is honoured
 * three ways: a cached copy is handed over only after the network has actually
 * failed (never to save a round trip), the whole cache is dropped the moment a
 * session ends (see the `message` handler and src/lib/session-reset.ts), and
 * nothing enters it unless it is named below.
 *
 * Excluded on purpose:
 *
 *   /api/v1/export/*   The full-database JSON dump and the transactions CSV.
 *                      These are downloads, not screens: a whole ledger in one
 *                      response, previously written into an origin-wide cache
 *                      and left there. Nothing can consume them offline anyway.
 *   /api/v1/auth/*     Session and identity, including the device list.
 *   anything unnamed   A new endpoint is uncached until someone adds it here
 *                      and says why, rather than the other way round.
 *
 * The list is not as short as it should be. Everything on it is an active
 * React Query on some screen, and `providers.tsx` sets `networkMode:
 * 'offlineFirst'` with `retry: 1`, which parks a failed read in `paused` for
 * as long as the connection is gone (query-core retryer.js:42). A paused query
 * never settles, so `await queryClient.invalidateQueries()` — which the quick
 * add sheet does after parking a transaction offline — hangs, and the sheet
 * stays open over a write that was in fact saved. Dropping a screen's reads
 * from this list is therefore safe only once reads stop pausing; `retry: 0`
 * (or `networkMode: 'always'`) for queries in providers.tsx is the unlock.
 */
const DATA_CACHE_ALLOWLIST = [
  '/api/v1/accounts',
  '/api/v1/categories',
  '/api/v1/transactions',
  '/api/v1/entitlements',
  '/api/v1/loans',
  '/api/v1/savings',
  '/api/v1/insurance',
  '/api/v1/reports',
  '/api/v1/import/batches',
  '/api/v1/notifications/telegram',
];

/* Prefix match on a path boundary, so `/loans/<id>/statement` is covered by
 * `/loans` while a future `/loans-export` would not be. */
function isCacheableData(pathname) {
  return DATA_CACHE_ALLOWLIST.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

/* A sign-out in any tab. There is one worker for the whole origin, so dropping
 * the cache here drops it everywhere at once — otherwise a second tab left open
 * on the dashboard keeps being served the previous user's balances the moment
 * it loses connection. The page clears the same cache itself; this is what
 * covers the tabs the page cannot reach. */
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== SESSION_ENDED) return;
  event.waitUntil(
    caches
      .delete(DATA_CACHE)
      .then(() => {
        if (event.ports && event.ports[0]) event.ports[0].postMessage({ ok: true });
      })
      .catch(() => undefined),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Auth must never be cached. Belt and braces: it is not on the allowlist either.
  if (url.pathname.startsWith('/api/v1/auth')) return;

  /* Data: network first, cache only as an offline fallback, and only for the
   * reads named in DATA_CACHE_ALLOWLIST.
   *
   * Plain stale-while-revalidate is wrong for money: it hands the page the
   * previous balance immediately after a write and the user sees their new
   * transaction missing. So we always prefer the live answer and keep the cache
   * purely so the ledger still opens with no connection. */
  if (url.pathname.startsWith('/api/')) {
    if (!isCacheableData(url.pathname)) return;

    event.respondWith(
      caches.open(DATA_CACHE).then(async (cache) => {
        try {
          const response = await fetch(request);
          if (response.ok) void cache.put(request, response.clone());
          return response;
        } catch (err) {
          const cached = await cache.match(request);
          if (cached) return cached;
          throw err;
        }
      }),
    );
    return;
  }

  /* Navigation: the cached shell first, the network in the background.
   *
   * This used to be network-first, and that is what made the installed app feel
   * like a website. The server is not slow — measured from Dhaka it answers a
   * 3.5 KB chunk in 0.7s, almost all of it round-trip time to Germany — so
   * *every* launch from the home screen paid a full DNS + TCP + TLS + HTML wait
   * before a single pixel appeared, however warm the cache was.
   *
   * Serving the cached document immediately makes a relaunch instant, and the
   * fetch that follows refreshes it for next time. Two things make that safe
   * here rather than merely fast:
   *
   *   - The shell carries no money. Every figure on every screen is fetched by
   *     React Query after boot, under the rules further down this file; a stale
   *     document cannot show a stale balance, only a stale layout.
   *   - Static chunks are cache-first and immutable, so a cached document and
   *     the exact chunk hashes it names stay together. A deploy changes both,
   *     and `VERSION` above drops the pair when the worker rolls over.
   */
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);

        const fresh = fetch(request)
          .then((response) => {
            /* Only a real page. A redirect to /login or an error page must not
             * be written over a good shell — the next launch would then open on
             * a login screen the user is not actually locked out of. */
            if (response.ok && response.type === 'basic') {
              const copy = response.clone();
              void caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => null);

        if (cached) {
          // Revalidation continues after the response is handed over; without
          // `waitUntil` the worker may be killed mid-flight and never update.
          event.waitUntil(fresh);
          return cached;
        }

        return (await fresh) ?? (await caches.match('/offline'));
      })(),
    );
    return;
  }

  // Static assets: cache first.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ??
        fetch(request).then((response) => {
          if (response.ok && url.pathname.startsWith('/_next/')) {
            const copy = response.clone();
            void caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
