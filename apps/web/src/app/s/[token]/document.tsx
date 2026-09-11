import { formatLedgerDate, formatMinor, fromLocalDateString, type Locale } from '@hishab/shared';
import Link from 'next/link';
import { BrandMark } from '@/components/brand-mark';
import { FooterAdBlock, type FooterAd } from '@/components/print-footer-ad';
import { PrintButton } from './print-button';

/**
 * The statement itself: a letterhead, the figures, and one invitation.
 *
 * ## Deliberately not the app
 *
 * No navigation, no bottom bar, nothing to tap that leads back into a product
 * the reader is not a customer of. They came to check a number. But it is also
 * the only page in this product a stranger ever sees, so "not the app" is not
 * the same as "unbranded" — it is laid out like a statement a bank would send,
 * with the mark at the top, an issuer, a subject, a reference and a date.
 *
 * ## Two renderings of the same rows
 *
 * A five-column table on a 320px phone is either a horizontal scrollbar or
 * unreadable type. Below `sm` each entry is a card — date and balance on one
 * line, the description under it, the amount to the right; above `sm`, and on
 * paper, the table. The alternative was one table that scrolls sideways, which
 * is what this page did first and what nobody does twice on a phone.
 *
 * ## Printing
 *
 * `window.print()`, which every phone and desktop already has. No PDF library
 * on the server: nothing to keep patched, and the output is a real selectable
 * document rather than a picture of one. The invitation at the bottom sits
 * outside `.statement` and is `print:hidden` — an advertisement on somebody's
 * printed financial record is exactly the wrong note.
 */

export interface PublicStatement {
  kind: 'PERSON' | 'LOAN' | 'SAVINGS' | 'INSURANCE' | 'GROUP';
  workspaceName: string;
  currency: string;
  locale: Locale;
  from: string | null;
  to: string | null;
  title: string;
  subtitle: string | null;
  reference: string;
  expiresAt: string;
  issuedAt: string;
  /**
   * The sponsored strip this workspace's documents carry, printed at the very
   * foot of the page and nowhere else.
   *
   * It travels with the statement rather than being fetched: nobody is signed
   * in on this page, and a second unauthenticated endpoint keyed by workspace
   * would let anybody holding one link enumerate which shops carry which
   * sponsor. Null for almost every workspace.
   */
  ad: FooterAd | null;
  data: Record<string, unknown>;
}

