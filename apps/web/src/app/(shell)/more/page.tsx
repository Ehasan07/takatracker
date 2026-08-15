'use client';

import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, LogOut, Search, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import {
  ALL_DESTINATIONS,
  GROUPS,
  blurbOf,
  groupTitleOf,
  labelOf,
  matchesQuery,
  type Destination,
} from '@/components/nav-model';
import { MIGRATION_HREF, useMigrationAllowed } from '@/app/(shell)/migration/access';
import { AccountMenu } from '@/components/account-menu';
import { api } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { resetSessionForSignOut } from '@/lib/session-reset';
import { t } from '@/lib/t';
import { fmtNumber } from '@/lib/format';

/**
 * The আরও hub.
 *
 * A phone tab bar holds five items. This app has thirteen screens, so nine of
 * them live here — one tap from any tab, two taps from anywhere. That is the
 * whole job: it is a directory, not a screen with content of its own, so it is
 * grouped rows with a chevron and a line saying what each one is for.
 *
 * The search box exists because a hub that grows past a screenful stops being
 * faster than guessing. It searches every destination, the four tabs included,
 * so "রিপোর্ট" typed here still finds the report.
 */
export default function MorePage() {
  const [query, setQuery] = React.useState('');
  const searching = query.trim().length > 0;

  /* The migration screen is an allowlist of one, so it is filtered out of both
     the rows and the search — a hub that finds a page the account cannot open
     is a hub that lies. */
  const migrationAllowed = useMigrationAllowed();
  const visible = React.useCallback(
    (item: Destination) => migrationAllowed || item.href !== MIGRATION_HREF,
    [migrationAllowed],
  );

  const matches = React.useMemo(
    () => ALL_DESTINATIONS.filter((item) => visible(item) && matchesQuery(item, query)),
    [query, visible],
  );

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <header className="hidden md:block">
        <h1 className="text-ink text-xl font-semibold sm:text-2xl">আরও</h1>
        <p className="text-ink-muted mt-1 text-sm">অ্যাপের সব পাতা এক জায়গায়।</p>
      </header>

      {/* On a phone there is no sidebar, so this is the only place the signed-in
          person and the way out can live. Logging out used to be reachable only
          from the foot of the settings page. */}
      <AccountMenu />

      <div className="relative">
        <Search
          className="text-ink-muted pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
          aria-hidden
        />
        {/* `type="text"`, not `type="search"`: the native clear affordance is
            inconsistent across engines and would sit under the one below. */}
        <input
          type="text"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="পাতা খুঁজুন"
          placeholder="কোন পাতা খুঁজছেন?"
          data-testid="more-search"
          className="border-rule bg-surface text-ink placeholder:text-ink-muted min-h-11 w-full rounded-md border pl-9 pr-10 text-sm"
        />
        {searching ? (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label="খোঁজ মুছুন"
            className="press text-ink-muted absolute right-0 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </div>

      {searching ? (
        matches.length > 0 ? (
          <Section title={`${fmtNumber(String(matches.length))} টি পাতা`} items={matches} />
        ) : (
          <p className="text-ink-muted rounded-card border-rule bg-surface border p-4 text-sm">
            কিছু পাওয়া যায়নি। অন্য শব্দে খুঁজে দেখুন — যেমন “বীমা”, “এক্সেল” বা “থিম”।
          </p>
        )
      ) : (
        GROUPS.map((group) => (
          <Section key={group.id} title={groupTitleOf(group)} items={group.items.filter(visible)} />
        ))
      )}

      {/* Signing out, in the open.
       *
       * It was already reachable — the account row at the top opens a menu with
       * it inside — but a control behind a disclosure is a control people report
       * as missing, and this one was. On a phone the way out of an app is
       * something you should be able to see, not remember. Hidden while
       * searching, because a directory filtered down to two rows should not
       * carry an unrelated red button under it. */}
      {!searching ? <SignOutRow /> : null}
    </div>
  );
}

function Section({ title, items }: { title: string; items: Destination[] }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="text-ink-muted px-1 text-xs font-medium uppercase tracking-wide">{title}</h2>
      <ul className="rounded-card border-rule bg-surface divide-rule divide-y overflow-hidden border">
        {items.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              onClick={() => haptic('tap')}
              className="press-row flex min-h-14 w-full items-center gap-3 px-3 py-2.5"
            >
              <span className="bg-greenbar text-income flex h-10 w-10 shrink-0 items-center justify-center rounded-full">
                <item.icon className="h-5 w-5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-ink block truncate text-sm font-medium">{labelOf(item)}</span>
                {item.blurb ? (
                  <span className="text-ink-muted block truncate text-xs">{blurbOf(item)}</span>
                ) : null}
              </span>
              <ChevronRight className="text-ink-muted h-4 w-4 shrink-0" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The way out.
 *
 * The same call the account menu makes, including the cache reset — a service
 * worker holding the previous person's balances on a shared phone is the reason
 * that reset exists, and a second sign-out path that skipped it would be a
 * second way to leave them there.
 */
function SignOutRow() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [busy, setBusy] = React.useState(false);

  const signOut = async (): Promise<void> => {
    setBusy(true);
    haptic('tap');
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    await resetSessionForSignOut(queryClient);
    router.push('/login');
    router.refresh();
  };

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void signOut()}
      className="press rounded-card border-rule bg-surface text-expense flex min-h-14 w-full items-center gap-3 border px-3 text-sm font-medium disabled:opacity-60"
    >
      <span className="bg-greenbar text-expense flex h-10 w-10 shrink-0 items-center justify-center rounded-full">
        <LogOut className="h-5 w-5" aria-hidden />
      </span>
      {busy ? t('shell.signingOut', 'বেরিয়ে যাচ্ছে…') : t('shell.signOut', 'লগআউট')}
    </button>
  );
}
