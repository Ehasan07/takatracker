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
import { CategoryPicker } from '@/components/category-picker';
import { TagPicker } from '@/app/(shell)/tags/tag-picker';
import { Button } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useIsDesktop } from '@/hooks/use-device';
import { api, ApiError, endpoints } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { useWorkspaceSettings } from '@/lib/workspace-settings';
import { cn } from '@/lib/utils';
import { originOf, type FieldOrigin } from './evidence';
import { convertedAmountText, FxReviewField } from './fx-review';
import { bnDateTime, bnNum, channelLabel, REJECT_REASONS, statusLabel } from './labels';
import { Sparkles } from 'lucide-react';
import { t } from '@/lib/t';
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
  /**
   * The tags the last accept carried, offered to the next draft.
   *
   * A shop's messages arrive in runs — fifty bKash alerts, all the same
   * venture — and re-picking the tag on every one of them is the reason a
   * queue does not get cleared. Carried like the account and the খাত are, and
   * as visible as they are: the line under the pickers says so.
   */
  tagIds: readonly string[];
}

export type Outcome = 'accepted' | 'rejected';

/**
 * The six words this screen can say — the same six as the নতুন লেনদেন sheet.
 *
 * ধার used to be missing here, and the gap was not academic: ৳3,000 arrives in
 * bKash and it is a borrower repaying. Accepted as আয় it invents ৳3,000 of
 * earnings *and* leaves the debt standing at its full size, so the books are
 * wrong twice and the one entry that mattered — the outstanding balance coming
 * down — never happens. There was no third option: the message could only be
 * filed wrongly or left in the queue forever.
 *
 * Nothing here creates a loan by itself. The two ধার tabs hand the accept a
 * person or a loan and the server posts through the loans module, which is
 * where disbursement, instalments, the interest clock and closing a settled
 * loan already live.
 */
type Kind = 'EXPENSE' | 'INCOME' | 'TRANSFER' | 'LENT' | 'BORROWED' | 'REPAY';

const KINDS: {
  kind: Kind;
  direction: Direction;
  key: string;
  label: string;
}[] = [
  { kind: 'EXPENSE', direction: 'OUT', key: 'entry.tab.expense', label: 'খরচ' },
  { kind: 'INCOME', direction: 'IN', key: 'entry.tab.income', label: 'আয়' },
  { kind: 'TRANSFER', direction: 'OUT', key: 'entry.tab.transfer', label: 'ট্রান্সফার' },
  { kind: 'LENT', direction: 'OUT', key: 'entry.tab.lent', label: 'ধার দিয়েছি' },
  { kind: 'BORROWED', direction: 'IN', key: 'entry.tab.borrowed', label: 'ধার নিয়েছি' },
  { kind: 'REPAY', direction: 'IN', key: 'entry.tab.repay', label: 'ধার ফেরত' },
];

/** The two that create a loan, and the one that pays an existing one. */
const isNewLoan = (kind: Kind): kind is 'LENT' | 'BORROWED' =>
  kind === 'LENT' || kind === 'BORROWED';
const isLoanKind = (kind: Kind): boolean => isNewLoan(kind) || kind === 'REPAY';

/** A live loan, as much of it as this screen needs to label a row. */
interface LoanOption {
  id: string;
  personName: string;
  direction: 'LENT' | 'BORROWED';
  status: string;
  progress: { outstandingMinor: number };
}

interface PersonOption {
  id: string;
  name: string;
}

/** Whichever the reviewer types a new name under. */
const NEW_PERSON = '__new__';

interface FormState {
  /** Which of the six this is. The two below are what the accept actually sends. */
  kind: Kind;
  date: string;
  amount: string;
  /**
   * Which way the money went. Never empty.
   *
   * It used to start as `''` whenever the parser could not read a direction —
   * while `kind` still started at `EXPENSE`, so the খরচ tab was drawn selected
   * over a form that held no direction at all. The খাত box then refused with
   * "আগে দিক বেছে নিন" about a tab that was already blue, and the only way out
   * was to press another tab and press খরচ again. The screen was telling the
   * truth about its state and lying about it in the same breath; this is the
   * half that was wrong.
   */
  direction: Direction;
  payee: string;
  accountId: string;
  /** Set only when this was a move between two of the reviewer's own accounts. */
  counterAccountId: string;
  categoryId: string;
  description: string;
  notes: string;
  /** What this is *for* — the venture, the trip, the family. */
  tagIds: string[];
  /** ধার ফেরত: which loan is being paid. */
  loanId: string;
  /** ধার দিয়েছি / ধার নিয়েছি: who with — an existing person, or `NEW_PERSON`. */
  personId: string;
  personName: string;
}