type Row = {
  date: string;
  description?: string | null;
  /**
   * The account or category on the other side, on an account statement.
   *
   * Absent on a loan or a party ledger, where every row already faces the same
   * counterparty and repeating their name down a column says nothing. On an
   * account statement it is the column that tells a withdrawal apart from a
   * payment for the same amount, so it is printed beneath the description
   * rather than given a column of its own — five columns already fill the width
   * a phone has, and this page must not scroll sideways.
   */
  contra?: string | null;
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

type GroupMember = {
  name: string;
  paidMinor: number;
  shareMinor: number;
  netMinor: number;
  left: boolean;
};

type GroupExpense = { date: string; description: string; payer: string; totalMinor: number };
type SettleUp = { from: string; to: string; amountMinor: number };

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
  | 'issuedBy'
  | 'subject'
  | 'reference'
  | 'issuedOn'
  | 'validUntil'
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
  | 'note'
  | 'ctaTitle'
  | 'ctaBody'
  | 'ctaButton'
  | 'ctaPricing'
  | 'groupTotal'
  | 'member'
  | 'memberPaid'
  | 'memberShare'
  | 'memberNet'
  | 'settleUp'
  | 'gets'
  | 'owes'
  | 'square'
  | 'paidBy'
  | 'left',
  string
>;

const T: Record<Locale, Words> = {
  bn: {
    statement: 'বিবরণী',
    period: 'সময়কাল',
    wholeLife: 'শুরু থেকে আজ পর্যন্ত',
    issuedBy: 'দিয়েছেন',
    subject: 'যাঁর হিসাব',
    reference: 'রেফারেন্স',
    issuedOn: 'তৈরির সময়',
    validUntil: 'লিংকের মেয়াদ',
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
    note: 'এটি একটি পঠন-মাত্র বিবরণী। প্রশ্ন থাকলে যিনি পাঠিয়েছেন তাঁকে জানান।',
    ctaTitle: 'এই হিসাবটা রাখা হয়েছে Taka Tracker দিয়ে',
    ctaBody:
      'আয়, খরচ, ধার-দেনা, সঞ্চয় আর বীমা — সব এক খাতায়, সম্পূর্ণ বাংলায়। নিজের হিসাব শুরু করুন।',
    ctaButton: 'ফ্রি অ্যাকাউন্ট খুলুন',
    ctaPricing: 'দাম দেখুন',
    groupTotal: 'মোট খরচ',
    member: 'কে',
    memberPaid: 'দিয়েছেন',
    memberShare: 'তার ভাগ',
    memberNet: 'পাবেন / দেবেন',
    settleUp: 'হিসাব মেটাতে',
    gets: 'পাবেন',
    owes: 'দেবেন',
    square: 'হিসাব শেষ',
    paidBy: 'দিয়েছেন',
    left: 'গ্রুপ ছেড়েছেন',
  },
  en: {
    statement: 'Statement',
    period: 'Period',
    wholeLife: 'From the beginning to today',
    issuedBy: 'Issued by',
    subject: 'Statement for',
    reference: 'Reference',
    issuedOn: 'Issued',
    validUntil: 'Link valid until',
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
    note: 'A read-only statement. If anything looks wrong, tell whoever sent it.',
    ctaTitle: 'These books are kept with Taka Tracker',
    ctaBody: 'Income, spending, loans, savings and insurance in one place. Start keeping your own.',
    ctaButton: 'Create a free account',
    ctaPricing: 'See pricing',
    groupTotal: 'Total spent',
    member: 'Who',
    memberPaid: 'Paid',
    memberShare: 'Their share',
    memberNet: 'Gets back / owes',
    settleUp: 'To settle up',
    gets: 'gets back',
    owes: 'owes',
    square: 'all square',
    paidBy: 'Paid by',
    left: 'left the group',
  },
};

export function StatementDocument({ statement }: { statement: PublicStatement }) {
  const t = T[statement.locale] ?? T.bn;

  /* Latin digits, because that is what every other screen in this product
     shows. `Money` defaults `bengaliNumerals: false`, so the owner's own
     dashboard reads ৳3,600.00 — and a statement rendered ৳৩,৬০০.০০ would be the
     same figure in a different script from the app it came out of. This is the
     copy a bank or an insurer keeps; it has to match.

     Dates stay in Bengali. Those are prose rather than figures, and a Bengali
     document with English month names reads wrong in the other direction. */
  const money = (minor: number): string =>
    formatMinor(minor, { currency: statement.currency, bengaliNumerals: false });

  /**
   * Dates in the reader's script, not ISO.
   *
   * The API speaks `YYYY-MM-DD` because that is what a date column is, and the
   * first version printed it straight through — so a Bengali statement was
   * headed `2026-03-01`. `formatLedgerDate` is the same function the owner's
   * own screens use, taking its locale from the workspace rather than from a
   * module-level setting there is nobody signed in to have set.
   */
  const date = (iso: string | null | undefined): string => {
    if (!iso) return '—';
    try {
      /* Two shapes arrive here. A ledger row carries `YYYY-MM-DD` — a calendar
         day, which must not be shifted by anybody's clock. The issue and expiry
         stamps are full instants, and slicing ten characters off those would
         print the UTC day: a link expiring at 01:00 in Dhaka would be dated the
         day before, on the one line telling the reader how long they have. */
      const when = iso.includes('T') ? new Date(iso) : fromLocalDateString(iso.slice(0, 10));
      return formatLedgerDate(when, statement.locale);
    } catch {
      /* Anything unparseable is shown as it arrived. A statement with one odd
         date is worth more than a statement with a gap in it. */
      return iso;
    }
  };

  const period =
    statement.from || statement.to
      ? `${statement.from ? date(statement.from) : '…'} — ${statement.to ? date(statement.to) : '…'}`
      : t.wholeLife;

  const ledgerRows = (statement.data.rows as Row[] | undefined) ?? null;
  const instalments = (statement.data.items as Instalment[] | undefined) ?? null;
  const groupMembers = (statement.data.members as GroupMember[] | undefined) ?? null;

  return (
    <div className="bg-paper min-h-dvh print:bg-white">
      <main className="statement mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-10 print:max-w-none print:px-0 print:py-0">
        {/* The letterhead. Brand on the left, what the document is on the
            right — the arrangement every bank statement, invoice and policy
            schedule uses, because it is the one a reader already knows. */}
        <header className="border-rule flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b pb-4">
          <BrandMark size="md" />
          <div className="text-right">
            <p className="text-ink-muted text-xs font-medium uppercase tracking-wide">
              {t.statement}
            </p>
            <p className="text-ink-muted mt-0.5 text-xs">
              {t.reference}: <span className="money text-ink">{statement.reference}</span>
            </p>
          </div>
        </header>

        {/* Whose account this is, as the document's one heading. It was briefly
            demoted to a labelled cell beside the others while this page was
            being made to look like a statement, which left the page with no
            heading at all — invisible on screen, and the first thing a screen
            reader looks for. */}
        <div className="mt-5">
          <p className="text-ink-muted text-xs">{t.subject}</p>
          <h1 className="text-ink break-words text-2xl font-semibold">{statement.title}</h1>
          {statement.subtitle ? (
            <p className="text-ink-muted break-words text-sm">{statement.subtitle}</p>
          ) : null}
        </div>

        {/* Issuer and period: what a reader checks before reading a figure. */}
        <section className="mt-4 flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            <Block label={t.issuedBy} value={statement.workspaceName} />
            <Block label={t.period} value={period} />
          </div>
          <div className="print:hidden">
            <PrintButton label={t.print} />
          </div>
        </section>

        {groupMembers ? (
          <GroupTables data={statement.data} money={money} date={date} t={t} />
        ) : ledgerRows ? (
          <LedgerTable rows={ledgerRows} data={statement.data} money={money} date={date} t={t} />
        ) : instalments ? (
          <InstalmentTable
            rows={instalments}
            data={statement.data}
            money={money}
            date={date}
            t={t}
          />
        ) : null}

        <footer className="border-rule text-ink-muted mt-8 space-y-1 border-t pt-4 text-xs">
          <p>{t.note}</p>
          <p>
            {t.issuedOn}: {date(statement.issuedAt)} · {t.validUntil}: {date(statement.expiresAt)}
          </p>
          {/* Not a link. On paper a URL is useful; on screen an anchor here is
              one stray tap away from a reader losing the page they were sent. */}
          <p className="text-ink-muted">takatracker.com</p>
        </footer>

        {/* Paper only, and below the document's own footer: the strip a super
            admin sold on this workspace's printed statements. It is hidden on
            screen for the same reason the signup card below is hidden in print
            — a reader holding a financial record should not have to sort
            advertising out of it on the medium they are reading it in. */}
        <FooterAdBlock ad={statement.ad} />
      </main>

      {/* Outside `.statement`, and gone in print. The reader is welcome to keep
          their own books; they are not welcome to find an advertisement in the
          middle of a financial record they were sent. */}
      <aside className="mx-auto w-full max-w-3xl px-4 pb-10 sm:px-6 print:hidden">
        <div className="rounded-card border-rule bg-surface flex flex-col gap-4 border p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-ink font-semibold">{t.ctaTitle}</p>
            <p className="text-ink-muted mt-1 text-sm">{t.ctaBody}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Link
              href={statement.locale === 'en' ? '/signup?lang=en' : '/signup'}
              className="press bg-brand text-brand-contrast hover:bg-brand-strong inline-flex min-h-11 items-center rounded-md px-4 text-sm font-medium"
            >
              {t.ctaButton}
            </Link>
            <Link
              href={statement.locale === 'en' ? '/en/pricing' : '/pricing'}
              className="press border-rule text-ink hover:bg-greenbar inline-flex min-h-11 items-center rounded-md border px-4 text-sm"
            >
              {t.ctaPricing}
            </Link>
          </div>
        </div>
      </aside>
    </div>
  );
}

/** One labelled fact in the header block. */
function Block({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-ink-muted text-xs">{label}</p>
      <p className="text-ink break-words font-medium">{value}</p>
    </div>
  );
}

function LedgerTable({
  rows,
  data,
  money,
  date,
  t,
}: {
  rows: Row[];
  data: Record<string, unknown>;
  money: (minor: number) => string;
  date: (iso: string | null | undefined) => string;
  t: Words;
}) {
  const opening = typeof data.openingMinor === 'number' ? data.openingMinor : 0;
  const closing = typeof data.closingMinor === 'number' ? data.closingMinor : 0;

  return (
    <>
      <dl className="border-rule mt-5 grid grid-cols-2 gap-3 border-y py-4 text-sm">
        <Figure label={t.opening} value={money(opening)} />
        <Figure label={t.closing} value={money(closing)} strong />
      </dl>

      {rows.length === 0 ? (
        <Empty>{t.empty}</Empty>
      ) : (
        <>
          {/* Phone: one card per entry. No sideways scrolling on the only page
              in this product a stranger sees. */}
          <ul className="divide-rule mt-2 divide-y sm:hidden print:hidden">
            {rows.map((row, i) => (
              <li key={`${row.date}-${i}`} className="py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-ink text-sm font-medium">{date(row.date)}</span>
                  <span className="money text-ink text-sm font-semibold">
                    {money(row.balanceMinor ?? 0)}
                  </span>
                </div>
                {row.description ? (
                  <p className="text-ink-muted mt-0.5 break-words text-sm">{row.description}</p>
                ) : null}
                {row.contra ? (
                  <p className="text-ink-muted mt-0.5 break-words text-xs">{row.contra}</p>
                ) : null}
                <p className="text-ink-muted mt-1 text-xs">
                  {row.debitMinor ? `${t.debit} ${money(row.debitMinor)}` : null}
                  {row.debitMinor && row.creditMinor ? ' · ' : null}
                  {row.creditMinor ? `${t.credit} ${money(row.creditMinor)}` : null}
                </p>
              </li>
            ))}
          </ul>

          <table className="mt-4 hidden w-full border-collapse text-sm sm:table print:table">
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
              {rows.map((row, i) => (
                <tr key={`${row.date}-${i}`} className="border-rule border-b last:border-0">
                  <Td>{date(row.date)}</Td>
                  <Td>
                    {row.description ?? ''}
                    {row.contra ? (
                      <span className="text-ink-muted block text-xs">{row.contra}</span>
                    ) : null}
                  </Td>
                  <Td align="right">{row.debitMinor ? money(row.debitMinor) : ''}</Td>
                  <Td align="right">{row.creditMinor ? money(row.creditMinor) : ''}</Td>
                  <Td align="right">{money(row.balanceMinor ?? 0)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

function InstalmentTable({
  rows,
  data,
  money,
  date,
  t,
}: {
  rows: Instalment[];
  data: Record<string, unknown>;
  money: (minor: number) => string;
  date: (iso: string | null | undefined) => string;
  t: Words;
}) {
  const paid = typeof data.paidMinor === 'number' ? data.paidMinor : 0;
  const due = typeof data.dueMinor === 'number' ? data.dueMinor : 0;

  return (
    <>
      <dl className="border-rule mt-5 grid grid-cols-2 gap-3 border-y py-4 text-sm sm:grid-cols-3">
        <Figure label={t.paid} value={money(paid)} />
        <Figure label={t.due} value={money(due)} />
        <Figure label={t.total} value={money(paid + due)} strong />
      </dl>

      {rows.length === 0 ? (
        <Empty>{t.empty}</Empty>
      ) : (
        <>
          <ul className="divide-rule mt-2 divide-y sm:hidden print:hidden">
            {rows.map((row) => (
              <li key={row.dueDate} className="py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-ink text-sm font-medium">{date(row.dueDate)}</span>
                  <span className="money text-ink text-sm font-semibold">
                    {money(row.expectedMinor)}
                  </span>
                </div>
                <p className="text-ink-muted mt-1 text-xs">
                  {row.status === 'PAID' ? `${t.paid} · ${date(row.paidDate)}` : t.due}
                </p>
              </li>
            ))}
          </ul>

          <table className="mt-4 hidden w-full border-collapse text-sm sm:table print:table">
            <thead>
              <tr className="border-rule border-b text-left">
                <Th>{t.dueDate}</Th>
                <Th align="right">{t.amount}</Th>
                <Th>{t.paidOn}</Th>
                <Th>{t.status}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.dueDate} className="border-rule border-b last:border-0">
                  <Td>{date(row.dueDate)}</Td>
                  <Td align="right">{money(row.expectedMinor)}</Td>
                  <Td>{date(row.paidDate)}</Td>
                  <Td>{row.status === 'PAID' ? t.paid : t.due}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

/**
 * A trip or an event, as the people who were on it need to read it.
 *
 * Two tables and a list, in the order somebody asks the questions: where do I
 * stand, what did we spend it on, and who should pay whom. The settle-up list
 * is the reason most people open the link at all — working "you owe Karim
 * ৳2,000" out of three columns is exactly the arithmetic that gets done wrong
 * and then argued about.
 */
function GroupTables({
  data,
  money,
  date,
  t,
}: {
  data: Record<string, unknown>;
  money: (minor: number) => string;
  date: (iso: string | null | undefined) => string;
  t: Words;
}) {
  const members = (data.members as GroupMember[] | undefined) ?? [];
  const expenses = (data.expenses as GroupExpense[] | undefined) ?? [];
  const settleUp = (data.settleUp as SettleUp[] | undefined) ?? [];
  const total = typeof data.totalMinor === 'number' ? data.totalMinor : 0;

  return (
    <>
      <dl className="border-rule mt-5 grid grid-cols-2 gap-3 border-y py-4 text-sm">
        <Figure label={t.groupTotal} value={money(total)} strong />
      </dl>

      {/* Phone: one card per person. */}
      <ul className="divide-rule mt-2 divide-y sm:hidden print:hidden">
        {members.map((m) => (
          <li key={m.name} className="py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-ink text-sm font-medium">
                {m.name}
                {m.left ? <span className="text-ink-muted ml-1 text-xs">· {t.left}</span> : null}
              </span>
              <span className="money text-ink text-sm font-semibold">
                {m.netMinor === 0
                  ? t.square
                  : `${money(Math.abs(m.netMinor))} ${m.netMinor > 0 ? t.gets : t.owes}`}
              </span>
            </div>
            <p className="text-ink-muted mt-0.5 text-xs">
              {t.memberPaid} {money(m.paidMinor)} · {t.memberShare} {money(m.shareMinor)}
            </p>
          </li>
        ))}
      </ul>

      <table className="mt-4 hidden w-full border-collapse text-sm sm:table print:table">
        <thead>
          <tr className="border-rule border-b text-left">
            <Th>{t.member}</Th>
            <Th align="right">{t.memberPaid}</Th>
            <Th align="right">{t.memberShare}</Th>
            <Th align="right">{t.memberNet}</Th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.name} className="border-rule border-b last:border-0">
              <Td>
                {m.name}
                {m.left ? <span className="text-ink-muted ml-1 text-xs">· {t.left}</span> : null}
              </Td>
              <Td align="right">{money(m.paidMinor)}</Td>
              <Td align="right">{money(m.shareMinor)}</Td>
              <Td align="right">{m.netMinor === 0 ? t.square : money(m.netMinor)}</Td>
            </tr>
          ))}
        </tbody>
      </table>

      {settleUp.length > 0 ? (
        <div className="mt-6">
          <h2 className="text-ink text-sm font-semibold">{t.settleUp}</h2>
          <ul className="divide-rule border-rule mt-2 divide-y border-t">
            {settleUp.map((s, i) => (
              <li
                key={`${s.from}-${s.to}-${i}`}
                className="flex justify-between gap-3 py-2 text-sm"
              >
                <span className="text-ink min-w-0 truncate">
                  {s.from} → {s.to}
                </span>
                <span className="money text-ink shrink-0 font-medium">{money(s.amountMinor)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {expenses.length > 0 ? (
        <table className="mt-6 w-full border-collapse text-sm">
          <thead>
            <tr className="border-rule border-b text-left">
              <Th>{t.date}</Th>
              <Th>{t.detail}</Th>
              <Th>{t.paidBy}</Th>
              <Th align="right">{t.amount}</Th>
            </tr>
          </thead>
          <tbody>
            {expenses.map((e, i) => (
              <tr key={`${e.date}-${i}`} className="border-rule border-b last:border-0">
                <Td>{date(e.date)}</Td>
                <Td>{e.description}</Td>
                <Td>{e.payer}</Td>
                <Td align="right">{money(e.totalMinor)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>{t.empty}</Empty>
      )}
    </>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-ink-muted mt-6 text-center text-sm">{children}</p>;
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-muted text-xs">{label}</dt>
      <dd className={`money text-ink break-words ${strong ? 'text-lg font-semibold' : ''}`}>
        {value}
      </dd>
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
    <td className={`text-ink py-2 pr-3 align-top ${align === 'right' ? 'money text-right' : ''}`}>
      {children}
    </td>
  );
}
