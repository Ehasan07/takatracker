'use client';

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  HandCoins,
  Archive,
  ArchiveRestore,
  BellOff,
  FileUp,
  Pencil,
  PiggyBank,
  Plus,
  FileText,
  Scale,
  TrendingUp,
  Tags,
} from '@/components/icons';
import * as React from 'react';
import { formatMinor, parseMoneyToMinor, toLocalDateString } from '@hishab/shared';
import { CardAmount } from '@/components/card-amount';
import { Money } from '@/components/money';
import { Button } from '@/components/ui/button';
import { CategoryOptions, type CategoryScope } from '@/components/category-options';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { SkeletonRows } from '@/components/skeleton';
import { api, ApiError, endpoints, FeatureLimitError, type AccountDto } from '@/lib/api';
import { t } from '@/lib/t';
import { fmtDate, fmtNumber } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import { useWorkspaceSettings } from '@/lib/workspace-settings';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { UsageMeter } from '@/components/usage-meter';

/* The Bengali stays here beside the key, and the lookup happens at render:
   a module-level constant is evaluated before a workspace's wording override
   has been fetched. */
const ACCOUNT_TYPES: { value: string; label: string; group: string }[] = [
  { value: 'CASH', label: t('account.type.cash', 'নগদ'), group: 'liquid' },
  { value: 'BANK', label: t('account.type.bank', 'ব্যাংক'), group: 'liquid' },
  { value: 'MOBILE_WALLET', label: t('account.type.wallet', 'মোবাইল ওয়ালেট'), group: 'liquid' },
  { value: 'SAVINGS', label: t('account.type.savings', 'সঞ্চয় / ডিপিএস'), group: 'liquid' },
  { value: 'ASSET', label: t('account.type.asset', 'সম্পদ (জমি, স্বর্ণ, গাড়ি)'), group: 'asset' },
  {
    value: 'RECEIVABLE',
    label: t('account.type.receivable', 'পাওনা (যা আমি পাব)'),
    group: 'asset',
  },
  { value: 'CREDIT_CARD', label: t('account.type.card', 'ক্রেডিট কার্ড'), group: 'liability' },
  { value: 'LIABILITY', label: t('account.type.liability', 'ঋণ / দায়'), group: 'liability' },
  { value: 'PAYABLE', label: t('account.type.payable', 'দেনা (যা আমি দেব)'), group: 'liability' },
];

/**
 * Two of those cannot be made by hand any more.
 *
 * `ঋণ` already records what somebody owes: against a person, in a direction,
 * with instalments, under one control account per direction and a sub-ledger
 * per name — which is how IAS 32.42 wants it, receivable and payable kept
 * apart rather than netted into a figure.
 *
 * A hand-made পাওনা account was a second, weaker way to say the same thing,
 * and the two together let one debt be written twice: fifty thousand in ঋণ and
 * fifty thousand in an account of the same name is a lakh of net worth that
 * does not exist. So the types stay — the loan control accounts are made of
 * them, and existing rows still render by these labels — but nobody is offered
 * one to fill in.
 */
const CREATABLE_TYPES = ACCOUNT_TYPES.filter(
  (entry) => entry.value !== 'RECEIVABLE' && entry.value !== 'PAYABLE',
);

/**
 * The accounts whose value can change without a transaction.
 *
 * Cash does not appreciate. If a wallet disagrees with the ledger one of them is
 * wrong, and the fix is a reconciliation — offering a revaluation there would
 * let a bookkeeping error be filed as a market gain.
 */
const REVALUABLE = new Set(['ASSET', 'LIABILITY']);

const TYPE_GROUPS = ['liquid', 'asset', 'liability'] as const;

const GROUP_LABELS: Record<(typeof TYPE_GROUPS)[number], string> = {
  liquid: t('account.group.liquid', 'হাতে ও ব্যাংকে'),
  asset: t('account.group.asset', 'সম্পদ'),
  liability: t('account.group.liability', 'দায়'),
};

/**
 * A tint per group, and never the only signal.
 *
 * Green for what is held, red for what is owed, brass for what is owned but
 * cannot be spent this month. The heading names the group in words and every
 * figure carries its sign, because colour alone fails in sunlight and fails
 * about one man in twelve outright.
 */
const GROUP_TINT: Record<(typeof TYPE_GROUPS)[number], string> = {
  liquid: 'bg-income/10 text-income',
  asset: 'bg-brass/10 text-brass',
  liability: 'bg-expense/10 text-expense',
};

const groupLabel = (group: (typeof TYPE_GROUPS)[number]): string =>
  t(`account.group.${group}`, GROUP_LABELS[group]);

/**
 * The three balance-sheet groups, plus the accounts no total can speak for.
 *
 * `foreign` is not a fourth kind of account — it cuts across all three. It is a
 * section on this list because the other three headers each carry a subtotal,
 * and a subtotal is precisely what cannot be written across two currencies
 * without a rate this app does not have.
 */
type ListSection = (typeof TYPE_GROUPS)[number] | 'foreign';

/** Neutral, deliberately: excluded is not the same as owed. */
const SECTION_TINT: Record<ListSection, string> = {
  ...GROUP_TINT,
  foreign: 'bg-greenbar text-ink-muted',
};

const sectionLabel = (section: ListSection): string =>
  section === 'foreign'
    ? t('account.group.foreign', 'অন্য মুদ্রার অ্যাকাউন্ট')
    : groupLabel(section);

/** Which of the three an account type belongs to. `liquid` when unknown. */
const groupOfType = (type: string): (typeof TYPE_GROUPS)[number] =>
  (ACCOUNT_TYPES.find((entry) => entry.value === type)?.group as
    (typeof TYPE_GROUPS)[number] | undefined) ?? 'liquid';

/** Offered only because the row draws it — see AccountAvatar. */
const ACCOUNT_COLORS: { value: string; key: string; label: string }[] = [
  { value: '#0F7B4F', key: 'green', label: t('colour.green', 'সবুজ') },
  { value: '#1E5EB8', key: 'blue', label: t('colour.blue', 'নীল') },
  { value: '#B26A00', key: 'gold', label: t('colour.gold', 'সোনালি') },
  { value: '#B3261E', key: 'red', label: t('colour.red', 'লাল') },
  { value: '#6B3FA0', key: 'purple', label: t('colour.purple', 'বেগুনি') },
  { value: '#3F4A55', key: 'grey', label: t('colour.grey', 'ধূসর') },
];

const typeLabel = (value: string): string => {
  const hit = ACCOUNT_TYPES.find((type) => type.value === value);
  return hit ? t(`account.type.${hit.value}`, hit.label) : value;
};

/**
 * An account edit moves money. The opening balance and the type change today's
 * balance, the ledger's running balance, this month's summary and the balance
 * sheet; archiving frees a slot in the plan. Everything that reads any of that
 * is stale the moment one of these mutations lands.
 */
