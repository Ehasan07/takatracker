'use client';

import * as React from 'react';

/**
 * SSR-safe media query hook. Returns false until mounted.
 *
 * Re-read when the app comes back to the foreground, not only on `change`. An
 * installed app on iOS can be suspended and resumed without the events that
 * happened in between ever being delivered, which leaves a hook holding an
 * answer that was true when the app was put down. See `useKeyboardInset` for
 * the case where that was actually visible.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(false);

  React.useEffect(() => {
    const mql = window.matchMedia(query);
    const read = (): void => setMatches(mql.matches);

    read();
    const onChange = (e: MediaQueryListEvent): void => setMatches(e.matches);
    mql.addEventListener('change', onChange);
    /* `pageshow` covers a restore from the back-forward cache, which is how an
       installed app usually comes back; `visibilitychange` covers a plain
       resume. Both are cheap and idempotent. */
    window.addEventListener('pageshow', read);
    document.addEventListener('visibilitychange', read);
    return () => {
      mql.removeEventListener('change', onChange);
      window.removeEventListener('pageshow', read);
      document.removeEventListener('visibilitychange', read);
    };
  }, [query]);

  return matches;
}

/** Tablet and up: sidebar, tables, hover affordances. */
export const useIsDesktop = (): boolean => useMediaQuery('(min-width: 768px)');

/** A finger, not a mouse — suppress the native keyboard, enlarge targets. */
export const useCoarsePointer = (): boolean => useMediaQuery('(pointer: coarse)');

/** Launched from the home screen rather than a browser tab. */
export const useIsStandalone = (): boolean =>
  useMediaQuery('(display-mode: standalone), (display-mode: fullscreen)');

/**
 * Height of the on-screen keyboard, in pixels. The visual viewport shrinks when
 * the keyboard opens; nothing else on the web tells you this reliably.
 *
 * ## Why it also listens for the app coming back
 *
 * This number does more than pad a sheet: the floating + button is hidden
 * whenever it is above zero, so a value that gets stuck non-zero takes the main
 * way of adding a transaction off the screen — and leaves a tall blank strip
 * under every sheet. It cannot be argued out of, because nothing on screen
 * explains it. Closing and reopening the app fixes it, which is exactly what
 * was reported.
 *
 * That is what a suspended web view does: an installed app backgrounded with
 * the keyboard up is resumed with the keyboard gone and no `resize` ever
 * delivered for the difference. So the measurement is taken again whenever the
 * page is shown, and a hidden page reports zero rather than whatever it
 * happened to be holding — there is no keyboard on a page nobody is looking at.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = React.useState(0);

  React.useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = (): void => {
      if (document.visibilityState === 'hidden') {
        setInset(0);
        return;
      }
      const hidden = window.innerHeight - vv.height - vv.offsetTop;
      setInset(hidden > 80 ? hidden : 0);
    };

    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    window.addEventListener('pageshow', update);
    window.addEventListener('orientationchange', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      window.removeEventListener('pageshow', update);
      window.removeEventListener('orientationchange', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  return inset;
}
