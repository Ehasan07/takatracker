'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  BadgeCheck,
  Bell,
  ChevronRight,
  Database,
  FileUp,
  HandCoins,
  Inbox,
  KeyRound,
  LifeBuoy,
  Lock,
  Paperclip,
  PiggyBank,
  Receipt,
  ScrollText,
  ShieldCheck,
  Tags,
  Wallet,
  X,
} from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { SkeletonRows } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { endpoints } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { ChangeBlock, type NameResolver } from './diff';
import {
  ACTION_GROUPS,
  actionFamily,
  actionLabel,
  actorLabel,
  bnNum,
  bnTime,
  dayHeading,
  dayKey,
  entityLabel,
  ipIsTrustworthy,
  isAlarming,
  shortId,
} from './labels';
import { QueryError } from './parts';
import { auditKeys, fetchAudit } from './queries';
import type { AuditEvent } from './types';

const FAMILY_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  auth: KeyRound,
  account: Wallet,
  transaction: Receipt,
  category: Tags,
  attachment: Paperclip,
  import: FileUp,
  export: FileUp,
  data: Database,
  ingestion: Inbox,
  loan: HandCoins,
  savings: PiggyBank,
  insurance: ShieldCheck,
  plan: BadgeCheck,
  entitlement: BadgeCheck,
  notifications: Bell,
  card: Bell,
  workspace: Database,
  support: LifeBuoy,
};

/**
 * Where a row can send you.
 *
 * Only a loan has a screen of its own. Transactions and accounts have list
 * screens but no per-record route and no way to focus one from the URL, so
 * linking there would land the user on a page that does not show the record
 * the line is about — worse than not linking at all. A deleted loan is left
 * unlinked for the same reason: its page would only say it is gone.
 */
function recordHref(event: AuditEvent): string | null {
  if (event.action === 'loan.deleted') return null;
  if (event.entity === 'Loan' && event.entityId) return `/loans/${event.entityId}`;
  if (event.entity === 'LoanPayment') {
    const loanId = event.after?.loanId ?? event.before?.loanId;
    if (typeof loanId === 'string' && loanId !== '') return `/loans/${loanId}`;
  }
  return null;
}

