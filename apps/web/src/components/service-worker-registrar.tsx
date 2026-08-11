'use client';

import { usePathname } from 'next/navigation';
import * as React from 'react';

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
