'use client';

import { useIsOperator } from '@/app/(shell)/admin/operator-flag';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Plus } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';
import { useIsDesktop, useKeyboardInset } from '@/hooks/use-device';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { BrandMark } from '@/components/brand-mark';
import { t } from '@/lib/t';
import {
  HUB_DESTINATIONS,
  MORE_HREF,
  PRIMARY,
  OPERATOR_PRIMARY,
  OPERATOR_SIDEBAR_GROUPS,
  SIDEBAR_GROUPS,
  groupTitleOf,
  labelOf,
  tabLabelOf,
  isPrimaryRoute,
  parentOf,
  titleFor,
} from './nav-model';
import { AccountMenu } from './account-menu';
import { OfflineBar } from './offline-bar';
import { PageTransition } from './page-transition';
import { PullToRefresh } from './pull-to-refresh';
import { QuickAddSheet } from './quick-add-sheet';

/**
 * One information architecture, two presentations (spec §5):
 *   ≤767px  fixed title bar + five-tab bottom bar, exactly like the native app
 *   ≥768px  left sidebar carrying all thirteen, in the hub's own three groups
 *
 * The phone's fifth tab is আরও, which lists the nine the bar cannot hold, so no
 * screen is more than two taps from the bottom of the thumb's reach. The
 * desktop needs no such compression and gets none: every screen is one click.
 *
 * The chrome never scrolls. Only `<main>` does. That single structural choice
 * is most of what separates "an app" from "a website" on a phone.
 *
 * The destinations themselves live in `nav-model.ts`; this file is only their
 * presentation and the behaviour around them — back, scroll memory, direction.
 */

