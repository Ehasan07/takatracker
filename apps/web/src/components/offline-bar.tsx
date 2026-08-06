'use client';

import { useQueryClient } from '@tanstack/react-query';
import { CloudOff } from 'lucide-react';
import * as React from 'react';
import { toBengaliDigits } from '@hishab/shared';
import { flushQueue, listQueued, onQueueChange } from '@/lib/offline-queue';

/** "অফলাইন — ৩টি পরিবর্তন অপেক্ষমাণ" (spec §5). */
export function OfflineBar() {
  const [online, setOnline] = React.useState(true);
  const [pending, setPending] = React.useState(0);
  const queryClient = useQueryClient();

  const refreshCount = React.useCallback(async () => {
    setPending((await listQueued()).length);
  }, []);

  React.useEffect(() => {
    setOnline(navigator.onLine);
    void refreshCount();

    const handleOnline = (): void => {
      setOnline(true);
      void (async () => {
        const { sent } = await flushQueue();
        await refreshCount();
        if (sent > 0) await queryClient.invalidateQueries();
      })();
    };
    const handleOffline = (): void => setOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    const unsubscribe = onQueueChange(() => void refreshCount());

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      unsubscribe();
    };
  }, [queryClient, refreshCount]);

  if (online && pending === 0) return null;

  return (
    <div
      role="status"
      data-testid="offline-bar"
      className="border-brass/40 bg-brass/10 text-ink flex items-center gap-2 border-b px-3 py-2 text-sm"
    >
      <CloudOff className="h-4 w-4 shrink-0" aria-hidden />
      <span>
        {online ? 'সংযোগ ফিরেছে' : 'অফলাইন'}
        {pending > 0 ? ` — ${toBengaliDigits(String(pending))}টি পরিবর্তন অপেক্ষমাণ` : ''}
      </span>
    </div>
  );
}
