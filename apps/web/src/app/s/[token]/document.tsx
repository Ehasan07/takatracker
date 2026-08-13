import { formatMinor, type Locale } from '@hishab/shared';
import { PrintButton } from './print-button';

/**
 * The statement itself: one table, a total, and a print button.
 *
 * ## Deliberately not the app
 *
 * No navigation, no branding beyond whose books these are, nothing to tap that
 * leads anywhere. The reader came to check a number, and every extra control is
 * something they have to decide to ignore. It is also the only page in this
 * product a stranger sees, so it should look like a document rather than a
 * screen.
 *
 * ## Printing
 *
 * `window.print()` from the browser, which every phone and desktop already has.
 * No PDF library on the server: nothing to keep patched, and the output is a
 * real selectable document rather than a picture of one. The print rules below
 * drop the button and let the table break across pages with its header
 * repeating — a two-page statement whose second page has no column titles is
 * not a statement.
 */

export interface PublicStatement {
  kind: 'PERSON' | 'LOAN' | 'SAVINGS' | 'INSURANCE';
  workspaceName: string;
  currency: string;
  locale: Locale;
  from: string | null;
  to: string | null;
  title: string;
  subtitle: string | null;
  data: Record<string, unknown>;
}

type Row = {
  date: string;
  description?: string | null;
  debitMinor?: number;
  creditMinor?: number;
  balanceMinor?: number;
};

type Instalment = {
  dueDate: string;
  expectedMinor: number;
  paidDate: string | null;
  status: string;
};

/**
 * The document's own words, in both languages, keyed by the workspace's.
 *
 * Not `t()` from `lib/t.ts`: that reads a module-level locale set from the
 * signed-in workspace, and there is nobody signed in here. The statement's
 * language is a property of the books it came from, which arrives on the
 * response — so it is passed down rather than read from anywhere.
 */
type Words = Record<
  | 'statement'
  | 'period'
  | 'wholeLife'
  | 'date'
  | 'detail'
  | 'debit'
  | 'credit'
  | 'balance'
  | 'opening'
  | 'closing'
  | 'dueDate'
  | 'amount'
  | 'paidOn'
  | 'status'
  | 'paid'
  | 'due'
  | 'total'
  | 'print'
  | 'empty'
  | 'issuedBy'
  | 'note',
  string
>;

const T: Record<Locale, Words> = {
  bn: {
    statement: 'বিবরণী',
    period: 'সময়কাল',
    wholeLife: 'শুরু থেকে আজ পর্যন্ত',
    date: 'তারিখ',
    detail: 'বিবরণ',
    debit: 'জমা',
    credit: 'খরচ',
    balance: 'জের',
    opening: 'শুরুর জের',
    closing: 'শেষের জের',
    dueDate: 'নির্ধারিত তারিখ',
    amount: 'পরিমাণ',
    paidOn: 'পরিশোধের তারিখ',
    status: 'অবস্থা',
    paid: 'পরিশোধিত',
    due: 'বাকি',
    total: 'মোট',
    print: 'প্রিন্ট বা PDF',
    empty: 'এই সময়ে কোনো লেনদেন নেই।',
    issuedBy: 'দিয়েছেন',
    note: 'এটি একটি পঠন-মাত্র বিবরণী। প্রশ্ন থাকলে যিনি পাঠিয়েছেন তাঁকে জানান।',
  },
  en: {
    statement: 'Statement',
    period: 'Period',
    wholeLife: 'From the beginning to today',
    date: 'Date',
    detail: 'Detail',
    debit: 'In',
    credit: 'Out',
    balance: 'Balance',
    opening: 'Opening',
    closing: 'Closing',
    dueDate: 'Due',
    amount: 'Amount',
    paidOn: 'Paid on',
    status: 'Status',
    paid: 'Paid',
    due: 'Outstanding',
    total: 'Total',
    print: 'Print or save as PDF',
    empty: 'Nothing in this period.',
    issuedBy: 'Issued by',
    note: 'A read-only statement. If anything looks wrong, tell whoever sent it.',
  },
};

export function StatementDocument({ statement }: { statement: PublicStatement }) {
  const t = T[statement.locale] ?? T.bn;
  const money = (minor: number): string =>
    formatMinor(minor, { currency: statement.currency, bengaliNumerals: false });

  const period =
    statement.from || statement.to
      ? `${statement.from ?? '…'} — ${statement.to ?? '…'}`
      : t.wholeLife;

  const ledgerRows = (statement.data.rows as Row[] | undefined) ?? null;
  const instalments = (statement.data.items as Instalment[] | undefined) ?? null;

  return (
    <main className="statement mx-auto w-full max-w-3xl px-4 py-6 print:max-w-none print:px-0 print:py-0">
      <header className="border-rule flex flex-wrap items-start justify-between gap-3 border-b pb-4">
        <div className="min-w-0">
          <p className="text-ink-muted text-xs uppercase tracking-wide">{t.statement}</p>
          <h1 className="text-ink mt-1 text-2xl font-semibold">{statement.title}</h1>
          {statement.subtitle ? (
            <p className="text-ink-muted text-sm">{statement.subtitle}</p>
          ) : null}
          <p className="text-ink-muted mt-2 text-sm">
            {t.period}: <span className="text-ink">{period}</span>
          </p>
        </div>
        <div className="text-right">
          <p className="text-ink-muted text-xs">{t.issuedBy}</p>
          <p className="text-ink font-medium">{statement.workspaceName}</p>
          {/* Hidden in print: a button on paper is furniture. */}
          <PrintButton label={t.print} />
        </div>
      </header>

      {ledgerRows ? (
        <LedgerTable rows={ledgerRows} data={statement.data} money={money} t={t} />
      ) : instalments ? (
        <InstalmentTable rows={instalments} data={statement.data} money={money} t={t} />
      ) : null}

      <p className="text-ink-muted mt-6 text-xs">{t.note}</p>
    </main>
  );
}

