'use client';

import * as React from 'react';

/** SSR-safe media query hook. Returns false until mounted. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(false);

  React.useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent): void => setMatches(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
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
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = React.useState(0);

  React.useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = (): void => {
      const hidden = window.innerHeight - vv.height - vv.offsetTop;
      setInset(hidden > 80 ? hidden : 0);
    };

    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return inset;
}