function categoryKindFor(direction: Direction): 'INCOME' | 'EXPENSE' {
  return direction === 'IN' ? 'INCOME' : 'EXPENSE';
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

  /* The books' currency decides how many minor units a typed amount is worth,
     what symbol goes on the label, and whether the message was in "another"
     currency at all. Read before the form state, which needs it. */
  const { currency, currencyInfo } = useWorkspaceSettings();

  /* Both halves, or neither — the server sends them that way. Null on the
     overwhelming majority of drafts, which are in the workspace's own money.
     Memoised so the rate field's "fill an empty box once" effect is not handed
     a new object on every keystroke. */
  const fx = React.useMemo(
    () =>
      draft.fxCurrency && draft.fxAmountMinor !== null
        ? { currency: draft.fxCurrency, amountMinor: draft.fxAmountMinor }
        : null,
    [draft.fxCurrency, draft.fxAmountMinor],
  );

  const [form, setForm] = React.useState<FormState>(() => ({
    kind: draft.direction === 'IN' ? 'INCOME' : 'EXPENSE',
    date: draft.date ?? '',
    /* Empty when the message carried no figure. A zero-confidence draft claims
       nothing, and a form pre-filled with ০.০০ would be claiming it — as would
       a foreign-currency draft, whose `amountMinor` is null for exactly that
       reason: 4.6 dollars is not 4.60 taka and the box must not pretend it is. */
    amount:
      draft.amountMinor === null ? '' : formatMinor(draft.amountMinor, { symbol: false, currency }),
    /* Whatever the tab above starts on, and the tab starts on খরচ. A message
       whose direction could not be read is still going to be one or the other,
       and the evidence line above the tabs says outright that this one was not
       read — so the person is told it is a default and one tap changes it. What
       cannot stand is a selected tab over an empty field. */
    direction: draft.direction === 'IN' ? 'IN' : 'OUT',
    payee: draft.payee ?? '',
    accountId: draft.accountId ?? sticky.accountId,
    /* Never carried over and never guessed. The parser has no way to know it,
       and a stuck-on counter-account would silently turn the next unrelated
       message into a transfer. */
    counterAccountId: '',
    categoryId: draft.categoryId ?? sticky.categoryId,
    description: '',
    notes: '',
    /* From the last accept. A draft carries no tags of its own — nothing in a
       bank message says which venture it belongs to — so the only proposal
       worth making is the one the person made a moment ago. */
    tagIds: [...sticky.tagIds],
    loanId: '',
    personId: '',
    personName: '',
  }));

  /* The rate, as typed. Never sent and never stored: what reaches the server is
     the converted amount, and the rate is recoverable from it and the original
     as a ratio of two integers. `fx-convert.ts` explains why that matters. */
  const [rate, setRate] = React.useState('');
  const [stickyApplied] = React.useState(
    () =>
      (!draft.accountId && Boolean(sticky.accountId)) ||
      (!draft.categoryId && Boolean(sticky.categoryId)) ||
      sticky.tagIds.length > 0,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [rejecting, setRejecting] = React.useState(false);
  const [reason, setReason] = React.useState<RejectReason>('BAD_PARSE');

  const formRef = React.useRef<HTMLFormElement>(null);

  const liveAccounts = (accounts.data ?? []).filter((account) => !account.isArchived);
  const isTransfer = form.kind === 'TRANSFER';
  const loanKind = isLoanKind(form.kind);

  /* Fetched only once a ধার tab is open. Most drafts are not loans, and two
     extra requests behind every message in a fifty-deep queue is a cost paid by
     everybody for a case that applies to a few. */
  const loans = useQuery({
    queryKey: ['loans', 'open'],
    queryFn: () => api<LoanOption[]>('/loans'),
    enabled: form.kind === 'REPAY',
    staleTime: 30_000,
  });
  /* `/loans/people` answers with an envelope — `{ filtered, people }` — because
     the same route serves the search box on the ঋণ screen and has to say
     whether `q` filtered anything. Read as a bare array it is an object, and
     the `.map` below throws where the tab opens, which takes the whole page to
     the error boundary. So the envelope is opened here, once. */
  const people = useQuery({
    queryKey: ['loans', 'people'],
    queryFn: async () => (await api<{ people: PersonOption[] }>('/loans/people')).people,
    enabled: isNewLoan(form.kind),
    staleTime: 30_000,
  });

  /* Settled and cancelled loans cannot take an instalment, and offering one is
     offering a refusal. */
  const openLoans = (loans.data ?? []).filter(
    (loan) => loan.status !== 'SETTLED' && loan.status !== 'CANCELLED',
  );
  const chosenLoan = openLoans.find((loan) => loan.id === form.loanId);
  /* Which half of the category tree this entry belongs to. Always one of the
     two now, because the direction always is — the transfer and ধার tabs have
     no খাত at all, and clear the one they were carrying rather than asking this
     for a kind it cannot have. */
  const wantedKind = categoryKindFor(form.direction);

  /* A category carried over from an expense must not survive a switch to
     income: the server would refuse it, and leaving it on screen would make
     the refusal look like a bug rather than a mismatch. */
  React.useEffect(() => {
    if (!form.categoryId || categories.data === undefined) return;
    const chosen = categories.data.find((category) => category.id === form.categoryId);
    if (chosen && chosen.kind !== wantedKind) setForm((f) => ({ ...f, categoryId: '' }));
  }, [form.categoryId, wantedKind, categories.data]);

  /* Each picker leaves the other's answer out of its own list, so the pair can
     never name one account twice. Kept as a state fix rather than only a filter
     because a list that loses its selected option does not clear the value —
     the select draws its first entry instead, and the screen then says one
     thing while the form holds another. */
  React.useEffect(() => {
    if (form.counterAccountId && form.counterAccountId === form.accountId) {
      setForm((f) => ({ ...f, counterAccountId: '' }));
    }
  }, [form.accountId, form.counterAccountId]);

  /* Which way a repayment moves is the loan's answer, not the reviewer's:
     money comes back *in* on something lent and goes *out* on something
     borrowed. Set here so the field the accept sends agrees with the entry the
     loans module is about to write. */
  React.useEffect(() => {
    if (form.kind !== 'REPAY' || !chosenLoan) return;
    const direction: Direction = chosenLoan.direction === 'LENT' ? 'IN' : 'OUT';
    setForm((f) => (f.direction === direction ? f : { ...f, direction }));
  }, [form.kind, chosenLoan]);

  const set =
    (key: keyof FormState) =>
    (e: { target: { value: string } }): void =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  /**
   * A rate typed above fills the amount box below.
   *
   * One direction only, and it is the kinder one. Somebody reading a rate off
   * their card app types four characters and watches the taka appear; somebody
   * reading the settled figure off a statement types that instead and this
   * never runs, because the rate box stays empty. Driving it the other way as
   * well — amount back to rate — would have two boxes fighting over one truth
   * while a finger is still on the keyboard.
   *
   * It only ever writes when the conversion produces something: a half-typed
   * `12.` yields null and leaves whatever is in the box alone.
   */
  const onRateChange = React.useCallback(
    (next: string) => {
      setRate(next);
      if (!fx) return;
      const converted = convertedAmountText(fx.amountMinor, fx.currency, next, currency);
      if (converted !== null) setForm((f) => ({ ...f, amount: converted }));
    },
    [fx, currency],
  );

  const accept = useMutation({
    mutationFn: (body: AcceptDraftBody) => acceptDraft(draft.id, body),
    onSuccess: (saved) => {
      haptic('success');
      onSticky({
        accountId: form.accountId,
        categoryId: form.categoryId,
        tagIds: form.tagIds,
      });
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

  /**
   * A refusal, put where the eye already is.
   *
   * Every check below used to only `setError`, and the message rendered at the
   * bottom of a sheet that is taller than a phone. Somebody on the ধার tab with
   * no counterparty chosen tapped যোগ করে পরেরটি and watched nothing happen:
   * the sentence telling them what was missing was two screens below the
   * button they had just pressed. The message now lives in the sticky footer,
   * and this scrolls the field it is about into view and puts the cursor in
   * it — a refusal nobody can see is a button that does not work.
   */
  const fail = (message: string, fieldId?: string): void => {
    setError(message);
    if (!fieldId) return;
    const field = document.getElementById(fieldId);
    if (!field) return;
    field.scrollIntoView({ block: 'center', behavior: 'smooth' });
    /* After the scroll, and without a second one: focus() would jump the sheet
       again on its own and land somewhere else. */
    field.focus({ preventScroll: true });
  };

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    setError(null);

    if (!form.date) {
      fail('তারিখ দিন', 'dr-date');
      return;
    }

    /* An empty box is a question nobody has answered yet, not a value that
       failed to parse — and `parseMoneyToMinor('')` throws, so without this it
       would be reported as "টাকার পরিমাণ বোঝা গেল না", which asks somebody to
       fix a number they never typed. On a foreign-currency draft it is *the*
       question, so it gets the sentence that says how to answer it. */
    if (!form.amount.trim()) {
      fail(
        fx
          ? t('inbox.fxNeedAmount', 'রেট দিন, নয়তো কত টাকা কাটা হয়েছে সেটি লিখুন')
          : 'টাকার পরিমাণ দিন',
        'dr-amount',
      );
      return;
    }

    let amountMinor: number;
    try {
      /* What a human typed becomes minor units here, truncated, never rounded —
         and in the *workspace's* currency, whatever the message was in. That is
         the invariant the ledger is built on: `amountMinor` is always the books'
         own money, and `fxCurrency`/`fxAmountMinor` record what it really was. */
      amountMinor = parseMoneyToMinor(form.amount, currency);
    } catch (err) {
      fail(
        err instanceof MoneyParseError ? 'টাকার পরিমাণ বোঝা গেল না' : 'টাকার পরিমাণ দিন',
        'dr-amount',
      );
      return;
    }
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      /* A foreign draft brings no figure of its own, so an empty box here is
         not a slip — it is the one question this screen was opened to ask. */
      fail(
        fx
          ? t('inbox.fxNeedAmount', 'রেট দিন, নয়তো কত টাকা কাটা হয়েছে সেটি লিখুন')
          : 'টাকার পরিমাণ দিন',
        'dr-amount',
      );
      return;
    }
    if (!form.accountId) {
      fail(isTransfer ? 'কোন হিসাব থেকে গেল বেছে নিন' : 'অ্যাকাউন্ট নির্বাচন করুন', 'dr-account');
      return;
    }
    if (isTransfer && !form.counterAccountId) {
      fail('কোন হিসাবে গেল বেছে নিন', 'dr-counter');
      return;
    }
    if (form.kind === 'REPAY' && !form.loanId) {
      fail(t('entry.pickLoan', 'কোন ধারের ফেরত — বেছে নিন'), 'dr-loan');
      return;
    }
    if (isNewLoan(form.kind) && !form.personId) {
      fail(t('entry.pickPerson', 'কার সাথে ধার — বেছে নিন বা নাম লিখুন'), 'dr-person');
      return;
    }
    if (isNewLoan(form.kind) && form.personId === NEW_PERSON && !form.personName.trim()) {
      fail(t('entry.typePersonName', 'নতুন নামটি লিখুন'), 'dr-person-name');
      return;
    }
    if (!isTransfer && !loanKind && !form.categoryId) {
      fail('ক্যাটাগরি নির্বাচন করুন', 'dr-category');
      return;
    }
    if (isTransfer && form.counterAccountId === form.accountId) {
      fail('একই অ্যাকাউন্টে সরানো যায় না — অন্য একটি বেছে নিন', 'dr-counter');
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
      /* Sent together or not at all: a transfer has no খাত, and sending a
         leftover one would be asking the server to book two contradictory
         things. */
      /* One of three shapes, never two. A transfer has no খাত; a ধার has
         neither, because the loans module owns both sides of it. */
      ...(isTransfer ? { counterAccountId: form.counterAccountId } : {}),
      ...(form.kind === 'REPAY' ? { loanId: form.loanId } : {}),
      ...(isNewLoan(form.kind)
        ? {
            loanDirection: form.kind,
            ...(form.personId === NEW_PERSON
              ? { personName: form.personName.trim() }
              : { personId: form.personId }),
          }
        : {}),
      ...(isTransfer || loanKind ? {} : { categoryId: form.categoryId }),
      ...(form.date === draft.date ? {} : { date: form.date }),
      ...(amountMinor === draft.amountMinor ? {} : { amountMinor }),
      ...(form.direction === draft.direction ? {} : { direction: form.direction }),
      // null clears a payee the parser guessed; '' would store an empty string.
      ...(payee === draft.payee ? {} : { payee }),
      ...(description ? { description } : {}),
      ...(notes ? { notes } : {}),
      /* Always sent, empty included: clearing the tags a previous draft stuck
         on has to be a thing a person can do, and an omitted field would mean
         "unchanged" rather than "none". */
      tagIds: form.tagIds,
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

      {draft.suggestedBy ? (
        /* Said out loud, because the fields below arrive filled in and there is
           otherwise nothing to tell a reader that two of them were guessed by a
           machine rather than read from their bank. A suggestion presented as a
           reading is how people stop checking. */
        <p className="bg-brand-tint text-ink-muted flex items-start gap-2 rounded-md px-3 py-2 text-sm">
          <Sparkles className="text-brand mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            {t(
              'inbox.aiSuggested',
              'খাত আর অ্যাকাউন্ট AI বেছে দিয়েছে — মিলিয়ে নিন, ভুল হলে বদলে দিন।',
            )}
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

        {/* Above the amount box, because it is what the amount box now depends
            on. A dollar charge has no taka figure until this is answered. */}
        {fx ? (
          <FxReviewField
            currency={fx.currency}
            amountMinor={fx.amountMinor}
            base={currency}
            rate={rate}
            onRateChange={onRateChange}
            quoted={draft.evidence.fxAmountMinor}
            disabled={!pending || busy}
          />
        ) : null}

        <EvidenceField
          /* Never `(৳)` on faith. The symbol is the workspace's own, so a
             yen-kept ledger says ¥ — and when the message was in another
             currency the label says out loud that this box is the *converted*
             figure, because a box marked ৳ holding a dollar amount is the
             visible half of the bug this screen used to have. */
          label={
            fx
              ? `${t('inbox.amountInBooks', 'খাতায় কত টাকা যাবে')} (${currencyInfo.symbol})`
              : `${t('inbox.amount', 'টাকার পরিমাণ')} (${currencyInfo.symbol})`
          }
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

        {/* The same three words the নতুন লেনদেন sheet opens with, in the same
            order and the same colours.
 
            This screen used to ask "কোন দিকে গেল" and offer two answers, which
            is a true question about a *bank message* and the wrong question
            about a ledger. A DPS instalment leaves an account and enters
            another; answering "বেরিয়েছে" is correct and still books an expense,
            and the reviewer has no word available for what actually happened.
            Somebody who has typed an entry by hand already knows where that
            word lives — so it lives in the same place here. */}
        <EvidenceField
          label={t('inbox.kind', 'ধরন')}
          htmlFor="dr-kind"
          group
          origin={originOf(draft.direction, 'direction', draft.evidence)}
          quoted={draft.evidence.direction}
        >
          <div
            id="dr-kind"
            role="tablist"
            aria-label={t('inbox.kind', 'ধরন')}
            /* Two rows of three. Six across a 288px sheet gives each label
               45px, and ট্রান্সফার does not fit in 45px at any weight — the
               same arithmetic the নতুন লেনদেন sheet settled on. */
            className="bg-greenbar grid grid-cols-3 gap-1 rounded-lg p-1"
          >
            {KINDS.map((tab) => (
              <button
                key={tab.kind}
                type="button"
                role="tab"
                aria-selected={form.kind === tab.kind}
                onClick={() => {
                  haptic('tap');
                  setForm((f) => {
                    if (isLoanKind(tab.kind)) {
                      /* One account and a person or a loan; no খাত and no other
                         side. `direction` is the tab's for a loan being made
                         and the loan's own for a repayment — see the effect
                         above, which corrects it once one is chosen. */
                      return {
                        ...f,
                        kind: tab.kind,
                        direction: tab.direction,
                        accountId: f.accountId || f.counterAccountId,
                        counterAccountId: '',
                        categoryId: '',
                        ...(tab.kind === 'REPAY'
                          ? { personId: '', personName: '' }
                          : { loanId: '' }),
                      };
                    }
                    if (tab.kind !== 'TRANSFER') {
                      /* Back to one account and one খাত. The other side goes,
                         because the accept reads that field and not the tab. */
                      return {
                        ...f,
                        kind: tab.kind,
                        direction: tab.direction,
                        accountId: f.accountId || f.counterAccountId,
                        counterAccountId: '',
                        loanId: '',
                        personId: '',
                        personName: '',
                      };
                    }
                    /* Two accounts now, and the message's own is already on one
                       of the two sides — which one is exactly what its direction
                       said. A DPS alert reading "জমা হয়েছে" names the account
                       that *received*, so it belongs in কোন হিসাবে and the box
                       above it is the one still to be answered. */
                    const arrived = f.direction === 'IN';
                    return {
                      ...f,
                      kind: 'TRANSFER',
                      // Always OUT on the wire: `accountId` pays, the other receives.
                      direction: 'OUT',
                      accountId: arrived ? '' : f.accountId,
                      counterAccountId: arrived ? f.accountId : f.counterAccountId,
                      categoryId: '',
                      loanId: '',
                      personId: '',
                      personName: '',
                    };
                  });
                }}
                className={cn(
                  form.kind === tab.kind
                    ? 'press bg-brand text-brand-contrast min-h-11 truncate rounded-md px-1 text-sm font-semibold shadow-sm'
                    : 'press text-ink-muted min-h-11 truncate rounded-md px-1 text-sm',
                )}
              >
                {t(tab.key, tab.label)}
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
        <EvidenceField
          label={isTransfer ? t('inbox.fromAccount', 'কোন হিসাব থেকে') : 'অ্যাকাউন্ট'}
          htmlFor="dr-account"
        >
          <Select id="dr-account" value={form.accountId} onChange={set('accountId')}>
            <option value="">অ্যাকাউন্ট বেছে নিন</option>
            {liveAccounts
              .filter((account) => !isTransfer || account.id !== form.counterAccountId)
              .map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
          </Select>
        </EvidenceField>

        {/* The half a bank message cannot see.
 
            A DPS alert says ৳10,000 arrived and has no way to say it left a
            bKash wallet a second earlier — the bank does not know, and the
            parser has nothing to read. So this is the one field on the screen
            that is pure human knowledge, and it is why the ট্রান্সফার tab
            exists: accepted as income that instalment invents ৳10,000 of
            earnings every month, which is how this ledger came to hold
            ৳66,98,616 of savings deposits filed as spending. */}
        {isTransfer ? (
          <EvidenceField label={t('inbox.toAccount', 'কোন হিসাবে')} htmlFor="dr-counter">
            <Select
              id="dr-counter"
              value={form.counterAccountId}
              onChange={set('counterAccountId')}
            >
              <option value="">অ্যাকাউন্ট বেছে নিন</option>
              {liveAccounts
                .filter((account) => account.id !== form.accountId)
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
            </Select>
            <p className="text-ink-muted mt-1 text-xs">
              {t(
                'inbox.counterHint',
                'খাতায় স্থানান্তর হিসেবে বসবে — আয়ও নয়, খরচও নয়, তাই খাত লাগবে না। মোট সম্পদ বদলাবে না, শুধু টাকাটা এক হিসাব থেকে আরেক হিসাবে যাবে।',
              )}
            </p>
          </EvidenceField>
        ) : null}

        {/* ধার ফেরত: which loan. A person can owe on three at once and an
            amount says nothing about which one it settles, so this is the
            question and there is no guessing it. */}
        {form.kind === 'REPAY' ? (
          <EvidenceField label={t('inbox.whichLoan', 'কোন ধারের ফেরত')} htmlFor="dr-loan">
            <Select id="dr-loan" value={form.loanId} onChange={set('loanId')}>
              <option value="">{t('entry.pickLoan', 'কোন ধারের ফেরত — বেছে নিন')}</option>
              {openLoans.map((loan) => (
                <option key={loan.id} value={loan.id}>
                  {`${loan.personName} — ${
                    loan.direction === 'LENT'
                      ? t('inbox.loanOwedToMe', 'পাবো')
                      : t('inbox.loanOwedByMe', 'দেবো')
                  } ${formatMinor(loan.progress.outstandingMinor, { currency })}`}
                </option>
              ))}
            </Select>
            {loans.isSuccess && openLoans.length === 0 ? (
              <p className="text-ink-muted mt-1 text-xs">
                {t('inbox.noOpenLoans', 'খোলা কোনো ধার নেই — আগে ঋণ পাতায় ধারটি লিখুন')}
              </p>
            ) : (
              <p className="text-ink-muted mt-1 text-xs">
                {t(
                  'inbox.repayHint',
                  'খাতায় ধারের কিস্তি হিসেবে বসবে — আয়ও নয়, খরচও নয়। বাকি টাকার অঙ্ক কমে যাবে, আর শোধ হয়ে গেলে ধারটি বন্ধ হয়ে যাবে।',
                )}
              </p>
            )}
          </EvidenceField>
        ) : null}

        {/* ধার দিয়েছি / ধার নিয়েছি: with whom. */}
        {isNewLoan(form.kind) ? (
          <EvidenceField label={t('inbox.withWhom', 'কার সাথে ধার')} htmlFor="dr-person">
            <Select id="dr-person" value={form.personId} onChange={set('personId')}>
              <option value="">
                {t('entry.pickPerson', 'কার সাথে ধার — বেছে নিন বা নাম লিখুন')}
              </option>
              {(people.data ?? []).map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
              <option value={NEW_PERSON}>{t('inbox.newPerson', 'নতুন নাম লিখি')}</option>
            </Select>
            {form.personId === NEW_PERSON ? (
              <Input
                id="dr-person-name"
                className="mt-2"
                value={form.personName}
                onChange={set('personName')}
                maxLength={120}
                placeholder={t('inbox.personName', 'নাম')}
                aria-label={t('inbox.personName', 'নাম')}
              />
            ) : null}
            <p className="text-ink-muted mt-1 text-xs">
              {t(
                'inbox.newLoanHint',
                'খাতায় নতুন একটি ধার খুলবে — সুদ ছাড়া, আজকের তারিখে। সুদ বা ফেরতের তারিখ লাগলে ঋণ পাতা থেকে যোগ করে নিন।',
              )}
            </p>
          </EvidenceField>
        ) : null}

        {isTransfer || loanKind ? null : (
          /* The same picker the নতুন লেনদেন sheet uses, search box and all.
 
             This screen had a bare `<select>`, and a workspace with a hundred
             categories turns that into the phone's native wheel — a list you
             scroll blind, with no way to type "bua" and land on বুয়া. Fifty
             drafts deep that is the slowest thing on the screen, and it was the
             one control here that had a better version already built. */
          <CategoryPicker
            categories={categories.data ?? []}
            kind={wantedKind}
            value={form.categoryId}
            onChange={(categoryId) => setForm((f) => ({ ...f, categoryId }))}
            idPrefix="dr"
          />
        )}

        {/* What this is *for*, beside what it was.
 
            A shop run out of the household's own bKash is separated from it by
            this and by nothing else, so a business message that cannot be
            tagged here never reaches the venture's own profit — it either goes
            in unmarked or has to be found again in the khata and edited. On a
            ধার tab it is absent: a loan carries no tags, and offering a control
            whose value would be dropped is worse than not offering it. */}
        {loanKind ? null : (
          <div className="flex flex-col gap-1.5">
            <span className="text-ink-muted text-xs font-medium">
              {t('inbox.tags', 'ট্যাগ — কার জন্য বা কোন কাজে')}
            </span>
            <TagPicker
              value={form.tagIds}
              onChange={(tagIds) => setForm((f) => ({ ...f, tagIds }))}
              idPrefix="dr"
            />
          </div>
        )}

        {stickyApplied && pending ? (
          <p className="text-ink-muted -mt-2 text-xs">
            গতবার বেছে নেওয়া অ্যাকাউন্ট, খাত ও ট্যাগ আগে থেকে বসানো আছে — না মিললে বদলে নিন।
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

      {/* A draft that is no longer pending has no footer to carry this, so the
          message it gets back from a failed reject stays here. */}
      {error && !pending ? (
        <p role="alert" className="text-expense text-sm">
          {error}
        </p>
      ) : null}

      {/* --- the decision -------------------------------------------------- */}
      {pending ? (
        <div className="bg-surface border-rule sticky bottom-0 -mx-4 flex flex-col gap-2 border-t px-4 pb-2 pt-3">
          {/* Inside the sticky bar, above the button that produced it: the
              sheet is longer than a phone screen, and a message rendered in
              the flow above sat below the fold exactly when it was needed. */}
          {error ? (
            <p role="alert" className="text-expense text-sm">
              {error}
            </p>
          ) : null}
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
