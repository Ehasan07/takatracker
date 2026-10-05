'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import {
  deriveLoanStatus,
  summariseLoan,
  type LoanPaymentInput,
  type LoanTerms,
} from '@hishab/core';
import { parseMoneyToMinor, toLocalDateString } from '@hishab/shared';
import { Money } from '@/components/money';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { api, ApiError } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { useWorkspaceSettings } from '@/lib/workspace-settings';
import { INTEREST_TYPES, directionLabel, statusLabel } from './labels';
import { invalidateLoanData } from './queries';
import type { LoanDetail, LoanInterestType } from './types';

/**
 * A loan date is a calendar day, not an instant — the API reads one with its
 * own `calendarDay` (loans.service.ts) and so does `@hishab/core`. The preview
 * below has to read it the same way, or it would warn about arithmetic the
 * server never performs.
 */
function calendarDay(iso: string): Date {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Taka typed by a human, in poisha. `null` while it is still half-typed ("১২."),
 * so the preview goes quiet for a keystroke instead of flashing a warning.
 *
 * Never `Math.trunc(Number(x) * 100)`: that turns 0.29 into 28.
 */
/* Takes the currency rather than reading it: this is a module-level helper
   and a hook cannot live here. The callers all have it. */
function minorOrNull(text: string, currency: string): number | null {
  try {
    return parseMoneyToMinor(text.trim() || '0', currency);
  } catch {
    return null;
  }
}

/** Poisha back to the digits a person would type, for seeding the form. */
function minorToInput(minor: number): string {
  if (minor === 0) return '';
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

interface EditForm {
  principal: string;
  interestType: LoanInterestType;
  interest: string;
  rate: string;
  loanDate: string;
  dueDate: string;
  note: string;
}

function seedForm(detail: LoanDetail): EditForm {
  const { loan } = detail;
  return {
    principal: minorToInput(loan.principalMinor),
    interestType: loan.interestType,
    interest: loan.interestType === 'FIXED' ? minorToInput(loan.interestMinor) : '',
    // Basis points are hundredths of a percent, so the same two-decimal shape:
    // 825 bps is the "৮.২৫" somebody typed.
    rate: loan.interestType === 'PERCENT' ? minorToInput(loan.interestRateBps) : '',
    loanDate: loan.loanDate.slice(0, 10),
    dueDate: loan.dueDate ? loan.dueDate.slice(0, 10) : '',
    note: loan.note ?? '',
  };
}

/**
 * Edit the terms of a loan.
 *
 * Only what can honestly move: the money, the interest, the dates, the note.
 * The counterparty, the direction and the cash account are fixed once the
 * ledger has booked the disbursement, so they are shown as facts rather than
 * offered as dead controls — a greyed-out dropdown with no explanation is a
 * worse answer than a sentence.
 *
 * The preview is not decoration. `summariseLoan` here is the same function the
 * API runs before it accepts the change, so the two warnings below — cutting
 * the total below what has already come back, and reopening a finished loan —
 * are the server's own arithmetic, shown before the save rather than after it.
 */
export function EditLoanSheet({
  detail,
  open,
  onOpenChange,
  onSaved,
}: {
  detail: LoanDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  /* The books' currency decides how many minor units a typed amount is worth —
     100 for taka, 1 for yen, 1000 for a dinar. Read at the top of the component
     because the derived figures below need it before the save handler does. */
  const { currency } = useWorkspaceSettings();
  const { loan, person, payments } = detail;

  const [form, setForm] = React.useState<EditForm>(() => seedForm(detail));
  const [error, setError] = React.useState<string | null>(null);

  /* Re-seeded once per opening, not on every render: a background refetch of
   * the loan must not wipe what the user is halfway through typing. */
  const seededFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!open) {
      seededFor.current = null;
      return;
    }
    if (seededFor.current === loan.id) return;
    seededFor.current = loan.id;
    setForm(seedForm(detail));
    setError(null);
  }, [open, loan.id, detail]);

  const set =
    (key: keyof EditForm) =>
    (e: { target: { value: string } }): void =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const paymentInputs = React.useMemo<LoanPaymentInput[]>(
    () =>
      payments.map((payment) => ({
        amountMinor: payment.amountMinor,
        date: calendarDay(payment.date),
      })),
    [payments],
  );

  const principalMinor = minorOrNull(form.principal, currency);
  const interestMinor = form.interestType === 'FIXED' ? minorOrNull(form.interest, currency) : 0;
  /* Basis points, not money: 12.5% is 1250 whatever the books are kept in.
     `'BDT'` here means "×100", not "taka". */
  const interestRateBps = form.interestType === 'PERCENT' ? minorOrNull(form.rate, 'BDT') : 0;

  const dueBeforeLoan = Boolean(form.dueDate) && form.dueDate < form.loanDate;

  const preview = React.useMemo(() => {
    if (principalMinor === null || principalMinor <= 0) return null;
    if (interestMinor === null || interestRateBps === null) return null;
    if (!ISO_DATE.test(form.loanDate)) return null;
    if (form.dueDate && !ISO_DATE.test(form.dueDate)) return null;
    if (form.dueDate && form.dueDate < form.loanDate) return null;

    const terms: LoanTerms = {
      principalMinor,
      interestType: form.interestType,
      interestMinor,
      interestRateBps,
      loanDate: calendarDay(form.loanDate),
      dueDate: form.dueDate ? calendarDay(form.dueDate) : null,
    };
    return summariseLoan(terms, paymentInputs, calendarDay(toLocalDateString(new Date())));
  }, [
    principalMinor,
    interestMinor,
    interestRateBps,
    form.interestType,
    form.loanDate,
    form.dueDate,
    paymentInputs,
  ]);

  /* The 400 the API returns when the new terms are worth less than what has
   * already been repaid. Caught here so the sheet can refuse to send rather
   * than bouncing the user off the server, and worded the same either way. */
  const belowRepaid = preview !== null && preview.paidMinor > preview.totalPayableMinor;

  /* Editing a settled loan is allowed and often right — a note or a date can be
   * wrong on a finished loan. Raising what is payable on one, though, quietly
   * reopens it, and that is worth saying out loud before the save. */
  const reopens = preview !== null && loan.status === 'COMPLETED' && !preview.isSettled;
  const nextStatus = preview ? statusLabel(deriveLoanStatus(preview)) : '';

  const invalid = principalMinor === null || principalMinor <= 0 || preview === null || belowRepaid;

  const save = useMutation({
    mutationFn: () =>
      api(`/loans/${loan.id}`, {
        method: 'PATCH',
        body: {
          // Taka typed by a human becomes poisha here, truncated, never rounded.
          principalMinor: parseMoneyToMinor(form.principal || '0', currency),
          interestType: form.interestType,
          interestMinor:
            form.interestType === 'FIXED' ? parseMoneyToMinor(form.interest || '0', currency) : 0,
          // 825 basis points is "৮.২৫" — hundredths again, so the same parser.
          interestRateBps:
            /* Deliberately *not* the workspace currency. A rate is basis
               points — 12.5% is 1250 — and it is ×100 whatever money the books
               are kept in. Passing `currency` here would make a percentage on a
               yen workspace a hundredth of itself. */
            form.interestType === 'PERCENT' ? parseMoneyToMinor(form.rate || '0') : 0,
          loanDate: form.loanDate,
          // Explicit null is how the contract clears a due date; undefined keeps it.
          dueDate: form.dueDate || null,
          note: form.note.trim() || null,
          /* attachmentIds is deliberately absent. The contract treats a present
           * array as the complete new set, and there is no attachment picker on
           * these screens, so sending one could only ever mean "throw away the
           * files this loan already has". Omitting it leaves them alone. */
        },
      }),
    onSuccess: () => {
      haptic('success');
      invalidateLoanData(queryClient);
      onOpenChange(false);
      onSaved(
        reopens
          ? 'ঋণের তথ্য হালনাগাদ হয়েছে — পাওনা বাড়ায় ঋণটি আবার চালু হয়েছে'
          : 'ঋণের তথ্য হালনাগাদ হয়েছে',
      );
    },
    // The API's own sentence, never swapped for a generic failure: it names the
    // amount already repaid, which is the only thing that explains the refusal.
    onError: (err) => setError(err instanceof ApiError ? err.message : 'সংরক্ষণ করা যায়নি'),
  });

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="ঋণের তথ্য সম্পাদনা"
      description={`${loan.loanNumber} · ${person.name}`}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        {/* Not editable — said once, as a fact, rather than as three dead controls. */}
        <div className="bg-greenbar flex flex-col gap-1 rounded-xl p-3">
          <p className="text-ink text-sm">
            {person.name} · {directionLabel(loan.direction)}
          </p>
          <p className="text-ink-muted text-xs">
            ব্যক্তি, ধরন আর যে অ্যাকাউন্ট দিয়ে টাকাটা গিয়েছিল — এই তিনটি বদলানো যায় না, কারণ
            খাতায় লেনদেনটি এগুলো ধরেই বসে গেছে; বদলাতে হলে ঋণটি মুছে নতুন করে যোগ করুন।
          </p>
        </div>

        <Field label="মূল টাকা (৳)" htmlFor="le-principal">
          <Input
            id="le-principal"
            value={form.principal}
            onChange={set('principal')}
            inputMode="decimal"
            required
            className="money text-xl"
            placeholder="০.০০"
          />
        </Field>

        <Field label="সুদ" htmlFor="le-interest-type">
          <Select id="le-interest-type" value={form.interestType} onChange={set('interestType')}>
            {INTEREST_TYPES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>

        {form.interestType === 'FIXED' ? (
          <Field label="মোট সুদ (৳)" htmlFor="le-interest">
            <Input
              id="le-interest"
              value={form.interest}
              onChange={set('interest')}
              inputMode="decimal"
              className="money"
              placeholder="০.০০"
            />
          </Field>
        ) : null}

        {form.interestType === 'PERCENT' ? (
          <Field label="বার্ষিক হার (%)" htmlFor="le-rate">
            <Input
              id="le-rate"
              value={form.rate}
              onChange={set('rate')}
              inputMode="decimal"
              className="money"
              placeholder="যেমন: ৮.২৫"
            />
          </Field>
        ) : null}

        <Field label="তারিখ" htmlFor="le-date">
          <Input
            id="le-date"
            type="date"
            value={form.loanDate}
            onChange={set('loanDate')}
            required
          />
        </Field>

        <Field
          label="ফেরতের শেষ তারিখ"
          htmlFor="le-due"
          error={dueBeforeLoan ? 'ফেরতের তারিখ ঋণের তারিখের আগে হতে পারে না' : undefined}
        >
          <Input
            id="le-due"
            type="date"
            value={form.dueDate}
            min={form.loanDate}
            onChange={set('dueDate')}
          />
        </Field>

        <Field label="নোট" htmlFor="le-note">
          <Textarea id="le-note" value={form.note} onChange={set('note')} rows={2} />
        </Field>

        {/* What the change is worth, before it is made. */}
        {preview ? (
          <div className="border-rule flex flex-col gap-1 rounded-xl border border-dashed p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-ink-muted text-xs">নতুন মোট পাওনা</span>
              <Money minor={preview.totalPayableMinor} className="text-sm font-semibold" />
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-ink-muted text-xs">জমা পড়েছে</span>
              <Money minor={preview.paidMinor} className="text-income text-sm" />
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-ink-muted text-xs">তখন বাকি থাকবে</span>
              <Money minor={preview.outstandingMinor} className="text-sm font-semibold" />
            </div>
          </div>
        ) : null}

        {belowRepaid && preview ? (
          <p role="alert" className="text-expense text-sm">
            এই ঋণে ইতিমধ্যে <Money minor={preview.paidMinor} /> জমা পড়েছে — মোট পাওনা তার চেয়ে কম
            করা যাবে না।
          </p>
        ) : null}

        {reopens && preview ? (
          <p role="status" className="text-brass text-sm">
            এই ঋণ এখন সম্পন্ন। সংরক্ষণ করলে আবার <Money minor={preview.outstandingMinor} /> বাকি
            থাকবে এবং ঋণটি ‘{nextStatus}’ হয়ে যাবে।
          </p>
        ) : null}

        <p className="text-ink-muted text-xs">
          আসল টাকা বা ঋণের তারিখ বদলালে খাতার মূল লেনদেনটিও একই সাথে ঠিক হয়ে যাবে।
        </p>

        {error ? (
          <p role="alert" className="text-expense text-sm">
            {error}
          </p>
        ) : null}

        <Button type="submit" size="block" disabled={save.isPending || invalid || dueBeforeLoan}>
          সংরক্ষণ করুন
        </Button>
      </form>
    </Sheet>
  );
}
