'use client';

import * as React from 'react';

/**
 * Registers the service worker and shows the custom
 * "হোম স্ক্রিনে যোগ করুন" prompt once, dismissibly (spec §5).
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'hishab.install-prompt.dismissed';

export function ServiceWorkerRegistrar() {
  const [installEvent, setInstallEvent] = React.useState<BeforeInstallPromptEvent | null>(null);

  React.useEffect(() => {
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
  }, []);

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
