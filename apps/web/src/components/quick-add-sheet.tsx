'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import * as React from 'react';
import { formatMinor, parseMoneyToMinor, toLocalDateString } from '@hishab/shared';
import { fetchPeople } from '@/app/(shell)/people/queries';
import { TagPicker } from '@/app/(shell)/tags/tag-picker';
import { useCoarsePointer } from '@/hooks/use-device';
import { haptic } from '@/lib/haptics';
import { invalidateAfterWrite } from '@/lib/invalidate';
import { useWorkspaceSettings } from '@/lib/workspace-settings';
import {
  api,
  endpoints,
  FeatureLimitError,
  QueuedOfflineError,
  type TransactionDto,
} from '@/lib/api';
import { CategoryChips, CategoryPicker } from './category-picker';
import { FxField, convert, type FxValue } from './fx-field';
import { QuantityField, type QuantityValue } from './quantity-field';
import { NumericKeypad } from './numeric-keypad';
import { Button } from './ui/button';
import { Field, Input, Select, Textarea } from './ui/field';
import { Sheet } from './ui/sheet';

type Kind = 'EXPENSE' | 'INCOME' | 'TRANSFER';

/**
 * The row being edited.
 *
 * `tags` is optional at runtime whatever `TransactionDto` says — a payload
 * replayed from the offline queue can predate tagging — which is what
 * `tagsKnown` below exists to notice.
 */
type TaggedTxn = TransactionDto;

const TABS: { kind: Kind; label: string }[] = [
  { kind: 'EXPENSE', label: 'খরচ' },
  { kind: 'INCOME', label: 'আয়' },
  { kind: 'TRANSFER', label: 'ট্রান্সফার' },
];

export interface QuickAddSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass an existing transaction to edit it instead of creating a new one. */
  editing?: TaggedTxn | null;
}

