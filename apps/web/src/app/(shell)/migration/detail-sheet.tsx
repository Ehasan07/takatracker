'use client';

import { bpsFromPercent, type DetailKind, type MigrationDetail } from '@hishab/core';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import type { MigrationItem } from './types';

/**
 * The questions the other product could not answer.
 *
 * ## Why it opens per row and not per approval
 *
 * Only 28 rows out of 320 raise anything: nine credit cards, and the categories
 * that turn out to be savings plans or policies. Attaching a form to *approval*
 * would put 320 forms in front of somebody to collect 28 answers; attaching it
 * to *needing an answer* puts 28.
 *
 * And it is asked before anything is created, because a plan created with an
 * invented twelve-month term looks exactly like a plan whose term somebody
 * chose. There is no way to tell them apart afterwards, which is the whole
 * reason this is on the draft.
 *
 * ## Nothing here is required
 *
 * Somebody who does not know their DPS rate this morning should still be able
 * to finish. Blank means not known: the row keeps its "বাকি আছে" mark and the
 * entity is created with what is known. What is never done is filling a gap
 * with a plausible number.
 */

const TITLES: Record<DetailKind, string> = {
  CARD: 'কার্ডের বিলের তারিখ',
  SAVINGS: 'সঞ্চয়ের হিসাব',
  INSURANCE: 'বীমার হিসাব',
};

const BLURBS: Record<DetailKind, string> = {
  CARD: 'এগুলো না দিলে বিলের কোনো মনে করিয়ে দেওয়া যাবে না।',
  SAVINGS: 'কিস্তি ও মেয়াদ দিলে পুরো সূচি আর মেয়াদপূর্তির অঙ্ক নিজে থেকেই বেরোবে।',
  INSURANCE: 'প্রিমিয়াম দিলে কিস্তির সূচি তৈরি হবে।',
};

/** Taka as typed, to poisha, by integer maths — never `* 100` on a float. */
function toMinor(text: string): number | null {
  const clean = text.trim();
  if (!clean) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(clean)) return null;
  const [whole, fraction = ''] = clean.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