function invalidateAccountData(queryClient: QueryClient): void {
  for (const key of [
    ['accounts'],
    ['transactions'],
    ['summary'],
    ['reports'],
    ['entitlements'],
    // Loan screens name the account the money moved through.
    ['loans'],
  ]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

export default function AccountsPage() {
  const queryClient = useQueryClient();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });
  const entitlements = useQuery({ queryKey: ['entitlements'], queryFn: endpoints.entitlements });
  const [addOpen, setAddOpen] = React.useState(false);
  const [reconciling, setReconciling] = React.useState<AccountDto | null>(null);
  const [revaluing, setRevaluing] = React.useState<AccountDto | null>(null);
  /** The asset being sold. `null` closes the sheet. */
  const [selling, setSelling] = React.useState<AccountDto | null>(null);
  const [editing, setEditing] = React.useState<AccountDto | null>(null);
  const [archiving, setArchiving] = React.useState<AccountDto | null>(null);
  const [showArchived, setShowArchived] = React.useState(false);

  /* Kept in its own key rather than widening ['accounts']: the total above, the
     plan meter and every account picker in the app read that key and must go on
     seeing live accounts only. */
  const archived = useQuery({
    queryKey: ['accounts', 'archived'],
    queryFn: () => api<AccountDto[]>('/accounts?includeArchived=true'),
    enabled: showArchived,
    select: (rows: AccountDto[]) => rows.filter((a) => a.isArchived),
  });

  const muteReminders = useMutation({
    mutationFn: (accountId: string) =>
      api<{ cycleMonth: string }>(`/cards/${accountId}/mute-reminders`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: () => void queryClient.invalidateQueries(),
  });

  /* DELETE archives; history is never thrown away. The API refuses for a system
     account and for the control account of a loan that is still running, both
     with a sentence of its own — carried into the confirmation sheet. */
  const archive = useMutation({
    mutationFn: (accountId: string) => api(`/accounts/${accountId}`, { method: 'DELETE' }),
    onSuccess: () => {
      haptic('success');
      invalidateAccountData(queryClient);
      setArchiving(null);
    },
  });

  const restore = useMutation({
    mutationFn: (accountId: string) =>
      api<AccountDto>(`/accounts/${accountId}`, { method: 'PATCH', body: { isArchived: false } }),
    onSuccess: () => {
      haptic('success');
      invalidateAccountData(queryClient);
    },
  });

  /**
   * Four figures, because one was a lie.
   *
   * This used to be a single "মোট" that added every account together — cash,
   * a plot of land, a credit card. IAS 7.6 defines cash and cash equivalents
   * narrowly (cash in hand, demand deposits, and investments of three months or
   * less whose value cannot really move), and land is none of those; IAS 1.32
   * says assets and liabilities are not offset into one number at all. So a
   * ৳12,00,000 plot was quietly being reported as money in hand.
   *
   * The sum of the three groups is exactly what that number was — it was net
   * worth wearing the word "total". It keeps its place at the bottom, under the
   * name of the thing it actually is.
   */
  /**
   * The accounts the four figures can speak for, and the ones they cannot.
   *
   * A balance is an integer in *its own* account's minor unit, and this app
   * converts nothing: `LedgerEntry.fxRate` is an `Int` column that every writer
   * sets to 1 and no query anywhere reads a rate. So adding a USD account's
   * $500 into the taka subtotal below would be a rate of 1.00 asserted by
   * accident — which is what these figures used to do.
   *
   * Converting honestly is IAS 21: the spot rate on each transaction's own date
   * (21.21), monetary balances retranslated at the closing rate (21.23(a)), and
   * the difference that falls out recognised in profit or loss (21.28). None of
   * that exists yet. Until it does the totals state their scope and the foreign
   * accounts are shown separately, in their own money.
   *
   * The same split by the same rule runs on the server in
   * `AccountsService.position` and on the dashboard. Case-insensitive because
   * `Account.currency` is a free three-character string nothing upper-cases on
   * the way in; deferred until `/auth/me` lands so the first paint never
   * mislabels an account while the workspace's currency is still a guess.
   */
  const { currency: homeCurrency, ready: currencyReady } = useWorkspaceSettings();
  const [homeAccounts, foreignAccounts] = React.useMemo(() => {
    const rows = accounts.data ?? [];
    if (!currencyReady) return [rows, [] as AccountDto[]] as const;
    const home = homeCurrency.toUpperCase();
    return [
      rows.filter((a) => a.currency.toUpperCase() === home),
      rows.filter((a) => a.currency.toUpperCase() !== home),
    ] as const;
  }, [accounts.data, homeCurrency, currencyReady]);

  const subtotals = React.useMemo(() => {
    const sums: Record<(typeof TYPE_GROUPS)[number], number> = {
      liquid: 0,
      asset: 0,
      liability: 0,
    };
    for (const account of homeAccounts) {
      sums[groupOfType(account.type)] += account.balanceMinor;
    }
    return sums;
  }, [homeAccounts]);

  const netWorth = subtotals.liquid + subtotals.asset + subtotals.liability;

  /* The list in the same three parts as the figures above, and in the same
     order a balance sheet reads. A flat list put a plot of land between two
     bank accounts. */
  const grouped = React.useMemo(
    () =>
      TYPE_GROUPS.map(
        (group) => [group, homeAccounts.filter((a) => groupOfType(a.type) === group)] as const,
      ).filter(([, rows]) => rows.length > 0),
    [homeAccounts],
  );

  /* A fourth section, and only when there is something to put in it.
   *
   * The foreign accounts are not hidden and not moved off this screen — they
   * are still edited, still reconciled, still have a statement. They are simply
   * kept out of the three sections whose headers carry a subtotal, because a
   * subtotal that mixed currencies would be the exact number this change
   * exists to stop printing. A workspace with no foreign account never sees the
   * word currency anywhere on this page. */
  const sections: readonly (readonly [ListSection, AccountDto[]])[] = React.useMemo(
    () =>
      foreignAccounts.length > 0 ? [...grouped, ['foreign', foreignAccounts] as const] : grouped,
    [grouped, foreignAccounts],
  );

  const accountLimit = entitlements.data?.entitlements['accounts.max'] ?? null;
  const accountsUsed = entitlements.data?.usage['accounts.max'] ?? 0;
  const atLimit = accountLimit !== null && accountsUsed >= accountLimit;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-ink hidden text-xl font-semibold sm:text-2xl md:block">
          {t('nav.accounts', 'অ্যাকাউন্ট')}
        </h1>
        <div className="flex items-center gap-2">
          {/* Accounts say what you have; categories say where money goes. Both
              answer "what do I keep books with", so they sit together. */}
          <Link
            href="/import"
            className="press border-rule text-ink hover:bg-greenbar flex min-h-11 items-center gap-1.5 rounded-md border px-3 text-sm"
          >
            <FileUp className="h-4 w-4" aria-hidden />
            আমদানি
          </Link>
          <Link
            href="/savings"
            className="press border-rule text-ink hover:bg-greenbar flex min-h-11 items-center gap-1.5 rounded-md border px-3 text-sm"
          >
            <PiggyBank className="h-4 w-4" aria-hidden />
            সঞ্চয়
          </Link>
          <Link
            href="/categories"
            className="press border-rule text-ink hover:bg-greenbar flex min-h-11 items-center gap-1.5 rounded-md border px-3 text-sm"
          >
            <Tags className="h-4 w-4" aria-hidden />
            ক্যাটাগরি
          </Link>
          <Button
            onClick={() => setAddOpen(true)}
            size="sm"
            disabled={atLimit}
            title={atLimit ? t('account.atLimit', 'প্ল্যানের সীমা শেষ') : undefined}
          >
            <Plus className="h-4 w-4" aria-hidden />
            {t('common.new', 'নতুন')}
          </Button>
        </div>
      </header>

      <section className="rounded-card border-rule bg-surface border p-4">
        {/* The headline is cash and cash equivalents alone — the only figure
            that answers "how much can I spend today". */}
        <p className="text-ink-muted text-sm">{t('account.total.liquid', 'হাতে ও ব্যাংকে')}</p>
        <Money minor={subtotals.liquid} colored className="text-2xl font-semibold" />

        <dl className="text-ink-muted mt-3 flex flex-col gap-1 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt>{t('account.total.asset', 'সম্পদ (জমি, স্বর্ণ, পাওনা)')}</dt>
            <dd>
              <Money minor={subtotals.asset} signed colored />
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt>{t('account.total.liability', 'দায় (কার্ড, ঋণ, দেনা)')}</dt>
            <dd>
              <Money minor={subtotals.liability} signed colored />
            </dd>
          </div>
          <div className="border-rule text-ink flex items-center justify-between gap-3 border-t pt-1 font-medium">
            <dt>{t('account.total.net', 'নিট সম্পদ')}</dt>
            <dd>
              <Money minor={netWorth} signed colored />
            </dd>
          </div>
        </dl>

        {/* What the four figures above do *not* cover, said where they are read
            rather than in a footnote further down. Only when it applies. */}
        {foreignAccounts.length > 0 ? (
          <p className="text-brass mt-2 text-xs">
            {t(
              'account.foreignExcluded',
              'উপরের চারটি হিসাবের বাইরে {n}টি অ্যাকাউন্ট রয়েছে — সেগুলো অন্য মুদ্রায় রাখা, আর অ্যাপ এখনও মুদ্রা রূপান্তর করে না। নিচে নিজের মুদ্রাতেই দেখানো হলো।',
            ).replace('{n}', fmtNumber(String(foreignAccounts.length)))}
          </p>
        ) : null}
        <UsageMeter
          className="mt-3"
          label={t('nav.accounts', 'অ্যাকাউন্ট')}
          used={accountsUsed}
          limit={accountLimit}
        />
        {atLimit ? (
          <p className="text-brass mt-2 text-xs">
            {t(
              'account.atLimitHint',
              'প্ল্যানের সীমা শেষ। পুরনো অ্যাকাউন্টের নামে চাপ দিয়ে সেটি আর্কাইভ করুন, অথবা প্ল্যান আপগ্রেড করুন।',
            )}
          </p>
        ) : null}
      </section>

      {accounts.isLoading ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border">
          <SkeletonRows rows={3} />
        </div>
      ) : accounts.data?.length === 0 ? (
        <div className="rounded-card border-rule border border-dashed p-8 text-center">
          <p className="text-ink">{t('account.empty', 'এখনও কোনো অ্যাকাউন্ট নেই।')}</p>
          <Button className="mt-3" onClick={() => setAddOpen(true)}>
            প্রথম অ্যাকাউন্ট যোগ করুন
          </Button>
        </div>
      ) : (
        <ul className="rounded-card border-rule bg-surface overflow-hidden border">
          {sections.flatMap(([group, rows]) => [
            <li
              key={`head-${group}`}
              className={`border-rule flex items-center justify-between gap-2 border-b px-3 py-2 text-xs font-medium ${SECTION_TINT[group]}`}
            >
              <span>{sectionLabel(group)}</span>
              {/* No subtotal for the foreign section, and that absence is the
                  point: adding dollars to yuan needs a rate, and IAS 21.23(a)
                  would want the closing one — the app has neither stored. A
                  count is the most this header can honestly say. */}
              {group === 'foreign' ? (
                <span className="shrink-0">
                  {t('account.foreignCount', '{n}টি — কোনো যোগফলে ধরা হয়নি').replace(
                    '{n}',
                    fmtNumber(String(rows.length)),
                  )}
                </span>
              ) : (
                <Money
                  minor={rows.reduce((sum, a) => sum + a.balanceMinor, 0)}
                  signed
                  className="shrink-0"
                />
              )}
            </li>,
            ...rows.map((account) => (
              <li
                key={account.id}
                /* `flex-wrap`, and the name is `basis-full` below md.
 
                   Four icon buttons at 44px each plus a figure left a card's
                   name 60px on a 390px screen, so the list read `S…`, `C..`,
                   `UCBL-BD…` — four rows of nothing anybody can tell apart. The
                   name takes its own line on a phone and the icons and the
                   figure share the one below it; from md up the row is what it
                   always was. */
                className="ledger-row border-rule flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2 last:border-b-0"
              >
                {/* The whole name block opens the editor: a fourth icon button
                  would leave nothing of the name at 320px. */}
                <button
                  type="button"
                  aria-label={`${account.name} — ${t('common.edit', 'সম্পাদনা')}`}
                  onClick={() => {
                    haptic('tap');
                    setEditing(account);
                  }}
                  className="press flex min-h-11 min-w-0 flex-1 basis-full items-center gap-2 rounded-md text-left md:basis-0"
                >
                  <AccountAvatar account={account} />
                  <span className="min-w-0 flex-1">
                    <span className="text-ink block truncate text-sm font-medium">
                      {account.name}
                    </span>
                    <span className="text-ink-muted block truncate text-xs">
                      {typeLabel(account.type)}
                      {account.accountNumberMasked ? ` · ${account.accountNumberMasked}` : ''}
                      {account.dueDayOfMonth
                        ? ` · ${t('account.dueOn', 'প্রতি মাসের {day} তারিখে পেমেন্ট').replace('{day}', fmtNumber(String(account.dueDayOfMonth)))}`
                        : ''}
                    </span>

                    {/* Three figures, because the balance alone answers only
                        one of the questions a card raises. The room left is
                        never added to anything: it is the bank's money until it
                        is spent, and spending it starts interest. */}
                  </span>
                  <Pencil className="text-ink-muted h-3.5 w-3.5 shrink-0" aria-hidden />
                </button>
                {account.dueDayOfMonth ? (
                  <button
                    type="button"
                    aria-label={`${account.name} — ${t('account.muteReminder', 'এই মাসের রিমাইন্ডার বন্ধ করুন')}`}
                    title={t('account.muteReminder', 'এই মাসের রিমাইন্ডার বন্ধ করুন')}
                    onClick={() => muteReminders.mutate(account.id)}
                    className="press touch-target text-ink-muted hover:bg-greenbar flex shrink-0 items-center justify-center rounded-md"
                  >
                    <BellOff className="h-4 w-4" aria-hidden />
                  </button>
                ) : null}
                {/* The account's own statement: opening balance, every movement,
                  closing balance. The question "when did money go in and out of
                  this one?" had no answer anywhere before this link. */}
                <Link
                  href={`/accounts/${account.id}/statement`}
                  aria-label={`${account.name} — ${t('account.statement', 'হিসাব বিবরণী')}`}
                  title={t('account.statement', 'হিসাব বিবরণী')}
                  className="press touch-target text-ink-muted hover:bg-greenbar flex shrink-0 items-center justify-center rounded-md"
                >
                  <FileText className="h-4 w-4" aria-hidden />
                </Link>
                {/* Two different questions wearing one icon would be worse than
                  two icons. Cash and bank accounts get "মেলান" — the ledger may
                  be wrong about money that already exists. Land, gold and a car
                  get "মূল্যায়ন" — the ledger is right and the world moved. */}
                {/* Selling is only ever offered on an asset, and only while it
                    is still owned. Revaluing says the world moved; selling says
                    it is somebody else's now — the third question on this row,
                    and the only one that turns a paper gain into a real one. */}
                {account.type === 'ASSET' && !account.isArchived ? (
                  <button
                    type="button"
                    aria-label={`${account.name} — ${t('account.sell', 'বিক্রি')}`}
                    title={t('account.sell', 'বিক্রি')}
                    onClick={() => setSelling(account)}
                    className="press touch-target text-ink-muted hover:bg-greenbar flex shrink-0 items-center justify-center rounded-md"
                  >
                    <HandCoins className="h-4 w-4" aria-hidden />
                  </button>
                ) : null}
                {REVALUABLE.has(account.type) ? (
                  <button
                    type="button"
                    aria-label={`${account.name} — ${t('account.revalue', 'মূল্যায়ন')}`}
                    onClick={() => setRevaluing(account)}
                    className="press touch-target text-ink-muted hover:bg-greenbar flex shrink-0 items-center justify-center rounded-md"
                  >
                    <TrendingUp className="h-4 w-4" aria-hidden />
                  </button>
                ) : (
                  <button
                    type="button"
                    aria-label={`${account.name} — ${t('account.reconcile', 'মেলান')}`}
                    onClick={() => setReconciling(account)}
                    className="press touch-target text-ink-muted hover:bg-greenbar flex shrink-0 items-center justify-center rounded-md"
                  >
                    <Scale className="h-4 w-4" aria-hidden />
                  </button>
                )}
                {/* Last on the row, and that is the whole point.
                 *
                 * The balance used to sit before the icons, and the icons a row
                 * carries depend on what kind of account it is — a card adds the
                 * mute bell, an asset adds the sell coin, everything else has
                 * neither. So no two rows put their figure at the same distance
                 * from the right edge, and a column of numbers that has to be
                 * compared could not be: ৳12,345.67 on a cash row landed two
                 * whole targets to the right of ৳9,00,000.00 on a land row.
                 *
                 * Moving it to the end costs nothing — no width has to be
                 * reserved for the widest row — and it lands the figure exactly
                 * under the section subtotal above it, which was already flush
                 * right and had nothing beneath it to line up with.
                 *
                 * In its own money on a foreign account, with the ISO code
                 * spelled out beside it. The symbol alone is not enough: `$` is
                 * a dozen currencies and `¥` is two, so a bare `$500.00` on a
                 * screen whose totals are in taka is exactly the ambiguity that
                 * has to go. */}
                {group === 'foreign' ? (
                  <span className="amount-col ml-auto shrink-0 pl-2 text-right text-sm">
                    <Money minor={account.balanceMinor} currency={account.currency} />
                    <span className="text-ink-muted ml-1 text-xs">
                      {account.currency.toUpperCase()}
                    </span>
                  </span>
                ) : account.type === 'CREDIT_CARD' && account.creditLimitMinor > 0 ? (
                  /* The same block the dashboard draws, from the same component:
                     limit, what is left, what is owed, stacked and flush right.
                     It replaces the balance rather than sitting beside it —
                     বকেয়া and the balance are one number twice, and a row that
                     prints it in two places invites somebody to add them. */
                  <CardAmount
                    minor={account.balanceMinor}
                    undrawnMinor={account.undrawnMinor}
                    drawnMinor={account.drawnMinor}
                    limitMinor={account.creditLimitMinor}
                    currency={account.currency}
                    className="ml-auto pl-2"
                  />
                ) : (
                  <Money
                    minor={account.balanceMinor}
                    className="amount-col ml-auto shrink-0 pl-2 text-sm"
                  />
                )}
              </li>
            )),
          ])}
        </ul>
      )}

      {/* Archiving is only a way out of the plan limit if what went in can be
          found again. */}
      <section className="flex flex-col gap-2">
        <button
          type="button"
          aria-expanded={showArchived}
          onClick={() => {
            haptic('tap');
            setShowArchived((open) => !open);
          }}
          className="press border-rule text-ink-muted hover:bg-greenbar flex min-h-11 items-center gap-2 self-start rounded-md border px-3 text-sm"
        >
          <Archive className="h-4 w-4" aria-hidden />
          {showArchived
            ? t('account.hideArchived', 'আর্কাইভ লুকান')
            : t('account.showArchived', 'আর্কাইভ করা অ্যাকাউন্ট দেখুন')}
        </button>

        {showArchived ? (
          archived.isLoading ? (
            <div className="rounded-card border-rule bg-surface overflow-hidden border">
              <SkeletonRows rows={2} />
            </div>
          ) : (archived.data?.length ?? 0) === 0 ? (
            <p className="text-ink-muted rounded-card border-rule border border-dashed p-4 text-center text-sm">
              আর্কাইভে কোনো অ্যাকাউন্ট নেই।
            </p>
          ) : (
            <>
              <ul className="rounded-card border-rule bg-surface overflow-hidden border">
                {(archived.data ?? []).map((account) => (
                  <li
                    key={account.id}
                    className="border-rule flex flex-col gap-1.5 border-b px-3 py-3 last:border-b-0"
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="text-ink min-w-0 flex-1 truncate text-sm">
                        {account.name}
                      </span>
                      {/* Its own money here too. An archived account is out of
                          every total by definition, so there is nothing to
                          exclude it from — but printing a dollar balance with a
                          ৳ in front of it would still be a lie. */}
                      <Money
                        minor={account.balanceMinor}
                        currency={account.currency}
                        className="shrink-0 text-sm"
                      />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-ink-muted min-w-0 truncate text-xs">
                        {typeLabel(account.type)}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={restore.isPending}
                        onClick={() => restore.mutate(account.id)}
                      >
                        <ArchiveRestore className="h-4 w-4" aria-hidden />
                        আবার চালু করুন
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              {atLimit ? (
                <p className="text-brass text-xs">
                  প্ল্যানের সীমা এখন পূর্ণ — কোনোটি আবার চালু করলে সীমা ছাড়িয়ে যাবে।
                </p>
              ) : null}
              {restore.error ? (
                <p role="alert" className="text-expense text-sm">
                  {restore.error.message}
                </p>
              ) : null}
            </>
          )
        ) : null}
      </section>

      <AddAccountSheet
        open={addOpen}
        onOpenChange={setAddOpen}
        onSaved={() => invalidateAccountData(queryClient)}
      />
      <EditAccountSheet
        account={editing}
        onClose={() => setEditing(null)}
        onArchive={(account) => {
          archive.reset();
          setEditing(null);
          setArchiving(account);
        }}
      />
      <ConfirmSheet
        open={archiving !== null}
        onOpenChange={(open) => {
          if (!open) setArchiving(null);
        }}
        title={t('account.archiveTitle', 'আর্কাইভ করবেন?')}
        description={archiving?.name}
        body={t(
          'account.archiveBody',
          'অ্যাকাউন্টটি তালিকা থেকে সরে যাবে এবং নতুন লেনদেনের ঘরে আর বেছে নেওয়া যাবে না। পুরনো লেনদেন, ব্যালেন্স আর প্রতিবেদনের হিসাব অক্ষত থাকবে, আর প্ল্যানের সীমার হিসাবেও এটি আর গোনা হবে না। চাইলে আবার চালু করা যাবে।',
        )}
        confirmLabel={t('account.archive', 'আর্কাইভ করুন')}
        pending={archive.isPending}
        error={archive.error ? archive.error.message : null}
        onConfirm={() => {
          if (archiving) archive.mutate(archiving.id);
        }}
      />
      <ReconcileSheet
        account={reconciling}
        onClose={() => setReconciling(null)}
        onSaved={() => invalidateAccountData(queryClient)}
      />
      <RevalueSheet
        account={revaluing}
        onClose={() => setRevaluing(null)}
        onSaved={() => invalidateAccountData(queryClient)}
      />
      <SellSheet
        account={selling}
        onClose={() => setSelling(null)}
        onSaved={() => invalidateAccountData(queryClient)}
      />
    </div>
  );
}

/** Only drawn when the user has set one, so the row stays as wide as it was. */
function AccountAvatar({ account }: { account: AccountDto }) {
  if (!account.icon && !account.color) return null;
  return (
    <span
      aria-hidden
      className="border-rule flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-base"
      style={account.color ? { backgroundColor: account.color } : undefined}
    >
      {account.icon ?? ''}
    </span>
  );
}

/**
 * Archiving asks first — as a sheet, not a modal. The loan screens have the
 * same component; it is written out again here rather than imported across
 * feature folders. `error` is what the API said when it refused.
 */
function ConfirmSheet({
  open,
  onOpenChange,
  title,
  description,
  body,
  confirmLabel,
  onConfirm,
  pending = false,
  error = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  error?: string | null;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title} description={description}>
      <div className="flex flex-col gap-4">
        <p className="text-ink text-sm">{body}</p>
        {error ? (
          <p role="alert" className="bg-expense/10 text-expense rounded-md px-3 py-2 text-sm">
            {error}
          </p>
        ) : null}
        <Button
          variant="danger"
          size="block"
          disabled={pending}
          onClick={() => {
            haptic('warn');
            onConfirm();
          }}
        >
          {confirmLabel}
        </Button>
        <Button variant="outline" size="block" onClick={() => onOpenChange(false)}>
          থাক
        </Button>
      </div>
    </Sheet>
  );
}

interface AccountForm {
  name: string;
  type: string;
  opening: string;
  institution: string;
  note: string;
  assetKind: string;
  purchaseCost: string;
  purchaseDate: string;
  masked: string;
  hints: string;
  icon: string;
  color: string;
  sortOrder: string;
  /** The day the opening balance was true, `YYYY-MM-DD`. */
  openingDate: string;
  /** Credit cards only, in major units as typed. */
  creditLimit: string;
  statementDay: string;
  dueDay: string;
  leadDays: string;
}

const toForm = (a: AccountDto | null): AccountForm => ({
  name: a?.name ?? '',
  type: a?.type ?? 'CASH',
  // Major units, so the field reads the way it was typed in the first place.
  opening: formatMinor(a?.openingBalance ?? 0, { symbol: false }),
  /* Today when the account has no opening balance yet, so typing an amount into
     an empty field does not also demand a date before it can be saved. */
  openingDate: a?.openingBalanceDate ?? toLocalDateString(new Date()),
  institution: a?.institution ?? '',
  note: a?.note ?? '',
  assetKind: a?.assetKind ?? 'OTHER',
  purchaseCost: a?.purchaseCostMinor ? formatMinor(a.purchaseCostMinor, { symbol: false }) : '',
  purchaseDate: a?.purchaseDate ?? '',
  masked: a?.accountNumberMasked ?? '',
  hints: (a?.matchHints ?? []).join(', '),
  icon: a?.icon ?? '',
  color: a?.color ?? '',
  sortOrder: String(a?.sortOrder ?? 0),
  creditLimit: a?.creditLimitMinor ? formatMinor(a.creditLimitMinor, { symbol: false }) : '',
  statementDay: a?.statementDayOfMonth ? String(a.statementDayOfMonth) : '',
  dueDay: a?.dueDayOfMonth ? String(a.dueDayOfMonth) : '',
  leadDays: a?.reminderLeadDays ? String(a.reminderLeadDays) : '',
});

/**
 * Only what actually changed goes into the PATCH. Sending an unchanged value
 * back is not always a no-op — it writes an audit entry, and on other screens
 * the API rederives things from whatever it is handed.
 */
function accountPatch(
  account: AccountDto,
  form: AccountForm,
  openingBalance: number,
): Record<string, unknown> {
  const isCard = form.type === 'CREDIT_CARD';
  const isAsset = form.type === 'ASSET';
  const next = {
    name: form.name.trim(),
    type: form.type,
    openingBalance,
    /* Sent only when there is a balance for it to date. An account whose
       opening balance is zero has no OPENING_BALANCE transaction to move, and
       the server would have nothing to attach the day to — `undefined` drops
       out of the JSON body rather than being sent as a null the schema
       refuses. */
    openingBalanceDate: openingBalance === 0 ? undefined : form.openingDate,
    institution: form.institution.trim(),
    note: form.note.trim(),
    /* Only sent for an asset. On anything else the server clears it anyway, and
       sending a stale "গাড়ি" from a form that no longer shows the box would be
       the screen asserting something the reader never saw. */
    assetKind: isAsset ? form.assetKind : null,
    purchaseCostMinor:
      isAsset && form.purchaseCost.trim() ? parseMoneyToMinor(form.purchaseCost) : null,
    purchaseDate: isAsset && form.purchaseDate ? form.purchaseDate : null,
    accountNumberMasked: form.masked.trim(),
    matchHints: form.hints
      .split(',')
      .map((hint) => hint.trim())
      .filter(Boolean)
      .slice(0, 20),
    icon: form.icon.trim(),
    color: form.color,
    sortOrder: Number(form.sortOrder || '0'),
    // Only a card has these. Switching away clears them rather than leaving a
    // payment date on a savings account.
    /* Zero when the field is empty: "no limit recorded" is the honest state,
       and it is cleared outright if the account stops being a card. */
    creditLimitMinor: isCard && form.creditLimit.trim() ? parseMoneyToMinor(form.creditLimit) : 0,
    statementDayOfMonth: isCard && form.statementDay ? Number(form.statementDay) : null,
    dueDayOfMonth: isCard && form.dueDay ? Number(form.dueDay) : null,
    reminderLeadDays: isCard && form.leadDays ? Number(form.leadDays) : null,
  };
  const before: typeof next = {
    name: account.name,
    type: account.type,
    openingBalance: account.openingBalance,
    openingBalanceDate:
      account.openingBalance === 0 ? undefined : (account.openingBalanceDate ?? undefined),
    institution: account.institution ?? '',
    note: account.note ?? '',
    assetKind: account.type === 'ASSET' ? (account.assetKind ?? 'OTHER') : null,
    purchaseCostMinor: account.purchaseCostMinor,
    purchaseDate: account.purchaseDate,
    accountNumberMasked: account.accountNumberMasked ?? '',
    matchHints: account.matchHints,
    icon: account.icon ?? '',
    color: account.color ?? '',
    sortOrder: account.sortOrder,
    creditLimitMinor: account.creditLimitMinor,
    statementDayOfMonth: account.statementDayOfMonth,
    dueDayOfMonth: account.dueDayOfMonth,
    reminderLeadDays: account.reminderLeadDays,
  };

  const body: Record<string, unknown> = {};
  for (const key of Object.keys(next) as (keyof typeof next)[]) {
    const after = next[key];
    const previous = before[key];
    const same =
      Array.isArray(after) && Array.isArray(previous)
        ? after.length === previous.length && after.every((v, i) => v === previous[i])
        : after === previous;
    if (!same) body[key] = after;
  }
  return body;
}

function EditAccountSheet({
  account,
  onClose,
  onArchive,
}: {
  account: AccountDto | null;
  onClose: () => void;
  onArchive: (account: AccountDto) => void;
}) {
  /* The books' currency decides how many minor units a typed amount is worth. */
  const { currency, currencyInfo } = useWorkspaceSettings();
  const queryClient = useQueryClient();
  const [form, setForm] = React.useState<AccountForm>(() => toForm(null));
  const [error, setError] = React.useState<string | null>(null);
  const [refusal, setRefusal] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!account) return;
    setForm(toForm(account));
    setError(null);
    setRefusal(null);
  }, [account]);

  const set =
    (key: keyof AccountForm) =>
    (e: { target: { value: string } }): void =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<AccountDto>(`/accounts/${account!.id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      haptic('success');
      invalidateAccountData(queryClient);
      onClose();
    },
    onError: (err) => {
      /* A 400 carrying no field issues is the API explaining itself in Bengali:
         a loan owns this account, or it is one of the hidden system accounts.
         That is a sentence for the user, not an error to swallow. */
      if (err instanceof ApiError && err.status === 400 && !err.issues) setRefusal(err.message);
      else
        setError(err instanceof Error ? err.message : t('common.saveFailed', 'সংরক্ষণ করা যায়নি'));
    },
  });

  const isCard = form.type === 'CREDIT_CARD';

  /* Only to decide whether to show the date field. Half-typed text is not an
     error yet — the submit handler is where a bad amount is refused — so an
     unparseable field simply reads as nothing to date. */
  const parsedOpening = React.useMemo(() => {
    try {
      return parseMoneyToMinor(form.opening || '0', currency);
    } catch {
      return 0;
    }
  }, [form.opening, currency]);

  return (
    <Sheet
      open={account !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t('account.edit', 'অ্যাকাউন্ট সম্পাদনা')}
      description={account?.name}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          setRefusal(null);
          if (!account) return;
          let openingBalance: number;
          try {
            openingBalance = parseMoneyToMinor(form.opening || '0', currency);
          } catch {
            setError(t('account.badOpening', 'প্রারম্ভিক জেরের অঙ্কটি বোঝা যায়নি।'));
            return;
          }
          const body = accountPatch(account, form, openingBalance);
          // Nothing moved; a PATCH here would only add a line to the audit log.
          if (Object.keys(body).length === 0) {
            onClose();
            return;
          }
          save.mutate(body);
        }}
      >
        <Field label={t('account.name', 'নাম')} htmlFor="edit-acc-name">
          <Input
            id="edit-acc-name"
            value={form.name}
            onChange={set('name')}
            required
            placeholder={t('account.nameHint', 'যেমন: ব্র্যাক ব্যাংক')}
          />
        </Field>

        <Field label={t('entry.kind', 'ধরন')} htmlFor="edit-acc-type">
          <Select id="edit-acc-type" value={form.type} onChange={set('type')}>
            {TYPE_GROUPS.map((group) => (
              /* `type`, not `t` — the translator is called `t` and a parameter
                 by that name shadows it inside this very block. */
              <optgroup key={group} label={groupLabel(group)}>
                {CREATABLE_TYPES.filter((type) => type.group === group).map((type) => (
                  <option key={type.value} value={type.value}>
                    {typeLabel(type.value)}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
        {account && form.type !== account.type ? (
          <p className="text-ink-muted -mt-2 text-xs">
            ধরন বদলালে প্রতিবেদনে অ্যাকাউন্টটি সম্পদ ও দায়ের অন্য পাশে চলে যাবে।
          </p>
        ) : null}

        {isCard ? (
          <>
            <Field label={t('account.creditLimit', 'কার্ডের লিমিট (৳)')} htmlFor="edit-acc-limit">
              <Input
                id="edit-acc-limit"
                inputMode="decimal"
                value={form.creditLimit}
                onChange={set('creditLimit')}
                placeholder={fmtNumber('100000')}
              />
              {/* Said where it is typed, because this is the number people
                  most expect to see added to their money. */}
              <p className="text-ink-muted text-xs">
                {t(
                  'account.creditLimitHint',
                  'লিমিট আপনার টাকা নয় — খরচ না করা পর্যন্ত দায়ও নয়। নিট সম্পদে ধরা হবে না।',
                )}
              </p>
            </Field>
            <Field
              label={t('account.dueDay', 'পেমেন্টের শেষ তারিখ (মাসের কত তারিখ)')}
              htmlFor="edit-acc-due-day"
            >
              <Input
                id="edit-acc-due-day"
                type="number"
                min={1}
                max={31}
                inputMode="numeric"
                value={form.dueDay}
                onChange={set('dueDay')}
                placeholder={fmtNumber('12')}
              />
            </Field>
            <Field
              label={t('account.statementDay', 'স্টেটমেন্টের তারিখ (মাসের কত তারিখ)')}
              htmlFor="edit-acc-stmt-day"
            >
              <Input
                id="edit-acc-stmt-day"
                type="number"
                min={1}
                max={31}
                inputMode="numeric"
                value={form.statementDay}
                onChange={set('statementDay')}
              />
            </Field>
            <Field
              label={t('account.leadDays', 'কত দিন আগে মনে করিয়ে দেব')}
              htmlFor="edit-acc-lead"
            >
              <Input
                id="edit-acc-lead"
                type="number"
                min={1}
                max={28}
                inputMode="numeric"
                value={form.leadDays}
                onChange={set('leadDays')}
                placeholder={t('account.leadDaysHint', 'ফাঁকা রাখলে ওয়ার্কস্পেসের নিয়ম')}
              />
            </Field>
          </>
        ) : null}

        <Field
          label={`${t('account.opening', 'প্রারম্ভিক জের')} (${currencyInfo.symbol})`}
          htmlFor="edit-acc-opening"
        >
          <Input
            id="edit-acc-opening"
            value={form.opening}
            onChange={set('opening')}
            inputMode="decimal"
            placeholder={fmtNumber('0.00')}
            className="money"
          />
        </Field>

        {/* The date the figure belongs to. Hidden when there is no figure —
            there is nothing to date, and the server books nothing. */}
        {parsedOpening !== 0 ? (
          <Field
            label={t('account.openingDate', 'জেরটি কোন তারিখের')}
            htmlFor="edit-acc-opening-date"
          >
            <Input
              id="edit-acc-opening-date"
              type="date"
              value={form.openingDate}
              onChange={set('openingDate')}
            />
          </Field>
        ) : null}

        <p className="text-ink-muted -mt-2 text-xs">
          খাতা অনুযায়ী এখন <Money minor={account?.balanceMinor ?? 0} className="inline" />।
          প্রারম্ভিক জের বদলালে আজকের ব্যালেন্সও ঠিক ততটাই বদলাবে। জেরটি ওই তারিখের একটি লেনদেন
          হিসেবে খাতায় বসে, তাই তার আগের তারিখের হিসাবে এটি ধরা হবে না।
        </p>

        {/* Assets only. Chosen when the asset is added, which is the moment
            somebody actually knows whether it is a flat or a motorcycle. */}
        {form.type === 'ASSET' ? (
          <>
            <Field label={t('account.assetKind', 'কী ধরনের সম্পদ')} htmlFor="edit-acc-kind">
              <Select id="edit-acc-kind" value={form.assetKind} onChange={set('assetKind')}>
                <option value="PROPERTY">স্থাবর সম্পত্তি — জমি, ফ্ল্যাট, দোকান</option>
                <option value="VEHICLE">যানবাহন — গাড়ি, মোটরসাইকেল</option>
                <option value="GOLD">স্বর্ণ ও গয়না</option>
                <option value="INVESTMENT">বিনিয়োগ — শেয়ার, বন্ড, বিও হিসাব</option>
                <option value="OTHER">অন্যান্য</option>
              </Select>
              <p className="text-ink-muted mt-1 text-xs">
                {t(
                  'account.assetKindHint',
                  'স্থাবর সম্পদ পাতায় এই ভাগ ধরেই আলাদা করে দেখানো হবে।',
                )}
              </p>
            </Field>

            <Field label={t('account.purchaseCost', 'কেনা দাম (৳)')} htmlFor="edit-acc-cost">
              <Input
                id="edit-acc-cost"
                value={form.purchaseCost}
                onChange={set('purchaseCost')}
                inputMode="decimal"
                className="money"
                placeholder="০.০০"
              />
              {/* The balance is the carrying amount — cost plus every
                  revaluation since — so the original has to be kept separately
                  or the two can never be compared. IAS 16.77(e). */}
              <p className="text-ink-muted mt-1 text-xs">
                {t(
                  'account.purchaseCostHint',
                  'যত টাকায় কিনেছিলেন। এখনকার মূল্য বদলাতে “মূল্যায়ন” ব্যবহার করুন — কেনা দাম একই থাকবে।',
                )}
              </p>
            </Field>

            <Field label={t('account.purchaseDate', 'কেনার তারিখ')} htmlFor="edit-acc-bought">
              <Input
                id="edit-acc-bought"
                type="date"
                value={form.purchaseDate}
                onChange={set('purchaseDate')}
              />
            </Field>
          </>
        ) : null}

        <Field label={t('account.institution', 'প্রতিষ্ঠান')} htmlFor="edit-acc-inst">
          <Input
            id="edit-acc-inst"
            value={form.institution}
            onChange={set('institution')}
            placeholder={t('account.nameHint', 'যেমন: ব্র্যাক ব্যাংক')}
          />
        </Field>

        <Field
          label={t('account.masked', 'অ্যাকাউন্ট নম্বর (শেষ কয়েক অঙ্ক)')}
          htmlFor="edit-acc-masked"
        >
          <Input
            id="edit-acc-masked"
            value={form.masked}
            onChange={set('masked')}
            placeholder={`****${fmtNumber('4521')}`}
          />
        </Field>

        <Field label={t('account.matchHints', 'মেলানোর সংকেত')} htmlFor="edit-acc-hints">
          <Input
            id="edit-acc-hints"
            value={form.hints}
            onChange={set('hints')}
            placeholder={t('account.matchHintsHint', 'যেমন: ৪৫২১, bKash, DBBL')}
          />
        </Field>
        <p className="text-ink-muted -mt-2 text-xs">
          শেষ চার অঙ্ক, ওয়ালেট নম্বর বা এসএমএস প্রেরকের নাম — আমদানি করা লেনদেন এগুলো দেখে এই
          অ্যাকাউন্টে বসে। কমা দিয়ে আলাদা করুন।
        </p>

        <Field label={t('account.icon', 'আইকন (ইমোজি)')} htmlFor="edit-acc-icon">
          <Input
            id="edit-acc-icon"
            value={form.icon}
            onChange={set('icon')}
            maxLength={4}
            placeholder="🏦"
          />
        </Field>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-ink text-sm font-medium">{t('account.colour', 'রঙ')}</legend>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-pressed={form.color === ''}
              onClick={() => setForm((f) => ({ ...f, color: '' }))}
              className={cn(
                'press border-rule text-ink hover:bg-greenbar flex min-h-11 items-center rounded-md border px-3 text-xs',
                form.color === '' && 'border-ink font-medium',
              )}
            >
              {t('account.noColour', 'রঙ নেই')}
            </button>
            {ACCOUNT_COLORS.map((swatch) => (
              <button
                key={swatch.value}
                type="button"
                aria-label={t(`account.colour.${swatch.key}`, swatch.label)}
                aria-pressed={form.color === swatch.value}
                onClick={() => setForm((f) => ({ ...f, color: swatch.value }))}
                className={cn(
                  'press touch-target flex items-center justify-center rounded-full border-2',
                  form.color === swatch.value ? 'border-ink' : 'border-transparent',
                )}
              >
                <span
                  className="block h-6 w-6 rounded-full"
                  style={{ backgroundColor: swatch.value }}
                />
              </button>
            ))}
          </div>
        </fieldset>

        <Field label={t('account.sortOrder', 'তালিকায় ক্রম (ছোট আগে)')} htmlFor="edit-acc-sort">
          <Input
            id="edit-acc-sort"
            type="number"
            inputMode="numeric"
            value={form.sortOrder}
            onChange={set('sortOrder')}
          />
        </Field>

        {/* Last, and deliberately so: it is the field somebody reaches for once
            the structured ones have failed to hold what they needed to keep.
            Without it the branch and the nominee end up in the account's name. */}
        <Field label={t('account.note', 'নোট')} htmlFor="edit-acc-note">
          <Textarea
            id="edit-acc-note"
            value={form.note}
            onChange={set('note')}
            rows={3}
            maxLength={2000}
            placeholder={t(
              'account.notePlaceholder',
              'যেমন: গুলশান শাখা, নমিনি — আম্মু, চেকবই ৪৫০১–৪৫৫০',
            )}
          />
          <p className="text-ink-muted mt-1 text-xs">
            {t('account.noteHint', 'শাখা, নমিনি, চেকবই — যা মনে রাখা দরকার।')}
          </p>
        </Field>

        {refusal ? (
          <div
            role="alert"
            className="border-rule bg-greenbar text-ink flex flex-col items-start gap-2 rounded-md border p-3 text-sm"
          >
            <p>{refusal}</p>
            {/* Both loan refusals name the loan; the system-account one does not. */}
            {refusal.includes('ঋণ') ? (
              <Link
                href="/loans"
                className="press text-income flex min-h-11 items-center underline"
              >
                ঋণের পাতায় যান
              </Link>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-expense text-sm">
            {error}
          </p>
        ) : null}

        <Button type="submit" size="block" disabled={save.isPending}>
          সংরক্ষণ করুন
        </Button>

        <Button
          type="button"
          variant="outline"
          size="block"
          className="text-expense"
          onClick={() => account && onArchive(account)}
        >
          <Archive className="h-4 w-4" aria-hidden />
          আর্কাইভ করুন
        </Button>
        <p className="text-ink-muted text-xs">
          আর্কাইভ করলে অ্যাকাউন্টটি তালিকা থেকে সরে যায়, লেনদেন অক্ষত থাকে, আর প্ল্যানের সীমার
          হিসাবে আর গোনা হয় না।
        </p>
      </form>
    </Sheet>
  );
}

function AddAccountSheet({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  /* The books' currency decides how many minor units a typed amount is worth. */
  const { currency, currencyInfo } = useWorkspaceSettings();
  const [name, setName] = React.useState('');
  const [type, setType] = React.useState('CASH');
  const [openingBalance, setOpeningBalance] = React.useState('');
  /* Today, because that is the day somebody filling this form in is describing.
     Somebody entering an account they have had for years changes it, and the
     figure then belongs to that day rather than to every day ever. */
  const [openingDate, setOpeningDate] = React.useState(() => toLocalDateString(new Date()));
  const [dueDay, setDueDay] = React.useState('');
  const [creditLimit, setCreditLimit] = React.useState('');
  /** Branch, nominee, cheque book — the field that catches everything else. */
  const [note, setNote] = React.useState('');
  /* Asked at creation, because that is the moment somebody knows whether the
     thing they are adding is a flat or a motorcycle. */
  const [assetKind, setAssetKind] = React.useState('PROPERTY');
  const [purchaseCost, setPurchaseCost] = React.useState('');
  const [purchaseDate, setPurchaseDate] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api<AccountDto>('/accounts', {
        method: 'POST',
        body: {
          name,
          type,
          openingBalance: openingBalance ? parseMoneyToMinor(openingBalance, currency) : 0,
          // Nothing to date when there is no balance, so the field is omitted.
          openingBalanceDate: openingBalance ? openingDate : undefined,
          // Only a card has a payment due day; sending it for cash would be noise.
          dueDayOfMonth: type === 'CREDIT_CARD' && dueDay ? Number(dueDay) : undefined,
          creditLimitMinor:
            type === 'CREDIT_CARD' && creditLimit.trim()
              ? parseMoneyToMinor(creditLimit, currency)
              : undefined,
          note: note.trim() || undefined,
          ...(type === 'ASSET'
            ? {
                assetKind,
                purchaseCostMinor: purchaseCost.trim()
                  ? parseMoneyToMinor(purchaseCost, currency)
                  : null,
                purchaseDate: purchaseDate || null,
              }
            : {}),
        },
      }),
    onSuccess: () => {
      setName('');
      setOpeningBalance('');
      setOpeningDate(toLocalDateString(new Date()));
      setDueDay('');
      setNote('');
      setPurchaseCost('');
      setPurchaseDate('');
      onSaved();
      onOpenChange(false);
    },
    onError: (err) =>
      setError(
        err instanceof FeatureLimitError
          ? err.message
          : err instanceof Error
            ? err.message
            : t('common.saveFailed', 'সংরক্ষণ করা যায়নি'),
      ),
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('account.new', 'নতুন অ্যাকাউন্ট')}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <Field label={t('account.name', 'নাম')} htmlFor="acc-name">
          <Input
            id="acc-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder={t('account.nameHint', 'যেমন: ব্র্যাক ব্যাংক')}
          />
        </Field>
        <Field label={t('entry.kind', 'ধরন')} htmlFor="acc-type">
          <Select id="acc-type" value={type} onChange={(e) => setType(e.target.value)}>
            {TYPE_GROUPS.map((group) => (
              /* `type`, not `t` — the translator is called `t` and a parameter
                 by that name shadows it inside this very block. */
              <optgroup key={group} label={groupLabel(group)}>
                {CREATABLE_TYPES.filter((type) => type.group === group).map((type) => (
                  <option key={type.value} value={type.value}>
                    {typeLabel(type.value)}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
        {type === 'CREDIT_CARD' ? (
          <>
            <Field label={t('account.creditLimit', 'কার্ডের লিমিট (৳)')} htmlFor="acc-limit">
              <Input
                id="acc-limit"
                inputMode="decimal"
                value={creditLimit}
                onChange={(e) => setCreditLimit(e.target.value)}
                placeholder={fmtNumber('100000')}
              />
              {/* Said where it is typed, because this is the number people
                  most expect to see added to their money. */}
              <p className="text-ink-muted text-xs">
                {t(
                  'account.creditLimitHint',
                  'লিমিট আপনার টাকা নয় — খরচ না করা পর্যন্ত দায়ও নয়। নিট সম্পদে ধরা হবে না।',
                )}
              </p>
            </Field>
            <Field
              label={t('account.dueDay', 'পেমেন্টের শেষ তারিখ (মাসের কত তারিখ)')}
              htmlFor="acc-due-day"
            >
              <Input
                id="acc-due-day"
                type="number"
                min={1}
                max={31}
                inputMode="numeric"
                value={dueDay}
                onChange={(e) => setDueDay(e.target.value)}
                placeholder={fmtNumber('12')}
              />
            </Field>
          </>
        ) : null}

        <Field
          label={`${t('account.opening', 'প্রারম্ভিক জের')} (${currencyInfo.symbol})`}
          htmlFor="acc-opening"
        >
          <Input
            id="acc-opening"
            value={openingBalance}
            onChange={(e) => setOpeningBalance(e.target.value)}
            inputMode="decimal"
            placeholder={fmtNumber('0.00')}
            className="money"
          />
        </Field>

        {/* Asked for only once there is a figure to date. The whole reason it
            is asked at all: the balance is written into the ledger as a
            transaction on this day, so a report covering an earlier period
            correctly leaves it out. */}
        {openingBalance.trim() ? (
          <Field label={t('account.openingDate', 'জেরটি কোন তারিখের')} htmlFor="acc-opening-date">
            <Input
              id="acc-opening-date"
              type="date"
              value={openingDate}
              onChange={(e) => setOpeningDate(e.target.value)}
            />
            <p className="text-ink-muted text-xs">
              {t(
                'account.openingDateHint',
                'এই তারিখে জেরটি খাতায় একটি লেনদেন হিসেবে বসবে। আগের তারিখের প্রতিবেদনে এটি থাকবে না।',
              )}
            </p>
          </Field>
        ) : null}

        {error ? (
          <p role="alert" className="text-expense text-sm">
            {error}
          </p>
        ) : null}

        {/* Assets only, and asked here rather than later: "what kind" is
            obvious at the moment of adding and becomes a chore afterwards. */}
        {type === 'ASSET' ? (
          <>
            <Field label={t('account.assetKind', 'কী ধরনের সম্পদ')} htmlFor="acc-kind">
              <Select
                id="acc-kind"
                value={assetKind}
                onChange={(e) => setAssetKind(e.target.value)}
              >
                <option value="PROPERTY">স্থাবর সম্পত্তি — জমি, ফ্ল্যাট, দোকান</option>
                <option value="VEHICLE">যানবাহন — গাড়ি, মোটরসাইকেল</option>
                <option value="GOLD">স্বর্ণ ও গয়না</option>
                <option value="INVESTMENT">বিনিয়োগ — শেয়ার, বন্ড, বিও হিসাব</option>
                <option value="OTHER">অন্যান্য</option>
              </Select>
            </Field>

            <Field label={t('account.purchaseCost', 'কেনা দাম (৳)')} htmlFor="acc-cost">
              <Input
                id="acc-cost"
                value={purchaseCost}
                onChange={(e) => setPurchaseCost(e.target.value)}
                inputMode="decimal"
                className="money"
                placeholder="০.০০"
              />
              <p className="text-ink-muted mt-1 text-xs">
                {t(
                  'account.purchaseCostHintShort',
                  'যত টাকায় কিনেছিলেন। পরে দাম বাড়লে “মূল্যায়ন” দিয়ে বদলাবেন — এই ঘরটি একই থাকবে।',
                )}
              </p>
            </Field>

            <Field label={t('account.purchaseDate', 'কেনার তারিখ')} htmlFor="acc-bought">
              <Input
                id="acc-bought"
                type="date"
                value={purchaseDate}
                onChange={(e) => setPurchaseDate(e.target.value)}
              />
            </Field>
          </>
        ) : null}

        {/* Last, and deliberately so: it is the field somebody reaches for once
            the structured ones have failed to hold what they needed to keep.
            Without it the branch and the nominee end up in the account's name. */}
        <Field label={t('account.note', 'নোট')} htmlFor="acc-note">
          <Textarea
            id="acc-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder={t(
              'account.notePlaceholder',
              'যেমন: গুলশান শাখা, নমিনি — আম্মু, চেকবই ৪৫০১–৪৫৫০',
            )}
          />
          <p className="text-ink-muted mt-1 text-xs">
            {t('account.noteHint', 'শাখা, নমিনি, চেকবই — যা মনে রাখা দরকার।')}
          </p>
        </Field>

        <Button type="submit" size="block" disabled={save.isPending}>
          সংরক্ষণ করুন
        </Button>
      </form>
    </Sheet>
  );
}

function ReconcileSheet({
  account,
  onClose,
  onSaved,
}: {
  account: AccountDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  /* The books' currency decides how many minor units a typed amount is worth. */
  const { currency, currencyInfo } = useWorkspaceSettings();
  const [actual, setActual] = React.useState('');
  const [result, setResult] = React.useState<string | null>(null);
  /**
   * What the number in the box means, for a credit card.
   *
   * `owed` is what the statement says is outstanding. `available` is what the
   * bank's SMS calls the balance — and on a card that is the room left under
   * the limit, not money. Reading one as the other is a whole limit's worth of
   * error in the books, and it is not hypothetical: it put ৳3,00,000 on the
   * wrong side of one of the owner's cards, twice, once through the Wallet
   * import and once through this very screen.
   */
  const [mode, setMode] = React.useState<'owed' | 'available'>('owed');

  const isCard = account?.type === 'CREDIT_CARD';
  const limitMinor = account?.creditLimitMinor ?? 0;

  React.useEffect(() => {
    setActual('');
    setResult(null);
    setMode('owed');
  }, [account]);

  /* What was typed, in minor units, or null while it is not a number yet. */
  const typedMinor = React.useMemo(() => {
    const text = actual.trim();
    if (!text) return null;
    try {
      return parseMoneyToMinor(text, currency);
    } catch {
      return null;
    }
  }, [actual, currency]);

  /**
   * The figure the ledger has to end at.
   *
   * A card is credit-normal: what is owed is negative. So an amount typed as
   * বকেয়া flips its sign, and one typed as the SMS's balance is turned into
   * what is owed first — limit less the room left — and then flipped.
   */
  const owedMinor =
    typedMinor === null ? null : mode === 'available' ? limitMinor - typedMinor : typedMinor;
  const targetMinor = typedMinor === null ? null : isCard ? -(owedMinor ?? 0) : typedMinor;

  const save = useMutation({
    mutationFn: () =>
      api<{ delta: number }>(`/accounts/${account!.id}/reconcile`, {
        method: 'POST',
        body: {
          date: toLocalDateString(new Date()),
          actualBalanceMinor: targetMinor ?? parseMoneyToMinor(actual, currency),
        },
      }),
    onSuccess: (data) => {
      onSaved();
      setResult(
        data.delta === 0
          ? t('account.alreadyMatched', 'হিসাব আগেই মিলে ছিল।')
          : t('account.adjusted', 'পার্থক্যটি সমন্বয় হিসেবে যোগ করা হয়েছে।'),
      );
    },
  });

  return (
    <Sheet
      open={account !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t('account.reconcileTitle', 'ব্যালেন্স মেলান')}
      description={account?.name}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {isCard ? (
          <p className="text-ink-muted text-sm">
            {t('account.cardLedgerNow', 'খাতা অনুযায়ী এখন')}{' '}
            <span className={(account?.balanceMinor ?? 0) < 0 ? 'text-expense' : 'text-income'}>
              {(account?.balanceMinor ?? 0) < 0
                ? t('dashboard.cardOwed', 'বকেয়া')
                : t('dashboard.cardCredit', 'জমা')}{' '}
              <Money minor={Math.abs(account?.balanceMinor ?? 0)} className="inline" />
            </span>
            ।
          </p>
        ) : (
          <p className="text-ink-muted text-sm">
            খাতা অনুযায়ী এখন <Money minor={account?.balanceMinor ?? 0} className="inline" />। আসল
            ব্যালেন্স লিখুন — পার্থক্যটি সমন্বয় হিসেবে যোগ হবে।
          </p>
        )}

        {/* Which of the two numbers a card can quote is being typed.
 
            A card statement says what is owed; a card SMS says "A/C balance"
            and means the room left under the limit. They are not the same
            quantity and they are not even the same sign — mistaking one for the
            other puts a whole credit limit on the wrong side of the books, and
            that is exactly what happened here twice. So the screen asks rather
            than assuming, and shows its arithmetic. */}
        {isCard ? (
          <div className="flex flex-col gap-2">
            <span className="text-ink-muted text-xs font-medium">
              {t('account.cardWhichFigure', 'কোন অঙ্কটা লিখছেন?')}
            </span>
            <div role="tablist" className="bg-greenbar grid grid-cols-2 gap-1 rounded-lg p-1">
              {(
                [
                  ['owed', t('account.cardModeOwed', 'এখন কত বকেয়া')],
                  ['available', t('account.cardModeAvailable', 'SMS-এর balance')],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={mode === key}
                  onClick={() => setMode(key)}
                  className={
                    mode === key
                      ? 'press bg-brand text-brand-contrast min-h-11 truncate rounded-md px-1 text-sm font-semibold shadow-sm'
                      : 'press text-ink-muted min-h-11 truncate rounded-md px-1 text-sm'
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            {mode === 'available' ? (
              <p className="text-ink-muted text-xs">
                {t(
                  'account.cardAvailableHint',
                  'অনেক ব্যাংকের কার্ড-বার্তায় “A/C balance” মানে বাকি লিমিট — বকেয়া নয়। লিমিট থেকে বাদ দিয়ে বকেয়া বের করা হবে।',
                )}
              </p>
            ) : null}
          </div>
        ) : null}

        <Field
          label={`${
            isCard
              ? mode === 'available'
                ? t('account.cardAvailableLabel', 'বার্তায় লেখা balance')
                : t('account.cardOwedLabel', 'এখন কত বকেয়া')
              : t('account.realBalance', 'আসল ব্যালেন্স')
          } (${currencyInfo.symbol})`}
          htmlFor="rec-actual"
        >
          <Input
            id="rec-actual"
            value={actual}
            onChange={(e) => setActual(e.target.value)}
            inputMode="decimal"
            required
            className="money text-xl"
          />
        </Field>

        {/* The arithmetic, on screen, before it is written. Somebody who can
            see ৩,০০,০০০ − ১,৬৬,৮৬৭.৬৪ = ১,৩৩,১৩২.৩৬ can also see when the
            limit on file is the wrong one. */}
        {isCard && mode === 'available' ? (
          limitMinor > 0 ? (
            <p className="text-ink-muted text-sm">
              {t('account.limit', 'লিমিট')} <Money minor={limitMinor} className="inline" /> −{' '}
              <Money minor={typedMinor ?? 0} className="inline" /> ={' '}
              <span className="text-expense">
                {t('dashboard.cardOwed', 'বকেয়া')}{' '}
                <Money minor={Math.abs(owedMinor ?? 0)} className="inline" />
              </span>
            </p>
          ) : (
            <p className="text-expense text-sm">
              {t(
                'account.cardNoLimit',
                'এই কার্ডের লিমিট লেখা নেই — আগে সম্পাদনা করে লিমিটটি বসান, নয়তো “এখন কত বকেয়া” লিখুন।',
              )}
            </p>
          )
        ) : null}
        {result ? <p className="text-income text-sm">{result}</p> : null}
        <Button
          type="submit"
          size="block"
          disabled={save.isPending || (isCard && mode === 'available' && limitMinor <= 0)}
        >
          মেলান
        </Button>
      </form>
    </Sheet>
  );
}

/**
 * What an asset is worth now.
 *
 * Asks for the new value, not the change: somebody looking at a plot of land
 * knows what it is worth today and does not know what the ledger has been
 * carrying it at. Asking for the difference would make them do arithmetic in
 * order to avoid doing arithmetic.
 *
 * The history is on the sheet because a single current figure is not a
 * revaluation model — IFRS wants to see the movements, and so does anybody
 * asked to believe a number.
 */
function RevalueSheet({
  account,
  onClose,
  onSaved,
}: {
  account: AccountDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { currency, currencyInfo } = useWorkspaceSettings();
  const [value, setValue] = React.useState('');
  const [note, setNote] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setValue(account ? formatMinor(account.balanceMinor, { symbol: false, currency }) : '');
    setNote('');
    setError(null);
  }, [account, currency]);

  const history = useQuery({
    queryKey: ['accounts', account?.id, 'revaluations'],
    queryFn: () =>
      api<{ id: string; date: string; note: string; deltaMinor: number }[]>(
        `/accounts/${account!.id}/revaluations`,
      ),
    enabled: account !== null,
  });

  const save = useMutation({
    mutationFn: () =>
      api<{ deltaMinor: number }>(`/accounts/${account!.id}/revalue`, {
        method: 'POST',
        body: {
          valueMinor: parseMoneyToMinor(value, currency),
          date: toLocalDateString(new Date()),
          note: note.trim() || undefined,
        },
      }),
    onSuccess: () => {
      haptic('success');
      onSaved();
      onClose();
    },
    onError: (err) => {
      haptic('warn');
      setError(
        err instanceof ApiError ? err.message : t('common.saveFailed', 'সংরক্ষণ করা যায়নি'),
      );
    },
  });

  return (
    <Sheet
      open={account !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t('account.revalueTitle', 'বর্তমান মূল্য')}
      description={account?.name}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (!value.trim()) {
            setError(t('account.valueRequired', 'এখনকার মূল্য লিখুন'));
            return;
          }
          save.mutate();
        }}
      >
        <p className="text-ink-muted text-sm">
          {t(
            'account.revalueHint',
            'এখন এটির বাজারমূল্য কত? পার্থক্যটি নিট সম্পদে যোগ হবে — আয় হিসেবে নয়, এবং নগদ প্রবাহেও যাবে না।',
          )}
        </p>

        <Field
          label={`${t('account.currentValue', 'এখনকার মূল্য')} (${currencyInfo.symbol})`}
          htmlFor="revalue-value"
        >
          <Input
            id="revalue-value"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
        </Field>

        <Field label={t('account.revalueNote', 'কেন')} htmlFor="revalue-note">
          <Input
            id="revalue-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder={t('account.revalueNotePlaceholder', 'যেমন: বাজারদর অনুযায়ী')}
          />
        </Field>

        {error ? (
          <p role="alert" className="bg-expense/10 text-expense rounded-md px-3 py-2 text-sm">
            {error}
          </p>
        ) : null}

        <Button type="submit" size="block" disabled={save.isPending}>
          {save.isPending ? t('common.saving', 'সংরক্ষণ হচ্ছে…') : t('common.save', 'সংরক্ষণ করুন')}
        </Button>

        {(history.data ?? []).length > 0 ? (
          <div>
            <h3 className="text-ink-muted text-sm font-medium">
              {t('account.revalueHistory', 'আগের মূল্যায়ন')}
            </h3>
            <ul className="divide-rule border-rule mt-2 divide-y rounded-md border">
              {(history.data ?? []).map((row) => (
                <li key={row.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0">
                    <span className="text-ink block truncate text-sm">{row.note}</span>
                    <span className="text-ink-muted text-xs">{fmtDate(row.date)}</span>
                  </span>
                  <Money minor={row.deltaMinor} signed colored className="shrink-0 text-sm" />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </form>
    </Sheet>
  );
}

/**
 * Sold it — the moment a paper gain becomes a real one.
 *
 * ## Why this is not the revaluation sheet with a different title
 *
 * Revaluing says the world moved and no money did: it posts against equity and
 * nothing reaches the income statement (IAS 16.39). Selling is where that stops
 * being true — the asset leaves, cash arrives, and the difference is a
 * **realised** gain that belongs in profit or loss (IAS 16.68).
 *
 * The sheet computes that difference live and shows it, because it is the one
 * number somebody will be surprised by. Land bought at ৳8,00,000 and revalued
 * to ৳9,00,000 shows a ৳2,00,000 gain when sold at ৳11,00,000 — not ৳3,00,000.
 * The first lakh was already recognised and is not earned twice.
 *
 * ## Why the খাত picker switches
 *
 * A gain is income and a loss is an expense, and they are filed on opposite
 * sides of the ledger. The server refuses a mismatch, so the picker follows the
 * arithmetic rather than letting somebody choose a head that will be rejected.
 */
function SellSheet({
  account,
  onClose,
  onSaved,
}: {
  account: AccountDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { currency } = useWorkspaceSettings();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });
  const categories = useQuery({ queryKey: ['categories'], queryFn: endpoints.categories });

  const [proceeds, setProceeds] = React.useState('');
  const [destinationId, setDestinationId] = React.useState('');
  const [categoryId, setCategoryId] = React.useState('');
  const [date, setDate] = React.useState(() => toLocalDateString(new Date()));
  const [note, setNote] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setProceeds('');
    setCategoryId('');
    setNote('');
    setDate(toLocalDateString(new Date()));
    setError(null);
  }, [account]);

  /* Anywhere the money could actually land — never the asset being sold. */
  const destinations = React.useMemo(
    () => (accounts.data ?? []).filter((a) => !a.isArchived && a.id !== account?.id),
    [accounts.data, account],
  );

  React.useEffect(() => {
    if (destinations.length > 0) setDestinationId((current) => current || destinations[0]!.id);
  }, [destinations]);

  const carrying = account?.balanceMinor ?? 0;
  const proceedsMinor = proceeds.trim() ? parseMoneyToMinor(proceeds, currency) : 0;
  const gain = proceedsMinor - carrying;
  /* The picker follows the arithmetic: the server refuses an income head on a
     loss, so offering one would be offering a choice that always fails. */
  const gainKind: CategoryScope = gain < 0 ? 'EXPENSE' : 'INCOME';

  React.useEffect(() => setCategoryId(''), [gainKind]);

  const save = useMutation({
    mutationFn: () =>
      api(`/accounts/${account!.id}/sell`, {
        method: 'POST',
        body: {
          proceedsMinor,
          destinationAccountId: destinationId,
          categoryId,
          date,
          note: note.trim() || undefined,
        },
      }),
    onSuccess: () => {
      haptic('success');
      onSaved();
      onClose();
    },
    onError: (err) =>
      setError(
        err instanceof ApiError ? err.message : t('common.saveFailed2', 'সংরক্ষণ করা যায়নি'),
      ),
  });

  if (!account) return null;

  return (
    <Sheet
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('account.sellTitle', 'সম্পদ বিক্রি')}
      description={account.name}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (proceedsMinor <= 0) {
            setError(t('account.sellNeedsPrice', 'কত টাকায় বিক্রি করলেন লিখুন'));
            return;
          }
          if (gain !== 0 && !categoryId) {
            setError(t('account.sellNeedsCategory', 'লাভ বা লোকসান কোন খাতে বসবে বেছে নিন'));
            return;
          }
          save.mutate();
        }}
      >
        <Field label={t('account.sellPrice', 'কত টাকায় বিক্রি করলেন (৳)')} htmlFor="sell-price">
          <Input
            id="sell-price"
            value={proceeds}
            onChange={(e) => setProceeds(e.target.value)}
            inputMode="decimal"
            required
            autoFocus
            className="money text-xl"
            placeholder="০.০০"
          />
        </Field>

        {/* The arithmetic, shown rather than left for somebody to do. The
            carrying amount is cost plus every revaluation since, which is why
            the gain here is smaller than the gain over what was paid. */}
        <div className="rounded-card border-rule bg-greenbar border p-3 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-ink-muted">{t('account.sellCarrying', 'খাতায় এখন আছে')}</span>
            <Money minor={carrying} className="text-ink-muted" />
          </div>
          {proceedsMinor > 0 ? (
            <div className="border-rule mt-2 flex items-baseline justify-between gap-3 border-t pt-2">
              <span className="text-ink font-medium">
                {gain >= 0
                  ? t('account.sellGain', 'বিক্রির লাভ')
                  : t('account.sellLoss', 'বিক্রির লোকসান')}
              </span>
              <Money
                minor={Math.abs(gain)}
                className={gain >= 0 ? 'text-income font-semibold' : 'text-expense font-semibold'}
              />
            </div>
          ) : null}
          <p className="text-ink-muted mt-2 text-xs">
            {t(
              'account.sellHint',
              'বিক্রির লাভ আয় বিবরণীতে যাবে। আগে মূল্যায়নে যতটা বেড়েছিল সেটা এখানে আবার ধরা হবে না — ওটা আগেই হিসাবে এসেছে।',
            )}
          </p>
        </div>

        <Field label={t('account.sellInto', 'টাকাটা কোথায় ঢুকল')} htmlFor="sell-into">
          <Select
            id="sell-into"
            value={destinationId}
            onChange={(e) => setDestinationId(e.target.value)}
            required
          >
            {destinations.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>

        {gain !== 0 ? (
          <Field
            label={
              gain > 0
                ? t('account.sellGainCategory', 'লাভ কোন খাতে')
                : t('account.sellLossCategory', 'লোকসান কোন খাতে')
            }
            htmlFor="sell-category"
          >
            <Select
              id="sell-category"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              required
            >
              <option value="">{t('common.choose', 'বেছে নিন')}</option>
              <CategoryOptions categories={categories.data} kind={gainKind} />
            </Select>
          </Field>
        ) : null}

        <Field label={t('account.sellDate', 'কোন তারিখে')} htmlFor="sell-date">
          <Input
            id="sell-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </Field>

        <Field label={t('account.note', 'নোট')} htmlFor="sell-note">
          <Input
            id="sell-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder={t('account.sellNotePlaceholder', 'যেমন: রেজিস্ট্রি হয়ে গেছে')}
          />
        </Field>

        {/* Said before the button, because archiving is the part somebody does
            not expect and would otherwise discover by the asset vanishing. */}
        <p className="text-ink-muted text-xs">
          {t(
            'account.sellArchiveNote',
            'বিক্রির পর সম্পদটি “বিক্রি করা সম্পদ”-এ চলে যাবে — মুছে যাবে না, শুধু মোটের বাইরে থাকবে।',
          )}
        </p>

        {error ? (
          <p role="alert" className="text-expense text-sm">
            {error}
          </p>
        ) : null}
        <Button type="submit" size="block" disabled={save.isPending}>
          {t('common.save', 'সংরক্ষণ করুন')}
        </Button>
      </form>
    </Sheet>
  );
}
