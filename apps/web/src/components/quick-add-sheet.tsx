'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from '@/components/icons';
import * as React from 'react';
import { formatMinor, parseMoneyToMinor, toLocalDateString } from '@hishab/shared';
import { fetchPeople } from '@/app/(shell)/people/queries';
import { TagPicker } from '@/app/(shell)/tags/tag-picker';
import { useCoarsePointer } from '@/hooks/use-device';
import { haptic } from '@/lib/haptics';
import { fmtDate, fmtNumber } from '@/lib/format';
import { t } from '@/lib/t';
import { invalidateAfterWrite } from '@/lib/invalidate';
import { cn } from '@/lib/utils';
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

/**
 * The five things this sheet can write.
 *
 * The first three go to `POST /transactions`; the last two go to `POST /loans`,
 * which books the disbursement itself. They share a sheet because they are the
 * same act — money moved today and it has to be written down — and because the
 * khata is where people are when they remember it. Sending somebody to
 * `/loans`, finding the নতুন button and filling in a nine-field form is how ধার
 * ends up not being recorded at all.
 *
 * `LENT` and `BORROWED` are two tabs rather than one tab with a direction
 * select, because that is already the grammar of this row: খরচ and আয় are one
 * transaction type each and the tab is what says which way the money went.
 * A single ধার tab would be the only one that needed a second question answered
 * before it knew.
 */
type Kind = 'EXPENSE' | 'INCOME' | 'TRANSFER' | 'LENT' | 'BORROWED' | 'REPAY';

/** Sentinel for the counterparty select: a name typed here, not an existing row. */
const NEW_PERSON = '__new__';

/* A predicate rather than a boolean, so that the early return in `save` narrows
   `kind` for the transaction body underneath it: `type: kind` there must be a
   TransactionType, and the compiler is what should be saying so. */
const isLoan = (kind: Kind): kind is 'LENT' | 'BORROWED' => kind === 'LENT' || kind === 'BORROWED';

/**
 * ধার ফেরত — an instalment against a loan that already exists.
 *
 * Its own tab rather than a sixth field on ধার দিয়েছি, because the two are
 * opposite movements and merging them is how somebody records a ৳2,000
 * repayment as a second ৳2,000 loan — leaving ৳7,000 outstanding where ৳3,000
 * is. It is also, after the first month, the more common of the two: a loan is
 * made once and paid back in pieces.
 *
 * Unlike the other five it cannot invent its subject. A repayment has to name
 * *which* loan, because one person can owe on three at once and an amount says
 * nothing about which it settles — so the person picker here offers only people
 * who actually have a live loan, and the loan picker only their open ones.
 */
const isRepay = (kind: Kind): kind is 'REPAY' => kind === 'REPAY';

/**
 * The row being edited.
 *
 * `tags` is optional at runtime whatever `TransactionDto` says — a payload
 * replayed from the offline queue can predate tagging — which is what
 * `tagsKnown` below exists to notice.
 */
type TaggedTxn = TransactionDto;

/* Keys beside the Bengali, resolved at render rather than here: a module-level
   constant is evaluated before a workspace's wording override has arrived.

   The spans are what keeps five tabs legible at 320px: six columns, the three
   transaction kinds at two each on the first row and the two ধার kinds at three
   each on the second. Five across a 288px sheet would give each label 57px,
   and ট্রান্সফার does not fit in 57px in any weight. */
