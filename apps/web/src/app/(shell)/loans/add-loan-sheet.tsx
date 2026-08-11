'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { parseMoneyToMinor, toLocalDateString } from '@hishab/shared';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { api, ApiError, endpoints } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { useWorkspaceSettings } from '@/lib/workspace-settings';
import { DIRECTIONS, INTEREST_TYPES } from './labels';
import { fetchLoans, invalidateLoanData, loanKeys } from './queries';
import type { LoanDirection, LoanInterestType, LoanPerson } from './types';

const NEW_PERSON = '__new__';

/**
 * A new loan. The counterparty can be somebody already in the khata or a name
 * typed here — the API accepts either `personId` or `personName`.
 */
export function AddLoanSheet({
  open,
  onOpenChange,
  direction,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  direction: LoanDirection;
}) {
  const queryClient = useQueryClient();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });

  /* There is no /people endpoint in the contract, so the people already in the
     ledger come from the unfiltered loan list. */
  const everyLoan = useQuery({
    queryKey: loanKeys.list({}),
    queryFn: () => fetchLoans({}),
    enabled: open,
  });

  const people = React.useMemo(() => {
    const seen = new Map<string, LoanPerson>();
    for (const loan of everyLoan.data ?? []) {
      if (loan.personId && !seen.has(loan.personId)) {
        seen.set(loan.personId, {
          id: loan.personId,
          name: loan.personName,
          phone: loan.personPhone,
        });
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, 'bn'));
  }, [everyLoan.data]);

  const [form, setForm] = React.useState({
    direction: direction as LoanDirection,
    personId: NEW_PERSON,
    personName: '',
    personPhone: '',
    principal: '',
    interestType: 'NONE' as LoanInterestType,
    interest: '',
    rate: '',
    loanDate: toLocalDateString(new Date()),
    dueDate: '',
    accountId: '',
    note: '',
  });
  const [error, setError] = React.useState<string | null>(null);

  const set =
    (key: keyof typeof form) =>
    (e: { target: { value: string } }): void =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  // The tab the user was on decides which way the money went.
  React.useEffect(() => {
    if (open) setForm((f) => ({ ...f, direction }));
  }, [open, direction]);

  // Default to the first account rather than making the user pick one twice.
  const firstAccountId = (accounts.data ?? []).find((a) => !a.isArchived)?.id ?? '';
  React.useEffect(() => {
    if (firstAccountId) setForm((f) => (f.accountId ? f : { ...f, accountId: firstAccountId }));
  }, [firstAccountId]);

  /* The books' currency decides how many minor units a typed amount is worth — 100 for taka, 1 for yen, 1000 for a dinar. */
  const { currency } = useWorkspaceSettings();
  const save = useMutation({
    mutationFn: () =>
      api('/loans', {
        method: 'POST',
        body: {
          ...(form.personId === NEW_PERSON
            ? {
                personName: form.personName.trim(),
                personPhone: form.personPhone.trim() || undefined,
              }
            : { personId: form.personId }),
          direction: form.direction,
          // Taka typed by a human becomes poisha here, truncated, never rounded.
          principalMinor: parseMoneyToMinor(form.principal || '0', currency),
          interestType: form.interestType,
          interestMinor:
            form.interestType === 'FIXED' ? parseMoneyToMinor(form.interest || '0', currency) : 0,
          /* Basis points are hundredths of a percent, so the same parser: "৮.২৫"
             is 825. `Math.trunc(Number(x) * 100)` would look equivalent and is
             not — it reads 0.29 as 28, because 0.29 has no exact binary form. */
          interestRateBps:
            /* Deliberately *not* the workspace currency. A rate is basis
               points — 12.5% is 1250 — and it is ×100 whatever money the books
               are kept in. Passing `currency` here would make a percentage on a
               yen workspace a hundredth of itself. */
            form.interestType === 'PERCENT' ? parseMoneyToMinor(form.rate || '0') : 0,
          loanDate: form.loanDate,
          dueDate: form.dueDate || undefined,
          accountId: form.accountId,
          note: form.note.trim() || undefined,
        },
      }),
    onSuccess: () => {
      haptic('success');
      invalidateLoanData(queryClient);
      setForm((f) => ({
        ...f,
        personId: NEW_PERSON,
        personName: '',
        personPhone: '',
        principal: '',
        interest: '',
        rate: '',
        dueDate: '',
        note: '',
      }));
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'সংরক্ষণ করা যায়নি'),
  });

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="নতুন ধার-দেনা"
      description={
        form.direction === 'LENT' ? 'আমি কাউকে ধার দিয়েছি' : 'আমি কারও কাছ থেকে ধার নিয়েছি'
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
        <Field label="ধরন" htmlFor="ln-direction">
          <Select id="ln-direction" value={form.direction} onChange={set('direction')}>
            {DIRECTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="কার সাথে" htmlFor="ln-person">
          <Select id="ln-person" value={form.personId} onChange={set('personId')}>
            <option value={NEW_PERSON}>নতুন ব্যক্তি</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
                {person.phone ? ` · ${person.phone}` : ''}
              </option>
            ))}
          </Select>
        </Field>

        {form.personId === NEW_PERSON ? (
          <>
            <Field label="নাম" htmlFor="ln-person-name">
              <Input
                id="ln-person-name"
                value={form.personName}
                onChange={set('personName')}
                required
                placeholder="যেমন: রহিম উদ্দিন"
              />
            </Field>
            <Field label="মোবাইল নম্বর" htmlFor="ln-person-phone">
              <Input
                id="ln-person-phone"
                type="tel"
                inputMode="tel"
                value={form.personPhone}
                onChange={set('personPhone')}
                placeholder="০১৭…"
              />
            </Field>
          </>
        ) : null}

        <Field label="মূল টাকা (৳)" htmlFor="ln-principal">
          <Input
            id="ln-principal"
            value={form.principal}
            onChange={set('principal')}
            inputMode="decimal"
            required
            className="money text-xl"
            placeholder="০.০০"
          />
        </Field>

        <Field label="সুদ" htmlFor="ln-interest-type">
          <Select id="ln-interest-type" value={form.interestType} onChange={set('interestType')}>
            {INTEREST_TYPES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>

        {form.interestType === 'FIXED' ? (
          <Field label="মোট সুদ (৳)" htmlFor="ln-interest">
            <Input
              id="ln-interest"
              value={form.interest}
              onChange={set('interest')}
              inputMode="decimal"
              className="money"
              placeholder="০.০০"
            />
          </Field>
        ) : null}

        {form.interestType === 'PERCENT' ? (
          <Field label="বার্ষিক হার (%)" htmlFor="ln-rate">
            <Input
              id="ln-rate"
              value={form.rate}
              onChange={set('rate')}
              inputMode="decimal"
              className="money"
              placeholder="যেমন: ৮.২৫"
            />
          </Field>
        ) : null}

        <Field label="তারিখ" htmlFor="ln-date">
          <Input
            id="ln-date"
            type="date"
            value={form.loanDate}
            onChange={set('loanDate')}
            required
          />
        </Field>

        <Field label="ফেরতের শেষ তারিখ" htmlFor="ln-due">
          <Input
            id="ln-due"
            type="date"
            value={form.dueDate}
            min={form.loanDate}
            onChange={set('dueDate')}
          />
        </Field>

        <Field label="কোন অ্যাকাউন্ট থেকে" htmlFor="ln-account">
          <Select id="ln-account" value={form.accountId} onChange={set('accountId')} required>
            <option value="" disabled>
              অ্যাকাউন্ট বেছে নিন
            </option>
            {(accounts.data ?? [])
              .filter((account) => !account.isArchived)
              .map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
          </Select>
        </Field>

        <Field label="নোট" htmlFor="ln-note">
          <Textarea id="ln-note" value={form.note} onChange={set('note')} rows={2} />
        </Field>

        <p className="text-ink-muted text-xs">
          টাকাটা এই অ্যাকাউন্ট থেকেই যাবে বা আসবে — খাতায় লেনদেনটি নিজে থেকে বসে যাবে।
        </p>

        {error ? (
          <p role="alert" className="text-expense text-sm">
            {error}
          </p>
        ) : null}

        <Button type="submit" size="block" disabled={save.isPending || !form.accountId}>
          সংরক্ষণ করুন
        </Button>
      </form>
    </Sheet>
  );
}
