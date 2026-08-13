'use client';

import * as React from 'react';

/**
 * Whether the browser thinks it has a network.
 *
 * ## Why a list needs this and not just an error state
 *
 * Queries here run with `retry: 0` — deliberately, because a paused retryer
 * makes `invalidateQueries` hang forever over a queued write. The cost is that
 * one dropped request on mobile data leaves a permanent "could not fetch" until
 * somebody taps the retry button, and "could not fetch" is the wrong sentence
 * when the real answer is that the train went into a tunnel.
 *
 * So: say which of the two it is, and come back on our own when the network
 * does. `navigator.onLine` is famously optimistic — it reports true for a
 * captive portal — but it is never wrong in the direction that matters here.
 * When it says false, there is genuinely no network, and that is the case worth
 * naming.
 *
 * Starts optimistic on the server and on the first client render, so the markup
 * matches and there is no hydration flash of an offline warning.
 */
export function useOnline(): boolean {
  const [online, setOnline] = React.useState(true);

  React.useEffect(() => {
    const sync = (): void => setOnline(navigator.onLine);
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    /* A phone that was locked in a lift comes back without firing `online` in
       some browsers; the visibility change is the reliable second chance. */
    document.addEventListener('visibilitychange', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);

  return online;
}
