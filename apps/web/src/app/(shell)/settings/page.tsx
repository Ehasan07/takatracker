'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { api, endpoints } from '@/lib/api';
import { resetSessionForSignOut } from '@/lib/session-reset';
import { UsageMeter } from '@/components/usage-meter';
import { SessionsList } from '@/components/sessions-list';
import { TelegramSettings } from '@/components/telegram-settings';
import { Money } from '@/components/money';
import { Button } from '@/components/ui/button';

export default function SettingsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: endpoints.me });
  const entitlements = useQuery({ queryKey: ['entitlements'], queryFn: endpoints.entitlements });
  const [theme, setTheme] = React.useState<'system' | 'light' | 'dark'>('system');

  React.useEffect(() => {
    const stored = (localStorage.getItem('hishab.theme') as typeof theme | null) ?? 'system';
    setTheme(stored);
    applyTheme(stored);
  }, []);

  const applyTheme = (next: 'system' | 'light' | 'dark'): void => {
    const root = document.documentElement;
    root.classList.remove('dark', 'light');
    if (next !== 'system') root.classList.add(next);
  };

  const changeTheme = (next: 'system' | 'light' | 'dark'): void => {
    setTheme(next);
    localStorage.setItem('hishab.theme', next);
    applyTheme(next);
  };

  const logout = async (): Promise<void> => {
    await api('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    /* After the token is dead so a racing tab cannot refill the cache, and
     * before navigating so nothing survives into /login. Without this the
     * service worker keeps serving the previous person's balances offline on a
     * shared phone. */
    await resetSessionForSignOut(queryClient);
    router.push('/login');
    router.refresh();
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <h1 className="text-ink hidden text-xl font-semibold sm:text-2xl md:block">সেটিংস</h1>

      <section className="rounded-card border-rule bg-surface border p-4">
        <h2 className="text-ink-muted text-sm font-medium">অ্যাকাউন্ট</h2>
        <p className="text-ink mt-1">{me.data?.name}</p>
        <p className="text-ink-muted text-sm">{me.data?.email}</p>
      </section>

      <section className="rounded-card border-rule bg-surface border p-4">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-ink-muted text-sm font-medium">প্ল্যান</h2>
          <span className="text-ink text-sm font-semibold">
            {entitlements.data?.plan?.name ?? '—'}
          </span>
        </div>
        {entitlements.data?.plan && entitlements.data.plan.priceMinor > 0 ? (
          <p className="text-ink-muted mt-1 text-xs">
            <Money minor={entitlements.data.plan.priceMinor} className="inline" decimals={false} />{' '}
            / মাস
          </p>
        ) : null}

        <div className="mt-3 flex flex-col gap-3">
          <UsageMeter
            label="অ্যাকাউন্ট"
            used={entitlements.data?.usage['accounts.max'] ?? 0}
            limit={entitlements.data?.entitlements['accounts.max'] ?? null}
          />
          <UsageMeter
            label="এই মাসের লেনদেন"
            used={entitlements.data?.usage['transactions.monthly.max'] ?? 0}
            limit={entitlements.data?.entitlements['transactions.monthly.max'] ?? null}
          />
          <UsageMeter
            label="সদস্য"
            used={entitlements.data?.usage['members.max'] ?? 0}
            limit={entitlements.data?.entitlements['members.max'] ?? null}
          />
        </div>
      </section>

      <section className="rounded-card border-rule bg-surface border p-4">
        <h2 className="text-ink-muted text-sm font-medium">খাত ব্যবস্থাপনা</h2>
        <p className="text-ink-muted mt-1 text-sm">আয় ও খরচের খাত যোগ করুন, নাম বদলান, মুছুন।</p>
        <Link
          href="/categories"
          className="press bg-income mt-3 inline-flex min-h-11 items-center rounded-md px-4 text-sm font-medium text-white"
        >
          ক্যাটাগরি দেখুন
        </Link>
      </section>

      <TelegramSettings />

      <SessionsList />

      <section className="rounded-card border-rule bg-surface border p-4">
        <h2 className="text-ink-muted text-sm font-medium">থিম</h2>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {(['system', 'light', 'dark'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => changeTheme(option)}
              aria-pressed={theme === option}
              className={
                theme === option
                  ? 'border-income bg-greenbar text-income min-h-11 rounded-md border text-sm font-semibold'
                  : 'border-rule text-ink min-h-11 rounded-md border text-sm'
              }
            >
              {option === 'system' ? 'সিস্টেম' : option === 'light' ? 'আলো' : 'অন্ধকার'}
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-card border-rule bg-surface border p-4">
        <h2 className="text-ink-muted text-sm font-medium">পরের ধাপ</h2>
        <ul className="text-ink-muted mt-2 list-disc pl-5 text-sm">
          <li>রিপোর্ট ও এক্সেল ইমপোর্ট (M5–M6)</li>
          <li>ড্রাফট ইনবক্স ও বার্তা থেকে স্বয়ংক্রিয় লেনদেন (M7–M11)</li>
          <li>ধার-দেনা, ডিপিএস, বীমা (M12–M14)</li>
        </ul>
      </section>

      <Button variant="outline" onClick={() => void logout()}>
        লগআউট
      </Button>
    </div>
  );
}
