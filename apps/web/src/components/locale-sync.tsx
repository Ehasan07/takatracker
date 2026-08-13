'use client';

import { useQuery } from '@tanstack/react-query';
import * as React from 'react';
import { endpoints } from '@/lib/api';
import { getActiveLocale, setActiveLocale } from '@/lib/format';

/**
 * Keep the formatters' locale in step with the workspace's, and keep the
 * `<html lang>` honest.
 *
 * Renders nothing. It exists because `lib/format.ts` holds the locale in a
 * module variable — see the reasoning there — and something has to put the
 * server's answer into it.
 *
 * ## Why it can force a reload
 *
 * Nothing subscribes to that variable, so a component already on screen will
 * not re-render when it changes. Almost always it does not change: the value
 * was seeded from localStorage before the first paint and `/auth/me` agrees.
 * The two cases where it does are a first sign-in on a device, and signing in
 * as somebody whose workspace reads the other language — and in both, half the
 * screen would otherwise be formatted with the previous reader's digits until
 * the next navigation.
 *
 * The settings switch does its own reload, so this path is only the fallback
 * for a locale that arrived from somewhere other than that button.
 */
export function LocaleSync() {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: endpoints.me,
    staleTime: 5 * 60_000,
    retry: false,
    networkMode: 'always',
  });

  const workspaceLocale = (me.data as { workspace?: { locale?: string | null } } | undefined)
    ?.workspace?.locale;

  React.useEffect(() => {
    if (workspaceLocale !== 'bn' && workspaceLocale !== 'en') return;

    document.documentElement.lang = workspaceLocale;

    /* `setActiveLocale` reports whether it actually changed anything. On the
       overwhelmingly common path it did not, and nothing further happens. */
    if (!setActiveLocale(workspaceLocale)) return;

    /* Guard against a reload loop: if storage is unwritable — private mode —
       the seed on the next load reverts and this would fire again, forever.
       Reading it back proves the next load will start from the new value. */
    let persisted = false;
    try {
      persisted = window.localStorage.getItem('hishab.locale') === workspaceLocale;
    } catch {
      persisted = false;
    }
    if (persisted && getActiveLocale() === workspaceLocale) window.location.reload();
  }, [workspaceLocale]);

  return null;
}
