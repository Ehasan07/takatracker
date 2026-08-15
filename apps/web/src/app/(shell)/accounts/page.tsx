'use client';

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
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
} from 'lucide-react';
import * as React from 'react';
import { formatMinor, parseMoneyToMinor, toLocalDateString } from '@hishab/shared';
import { Money } from '@/components/money';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
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

const groupLabel = (group: (typeof TYPE_GROUPS)[number]): string =>
  t(`account.group.${group}`, GROUP_LABELS[group]);

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
  const subtotals = React.useMemo(() => {
    const sums: Record<(typeof TYPE_GROUPS)[number], number> = {
      liquid: 0,
      asset: 0,
      liability: 0,
    };
    for (const account of accounts.data ?? []) {
      sums[groupOfType(account.type)] += account.balanceMinor;
    }
    return sums;
  }, [accounts.data]);

  const netWorth = subtotals.liquid + subtotals.asset + subtotals.liability;

  /* The list in the same three parts as the figures above, and in the same
     order a balance sheet reads. A flat list put a plot of land between two
     bank accounts. */
  const grouped = React.useMemo(
    () =>
      TYPE_GROUPS.map(
        (group) =>
          [group, (accounts.data ?? []).filter((a) => groupOfType(a.type) === group)] as const,
      ).filter(([, rows]) => rows.length > 0),
    [accounts.data],
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
        <Money minor={subtotals.liquid} className="text-2xl font-semibold" />

        <dl className="text-ink-muted mt-3 flex flex-col gap-1 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt>{t('account.total.asset', 'সম্পদ (জমি, স্বর্ণ, পাওনা)')}</dt>
            <dd>
              <Money minor={subtotals.asset} />
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt>{t('account.total.liability', 'দায় (কার্ড, ঋণ, দেনা)')}</dt>
            <dd>
              <Money minor={subtotals.liability} />
            </dd>
          </div>
          <div className="border-rule text-ink flex items-center justify-between gap-3 border-t pt-1 font-medium">
            <dt>{t('account.total.net', 'নিট সম্পদ')}</dt>
            <dd>
              <Money minor={netWorth} />
            </dd>
          </div>
        </dl>
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
          {grouped.flatMap(([group, rows]) => [
            <li
              key={`head-${group}`}
              className="border-rule bg-greenbar/40 text-ink-muted flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs font-medium"
            >
              <span>{groupLabel(group)}</span>
              <Money minor={rows.reduce((sum, a) => sum + a.balanceMinor, 0)} />
            </li>,
            ...rows.map((account) => (
              <li
                key={account.id}
                className="ledger-row border-rule flex items-center gap-2 border-b px-3 py-2 last:border-b-0"
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
                  className="press flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md text-left"
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
                  </span>
                  <Pencil className="text-ink-muted h-3.5 w-3.5 shrink-0" aria-hidden />
                </button>
                <Money minor={account.balanceMinor} className="amount-col shrink-0 pl-2 text-sm" />
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
                      <Money minor={account.balanceMinor} className="shrink-0 text-sm" />
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
  masked: string;
  hints: string;
  icon: string;
  color: string;
  sortOrder: string;
  statementDay: string;
  dueDay: string;
  leadDays: string;
}

const toForm = (a: AccountDto | null): AccountForm => ({
  name: a?.name ?? '',
  type: a?.type ?? 'CASH',
  // Major units, so the field reads the way it was typed in the first place.
  opening: formatMinor(a?.openingBalance ?? 0, { symbol: false }),
  institution: a?.institution ?? '',
  masked: a?.accountNumberMasked ?? '',
  hints: (a?.matchHints ?? []).join(', '),
  icon: a?.icon ?? '',
  color: a?.color ?? '',
  sortOrder: String(a?.sortOrder ?? 0),
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
  const next = {
    name: form.name.trim(),
    type: form.type,
    openingBalance,
    institution: form.institution.trim(),
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
    statementDayOfMonth: isCard && form.statementDay ? Number(form.statementDay) : null,
    dueDayOfMonth: isCard && form.dueDay ? Number(form.dueDay) : null,
    reminderLeadDays: isCard && form.leadDays ? Number(form.leadDays) : null,
  };
  const before: typeof next = {
    name: account.name,
    type: account.type,
    openingBalance: account.openingBalance,
    institution: account.institution ?? '',
    accountNumberMasked: account.accountNumberMasked ?? '',
    matchHints: account.matchHints,
    icon: account.icon ?? '',
    color: account.color ?? '',
    sortOrder: account.sortOrder,
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
        <p className="text-ink-muted -mt-2 text-xs">
          খাতা অনুযায়ী এখন <Money minor={account?.balanceMinor ?? 0} className="inline" />।
          প্রারম্ভিক জের বদলালে আজকের ব্যালেন্সও ঠিক ততটাই বদলাবে।
        </p>

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
  const [dueDay, setDueDay] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api<AccountDto>('/accounts', {
        method: 'POST',
        body: {
          name,
          type,
          openingBalance: openingBalance ? parseMoneyToMinor(openingBalance, currency) : 0,
          // Only a card has a payment due day; sending it for cash would be noise.
          dueDayOfMonth: type === 'CREDIT_CARD' && dueDay ? Number(dueDay) : undefined,
        },
      }),
    onSuccess: () => {
      setName('');
      setOpeningBalance('');
      setDueDay('');
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
        {error ? (
          <p role="alert" className="text-expense text-sm">
            {error}
          </p>
        ) : null}
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

  React.useEffect(() => {
    setActual('');
    setResult(null);
  }, [account]);

  const save = useMutation({
    mutationFn: () =>
      api<{ delta: number }>(`/accounts/${account!.id}/reconcile`, {
        method: 'POST',
        body: {
          date: toLocalDateString(new Date()),
          actualBalanceMinor: parseMoneyToMinor(actual, currency),
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
        <p className="text-ink-muted text-sm">
          খাতা অনুযায়ী এখন <Money minor={account?.balanceMinor ?? 0} className="inline" />। আসল
          ব্যালেন্স লিখুন — পার্থক্যটি সমন্বয় হিসেবে যোগ হবে।
        </p>
        <Field
          label={`${t('account.realBalance', 'আসল ব্যালেন্স')} (${currencyInfo.symbol})`}
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
        {result ? <p className="text-income text-sm">{result}</p> : null}
        <Button type="submit" size="block" disabled={save.isPending}>
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