function fromMinor(minor: number | null | undefined): string {
  if (!minor) return '';
  return `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

const numberOrNull = (text: string): number | null => {
  const clean = text.trim();
  if (!clean) return null;
  const value = Number(clean);
  return Number.isFinite(value) ? Math.trunc(value) : null;
};

export function DetailSheet({
  item,
  open,
  saving,
  onClose,
  onSave,
}: {
  item: MigrationItem | null;
  open: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: (detail: MigrationDetail) => void;
}) {
  const kind = item?.needs ?? null;

  /* Built once, when the sheet mounts for a row.
   *
   * The page gives this a `key` of the row id, so choosing a different row
   * mounts a fresh component with fresh initial values. An effect that copied
   * the saved figures into state on every render of `item` would instead reset
   * the boxes under somebody's fingers each time the batch refetched — which it
   * does after every keystroke elsewhere on the page. */
  const [form, setForm] = React.useState<Record<string, string>>(() => {
    const d = item?.targetDetail ?? {};
    return {
      statementDay: d.statementDay ? String(d.statementDay) : '',
      dueDay: d.dueDay ? String(d.dueDay) : '',
      reminderLeadDays: d.reminderLeadDays == null ? '' : String(d.reminderLeadDays),
      installment: fromMinor(d.installmentMinor),
      principal: fromMinor(d.principalMinor),
      termMonths: d.termMonths ? String(d.termMonths) : '',
      /* Basis points back to the percentage the bank printed — a division by a
         hundred, which is exact for any rate anybody quotes. */
      ratePercent: d.profitRateBps ? String(d.profitRateBps / 100) : '',
      premium: fromMinor(d.premiumMinor),
      sumAssured: fromMinor(d.sumAssuredMinor),
      startDate: d.startDate ?? '',
    };
  });

  if (!item || !kind) return null;

  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = (): void => {
    onSave({
      statementDay: numberOrNull(form.statementDay ?? ''),
      dueDay: numberOrNull(form.dueDay ?? ''),
      reminderLeadDays: numberOrNull(form.reminderLeadDays ?? ''),
      installmentMinor: toMinor(form.installment ?? ''),
      principalMinor: toMinor(form.principal ?? ''),
      termMonths: numberOrNull(form.termMonths ?? ''),
      /* The percentage a bank prints, to basis points — 9.5 becomes 950, by
         integer maths on the string rather than a float multiplication. */
      profitRateBps: bpsFromPercent(form.ratePercent ?? '') ?? null,
      premiumMinor: toMinor(form.premium ?? ''),
      sumAssuredMinor: toMinor(form.sumAssured ?? ''),
      startDate: /^\d{4}-\d{2}-\d{2}$/.test(form.startDate ?? '') ? form.startDate : null,
    });
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={TITLES[kind]}
      description={item.sourceName}
    >
      <div className="flex flex-col gap-3">
        <p className="text-ink-muted text-sm">{BLURBS[kind]}</p>

        {kind === 'CARD' ? (
          <>
            <Field label="স্টেটমেন্ট কত তারিখে বন্ধ হয়" htmlFor="d-statement">
              <Input
                id="d-statement"
                inputMode="numeric"
                placeholder="১–৩১"
                value={form.statementDay ?? ''}
                onChange={set('statementDay')}
              />
            </Field>
            <Field label="বিল দেওয়ার শেষ তারিখ" htmlFor="d-due">
              <Input
                id="d-due"
                inputMode="numeric"
                placeholder="১–৩১"
                value={form.dueDay ?? ''}
                onChange={set('dueDay')}
              />
            </Field>
            <Field label="কত দিন আগে মনে করিয়ে দেব (ঐচ্ছিক)" htmlFor="d-lead">
              <Input
                id="d-lead"
                inputMode="numeric"
                placeholder="৩"
                value={form.reminderLeadDays ?? ''}
                onChange={set('reminderLeadDays')}
              />
            </Field>
            {/* The 31st in February is the 28th — said here rather than found
                out in a month with 30 days. */}
            <p className="text-ink-muted text-xs">
              মাস ছোট হলে তারিখটা ওই মাসের শেষ দিনে নেমে আসবে।
            </p>
          </>
        ) : null}

        {kind === 'SAVINGS' ? (
          <>
            <Field label="মাসিক কিস্তি (টাকা)" htmlFor="d-installment">
              <Input
                id="d-installment"
                inputMode="decimal"
                placeholder="১০০০০"
                value={form.installment ?? ''}
                onChange={set('installment')}
              />
            </Field>
            <Field label="এককালীন জমা — এফডিআর হলে (টাকা)" htmlFor="d-principal">
              <Input
                id="d-principal"
                inputMode="decimal"
                value={form.principal ?? ''}
                onChange={set('principal')}
              />
            </Field>
            <Field label="মেয়াদ (মাস)" htmlFor="d-term">
              <Input
                id="d-term"
                inputMode="numeric"
                placeholder="৬০"
                value={form.termMonths ?? ''}
                onChange={set('termMonths')}
              />
            </Field>
            <Field label="মুনাফার হার (%)" htmlFor="d-rate">
              <Input
                id="d-rate"
                inputMode="decimal"
                placeholder="৯.৫"
                value={form.ratePercent ?? ''}
                onChange={set('ratePercent')}
              />
            </Field>
            <Field label="শুরুর তারিখ" htmlFor="d-start">
              <Input
                id="d-start"
                type="date"
                value={form.startDate ?? ''}
                onChange={set('startDate')}
              />
            </Field>
          </>
        ) : null}

        {kind === 'INSURANCE' ? (
          <>
            <Field label="প্রিমিয়াম (টাকা)" htmlFor="d-premium">
              <Input
                id="d-premium"
                inputMode="decimal"
                value={form.premium ?? ''}
                onChange={set('premium')}
              />
            </Field>
            <Field label="বীমার অঙ্ক (টাকা)" htmlFor="d-sum">
              <Input
                id="d-sum"
                inputMode="decimal"
                value={form.sumAssured ?? ''}
                onChange={set('sumAssured')}
              />
            </Field>
            <Field label="মেয়াদ (মাস)" htmlFor="d-term-i">
              <Input
                id="d-term-i"
                inputMode="numeric"
                value={form.termMonths ?? ''}
                onChange={set('termMonths')}
              />
            </Field>
            <Field label="শুরুর তারিখ" htmlFor="d-start-i">
              <Input
                id="d-start-i"
                type="date"
                value={form.startDate ?? ''}
                onChange={set('startDate')}
              />
            </Field>
          </>
        ) : null}

        <div className="flex gap-2 pt-1">
          <Button onClick={submit} disabled={saving}>
            {saving ? 'রাখা হচ্ছে…' : 'রাখুন'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            থাক
          </Button>
        </div>

        {/* Said plainly, because the alternative is somebody inventing a rate to
            make a red mark go away. */}
        <p className="text-ink-muted text-xs">
          জানা না থাকলে খালি রাখুন — পরে বসানো যাবে। আন্দাজে কিছু লিখবেন না।
        </p>
      </div>
    </Sheet>
  );
}
