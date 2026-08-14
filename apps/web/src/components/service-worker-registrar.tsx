'use client';

import { usePathname } from 'next/navigation';
import * as React from 'react';
import { isRefreshing } from '@/lib/api';

/**
 * Registers the service worker and shows the custom
 * "হোম স্ক্রিনে যোগ করুন" prompt once, dismissibly (spec §5).
 */

/**
 * The public pages, where a service worker is a cost with no benefit.
 *
 * Installing it precaches eight app routes — every tab-bar destination — which
 * is exactly right for somebody who is going to use the app offline and exactly
 * wrong for somebody who arrived from a search result and may never sign up: it
 * is eight extra requests competing with the paint of the page they asked for,
 * on the connection least able to spare them. Registration is deferred until
 * they are inside the product, which is also when the offline promise starts
 * being worth anything.
 */
const NO_WORKER = new Set([
  '/home',
  '/pricing',
  '/login',
  '/signup',
  '/forgot',
  '/reset',
  '/verify',
]);
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'hishab.install-prompt.dismissed';

/**
 * Take a new release on the launch that finds it, not the one after.
 *
 * Navigation is stale-while-revalidate (see `public/sw.js`), which is what
 * makes a relaunch from the home screen instant. The cost is that the document
 * served on launch is the one cached last time: a person who installed the app
 * a month ago opens it after a deploy and gets the old shell, with the new one
 * arriving only in the background. Without this they would have to open the app
 * twice to see anything that shipped — and would have no way of knowing that.
 *
 * Three things happen here, and the order matters:
 *
 *  - `update()` asks the browser to re-fetch `sw.js` now. It does that on its
 *    own eventually, but "eventually" is up to a day.
 *  - `controllerchange` fires when the new worker takes over. `sw.js` calls
 *    `skipWaiting()` and `clients.claim()`, so that happens without waiting for
 *    every tab to close — which means the page is now running the *old* code
 *    against the *new* cache. Reloading is what resolves that, not what causes
 *    it.
 *  - The reload is guarded twice. `refreshing` stops the classic loop where the
 *    reload triggers another `controllerchange`; and it only fires when there
 *    was already a controller, so a first install — where there is nothing to
 *    replace — does not bounce the page somebody just opened.
 */
let refreshing = false;

/**
 * Reload, but never on top of a token rotation.
 *
 * Reloading mid-refresh is not merely wasteful: the request is cancelled after
 * the server has already spent the refresh token, the browser keeps the old one
 * in its cookie, and the next load presents it. The server reads that as a
 * replayed token — correctly, that is what reuse detection is for — revokes the
 * whole family, and the person is signed out of their own books by an update
 * they never asked for. It was visible in production as three
 * `Refresh token reuse detected` lines and a dashboard with no name on it.
 *
 * So the reload waits for the rotation to land. The ceiling is there because a
 * refresh that never settles must not leave the page waiting forever; taking
 * the update on the *next* launch is a small cost, and signing somebody out is
 * not.
 */
/**
 * How rarely a resumed app re-checks for a release.
 *
 * A minute is short enough that somebody who switches back after lunch gets the
 * new build, and long enough that flicking between two apps does not refetch
 * `sw.js` on every flick.
 */
export const UPDATE_CHECK_THROTTLE_MS = 60_000;

export const RELOAD_POLL_MS = 400;
export const RELOAD_GIVE_UP_MS = 10_000;

/**
 * The decision on its own, so it can be tested without a browser.
 *
 * Two ways to say yes and they mean different things: the rotation finished, or
 * it never will. The second is a deliberate surrender — a refresh that hangs
 * must not leave the page pinned to an old build forever.
 */
export function shouldReloadNow(busy: boolean, elapsedMs: number): boolean {
  return !busy || elapsedMs > RELOAD_GIVE_UP_MS;
}

function reloadOnceItIsSafe(startedAt = Date.now()): void {
  if (shouldReloadNow(isRefreshing(), Date.now() - startedAt)) {
    window.location.reload();
    return;
  }
  window.setTimeout(() => reloadOnceItIsSafe(startedAt), RELOAD_POLL_MS);
}

