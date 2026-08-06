'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { api, endpoints } from '@/lib/api';
import { Button } from '@/components/ui/button';

export default function SettingsPage() {
  const router = useRouter();
  const me = useQuery({ queryKey: ['me'], queryFn: endpoints.me });
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
