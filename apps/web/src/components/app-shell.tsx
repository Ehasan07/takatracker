'use client';

import { Inbox, LayoutDashboard, Plus, Settings, Wallet } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';
import { cn } from '@/lib/utils';
import { OfflineBar } from './offline-bar';
import { QuickAddSheet } from './quick-add-sheet';

/**
 * One information architecture, two presentations (spec §5):
 *   ≤767px  bottom tab bar, matching the native app
 *   ≥768px  left sidebar
 */
const NAV = [
  { href: '/', label: 'ড্যাশবোর্ড', icon: LayoutDashboard },
  { href: '/transactions', label: 'খাতা', icon: Inbox },
  { href: '/accounts', label: 'অ্যাকাউন্ট', icon: Wallet },
  { href: '/settings', label: 'সেটিংস', icon: Settings },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [quickAddOpen, setQuickAddOpen] = React.useState(false);

  const isActive = (href: string): boolean =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      {/* Sidebar — 768px and up */}
      <aside
        data-testid="sidebar"
        className="border-rule bg-surface hidden w-56 shrink-0 border-r md:flex md:flex-col lg:w-64"
      >
        <div className="safe-top px-4 py-5">
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
              aria-current={isActive(item.href) ? 'page' : undefined}
              className={cn(
                'flex min-h-11 items-center gap-3 rounded-md px-3 text-sm',
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
            onClick={() => setQuickAddOpen(true)}
            className="bg-income flex min-h-11 w-full items-center justify-center gap-2 rounded-md px-4 text-sm font-medium text-white"
          >
            <Plus className="h-4 w-4" aria-hidden />
            নতুন লেনদেন
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <OfflineBar />
        {/* pb-24 keeps the last row clear of the bottom bar and the FAB */}
        <main className="min-w-0 flex-1 px-3 pb-24 pt-4 sm:px-4 md:px-6 md:pb-8">{children}</main>
      </div>

      {/* Floating quick-add on phones — target under 5 seconds */}
      <button
        type="button"
        aria-label="নতুন লেনদেন"
        onClick={() => setQuickAddOpen(true)}
        className="bg-income fixed bottom-20 right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full text-white shadow-lg md:hidden"
        style={{ bottom: 'calc(4.5rem + env(safe-area-inset-bottom))' }}
      >
        <Plus className="h-6 w-6" aria-hidden />
      </button>

      {/* Bottom tab bar — up to 767px */}
      <nav
        data-testid="bottom-nav"
        aria-label="প্রধান মেনু"
        className="safe-bottom border-rule bg-surface fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t md:hidden"
      >
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive(item.href) ? 'page' : undefined}
            className={cn(
              'touch-target flex flex-col items-center justify-center gap-0.5 py-2 text-[11px]',
              isActive(item.href) ? 'text-income font-semibold' : 'text-ink-muted',
            )}
          >
            <item.icon className="h-5 w-5" aria-hidden />
            <span className="truncate px-0.5">{item.label}</span>
          </Link>
        ))}
      </nav>

      <QuickAddSheet open={quickAddOpen} onOpenChange={setQuickAddOpen} />
    </div>
  );
}
