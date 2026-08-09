'use client';

import { usePathname } from 'next/navigation';
import * as React from 'react';

/**
 * Re-keying on the pathname restarts the enter animation, so a route change
 * reads as a screen change rather than a page load.
 *
 * The direction matters more than the distance. A screen that arrives from the
 * right and leaves to the right is the single clearest signal that you are
 * inside a stack of screens rather than clicking through pages — it is what
 * makes the back arrow feel like it undoes something. 14px and 190ms: far
 * enough to read as movement, short enough that it is never latency.
 *
 * Disabled under prefers-reduced-motion by the CSS itself. The animation only
 * translates on the X axis and lives inside `.app-scroll`, which is
 * `overflow-x: hidden`, so it can never widen the document.
 */
export function PageTransition({
  children,
  direction = 'forward',
}: {
  children: React.ReactNode;
  direction?: 'forward' | 'back';
}) {
  const pathname = usePathname();
  return (
    <div key={pathname} className={direction === 'back' ? 'page-enter-back' : 'page-enter'}>
      {children}
    </div>
  );
}
