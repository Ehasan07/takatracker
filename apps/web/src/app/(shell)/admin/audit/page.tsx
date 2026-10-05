'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { Building2, Lock, ScrollText, X } from '@/components/icons';
import Link from 'next/link';
import * as React from 'react';
import { SkeletonRows } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import {
  ACTION_GROUPS,
  actionLabel,
  actorTypeLabel,
  bnDateTime,
  bnNum,
  entityLabel,
  isAlarming,
  shortId,
} from '../labels';
import { NotFoundScreen, QueryError } from '../parts';
import { adminKeys, fetchPlatformAudit, isNotHere, type AuditFilters } from '../queries';
import type { JsonObject, PlatformAuditEvent } from '../types';

export default function AdminAuditPage() {
  const [action, setAction] = React.useState('');
  const [typedWorkspace, setTypedWorkspace] = React.useState('');
  const [workspaceId, setWorkspaceId] = React.useState('');
  const [actorId, setActorId] = React.useState('');

  // Debounced, because every request here writes a row into the log it reads.
  React.useEffect(() => {
    const timer = setTimeout(() => setWorkspaceId(typedWorkspace.trim()), 400);
    return () => clearTimeout(timer);
  }, [typedWorkspace]);

  const filters: AuditFilters = React.useMemo(
    () => ({
      action: action || undefined,
      workspaceId: workspaceId || undefined,
      actorId: actorId || undefined,
    }),
    [action, workspaceId, actorId],
  );

  const log = useInfiniteQuery({
    queryKey: adminKeys.audit(filters),
    queryFn: ({ pageParam }) => fetchPlatformAudit(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const rows = React.useMemo(
    () => (log.data?.pages ?? []).flatMap((page) => page.items),
    [log.data],
  );

  if (isNotHere(log.error)) return <NotFoundScreen />;

  const filtered = action !== '' || workspaceId !== '' || actorId !== '';

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h1 className="text-ink text-xl font-extrabold sm:text-2xl">সব কার্যবিবরণী</h1>
        {rows.length > 0 ? (
          <span className="text-ink-muted text-xs">{bnNum(rows.length)}টি ঘটনা</span>
        ) : null}
      </header>

      {/* The one query in the product whose whole purpose is to ignore the
          workspace boundary. Reading it is itself a recorded event. */}
      <p className="rounded-card border-rule bg-surface text-ink-muted flex items-start gap-2 border-[1.5px] p-3 text-xs">
        <Lock className="text-income mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>
          এখানে সব ওয়ার্কস্পেসের ঘটনা একসঙ্গে দেখা যায়। এই পাতা খোলাও একটি{' '}
          <span className="text-ink font-medium">রেকর্ড হওয়া ঘটনা</span> — ছাঁকনি সহ আপনার নামে
          কার্যবিবরণীতে লেখা হয়।
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

      <Input
        aria-label="ওয়ার্কস্পেসের আইডি"
        placeholder="ওয়ার্কস্পেসের আইডি (ঐচ্ছিক)"
        value={typedWorkspace}
        onChange={(e) => setTypedWorkspace(e.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />

      {actorId ? (
        <div className="border-rule bg-greenbar flex min-h-11 items-center gap-2 rounded-xl border px-3">
          <span className="text-ink min-w-0 flex-1 truncate text-xs">
            একজন ব্যবহারকারীর ঘটনা দেখানো হচ্ছে ({shortId(actorId)})
          </span>
          <button
            type="button"
            onClick={() => {
              haptic('tap');
              setActorId('');
            }}
            aria-label="এই ব্যবহারকারীর ফিল্টার সরান"
            className="press touch-target text-ink-muted hover:bg-surface -mr-2 flex items-center justify-center rounded-xl"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : null}

      {log.isError ? (
        <QueryError message="কার্যবিবরণী আনা যায়নি।" onRetry={() => void log.refetch()} />
      ) : log.isLoading ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border-[1.5px]">
          <SkeletonRows rows={6} />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-card border-rule border-[1.5px] border-dashed p-8 text-center">
          <ScrollText className="text-ink-muted mx-auto h-6 w-6" aria-hidden />
          <p className="text-ink mt-2">
            {filtered ? 'এই ছাঁকনিতে কোনো ঘটনা নেই।' : 'এখনও কিছু রেকর্ড হয়নি।'}
          </p>
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {rows.map((event) => (
              <li key={event.id}>
                <Row
                  event={event}
                  onFilterActor={
                    actorId === '' && event.actor
                      ? () => setActorId(event.actor?.id ?? '')
                      : undefined
                  }
                />
              </li>
            ))}
          </ul>

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
        </>
      )}
    </div>
  );
}

function Row({ event, onFilterActor }: { event: PlatformAuditEvent; onFilterActor?: () => void }) {
  const alarming = isAlarming(event.action);
  const entity = entityLabel(event.entity);

  return (
    <article
      className={cn(
        'rounded-card bg-surface min-w-0 border-[1.5px] p-3.5',
        alarming ? 'border-expense/40' : 'border-rule',
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-ink text-sm font-medium">{actionLabel(event.action)}</p>
          <p className="text-ink-muted truncate text-xs">
            {event.actor ? event.actor.name || event.actor.email : 'অজানা'} ·{' '}
            {actorTypeLabel(event.actorType)}
            {entity ? ` · ${entity}` : ''}
          </p>
        </div>
        <span className="text-ink-muted shrink-0 text-right text-[11px]">
          {bnDateTime(event.createdAt)}
        </span>
      </div>

      {event.workspace ? (
        <Link
          href={`/admin/tenants/${event.workspace.id}`}
          onClick={() => haptic('tap')}
          className="press text-income mt-1.5 inline-flex min-h-11 items-center gap-1 text-xs font-medium md:min-h-9"
        >
          <Building2 className="h-3.5 w-3.5" aria-hidden />
          {event.workspace.name}
        </Link>
      ) : null}

      <Payload before={event.before} after={event.after} />

      {event.ip ? (
        <p className="text-ink-muted mt-2 break-all text-[11px]">
          {/* Latin digits on purpose: an IP is compared and copied, not read as
              a quantity. */}
          আইপি {event.ip}
        </p>
      ) : null}

      {onFilterActor ? (
        <div className="border-rule mt-2.5 border-t pt-1">
          <button
            type="button"
            onClick={() => {
              haptic('tap');
              onFilterActor();
            }}
            className="press text-ink-muted hover:text-ink inline-flex min-h-11 items-center text-xs md:min-h-9"
          >
            এই ব্যক্তির সব ঘটনা
          </button>
        </div>
      ) : null}
    </article>
  );
}

/**
 * `before` and `after` verbatim.
 *
 * The tenant-facing log renders a translated diff, but an operator screen wants
 * the row as it was written — an admin payload carries operator emails, session
 * ids, plan codes and free-text notes, and inventing Bengali for keys nobody
 * has named would hide the half this screen exists to show. Rendered inside its
 * own horizontal scroller so a long value cannot push the page sideways.
 */
function Payload({ before, after }: { before: JsonObject | null; after: JsonObject | null }) {
  const entries: [string, JsonObject][] = [];
  if (before) entries.push(['আগে', before]);
  if (after) entries.push(['পরে', after]);
  if (entries.length === 0) return null;

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {entries.map(([label, payload]) => (
        <div key={label} className="min-w-0">
          <p className="text-ink-muted text-[11px]">{label}</p>
          <dl className="border-rule bg-greenbar mt-0.5 overflow-x-auto rounded-xl border p-2">
            {Object.entries(payload).map(([key, value]) => (
              <div key={key} className="flex gap-2 whitespace-nowrap text-[11px]">
                <dt className="text-ink-muted">{key}</dt>
                <dd className="text-ink font-medium">{stringify(value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

const stringify = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value === 'string') return value === '' ? '""' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? '—';
  } catch {
    return '—';
  }
};
