'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, FileText, Plus, Trash2, User } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';
import { Money } from '@/components/money';
import { SkeletonCard, SkeletonRows } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { bnDate, bnNum, directionLabel, methodLabel, paidPercent } from '../labels';
import { ConfirmSheet, ProgressBar, QueryError, StatusPill, Toast } from '../parts';
import { PaymentSheet } from '../payment-sheet';
import { fetchLoanDetail, invalidateLoanData, loanKeys } from '../queries';
import type { LoanDetail } from '../types';

/** One line of the payment history, with the running balance already worked out. */
interface HistoryRow {
  key: string;
  serial: string;
  date: string;
  description: string;
  debitMinor: number;
  creditMinor: number;
  repaidMinor: number;
  balanceMinor: number;
  method: string;
  reference: string;
  paymentId: string | null;
}

const COLUMNS = [
  'ক্রম',
  'তারিখ',
  'বিবরণ',
  'ডেবিট',
  'ক্রেডিট',
  'পরিশোধ',
  'চলতি জের',
  'মাধ্যম',
  'রেফারেন্স',
];

/**
 * The history is built from `payments`, not from the statement rows: only the
 * payments carry an id (so an instalment can be deleted) and the balance can be
 * derived from `totalPayableMinor` downwards, which is what a khata shows.
 */
function buildHistory(detail: LoanDetail | undefined): HistoryRow[] {
  if (!detail) return [];
  const { loan, progress, payments } = detail;
  const lent = loan.direction === 'LENT';
  const total = progress.totalPayableMinor;

  const rows: HistoryRow[] = [
    {
      key: 'disbursement',
      serial: '—',
      date: loan.loanDate,
      description: lent ? 'ঋণ প্রদান' : 'ঋণ গ্রহণ',
      debitMinor: lent ? total : 0,
      creditMinor: lent ? 0 : total,
      repaidMinor: 0,
      balanceMinor: total,
      method: '',
      reference: loan.loanNumber,
      paymentId: null,
    },
  ];

  const ordered = [...payments].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let balance = total;
  ordered.forEach((payment, i) => {
    balance -= payment.amountMinor;
    rows.push({
      key: payment.id,
      serial: bnNum(i + 1),
      date: payment.date,
      description: payment.note?.trim() || 'কিস্তি পরিশোধ',
      // A repayment credits a receivable and debits a payable.
      debitMinor: lent ? 0 : payment.amountMinor,
      creditMinor: lent ? payment.amountMinor : 0,
      repaidMinor: payment.amountMinor,
      balanceMinor: balance,
      method: methodLabel(payment.method),
      reference: payment.referenceNumber ?? '',
      paymentId: payment.id,
    });
  });

  return rows;
}