function adoptUpdates(): void {
  const container = navigator.serviceWorker;

  /* Read *before* anything is registered. `sw.js` calls `clients.claim()`, so a
     first install also fires `controllerchange` — going from no controller to
     one — and reloading on that would bounce the page of somebody who has just
     arrived, every first visit, for no benefit at all: they are already looking
     at the newest build. Only a page that was already controlled by an older
     worker has anything to adopt. */
  const hadController = Boolean(container.controller);

  container.addEventListener('controllerchange', () => {
    if (!hadController || refreshing) return;
    refreshing = true;
    reloadOnceItIsSafe();
  });

  if (!hadController) return;

  /* Ask now. Browsers re-fetch `sw.js` on their own, but on a schedule measured
     in hours — far too slow to be how a release reaches an installed app. */
  void container.ready.then((registration) => registration.update()).catch(() => undefined);

  /* And ask again every time the app comes back to the front.
   *
   * This is the whole reason an installed app was running a build from days
   * ago. The check above happens when a *page loads*, and an installed app
   * resumed from the background does not load a page — it is the same document
   * it was when the person switched away. So on a phone the question was never
   * asked again, and the app went on serving whatever was cached the day it was
   * opened. A browser tab hid the problem by being reloaded now and then.
   *
   * `visibilitychange` is the event that means "somebody is looking at this
   * again", which is exactly when a new release should be picked up and exactly
   * when a reload costs nothing. `controllerchange` above does the reloading;
   * this only asks the question.
   *
   * Throttled, because switching apps twice in a second should not fetch
   * `sw.js` twice — and because the fetch is cheap but not free on a phone
   * connection. */
  let lastAsk = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastAsk < UPDATE_CHECK_THROTTLE_MS) return;
    lastAsk = Date.now();
    void container.ready.then((registration) => registration.update()).catch(() => undefined);
  });
}

export function ServiceWorkerRegistrar() {
  const pathname = usePathname();
  const [installEvent, setInstallEvent] = React.useState<BeforeInstallPromptEvent | null>(null);
  /* `/` is the landing page for a signed-out visitor and the dashboard for
   * everybody else — the same URL, decided by the middleware. The refresh
   * cookie is not readable from script (httpOnly, by design), so the shell's
   * own marker on the DOM is what separates the two. */
  const isPublicPage =
    NO_WORKER.has(pathname) ||
    (pathname === '/' &&
      typeof document !== 'undefined' &&
      !document.querySelector('[data-app-shell]'));

  React.useEffect(() => {
    if (isPublicPage) return;
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
      adoptUpdates();
    }

    const onPrompt = (event: Event): void => {
      event.preventDefault();
      if (localStorage.getItem(DISMISS_KEY) === '1') return;
      setInstallEvent(event as BeforeInstallPromptEvent);
    };

    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, [isPublicPage]);

  const dismiss = (): void => {
    localStorage.setItem(DISMISS_KEY, '1');
    setInstallEvent(null);
  };

  if (!installEvent) return null;

  return (
    <div
      role="dialog"
      aria-label="অ্যাপ ইনস্টল"
      className="border-rule bg-surface fixed inset-x-3 bottom-24 z-40 flex items-center gap-3 rounded-lg border p-3 shadow-lg md:inset-x-auto md:bottom-6 md:right-6 md:w-80"
    >
      <p className="text-ink flex-1 text-sm">হোম স্ক্রিনে যোগ করুন — অ্যাপের মতো চলবে।</p>
      <button
        type="button"
        onClick={dismiss}
        className="touch-target text-ink-muted rounded-md px-2 text-sm"
      >
        পরে
      </button>
      <button
        type="button"
        onClick={() => {
          void installEvent.prompt();
          dismiss();
        }}
        className="bg-income min-h-11 rounded-md px-3 text-sm font-medium text-white"
      >
        যোগ করুন
      </button>
    </div>
  );
}
