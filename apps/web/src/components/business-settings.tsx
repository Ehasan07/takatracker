'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Briefcase } from '@/components/icons';
import Link from 'next/link';
import * as React from 'react';
import { StandardNote } from '@/components/info-note';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { t } from '@/lib/t';

/**
 * A personal business, kept inside a household's books — off unless asked for.
 *
 * ## Why it is a switch and not simply there
 *
 * Most households have no shop and no BO account, and for them the whole
 * apparatus is clutter: eighteen extra categories in every picker, an inventory
 * account, a month-end stock count, a second profit-and-loss beside the one
 * they wanted. An app that shows everybody everything reads as something you
 * have to learn before you can write down what you spent on rice.
 *
 * So it is opt-in, and the copy says what turning it on gets you rather than
 * naming a feature. Nobody switches on "segment reporting"; somebody who runs a
 * shop switches on "আমার একটা ব্যবসা আছে".
 *
 * ## Why the rules are here rather than only on the report
 *
 * This is the screen where somebody decides they are going to keep a business
 * in here, which is the moment before they start recording things wrongly. The
 * three ⓘ notes carry the rules that decide whether the books mean anything —
 * a share purchase is not an expense, capital and drawings are not income,
 * stock is an asset until it sells — each with the standard it rests on, so
 * somebody who wants to check can. The full six-step method lives on the
 * report itself, where it is read at the moment of doing.
 */

interface Settings {
  businessEnabled: boolean;
}

export function BusinessSettings() {
  const queryClient = useQueryClient();

  const settings = useQuery({
    queryKey: ['workspace', 'settings'],
    queryFn: () => api<Settings>('/workspace/settings'),
    staleTime: 60_000,
  });

  const save = useMutation({
    mutationFn: (businessEnabled: boolean) =>
      api<Settings>('/workspace/settings', { method: 'PATCH', body: { businessEnabled } }),
    onSuccess: () => {
      haptic('tap');
      void queryClient.invalidateQueries({ queryKey: ['workspace', 'settings'] });
    },
  });

  const on = settings.data?.businessEnabled ?? false;

  return (
    <section className="rounded-card border-rule bg-surface border p-4">
      <h2 className="text-ink-muted flex items-center gap-2 text-sm font-medium">
        <Briefcase className="text-brand h-4 w-4" aria-hidden />
        {t('business.title', 'ব্যক্তিগত ব্যবসা বা শেয়ার ট্রেডিং')}
      </h2>

      <p className="text-ink-muted mt-1 text-sm">
        {t(
          'business.blurb',
          'দোকান, ছোট ব্যবসা বা শেয়ার-বিনিয়োগ থাকলে চালু করুন। নিজের ব্যাংক-বিকাশ দিয়েই ব্যবসা চললে ব্যবসার আয়-খরচ আলাদা করে দেখা যাবে — দিন শেষে লাভ না লোকসান।',
        )}
      </p>

      <p className="text-ink-muted mt-2 text-xs">
        {t(
          'business.cost',
          'চালু করলে ব্যবসার জন্য আলাদা খাত, মাস শেষে মজুদ গণনার পর্দা আর একটা আলাদা লাভ-লোকসান হিসাব যোগ হবে। ব্যবসা না থাকলে বন্ধ রাখাই ভালো — না হলে খাতের তালিকা অকারণে বড় হবে।',
        )}
      </p>

      {/* The rules, before anybody starts recording things wrongly. Each note
          carries the standard it rests on; the parent is the flex-wrap row
          `InfoNote` documents. */}
      <div className="mt-3">
        <p className="text-ink-muted text-xs font-medium">
          {t('business.rules', 'কীভাবে রাখতে হয়, আর কীভাবে রাখতে নেই')}
        </p>
        <div className="mt-1 flex flex-col gap-1">
          <RuleLine
            label={t('business.rule1', 'শেয়ার কেনা খরচ নয় — সম্পদ')}
            note="note.investmentNotExpense"
          />
          <RuleLine
            label={t('business.rule2', 'মূলধন দেওয়া বা টাকা তোলা আয়-খরচ নয় — ট্রান্সফার')}
            note="note.ownerCapital"
          />
          <RuleLine
            label={t('business.rule3', 'দোকানের মাল বিক্রি হওয়ার আগে খরচ নয় — মজুদ')}
            note="note.stockNotExpense"
          />
          <RuleLine
            label={t('business.rule4', 'ব্যবসা আর সংসার আলাদা — ট্যাগ দিয়ে')}
            note="note.segmentBooks"
          />
        </div>
      </div>

      <Button
        variant="outline"
        className="mt-3"
        disabled={save.isPending || settings.isLoading}
        aria-pressed={on}
        onClick={() => save.mutate(!on)}
      >
        {on ? t('business.turnOff', 'বন্ধ করুন') : t('business.turnOn', 'চালু করুন')}
      </Button>

      {on ? (
        <p className="text-ink-muted mt-2 text-xs">
          {t('business.onNow', 'চালু আছে। রিপোর্ট পাতায় “ব্যক্তিগত ব্যবসার হিসাব” পাবেন — ')}
          <Link href="/reports/segment" className="text-brand underline">
            {t('business.open', 'এখনই খুলুন')}
          </Link>
        </p>
      ) : null}
    </section>
  );
}

/**
 * One rule, with its ⓘ.
 *
 * The sentence is the rule in plain Bengali and is readable without pressing
 * anything; the note behind the icon is why, and under which standard. A page
 * that put four icons in a row and the sentences nowhere would be four controls
 * that all look the same.
 */
function RuleLine({ label, note }: { label: string; note: string }) {
  return (
    <div className="text-ink-muted flex flex-wrap items-baseline gap-x-1.5 text-xs">
      <span aria-hidden>·</span>
      <span>{label}</span>
      <StandardNote noteKey={note} />
    </div>
  );
}