/**
 * The print control.
 *
 * Its own client component, and the only one on this page: everything else is
 * server-rendered HTML that a reader with scripting off can still print from
 * their browser's own menu. `window.print()` is what every phone and desktop
 * already has, so there is no PDF library on the server to keep patched, and
 * the output is a real selectable document rather than a picture of one.
 */

function LedgerTable({
  rows,
  data,
  money,
  t,
}: {
  rows: Row[];
  data: Record<string, unknown>;
  money: (minor: number) => string;
  t: Words;
}) {
  const opening = typeof data.openingMinor === 'number' ? data.openingMinor : 0;
  const closing = typeof data.closingMinor === 'number' ? data.closingMinor : 0;

  return (
    <>
      <dl className="border-rule mt-4 grid grid-cols-2 gap-3 border-b pb-4 text-sm sm:grid-cols-3">
        <Figure label={t.opening} value={money(opening)} />
        <Figure label={t.closing} value={money(closing)} strong />
      </dl>

      {/* Scrolls inside its own box on a narrow phone rather than making the
          page scroll sideways; prints at full width. */}
      <div className="mt-4 overflow-x-auto print:overflow-visible">
        <table className="w-full min-w-[34rem] border-collapse text-sm">
          <thead>
            <tr className="border-rule border-b text-left">
              <Th>{t.date}</Th>
              <Th>{t.detail}</Th>
              <Th align="right">{t.debit}</Th>
              <Th align="right">{t.credit}</Th>
              <Th align="right">{t.balance}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-ink-muted py-4 text-center">
                  {t.empty}
                </td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr key={`${row.date}-${i}`} className="border-rule border-b last:border-0">
                  <Td>{row.date}</Td>
                  <Td>{row.description ?? ''}</Td>
                  <Td align="right">{row.debitMinor ? money(row.debitMinor) : ''}</Td>
                  <Td align="right">{row.creditMinor ? money(row.creditMinor) : ''}</Td>
                  <Td align="right">{money(row.balanceMinor ?? 0)}</Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function InstalmentTable({
  rows,
  data,
  money,
  t,
}: {
  rows: Instalment[];
  data: Record<string, unknown>;
  money: (minor: number) => string;
  t: Words;
}) {
  const paid = typeof data.paidMinor === 'number' ? data.paidMinor : 0;
  const due = typeof data.dueMinor === 'number' ? data.dueMinor : 0;

  return (
    <>
      <dl className="border-rule mt-4 grid grid-cols-2 gap-3 border-b pb-4 text-sm sm:grid-cols-3">
        <Figure label={t.paid} value={money(paid)} />
        <Figure label={t.due} value={money(due)} />
        <Figure label={t.total} value={money(paid + due)} strong />
      </dl>

      <div className="mt-4 overflow-x-auto print:overflow-visible">
        <table className="w-full min-w-[30rem] border-collapse text-sm">
          <thead>
            <tr className="border-rule border-b text-left">
              <Th>{t.dueDate}</Th>
              <Th align="right">{t.amount}</Th>
              <Th>{t.paidOn}</Th>
              <Th>{t.status}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="text-ink-muted py-4 text-center">
                  {t.empty}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.dueDate} className="border-rule border-b last:border-0">
                  <Td>{row.dueDate}</Td>
                  <Td align="right">{money(row.expectedMinor)}</Td>
                  <Td>{row.paidDate ?? '—'}</Td>
                  <Td>{row.status === 'PAID' ? t.paid : t.due}</Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-muted text-xs">{label}</dt>
      <dd className={`money text-ink ${strong ? 'text-lg font-semibold' : ''}`}>{value}</dd>
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: 'right' }) {
  return (
    <th
      scope="col"
      className={`text-ink-muted py-2 pr-3 text-xs font-medium ${align === 'right' ? 'text-right' : ''}`}
    >
      {children}
    </th>
  );
}

function Td({ children, align }: { children: React.ReactNode; align?: 'right' }) {
  return (
    <td className={`text-ink py-2 pr-3 ${align === 'right' ? 'money text-right' : ''}`}>
      {children}
    </td>
  );
}