export function QuickAddSheet({ open, onOpenChange, editing }: QuickAddSheetProps) {
  const queryClient = useQueryClient();
  const coarse = useCoarsePointer();
  const today = toLocalDateString(new Date());

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });
  const categories = useQuery({ queryKey: ['categories'], queryFn: endpoints.categories });
  const recent = useQuery({
    queryKey: ['transactions', { limit: 5 }],
    queryFn: () => endpoints.transactions({ limit: 5 }),
    enabled: open,
  });

  const [kind, setKind] = React.useState<Kind>('EXPENSE');
  const [amount, setAmount] = React.useState('');
  const [date, setDate] = React.useState(today);
  const [accountId, setAccountId] = React.useState('');
  const [counterAccountId, setCounterAccountId] = React.useState('');
  const [categoryId, setCategoryId] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [tagIds, setTagIds] = React.useState<string[]>([]);
  const [personId, setPersonId] = React.useState('');
  /* Null for the overwhelming majority of entries, which are in the
     workspace's own money and never open the section. */
  const [fx, setFx] = React.useState<FxValue | null>(null);
  const [fxRate, setFxRate] = React.useState('');
  /* Null on almost every entry — a bus fare is not two of anything. */
  const [quantity, setQuantity] = React.useState<QuantityValue | null>(null);
  /**
   * Whether the row being edited actually told us its tags.
   *
   * `tagIds` omitted on a `PATCH` leaves them alone; `[]` clears them. Those are
   * different requests and the difference matters: a row that arrived without a
   * `tags` field — an older cached payload — would otherwise be saved with an
   * empty picker and lose every label it had to an unrelated edit of the amount.
   */
  const [tagsKnown, setTagsKnown] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Load the sheet with the row being edited, or reset it for a new entry.
  React.useEffect(() => {
    if (!open) return;
    if (editing) {
      const editKind: Kind =
        editing.type === 'INCOME' ? 'INCOME' : editing.type === 'TRANSFER' ? 'TRANSFER' : 'EXPENSE';
      setKind(editKind);
      setAmount(formatMinor(Math.abs(editing.amountMinor), { symbol: false }));
      setDate(editing.date);
      /**
       * Put a transfer's two sides back the way they were written.
       *
       * `TransactionsService.present()` puts the *focused* account first when
       * the list was filtered by one, so that the sign it prints is the sign
       * that account saw. A transfer found under its destination account
       * therefore arrives inside out: `accountId` is the money's destination,
       * `counterAccountId` its source. Loading that straight into "যে অ্যাকাউন্ট
       * থেকে" would show the transfer backwards, and saving it — even saving it
       * untouched, which is what attaching a receipt or fixing a typo does —
       * would write it back reversed. The books would still balance, both
       * accounts would still be named, and the money would have gone the other
       * way with nothing on any screen saying so.
       *
       * The sign is the recovery, and it is exact rather than a guess: for a
       * transfer `present()` returns `+magnitude` only through
       * `computeTransferSign`, only for a focused account on the DEBIT side —
       * the destination — which is the one and only case in which it swapped
       * the pair. Unfocused, and focused on the source, it returns
       * `-magnitude` and leaves the order alone. The receipt sheet in
       * `(shell)/transactions/page.tsx` undoes the same swap the same way.
       */
      const flipped = editing.type === 'TRANSFER' && editing.amountMinor > 0;
      setAccountId((flipped ? editing.counterAccountId : editing.accountId) ?? '');
      setCounterAccountId((flipped ? editing.accountId : editing.counterAccountId) ?? '');
      setCategoryId(editing.categoryId ?? '');
      setDescription(editing.description ?? '');
      setNotes(editing.notes ?? '');
      setTagIds((editing.tags ?? []).map((tag) => tag.id));
      setTagsKnown(editing.tags !== undefined);
      setPersonId(editing.personId ?? '');
      setFx(
        editing.fxCurrency && editing.fxAmountMinor
          ? { currency: editing.fxCurrency, amountMinor: editing.fxAmountMinor }
          : null,
      );
      /* Derived from the two stored figures rather than stored itself — see
         the migration. `amountMinor` is signed for display, so its magnitude
         is what the rate was applied to. */
      setFxRate(
        editing.fxCurrency && editing.fxAmountMinor
          ? String(Math.abs(editing.amountMinor) / editing.fxAmountMinor)
          : '',
      );
      setQuantity(
        editing.quantityMilli && editing.quantityUnit
          ? { milli: editing.quantityMilli, unit: editing.quantityUnit }
          : null,
      );
    } else {
      setKind('EXPENSE');
      setAmount('');
      setDate(today);
      setCounterAccountId('');
      setCategoryId('');
      setDescription('');
      setNotes('');
      setTagIds([]);
      setTagsKnown(true);
      setPersonId('');
      setFx(null);
      setFxRate('');
      setQuantity(null);
    }
    setError(null);
  }, [open, editing, today]);

  const accountList = accounts.data ?? [];
  React.useEffect(() => {
    if (!accountId && accountList.length > 0) setAccountId(accountList[0]!.id);
  }, [accountId, accountList]);

  /* The accounts query may resolve after the sheet is already open. Without a
   * fallback the <select> would sit on an unmatched empty value, which a
   * required control refuses to submit — silently, with no visible error. */
  const effectiveAccountId = accountId || (accountList[0]?.id ?? '');

  /* One stable array: both category controls memoise their grouping off it. */
  const categoryList = React.useMemo(() => categories.data ?? [], [categories.data]);
  /* A transfer carries no category, but the tab still has to name one of the two
   * kinds the picker knows about. */
  const categoryKind = kind === 'INCOME' ? 'INCOME' : 'EXPENSE';

  /* Categories the user actually reaches for, most recent first. The full tree
   * stays in the picker below; these chips are the accelerator. */
  const recentCategoryIds = React.useMemo(() => {
    const seen: string[] = [];
    for (const txn of recent.data?.items ?? []) {
      if (txn.categoryId && !seen.includes(txn.categoryId)) seen.push(txn.categoryId);
    }
    return seen.slice(0, 6);
  }, [recent.data]);

  const repeatable = ((recent.data?.items ?? []) as TaggedTxn[])
    .filter((t) => t.type === 'EXPENSE' || t.type === 'INCOME')
    .slice(0, 3);

  const applyRepeat = (txn: TaggedTxn): void => {
    haptic('select');
    setKind(txn.type === 'INCOME' ? 'INCOME' : 'EXPENSE');
    setAmount(formatMinor(Math.abs(txn.amountMinor), { symbol: false }));
    if (txn.accountId) setAccountId(txn.accountId);
    if (txn.categoryId) setCategoryId(txn.categoryId);
    setDescription(txn.description ?? '');
    /* Last month's rent was for শ্বশুরবাড়ি and so is this one. Repeating a row
       and then re-picking its tags by hand is the repeat not having worked. */
    setTagIds((txn.tags ?? []).map((tag) => tag.id));
    setDate(today);
  };

  /* The books' currency decides how many minor units a typed amount is worth — 100 for taka, 1 for yen, 1000 for a dinar. */
  const { currency } = useWorkspaceSettings();
  const save = useMutation({
    mutationFn: async () => {
      /* When the money was in another currency, the amount written to the
         books is the conversion at the rate the user confirmed — not the
         figure in the amount box, which is left showing what they typed. */
      const converted = fx ? convert(fx.amountMinor, fx.currency, fxRate, currency) : null;
      if (fx && (converted === null || converted <= 0)) {
        throw new Error('রেট বা মূল অঙ্ক ঠিক নেই');
      }
      const amountMinor = converted ?? parseMoneyToMinor(amount, currency);
      if (amountMinor <= 0) throw new Error('পরিমাণ শূন্যের চেয়ে বেশি হতে হবে');
      /* The <select> is `required`, so the browser normally refuses first. Said
         again here in words, because native validation is a bubble that a
         scrolled sheet can push off screen, and because an offline save is
         queued rather than answered — a row parked without its খাত would come
         back days later as an uncategorised entry nobody remembers. উপ-খাত is
         optional; the id below is whichever of the two was chosen last. */
      if (kind !== 'TRANSFER' && !categoryId) throw new Error('ক্যাটাগরি বেছে নিন');

      const body = {
        date,
        type: kind,
        amountMinor,
        accountId: effectiveAccountId,
        counterAccountId: kind === 'TRANSFER' ? counterAccountId : undefined,
        categoryId: kind === 'TRANSFER' ? undefined : categoryId || undefined,
        description: description || undefined,
        notes: notes || undefined,
        source: 'MANUAL' as const,
        /* Sent whenever the picker holds the truth, empty list included — that
           is how somebody takes the last tag off a row. Left out entirely when
           the row arrived without its tags, so the server keeps what it has. */
        tagIds: tagsKnown ? tagIds : undefined,
        /* `null`, not `undefined`, when the picker is empty: omitting the field
           leaves the row's person alone, which would make "কেউ না" impossible
           to save. Sent on a create too, where the two mean the same thing. */
        personId: personId || null,
        /* Both or neither — the server refuses a half-pair, and an edit that
           cleared the section has to say so rather than leave the old one. */
        fxCurrency: fx ? fx.currency : null,
        fxAmountMinor: fx ? fx.amountMinor : null,
        /* Both or neither — the server refuses a half-pair, and an edit that
           cleared the section has to say so rather than leave the old one. */
        quantityMilli: quantity && quantity.milli > 0 ? quantity.milli : null,
        quantityUnit: quantity && quantity.milli > 0 ? quantity.unit.trim() || null : null,
      };

      return api<TransactionDto>(editing ? `/transactions/${editing.id}` : '/transactions', {
        method: editing ? 'PATCH' : 'POST',
        body,
        queueWhenOffline: true,
      });
    },
    onSuccess: () => {
      haptic('success');
      /* Close first, refresh after.
       *
       * This used to `await queryClient.invalidateQueries()` — with no filter,
       * which marks *every* query in the cache stale and waits for all of them
       * to refetch before the sheet closes. On a connection with a second of
       * round-trip time that is the write, then a fan-out of reads, then the
       * sheet finally moving: two seconds of a form sitting there after the
       * user has finished with it.
       *
       * The write has already succeeded by the time this runs. Nothing about
       * the refresh needs to block the person who made it. */
      onOpenChange(false);
      invalidateAfterWrite(queryClient);
    },
    onError: async (err) => {
      if (err instanceof QueuedOfflineError) {
        // Parked offline is a success from the user's point of view.
        onOpenChange(false);
        invalidateAfterWrite(queryClient);
        return;
      }
      haptic('warn');
      // A 402 already carries a sentence worth showing; anything else falls back.
      if (err instanceof FeatureLimitError) {
        setError(err.message);
        return;
      }
      setError(err instanceof Error ? err.message : 'সংরক্ষণ করা যায়নি');
    },
  });

  const previewMinor = (() => {
    try {
      return amount ? parseMoneyToMinor(amount, currency) : 0;
    } catch {
      return 0;
    }
  })();

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? 'লেনদেন সম্পাদনা' : 'নতুন লেনদেন'}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <div
          role="tablist"
          aria-label="ধরন"
          className="bg-greenbar grid grid-cols-3 gap-1 rounded-lg p-1"
        >
          {TABS.map((tab) => (
            <button
              key={tab.kind}
              type="button"
              role="tab"
              aria-selected={kind === tab.kind}
              onClick={() => {
                haptic('tap');
                setKind(tab.kind);
                /* খরচের খাত must not survive a switch to আয়. The picker below
                   only offers one kind, so a category left over from the other
                   one shows as an unmatched value in the box — and the API
                   checks only that the category exists, so saving it would file
                   an income under an expense খাত and quietly bend the report.
                   TRANSFER counts as EXPENSE here so that খরচ → ট্রান্সফার →
                   খরচ, which shows no category in the middle, keeps it. */
                if ((tab.kind === 'INCOME') !== (kind === 'INCOME')) setCategoryId('');
              }}
              className={
                kind === tab.kind
                  ? 'press bg-surface text-ink min-h-10 rounded-md text-sm font-semibold shadow-sm'
                  : 'press text-ink-muted min-h-10 rounded-md text-sm'
              }
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* One-tap repeat of something recent (spec §6.4). */}
        {!editing && repeatable.length > 0 ? (
          <div className="chip-strip" aria-label="আবার যোগ করুন">
            {repeatable.map((txn) => (
              <button
                key={txn.id}
                type="button"
                onClick={() => applyRepeat(txn)}
                className="press border-rule text-ink flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs"
              >
                <RotateCcw className="h-3 w-3 shrink-0" aria-hidden />
                <span className="max-w-28 truncate">
                  {txn.description || txn.categoryName || 'লেনদেন'}
                </span>
                <span className="money text-ink-muted">
                  {formatMinor(Math.abs(txn.amountMinor), { decimals: false })}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        <Field label="পরিমাণ (৳)" htmlFor="qa-amount">
          <Input
            id="qa-amount"
            name="amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            autoFocus={!coarse}
            /* On a phone the keypad below replaces the OS keyboard, so the sheet
               never gets shoved off-screen halfway through typing. */
            inputMode={coarse ? 'none' : 'decimal'}
            enterKeyHint="done"
            placeholder="০.০০"
            className="money h-14 !text-3xl font-semibold"
          />
        </Field>

        {coarse ? <NumericKeypad value={amount} onChange={setAmount} /> : null}

        {/* A chip writes the one id the two boxes below are derived from, so a
            sub-category chip fills the parent in as well — the fast path and the
            slow path cannot disagree. */}
        {kind !== 'TRANSFER' ? (
          <CategoryChips
            categories={categoryList}
            kind={categoryKind}
            recentIds={recentCategoryIds}
            value={categoryId}
            onChange={setCategoryId}
          />
        ) : null}

        <Field label="তারিখ" htmlFor="qa-date">
          <Input
            id="qa-date"
            name="date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </Field>

        <Field
          label={kind === 'TRANSFER' ? 'যে অ্যাকাউন্ট থেকে' : 'অ্যাকাউন্ট'}
          htmlFor="qa-account"
        >
          <Select
            id="qa-account"
            name="accountId"
            value={effectiveAccountId}
            onChange={(e) => setAccountId(e.target.value)}
            required
          >
            {accountList.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>

        {kind === 'TRANSFER' ? (
          <Field label="যে অ্যাকাউন্টে" htmlFor="qa-counter">
            <Select
              id="qa-counter"
              name="counterAccountId"
              value={counterAccountId}
              onChange={(e) => setCounterAccountId(e.target.value)}
              required
            >
              <option value="">বেছে নিন</option>
              {accountList
                .filter((a) => a.id !== effectiveAccountId)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </Select>
          </Field>
        ) : (
          <CategoryPicker
            categories={categoryList}
            kind={categoryKind}
            value={categoryId}
            onChange={setCategoryId}
            idPrefix="qa"
            unknownName={editing?.categoryName ?? null}
          />
        )}

        {/* Directly under the category, because that is where the difference
            has to be learned: one box asks what the money went on, the next
            asks who it was for. A transfer has no category and can still be
            tagged — গাড়ি is a tag whether the money was spent or moved. */}
        <TagPicker value={tagIds} onChange={setTagIds} idPrefix="qa" />

        <PersonField value={personId} onChange={setPersonId} />

        <QuantityField value={quantity} onChange={setQuantity} />

        <FxField value={fx} onChange={setFx} rate={fxRate} onRateChange={setFxRate} />

        <Field label="বিবরণ" htmlFor="qa-description">
          <Input
            id="qa-description"
            name="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="যেমন: সাপ্তাহিক বাজার"
          />
        </Field>

        <Field label="নোট" htmlFor="qa-notes">
          <Textarea
            id="qa-notes"
            name="notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>

        {error ? (
          <p role="alert" className="bg-expense/10 text-expense rounded-md px-3 py-2 text-sm">
            {error}
          </p>
        ) : null}

        <Button type="submit" size="block" disabled={save.isPending} className="press">
          {save.isPending
            ? 'সংরক্ষণ হচ্ছে…'
            : previewMinor > 0
              ? `${formatMinor(previewMinor)} সংরক্ষণ করুন`
              : 'সংরক্ষণ করুন'}
        </Button>
      </form>
    </Sheet>
  );
}

/**
 * Who the money was with.
 *
 * A `<select>` of people who already exist, and nothing more. Typing a new name
 * here would create a contact as a side effect of an expense — exactly how the
 * duplicate করিমs that `/people` exists to merge came about in the first place.
 * Adding somebody is a deliberate act on that screen, or a consequence of
 * recording a loan.
 *
 * Optional, always. Most entries have no counterparty worth naming, and a field
 * that nags for one teaches people to put something meaningless in it.
 */
function PersonField({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const people = useQuery({
    queryKey: ['people', 'list', ''],
    queryFn: () => fetchPeople(),
    staleTime: 60_000,
  });

  const rows = people.data ?? [];
  /* Hidden until there is somebody to pick, rather than shown empty. An
     enabled dropdown with one "কেউ না" in it is a dead end that asks the reader
     to work out why. */
  if (rows.length === 0 && !value) return null;

  return (
    <Field label="কার সাথে" htmlFor="qa-person">
      <Select
        id="qa-person"
        name="personId"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">কেউ না</option>
        {rows.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
            {person.relation ? ` — ${person.relation}` : ''}
          </option>
        ))}
      </Select>
      <p className="text-ink-muted mt-1 text-xs">ঐচ্ছিক। নতুন কাউকে যোগ করতে মানুষজন পাতায় যান।</p>
    </Field>
  );
}
