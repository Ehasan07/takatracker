'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, FileText, Pencil, Plus, Trash2, User } from '@/components/icons';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import * as React from 'react';
import { Money } from '@/components/money';
import { t } from '@/lib/t';
import { SkeletonCard, SkeletonRows } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { api, ApiError } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { EditLoanSheet } from '../edit-loan-sheet';
import { bnDate, bnNum, directionLabel, methodLabel, paidPercent } from '../labels';
import { ConfirmSheet, ProgressBar, QueryError, StatusPill, Toast } from '../parts';
import { PaymentSheet } from '../payment-sheet';
import { fetchLoanDetail, invalidateLoanData, loanKeys } from '../queries';
import type { LoanDetail, LoanPayment } from '../types';

/** The id the "go to the instalments" button scrolls to. */
const PAYMENTS_ANCHOR = 'loan-payments';

/**
 * Cancelling and deleting are both refused once an instalment exists, and both
 * refusals have the same cure. `null` means the action can go ahead.
 */
type BlockedAction = 'cancel' | 'delete' | null;

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
  /** The instalment this row came from — null on the disbursement row, which
   *  is not a payment and cannot be deleted on its own. */
  payment: LoanPayment | null;
}

/* A function rather than a constant: a module-level array is built before the
   workspace's language has been fetched, so it would freeze the Bengali in
   place on an English workspace. Every other label in this file has the same
   shape for the same reason. */
const columns = (): string[] => [
  t('loan.col.seq', 'ক্রম'),
  t('loan.col.date', 'তারিখ'),
  t('loan.col.detail', 'বিবরণ'),
  t('loan.col.debit', 'ডেবিট'),
  t('loan.col.credit', 'ক্রেডিট'),
  t('loan.col.paid', 'পরিশোধ'),
  t('loan.col.running', 'চলতি জের'),
  t('loan.col.method', 'মাধ্যম'),
  t('loan.col.reference', 'রেফারেন্স'),
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
      description: lent ? t('loan.lentTitle', 'ঋণ প্রদান') : t('loan.borrowedTitle', 'ঋণ গ্রহণ'),
      debitMinor: lent ? total : 0,
      creditMinor: lent ? 0 : total,
      repaidMinor: 0,
      balanceMinor: total,
      method: '',
      reference: loan.loanNumber,
      payment: null,
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
      description: payment.note?.trim() || t('loan.repayment', 'কিস্তি পরিশোধ'),
      // A repayment credits a receivable and debits a payable.
      debitMinor: lent ? 0 : payment.amountMinor,
      creditMinor: lent ? payment.amountMinor : 0,
      repaidMinor: payment.amountMinor,
      balanceMinor: balance,
      method: methodLabel(payment.method),
      reference: payment.referenceNumber ?? '',
      payment,
    });
  });

  return rows;
}

