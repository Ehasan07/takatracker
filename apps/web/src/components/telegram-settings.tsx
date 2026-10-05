'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, Send, Unplug } from '@/components/icons';
import * as React from 'react';
import { api } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { Button } from './ui/button';
import { Field, Input } from './ui/field';

interface TelegramStatus {
  configured: boolean;
  botUsername: string | null;
  connection: {
    status: string;
    mode: string;
    isEnabled: boolean;
    verifiedAt: string | null;
    chatIdMasked: string | null;
    lastSentAt: string | null;
    lastError: string | null;
  } | null;
  leadDays: number;
  autoMuteOnPayment: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  PENDING: 'অপেক্ষমাণ',
  ACTIVE: 'সচল',
  AUTH_FAILED: 'সংযোগ ব্যর্থ',
  DISABLED: 'বন্ধ',
  REVOKED: 'বাতিল',
};

/**
 * One button to connect. No BotFather, no token to paste — the user taps a deep
 * link, presses Start, and Telegram tells us their chat. Nothing secret is ever
 * typed into this screen.
 */
export function TelegramSettings() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = React.useState<string | null>(null);

  const status = useQuery({
    queryKey: ['telegram'],
    queryFn: () => api<TelegramStatus>('/notifications/telegram'),
    refetchInterval: (query) =>
      // While a binding is in flight, poll so the screen updates the moment
      // the user presses Start in Telegram.
      query.state.data?.connection && !query.state.data.connection.verifiedAt ? 3000 : false,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['telegram'] });

  const bind = useMutation({
    mutationFn: () => api<{ url: string }>('/notifications/telegram/bind', { method: 'POST' }),
    onSuccess: (data) => {
      haptic('select');
      window.open(data.url, '_blank', 'noopener');
      setNotice('টেলিগ্রাম খুলেছে — সেখানে Start চাপুন।');
      invalidate();
    },
  });

  const test = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; message: string }>('/notifications/telegram/test', { method: 'POST' }),
    onSuccess: (data) => {
      haptic(data.ok ? 'success' : 'warn');
      setNotice(data.message);
      invalidate();
    },
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      api('/notifications/telegram/enabled', { method: 'POST', body: { enabled } }),
    onSuccess: invalidate,
  });

  const settings = useMutation({
    mutationFn: (body: { leadDays?: number; autoMuteOnPayment?: boolean }) =>
      api('/notifications/telegram/settings', { method: 'POST', body }),
    onSuccess: invalidate,
  });

  const disconnect = useMutation({
    mutationFn: () => api('/notifications/telegram', { method: 'DELETE' }),
    onSuccess: () => {
      setNotice('সংযোগ বিচ্ছিন্ন হয়েছে');
      invalidate();
    },
  });

  const data = status.data;
  const connection = data?.connection ?? null;
  const linked = Boolean(connection?.verifiedAt);

  return (
    <section className="rounded-card border-rule bg-surface border-[1.5px] p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-ink text-lg font-bold">টেলিগ্রাম নোটিফিকেশন</h2>
        {connection ? (
          <span className="text-ink-muted text-xs">
            {STATUS_LABEL[connection.status] ?? connection.status}
          </span>
        ) : null}
      </div>

      {data && !data.configured ? (
        <p className="text-brass mt-2 text-sm">সার্ভারে বট এখনো কনফিগার করা হয়নি।</p>
      ) : !linked ? (
        <>
          <p className="text-ink-muted mt-2 text-sm">
            ক্রেডিট কার্ডের পেমেন্টের তারিখের আগে টেলিগ্রামে মনে করিয়ে দেব। এক ট্যাপেই সংযুক্ত হবে
            — কোনো টোকেন বা আইডি লিখতে হবে না।
          </p>
          <Button
            className="mt-3"
            onClick={() => bind.mutate()}
            disabled={bind.isPending || !data?.configured}
          >
            <ExternalLink className="h-4 w-4" aria-hidden />
            টেলিগ্রামে সংযুক্ত করুন
          </Button>
          {connection && !connection.verifiedAt ? (
            <p className="text-ink-muted mt-2 text-xs">
              টেলিগ্রামে <strong>Start</strong> চাপার অপেক্ষায়…
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p className="text-income mt-2 flex items-center gap-1.5 text-sm">
            <Check className="h-4 w-4" aria-hidden />
            সংযুক্ত ({connection?.chatIdMasked})
          </p>

          <label className="mt-3 flex min-h-11 items-center justify-between gap-3">
            <span className="text-ink text-sm">নোটিফিকেশন চালু</span>
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={connection?.isEnabled ?? false}
              onChange={(e) => toggle.mutate(e.target.checked)}
            />
          </label>

          <Field className="mt-3" label="কত দিন আগে থেকে মনে করাব" htmlFor="tg-lead">
            <Input
              id="tg-lead"
              type="number"
              min={1}
              max={28}
              defaultValue={data?.leadDays ?? 7}
              inputMode="numeric"
              onBlur={(e) => {
                const leadDays = Number(e.target.value);
                if (Number.isInteger(leadDays) && leadDays >= 1 && leadDays <= 28) {
                  settings.mutate({ leadDays });
                }
              }}
            />
          </Field>

          <label className="mt-3 flex min-h-11 items-center justify-between gap-3">
            <span className="text-ink text-sm">পেমেন্ট লিখলে ওই মাসের রিমাইন্ডার বন্ধ</span>
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={data?.autoMuteOnPayment ?? true}
              onChange={(e) => settings.mutate({ autoMuteOnPayment: e.target.checked })}
            />
          </label>

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => test.mutate()}
              disabled={test.isPending}
            >
              <Send className="h-4 w-4" aria-hidden />
              পরীক্ষা করুন
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
            >
              <Unplug className="h-4 w-4" aria-hidden />
              সংযোগ বিচ্ছিন্ন করুন
            </Button>
          </div>
        </>
      )}

      {connection?.lastError ? (
        <p className="text-expense mt-2 text-xs">শেষ ত্রুটি: {connection.lastError}</p>
      ) : null}
      {notice ? (
        <p role="status" className="text-ink-muted mt-2 text-xs">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