export default function LoanDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const queryClient = useQueryClient();

  const [payOpen, setPayOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);
  const dismissToast = React.useCallback(() => setToast(null), []);

  const detail = useQuery({
    queryKey: loanKeys.detail(id),
    queryFn: () => fetchLoanDetail(id),
    enabled: Boolean(id),
  });

  const removePayment = useMutation({
    mutationFn: (paymentId: string) =>
      api(`/loans/${id}/payments/${paymentId}`, { method: 'DELETE' }),
    onSuccess: () => {
      haptic('success');
      invalidateLoanData(queryClient);
      setDeleting(null);
      setToast('কিস্তিটি মুছে ফেলা হয়েছে');
    },
    onError: (err) => {
      setDeleting(null);
      setToast(err instanceof ApiError ? err.message : 'কিস্তি মোছা যায়নি');
    },
  });

  const cancelLoan = useMutation({
    mutationFn: () => api(`/loans/${id}/cancel`, { method: 'POST', body: {} }),
    onSuccess: () => {
      haptic('success');
      invalidateLoanData(queryClient);
      setCancelOpen(false);
      setToast('ঋণটি বাতিল করা হয়েছে');
    },
    onError: (err) => {
      setCancelOpen(false);
      setToast(err instanceof ApiError ? err.message : 'ঋণ বাতিল করা যায়নি');
    },
  });

  const history = React.useMemo(() => buildHistory(detail.data), [detail.data]);

  if (detail.isError) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <BackLink />
        <QueryError message="ঋণের তথ্য আনা যায়নি।" onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  if (detail.isLoading || !detail.data) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <BackLink />
        <SkeletonCard />
        <div className="rounded-card border-rule bg-surface overflow-hidden border">
          <SkeletonRows rows={4} />
        </div>
      </div>
    );
  }

  const { loan, person, progress } = detail.data;
  const percent = paidPercent(progress.paidMinor, progress.totalPayableMinor);
  const overdue = progress.daysOverdue > 0 || loan.status === 'OVERDUE';
  const closed = loan.status === 'CANCELLED' || loan.status === 'COMPLETED';

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <BackLink />

      <header className="rounded-card border-rule bg-surface border p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-ink truncate text-xl font-semibold">{person?.name ?? 'অজানা'}</h1>
            <p className="text-ink-muted truncate text-sm">
              {loan.loanNumber} · {directionLabel(loan.direction)}
              {person?.phone ? ` · ${person.phone}` : ''}
            </p>
          </div>
          <StatusPill status={loan.status} />
        </div>

        <dl className="border-rule mt-4 grid grid-cols-2 gap-3 border-t pt-3 sm:grid-cols-4">
          <div className="min-w-0">
            <dt className="text-ink-muted text-xs">মোট ঋণ</dt>
            <dd>
              <Money minor={progress.totalPayableMinor} className="block text-sm" />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-ink-muted text-xs">পরিশোধিত</dt>
            <dd>
              <Money minor={progress.paidMinor} className="text-income block text-sm" />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-ink-muted text-xs">বাকি</dt>
            <dd>
              <Money
                minor={progress.outstandingMinor}
                className={cn(
                  'block text-sm font-semibold',
                  loan.direction === 'BORROWED' ? 'text-expense' : 'text-income',
                )}
              />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-ink-muted text-xs">পরের কিস্তির তারিখ</dt>
            <dd className={cn('text-sm', overdue ? 'text-expense' : 'text-ink')}>
              {progress.isSettled ? 'সব পরিশোধ হয়েছে' : bnDate(loan.dueDate)}
            </dd>
          </div>
        </dl>

        <ProgressBar
          className="mt-3"
          percent={percent}
          label={`${loan.loanNumber} — পরিশোধের অগ্রগতি`}
        />

        {overdue && !progress.isSettled ? (
          <p className="text-expense mt-2 text-xs">
            {progress.daysOverdue > 0
              ? `ফেরতের তারিখ ${bnNum(progress.daysOverdue)} দিন পার হয়েছে।`
              : 'ফেরতের তারিখ পার হয়েছে।'}
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Link
            href={`/loans/${loan.id}/statement`}
            className="press border-rule text-ink hover:bg-greenbar flex min-h-11 items-center gap-1.5 rounded-md border px-3 text-sm"
          >
            <FileText className="h-4 w-4" aria-hidden />
            বিবরণী
          </Link>
          {person?.id ? (
            <Link
              href={`/loans/people/${person.id}`}
              className="press border-rule text-ink hover:bg-greenbar flex min-h-11 items-center gap-1.5 rounded-md border px-3 text-sm"
            >
              <User className="h-4 w-4" aria-hidden />
              পার্টি লেজার
            </Link>
          ) : null}
          {!closed ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-expense ml-auto"
              onClick={() => setCancelOpen(true)}
            >
              <Ban className="h-4 w-4" aria-hidden />
              ঋণ বাতিল
            </Button>
          ) : null}
        </div>
      </header>

      {/* The one action this screen exists for. */}
      {!closed ? (
        <Button size="block" onClick={() => setPayOpen(true)}>
          <Plus className="h-5 w-5" aria-hidden />
          কিস্তি যোগ করুন
        </Button>
      ) : null}

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-ink text-base font-semibold">কিস্তির হিসাব</h2>
          <span className="text-ink-muted text-xs">
            {bnNum(progress.paymentCount || detail.data.payments.length)}টি কিস্তি
          </span>
        </div>

        {/* Phone: a card per instalment. Nine columns do not belong on a 360px
            screen, and a sideways-scrolling table is not a table anybody reads. */}
        <ul className="loan-screen-cards flex flex-col gap-2 md:hidden">
          {history.map((row) => (
            <li key={row.key} className="rounded-card border-rule bg-surface border p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-ink text-sm">{row.description}</p>
                  <p className="text-ink-muted text-xs">
                    {row.serial !== '—' ? `${row.serial} · ` : ''}
                    {bnDate(row.date)}
                    {row.method ? ` · ${row.method}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-start gap-1">
                  <div className="text-right">
                    {row.repaidMinor !== 0 ? (
                      <>
                        <Money minor={row.repaidMinor} className="text-income block text-sm" />
                        <span className="text-ink-muted text-[11px]">পরিশোধ</span>
                      </>
                    ) : (
                      <>
                        <Money
                          minor={row.debitMinor !== 0 ? row.debitMinor : row.creditMinor}
                          className="block text-sm"
                        />
                        <span className="text-ink-muted text-[11px]">
                          {row.debitMinor !== 0 ? 'ডেবিট' : 'ক্রেডিট'}
                        </span>
                      </>
                    )}
                  </div>
                  {row.paymentId ? (
                    <button
                      type="button"
                      aria-label="কিস্তি মুছুন"
                      onClick={() => setDeleting(row.paymentId)}
                      className="press touch-target text-expense hover:bg-greenbar no-print flex items-center justify-center rounded-md"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </button>
                  ) : null}
                </div>
              </div>
              {row.reference ? (
                <p className="text-ink-muted mt-1 truncate text-xs">রেফারেন্স: {row.reference}</p>
              ) : null}
              <div className="border-rule mt-2 flex items-center justify-between gap-2 border-t pt-2">
                <span className="text-ink-muted text-xs">চলতি জের</span>
                <Money minor={row.balanceMinor} className="text-sm font-semibold" />
              </div>
            </li>
          ))}
        </ul>

        {/* Tablet up: the full nine columns, in their own scroll container. */}
        <div className="loan-print-table rounded-card border-rule bg-surface hidden overflow-x-auto border md:block">
          <table className="w-full min-w-[56rem] text-sm">
            <caption className="sr-only">{`${loan.loanNumber} — কিস্তির হিসাব`}</caption>
            <thead>
              <tr className="border-rule bg-greenbar border-b">
                {COLUMNS.map((column, i) => (
                  <th
                    key={column}
                    scope="col"
                    className={`text-ink-muted px-2 py-2 text-xs font-medium ${
                      i >= 3 && i <= 6 ? 'text-right' : 'text-left'
                    }`}
                  >
                    {column}
                  </th>
                ))}
                <th scope="col" className="no-print px-2 py-2">
                  <span className="sr-only">কাজ</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.key} className="ledger-row border-rule border-b">
                  <td className="text-ink-muted px-2 py-2">{row.serial}</td>
                  <td className="text-ink whitespace-nowrap px-2 py-2">{bnDate(row.date)}</td>
                  <td className="text-ink px-2 py-2">{row.description}</td>
                  <td className="px-2 py-2 text-right">
                    {row.debitMinor !== 0 ? <Money minor={row.debitMinor} /> : '—'}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {row.creditMinor !== 0 ? <Money minor={row.creditMinor} /> : '—'}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {row.repaidMinor !== 0 ? (
                      <Money minor={row.repaidMinor} className="text-income" />
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Money minor={row.balanceMinor} className="font-semibold" />
                  </td>
                  <td className="text-ink-muted whitespace-nowrap px-2 py-2">
                    {row.method || '—'}
                  </td>
                  <td className="text-ink-muted px-2 py-2">{row.reference || '—'}</td>
                  <td className="no-print px-1 py-1 text-right">
                    {row.paymentId ? (
                      <button
                        type="button"
                        aria-label="কিস্তি মুছুন"
                        onClick={() => setDeleting(row.paymentId)}
                        className="press text-expense hover:bg-greenbar flex h-9 w-9 items-center justify-center rounded-md"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {detail.data.payments.length === 0 ? (
          <p className="text-ink-muted text-sm">
            এখনও কোনো কিস্তি জমা হয়নি — উপরের বোতামে প্রথম কিস্তিটি যোগ করুন।
          </p>
        ) : null}
      </section>

      <PaymentSheet
        loanId={loan.id}
        direction={loan.direction}
        outstandingMinor={progress.outstandingMinor}
        defaultAccountId={loan.accountId}
        open={payOpen}
        onOpenChange={setPayOpen}
      />

      <ConfirmSheet
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="কিস্তি মুছবেন?"
        body="কিস্তিটি খাতা থেকেও মুছে যাবে এবং ঋণের বাকি টাকা আবার বেড়ে যাবে। এটি ফেরানো যাবে না।"
        confirmLabel="হ্যাঁ, মুছে ফেলুন"
        pending={removePayment.isPending}
        onConfirm={() => deleting && removePayment.mutate(deleting)}
      />

      <ConfirmSheet
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="ঋণ বাতিল করবেন?"
        description={loan.loanNumber}
        body="বাতিল করলে ঋণটি হিসাবের বাইরে চলে যাবে। জমা হওয়া কিস্তিগুলো খাতায় থেকে যাবে।"
        confirmLabel="হ্যাঁ, বাতিল করুন"
        pending={cancelLoan.isPending}
        onConfirm={() => cancelLoan.mutate()}
      />

      {toast ? <Toast message={toast} onDismiss={dismissToast} /> : null}
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/loans"
      className="press text-ink-muted hover:text-ink no-print flex min-h-11 w-fit items-center gap-1.5 text-sm"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden />
      ধার-দেনা
    </Link>
  );
}