export default function LoanDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const queryClient = useQueryClient();
  const router = useRouter();

  const [payOpen, setPayOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  /* The whole payment, not its id: the confirmation names the amount and the
     date, and it has to keep naming them while the delete is in flight. */
  const [deleting, setDeleting] = React.useState<LoanPayment | null>(null);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [blocked, setBlocked] = React.useState<BlockedAction>(null);
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
      setToast(
        t(
          'loan.paymentDeleted',
          'কিস্তিটি মুছে ফেলা হয়েছে — খাতার লেনদেনটিও ফিরিয়ে নেওয়া হয়েছে',
        ),
      );
    },
    onError: (err) => {
      setDeleting(null);
      setToast(
        err instanceof ApiError ? err.message : t('loan.paymentDeleteFailed', 'কিস্তি মোছা যায়নি'),
      );
    },
  });

  const cancelLoan = useMutation({
    mutationFn: () => api(`/loans/${id}/cancel`, { method: 'POST', body: {} }),
    onSuccess: () => {
      haptic('success');
      invalidateLoanData(queryClient);
      setCancelOpen(false);
      setToast(t('loan.cancelled', 'ঋণটি বাতিল করা হয়েছে'));
    },
    onError: (err) => {
      setCancelOpen(false);
      setToast(
        err instanceof ApiError ? err.message : t('loan.cancelFailed', 'ঋণ বাতিল করা যায়নি'),
      );
    },
  });

  const removeLoan = useMutation({
    mutationFn: () => api(`/loans/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      haptic('success');
      invalidateLoanData(queryClient);
      setDeleteOpen(false);
      // Nothing left to look at; `replace` so Back does not land on a 404.
      router.replace('/loans');
    },
    onError: (err) => {
      setDeleteOpen(false);
      setToast(
        err instanceof ApiError ? err.message : t('loan.deleteFailed', 'ঋণ মুছে ফেলা যায়নি'),
      );
    },
  });

  /* The instalment list is already on this screen, so the cure for "delete the
     instalments first" is a scroll, not another journey. */
  const goToPayments = React.useCallback(() => {
    setBlocked(null);
    document
      .getElementById(PAYMENTS_ANCHOR)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

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
        <div className="rounded-card border-rule bg-surface overflow-hidden border-[1.5px]">
          <SkeletonRows rows={4} />
        </div>
      </div>
    );
  }

  const { loan, person, progress, payments } = detail.data;
  const percent = paidPercent(progress.paidMinor, progress.totalPayableMinor);
  const overdue = progress.daysOverdue > 0 || loan.status === 'OVERDUE';
  const closed = loan.status === 'CANCELLED' || loan.status === 'COMPLETED';
  /* Both refusals are the API's, and both are worth catching here: a button
     that explains itself beats one that fires a request in order to fail. */
  const hasPayments = payments.length > 0;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <BackLink />

      <header className="rounded-card border-rule bg-surface border-[1.5px] p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-ink truncate text-xl font-bold">
              {person?.name ?? t('common.unknown', 'অজানা')}
            </h1>
            <p className="text-ink-muted truncate text-sm">
              {loan.loanNumber} · {directionLabel(loan.direction)}
              {person?.phone ? ` · ${person.phone}` : ''}
            </p>
          </div>
          <StatusPill status={loan.status} />
        </div>

        <dl className="border-rule mt-4 grid grid-cols-2 gap-3 border-t pt-3 sm:grid-cols-4">
          <div className="min-w-0">
            <dt className="text-ink-muted text-xs">{t('loan.totalOwed', 'মোট ঋণ')}</dt>
            <dd>
              <Money minor={progress.totalPayableMinor} className="block text-sm" />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-ink-muted text-xs">{t('loan.paidLabel', 'পরিশোধিত')}</dt>
            <dd>
              <Money minor={progress.paidMinor} className="text-income block text-sm" />
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-ink-muted text-xs">{t('loan.outstanding', 'বাকি')}</dt>
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
            <dt className="text-ink-muted text-xs">{t('loan.nextDue', 'পরের কিস্তির তারিখ')}</dt>
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
            className="press border-rule text-ink hover:bg-greenbar flex min-h-11 items-center gap-1.5 rounded-xl border px-3 text-sm"
          >
            <FileText className="h-4 w-4" aria-hidden />
            বিবরণী
          </Link>
          {person?.id ? (
            <Link
              href={`/loans/people/${person.id}`}
              className="press border-rule text-ink hover:bg-greenbar flex min-h-11 items-center gap-1.5 rounded-xl border px-3 text-sm"
            >
              <User className="h-4 w-4" aria-hidden />
              পার্টি লেজার
            </Link>
          ) : null}
          {/* Allowed on a settled loan too — a note or a date can be wrong on a
              finished loan, and the API says so by returning 200. */}
          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
            <Pencil className="h-4 w-4" aria-hidden />
            সম্পাদনা
          </Button>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {!closed ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-expense"
                onClick={() => (hasPayments ? setBlocked('cancel') : setCancelOpen(true))}
              >
                <Ban className="h-4 w-4" aria-hidden />
                ঋণ বাতিল
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="text-expense"
              onClick={() => (hasPayments ? setBlocked('delete') : setDeleteOpen(true))}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              ঋণ মুছুন
            </Button>
          </div>
        </div>
      </header>

      {/* The one action this screen exists for. */}
      {!closed ? (
        <Button size="block" onClick={() => setPayOpen(true)}>
          <Plus className="h-5 w-5" aria-hidden />
          কিস্তি যোগ করুন
        </Button>
      ) : null}

      <section id={PAYMENTS_ANCHOR} className="flex scroll-mt-4 flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-ink text-base font-semibold">
            {t('loan.payments', 'কিস্তির হিসাব')}
          </h2>
          <span className="text-ink-muted text-xs">
            {bnNum(progress.paymentCount || payments.length)}টি কিস্তি
          </span>
        </div>

        {/* Phone: a card per instalment. Nine columns do not belong on a 360px
            screen, and a sideways-scrolling table is not a table anybody reads. */}
        <ul className="loan-screen-cards flex flex-col gap-2 md:hidden">
          {history.map((row) => (
            <li key={row.key} className="rounded-card border-rule bg-surface border-[1.5px] p-3">
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
                  {row.payment ? (
                    <button
                      type="button"
                      aria-label="কিস্তি মুছুন"
                      onClick={() => setDeleting(row.payment)}
                      className="press touch-target text-expense hover:bg-greenbar no-print flex items-center justify-center rounded-xl"
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
        <div className="loan-print-table rounded-card border-rule bg-surface hidden overflow-x-auto border-[1.5px] md:block">
          <table className="w-full min-w-[56rem] text-sm">
            <caption className="sr-only">{`${loan.loanNumber} — কিস্তির হিসাব`}</caption>
            <thead>
              <tr className="border-rule bg-greenbar border-b">
                {columns().map((column, i) => (
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
                  <span className="sr-only">{t('loan.action', 'কাজ')}</span>
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
                    {row.payment ? (
                      <button
                        type="button"
                        aria-label="কিস্তি মুছুন"
                        onClick={() => setDeleting(row.payment)}
                        className="press text-expense hover:bg-greenbar flex h-9 w-9 items-center justify-center rounded-xl"
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

        {payments.length === 0 ? (
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

      <EditLoanSheet
        detail={detail.data}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={setToast}
      />

      {/* Deleting an instalment moves real money, so the question names which
          one: the amount and the day it was paid, not "this instalment". */}
      <ConfirmSheet
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="কিস্তি মুছবেন?"
        description={deleting ? bnDate(deleting.date) : undefined}
        body={
          deleting ? (
            <>
              <Money minor={deleting.amountMinor} className="font-semibold" /> ·{' '}
              {bnDate(deleting.date)}
              {methodLabel(deleting.method) ? ` · ${methodLabel(deleting.method)}` : ''}
              {deleting.referenceNumber ? ` · ${deleting.referenceNumber}` : ''} — এই কিস্তিটি মুছে
              যাবে। খাতা থেকে লেনদেনটিও ফিরিয়ে নেওয়া হবে এবং ঋণের বাকি টাকা আবার বেড়ে যাবে। এটি
              ফেরানো যাবে না।
            </>
          ) : null
        }
        confirmLabel="হ্যাঁ, মুছে ফেলুন"
        pending={removePayment.isPending}
        onConfirm={() => deleting && removePayment.mutate(deleting.id)}
      />

      <ConfirmSheet
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="ঋণ বাতিল করবেন?"
        description={loan.loanNumber}
        body="বাতিল করলে খাতা থেকে ঋণের মূল লেনদেনটি ফিরিয়ে নেওয়া হবে আর ঋণের হিসাবটি আর্কাইভ হয়ে যাবে — ব্যালেন্স শিটে কিছুই পড়ে থাকবে না। ঋণ নম্বরটি তালিকায় ‘বাতিল’ হয়ে থেকে যাবে।"
        confirmLabel="হ্যাঁ, বাতিল করুন"
        pending={cancelLoan.isPending}
        onConfirm={() => cancelLoan.mutate()}
      />

      <ConfirmSheet
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="ঋণটি মুছে ফেলবেন?"
        description={`${loan.loanNumber} · ${person?.name ?? ''}`}
        body={
          <>
            পুরো ঋণটি তালিকা থেকে চলে যাবে। খাতা থেকে <Money minor={loan.principalMinor} />
            -এর মূল লেনদেনটি ফিরিয়ে নেওয়া হবে আর ঋণের হিসাবটি আর্কাইভ হয়ে যাবে — ব্যালেন্স শিটে
            কিছুই পড়ে থাকবে না। এটি ফেরানো যাবে না।
          </>
        }
        confirmLabel="হ্যাঁ, মুছে ফেলুন"
        pending={removeLoan.isPending}
        onConfirm={() => removeLoan.mutate()}
      />

      {/* The API refuses both cancel and delete while an instalment exists.
          Relaying that sentence alone leaves the user hunting; the way out is
          one tap away on this very screen, so point at it. */}
      <Sheet
        open={blocked !== null}
        onOpenChange={(open) => !open && setBlocked(null)}
        title="আগে কিস্তিগুলো মুছুন"
        description={loan.loanNumber}
      >
        <div className="flex flex-col gap-4">
          <p className="text-ink text-sm">
            এই ঋণে {bnNum(payments.length)}টি কিস্তি জমা আছে, মোট{' '}
            <Money minor={progress.paidMinor} className="font-semibold" /> — তাই ঋণটি এখন{' '}
            {blocked === 'cancel' ? 'বাতিল করা যাবে না' : 'মুছে ফেলা যাবে না'}। জমা হওয়া টাকা খাতার
            সত্যি ঘটনা, আর সেটি মুছলে হিসাবও বদলে যায়।
          </p>
          <p className="text-ink-muted text-sm">
            নিচের ‘কিস্তির হিসাব’ তালিকা থেকে কিস্তিগুলো একে একে মুছে ফেলুন — শেষটি মুছলেই ঋণটি{' '}
            {blocked === 'cancel' ? 'বাতিল করা যাবে' : 'মুছে ফেলা যাবে'}।
          </p>
          <Button size="block" onClick={goToPayments}>
            কিস্তির তালিকায় যান
          </Button>
          <Button variant="outline" size="block" onClick={() => setBlocked(null)}>
            থাক
          </Button>
        </div>
      </Sheet>

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
