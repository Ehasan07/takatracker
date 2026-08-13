'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';
import { Money } from '@/components/money';
import { ShareStatementSheet } from '@/components/share-statement-sheet';
import { SkeletonRows } from '@/components/skeleton';
import { bnDate, bnNum, directionLabel } from '../../labels';
import { QueryError, StatusPill } from '../../parts';
import { fetchLoans, fetchPartyLedger, loanKeys } from '../../queries';
import { ALL_TIME, StatementView, filterQuery, type DateFilter } from '../../statement-view';

export default function PartyLedgerPage() {
  const params = useParams<{ personId: string }>();
  const personId = params.personId;
  const [filter, setFilter] = React.useState<DateFilter>(ALL_TIME);
  const [sharing, setSharing] = React.useState(false);
  const range = filterQuery(filter);

  const ledger = useQuery({
    queryKey: loanKeys.ledger(personId, range),
    queryFn: () => fetchPartyLedger(personId, range),
    enabled: Boolean(personId),
  });

  /* The loan list carries this person's loans and, when the ledger does not
     send its own subtotals, the net position too. */
  const loans = useQuery({
    queryKey: loanKeys.list({ personId }),
    queryFn: () => fetchLoans({ personId }),
    enabled: Boolean(personId),
  });

  const rows = loans.data ?? [];
  const first = rows[0];
  const person =
    ledger.data?.person ??
    (first ? { id: first.personId, name: first.personName, phone: first.personPhone } : null);

  const sumOutstanding = (direction: 'LENT' | 'BORROWED'): number =>
    rows
      .filter((loan) => loan.direction === direction && loan.status !== 'CANCELLED')
      .reduce((sum, loan) => sum + loan.progress.outstandingMinor, 0);

  // The API's own subtotals when it sends them; otherwise the same sums here.
  const lentMinor = ledger.data?.receivableMinor ?? sumOutstanding('LENT');
  const borrowedMinor = ledger.data?.payableMinor ?? sumOutstanding('BORROWED');
  const netMinor = ledger.data?.netPositionMinor ?? lentMinor - borrowedMinor;

  const heading = person?.name ? `${person.name} — পার্টি লেজার` : 'পার্টি লেজার';
  const subheading = person?.phone ?? undefined;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <Link
        href="/loans"
        className="press text-ink-muted hover:text-ink no-print flex min-h-11 w-fit items-center gap-1.5 text-sm"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        ধার-দেনা
      </Link>

      {sharing && person ? (
        <ShareStatementSheet
          open
          onOpenChange={setSharing}
          kind="PERSON"
          subjectId={person.id}
          subjectName={person.name}
        />
      ) : null}

      <header className="rounded-card border-rule bg-surface loan-print-block border p-4">
        <h1 className="text-ink truncate text-xl font-semibold">
          {person?.name ?? 'পার্টি লেজার'}
        </h1>
        {person?.phone ? <p className="text-ink-muted text-sm">{person.phone}</p> : null}

        <div className="border-rule mt-3 border-t pt-3">
          <p className="text-ink-muted text-xs">
            {netMinor > 0
              ? 'সব মিলিয়ে আপনি পাবেন'
              : netMinor < 0
                ? 'সব মিলিয়ে আপনি দেবেন'
                : 'হিসাব'}
          </p>
          <Money
            minor={Math.abs(netMinor)}
            className={
              netMinor > 0
                ? 'text-income block text-2xl font-semibold'
                : netMinor < 0
                  ? 'text-expense block text-2xl font-semibold'
                  : 'block text-2xl font-semibold'
            }
          />
          {netMinor === 0 ? <p className="text-ink-muted text-xs">দুই পক্ষের হিসাব সমান।</p> : null}
        </div>

        <dl className="border-rule mt-3 grid grid-cols-2 gap-3 border-t pt-3">
          <div className="min-w-0">
            <dt className="text-ink-muted text-xs">যা ধার দিয়েছি (বাকি)</dt>
            <dd>
              <Money minor={lentMinor} className="text-income block text-sm" />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-ink-muted text-xs">যা ধার নিয়েছি (বাকি)</dt>
            <dd>
              <Money minor={borrowedMinor} className="text-expense block text-sm" />
            </dd>
          </div>
        </dl>
      </header>

      <section className="flex flex-col gap-2">
        <h2 className="text-ink text-base font-semibold">এই ব্যক্তির ঋণসমূহ</h2>
        {loans.isError ? (
          <QueryError message="ঋণের তালিকা আনা যায়নি।" onRetry={() => void loans.refetch()} />
        ) : loans.isLoading ? (
          <div className="rounded-card border-rule bg-surface overflow-hidden border">
            <SkeletonRows rows={2} />
          </div>
        ) : rows.length === 0 ? (
          <p className="text-ink-muted text-sm">এই ব্যক্তির নামে কোনো ঋণ নেই।</p>
        ) : (
          <ul className="rounded-card border-rule bg-surface loan-print-block overflow-hidden border">
            {rows.map((loan) => (
              <li key={loan.id} className="ledger-row border-rule border-b last:border-b-0">
                <Link
                  href={`/loans/${loan.id}`}
                  className="press hover:bg-greenbar flex items-center gap-3 px-3 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-ink truncate text-sm font-medium">{loan.loanNumber}</p>
                      <StatusPill status={loan.status} />
                    </div>
                    <p className="text-ink-muted truncate text-xs">
                      {directionLabel(loan.direction)} · {bnDate(loan.loanDate)}
                      {loan.dueDate ? ` · ফেরত ${bnDate(loan.dueDate)}` : ''}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <Money
                      minor={loan.progress.outstandingMinor}
                      className="block text-sm"
                      decimals={false}
                    />
                    <span className="text-ink-muted text-[11px]">বাকি</span>
                  </div>
                  <ChevronRight className="text-ink-muted no-print h-4 w-4 shrink-0" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
        {rows.length > 0 ? (
          <p className="text-ink-muted text-xs">{bnNum(rows.length)}টি ঋণ</p>
        ) : null}
      </section>

      <StatementView
        heading={heading}
        subheading={subheading}
        filter={filter}
        onFilterChange={setFilter}
        data={ledger.data}
        isLoading={ledger.isLoading}
        isError={ledger.isError}
        onRetry={() => void ledger.refetch()}
        fileBaseName={`party-${person?.name ?? personId}-ledger`}
        /* Every loan with one person on one running balance — the statement a
           creditor actually asks for, and until now the one screen with no way
           to send it. */
        onShareLink={person ? () => setSharing(true) : undefined}
      />
    </div>
  );
}
