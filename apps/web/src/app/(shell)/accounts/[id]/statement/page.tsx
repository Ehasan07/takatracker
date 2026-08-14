'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import * as React from 'react';
import { Money } from '@/components/money';
import { ShareStatementSheet } from '@/components/share-statement-sheet';
import { api } from '@/lib/api';
import { t } from '@/lib/t';
import { ALL_TIME, StatementView, type DateFilter } from '../../../loans/statement-view';

/**
 * One account's own statement, the way a bank issues one.
 *
 * ## Why it reuses the loan screens' `StatementView`
 *
 * Opening balance, a running balance down the rows, a closing balance, the date
 * chips, print, CSV, share — all of it already exists and is already tested on
 * two screens. A second implementation would drift, and the first thing to
 * drift is the running balance, which is the one number a reader checks against
 * their own bank's paper.
 *
 * The seventh column is the only difference and it is a real one: on a loan it
 * is how the instalment was paid, here it is the other side of the entry. That
 * is why `StatementView` takes the heading and the formatter rather than this
 * screen taking a copy of the table.
 *
 * ## What the summary strip says
 *
 * The proof, stated: opening + debits − credits = closing. A bank statement
 * that showed only the closing figure would be asking to be trusted; showing
 * the three numbers it came from is what lets somebody check it in ten seconds
 * — which is the whole reason the document exists.
 */

interface AccountStatementRow {
  date: string;
  transactionId: string;
  description: string;
  contra: string;
  debitMinor: number;
  creditMinor: number;
  balanceMinor: number;
}

interface AccountStatement {
  account: {
    id: string;
    name: string;
    type: string;
    currency: string;
    institution: string | null;
    accountNumberMasked: string | null;
  };
  from: string | null;
  to: string | null;
  openingMinor: number;
  rows: AccountStatementRow[];
  closingMinor: number;
  totalDebitMinor: number;
  totalCreditMinor: number;
  debitNormal: boolean;
}

