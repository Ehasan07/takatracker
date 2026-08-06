'use client';

import { usePathname } from 'next/navigation';
import * as React from 'react';

/**
 * Re-keying on the pathname restarts the enter animation, so a route change
 * reads as a screen change rather than a page load. Deliberately short (180ms)
 * — anything slower feels like latency, not polish. Disabled under
 * prefers-reduced-motion by the CSS itself.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={pathname} className="page-enter">
      {children}
    </div>
  );
}
