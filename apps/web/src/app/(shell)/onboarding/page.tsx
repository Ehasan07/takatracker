'use client';

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, ChevronRight, Info, Plus, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { parseMoneyToMinor, toBengaliDigits } from '@hishab/shared';
import { QueryError } from '@/app/(shell)/loans/parts';
import { Money } from '@/components/money';
import { QuickAddSheet } from '@/components/quick-add-sheet';
import { SkeletonRows } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { useKeyboardInset } from '@/hooks/use-device';
import { api, endpoints, FeatureLimitError, type AccountDto } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import {
  ACCOUNT_SUGGESTIONS,
  ACCOUNT_TYPES,
  NEXT_STEPS,
  STEP_ORDER,
  STEPS,
  TYPE_GROUPS,
  typeLabel,
  type AccountSuggestion,
  type StepId,
} from './labels';
import { useCompleteOnboarding, useMe } from './queries';

/**
 * First run.
 *
 * Signing up used to land on ৳0.00 and three empty states, which is a dead end
 * for anybody who does not already think in accounts: a double-entry ledger
 * refuses to record an expense until money has somewhere to come from, and
 * nothing on the dashboard said so. This route is the shortest path out of
 * that, and nothing more — it is not a tour.
 *
 * Every part of it can be walked away from. The header carries a skip on every
 * step, the shell's back arrow works throughout, and both exits mark first run
 * done, so a person who skipped is never asked again. The route stays reachable
 * afterwards, so it is also the "run me again" that settings can point at.
 *
 * The two forms it needs already exist and are not written a second time here:
 * accounts go through the same `POST /accounts` shape the accounts screen uses,
 * including how it surfaces the plan's 402, and the optional first transaction
 * is the real `<QuickAddSheet />` — offline queue, keypad, tags and all.
 */

interface Draft {
  /** Stable across re-renders and re-orders; also the input's id. */
  key: string;
  /** Which chip produced this, so the chip can show as taken. Null for অন্য কিছু. */
  suggestionId: string | null;
  name: string;
  type: string;
  /** Exactly as typed. Parsed once, at save, by `parseMoneyToMinor`. */
  opening: string;
}

interface SaveOutcome {
  savedKeys: string[];
  error: string | null;
  /** The plan refused. Worth its own link rather than a bare sentence. */
  limit: boolean;
}

/**
 * An opening balance is money on the books: it moves today's balance, the
 * month's summary, the balance sheet and the plan's account count. Everything
 * that reads any of those is stale the moment one of these lands — the same
 * list `accounts/page.tsx` invalidates, for the same reasons.
 */
