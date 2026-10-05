'use client';

import { Building2, LayoutGrid, ScrollText, UserRound } from '@/components/icons';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';
import { Skeleton } from '@/components/skeleton';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { NotFoundScreen, QueryError } from './parts';
import { useOperatorProbe } from './queries';

const TABS: { href: string; label: string; icon: typeof LayoutGrid }[] = [
  { href: '/admin', label: 'সারসংক্ষেপ', icon: LayoutGrid },
  { href: '/admin/tenants', label: 'ওয়ার্কস্পেস', icon: Building2 },
  { href: '/admin/users', label: 'ইউজার', icon: UserRound },
  { href: '/admin/audit', label: 'কার্যবিবরণী', icon: ScrollText },
];

/**
 * The gate, and the panel's own chrome.
 *
 * ## The gate
 *
 * Nothing under `/admin` renders until one request has come back 200. The check
 * is a request rather than a claim because there is no claim to read:
 * `isSuperAdmin` is absent from the JWT on purpose, so that a revoked operator
 * loses access on their next request instead of up to fifteen minutes later,
 * and `/auth/me` does not return it either. The server is the only thing that
 * knows, so the server is asked.
 *
 * A 404 renders the ordinary not-found page — no chrome, no tabs, no hint that
 * anything was refused. That mirrors `SuperAdminGuard`, which answers a
 * non-operator exactly as it answers a path that was never routed, so that the
 * existence of this panel cannot be established by comparing status codes.
 *
 * A *network* failure is not a verdict. It gets a retry, not a 404 — telling an
 * operator on a bad connection that their access has gone would be a lie, and
 * one they would escalate.
 *
 * None of this is a security boundary. The boundary is the guard: every byte
 * this panel shows came through it, and hiding the tabs only keeps the panel
 * out of the way of people it does not concern.
 *
 * ## The bar
 *
 * `ImpersonationBar` is no longer mounted here. It moved to
 * `components/app-shell.tsx`, which wraps every signed-in screen rather than
 * only the console — the operator spends a support session on the customer's
 * own pages, which is precisely where the banner and the way out have to be.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const probe = useOperatorProbe();

  /* No latch any more: `/auth/me` returns `isSuperAdmin`, so the navigation can
   * answer the question without a probe and a revoked operator loses the link
   * on their next page load rather than when they next follow it. The probe
   * below stays because it is the *guard's* answer, and the guard is the
   * boundary — a client flag decides a menu item, never access. */

  if (probe.isNotHere) return <NotFoundScreen />;

  if (probe.isError) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <QueryError message="সংযোগ পাওয়া যায়নি।" onRetry={probe.refetch} />
      </div>
    );
  }

  if (probe.isLoading) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3" aria-busy>
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-4xl flex-col gap-4">
      <nav aria-label="প্ল্যাটফর্ম মেনু" className="chip-strip">
        {TABS.map((tab) => {
          const active =
            tab.href === '/admin' ? pathname === '/admin' : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              onClick={() => haptic('tap')}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'press border-rule flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm md:min-h-9',
                active
                  ? 'bg-income border-income font-medium text-white'
                  : 'bg-surface text-ink hover:bg-greenbar',
              )}
            >
              <tab.icon className="h-4 w-4 shrink-0" aria-hidden />
              {tab.label}
            </Link>
          );
        })}
      </nav>

      {children}
    </div>
  );
}
