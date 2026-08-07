/* Hishab service worker — app-shell precache + stale-while-revalidate for data.
 * Hand-written rather than generated: the caching rules for a finance app need
 * to be obvious and auditable, and money data must never be served stale
 * without the page knowing. */

const VERSION = 'hishab-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;

const SHELL_ASSETS = ['/', '/transactions', '/accounts', '/settings', '/offline', '/manifest.webmanifest'];

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

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Auth must never be cached.
  if (url.pathname.startsWith('/api/v1/auth')) return;

  /* Data: network first, cache only as an offline fallback.
   *
   * Plain stale-while-revalidate is wrong for money: it hands the page the
   * previous balance immediately after a write and the user sees their new
   * transaction missing. So we always prefer the live answer and keep the cache
   * purely so the ledger still opens with no connection. */
  if (url.pathname.startsWith('/api/')) {
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

  // Navigation: network first, fall back to the cached shell, then the offline page.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(async () => (await caches.match(request)) ?? (await caches.match('/offline'))),
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