export default function AccountStatementPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [filter, setFilter] = React.useState<DateFilter>(ALL_TIME);
  const [sharing, setSharing] = React.useState(false);

  /* The API takes explicit dates, not the presets the loan endpoints accept, so
     the preset is resolved to a window here. One fewer thing for the server to
     know about, and the URL a reader ends up with says which days it covers. */
  const range = accountRange(filter);

  const statement = useQuery({
    queryKey: ['accounts', 'statement', id, range],
    queryFn: () => api<AccountStatement>(`/accounts/${id}/statement${range}`),
    enabled: Boolean(id),
  });

  const data = statement.data;
  const account = data?.account;
  const heading = account
    ? `${account.name} — ${t('account.statement', 'হিসাব বিবরণী')}`
    : t('account.statement', 'হিসাব বিবরণী');
  const subheading = account
    ? [account.institution, account.accountNumberMasked].filter(Boolean).join(' · ') || undefined
    : undefined;

  /* `StatementView` renders `Statement`, whose rows carry `method` and
     `referenceNumber`. The contra account rides in `method` — one short string
     beside the money, which is what that slot is — and the column is renamed
     below so nothing is called what it is not. */
  const view = data
    ? {
        openingMinor: data.openingMinor,
        closingMinor: data.closingMinor,
        rows: data.rows.map((row) => ({
          date: row.date,
          description: row.description,
          debitMinor: row.debitMinor,
          creditMinor: row.creditMinor,
          balanceMinor: row.balanceMinor,
          method: row.contra || null,
          referenceNumber: null,
        })),
      }
    : undefined;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="no-print flex flex-wrap items-center gap-2">
        <Link
          href="/accounts"
          className="press text-ink-muted hover:text-ink flex min-h-11 w-fit items-center gap-1.5 text-sm"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {t('nav.accounts', 'অ্যাকাউন্ট')}
        </Link>
      </div>

      {sharing && account ? (
        <ShareStatementSheet
          open
          onOpenChange={setSharing}
          kind="ACCOUNT"
          subjectId={id}
          subjectName={account.name}
        />
      ) : null}

      <h1 className="text-ink no-print hidden text-xl font-semibold sm:text-2xl md:block">
        {t('account.statement', 'হিসাব বিবরণী')}
      </h1>

      <StatementView
        heading={heading}
        subheading={subheading}
        filter={filter}
        onFilterChange={setFilter}
        data={view}
        isLoading={statement.isLoading}
        isError={statement.isError}
        onRetry={() => void statement.refetch()}
        fileBaseName={`account-${account?.name ?? id}-statement`}
        onShareLink={() => setSharing(true)}
        detailHeading={t('stmt.contra', 'বিপরীত খাত')}
        formatDetail={(value) => value ?? ''}
        /* The strip below carries opening, both column totals and closing.
           Letting the view print its own opening/closing pair as well put the
           same two figures on the page twice, which on paper reads as an error
           in the document rather than a repetition in the layout. */
        showBalances={false}
      >
        {data ? (
          <dl className="rounded-card border-rule bg-surface loan-print-block grid grid-cols-2 gap-3 border p-4 sm:grid-cols-4">
            <div className="min-w-0">
              <dt className="text-ink-muted text-xs">{t('stmt.opening', 'প্রারম্ভিক জের')}</dt>
              <dd>
                <Money minor={data.openingMinor} className="block text-sm" />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-ink-muted text-xs">{t('stmt.totalDebit', 'মোট ডেবিট')}</dt>
              <dd>
                <Money minor={data.totalDebitMinor} className="block text-sm" />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-ink-muted text-xs">{t('stmt.totalCredit', 'মোট ক্রেডিট')}</dt>
              <dd>
                <Money minor={data.totalCreditMinor} className="block text-sm" />
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-ink-muted text-xs">{t('stmt.closing', 'সমাপনী জের')}</dt>
              <dd>
                <Money minor={data.closingMinor} className="block text-sm font-semibold" />
              </dd>
            </div>
            {/* Which side of this account is the natural one. A reader who has
                never met a credit balance needs the sentence; one who has reads
                past it. */}
            <p className="text-ink-muted col-span-2 text-xs sm:col-span-4">
              {data.debitNormal
                ? t(
                    'stmt.debitNormalNote',
                    'এই অ্যাকাউন্টে ডেবিট মানে টাকা যোগ, ক্রেডিট মানে টাকা বের হওয়া।',
                  )
                : t(
                    'stmt.creditNormalNote',
                    'এটি দায়ের অ্যাকাউন্ট — ক্রেডিট মানে দেনা বাড়ল, ডেবিট মানে দেনা কমল।',
                  )}
            </p>
          </dl>
        ) : null}
      </StatementView>
    </div>
  );
}

/**
 * The window as a query string of explicit dates.
 *
 * The presets are resolved in the browser against the reader's own clock, which
 * is the same clock the chips are labelled from — so "এই মাস" on screen and the
 * month the server is asked for can never be two different months.
 */
function accountRange(filter: DateFilter): string {
  if (filter.preset === 'all') return '';
  if (filter.preset === 'custom') {
    const qs = new URLSearchParams();
    if (filter.from) qs.set('from', filter.from);
    if (filter.to) qs.set('to', filter.to);
    const text = qs.toString();
    return text ? `?${text}` : '';
  }
  return presetToDates(filter.preset);
}

/** `YYYY-MM-DD` bounds for a preset, in the reader's own timezone. */
function presetToDates(preset: DateFilter['preset']): string {
  const now = new Date();
  const iso = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const start = new Date(now);
  const end = new Date(now);

  switch (preset) {
    case 'today':
      break;
    case 'yesterday':
      start.setDate(start.getDate() - 1);
      end.setDate(end.getDate() - 1);
      break;
    case 'last7':
      start.setDate(start.getDate() - 6);
      break;
    case 'thisMonth':
      start.setDate(1);
      break;
    case 'lastMonth':
      start.setMonth(start.getMonth() - 1, 1);
      end.setDate(0);
      break;
    case 'thisYear':
      start.setMonth(0, 1);
      break;
    default:
      return '';
  }
  return `?from=${iso(start)}&to=${iso(end)}`;
}
