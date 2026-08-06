'use client';

import { RefreshCw } from 'lucide-react';
import * as React from 'react';
import { haptic } from '@/lib/haptics';

const THRESHOLD = 72;
const MAX_PULL = 120;

/**
 * Pull-to-refresh for the app's own scroll container.
 *
 * The browser's native gesture is switched off (`overscroll-behavior: none`)
 * because in a standalone PWA it reloads the whole shell — which looks like a
 * crash. This replaces it with the gesture a native app would use: drag down
 * past the threshold at the top of the list, release, refetch.
 *
 * Touch only. On desktop the data refreshes on its own and there is nothing to
 * pull.
 */
export function PullToRefresh({
  scrollRef,
  onRefresh,
  children,
}: {
  scrollRef: React.RefObject<HTMLElement | null>;
  onRefresh: () => Promise<unknown>;
  children: React.ReactNode;
}) {
  const [pull, setPull] = React.useState(0);
  const [refreshing, setRefreshing] = React.useState(false);
  const startY = React.useRef<number | null>(null);
  const armed = React.useRef(false);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent): void => {
      if (el.scrollTop > 0 || refreshing) return;
      startY.current = e.touches[0]?.clientY ?? null;
      armed.current = false;
    };

    const onTouchMove = (e: TouchEvent): void => {
      if (startY.current === null || refreshing) return;
      const y = e.touches[0]?.clientY ?? 0;
      const delta = y - startY.current;

      if (delta <= 0 || el.scrollTop > 0) {
        setPull(0);
        return;
      }
      // Rubber band: the further you pull, the less it moves.
      const damped = Math.min(MAX_PULL, delta ** 0.85);
      setPull(damped);

      if (!armed.current && damped >= THRESHOLD) {
        armed.current = true;
        haptic('select');
      }
      if (damped > 6) e.preventDefault();
    };

    const onTouchEnd = (): void => {
      if (startY.current === null) return;
      const shouldRefresh = armed.current;
      startY.current = null;
      armed.current = false;

      if (!shouldRefresh) {
        setPull(0);
        return;
      }

      setRefreshing(true);
      setPull(THRESHOLD);
      void onRefresh().finally(() => {
        setRefreshing(false);
        setPull(0);
      });
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [scrollRef, onRefresh, refreshing]);

  return (
    <>
      <div
        aria-hidden={pull === 0}
        className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center"
        style={{
          height: pull,
          opacity: pull > 8 ? 1 : 0,
          transition: startY.current === null ? 'height 220ms ease, opacity 220ms ease' : 'none',
        }}
      >
        <div className="bg-surface border-rule mt-2 flex h-9 w-9 items-center justify-center self-start rounded-full border shadow-sm">
          <RefreshCw
            className={`text-income h-4 w-4 ${refreshing ? 'animate-spin' : ''}`}
            style={{ transform: refreshing ? undefined : `rotate(${pull * 3}deg)` }}
            aria-hidden
          />
        </div>
      </div>
      <div
        style={{
          transform: `translateY(${pull}px)`,
          transition: startY.current === null ? 'transform 220ms ease' : 'none',
        }}
      >
        {children}
      </div>
    </>
  );
}
