'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toAsciiDigits } from '@hishab/shared';
import * as React from 'react';
import { Field, Input, Select } from '@/components/ui/field';
import { ApiError } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { bnNum, periodLabel } from '../labels';
import { ActionSheet, Segmented } from '../parts';
import { isNotHere } from '../queries';
import {
  CATEGORY_OPTIONS,
  isSeededFeature,
  KIND_IS_FROZEN,
  KIND_OPTIONS,
  PERIOD_IS_FROZEN,
  SEEDED_FEATURE_HISTORY,
  kindHelp,
  kindLabel,
  NEW_FEATURE_DEFAULT,
  NO_FEATURE_DELETE,
  PERIOD_OPTIONS,
  UNIT_OPTIONS,
  unitLabel,
} from './labels';
import {
  createFeature,
  invalidatePlatformCaches,
  updateFeature,
  type FeatureInput,
} from './queries';
import { featureTitle, type AdminFeature, type LabelOrientation } from './types';

/**
 * Create a feature, or correct one.
 *
 * Two things this form deliberately cannot do:
 *
 *   the key      is the primary key and a foreign key from every `PlanFeature`
 *                and every `WorkspaceFeatureOverride` row. Renaming it would
 *                orphan both.
 *   the kind     is refused by the API, and is not offered here rather than
 *                offered and rejected. Every number already stored against this
 *                feature was written under the old reading of it: a `5` that
 *                means "five accounts" becomes "on" the moment the feature
 *                turns into a FLAG, and no migration can tell which packages
 *                meant which.
 *
 * The third thing worth saying out loud is what a *new* feature does, which is
 * nothing: it is off everywhere until a package prices it. An operator who
 * creates one and then goes looking for it in the product will not find it, and
 * the summary says so before they press the button rather than after.
 */
/* The server's own rules, mirrored: a key starts with a lower-case letter and
 * is split by dots or underscores — no hyphens — and sort order stops at ten
 * thousand. Approximating them here would turn a typo into a 400 describing a
 * regular expression. */
const KEY_PATTERN = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/;
const MAX_SORT_ORDER = 10_000;

