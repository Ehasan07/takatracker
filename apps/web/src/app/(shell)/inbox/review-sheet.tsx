'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
} from 'lucide-react';
import * as React from 'react';
import { formatMinor, MoneyParseError, parseMoneyToMinor } from '@hishab/shared';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useIsDesktop } from '@/hooks/use-device';
import { ApiError, endpoints, type CategoryDto } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { originOf, type FieldOrigin } from './evidence';
import { bnDateTime, bnNum, channelLabel, DIRECTIONS, REJECT_REASONS, statusLabel } from './labels';
import { ConfidenceMeter, OriginBadge, StatusPill } from './parts';
import { RawMessage } from './raw-message';
import { acceptDraft, invalidateAfterAccept, invalidateAfterReject, rejectDraft } from './queries';
import type { AcceptDraftBody, Direction, DraftView, RejectReason } from './types';

/**
 * The account and category the reviewer last accepted with.
 *
 * Fifty alerts from one bank land in one account and usually in one or two
 * categories. Carrying the last choice forward is the difference between fifty
 * decisions and fifty confirmations. It is never silent: the pickers show what
 * was carried and a line under them says where it came from.
 */
export interface StickyPick {
  accountId: string;
  categoryId: string;
}

export type Outcome = 'accepted' | 'rejected';

interface FormState {
  date: string;
  amount: string;
  direction: '' | Direction;
  payee: string;
  accountId: string;
  categoryId: string;
  description: string;
  notes: string;
}

function categoryKindFor(direction: '' | Direction): 'INCOME' | 'EXPENSE' | null {
  if (direction === 'IN') return 'INCOME';
  if (direction === 'OUT') return 'EXPENSE';
  return null;
}

function categoryName(category: CategoryDto): string {
  return category.nameBn?.trim() || category.name;
}

/** Bengali for whatever went wrong, whoever it came from. */
function messageFor(err: unknown): string {
  // ApiError already carries the server's own Bengali message, and
  // FeatureLimitError extends it, so the plan-limit text lands here too.
  return err instanceof ApiError ? err.message : 'সংরক্ষণ করা যায়নি';
}

