'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, User } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';
import { Money } from '@/components/money';
import { ShareStatementSheet } from '@/components/share-statement-sheet';
import { bnDate, directionLabel, statusLabel } from '../../labels';
import { fetchLoanStatement, loanKeys } from '../../queries';
import { ALL_TIME, StatementView, filterQuery, type DateFilter } from '../../statement-view';

export default function LoanStatementPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [filter, setFilter] = React.useState<DateFilter>(ALL_TIME);
  const [sharing, setSharing] = React.useState(false);
  const range = filterQuery(filter);

  const statement = useQuery({
    queryKey: loanKeys.statement(id, range),
    queryFn: () => fetchLoanStatement(id, range),
    enabled: Boolean(id),
  });

  const loan = statement.data?.loan;
  const person = statement.data?.person ?? null;
  const personName = person?.name ?? loan?.personName ?? '';
  const personId = person?.id ?? loan?.personId ?? '';
  const heading = personName ? `${personName} — ঋণের বিবরণী` : 'ঋণের বিবরণী';
  const subheading = loan
    ? `${loan.loanNumber} · ${directionLabel(loan.direction)} · ${statusLabel(loan.status)}`
    : undefined;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="no-print flex flex-wrap items-center gap-2">
        <Link
          href={`/loans/${id}`}
          className="press text-ink-muted hover:text-ink flex min-h-11 w-fit items-center gap-1.5 text-sm"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          ঋণে ফিরুন
        </Link>
        {personId ? (
          <Link
            href={`/loans/people/${personId}`}
            className="press border-rule text-ink hover:bg-greenbar ml-auto flex min-h-11 items-center gap-1.5 rounded-md border px-3 text-sm"
          >
            <User className="h-4 w-4" aria-hidden />
            পার্টি লেজার
          </Link>
        ) : null}
      </div>

      {sharing ? (
        <ShareStatementSheet
          open
          onOpenChange={setSharing}
          kind="LOAN"
          subjectId={id}
          subjectName={heading}
        />
      ) : null}

      {/* The phone gets this from the shell's title bar, which names this route
          explicitly; printing drops it either way via `no-print`. */}
      <h1 className="text-ink no-print hidden text-xl font-semibold sm:text-2xl md:block">
        ঋণের বিবরণী
      </h1>

      <StatementView
        heading={heading}
        subheading={subheading}
        filter={filter}
        onFilterChange={setFilter}
        data={statement.data}
        isLoading={statement.isLoading}
        isError={statement.isError}
        onRetry={() => void statement.refetch()}
        fileBaseName={`loan-${loan?.loanNumber ?? id}-statement`}
        /* Shares the window that is on screen, so what the creditor opens is
           what the owner was looking at when they pressed it. */
        onShareLink={() => setSharing(true)}
      >
        {loan ? (
          <dl className="rounded-card border-rule bg-surface loan-print-block grid grid-cols-2 gap-3 border p-4 sm:grid-cols-4">
            <div className="min-w-0">
              <dt className="text-ink-muted text-xs">মূল টাকা</dt>
              <dd>
                <Money minor={loan.principalMinor} className="block text-sm" />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-ink-muted text-xs">মোট দেয়</dt>
              <dd>
                <Money minor={loan.progress.totalPayableMinor} className="block text-sm" />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-ink-muted text-xs">পরিশোধিত</dt>
              <dd>
                <Money minor={loan.progress.paidMinor} className="block text-sm" />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-ink-muted text-xs">ফেরতের তারিখ</dt>
              <dd className="text-ink text-sm">{bnDate(loan.dueDate)}</dd>
            </div>
          </dl>
        ) : null}
      </StatementView>
    </div>
  );
}
