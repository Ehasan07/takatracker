'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Settings } from '@/components/icons';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { api, endpoints } from '@/lib/api';
import { t } from '@/lib/t';
import { haptic } from '@/lib/haptics';
import { resetSessionForSignOut } from '@/lib/session-reset';
import { cn } from '@/lib/utils';

/**
 * Who is signed in, and how to stop being signed in.
 *
 * Logging out used to live only at the bottom of the settings page, and the
 * shell showed no name, no email and no account control at all — so there was
 * nothing on screen to suggest an account existed, let alone how to leave it.
 * A person who wants to sign out looks for themselves first; if they cannot
 * find themselves, they cannot find the door.
 */
export function AccountMenu({
  collapsed = false,
  /**
   * Avatar only, with no box around it — for the phone's top bar, where there
   * is room for a 44px target and none for a name and an email beside it.
   */
  compact = false,
  /**
   * Which way the menu opens. `up` suits the sidebar's footer; `down` is what
   * a control in a header needs, and opening upward there would put the menu
   * off the top of the screen.
   */
  placement = 'up',
}: {
  collapsed?: boolean;
  compact?: boolean;
  placement?: 'up' | 'down';
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  const me = useQuery({
    queryKey: ['me'],
    queryFn: endpoints.me,
    staleTime: 5 * 60_000,
    retry: false,
    networkMode: 'always',
  });

  // Click-away and Escape, the two ways anybody expects to dismiss a menu.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const logout = async (): Promise<void> => {
    setBusy(true);
    haptic('tap');
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    /* After the token is dead so a racing tab cannot refill the cache, and
     * before navigating so nothing survives into /login — the service worker
     * would otherwise keep serving the previous person's balances offline. */
    await resetSessionForSignOut(queryClient);
    router.push('/login');
    router.refresh();
  };

  const name = me.data?.name ?? '';
  const email = me.data?.email ?? '';
  /* The first letter of their name, or the brand's initial when there is no
     name yet. `T` rather than `হ` once the app is in English: an avatar is a
     glyph, and a Bengali one on an otherwise English chrome reads as a bug. */
  const initial = name.trim().slice(0, 1) || t('shell.avatarFallback', 'হ');

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        /* Its own name, not the settings heading's. On a phone this button is
           the only thing carrying a label, and "অ্যাকাউন্ট" is also what every
           money-account picker on the app is called — two controls with one
           accessible name on the same screen is a screen reader reading the
           same word for the profile menu and for the field asking which bank
           account an entry came out of. */
        aria-label={compact ? t('shell.accountMenu', 'আমার অ্যাকাউন্ট') : undefined}
        className={cn(
          'press hover:bg-greenbar flex min-h-11 items-center gap-2 text-left',
          compact
            ? 'touch-target justify-center rounded-md px-1'
            : 'border-rule w-full rounded-md border px-2',
          collapsed && 'justify-center',
        )}
      >
        <span
          aria-hidden
          className="bg-greenbar text-income flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
        >
          {initial}
        </span>
        {!collapsed && !compact ? (
          <span className="min-w-0 flex-1">
            <span className="text-ink block truncate text-sm font-medium">
              {name || t('shell.account', 'অ্যাকাউন্ট')}
            </span>
            <span className="text-ink-muted block truncate text-xs">{email}</span>
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="menu"
          className={cn(
            'border-rule bg-surface absolute z-40 min-w-52 overflow-hidden rounded-md border shadow-lg',
            placement === 'down' ? 'right-0 top-full mt-2' : 'bottom-full left-0 mb-2 w-full',
          )}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              router.push('/settings');
            }}
            className="press text-ink hover:bg-greenbar flex min-h-11 w-full items-center gap-2 px-3 text-sm"
          >
            <Settings className="h-4 w-4" aria-hidden />
            {t('nav.settings', 'সেটিংস')}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => void logout()}
            className="press text-expense hover:bg-greenbar border-rule flex min-h-11 w-full items-center gap-2 border-t px-3 text-sm disabled:opacity-60"
          >
            <LogOut className="h-4 w-4" aria-hidden />
            {busy ? t('shell.signingOut', 'বেরিয়ে যাচ্ছে…') : t('shell.signOut', 'লগআউট')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The time of day, in the words a Bengali speaker would use.
 *
 * Read from the *browser's* clock, not the workspace timezone: "good evening"
 * describes where the person reading it is sitting, and telling somebody in
 * London "শুভ সকাল" because their books are kept in Dhaka time would be wrong
 * about the only thing this sentence claims.
 */
export function greetingFor(now: Date): string {
  const hour = now.getHours();
  /* Bengali has five of these where English has three, so the English
     catalogue maps দুপুর and বিকাল onto one "Good afternoon" rather than
     inventing a word for each. That is a translation decision, not a lost
     distinction: the Bengali still says all five. */
  if (hour >= 5 && hour < 12) return t('greeting.morning', 'শুভ সকাল');
  if (hour >= 12 && hour < 16) return t('greeting.noon', 'শুভ দুপুর');
  if (hour >= 16 && hour < 18) return t('greeting.afternoon', 'শুভ বিকাল');
  if (hour >= 18 && hour < 21) return t('greeting.evening', 'শুভ সন্ধ্যা');
  return t('greeting.night', 'শুভ রাত্রি');
}

/**
 * The part of a name a greeting should use.
 *
 * First word only, because a full legal name in a greeting reads like a
 * summons — but *not* when the first word is an initial. `S M MEJBA UL HAQUE`
 * greeted somebody as "S", which is not a name, it is a letter. Bangladeshi
 * names carry initials constantly: `S M`, `Md.`, `A K M`, `S.M.` written solid.
 *
 * So initials are skipped until a real word turns up, and the honorific
 * prefixes people write in front of their names go with them — `Md. Karim`
 * should say Karim. If the whole name is initials there is nothing better to
 * fall back to than the whole name.
 */
const HONORIFICS = new Set(['md', 'mst', 'mt', 'mr', 'mrs', 'ms', 'dr', 'engr', 'prof']);

/** `S`, `S.`, `S.M.`, `মো:` — a token with no word in it. */
function isInitial(token: string): boolean {
  const letters = token.replace(/[.-]/g, '');
  return letters.length <= 2 && !/\d/.test(letters);
}

export function firstNameOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';

  const real = words.find(
    (word) => !isInitial(word) && !HONORIFICS.has(word.replace(/[.-]/g, '').toLowerCase()),
  );
  /* Nothing but initials — `S M K` — so the whole thing is the best there is.
     Greeting somebody by one arbitrary letter of their own name is worse. */
  return real ?? words.join(' ');
}

export function useGreeting(): { greeting: string; name: string } {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: endpoints.me,
    staleTime: 5 * 60_000,
    retry: false,
    networkMode: 'always',
  });

  /* Computed after mount, never during render: the server has no idea what
   * time it is where the reader is, so rendering a greeting on the server and
   * a different one in the browser would be a hydration mismatch. */
  const [greeting, setGreeting] = React.useState('');
  React.useEffect(() => {
    setGreeting(greetingFor(new Date()));
    // Re-check on the hour, so a screen left open overnight is not still
    // wishing somebody a good afternoon.
    const timer = setInterval(() => setGreeting(greetingFor(new Date())), 10 * 60_000);
    return () => clearInterval(timer);
  }, []);

  return { greeting, name: firstNameOf(me.data?.name ?? '') };
}
