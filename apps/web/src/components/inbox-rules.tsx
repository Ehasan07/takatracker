'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Filter, Trash2 } from '@/components/icons';
import * as React from 'react';
import { api } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { t } from '@/lib/t';

/**
 * The shapes this inbox has been taught to stop asking about.
 *
 * ## Why the list exists at all
 *
 * Rejecting a draft as "এই লেনদেন আমার নয়" or "ভুলভাবে পড়া হয়েছে" now teaches
 * the inbox to leave that *shape* of message alone — twenty-four one-time codes
 * from one shortcode stop being twenty-four decisions. That is a real
 * improvement and it is also the app acting on somebody's behalf, quietly,
 * forever. So it is listed: what was learned, from which sender, how many
 * messages it has kept out since, and a button to undo it.
 *
 * A rule with no way back is not a feature, it is a trap — the day a bank
 * changes its wording and a real alert happens to fold to a shape somebody
 * rejected last year, this screen is the only place that can say so.
 *
 * ## What removing one does, and does not
 *
 * From then on, that shape asks again. The messages it already suppressed are
 * left alone: they are stored, they are on the messages tab, and re-raising
 * decisions about mail from last month because a rule was removed today would
 * be a surprise nobody asked for.
 */
interface Rule {
  id: string;
  sender: string;
  reason: string;
  sample: string;
  matchCount: number;
  lastMatchAt: string | null;
  createdAt: string;
}

const REASON: Record<string, string> = {
  NOT_MINE: 'এটি আমার লেনদেন নয়',
  BAD_PARSE: 'ভুলভাবে পড়া হয়েছে',
};

export function InboxRules() {
  const queryClient = useQueryClient();

  const rules = useQuery({
    queryKey: ['ingestion', 'rules'],
    queryFn: () => api<Rule[]>('/ingestion/rules'),
    staleTime: 60_000,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/ingestion/rules/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      haptic('tap');
      void queryClient.invalidateQueries({ queryKey: ['ingestion', 'rules'] });
    },
  });

  const list = rules.data ?? [];

  /* Nothing to show and nothing to explain: a workspace that has never rejected
     a message has never taught one, and a heading over an empty box is a
     feature announcing itself to somebody who has not met it. */
  if (rules.isSuccess && list.length === 0) return null;

  return (
    <section className="rounded-card border-rule bg-surface border p-4">
      <h2 className="text-ink-muted flex items-center gap-2 text-sm font-medium">
        <Filter className="text-brand h-4 w-4" aria-hidden />
        {t('rules.title', 'যেসব বার্তা আর জিজ্ঞেস করা হবে না')}
      </h2>
      <p className="text-ink-muted mt-1 text-sm">
        {t(
          'rules.blurb',
          'আপনি যেসব বার্তাকে “আমার লেনদেন নয়” বা “ভুলভাবে পড়া হয়েছে” বলেছেন, সেরকম বার্তা এলে আর খসড়া তৈরি হয় না। বার্তাগুলো মুছে যায় না — বার্তা তালিকায় থেকে যায়।',
        )}
      </p>

      <ul className="mt-3 flex flex-col gap-2">
        {list.map((rule) => (
          <li key={rule.id} className="border-rule flex items-start gap-2 rounded-md border p-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-ink text-sm font-medium">{rule.sender}</p>
              {/* The message it was taught by. A rule is a fold of a sentence
                  and unreadable on its own; without this the list would be a
                  column of senders and a number. */}
              <p className="text-ink-muted mt-0.5 break-words text-xs">{rule.sample}</p>
              <p className="text-ink-muted mt-1 text-xs">
                {REASON[rule.reason] ?? rule.reason}
                {rule.matchCount > 0
                  ? ` · ${t('rules.kept', '{n}টি বার্তা আটকেছে').replace(
                      '{n}',
                      String(rule.matchCount),
                    )}`
                  : ''}
              </p>
            </div>
            <button
              type="button"
              aria-label={`${rule.sender} — ${t('rules.remove', 'নিয়মটি সরান')}`}
              title={t('rules.remove', 'নিয়মটি সরান')}
              disabled={remove.isPending}
              onClick={() => remove.mutate(rule.id)}
              className="press touch-target text-ink-muted hover:bg-greenbar hover:text-expense flex shrink-0 items-center justify-center rounded-md disabled:opacity-60"
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
