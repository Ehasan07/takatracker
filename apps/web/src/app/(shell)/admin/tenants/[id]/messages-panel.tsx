'use client';

import { useQuery } from '@tanstack/react-query';
import { MessageSquareText } from '@/components/icons';
import * as React from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { adminKeys } from '../../queries';
import type { TenantMessages } from '../../types';

/**
 * What a tenant's phone forwarded, and what this product made of it.
 *
 * ## Why it exists
 *
 * The parsers are the part of this product most likely to be quietly wrong. A
 * bank rewords its alert and every customer on that bank stops getting drafts,
 * with nothing on any screen to say so — the messages still arrive, they simply
 * stop being understood. The only way to see that is to look at what came in
 * beside what was read out of it, which is what this panel is.
 *
 * The three counts are the answer at a glance:
 *
 * - **পড়া গেছে** — a draft with an amount. Working.
 * - **পড়া যায়নি** — looked like money, produced nothing. A parser to fix, and
 *   the only number here worth acting on.
 * - **টাকার নয়** — never about money. Correctly ignored.
 *
 * ## Why it is behind a press
 *
 * Same reason as the finance panel, only more so. These are the customer's SMS
 * as their phone received them: a phone forwarding everything forwards one-time
 * codes and private conversation along with the bank alerts. Every fetch writes
 * an audit row under its own action, so a panel that loaded with the page would
 * file "read their messages" on every routine visit and the log would stop
 * meaning anything.
 */
export function MessagesPanel({ workspaceId }: { workspaceId: string }) {
  const [asked, setAsked] = React.useState(false);

  const messages = useQuery({
    queryKey: adminKeys.messages(workspaceId),
    queryFn: () => api<TenantMessages>(`/admin/tenants/${workspaceId}/messages`),
    enabled: asked,
    /* Never silently refetched: every fetch is an audited read of somebody's
       private messages, so a background refresh would write rows nobody asked
       for and could not account for. */
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const data = messages.data;

  return (
    <section className="rounded-card border-rule bg-surface border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-ink-muted text-sm font-medium">ফোন থেকে আসা বার্তা</h2>
        {data ? (
          <span className="text-ink-muted text-xs">সর্বশেষ {data.messages.length}টি</span>
        ) : null}
      </div>

      {!asked ? (
        <>
          <p className="text-ink-muted mt-1 text-sm">
            পার্সার ব্যাংকের ছাঁচ ধরতে পারছে কিনা দেখার জন্য। গ্রাহকের বার্তাগুলো হুবহু দেখা যাবে —
            ওটিপি আর ব্যক্তিগত বার্তাসহ, কারণ ফোন সবই পাঠায়।
          </p>
          <p className="text-ink-muted mt-1 text-xs">
            দেখলে কার্যবিবরণীতে আপনার নামে রেকর্ড থাকবে।
          </p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => setAsked(true)}>
            <MessageSquareText className="h-4 w-4" aria-hidden />
            বার্তাগুলো দেখুন
          </Button>
        </>
      ) : messages.isError ? (
        <p className="text-ink-muted mt-2 text-sm">বার্তা আনা যায়নি।</p>
      ) : messages.isLoading ? (
        <p className="text-ink-muted mt-2 text-sm">আনা হচ্ছে…</p>
      ) : !data || data.messages.length === 0 ? (
        <p className="text-ink-muted mt-2 text-sm">এই ওয়ার্কস্পেস থেকে কোনো বার্তা আসেনি।</p>
      ) : (
        <>
          {/* The counts first, because they are the reason to open this at all.
              `পড়া যায়নি` is the one worth acting on. */}
          <dl className="border-rule mt-3 grid grid-cols-3 gap-3 border-y py-3">
            <Count label="পড়া গেছে" value={data.summary.parsed} />
            <Count
              label="পড়া যায়নি"
              value={data.summary.unread}
              strong={data.summary.unread > 0}
            />
            <Count label="টাকার নয়" value={data.summary.ignored} />
          </dl>

          <ul className="divide-rule mt-2 divide-y">
            {data.messages.map((row) => (
              <li key={row.id} className="py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-ink text-sm font-medium">{row.sender || row.channel}</span>
                  <span className="text-ink-muted text-xs">{row.receivedAt.slice(0, 16)}</span>
                </div>
                <p className="text-ink-muted mt-1 whitespace-pre-wrap break-words text-sm">
                  {row.body}
                </p>
                <p className="text-ink-muted mt-1 text-xs">
                  {row.outcome === 'PARSED'
                    ? `পড়া গেছে · ${row.parserName ?? '—'} · আত্মবিশ্বাস ${row.confidence ?? 0}`
                    : row.outcome === 'UNREAD'
                      ? 'টাকার বার্তা, কিন্তু পার্সার কিছু পায়নি'
                      : 'টাকার বার্তা নয়'}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Count({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-muted text-xs">{label}</dt>
      <dd
        className={strong ? 'text-expense text-lg font-semibold' : 'text-ink text-lg font-semibold'}
      >
        {value}
      </dd>
    </div>
  );
}
