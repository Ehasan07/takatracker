'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Settings } from 'lucide-react';
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
export function AccountMenu({ collapsed = false }: { collapsed?: boolean }) {
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
        className={cn(
          'press border-rule hover:bg-greenbar flex min-h-11 w-full items-center gap-2 rounded-md border px-2 text-left',
          collapsed && 'justify-center',
        )}
      >
        <span
          aria-hidden
          className="bg-greenbar text-income flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
        >
          {initial}
        </span>
        {!collapsed ? (
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
          className="border-rule bg-surface absolute bottom-full left-0 z-40 mb-2 w-full min-w-52 overflow-hidden rounded-md border shadow-lg"
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

/** First name only — a full legal name in a greeting reads like a summons. */
export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
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
