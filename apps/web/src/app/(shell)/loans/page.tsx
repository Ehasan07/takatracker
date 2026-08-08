'use client';

import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { Money } from '@/components/money';
import { SkeletonCard, SkeletonRows } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { AddLoanSheet } from './add-loan-sheet';
import {
  DIRECTION_TITLE,
  OUTSTANDING_LABEL,
  REPAID_LABEL,
  STATUS_FILTERS,
  bnDate,
  bnNum,
  paidPercent,
} from './labels';
import { Chip, ProgressBar, QueryError, StatusPill, Tile } from './parts';
import { fetchDashboard, fetchLoans, loanKeys } from './queries';
import type { DirectionSummary, Loan, LoanDirection } from './types';

export default function LoansPage() {
  const [direction, setDirection] = React.useState<LoanDirection>('BORROWED');
  const [status, setStatus] = React.useState('');
  const [typed, setTyped] = React.useState('');
  const [q, setQ] = React.useState('');
  const [addOpen, setAddOpen] = React.useState(false);

  // Debounced: one request when the typing stops, not one per keystroke.
  React.useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);

  const dashboard = useQuery({ queryKey: loanKeys.dashboard(), queryFn: fetchDashboard });

  const filters = { direction, status: status || undefined, q: q || undefined };
  const loans = useQuery({
    queryKey: loanKeys.list(filters),
    queryFn: () => fetchLoans(filters),
  });

  const rows = loans.data ?? [];
  const unfiltered = status === '' && q === '';

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-ink hidden text-xl font-semibold sm:text-2xl md:block">ধার-দেনা</h1>
        <div className="ml-auto">
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            নতুন
          </Button>
        </div>
      </header>

      {/* Both directions at a glance. Tapping a card switches the list below. */}
      {dashboard.isError ? (
        <QueryError message="সারসংক্ষেপ আনা যায়নি।" onRetry={() => void dashboard.refetch()} />
      ) : dashboard.isLoading ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {(['BORROWED', 'LENT'] as const).map((key) => (
            <SummaryCard
              key={key}
              direction={key}
              summary={key === 'BORROWED' ? dashboard.data?.borrowed : dashboard.data?.lent}
              active={direction === key}
              onSelect={() => {
                haptic('select');
                setDirection(key);
              }}
            />
          ))}
        </div>
      )}

      {/* Which side of the khata are we looking at */}
      <div
        role="tablist"
        aria-label="ধার-দেনার দিক"
        className="border-rule bg-surface grid grid-cols-2 gap-1 rounded-md border p-1"
      >
        {(['BORROWED', 'LENT'] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`loans-tab-${key}`}
            aria-selected={direction === key}
            aria-controls="loans-panel"
            onClick={() => {
              haptic('tap');
              setDirection(key);
            }}
            className={cn(
              'press flex min-h-11 items-center justify-center rounded-md px-3 text-sm md:min-h-9',
              direction === key ? 'bg-income font-medium text-white' : 'text-ink hover:bg-greenbar',
            )}
          >
            {DIRECTION_TITLE[key]}
          </button>
        ))}
      </div>

      <div className="relative">
        <Search
          className="text-ink-muted pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
          aria-hidden
        />
        <Input
          aria-label="নাম বা ঋণ নম্বর দিয়ে খুঁজুন"
          placeholder="নাম বা ঋণ নম্বর দিয়ে খুঁজুন…"
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

      <div id="loans-panel" role="tabpanel" aria-labelledby={`loans-tab-${direction}`}>
        {loans.isError ? (
          <QueryError message="ঋণের তালিকা আনা যায়নি।" onRetry={() => void loans.refetch()} />
        ) : loans.isLoading ? (
          <div className="rounded-card border-rule bg-surface overflow-hidden border">
            <SkeletonRows rows={4} />
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-card border-rule border border-dashed p-8 text-center">
            <p className="text-ink">
              {unfiltered
                ? direction === 'BORROWED'
                  ? 'এখনও কোনো ধার নেওয়ার হিসাব নেই।'
                  : 'এখনও কোনো ধার দেওয়ার হিসাব নেই।'
                : 'এই ফিল্টারে কোনো হিসাব নেই।'}
            </p>
            {unfiltered ? (
              <Button className="mt-3" onClick={() => setAddOpen(true)}>
                প্রথম ঋণ যোগ করুন
              </Button>
            ) : (
              <p className="text-ink-muted mt-1 text-sm">উপরের ফিল্টার বদলে দেখুন।</p>
            )}
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {rows.map((loan) => (
              <li key={loan.id}>
                <LoanRow loan={loan} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <AddLoanSheet open={addOpen} onOpenChange={setAddOpen} direction={direction} />
    </div>
  );
}

function SummaryCard({
  direction,
  summary,
  active,
  onSelect,
}: {
  direction: LoanDirection;
  summary: DirectionSummary | undefined;
  active: boolean;
  onSelect: () => void;
}) {
  const s = summary;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        'press rounded-card border-rule bg-surface border p-4 text-left',
        active && 'border-income',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-ink-muted text-sm font-medium">{DIRECTION_TITLE[direction]}</h2>
        <span className="text-ink-muted text-xs">{bnNum(s?.count ?? 0)}টি</span>
      </div>
      <Money
        minor={s?.outstandingMinor ?? 0}
        className={cn(
          'mt-1 block text-2xl font-semibold',
          direction === 'BORROWED' ? 'text-expense' : 'text-income',
        )}
      />
      <p className="text-ink-muted text-xs">{OUTSTANDING_LABEL[direction]}</p>

      <dl className="border-rule mt-3 grid grid-cols-2 gap-2 border-t pt-2">
        <Tile label="মোট" minor={s?.totalMinor ?? 0} />
        <Tile label={REPAID_LABEL[direction]} minor={s?.repaidMinor ?? 0} />
        <Tile label="মেয়াদোত্তীর্ণ" minor={s?.overdueMinor ?? 0} tone="text-expense" />
        <Tile label="আসন্ন" minor={s?.upcomingMinor ?? 0} />
      </dl>
    </button>
  );
}

function LoanRow({ loan }: { loan: Loan }) {
  const { progress } = loan;
  const percent = paidPercent(progress.paidMinor, progress.totalPayableMinor);
  const overdue = progress.daysOverdue > 0 || loan.status === 'OVERDUE';

  return (
    <Link
      href={`/loans/${loan.id}`}
      onClick={() => haptic('tap')}
      className="press rounded-card border-rule bg-surface hover:bg-greenbar block border p-4"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-ink truncate text-sm font-medium">{loan.personName}</p>
            <StatusPill status={loan.status} />
          </div>
          <p className="text-ink-muted truncate text-xs">
            {loan.loanNumber}
            {loan.personPhone ? ` · ${loan.personPhone}` : ''}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <Money
            minor={progress.outstandingMinor}
            className={cn(
              'block text-base font-semibold',
              loan.direction === 'BORROWED' ? 'text-expense' : 'text-income',
            )}
            decimals={false}
          />
          <span className="text-ink-muted text-[11px]">{OUTSTANDING_LABEL[loan.direction]}</span>
        </div>
        <ChevronRight className="text-ink-muted mt-1 h-4 w-4 shrink-0" aria-hidden />
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-ink-muted min-w-0 truncate text-xs">
          ফেরতের তারিখ: {bnDate(loan.dueDate)}
        </span>
        {overdue ? (
          <span className="bg-expense/10 text-expense shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium">
            {progress.daysOverdue > 0
              ? `${bnNum(progress.daysOverdue)} দিন পার হয়েছে`
              : 'মেয়াদোত্তীর্ণ'}
          </span>
        ) : null}
      </div>

      <ProgressBar
        className="mt-2"
        percent={percent}
        label={`${loan.loanNumber} — পরিশোধের অগ্রগতি`}
      />
    </Link>
  );
}