export function ReviewSheet({
  draft,
  position,
  total,
  hasPrev,
  hasNext,
  onStep,
  onClose,
  onResolved,
  sticky,
  onSticky,
}: {
  draft: DraftView | null;
  /** 1-based place in the loaded queue. */
  position: number;
  total: number;
  hasPrev: boolean;
  hasNext: boolean;
  onStep: (delta: -1 | 1) => void;
  onClose: () => void;
  onResolved: (draft: DraftView, outcome: Outcome) => void;
  sticky: StickyPick;
  onSticky: (pick: StickyPick) => void;
}) {
  const isDesktop = useIsDesktop();

  /* j / k / arrows walk the queue, the way they do in a mail client, and with
   * the same guard the app shell already puts on its own "n": never while
   * somebody is typing into a field. */
  React.useEffect(() => {
    if (!draft) return;
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable;
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        onStep(1);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        onStep(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft, onStep]);

  return (
    <Sheet
      open={draft !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="বার্তা যাচাই"
      description={
        total > 0 ? `${bnNum(position)} / ${bnNum(total)}টি খসড়া` : 'খসড়া দেখে খাতায় তুলুন'
      }
      className="md:w-[40rem]"
    >
      {draft ? (
        <ReviewForm
          key={draft.id}
          draft={draft}
          isDesktop={isDesktop}
          hasPrev={hasPrev}
          hasNext={hasNext}
          onStep={onStep}
          onResolved={onResolved}
          sticky={sticky}
          onSticky={onSticky}
        />
      ) : null}
    </Sheet>
  );
}

function ReviewForm({
  draft,
  isDesktop,
  hasPrev,
  hasNext,
  onStep,
  onResolved,
  sticky,
  onSticky,
}: {
  draft: DraftView;
  isDesktop: boolean;
  hasPrev: boolean;
  hasNext: boolean;
  onStep: (delta: -1 | 1) => void;
  onResolved: (draft: DraftView, outcome: Outcome) => void;
  sticky: StickyPick;
  onSticky: (pick: StickyPick) => void;
}) {
  const queryClient = useQueryClient();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });
  const categories = useQuery({ queryKey: ['categories'], queryFn: endpoints.categories });

  const pending = draft.status === 'PENDING';

  const [form, setForm] = React.useState<FormState>(() => ({
    date: draft.date ?? '',
    /* Empty when the message carried no figure. A zero-confidence draft claims
       nothing, and a form pre-filled with ০.০০ would be claiming it. */
    amount: draft.amountMinor === null ? '' : formatMinor(draft.amountMinor, { symbol: false }),
    direction: draft.direction ?? '',
    payee: draft.payee ?? '',
    accountId: draft.accountId ?? sticky.accountId,
    categoryId: draft.categoryId ?? sticky.categoryId,
    description: '',
    notes: '',
  }));
  const [stickyApplied] = React.useState(
    () =>
      (!draft.accountId && Boolean(sticky.accountId)) ||
      (!draft.categoryId && Boolean(sticky.categoryId)),
  );
  const [error, setError] = React.useState<string | null>(null);
  const [rejecting, setRejecting] = React.useState(false);
  const [reason, setReason] = React.useState<RejectReason>('BAD_PARSE');

  const formRef = React.useRef<HTMLFormElement>(null);

  const liveAccounts = (accounts.data ?? []).filter((account) => !account.isArchived);
  const wantedKind = categoryKindFor(form.direction);
  const liveCategories = (categories.data ?? []).filter(
    (category) => wantedKind === null || category.kind === wantedKind,
  );

  /* A category carried over from an expense must not survive a switch to
     income: the server would refuse it, and leaving it on screen would make
     the refusal look like a bug rather than a mismatch. */
  React.useEffect(() => {
    if (!form.categoryId || wantedKind === null || categories.data === undefined) return;
    const chosen = categories.data.find((category) => category.id === form.categoryId);
    if (chosen && chosen.kind !== wantedKind) setForm((f) => ({ ...f, categoryId: '' }));
  }, [form.categoryId, wantedKind, categories.data]);

  const set =
    (key: keyof FormState) =>
    (e: { target: { value: string } }): void =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const accept = useMutation({
    mutationFn: (body: AcceptDraftBody) => acceptDraft(draft.id, body),
    onSuccess: (saved) => {
      haptic('success');
      onSticky({ accountId: form.accountId, categoryId: form.categoryId });
      invalidateAfterAccept(queryClient);
      onResolved(saved, 'accepted');
    },
    onError: (err) => {
      haptic('warn');
      setError(messageFor(err));
    },
  });

  const reject = useMutation({
    mutationFn: () => rejectDraft(draft.id, reason),
    onSuccess: (saved) => {
      haptic('warn');
      invalidateAfterReject(queryClient);
      onResolved(saved, 'rejected');
    },
    onError: (err) => setError(messageFor(err)),
  });

  const busy = accept.isPending || reject.isPending;

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    setError(null);

    if (!form.date) {
      setError('তারিখ দিন');
      return;
    }

    let amountMinor: number;
    try {
      // Taka typed by a human becomes poisha here, truncated, never rounded.
      amountMinor = parseMoneyToMinor(form.amount);
    } catch (err) {
      setError(err instanceof MoneyParseError ? 'টাকার পরিমাণ বোঝা গেল না' : 'টাকার পরিমাণ দিন');
      return;
    }
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      setError('টাকার পরিমাণ দিন');
      return;
    }
    if (form.direction !== 'IN' && form.direction !== 'OUT') {
      setError('টাকা ঢুকেছে না বেরিয়েছে — সেটি বেছে নিন');
      return;
    }
    if (!form.accountId) {
      setError('অ্যাকাউন্ট নির্বাচন করুন');
      return;
    }
    if (!form.categoryId) {
      setError('ক্যাটাগরি নির্বাচন করুন');
      return;
    }

    const description = form.description.trim();
    const notes = form.notes.trim();
    const payee = form.payee.trim() || null;

    /* Only what actually changed.
     *
     * Every field is optional and an absent one keeps the parser's proposal,
     * so sending all six would produce the same transaction — but the accept
     * audit record stores `Object.keys(input)` as *which fields the person had
     * to correct*, and that is the signal a future rule-quality report reads.
     * Sending an untouched amount back would tell it the parser got the amount
     * wrong. The two pickers are always in here: the parser never proposes
     * either, so supplying them is not a correction, it is the only way the
     * merged result can have them at all. */
    accept.mutate({
      accountId: form.accountId,
      categoryId: form.categoryId,
      ...(form.date === draft.date ? {} : { date: form.date }),
      ...(amountMinor === draft.amountMinor ? {} : { amountMinor }),
      ...(form.direction === draft.direction ? {} : { direction: form.direction }),
      // null clears a payee the parser guessed; '' would store an empty string.
      ...(payee === draft.payee ? {} : { payee }),
      ...(description ? { description } : {}),
      ...(notes ? { notes } : {}),
    });
  };

  // Ctrl/⌘+Enter accepts from anywhere in the form, including a textarea.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      formRef.current?.requestSubmit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const message = draft.message;

  return (
    <form ref={formRef} onSubmit={submit} className="flex min-w-0 flex-col gap-4">
      {/* --- what arrived ------------------------------------------------ */}
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-ink-muted min-w-0 truncate text-xs">
            <span className="text-ink font-medium">
              {message?.sender?.trim() || channelLabel(message?.channel)}
            </span>
            {message ? ` · ${bnDateTime(message.receivedAt)}` : null}
          </p>
          {pending ? null : <StatusPill status={draft.status} />}
        </div>
        <ConfidenceMeter confidence={draft.confidence} needsReview={draft.needsReview} />
      </header>

      {message ? (
        <RawMessage body={message.body} evidence={draft.evidence} />
      ) : (
        <p className="border-rule text-ink-muted rounded-md border border-dashed p-3 text-sm">
          মূল বার্তাটি আর সংরক্ষিত নেই, তাই কোথা থেকে কী পড়া হয়েছিল দেখানো যাচ্ছে না।
        </p>
      )}

      {draft.confidence === 0 ? (
        <p className="bg-brass/10 text-brass flex items-start gap-2 rounded-md px-3 py-2 text-sm">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            এই বার্তায় টাকার কোনো অঙ্ক পাওয়া যায়নি, তাই খসড়াটি নিজে থেকে কিছুই দাবি করছে না।
            দেখে নিন — দরকার হলে নিজে লিখে যোগ করুন, নইলে বাতিল করে দিন।
          </span>
        </p>
      ) : null}

      {/* --- what would be written --------------------------------------- */}
      <fieldset disabled={!pending || busy} className="flex min-w-0 flex-col gap-4">
        <legend className="sr-only">খাতায় যা লেখা হবে</legend>

        <EvidenceField
          label="তারিখ"
          htmlFor="dr-date"
          origin={originOf(draft.date, 'date', draft.evidence)}
          quoted={draft.evidence.date}
        >
          <Input id="dr-date" type="date" value={form.date} onChange={set('date')} />
        </EvidenceField>

        <EvidenceField
          label="টাকার পরিমাণ (৳)"
          htmlFor="dr-amount"
          origin={originOf(draft.amountMinor, 'amountMinor', draft.evidence)}
          quoted={draft.evidence.amountMinor}
        >
          <Input
            id="dr-amount"
            value={form.amount}
            onChange={set('amount')}
            inputMode="decimal"
            autoComplete="off"
            className="money text-xl"
            placeholder="০.০০"
          />
        </EvidenceField>

        <EvidenceField
          label="কোন দিকে গেল"
          htmlFor="dr-direction"
          group
          origin={originOf(draft.direction, 'direction', draft.evidence)}
          quoted={draft.evidence.direction}
        >
          <div
            id="dr-direction"
            role="radiogroup"
            aria-labelledby="dr-direction-label"
            className="border-rule bg-surface grid grid-cols-2 gap-1 rounded-md border p-1"
          >
            {DIRECTIONS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={form.direction === value}
                onClick={() => {
                  haptic('tap');
                  setForm((f) => ({ ...f, direction: value }));
                }}
                className={cn(
                  'press flex min-h-11 items-center justify-center rounded-md px-3 text-sm md:min-h-9',
                  form.direction === value
                    ? value === 'IN'
                      ? 'bg-income font-medium text-white'
                      : 'bg-expense font-medium text-white'
                    : 'text-ink hover:bg-greenbar',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </EvidenceField>

        <EvidenceField
          label="কার সাথে"
          htmlFor="dr-payee"
          origin={originOf(draft.payee, 'payee', draft.evidence)}
          quoted={draft.evidence.payee}
        >
          <Input
            id="dr-payee"
            value={form.payee}
            onChange={set('payee')}
            maxLength={200}
            placeholder="নাম বা দোকান"
          />
        </EvidenceField>

        {/* No provenance on the two pickers: the parser never proposes either,
            so there is nothing for it to have read or guessed. */}
        <EvidenceField label="অ্যাকাউন্ট" htmlFor="dr-account">
          <Select id="dr-account" value={form.accountId} onChange={set('accountId')}>
            <option value="">অ্যাকাউন্ট বেছে নিন</option>
            {liveAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </Select>
        </EvidenceField>

        <EvidenceField label="খাত" htmlFor="dr-category">
          <Select
            id="dr-category"
            value={form.categoryId}
            onChange={set('categoryId')}
            disabled={!pending || busy || wantedKind === null}
          >
            <option value="">{wantedKind === null ? 'আগে দিক বেছে নিন' : 'খাত বেছে নিন'}</option>
            {liveCategories.map((category) => (
              <option key={category.id} value={category.id}>
                {categoryName(category)}
              </option>
            ))}
          </Select>
        </EvidenceField>

        {stickyApplied && pending ? (
          <p className="text-ink-muted -mt-2 text-xs">
            গতবার বেছে নেওয়া অ্যাকাউন্ট ও খাত আগে থেকে বসানো আছে — না মিললে বদলে নিন।
          </p>
        ) : null}

        <details className="border-rule rounded-md border p-3">
          <summary className="text-ink cursor-pointer text-sm font-medium">
            বিবরণ ও নোট (ইচ্ছা হলে)
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="dr-description" className="text-ink text-sm font-medium">
                বিবরণ
              </label>
              <Input
                id="dr-description"
                value={form.description}
                onChange={set('description')}
                maxLength={500}
                placeholder={draft.payee ?? 'বার্তা থেকে যোগ করা'}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="dr-notes" className="text-ink text-sm font-medium">
                নোট
              </label>
              <Textarea
                id="dr-notes"
                value={form.notes}
                onChange={set('notes')}
                rows={2}
                maxLength={2000}
              />
            </div>
          </div>
        </details>
      </fieldset>

      {/* --- already decided ---------------------------------------------- */}
      {pending ? null : (
        <p className="bg-greenbar text-ink-muted rounded-md px-3 py-2 text-sm">
          {statusLabel(draft.status)}
          {draft.reviewedAt ? ` · ${bnDateTime(draft.reviewedAt)}` : ''}।{' '}
          {draft.transactionId
            ? 'খাতায় এর লেনদেনটি আছে।'
            : 'খাতায় এর জন্য কোনো লেনদেন লেখা হয়নি।'}
        </p>
      )}

      {error ? (
        <p role="alert" className="text-expense text-sm">
          {error}
        </p>
      ) : null}

      {/* --- the decision -------------------------------------------------- */}
      {pending ? (
        <div className="bg-surface border-rule sticky bottom-0 -mx-4 flex flex-col gap-2 border-t px-4 pb-2 pt-3">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="আগের খসড়া"
              disabled={!hasPrev || busy}
              onClick={() => onStep(-1)}
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </Button>
            <Button type="submit" size="block" disabled={busy} className="min-w-0 flex-1">
              <Check className="h-4 w-4 shrink-0" aria-hidden />
              <span className="truncate">{hasNext ? 'যোগ করে পরেরটি' : 'খাতায় যোগ করুন'}</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="পরের খসড়া"
              disabled={!hasNext || busy}
              onClick={() => onStep(1)}
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </Button>
          </div>

          {rejecting ? (
            <div className="border-rule flex flex-col gap-2 rounded-md border border-dashed p-3">
              <p className="text-ink text-sm">
                বাতিল করলে খাতায় <strong>কিছুই লেখা হবে না</strong> — কোনো লেনদেন যোগ হবে না, কোনো
                ব্যালান্সও বদলাবে না। মূল বার্তাটি থেকে যাবে।
              </p>
              <div role="radiogroup" aria-label="বাতিলের কারণ" className="flex flex-col">
                {REJECT_REASONS.map(([value, label]) => (
                  <label
                    key={value}
                    className="text-ink flex min-h-11 cursor-pointer items-center gap-2 text-sm"
                  >
                    <input
                      type="radio"
                      name="dr-reason"
                      className="h-4 w-4"
                      checked={reason === value}
                      onChange={() => setReason(value)}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="danger"
                  className="min-w-0 flex-1"
                  disabled={busy}
                  onClick={() => reject.mutate()}
                >
                  বাতিল করুন
                </Button>
                <Button type="button" variant="ghost" onClick={() => setRejecting(false)}>
                  থাক
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-ink-muted"
                disabled={busy}
                onClick={() => setRejecting(true)}
              >
                <Ban className="h-4 w-4" aria-hidden />
                বাতিল — খাতায় কিছু লেখা হবে না
              </Button>
              {isDesktop ? (
                <span className="text-ink-muted flex items-center gap-1 text-[11px]">
                  <kbd className="border-rule rounded border px-1">⌘</kbd>
                  <kbd className="border-rule rounded border px-1">↵</kbd>
                  যোগ ·
                  <ArrowDown className="h-3 w-3" aria-hidden />
                  <ArrowUp className="h-3 w-3" aria-hidden />
                  পরের / আগের
                </span>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </form>
  );
}

/**
 * One control with the parser's provenance attached to its label.
 *
 * `Field` from the design system takes a label and nothing else; showing the
 * quotation beside it is the point of this whole screen, so the two lines of
 * markup are written out here instead. `origin` is omitted for the fields the
 * parser never proposes — there is no provenance to report for those.
 */
function EvidenceField({
  label,
  htmlFor,
  group = false,
  origin,
  quoted,
  children,
}: {
  label: string;
  htmlFor: string;
  /** The control is a radiogroup, not a labelable element: it points back here instead. */
  group?: boolean;
  origin?: FieldOrigin;
  quoted?: string;
  children: React.ReactNode;
}) {
  const labelClass = 'text-ink text-sm font-medium';
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
        {group ? (
          <span id={`${htmlFor}-label`} className={labelClass}>
            {label}
          </span>
        ) : (
          <label htmlFor={htmlFor} className={labelClass}>
            {label}
          </label>
        )}
        {origin ? <OriginBadge origin={origin} quoted={quoted} className="min-w-0" /> : null}
      </div>
      {children}
    </div>
  );
}