export function FeatureSheet({
  mode,
  feature,
  features,
  orientation,
  open,
  onOpenChange,
  onGone,
}: {
  mode: 'create' | 'edit';
  feature: AdminFeature | null;
  /** The whole catalogue, for the key-collision check and the next sort order. */
  features: AdminFeature[];
  orientation: LabelOrientation;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGone: () => void;
}) {
  const queryClient = useQueryClient();

  const [key, setKey] = React.useState('');
  const [labelBn, setLabelBn] = React.useState('');
  const [labelEn, setLabelEn] = React.useState('');
  const [kind, setKind] = React.useState('LIMIT');
  const [unit, setUnit] = React.useState('count');
  const [period, setPeriod] = React.useState('LIFETIME');
  const [category, setCategory] = React.useState('core');
  const [sortOrder, setSortOrder] = React.useState('0');
  const [active, setActive] = React.useState<'active' | 'retired'>('active');
  const [error, setError] = React.useState<string | null>(null);

  /* Keyed on `open` alone, with the row read out of a ref: every admin write
   * invalidates `['admin']`, so a background refetch hands this component a new
   * `features` array, and an effect that depended on it would empty a
   * half-filled form for a reason the operator cannot see. */
  const latest = React.useRef({ mode, feature, features });
  latest.current = { mode, feature, features };

  React.useEffect(() => {
    if (!open) return;
    const { mode, feature, features } = latest.current;
    setError(null);
    if (mode === 'edit' && feature) {
      setKey(feature.key);
      setLabelBn(feature.labelBn);
      setLabelEn(feature.labelEn);
      setKind(feature.kind);
      setUnit(feature.unit);
      setPeriod(feature.period);
      setCategory(feature.category);
      setSortOrder(String(feature.sortOrder));
      setActive(feature.isActive ? 'active' : 'retired');
      return;
    }
    const highest = features.reduce((max, row) => (row.sortOrder > max ? row.sortOrder : max), 0);
    setKey('');
    setLabelBn('');
    setLabelEn('');
    setKind('LIMIT');
    setUnit('count');
    setPeriod('LIFETIME');
    setCategory('core');
    setSortOrder(String(Math.min(MAX_SORT_ORDER, highest + 10)));
    setActive('active');
  }, [open]);

  const trimmedKey = key.trim();
  const keyTaken = mode === 'create' && features.some((row) => row.key === trimmedKey);
  const keyValid =
    mode === 'edit' ||
    (KEY_PATTERN.test(trimmedKey) &&
      trimmedKey.length >= 2 &&
      trimmedKey.length <= 80 &&
      !keyTaken);

  const sortDigits = toAsciiDigits(sortOrder).trim();
  const sortValid = /^\d+$/.test(sortDigits) && Number(sortDigits) <= MAX_SORT_ORDER;

  const bnValid = labelBn.trim().length >= 1 && labelBn.trim().length <= 120;
  const unitValid = unit.trim() !== '' && unit.trim().length <= 40;
  const categoryValid = category.trim() !== '' && category.trim().length <= 40;

  const canSubmit = keyValid && bnValid && unitValid && categoryValid && sortValid;

  const input: FeatureInput = {
    key: trimmedKey,
    labelBn: labelBn.trim(),
    // The column is NOT NULL and English is the translation here, not the
    // source: an operator who leaves it blank gets the Bengali name in both,
    // which is a poor English label and never an empty one.
    labelEn: labelEn.trim() !== '' ? labelEn.trim() : labelBn.trim(),
    kind,
    unit: unit.trim(),
    period,
    category: category.trim(),
    sortOrder: sortValid ? Number(sortDigits) : 0,
    isActive: active === 'active',
  };

  const save = useMutation({
    mutationFn: () =>
      mode === 'create'
        ? createFeature(input, orientation)
        : updateFeature(feature?.key ?? trimmedKey, input, orientation),
    onSuccess: () => {
      haptic('success');
      invalidatePlatformCaches(queryClient);
      onOpenChange(false);
    },
    onError: (err) => {
      if (isNotHere(err)) {
        onGone();
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : mode === 'create'
            ? 'ফিচার তৈরি করা যায়নি'
            : 'ফিচার সংরক্ষণ করা যায়নি',
      );
    },
  });

  const changed =
    mode === 'create' ||
    !feature ||
    feature.labelBn !== input.labelBn ||
    feature.labelEn !== input.labelEn ||
    feature.unit !== input.unit ||
    feature.category !== input.category ||
    feature.sortOrder !== input.sortOrder ||
    feature.isActive !== input.isActive;

  return (
    <ActionSheet
      open={open}
      onOpenChange={onOpenChange}
      title={mode === 'create' ? 'নতুন ফিচার' : 'ফিচার সম্পাদনা'}
      description={mode === 'edit' && feature ? featureTitle(feature) : undefined}
      destructive={mode === 'edit' && feature?.isActive === true && active === 'retired'}
      canSubmit={canSubmit && changed}
      pending={save.isPending}
      error={error}
      confirmLabel={mode === 'create' ? 'ফিচার তৈরি করুন' : 'পরিবর্তন সংরক্ষণ করুন'}
      onConfirm={() => {
        setError(null);
        save.mutate();
      }}
      fields={
        <>
          {mode === 'create' ? (
            <Field
              label="কী (key)"
              htmlFor="ft-key"
              error={
                trimmedKey !== '' && keyTaken
                  ? 'এই কী-তে আগে থেকেই একটি ফিচার আছে।'
                  : trimmedKey !== '' && !KEY_PATTERN.test(trimmedKey)
                    ? 'ছোট হাতের ইংরেজি অক্ষর দিয়ে শুরু, ভাগ করুন . বা _ দিয়ে — যেমন reports.export.max।'
                    : undefined
              }
            >
              <Input
                id="ft-key"
                value={key}
                onChange={(e) => setKey(e.target.value.toLowerCase())}
                placeholder="যেমন reports.export.max"
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                required
              />
              <span className="text-ink-muted text-[11px]">
                কী পরে আর বদলানো যায় না — প্যাকেজ ও ওভাররাইডের সারিগুলো এটিকে ধরেই লেখা হয়।
              </span>
            </Field>
          ) : (
            <div className="bg-greenbar flex items-baseline justify-between gap-2 rounded-md p-3">
              <span className="text-ink-muted text-xs">কী</span>
              <span className="text-ink break-all text-sm font-medium">{feature?.key}</span>
            </div>
          )}

          <Field label="নাম (বাংলা)" htmlFor="ft-bn">
            <Input
              id="ft-bn"
              value={labelBn}
              onChange={(e) => setLabelBn(e.target.value)}
              placeholder="যেমন রপ্তানি"
              maxLength={120}
              required
            />
            <span className="text-ink-muted text-[11px]">
              গ্রাহক এটিই দেখেন — সীমা ছাড়ানোর বার্তায় ও দামের তালিকায়।
            </span>
          </Field>

          <Field label="নাম (ইংরেজি, ঐচ্ছিক)" htmlFor="ft-en">
            <Input
              id="ft-en"
              value={labelEn}
              onChange={(e) => setLabelEn(e.target.value)}
              placeholder="Export"
              maxLength={120}
            />
            <span className="text-ink-muted text-[11px]">
              অপারেটরের পর্দা ও লগে ব্যবহার হয়। ফাঁকা রাখলে বাংলা নামটিই বসবে।
            </span>
          </Field>

          {mode === 'create' ? (
            <div className="flex flex-col gap-1.5">
              <Segmented label="ধরন" value={kind} options={KIND_OPTIONS} onChange={setKind} />
              <span className="text-ink-muted text-[11px]">{kindHelp(kind)}</span>
              <span className="text-brass text-[11px]">একবার তৈরি হলে ধরন আর বদলানো যায় না।</span>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <div className="bg-greenbar flex items-baseline justify-between gap-2 rounded-md p-3">
                <span className="text-ink-muted text-xs">ধরন</span>
                <span className="text-ink text-sm font-medium">{kindLabel(kind)}</span>
              </div>
              <span className="text-ink-muted text-[11px]">{KIND_IS_FROZEN}</span>
            </div>
          )}

          <ChoiceOrText
            id="ft-unit"
            label="একক"
            value={unit}
            options={UNIT_OPTIONS}
            onChange={setUnit}
            placeholder="যেমন seats"
            help="সংখ্যার পাশে যা লেখা হবে। ক্যাটালগে না থাকা একক লিখলে সেটি সরল সংখ্যা হিসেবেই দেখানো হবে।"
          />

          {mode === 'create' ? (
            <Field label="সময়কাল" htmlFor="ft-period">
              <Select id="ft-period" value={period} onChange={(e) => setPeriod(e.target.value)}>
                {PERIOD_OPTIONS.map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </Select>
              <span className="text-ink-muted text-[11px]">
                কেবল কোটার ক্ষেত্রে কাজে লাগে — মিটার কোন বালতিতে গোনা হবে। সীমা ও চালু/বন্ধের
                বেলায় এটি উপেক্ষা করা হয়। ধরনের মতো এটিও পরে বদলানো যায় না।
              </span>
            </Field>
          ) : (
            <div className="flex flex-col gap-1.5">
              <div className="bg-greenbar flex items-baseline justify-between gap-2 rounded-md p-3">
                <span className="text-ink-muted text-xs">সময়কাল</span>
                <span className="text-ink text-sm font-medium">{periodLabel(period)}</span>
              </div>
              <span className="text-ink-muted text-[11px]">{PERIOD_IS_FROZEN}</span>
            </div>
          )}

          <ChoiceOrText
            id="ft-category"
            label="বিভাগ"
            value={category}
            options={CATEGORY_OPTIONS}
            onChange={setCategory}
            placeholder="যেমন billing"
            help="অপারেটরের পর্দায় ফিচারগুলো এই ভাগে সাজানো হয়।"
          />

          <Field
            label="ক্রম"
            htmlFor="ft-sort"
            error={!sortValid ? `০ থেকে ${bnNum(MAX_SORT_ORDER)} পর্যন্ত পূর্ণসংখ্যা।` : undefined}
          >
            <Input
              id="ft-sort"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
              inputMode="numeric"
              className="money"
              required
            />
          </Field>

          {mode === 'edit' && feature && isSeededFeature(feature.key) ? (
            <p className="rounded-card border-rule bg-greenbar text-ink-muted border p-3 text-[11px]">
              {SEEDED_FEATURE_HISTORY}
            </p>
          ) : null}

          {mode === 'edit' ? (
            <div className="flex flex-col gap-1.5">
              <Segmented
                label="অবস্থা"
                value={active}
                options={
                  [
                    ['active', 'চালু'],
                    ['retired', 'অবসরে'],
                  ] as const
                }
                onChange={setActive}
              />
              <span className="text-ink-muted text-[11px]">{NO_FEATURE_DELETE}</span>
            </div>
          ) : null}

          {mode === 'create' ? (
            <p className="rounded-card border-brass/40 bg-brass/10 text-ink border p-3 text-xs">
              {NEW_FEATURE_DEFAULT}
            </p>
          ) : null}
        </>
      }
      summary={
        mode === 'create' ? (
          <>
            <p>
              <span className="break-all font-medium">{trimmedKey}</span> কী-তে{' '}
              <span className="font-medium">{input.labelBn}</span> নামে একটি ফিচার তৈরি হবে — ধরন{' '}
              <span className="font-medium">{kindLabel(input.kind)}</span>, একক{' '}
              {unitLabel(input.unit)}।
            </p>
            <p className="mt-1">{NEW_FEATURE_DEFAULT}</p>
            <p className="mt-1">
              কী ও ধরন — দুটোর কোনোটিই পরে বদলানো যাবে না। ধরন বদলালে জমা থাকা প্রতিটি সংখ্যার মানে
              বদলে যেত।
            </p>
          </>
        ) : (
          <>
            <p>
              <span className="font-medium">{feature ? featureTitle(feature) : ''}</span> (
              <span className="break-all">{feature?.key}</span>) বদলাবে।
            </p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {feature && feature.labelBn !== input.labelBn ? (
                <li>
                  বাংলা নাম: {feature.labelBn || '—'} →{' '}
                  <span className="font-medium">{input.labelBn}</span>
                </li>
              ) : null}
              {feature && feature.labelEn !== input.labelEn ? (
                <li>
                  ইংরেজি নাম: {feature.labelEn || '—'} →{' '}
                  <span className="font-medium">{input.labelEn}</span>
                </li>
              ) : null}
              {feature && feature.unit !== input.unit ? (
                <li>
                  একক: {unitLabel(feature.unit)} →{' '}
                  <span className="font-medium">{unitLabel(input.unit)}</span>
                </li>
              ) : null}
              {feature && feature.category !== input.category ? (
                <li>
                  বিভাগ: {feature.category} → <span className="font-medium">{input.category}</span>
                </li>
              ) : null}
              {feature && feature.sortOrder !== input.sortOrder ? (
                <li>
                  ক্রম: {bnNum(feature.sortOrder)} →{' '}
                  <span className="font-medium">{bnNum(input.sortOrder)}</span>
                </li>
              ) : null}
            </ul>
            {feature && feature.isActive && !input.isActive ? (
              <>
                <p className="mt-1 font-medium">
                  ফিচারটি অবসরে যাবে: নতুন কোনো প্যাকেজে আর যোগ করা যাবে না। যেসব প্যাকেজ ও
                  ওভাররাইডে এটি আগে থেকে আছে সেখানে যেমন আছে তেমনই কাজ করে যাবে — কারও সীমা বদলাবে
                  না।
                </p>
                <p className="mt-1">
                  {feature.grantedByPlans.length === 0
                    ? 'এখন কোনো প্যাকেজে এটির দাম বসানো নেই।'
                    : `এই প্যাকেজগুলো এটি ধরে রাখবে: ${feature.grantedByPlans
                        .map((grant) => grant.code)
                        .join(', ')}।`}
                </p>
              </>
            ) : null}
            {feature && !feature.isActive && input.isActive ? (
              <p className="mt-1">ফিচারটি আবার চালু হবে — নতুন প্যাকেজে এটির দাম বসানো যাবে।</p>
            ) : null}
            <p className="mt-1">ধরন ও সময়কাল বদলায়নি — এপিআই সে দুটি বদলাতে দেয় না।</p>
          </>
        )
      }
    />
  );
}

/**
 * A picker for a column that is a plain string in the database.
 *
 * `unit` and `category` are `String`, not enums, precisely so a feature
 * invented this afternoon can carry a unit this build has never heard of — so
 * the form offers the known ones and a way past them. The escape hatch is not
 * decoration: without it, every new kind of feature would need a web deploy,
 * which is the exact thing making the catalogue data was meant to end.
 */
function ChoiceOrText({
  id,
  label,
  value,
  options,
  onChange,
  placeholder,
  help,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
  placeholder: string;
  help?: string;
}) {
  const known = options.some(([option]) => option === value);
  const [free, setFree] = React.useState(!known);
  const typing = free || !known;

  return (
    <Field label={label} htmlFor={id}>
      <Select
        id={id}
        value={typing ? '__other' : value}
        onChange={(e) => {
          if (e.target.value === '__other') {
            setFree(true);
            onChange('');
          } else {
            setFree(false);
            onChange(e.target.value);
          }
        }}
      >
        {options.map(([option, text]) => (
          <option key={option} value={option}>
            {text}
          </option>
        ))}
        <option value="__other">অন্য…</option>
      </Select>
      {typing ? (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          aria-label={`${label} — নিজে লিখুন`}
          maxLength={40}
        />
      ) : null}
      {help ? <span className="text-ink-muted text-[11px]">{help}</span> : null}
    </Field>
  );
}