/** `/import` must not light up on a hypothetical `/importer`. */
function isUnder(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * A popstate that does not end in a route change — going back over a
 * search-param-only entry on /reports, say — would otherwise leave the flag set
 * and make the next forward navigation restore a stale scroll offset.
 */
const POP_WINDOW_MS = 600;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isDesktop = useIsDesktop();
  const keyboardInset = useKeyboardInset();
  const queryClient = useQueryClient();
  /* An operator gets a different product, not the same one with a menu item
   * added.
   *
   * They run the platform; they do not keep books in it. Leaving ড্যাশবোর্ড,
   * খাতা and ধার-দেনা in their navigation offered five taps into a ledger that
   * will never have anything in it, and made the product look as though the
   * person running it is also a customer of it.
   *
   * This is presentation only. Every byte the panel shows still passes
   * `SuperAdminGuard`, which re-reads the flag from the database on every admin
   * request — forging the flag here buys a menu that leads to 404. And it hides
   * rather than forbids: the customer routes still render if an operator types
   * one, because their workspace does exist (it is where their own audit rows
   * are filed) and breaking it would be a bigger change than this is. */
  const isOperator = useIsOperator();
  const sidebarGroups = React.useMemo(
    () => (isOperator ? OPERATOR_SIDEBAR_GROUPS : SIDEBAR_GROUPS),
    [isOperator],
  );
  const tabs = isOperator ? OPERATOR_PRIMARY : PRIMARY;
  const [quickAddOpen, setQuickAddOpen] = React.useState(false);
  const scrollRef = React.useRef<HTMLElement | null>(null);

  const isActive = (href: string): boolean => isUnder(pathname, href);

  /* আরও owns every screen it lists. Standing on /settings, the tab a person
   * came through is the one that should look selected. */
  const inHub = React.useMemo(
    () => HUB_DESTINATIONS.some((item) => isUnder(pathname, item.href)),
    [pathname],
  );
  const tabActive = (href: string): boolean =>
    href === MORE_HREF ? pathname === MORE_HREF || inHub : isActive(href);

  /* --- navigation history ------------------------------------------------ */

  const scrollMemory = React.useRef(new Map<string, number>());
  const poppedRef = React.useRef(false);
  const popTimer = React.useRef<number | null>(null);
  const previousPath = React.useRef<string | null>(null);
  const directionRef = React.useRef<'forward' | 'back'>('forward');

  // Computed in render, not in an effect: a class that changes after the node
  // has mounted restarts the animation, and the restart is visible.
  if (previousPath.current !== pathname) {
    directionRef.current = poppedRef.current ? 'back' : 'forward';
    previousPath.current = pathname;
  }

  React.useEffect(() => {
    const onPopState = (): void => {
      poppedRef.current = true;
      if (popTimer.current) window.clearTimeout(popTimer.current);
      popTimer.current = window.setTimeout(() => {
        poppedRef.current = false;
      }, POP_WINDOW_MS);
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      if (popTimer.current) window.clearTimeout(popTimer.current);
    };
  }, []);

  // Remember where each screen was left, cheaply — one write per frame at most.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const memory = scrollMemory.current;
    let frame = 0;
    const onScroll = (): void => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        memory.set(pathname, el.scrollTop);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener('scroll', onScroll);
    };
  }, [pathname]);

  /**
   * Forward goes to the top, as a pushed screen would. Back returns to the
   * pixel the list was left on — which is the whole point of going back, and
   * the thing whose absence makes a PWA feel like a web page.
   *
   * The retry loop exists because the screen being restored is usually a
   * skeleton for a frame or two: the container is not yet tall enough to hold
   * the offset, so a single `scrollTo` silently clamps to the bottom.
   */
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const restoring = poppedRef.current;
    poppedRef.current = false;
    if (popTimer.current) window.clearTimeout(popTimer.current);

    const target = restoring ? (scrollMemory.current.get(pathname) ?? 0) : 0;
    el.scrollTo({ top: target });
    if (target === 0) return;

    let attempts = 0;
    let frame = 0;
    const retry = (): void => {
      attempts += 1;
      if (el.scrollTop < target) el.scrollTo({ top: target });
      if (el.scrollTop >= target || attempts > 20) return;
      frame = requestAnimationFrame(retry);
    };
    frame = requestAnimationFrame(retry);
    return () => cancelAnimationFrame(frame);
  }, [pathname]);

  /* --- back ---------------------------------------------------------------- */

  const showBack = !isPrimaryRoute(pathname);

  /* How many screens this session has been through. One means the app opened
   * straight onto this route — a deep link, a notification, a restored
   * standalone window — so there is nothing of ours behind it and `back()`
   * would leave the app entirely. `history.length` cannot tell us that: it
   * counts the tab's whole browsing history, not ours. */
  const screensVisited = React.useRef(0);
  React.useEffect(() => {
    screensVisited.current += 1;
  }, [pathname]);

  const goBack = (): void => {
    haptic('tap');
    if (screensVisited.current > 1) router.back();
    else router.push(parentOf(pathname));
  };

  /* --- quick add ------------------------------------------------------------ */

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

  /* The home-screen shortcut "নতুন লেনদেন" opens `/?quickadd=1`. The manifest
   * has advertised that URL since the app was installable and nothing had ever
   * read it, so the shortcut landed on the dashboard and did nothing.
   *
   * Read from `location` rather than `useSearchParams`, which would force every
   * screen under this layout out of static rendering for one query parameter. */
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('quickadd')) return;
    setQuickAddOpen(true);
    params.delete('quickadd');
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  }, []);

  const refresh = React.useCallback(() => queryClient.invalidateQueries(), [queryClient]);

  const openQuickAdd = (): void => {
    haptic('select');
    setQuickAddOpen(true);
  };

  return (
    <div data-app-shell className="flex h-dvh overflow-hidden">
      {/* Sidebar — 768px and up. One <nav>, because the 44px audit in
          e2e/responsive.spec.ts resolves it with getByRole('navigation'). */}
      <aside
        data-testid="sidebar"
        className="border-rule bg-surface safe-top hidden w-56 shrink-0 flex-col border-r md:flex lg:w-64"
      >
        <div className="shrink-0 px-4 pb-2 pt-4">
          <Link href="/" className="text-ink text-lg font-semibold">
            Taka Tracker
          </Link>
          <p className="text-ink-muted text-xs">takatracker.com</p>
        </div>

        {/* Thirteen 44px rows and three labels measure 664px, which is exactly
            the room a 1280×800 window leaves between the wordmark and the add
            button — hence `pt-2` on the labels rather than anything rounder.
            It scrolls on a shorter window instead of silently losing its tail.

            The group titles are <p>, not headings: the sidebar is chrome, and
            three more headings would clutter a screen reader's document
            outline. `aria-labelledby` still names each list. */}
        <nav
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
          aria-label={t('shell.mainMenu', 'প্রধান মেনু')}
        >
          {sidebarGroups.map((group) => (
            <div key={group.id}>
              {group.title ? (
                <p
                  id={`nav-${group.id}`}
                  className="text-ink-muted px-3 pb-0.5 pt-2 text-[11px] font-medium tracking-wide"
                >
                  {groupTitleOf(group)}
                </p>
              ) : null}
              <ul
                className="flex flex-col"
                aria-labelledby={group.title ? `nav-${group.id}` : undefined}
              >
                {group.items.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      prefetch={group.id === 'primary'}
                      aria-current={isActive(item.href) ? 'page' : undefined}
                      className={cn(
                        'press flex min-h-11 items-center gap-3 rounded-md px-3 text-sm',
                        isActive(item.href)
                          ? 'bg-greenbar text-income font-semibold'
                          : 'text-ink hover:bg-greenbar',
                      )}
                    >
                      <item.icon className="h-5 w-5 shrink-0" aria-hidden />
                      <span className="truncate">{labelOf(item)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="shrink-0 space-y-2 p-3">
          {/* Who is signed in, and the way out. Both were invisible: the shell
              showed no name at all and logout lived at the foot of the settings
              page, so there was nothing on screen to suggest an account even
              existed. */}
          <AccountMenu />
          {/* Not for an operator: the button writes into a ledger they do not
              keep, and offering it is how a support session ends up with a test
              transaction in somebody's books. */}
          {isOperator ? null : (
            <button
              type="button"
              onClick={openQuickAdd}
              title={`${t('shell.newTransaction', 'নতুন লেনদেন')} (N)`}
              className="press bg-brand text-brand-contrast hover:bg-brand-strong flex min-h-11 w-full items-center justify-center gap-2 rounded-md px-4 text-sm font-medium"
            >
              <Plus className="h-4 w-4" aria-hidden />
              {t('shell.newTransaction', 'নতুন লেনদেন')}
            </button>
          )}
        </div>
      </aside>

      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* Fixed title bar — phones only. Mirrors a native navigation bar, and
            differs between the two kinds of screen for the reason a native app
            does:

            On a tab root the mark and the name sit on the left, because an
            installed app opening with nothing but the word "ড্যাশবোর্ড" could be
            anybody's, and the home screen icon is the only other place the brand
            appears. On a screen you navigated *into*, the back arrow and the
            centred page title take over — there "where am I" is worth more than
            "whose app is this", which the person already knows by then. */}
        <header className="chrome-blur border-rule safe-top safe-x z-30 shrink-0 border-b md:hidden">
          <div
            className={cn(
              'relative flex h-12 items-center',
              showBack ? 'justify-center px-12' : 'justify-start px-3',
            )}
          >
            {showBack ? (
              <>
                <button
                  type="button"
                  onClick={goBack}
                  aria-label={t('shell.back', 'পিছনে')}
                  className="press touch-target text-ink absolute inset-y-0 left-0 flex items-center justify-center"
                >
                  <ChevronLeft className="h-6 w-6" aria-hidden />
                </button>
                <h1 className="text-ink truncate text-base font-semibold">{titleFor(pathname)}</h1>
              </>
            ) : (
              <>
                <BrandMark size="sm" />
                {/* Both, because both answer a question and they are different
                    questions. The brand says whose app this is, which an
                    installed app opening on the word ড্যাশবোর্ড could not; the
                    page title says where you are, which is what the bar was for
                    in the first place. Losing the second to gain the first was
                    a bad trade and this is the correction.

                    Right-aligned and muted: the eye starts at the brand, and
                    the title is a label rather than a headline once something
                    else is already claiming the left. */}
                <h1 className="text-ink-muted ml-auto min-w-0 truncate pl-3 text-sm">
                  {titleFor(pathname)}
                </h1>
              </>
            )}
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
              <PageTransition direction={directionRef.current}>{children}</PageTransition>
            </div>
          </PullToRefresh>
        </main>

        {/* Floating quick add — under five seconds to a saved transaction. It
            gets out of the way when the on-screen keyboard is up, where it would
            otherwise sit on top of the field being typed into. */}
        <button
          type="button"
          aria-label={t('shell.newTransaction', 'নতুন লেনদেন')}
          onClick={openQuickAdd}
          className={cn(
            'press bg-brand text-brand-contrast fixed right-4 z-30 h-14 w-14 items-center justify-center rounded-full shadow-lg',
            // Not the `hidden` attribute: `display: flex` from a utility class
            // is an author rule and beats the user agent's `[hidden]`.
            keyboardInset > 0 || isOperator ? 'hidden' : 'flex md:hidden',
          )}
          style={{ bottom: 'calc(4.75rem + env(safe-area-inset-bottom))' }}
        >
          <Plus className="h-6 w-6" aria-hidden />
        </button>

        {/* Bottom tab bar — up to 767px.

            Five, measured rather than assumed. At 320px five cells are 64px and
            every label clears its box by 15–45px. Six cells are 53px, where
            "ড্যাশবোর্ড" (47px) and "অ্যাকাউন্ট" (48px) fit by one or two pixels
            with the fallback Bengali face — one font substitution from clipping,
            and too narrow for the 48px selected-tab pill. Seven clips three of
            the seven outright. So five, with short labels, is the honest limit
            and everything else lives one tap deeper in আরও. */}
        <nav
          data-testid="bottom-nav"
          aria-label={t('shell.mainMenu', 'প্রধান মেনু')}
          className="chrome-blur border-rule safe-bottom safe-x z-30 grid shrink-0 grid-cols-5 border-t md:hidden"
        >
          {tabs.map((item) => {
            const active = tabActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                prefetch
                onClick={() => haptic('tap')}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'press touch-target flex flex-col items-center justify-center gap-0.5 py-1.5 text-[11px]',
                  active ? 'text-income font-semibold' : 'text-ink-muted',
                )}
              >
                <span
                  className={cn(
                    'flex h-7 w-12 items-center justify-center rounded-full transition-colors',
                    active && 'bg-greenbar',
                  )}
                >
                  <item.icon className="h-5 w-5" aria-hidden />
                </span>
                <span className="w-full truncate px-0.5 text-center">{tabLabelOf(item)}</span>
              </Link>
            );
          })}
        </nav>
      </div>

      <QuickAddSheet open={quickAddOpen} onOpenChange={setQuickAddOpen} />
    </div>
  );
}