const TABS: { kind: Kind; key: string; label: string; span: string }[] = [
  { kind: 'EXPENSE', key: 'entry.tab.expense', label: 'খরচ', span: 'col-span-2' },
  { kind: 'INCOME', key: 'entry.tab.income', label: 'আয়', span: 'col-span-2' },
  { kind: 'TRANSFER', key: 'entry.tab.transfer', label: 'ট্রান্সফার', span: 'col-span-2' },
  { kind: 'LENT', key: 'entry.tab.lent', label: 'ধার দিয়েছি', span: 'col-span-2' },
  { kind: 'BORROWED', key: 'entry.tab.borrowed', label: 'ধার নিয়েছি', span: 'col-span-2' },
  { kind: 'REPAY', key: 'entry.tab.repay', label: 'ধার ফেরত', span: 'col-span-2' },
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
  /* One field for two questions, because they are the same question: "কার সাথে"
     on an expense and the counterparty of a ধার are both a row in `Person`. On
     the ধার tabs it may also hold NEW_PERSON, which is the only value the
     transaction body must never see — cleared on the way out of those tabs. */
  const [personId, setPersonId] = React.useState('');
  const [personName, setPersonName] = React.useState('');
  /** Which existing loan a ধার ফেরত settles. Empty on every other tab. */
  const [loanId, setLoanId] = React.useState('');
  /* Which investment this row belongs to — a Sanchayapatra, a DPS, an FDR.
     Optional, and the reason it lives here rather than on the savings screen:
     profit arrives as an ordinary income row in the khata, and the only thing
     that has to be added is *which certificate paid it*. Asking somebody to go
     to another screen to record money that landed in their bank account is
     asking them to remember a place, not a fact. */
  const [savingsPlanId, setSavingsPlanId] = React.useState('');
  /* Which policy's premium this expense pays, and which instalment of it.
     Null on almost every entry. Creates only: re-ticking an instalment because
     somebody fixed a typo on a row would settle a second premium nobody
     paid. */
  const [premium, setPremium] = React.useState<PremiumPick | null>(null);
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
      setPersonName('');
      setSavingsPlanId(editing.savingsPlanId ?? '');
      /* Not offered on an edit and so never restored: the instalment was
         settled when the row was created, and a second tick would mark a
         premium paid that nobody paid. */
      setPremium(null);
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
      setPersonName('');
      setPremium(null);
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
  const { currency, currencyInfo } = useWorkspaceSettings();
  const save = useMutation({
    mutationFn: async () => {
      /* When the money was in another currency, the amount written to the
         books is the conversion at the rate the user confirmed — not the
         figure in the amount box, which is left showing what they typed. */
      const converted = fx ? convert(fx.amountMinor, fx.currency, fxRate, currency) : null;
      if (fx && (converted === null || converted <= 0)) {
        throw new Error(t('entry.badRate', 'রেট বা মূল অঙ্ক ঠিক নেই'));
      }
      const amountMinor = converted ?? parseMoneyToMinor(amount, currency);
      if (amountMinor <= 0)
        throw new Error(t('entry.amountPositive', 'পরিমাণ শূন্যের চেয়ে বেশি হতে হবে'));

      /**
       * ধার goes to `POST /loans`, not to `POST /transactions`.
       *
       * A loan is a relationship, not a row: the loans module opens a control
       * account for the direction, files the person, books the disbursement
       * against the cash account and leaves something that repayments can be
       * added to and a party ledger can be drawn from. Posting an EXPENSE here
       * instead would put the right number in the right account and lose every
       * one of those, and the money would never come back off the books when it
       * was repaid.
       *
       * ## What this tab asks for, and what it does not
       *
       * Five fields: how much, from or into which account, with whom, when, and
       * a note. That is a loan recorded honestly — the API needs nothing else,
       * and every one of them is a thing the person is holding in their head at
       * the moment they reach for the + button.
       *
       * Deliberately left to `/loans`: the interest (a fixed sum or an annual
       * rate, plus the choice between them — three controls that would double
       * the height of this sheet and are wrong for the overwhelming majority of
       * ধার between family and neighbours, which carries none), the due date,
       * the counterparty's phone number, and receipts. None of them can be
       * missed later: the loan exists the moment this saves, and `/loans` can
       * edit its terms, its dates and its note afterwards. The quick sheet's
       * job is that the ধার gets written down at all — the common case here is
       * still somebody recording an expense, and every control added for the
       * rare case is paid for by all of them.
       */
      /* A repayment is not a new loan and not a transaction: it is an
         instalment on something that already exists, and the loans module books
         the transfer, moves the outstanding balance and closes the loan when it
         reaches zero. Posting a TRANSFER here instead would move the money and
         leave the debt untouched. */
      if (isRepay(kind)) {
        if (!loanId) throw new Error(t('entry.pickLoan', 'কোন ধারের ফেরত — বেছে নিন'));
        return api(`/loans/${loanId}/payments`, {
          method: 'POST',
          body: {
            date,
            amountMinor,
            accountId: effectiveAccountId,
            note: notes.trim() || undefined,
          },
        });
      }

      if (isLoan(kind)) {
        const named = personId === NEW_PERSON;
        if (!named && !personId) {
          throw new Error(t('entry.pickPerson', 'কার সাথে ধার — বেছে নিন বা নাম লিখুন'));
        }
        if (named && !personName.trim()) {
          throw new Error(t('entry.pickPerson', 'কার সাথে ধার — বেছে নিন বা নাম লিখুন'));
        }
        return api('/loans', {
          method: 'POST',
          body: {
            ...(named ? { personName: personName.trim() } : { personId }),
            direction: kind,
            principalMinor: amountMinor,
            interestType: 'NONE',
            loanDate: date,
            accountId: effectiveAccountId,
            /* One note field, and it is the নোট box rather than বিবরণ — which is
               why বিবরণ is not drawn on these two tabs. A loan is already
               headed by a name and a direction; a second free-text line with
               nowhere on the loan to put it would be a field that eats what
               somebody typed. */
            note: notes.trim() || undefined,
          },
        });
      }

      /* The <select> is `required`, so the browser normally refuses first. Said
         again here in words, because native validation is a bubble that a
         scrolled sheet can push off screen, and because an offline save is
         queued rather than answered — a row parked without its খাত would come
         back days later as an uncategorised entry nobody remembers. উপ-খাত is
         optional; the id below is whichever of the two was chosen last. */
      if (kind !== 'TRANSFER' && !categoryId)
        throw new Error(t('entry.pickCategory', 'ক্যাটাগরি বেছে নিন'));

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
           to save. Sent on a create too, where the two mean the same thing.
           NEW_PERSON is refused rather than sent: the tab switch clears it, and
           a sentinel that reached the server would be a 400 on an id nobody
           chose. */
        personId: personId && personId !== NEW_PERSON ? personId : null,
        /* Same three-way rule as `personId`: `null` unfiles it, which is how
           somebody takes a row back off an investment they tagged by mistake. */
        savingsPlanId: savingsPlanId || null,
        /* Both or neither — the server refuses a half-pair, and an edit that
           cleared the section has to say so rather than leave the old one. */
        fxCurrency: fx ? fx.currency : null,
        fxAmountMinor: fx ? fx.amountMinor : null,
        /* Both or neither — the server refuses a half-pair, and an edit that
           cleared the section has to say so rather than leave the old one. */
        quantityMilli: quantity && quantity.milli > 0 ? quantity.milli : null,
        quantityUnit: quantity && quantity.milli > 0 ? quantity.unit.trim() || null : null,
      };

      const saved = await api<TransactionDto>(
        editing ? `/transactions/${editing.id}` : '/transactions',
        {
          method: editing ? 'PATCH' : 'POST',
          body,
          /* Parked offline for every ordinary entry — and never when a premium
             is riding on it. A queued write comes back with no id, so the tick
             below could not name the transaction that paid it; the instalment
             would stay owed with nothing on any screen saying why. Better to
             refuse the save while the person is still looking at it. */
          queueWhenOffline: premium === null,
        },
      );

      /* The instalment, settled against the entry that paid it.
       *
       * A second request rather than a field on the first, because a policy
       * holds no money: the ledger row and the premium schedule are two
       * records of one event and `/insurance/:id/premiums/:id/pay` is the door
       * built for the second. The inbox does the same thing server-side, where
       * it has a draft to hang it on. */
      if (premium && saved?.id) {
        await api(`/insurance/${premium.policyId}/premiums/${premium.premiumId}/pay`, {
          method: 'POST',
          body: { transactionId: saved.id, paidDate: date, amountMinor },
        });
      }

      return saved;
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
      /* Only when one was settled. An ordinary expense cannot change a policy,
         and refetching বীমা behind every entry is a request that can only
         return the same answer. */
      if (premium) void queryClient.invalidateQueries({ queryKey: ['insurance'] });
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
      setError(err instanceof Error ? err.message : t('common.saveFailed', 'সংরক্ষণ করা যায়নি'));
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
      title={
        editing ? t('entry.edit', 'লেনদেন সম্পাদনা') : t('shell.newTransaction', 'নতুন লেনদেন')
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        {/* Frozen to the top of the sheet.
         *
         * Which way the money went is the frame every field below is read in,
         * and this form is long — an expense with a category, a date, a note,
         * tags and a receipt runs well past one screen on a phone. Once the
         * strip scrolls away the only way back to আয় is to scroll the whole
         * form up again, and somebody who started on the wrong tab has to do
         * that before they can do anything at all.
         *
         * `-mx-4 px-4` bleeds it to the sheet's own edges so rows pass behind
         * it rather than beside it, and `bg-surface` is the sheet's ground
         * rather than a new colour. */}
        <div className="bg-surface sticky top-0 z-20 -mx-4 -mt-1 px-4 pb-1 pt-1">
          <div
            role="tablist"
            aria-label={t('entry.kind', 'ধরন')}
            className="bg-greenbar grid grid-cols-6 gap-1 rounded-lg p-1"
          >
            {/* Editing offers the three transaction kinds only. `PATCH
              /transactions` cannot turn a row into a loan — a loan is a control
              account, a person and a repayment schedule, none of which this
              body can create — so a ধার tab here would be a tab that could
              only fail. */}
            {(editing ? TABS.filter((tab) => !isLoan(tab.kind) && !isRepay(tab.kind)) : TABS).map(
              (tab) => (
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
                    /* "নতুন ব্যক্তি" is a choice only the ধার tabs offer. Left
                   behind on the way out it would sit in কার সাথে as a value
                   that select has no option for — a box that looks empty and
                   is not. */
                    if (!isLoan(tab.kind) && personId === NEW_PERSON) setPersonId('');
                    /* A loan chosen on ধার ফেরত means nothing anywhere else, and
                     left behind it would be sent with the next save. */
                    if (!isRepay(tab.kind)) setLoanId('');
                  }}
                  /* min-h-11, up from min-h-10. Two rows of tabs is two rows of
                 things to hit with a thumb, and 40px was already under the
                 44px floor when there was one. */
                  /* The selected tab is drawn in the brand colour, not in
                   `bg-surface`.
                   
                   On the dark palettes `--hishab-surface` and
                   `--hishab-greenbar` are two shades of the same near-black —
                   #16201c on #1a241f — so a tab lifted by `bg-surface` and a
                   `shadow-sm` was invisible: five tabs, none of them visibly
                   chosen. `brand` and `brand-contrast` are defined as a legible
                   pair in every one of the eight faces, which is what this
                   needs. The weight and `aria-selected` carry it for anybody
                   who cannot see the hue. */
                  className={cn(
                    tab.span,
                    kind === tab.kind
                      ? 'press bg-brand text-brand-contrast min-h-11 truncate rounded-md px-1 text-sm font-semibold shadow-sm'
                      : 'press text-ink-muted min-h-11 truncate rounded-md px-1 text-sm',
                  )}
                >
                  {t(tab.key, tab.label)}
                </button>
              ),
            )}
          </div>
        </div>

        {/* One-tap repeat of something recent (spec §6.4). Transaction kinds
            only: every chip sets the tab back to খরচ or আয়, so on a ধার tab the
            strip is a row of buttons that quietly undo the tab just chosen. */}
        {!editing && !isLoan(kind) && repeatable.length > 0 ? (
          <div className="chip-strip" aria-label={t('entry.repeat', 'আবার যোগ করুন')}>
            {repeatable.map((txn) => (
              <button
                key={txn.id}
                type="button"
                onClick={() => applyRepeat(txn)}
                className="press border-rule text-ink flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs"
              >
                <RotateCcw className="h-3 w-3 shrink-0" aria-hidden />
                <span className="max-w-28 truncate">
                  {txn.description || txn.categoryName || t('entry.transaction', 'লেনদেন')}
                </span>
                <span className="money text-ink-muted">
                  {formatMinor(Math.abs(txn.amountMinor), { decimals: false })}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        <Field
          label={`${t('entry.amount', 'পরিমাণ')} (${currencyInfo.symbol})`}
          htmlFor="qa-amount"
        >
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
            placeholder={fmtNumber('0.00')}
            className="money h-14 !text-3xl font-semibold"
          />
        </Field>

        {coarse ? <NumericKeypad value={amount} onChange={setAmount} /> : null}

        {/* A chip writes the one id the two boxes below are derived from, so a
            sub-category chip fills the parent in as well — the fast path and the
            slow path cannot disagree.

            Neither a transfer nor a ধার carries a খাত: one moves money between
            two of your own accounts and the other is a debt, and filing either
            under খাবার ও বাজার would put money in this month's expense report
            that was never spent. */}
        {kind !== 'TRANSFER' && !isLoan(kind) && !isRepay(kind) ? (
          <CategoryChips
            categories={categoryList}
            kind={categoryKind}
            recentIds={recentCategoryIds}
            value={categoryId}
            onChange={setCategoryId}
          />
        ) : null}

        <Field label={t('entry.date', 'তারিখ')} htmlFor="qa-date">
          <Input
            id="qa-date"
            name="date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </Field>

        {/* The account is the one field every kind needs and the one whose
            question changes most: money leaves it on a খরচ or a ধার দিয়েছি,
            arrives in it on an আয় or a ধার নিয়েছি. Saying which in the label is
            cheaper than a hint underneath, and on the ধার tabs it is the only
            thing telling the reader that the money really moves — a loan
            recorded here is not a note to self. */}
        <Field
          label={
            kind === 'TRANSFER'
              ? t('entry.fromAccount', 'যে অ্যাকাউন্ট থেকে')
              : kind === 'LENT'
                ? t('entry.loanFromAccount', 'কোন অ্যাকাউন্ট থেকে দিলেন')
                : kind === 'BORROWED'
                  ? t('entry.loanToAccount', 'কোন অ্যাকাউন্টে এল')
                  : kind === 'REPAY'
                    ? t('entry.repayAccount', 'কোন অ্যাকাউন্টে বা কোন অ্যাকাউন্ট থেকে')
                    : t('entry.account', 'অ্যাকাউন্ট')
          }
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
          <Field label={t('entry.toAccount', 'যে অ্যাকাউন্টে')} htmlFor="qa-counter">
            <Select
              id="qa-counter"
              name="counterAccountId"
              value={counterAccountId}
              onChange={(e) => setCounterAccountId(e.target.value)}
              required
            >
              <option value="">{t('common.choose', 'বেছে নিন')}</option>
              {accountList
                .filter((a) => a.id !== effectiveAccountId)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </Select>
          </Field>
        ) : isRepay(kind) ? (
          <LoanToRepayField value={loanId} onChange={setLoanId} onAccountHint={setAccountId} />
        ) : isLoan(kind) ? (
          <LoanPersonField
            direction={kind}
            personId={personId}
            personName={personName}
            onPersonId={setPersonId}
            onPersonName={setPersonName}
          />
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

        {/* Everything from here down belongs to a transaction and to nothing
            else. `POST /loans` takes a person, an amount, an account, a date
            and a note — no tags, no quantity, no foreign currency, no second
            free-text line — and a control that silently discards what somebody
            typed into it is worse than a control that is not there. */}
        {isRepay(kind) ? (
          <p className="text-ink-muted text-xs">
            {t(
              'entry.repayHint',
              'ধারের বাকি টাকা কমে যাবে আর খাতায় লেনদেনটি নিজে থেকে বসে যাবে। পুরোটা শোধ হয়ে গেলে ধারটি নিজেই বন্ধ হয়ে যাবে। সুদ থাকলে আগে সুদ, তারপর আসল — হিসাবটা ধার-দেনা পাতায় দেখা যায়।',
            )}
          </p>
        ) : isLoan(kind) ? (
          <p className="text-ink-muted text-xs">
            {t(
              'entry.loanHint',
              'টাকাটা এই অ্যাকাউন্ট থেকেই যাবে বা আসবে — খাতায় লেনদেনটি নিজে থেকে বসে যাবে। সুদ, ফেরতের তারিখ বা কিস্তি যোগ করতে ধার-দেনা পাতায় যান।',
            )}
          </p>
        ) : (
          <>
            {/* Directly under the category, because that is where the difference
                has to be learned: one box asks what the money went on, the next
                asks who it was for. A transfer has no category and can still be
                tagged — গাড়ি is a tag whether the money was spent or moved. */}
            <TagPicker value={tagIds} onChange={setTagIds} idPrefix="qa" />

            <PersonField value={personId} onChange={setPersonId} />
            <InvestmentField kind={kind} value={savingsPlanId} onChange={setSavingsPlanId} />
            {editing ? null : <PremiumField kind={kind} value={premium} onChange={setPremium} />}

            <QuantityField value={quantity} onChange={setQuantity} />

            <FxField value={fx} onChange={setFx} rate={fxRate} onRateChange={setFxRate} />

            <Field label={t('entry.description', 'বিবরণ')} htmlFor="qa-description">
              <Input
                id="qa-description"
                name="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('entry.descriptionHint', 'যেমন: সাপ্তাহিক বাজার')}
              />
            </Field>
          </>
        )}

        <Field label={t('entry.notes', 'নোট')} htmlFor="qa-notes">
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
            ? t('common.saving', 'সংরক্ষণ হচ্ছে…')
            : previewMinor > 0
              ? `${formatMinor(previewMinor)} ${t('common.save', 'সংরক্ষণ করুন')}`
              : t('common.save', 'সংরক্ষণ করুন')}
        </Button>
      </form>
    </Sheet>
  );
}

/**
 * Who the ধার is with.
 *
 * ## The list is everybody
 *
 * `GET /people`, through the same `fetchPeople` and the same
 * `['people', 'list', '']` key the কার সাথে box below already uses — so opening
 * this tab costs no request the sheet had not made anyway, and the two boxes
 * can never disagree about who exists. A second way to ask the same question is
 * exactly how the loans screen came to offer only people who already had a
 * loan: the 28 brought over from Wallet were in the database and appeared in no
 * menu.
 *
 * ## And a name may be typed
 *
 * Which `PersonField` below deliberately refuses to allow, and the difference is
 * not an inconsistency. Creating a contact as a side effect of an expense is how
 * the duplicate করিমs got there. A ধার is the other case: the person *is* the
 * loan, there is no loan without one, and `POST /loans` takes a `personName` and
 * files them itself precisely so that recording one is a single screen.
 */
/**
 * Which loan a ধার ফেরত settles.
 *
 * One picker, not two. A person picker followed by a loan picker reads well on
 * paper and is two decisions where one will do: nearly everybody has a handful
 * of open loans in total, and each option can carry the name, the direction and
 * what is left on it — which is the number somebody is checking against the
 * money in their hand anyway.
 *
 * Only ACTIVE loans, and OVERDUE ones, are offered. A settled loan cannot take
 * another payment (the API refuses one), and a cancelled loan is a debt both
 * sides called off; listing either would be offering a choice that fails.
 */
function LoanToRepayField({
  value,
  onChange,
  onAccountHint,
}: {
  value: string;
  onChange: (id: string) => void;
  /** The account the loan was made through, offered as the default for the money coming back. */
  onAccountHint: (accountId: string) => void;
}) {
  /* The whole list, filtered here rather than by `?status=ACTIVE`. An overdue
     loan has status OVERDUE, and that server-side filter would drop exactly the
     loans somebody is most likely to be recording a payment against. */
  const loans = useQuery({
    queryKey: ['loans', 'list', ''],
    queryFn: () => api<LoanRow[]>('/loans'),
    staleTime: 30_000,
  });

  const rows = (loans.data ?? []).filter(
    (row) =>
      (row.status === 'ACTIVE' || row.status === 'OVERDUE') && row.progress.outstandingMinor > 0,
  );
  const chosen = rows.find((row) => row.id === value);

  return (
    <Field label={t('entry.repayWhich', 'কোন ধারের ফেরত')} htmlFor="qa-loan">
      <Select
        id="qa-loan"
        name="loanId"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          const picked = rows.find((row) => row.id === e.target.value);
          /* The account the loan went out through, offered back as the default
             for the money returning. Nearly always right, and always editable —
             somebody who lent from bKash may well be repaid in cash. */
          if (picked) onAccountHint(picked.accountId);
        }}
        required
      >
        <option value="">{t('common.choose', 'বেছে নিন')}</option>
        {rows.map((row) => (
          <option key={row.id} value={row.id}>
            {`${row.personName} · ${
              row.direction === 'LENT'
                ? t('entry.repayIn', 'ফেরত পাব')
                : t('entry.repayOut', 'ফেরত দেব')
            } ${formatMinor(row.progress.outstandingMinor)}`}
          </option>
        ))}
      </Select>
      {loans.isSuccess && rows.length === 0 ? (
        <p className="text-ink-muted mt-1 text-xs">
          {t(
            'entry.repayNone',
            'এখনো কোনো চলমান ধার নেই। আগে “ধার দিয়েছি” বা “ধার নিয়েছি” দিয়ে লিখে নিন।',
          )}
        </p>
      ) : null}
      {chosen ? (
        <p className="text-ink-muted mt-1 text-xs">
          {chosen.direction === 'LENT'
            ? t('entry.repayInHint', 'টাকাটা আপনার হিসাবে ঢুকবে আর পাওনা কমবে।')
            : t('entry.repayOutHint', 'টাকাটা আপনার হিসাব থেকে যাবে আর দেনা কমবে।')}
        </p>
      ) : null}
    </Field>
  );
}

/** Only what the picker above reads. `LoanView` in the API has the full shape. */
interface LoanRow {
  id: string;
  personName: string;
  direction: 'LENT' | 'BORROWED';
  status: string;
  accountId: string;
  progress: { outstandingMinor: number };
}

function LoanPersonField({
  direction,
  personId,
  personName,
  onPersonId,
  onPersonName,
}: {
  direction: 'LENT' | 'BORROWED';
  personId: string;
  personName: string;
  onPersonId: (id: string) => void;
  onPersonName: (name: string) => void;
}) {
  const people = useQuery({
    queryKey: ['people', 'list', ''],
    queryFn: () => fetchPeople(),
    staleTime: 60_000,
  });

  const rows = React.useMemo(
    () => [...(people.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'bn')),
    [people.data],
  );

  /* A khata with nobody in it yet has nothing to choose between, so it asks for
     the name outright. Waiting for `isSuccess` matters: an empty list while the
     request is still in flight is not the same answer as an empty khata, and
     flipping to the name box and back as the data lands would move the field
     under somebody's thumb. */
  const empty = people.isSuccess && rows.length === 0;
  React.useEffect(() => {
    if (empty && personId !== NEW_PERSON) onPersonId(NEW_PERSON);
  }, [empty, personId, onPersonId]);

  const label =
    direction === 'LENT'
      ? t('entry.lentTo', 'কাকে ধার দিয়েছেন')
      : t('entry.borrowedFrom', 'কার কাছ থেকে ধার নিয়েছেন');

  return (
    <div className="flex flex-col gap-4">
      {empty ? null : (
        <Field label={label} htmlFor="qa-loan-person">
          <Select
            id="qa-loan-person"
            name="loanPersonId"
            value={personId}
            onChange={(e) => onPersonId(e.target.value)}
            required
          >
            <option value="">{t('common.choose', 'বেছে নিন')}</option>
            <option value={NEW_PERSON}>{t('entry.newPerson', 'নতুন ব্যক্তি')}</option>
            {rows.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
                {person.phone ? ` · ${person.phone}` : ''}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {personId === NEW_PERSON ? (
        <Field label={empty ? label : t('entry.personName', 'নাম')} htmlFor="qa-loan-person-name">
          <Input
            id="qa-loan-person-name"
            name="loanPersonName"
            value={personName}
            onChange={(e) => onPersonName(e.target.value)}
            required
            placeholder={t('entry.personNameHint', 'যেমন: রহিম উদ্দিন')}
          />
          {/* The number is on the contact, not on the loan, so it can be added
              later without touching the money. Said here because somebody
              typing a name is exactly the person wondering where it went. */}
          <p className="text-ink-muted mt-1 text-xs">
            {t('entry.personPhoneLater', 'মোবাইল নম্বর পরে মানুষজন পাতায় যোগ করা যাবে।')}
          </p>
        </Field>
      ) : null}
    </div>
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
/** The policy and the instalment a premium entry settles. */
interface PremiumPick {
  policyId: string;
  premiumId: string;
  insurer: string;
  dueDate: string;
  amountMinor: number;
}

/** A policy the picker can offer, from `GET /insurance`. */
interface PolicyOption {
  id: string;
  insurer: string;
  policyNumberMasked: string | null;
  status: string;
  nextDue: { id: string; dueDate: string; amountMinor: number } | null;
}

/**
 * "কোন বীমার প্রিমিয়াম" — the policy an expense pays into.
 *
 * ## Why it is here and not on the বীমা screen
 *
 * The same reason `InvestmentField` above is here. A premium leaves the bank
 * account like any other expense, and the person recording it is already on
 * this form with the amount in front of them. What the books were missing was
 * *which policy it settled* — so the schedule went on asking for money that had
 * already gone, and the only way to answer it was to remember another screen
 * and press দিলাম there. Two records of one event, kept in step by somebody's
 * memory.
 *
 * The tick is a second request, made after the entry saves: a policy holds no
 * money of its own, so nothing about the ledger row changes — what changes is
 * that one instalment now names the transaction that paid it.
 *
 * ## Expenses only, and only what can still be paid
 *
 * Money arriving *from* an insurer is a claim or a maturity and settles no
 * instalment. A lapsed policy and one whose schedule is finished are both
 * refused by the server, so neither is offered — an enabled dropdown whose only
 * outcome is an error is worse than no dropdown.
 */
function PremiumField({
  kind,
  value,
  onChange,
}: {
  kind: Kind;
  value: PremiumPick | null;
  onChange: (pick: PremiumPick | null) => void;
}) {
  const { currency } = useWorkspaceSettings();
  const policies = useQuery({
    queryKey: ['insurance'],
    queryFn: () => api<PolicyOption[]>('/insurance'),
    staleTime: 60_000,
    enabled: kind === 'EXPENSE',
  });

  if (kind !== 'EXPENSE') return null;
  const rows = (policies.data ?? []).filter(
    (policy) => policy.status === 'ACTIVE' && policy.nextDue !== null,
  );
  if (rows.length === 0) return null;

  return (
    <Field label={t('entry.whichPolicy', 'কোন বীমার প্রিমিয়াম')} htmlFor="qa-policy">
      <Select
        id="qa-policy"
        name="policyId"
        value={value?.policyId ?? ''}
        onChange={(e) => {
          const policy = rows.find((row) => row.id === e.target.value);
          onChange(
            policy?.nextDue
              ? {
                  policyId: policy.id,
                  premiumId: policy.nextDue.id,
                  insurer: policy.insurer,
                  dueDate: policy.nextDue.dueDate,
                  amountMinor: policy.nextDue.amountMinor,
                }
              : null,
          );
        }}
      >
        <option value="">{t('entry.notAPremium', 'বীমার প্রিমিয়াম নয়')}</option>
        {rows.map((policy) => (
          <option key={policy.id} value={policy.id}>
            {[policy.insurer, policy.policyNumberMasked].filter(Boolean).join(' ')}
          </option>
        ))}
      </Select>
      <p className="text-ink-muted mt-1 text-xs">
        {value
          ? t(
              'entry.premiumWillTick',
              '{date} তারিখের কিস্তিটি ({amount}) পরিশোধিত হিসেবে টিক পড়বে।',
            )
              .replace('{date}', fmtDate(value.dueDate))
              .replace('{amount}', formatMinor(value.amountMinor, { currency }))
          : t(
              'entry.whichPolicyHint',
              'ঐচ্ছিক। বীমার প্রিমিয়াম দিলে পলিসিটি বেছে দিন — বীমা পাতায় ওই কিস্তিটি নিজে থেকেই পরিশোধিত হয়ে যাবে।',
            )}
      </p>
    </Field>
  );
}

/**
 * "কোন সঞ্চয় থেকে" — the investment an income row came out of.
 *
 * ## Why it is here and not on the savings screen
 *
 * A Sanchayapatra pays its profit into an ordinary bank account every month or
 * quarter. That is an income row like any other, and the person recording it is
 * already here, in the khata, with the amount in front of them. The only thing
 * the books were missing was *which certificate paid it* — so that is the only
 * thing this asks.
 *
 * The alternative, a button on the savings screen, makes somebody remember a
 * place rather than a fact, and it quietly implies that investment income is a
 * different kind of money. It is not. It is income, and it belongs on the same
 * form as a salary.
 *
 * ## Income only
 *
 * Shown on income rows and nowhere else. Money going *into* a DPS is a transfer
 * between two of your own accounts, not a transaction filed against the plan,
 * and offering this box on an expense would invite exactly that mistake.
 *
 * Hidden when there is nothing to pick, like `PersonField` above: an enabled
 * dropdown holding one "কোনোটি নয়" is a dead end that asks the reader to work
 * out why.
 */
function InvestmentField({
  kind,
  value,
  onChange,
}: {
  kind: Kind;
  value: string;
  onChange: (id: string) => void;
}) {
  const plans = useQuery({
    queryKey: ['savings'],
    queryFn: () => api<{ id: string; planName: string; planType: string }[]>('/savings'),
    staleTime: 60_000,
    enabled: kind === 'INCOME',
  });

  if (kind !== 'INCOME') return null;
  const rows = plans.data ?? [];
  if (rows.length === 0 && !value) return null;

  return (
    <Field label={t('entry.fromInvestment', 'কোন সঞ্চয় থেকে')} htmlFor="qa-investment">
      <Select
        id="qa-investment"
        name="savingsPlanId"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t('entry.noInvestment', 'কোনোটি নয়')}</option>
        {rows.map((plan) => (
          <option key={plan.id} value={plan.id}>
            {plan.planName}
          </option>
        ))}
      </Select>
      <p className="text-ink-muted mt-1 text-xs">
        {t(
          'entry.fromInvestmentHint',
          'ঐচ্ছিক। সঞ্চয়পত্র বা ডিপিএসের মুনাফা হলে বেছে দিন — তাহলে কোনটা থেকে কত মুনাফা পেলেন সেই হিসাব রাখা যাবে।',
        )}
      </p>
    </Field>
  );
}

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
    <Field label={t('entry.withWhom', 'কার সাথে')} htmlFor="qa-person">
      <Select
        id="qa-person"
        name="personId"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t('entry.nobody', 'কেউ না')}</option>
        {rows.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
            {person.relation ? ` — ${person.relation}` : ''}
          </option>
        ))}
      </Select>
      <p className="text-ink-muted mt-1 text-xs">
        {t('entry.personHint', 'ঐচ্ছিক। নতুন কাউকে যোগ করতে মানুষজন পাতায় যান।')}
      </p>
    </Field>
  );
}
