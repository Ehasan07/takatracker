'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from '@/components/icons';
import * as React from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { haptic } from '@/lib/haptics';
import { t } from '@/lib/t';

/**
 * Letting a model read your messages to fill in two fields.
 *
 * ## Why it is a switch and not a default
 *
 * The parser can read an amount out of a bank alert; it can never know that
 * "স্বপ্ন" is groceries or that a message naming a school is education. A model
 * can, and drafts arrive filled in rather than half empty.
 *
 * The cost is that the text of somebody's bank SMS leaves this server and
 * reaches a third party. That is a decision for the person whose messages they
 * are — so it is off until they say otherwise, and the copy says plainly what
 * turning it on does rather than describing it as "smart suggestions".
 *
 * ## What it does not do
 *
 * It never touches an amount, a date or a direction, and it never accepts a
 * draft. Those are arithmetic and consent; this is a guess about which label
 * fits, and a guess is all it is allowed to be.
 */

interface Settings {
  aiSuggestEnabled: boolean;
}

export function AiSettings() {
  const queryClient = useQueryClient();

  const settings = useQuery({
    queryKey: ['workspace', 'settings'],
    queryFn: () => api<Settings>('/workspace/settings'),
    staleTime: 60_000,
  });

  const save = useMutation({
    mutationFn: (aiSuggestEnabled: boolean) =>
      api<Settings>('/workspace/settings', { method: 'PATCH', body: { aiSuggestEnabled } }),
    onSuccess: () => {
      haptic('tap');
      void queryClient.invalidateQueries({ queryKey: ['workspace', 'settings'] });
    },
  });

  const on = settings.data?.aiSuggestEnabled ?? false;

  return (
    <section className="rounded-card border-rule bg-surface border-[1.5px] p-4">
      <h2 className="text-ink-muted flex items-center gap-2 text-sm font-medium">
        <Sparkles className="text-brand h-4 w-4" aria-hidden />
        {t('ai.title', 'AI দিয়ে খাত বেছে দেওয়া')}
      </h2>

      <p className="text-ink-muted mt-1 text-sm">
        {t(
          'ai.blurb',
          'বার্তা পড়ে খসড়ায় খাত আর অ্যাকাউন্ট আগে থেকে বসিয়ে দেবে। টাকার অঙ্ক, তারিখ বা দিক কখনো বদলাবে না, আর আপনি না বললে খাতায় কিছুই উঠবে না।',
        )}
      </p>

      {/* The cost, in the same size type as the benefit. Somebody deciding
          should not have to find this in a policy page afterwards. */}
      <p className="text-ink-muted mt-2 text-xs">
        {t(
          'ai.privacy',
          'চালু করলে আপনার বার্তার লেখা আমাদের সার্ভারের বাইরে একটি AI সেবায় যাবে — শুধু বার্তা আর আপনার খাত-অ্যাকাউন্টের নাম, কোনো ব্যালেন্স বা অন্য লেনদেন নয়।',
        )}
      </p>

      <Button
        variant="outline"
        className="mt-3"
        disabled={save.isPending || settings.isLoading}
        aria-pressed={on}
        onClick={() => save.mutate(!on)}
      >
        {on ? t('ai.turnOff', 'বন্ধ করুন') : t('ai.turnOn', 'চালু করুন')}
      </Button>

      {on ? (
        <p className="text-ink-muted mt-2 text-xs">
          {t('ai.onNow', 'চালু আছে। খসড়ায় লেখা থাকবে কোনগুলো AI বেছে দিয়েছে।')}
        </p>
      ) : null}
    </section>
  );
}
