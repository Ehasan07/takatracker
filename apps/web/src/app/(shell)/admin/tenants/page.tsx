'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Building2, ChevronRight, Search } from '@/components/icons';
import Link from 'next/link';
import * as React from 'react';
import { Money } from '@/components/money';
import { SkeletonRows } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { haptic } from '@/lib/haptics';
import { bnBytes, bnDate, bnNum, STATUS_FILTERS } from '../labels';
import { Chip, NotFoundScreen, QueryError, StatusPill } from '../parts';
import {
  adminKeys,
  catalogueKeys,
  fetchPlans,
  fetchTenants,
  isNotHere,
  type TenantFilters,
} from '../queries';
import type { TenantRow } from '../types';

export default function AdminTenantsPage() {
  const [typed, setTyped] = React.useState('');
  const [q, setQ] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [planCode, setPlanCode] = React.useState('');

  // Debounced: one request when the typing stops, not one per keystroke — and
  // every one of these writes an audit row, so it matters more here than usual.
  React.useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);

  const filters: TenantFilters = React.useMemo(
    () => ({ q: q || undefined, status: status || undefined, planCode: planCode || undefined }),
    [q, status, planCode],
  );

  const list = useInfiniteQuery({
    queryKey: adminKeys.tenants(filters),
    queryFn: ({ pageParam }) => fetchTenants(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  /* The package filter. `/entitlements/plans` returns only `isPublic` packages,
   * so a bespoke plan assembled for one customer will not appear in this list
   * even though tenants are sitting on it — there is no admin endpoint that
   * lists every plan. The chips above still find those tenants; only this
   * dropdown is incomplete, which is why it is a filter and not the answer. */
  const plans = useQuery({
    queryKey: catalogueKeys.plans(),
    queryFn: fetchPlans,
    staleTime: 5 * 60_000,
  });

  const rows = React.useMemo(
    () => (list.data?.pages ?? []).flatMap((page) => page.items),
    [list.data],
  );

  if (isNotHere(list.error)) return <NotFoundScreen />;

  const filtered = q !== '' || status !== '' || planCode !== '';

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h1 className="text-ink text-xl font-extrabold sm:text-2xl">সব ওয়ার্কস্পেস</h1>
        {rows.length > 0 ? (
          <p className="text-ink-muted text-xs">
            {bnNum(rows.length)}টি দেখানো হচ্ছে
            {list.hasNextPage ? ', আরও আছে' : ''}
          </p>
        ) : null}
      </header>

      <div className="relative">
        <Search
          className="text-ink-muted pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
          aria-hidden
        />
        <Input
          aria-label="ওয়ার্কস্পেসের নাম বা মালিকের ইমেইল দিয়ে খুঁজুন"
          placeholder="নাম বা মালিকের ইমেইল…"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          type="search"
          enterKeyHint="search"
          className="pl-9"
        />
      </div>

      <div className="chip-strip">
        {STATUS_FILTERS.map(([value, label]) => (
          <Chip key={value || 'all'} active={status === value} onClick={() => setStatus(value)}>
            {label}
          </Chip>
        ))}
      </div>

      <Select
        aria-label="প্ল্যান দিয়ে ছাঁকুন"
        value={planCode}
        onChange={(e) => setPlanCode(e.target.value)}
      >
        <option value="">সব প্ল্যান</option>
        {(plans.data ?? []).map((plan) => (
          <option key={plan.code} value={plan.code}>
            {plan.name} ({plan.code})
          </option>
        ))}
      </Select>

      {list.isError ? (
        <QueryError
          message="ওয়ার্কস্পেসের তালিকা আনা যায়নি।"
          onRetry={() => void list.refetch()}
        />
      ) : list.isLoading ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border-[1.5px]">
          <SkeletonRows rows={5} />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-card border-rule border-[1.5px] border-dashed p-8 text-center">
          <Building2 className="text-ink-muted mx-auto h-6 w-6" aria-hidden />
          <p className="text-ink mt-2">
            {filtered ? 'এই ছাঁকনিতে কোনো ওয়ার্কস্পেস নেই।' : 'কোনো ওয়ার্কস্পেস নেই।'}
          </p>
          {filtered ? (
            <p className="text-ink-muted mt-1 text-sm">উপরের ছাঁকনি বদলে দেখুন।</p>
          ) : null}
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {rows.map((tenant) => (
              <li key={tenant.id}>
                <TenantCard tenant={tenant} />
              </li>
            ))}
          </ul>

          {list.hasNextPage ? (
            <Button
              variant="outline"
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              {list.isFetchingNextPage ? 'আনা হচ্ছে…' : 'আরও দেখুন'}
            </Button>
          ) : (
            <p className="text-ink-muted py-2 text-center text-xs">এটুকুই — আর কিছু নেই।</p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * A card, not a table row.
 *
 * Six numbers about a tenant will not fit across 320px as columns, and a table
 * in a horizontal scroller hides half of them behind a gesture nobody makes on
 * a support call. The card carries the same six and stacks.
 */
function TenantCard({ tenant }: { tenant: TenantRow }) {
  return (
    <Link
      href={`/admin/tenants/${tenant.id}`}
      onClick={() => haptic('tap')}
      className="press rounded-card border-rule bg-surface hover:bg-greenbar block border-[1.5px] p-3.5"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="text-ink truncate text-sm font-medium">{tenant.name}</p>
            <StatusPill status={tenant.status} />
          </div>
          <p className="text-ink-muted truncate text-xs">
            {tenant.owner ? tenant.owner.email : 'মালিক জানা যায়নি'}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-ink text-xs font-medium">{tenant.plan?.name ?? 'প্ল্যান নেই'}</p>
          {tenant.plan && tenant.plan.priceMinor > 0 ? (
            <Money
              minor={tenant.plan.priceMinor}
              className="text-ink-muted block text-[11px]"
              decimals={false}
            />
          ) : null}
        </div>
        <ChevronRight className="text-ink-muted mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      </div>

      <dl className="border-rule mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1 border-t pt-2 sm:grid-cols-4">
        <Cell label="সদস্য" value={bnNum(tenant.memberCount)} />
        <Cell label="লেনদেন" value={bnNum(tenant.transactionCount)} />
        <Cell label="স্টোরেজ" value={bnBytes(tenant.storageBytes)} />
        <Cell label="খোলা হয়েছে" value={bnDate(tenant.createdAt)} />
      </dl>

      {tenant.trialEndsAt ? (
        <p className="text-brass mt-1.5 text-[11px]">ট্রায়াল শেষ {bnDate(tenant.trialEndsAt)}</p>
      ) : null}
    </Link>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-muted truncate text-[11px]">{label}</dt>
      <dd className="text-ink truncate text-xs">{value}</dd>
    </div>
  );
}