function invalidateAccountData(queryClient: QueryClient): void {
  for (const key of [['accounts'], ['summary'], ['transactions'], ['reports'], ['entitlements']]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

export default function OnboardingPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const keyboardInset = useKeyboardInset();

  const [step, setStep] = React.useState<StepId>('accounts');
  const [drafts, setDrafts] = React.useState<Draft[]>([]);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [limitRefusal, setLimitRefusal] = React.useState(false);
  const [quickAddOpen, setQuickAddOpen] = React.useState(false);
  const nextKey = React.useRef(0);

  const me = useMe();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });
  const entitlements = useQuery({ queryKey: ['entitlements'], queryFn: endpoints.entitlements });
  /* Only to tell whether step two has already happened — one row is enough, and
     it shares the ledger's cache key so the dashboard's copy stays warm. */
  const recent = useQuery({
    queryKey: ['transactions', { limit: 1 }],
    queryFn: () => endpoints.transactions({ limit: 1 }),
  });

  const complete = useCompleteOnboarding();
  const alreadyCompleted = Boolean(me.data?.onboardingCompletedAt);

  const existing = accounts.data ?? [];
  const existingNames = React.useMemo(
    () => new Set(existing.map((account) => account.name.trim())),
    [existing],
  );

  const accountLimit = entitlements.data?.entitlements['accounts.max'] ?? null;
  const accountsUsed = entitlements.data?.usage['accounts.max'] ?? existing.length;
  /** null means the plan does not cap accounts at all. */
  const room = accountLimit === null ? null : accountLimit - accountsUsed - drafts.length;
  const noRoom = room !== null && room <= 0;

  const stepIndex = STEP_ORDER.indexOf(step);
  const firstTxn = recent.data?.items[0] ?? null;

  /* --- leaving ------------------------------------------------------------- */

  /**
   * Finish and skip are the same request. The difference is only what the
   * person did before pressing it, and the server has never needed to know.
   */
  const leave = (): void => {
    haptic('success');
    complete.mutate(undefined, {
      onSuccess: () => {
        router.push('/');
      },
    });
  };

  /* --- accounts ------------------------------------------------------------ */

  const addDraft = (suggestion: AccountSuggestion | null): void => {
    haptic('select');
    setSaveError(null);
    nextKey.current += 1;
    setDrafts((rows) => [
      ...rows,
      {
        key: `draft-${nextKey.current}`,
        suggestionId: suggestion?.id ?? null,
        name: suggestion?.name ?? '',
        type: suggestion?.type ?? 'CASH',
        opening: '',
      },
    ]);
  };

  const patchDraft = (key: string, patch: Partial<Draft>): void =>
    setDrafts((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const removeDraft = (key: string): void => {
    haptic('tap');
    setDrafts((rows) => rows.filter((row) => row.key !== key));
  };

  /**
   * One POST per account, in order, stopping at the first refusal.
   *
   * It resolves with an outcome instead of throwing, because which rows got in
   * before the refusal is not an error detail — it is the state the screen has
   * to show. On a FREE plan the sixth account comes back 402 with a sentence of
   * its own; the five before it are real, and re-sending them would be five
   * duplicates.
   */
  const saveDrafts = useMutation<SaveOutcome, Error, Draft[]>({
    mutationFn: async (rows) => {
      const savedKeys: string[] = [];
      for (const row of rows) {
        try {
          await api<AccountDto>('/accounts', {
            method: 'POST',
            body: {
              name: row.name.trim(),
              type: row.type,
              openingBalance: row.opening.trim() ? parseMoneyToMinor(row.opening) : 0,
            },
          });
          savedKeys.push(row.key);
        } catch (err) {
          return {
            savedKeys,
            error: err instanceof Error ? err.message : 'অ্যাকাউন্ট যোগ করা যায়নি',
            limit: err instanceof FeatureLimitError,
          };
        }
      }
      return { savedKeys, error: null, limit: false };
    },
    onSuccess: (outcome) => {
      if (outcome.savedKeys.length > 0) {
        invalidateAccountData(queryClient);
        setDrafts((rows) => rows.filter((row) => !outcome.savedKeys.includes(row.key)));
      }
      setSaveError(outcome.error);
      setLimitRefusal(outcome.limit);
      if (outcome.error) {
        haptic('warn');
        return;
      }
      haptic('success');
      setStep('entry');
    },
  });

  /**
   * Both checks happen before a single request goes out. A typo in the third
   * row should not leave the first two written and the screen half-saved, and
   * `parseMoneyToMinor` is the only thing that decides whether ০.২৯ is 29
   * poisha — never `Number(x) * 100`, which makes it 28.
   */
  const saveAndAdvance = (): void => {
    setSaveError(null);
    setLimitRefusal(false);

    if (drafts.length === 0) {
      setStep('entry');
      return;
    }

    const rows = drafts.map((row) => ({ ...row, name: row.name.trim() }));

    if (rows.some((row) => row.name === '')) {
      setSaveError('প্রতিটি অ্যাকাউন্টের একটা নাম দরকার।');
      return;
    }
    for (const row of rows) {
      if (!row.opening.trim()) continue;
      try {
        parseMoneyToMinor(row.opening);
      } catch {
        setSaveError(`“${row.name}” — অঙ্কটা বোঝা যায়নি। যেমন: ১২৫০ বা 1250.50`);
        return;
      }
    }

    saveDrafts.mutate(rows);
  };

  /* --- render -------------------------------------------------------------- */

  const currentStep = STEPS.find((entry) => entry.id === step);
  const busy = saveDrafts.isPending || complete.isPending;

  return (
    <div
      className="mx-auto flex w-full max-w-2xl flex-col gap-4"
      /* The on-screen keyboard shrinks the viewport, not the scroll container.
         Without this the last balance field on a long list sits underneath it
         and the browser has nowhere to scroll it to. */
      style={keyboardInset > 0 ? { paddingBottom: `${keyboardInset}px` } : undefined}
    >
      {/* The shell's phone title bar can only say "হিসাব" for a route that is in
          no menu, so this heading is visible at every width — the same thing the
          loan detail screens do. */}
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-ink text-xl font-semibold sm:text-2xl">শুরু করা যাক</h1>
          <p className="text-ink-muted mt-0.5 text-sm">
            {me.data?.name ? `${me.data.name}, ` : ''}দুই মিনিটের কাজ। যেকোনো সময় থামা যাবে।
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={leave} disabled={busy}>
          {alreadyCompleted ? 'বন্ধ করুন' : 'পরে করব'}
        </Button>
      </header>

      {alreadyCompleted ? (
        <p className="text-ink-muted rounded-card border-rule border border-dashed px-3 py-2 text-xs">
          শুরুর ধাপ আগেই সম্পন্ন হয়েছে। এখান থেকে যা যোগ করবেন তা সরাসরি খাতায় যাবে।
        </p>
      ) : null}

      <Stepper current={stepIndex} onGoTo={setStep} />

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-ink text-base font-semibold">{currentStep?.title}</h2>
          <p className="text-ink-muted mt-1 text-sm">{currentStep?.blurb}</p>
        </div>

        {step === 'accounts' ? (
          <>
            {accounts.isError ? (
              <QueryError
                message="অ্যাকাউন্টের তালিকা আনা যায়নি।"
                onRetry={() => void accounts.refetch()}
              />
            ) : accounts.isLoading ? (
              <div className="rounded-card border-rule bg-surface overflow-hidden border">
                <SkeletonRows rows={2} />
              </div>
            ) : existing.length > 0 ? (
              <ul className="rounded-card border-rule bg-surface overflow-hidden border">
                {existing.map((account) => (
                  <li
                    key={account.id}
                    className="border-rule flex items-center gap-2 border-b px-3 py-2.5 last:border-b-0"
                  >
                    <Check className="text-income h-4 w-4 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="text-ink block truncate text-sm font-medium">
                        {account.name}
                      </span>
                      <span className="text-ink-muted block truncate text-xs">
                        {typeLabel(account.type)}
                      </span>
                    </span>
                    <Money minor={account.balanceMinor} className="shrink-0 text-sm" />
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="flex flex-col gap-2">
              <p className="text-ink text-sm font-medium">যেগুলো আছে সেগুলোয় চাপ দিন</p>
              <div className="flex flex-wrap gap-2">
                {ACCOUNT_SUGGESTIONS.map((suggestion) => {
                  const taken =
                    existingNames.has(suggestion.name) ||
                    drafts.some((row) => row.suggestionId === suggestion.id);
                  return (
                    <SuggestionChip
                      key={suggestion.id}
                      label={suggestion.name}
                      taken={taken}
                      disabled={taken || noRoom}
                      onClick={() => addDraft(suggestion)}
                    />
                  );
                })}
                <SuggestionChip
                  label="অন্য কিছু"
                  taken={false}
                  disabled={noRoom}
                  onClick={() => addDraft(null)}
                />
              </div>
              {noRoom ? (
                <p className="text-brass text-xs">
                  প্ল্যানে আর জায়গা নেই।{' '}
                  <Link href="/plans" className="underline">
                    প্ল্যান দেখুন
                  </Link>{' '}
                  অথবা অ্যাকাউন্ট পাতা থেকে পুরনো কোনোটি আর্কাইভ করুন।
                </p>
              ) : room !== null ? (
                <p className="text-ink-muted text-xs">
                  আপনার প্ল্যানে আর {toBengaliDigits(String(room))}টি অ্যাকাউন্ট যোগ করা যাবে।
                </p>
              ) : null}
            </div>

            {drafts.length > 0 ? (
              <ul className="flex flex-col gap-3">
                {drafts.map((draft) => (
                  <li
                    key={draft.key}
                    className="rounded-card border-rule bg-surface flex flex-col gap-3 border p-3"
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <Field label="নাম" htmlFor={`${draft.key}-name`}>
                          <Input
                            id={`${draft.key}-name`}
                            value={draft.name}
                            onChange={(e) => patchDraft(draft.key, { name: e.target.value })}
                            placeholder="যেমন: ব্র্যাক ব্যাংক"
                            autoFocus={draft.suggestionId === null}
                          />
                        </Field>
                      </div>
                      <button
                        type="button"
                        aria-label={`${draft.name || 'নতুন অ্যাকাউন্ট'} সরান`}
                        onClick={() => removeDraft(draft.key)}
                        className="press touch-target text-ink-muted hover:bg-greenbar mt-6 flex shrink-0 items-center justify-center rounded-md"
                      >
                        <X className="h-4 w-4" aria-hidden />
                      </button>
                    </div>

                    {/* The chip already chose the type; only অন্য কিছু has to ask. */}
                    {draft.suggestionId === null ? (
                      <Field label="ধরন" htmlFor={`${draft.key}-type`}>
                        <Select
                          id={`${draft.key}-type`}
                          value={draft.type}
                          onChange={(e) => patchDraft(draft.key, { type: e.target.value })}
                        >
                          {TYPE_GROUPS.map((group) => (
                            <optgroup key={group} label={group}>
                              {ACCOUNT_TYPES.filter((type) => type.group === group).map((type) => (
                                <option key={type.value} value={type.value}>
                                  {type.label}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </Select>
                      </Field>
                    ) : (
                      <p className="text-ink-muted -mt-1 text-xs">{typeLabel(draft.type)}</p>
                    )}

                    <Field label="এখন কত আছে (৳)" htmlFor={`${draft.key}-opening`}>
                      <Input
                        id={`${draft.key}-opening`}
                        value={draft.opening}
                        onChange={(e) => patchDraft(draft.key, { opening: e.target.value })}
                        inputMode="decimal"
                        enterKeyHint="done"
                        placeholder="০.০০"
                        className="money"
                      />
                    </Field>
                  </li>
                ))}
                <li className="text-ink-muted text-xs">
                  অঙ্কটা না জানলে ফাঁকা রাখুন — পরে অ্যাকাউন্ট পাতা থেকে আসল ব্যালেন্স মিলিয়ে
                  নেওয়া যাবে।
                </li>
              </ul>
            ) : null}

            {saveError ? (
              <div
                role="alert"
                className="bg-expense/10 text-expense flex flex-col items-start gap-2 rounded-md px-3 py-2 text-sm"
              >
                <p>{saveError}</p>
                {limitRefusal ? (
                  <Link href="/plans" className="press flex min-h-11 items-center underline">
                    প্ল্যান দেখুন
                  </Link>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}

        {step === 'entry' ? (
          existing.length === 0 ? (
            <div className="rounded-card border-rule flex flex-col items-start gap-3 border border-dashed p-4">
              <p className="text-ink text-sm">
                এখনও কোনো অ্যাকাউন্ট নেই। খরচ লিখতে হলে টাকাটা কোথা থেকে গেল তা খাতার জানা দরকার,
                তাই আগে অন্তত একটা অ্যাকাউন্ট লাগবে।
              </p>
              <Button variant="outline" size="sm" onClick={() => setStep('accounts')}>
                <ArrowLeft className="h-4 w-4" aria-hidden />
                আগের ধাপে ফিরুন
              </Button>
            </div>
          ) : firstTxn ? (
            <div className="rounded-card border-rule bg-surface flex flex-col gap-2 border p-4">
              <p className="text-income flex items-center gap-1.5 text-sm font-medium">
                <Check className="h-4 w-4 shrink-0" aria-hidden />
                খাতায় প্রথম লেখা হয়ে গেছে।
              </p>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-ink min-w-0 truncate text-sm">
                  {firstTxn.description ||
                    firstTxn.categoryName ||
                    firstTxn.accountName ||
                    'লেনদেন'}
                </span>
                <Money minor={firstTxn.amountMinor} colored signed className="shrink-0 text-sm" />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => setQuickAddOpen(true)}
              >
                <Plus className="h-4 w-4" aria-hidden />
                আরেকটা লিখুন
              </Button>
            </div>
          ) : (
            <div className="rounded-card border-rule bg-surface flex flex-col items-start gap-3 border p-4">
              <p className="text-ink-muted text-sm">
                আজকের একটা খরচ বা এই মাসের আয় — যেটা মনে আছে সেটাই লিখুন। ভুল হলে পরে বদলানো যাবে।
              </p>
              <Button onClick={() => setQuickAddOpen(true)}>
                <Plus className="h-4 w-4" aria-hidden />
                প্রথম লেনদেন লিখুন
              </Button>
            </div>
          )
        ) : null}

        {step === 'next' ? (
          <ul className="flex flex-col gap-2">
            {NEXT_STEPS.map((item) => (
              <li key={item.title}>
                <Link
                  href={item.href}
                  onClick={() => haptic('tap')}
                  className="press rounded-card border-rule bg-surface hover:bg-greenbar flex items-start gap-2 border p-3"
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-ink block text-sm font-medium">{item.title}</span>
                    <span className="text-ink-muted mt-0.5 block text-xs">{item.body}</span>
                    {/* Said out loud, not hidden behind the link: these two
                        cannot be finished from inside the app. */}
                    {item.caveat ? (
                      <span className="text-brass mt-1.5 flex items-start gap-1.5 text-xs">
                        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                        <span>{item.caveat}</span>
                      </span>
                    ) : null}
                  </span>
                  <ChevronRight className="text-ink-muted mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {complete.isError ? (
        <div
          role="alert"
          className="bg-expense/10 text-expense flex flex-col items-start gap-2 rounded-md px-3 py-2 text-sm"
        >
          <p>{complete.error.message}</p>
          {/* Failing to record the flag must not trap anybody on this screen. */}
          <Link href="/" className="press flex min-h-11 items-center underline">
            তবু ড্যাশবোর্ডে যান
          </Link>
        </div>
      ) : null}

      {/* In normal flow, not stuck to the bottom: a fixed bar is the thing that
          ends up sitting on top of the field being typed into. */}
      <div className="flex flex-col gap-2 pt-1">
        {step === 'accounts' ? (
          <Button size="block" onClick={saveAndAdvance} disabled={busy}>
            {saveDrafts.isPending
              ? 'যোগ হচ্ছে…'
              : drafts.length > 0
                ? `${toBengaliDigits(String(drafts.length))}টি যোগ করে এগোন`
                : 'পরের ধাপ'}
          </Button>
        ) : null}

        {step === 'entry' ? (
          <Button size="block" onClick={() => setStep('next')} disabled={busy}>
            {firstTxn ? 'পরের ধাপ' : 'এখন থাক, পরে লিখব'}
          </Button>
        ) : null}

        {step === 'next' ? (
          <Button size="block" onClick={leave} disabled={busy}>
            {complete.isPending ? 'শেষ হচ্ছে…' : 'শেষ করুন'}
          </Button>
        ) : null}

        {stepIndex > 0 ? (
          <Button
            variant="outline"
            size="block"
            disabled={busy}
            onClick={() => setStep(STEP_ORDER[stepIndex - 1] ?? 'accounts')}
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            আগের ধাপ
          </Button>
        ) : null}
      </div>

      <QuickAddSheet open={quickAddOpen} onOpenChange={setQuickAddOpen} />
    </div>
  );
}

/**
 * Where we are, and a way back to anything already passed.
 *
 * Numbers only under `sm`: three Bengali step names do not fit across 320px
 * without truncating all three into nothing. The names are still on each
 * button's accessible name, and the current one is the `<h2>` below.
 */
function Stepper({ current, onGoTo }: { current: number; onGoTo: (step: StepId) => void }) {
  return (
    <ol className="flex items-center gap-1.5" aria-label="ধাপ">
      {STEPS.map((entry, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={entry.id} className="flex min-w-0 flex-1 items-center">
            <button
              type="button"
              disabled={index > current}
              aria-current={active ? 'step' : undefined}
              aria-label={`ধাপ ${toBengaliDigits(String(index + 1))} — ${entry.title}`}
              onClick={() => {
                haptic('tap');
                onGoTo(entry.id);
              }}
              className={cn(
                'press flex min-h-11 w-full items-center gap-2 rounded-md px-1 disabled:opacity-100',
                index > current && 'cursor-default',
              )}
            >
              <span
                className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
                  done && 'bg-income border-income text-white',
                  active && 'border-income text-income',
                  !done && !active && 'border-rule text-ink-muted',
                )}
              >
                {done ? (
                  <Check className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  toBengaliDigits(String(index + 1))
                )}
              </span>
              <span
                aria-hidden
                className={cn(
                  'hidden min-w-0 truncate text-xs sm:block',
                  active ? 'text-ink font-medium' : 'text-ink-muted',
                )}
              >
                {entry.title}
              </span>
              {/* The rail between the pills, so three buttons read as one path. */}
              {index < STEPS.length - 1 ? (
                <span
                  aria-hidden
                  className={cn('h-px min-w-0 flex-1', done ? 'bg-income' : 'bg-rule')}
                />
              ) : null}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** A tappable account suggestion. 44px on a finger, wraps rather than scrolls. */
function SuggestionChip({
  label,
  taken,
  disabled,
  onClick,
}: {
  label: string;
  taken: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={taken}
      onClick={onClick}
      className={cn(
        'press border-rule flex min-h-11 max-w-full items-center gap-1.5 rounded-full border px-3.5 text-sm disabled:opacity-50 md:min-h-9',
        taken ? 'bg-greenbar text-ink-muted' : 'bg-surface text-ink hover:bg-greenbar',
      )}
    >
      {taken ? (
        <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
      ) : (
        <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden />
      )}
      <span className="truncate">{label}</span>
    </button>
  );
}