export default function AuditPage() {
  const [action, setAction] = React.useState('');
  const [entityId, setEntityId] = React.useState('');

  const filters = React.useMemo(
    () => ({ action: action || undefined, entityId: entityId || undefined }),
    [action, entityId],
  );

  const log = useInfiniteQuery({
    queryKey: auditKeys.list(filters),
    queryFn: ({ pageParam }) => fetchAudit(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  /* Names for the ids inside `before`/`after`. Decoration, not content: if
   * either list fails the diff still renders, with the tail of the id where a
   * name would have been. So neither one gets an error state of its own. */
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });
  const categories = useQuery({ queryKey: ['categories'], queryFn: endpoints.categories });

  const resolve: NameResolver = React.useMemo(() => {
    const accountNames = new Map((accounts.data ?? []).map((a) => [a.id, a.name]));
    const categoryNames = new Map(
      (categories.data ?? []).map((c) => [c.id, c.nameBn ?? c.name] as const),
    );
    return {
      account: (id) => accountNames.get(id),
      category: (id) => categoryNames.get(id),
    };
  }, [accounts.data, categories.data]);

  const rows = React.useMemo(
    () => (log.data?.pages ?? []).flatMap((page) => page.items),
    [log.data],
  );

  // Grouped by the Dhaka day, so the log reads like a diary. The API already
  // returns newest first, so insertion order is the order we want.
  const days = React.useMemo(() => {
    const map = new Map<string, AuditEvent[]>();
    for (const row of rows) {
      const key = dayKey(row.createdAt);
      const bucket = map.get(key);
      if (bucket) bucket.push(row);
      else map.set(key, [row]);
    }
    return [...map.entries()];
  }, [rows]);

  const filtered = action !== '' || entityId !== '';

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="flex items-baseline justify-between gap-2">
        <h1 className="text-ink hidden text-xl font-semibold sm:text-2xl md:block">কার্যবিবরণী</h1>
        {rows.length > 0 ? (
          <span className="text-ink-muted ml-auto text-xs">{bnNum(rows.length)}টি ঘটনা</span>
        ) : null}
      </header>

      {/* Said once, plainly. A log the reader believes could have been tidied up
          afterwards is worth nothing to them. */}
      <p className="rounded-card border-rule bg-surface text-ink-muted flex items-start gap-2 border p-3 text-xs">
        <Lock className="text-income mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>
          এই তালিকায় শুধু নতুন লাইন <span className="text-ink font-medium">যোগ</span> হয়। কোনো
          লাইন বদলানোর বা মোছার কোনো ব্যবস্থাই সার্ভারে নেই — তাই এখানে যা লেখা আছে, ঠিক তা-ই ঘটেছে।
        </span>
      </p>

      <Select
        aria-label="কোন ধরনের ঘটনা"
        value={action}
        onChange={(e) => setAction(e.target.value)}
      >
        <option value="">সব ধরনের ঘটনা</option>
        {ACTION_GROUPS.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.actions.map((value) => (
              <option key={value} value={value}>
                {actionLabel(value)}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>

      {entityId ? (
        <div className="border-rule bg-greenbar flex min-h-11 items-center gap-2 rounded-md border px-3">
          <span className="text-ink min-w-0 flex-1 truncate text-xs">
            একটি রেকর্ডের ঘটনা দেখানো হচ্ছে ({shortId(entityId)})
          </span>
          <button
            type="button"
            onClick={() => {
              haptic('tap');
              setEntityId('');
            }}
            aria-label="এই রেকর্ডের ফিল্টার সরান"
            className="press touch-target text-ink-muted hover:bg-surface -mr-2 flex items-center justify-center rounded-md"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : null}

      {log.isError ? (
        <QueryError message="কার্যবিবরণী আনা যায়নি।" onRetry={() => void log.refetch()} />
      ) : log.isLoading ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border">
          <SkeletonRows rows={6} />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-card border-rule border border-dashed p-8 text-center">
          <ScrollText className="text-ink-muted mx-auto h-6 w-6" aria-hidden />
          <p className="text-ink mt-2">
            {filtered ? 'এই ফিল্টারে কোনো ঘটনা নেই।' : 'এখনও কিছু রেকর্ড হয়নি।'}
          </p>
          <p className="text-ink-muted mt-1 text-sm">
            {filtered
              ? 'উপরের ফিল্টার বদলে দেখুন।'
              : 'লেনদেন, অ্যাকাউন্ট বা ঋণে কিছু করলে তা এখানে জমা হবে।'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {days.map(([key, events]) => (
            <section key={key} className="flex flex-col gap-2">
              <h2 className="text-ink-muted text-xs font-medium">{dayHeading(key)}</h2>
              <ul className="flex flex-col gap-2">
                {events.map((event) => (
                  <li key={event.id}>
                    <Row
                      event={event}
                      resolve={resolve}
                      onFilterRecord={
                        entityId === '' && event.entityId
                          ? () => setEntityId(event.entityId ?? '')
                          : undefined
                      }
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {log.hasNextPage ? (
            <Button
              variant="outline"
              disabled={log.isFetchingNextPage}
              onClick={() => void log.fetchNextPage()}
            >
              {log.isFetchingNextPage ? 'আনা হচ্ছে…' : 'আরও পুরনো ঘটনা দেখুন'}
            </Button>
          ) : (
            <p className="text-ink-muted py-2 text-center text-xs">এটুকুই — আর কিছু নেই।</p>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  event,
  resolve,
  onFilterRecord,
}: {
  event: AuditEvent;
  resolve: NameResolver;
  onFilterRecord?: () => void;
}) {
  const Icon = FAMILY_ICON[actionFamily(event.action)] ?? ScrollText;
  const href = recordHref(event);
  const alarming = isAlarming(event.action);
  const entity = entityLabel(event.entity);

  return (
    <article className="rounded-card border-rule bg-surface min-w-0 border p-3.5">
      <div className="flex min-w-0 items-start gap-3">
        <span
          className={cn(
            'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
            alarming ? 'bg-expense/10 text-expense' : 'bg-greenbar text-income',
          )}
        >
          <Icon className="h-4 w-4" aria-hidden />
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-ink text-sm font-medium">{actionLabel(event.action)}</p>
          <p className="text-ink-muted truncate text-xs">
            {actorLabel(event.actor, event.actorType, event.action)}
            {entity ? ` · ${entity}` : ''}
          </p>
        </div>

        <span className="text-ink-muted money shrink-0 text-xs">{bnTime(event.createdAt)}</span>
      </div>

      <ChangeBlock event={event} resolve={resolve} />

      {event.ip ? (
        <p className="text-ink-muted mt-2 break-all text-[11px]">
          {/* Latin digits on purpose: an IP is an identifier to be compared and
              copied, not a quantity to be read — the same reason a loan number
              is printed as it was issued. */}
          আইপি {event.ip}
          {ipIsTrustworthy(event.createdAt) ? null : (
            <span className="text-brass"> · প্রক্সির নিজের ঠিকানা, ব্যবহারকারীর নয়</span>
          )}
        </p>
      ) : null}

      {href || onFilterRecord ? (
        <div className="border-rule mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-2">
          {href ? (
            <Link
              href={href}
              onClick={() => haptic('tap')}
              className="press text-income inline-flex min-h-11 items-center gap-1 text-xs font-medium md:min-h-9"
            >
              রেকর্ডটি দেখুন
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          ) : null}
          {onFilterRecord ? (
            <button
              type="button"
              onClick={() => {
                haptic('tap');
                onFilterRecord();
              }}
              className="press text-ink-muted hover:text-ink inline-flex min-h-11 items-center text-xs md:min-h-9"
            >
              এই রেকর্ডের সব ঘটনা
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
