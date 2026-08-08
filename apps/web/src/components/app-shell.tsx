'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  ChartColumn,
  HandCoins,
  Inbox,
  LayoutDashboard,
  Plus,
  Settings,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';
import { useIsDesktop } from '@/hooks/use-device';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { OfflineBar } from './offline-bar';
import { PageTransition } from './page-transition';
import { PullToRefresh } from './pull-to-refresh';
import { QuickAddSheet } from './quick-add-sheet';

/**
 * One information architecture, two presentations (spec §5):
 *   ≤767px  fixed title bar + bottom tab bar, exactly like the native app
 *   ≥768px  left sidebar, desktop density
 *
 * The chrome never scrolls. Only `<main>` does. That single structural choice
 * is most of what separates "an app" from "a website" on a phone.
 */
const NAV = [
  { href: '/', label: 'ড্যাশবোর্ড', icon: LayoutDashboard },
  { href: '/transactions', label: 'খাতা', icon: Inbox },
  { href: '/loans', label: 'ঋণ', icon: HandCoins },
  { href: '/accounts', label: 'অ্যাকাউন্ট', icon: Wallet },
  { href: '/reports', label: 'রিপোর্ট', icon: ChartColumn },
  { href: '/settings', label: 'সেটিংস', icon: Settings },
] as const;

/**
 * The phone bar carries five of the six. Six tabs at 360px leaves 60px each,
 * which truncates every Bengali label into an unreadable stub. Accounts is the
 * one that drops: it is a setup screen, and the dashboard's balance card links
 * straight to it, whereas loans is visited weekly.
 */
const MOBILE_NAV = NAV.filter((item) => item.href !== '/accounts');

const TITLES: Record<string, string> = {
  '/': 'ড্যাশবোর্ড',
  '/transactions': 'খাতা',
  '/accounts': 'অ্যাকাউন্ট',
  '/categories': 'ক্যাটাগরি',
  '/reports': 'রিপোর্ট',
  '/savings': 'সঞ্চয় ও বীমা',
  '/insurance': 'বীমা',
  '/loans': 'ঋণ',
  '/settings': 'সেটিংস',
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isDesktop = useIsDesktop();
  const queryClient = useQueryClient();
  const [quickAddOpen, setQuickAddOpen] = React.useState(false);
  const scrollRef = React.useRef<HTMLElement | null>(null);

  const isActive = (href: string): boolean =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  // Every route change starts at the top, as a pushed screen would.
  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [pathname]);

  // Desktop accelerators. "n" for a new transaction, Escape to close.
  React.useEffect(() => {
    if (!isDesktop) return;
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable;
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        setQuickAddOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isDesktop]);

  const refresh = React.useCallback(() => queryClient.invalidateQueries(), [queryClient]);

  const openQuickAdd = (): void => {
    haptic('select');
    setQuickAddOpen(true);
  };

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Sidebar — 768px and up */}
      <aside
        data-testid="sidebar"
        className="border-rule bg-surface safe-top hidden w-56 shrink-0 flex-col border-r md:flex lg:w-64"
      >
        <div className="px-4 py-5">
          <Link href="/" className="text-ink text-xl font-semibold">
            হিসাব
          </Link>
          <p className="text-ink-muted text-xs">takatracker.com</p>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-2" aria-label="প্রধান মেনু">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              prefetch
              aria-current={isActive(item.href) ? 'page' : undefined}
              className={cn(
                'press flex min-h-11 items-center gap-3 rounded-md px-3 text-sm',
                isActive(item.href)
                  ? 'bg-greenbar text-income font-semibold'
                  : 'text-ink hover:bg-greenbar',
              )}
            >
              <item.icon className="h-5 w-5 shrink-0" aria-hidden />
              <span className="truncate">{item.label}</span>
            </Link>
          ))}
        </nav>
        <div className="p-3">
          <button
            type="button"
            onClick={openQuickAdd}
            title="নতুন লেনদেন (N)"
            className="press bg-income flex min-h-11 w-full items-center justify-center gap-2 rounded-md px-4 text-sm font-medium text-white"
          >
            <Plus className="h-4 w-4" aria-hidden />
            নতুন লেনদেন
          </button>
        </div>
      </aside>

      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* Fixed title bar — phones only. Mirrors a native navigation bar. */}
        <header className="chrome-blur border-rule safe-top safe-x z-30 shrink-0 border-b md:hidden">
          <div className="flex h-12 items-center justify-center px-3">
            <h1 className="text-ink truncate text-base font-semibold">
              {TITLES[pathname] ?? 'হিসাব'}
            </h1>
          </div>
        </header>

        <OfflineBar />

        <main
          ref={scrollRef}
          className="app-scroll safe-x relative min-w-0 flex-1"
          data-testid="app-scroll"
        >
          <PullToRefresh scrollRef={scrollRef} onRefresh={refresh}>
            {/* Bottom padding clears the tab bar and the floating button. */}
            <div className="px-3 pb-28 pt-4 sm:px-4 md:px-6 md:pb-10 md:pt-6">
              <PageTransition>{children}</PageTransition>
            </div>
          </PullToRefresh>
        </main>

        {/* Floating quick add — under five seconds to a saved transaction. */}
        <button
          type="button"
          aria-label="নতুন লেনদেন"
          onClick={openQuickAdd}
          className="press bg-income fixed right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full text-white shadow-lg md:hidden"
          style={{ bottom: 'calc(4.75rem + env(safe-area-inset-bottom))' }}
        >
          <Plus className="h-6 w-6" aria-hidden />
        </button>

        {/* Bottom tab bar — up to 767px */}
        <nav
          data-testid="bottom-nav"
          aria-label="প্রধান মেনু"
          className="chrome-blur border-rule safe-bottom safe-x z-30 grid shrink-0 grid-cols-5 border-t md:hidden"
        >
          {MOBILE_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              prefetch
              onClick={() => haptic('tap')}
              aria-current={isActive(item.href) ? 'page' : undefined}
              className={cn(
                'press touch-target flex flex-col items-center justify-center gap-0.5 py-1.5 text-[11px]',
                isActive(item.href) ? 'text-income font-semibold' : 'text-ink-muted',
              )}
            >
              <item.icon
                className={cn('h-5 w-5 transition-transform', isActive(item.href) && 'scale-110')}
                aria-hidden
              />
              <span className="truncate px-0.5">{item.label}</span>
            </Link>
          ))}
        </nav>
      </div>

      <QuickAddSheet open={quickAddOpen} onOpenChange={setQuickAddOpen} />
    </div>
  );
}
