'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toAsciiDigits } from '@hishab/shared';
import * as React from 'react';
import { Field, Input, Textarea } from '@/components/ui/field';
import { ApiError } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { bnCount, bnDateTime, featureName, limitText, unitSuffix, UNMEASURED } from '../../labels';
import { ActionSheet, Segmented } from '../../parts';
import { invalidateAdminData, setFeatureOverride, type OverrideBody } from '../../queries';
import type { TenantDetail, TenantFeature, TenantOverride } from '../../types';

/**
 * Four things an operator can do to one ceiling, and they are four because
 * three of them are indistinguishable if you try to express them as a number.
 *
 *   সীমাহীন   `limitValue: null`  — unlimited
 *   বন্ধ       `limitValue: 0`     — switched off
 *   নির্দিষ্ট  `limitValue: n`     — a ceiling
 *   সরান       `action: 'clear'`   — no override at all; the plan decides again
 *
 * The API keeps `set` and `clear` as separate arms of a discriminated union for
 * exactly this reason: `null` already means unlimited everywhere in the
 * entitlement code, so "give them unlimited transactions" and "take the grant
 * away" would otherwise be the same request body doing opposite things. This
 * form keeps them separate too.
 */
type Mode = 'limited' | 'unlimited' | 'off' | 'clear';

const MAX_LIMIT = 1_000_000_000;

/** Local wall-clock, in the shape `<input type="datetime-local">` wants. */
function toLocalInput(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function OverrideSheet({
  tenant,
  feature,
  override,
  open,
  onOpenChange,
}: {
  tenant: TenantDetail;
  feature: TenantFeature | null;
  override: TenantOverride | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = React.useState<Mode>('limited');
  const [typed, setTyped] = React.useState('');
  const [expiresLocal, setExpiresLocal] = React.useState('');
  const [note, setNote] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  /* Reopened on a different feature: start from what that feature has now
   * rather than from whatever the last one was left on. */
  React.useEffect(() => {
    if (!open || !feature) return;
    setError(null);
    setNote('');
    const live = override && !override.expired ? override : null;
    if (live) {
      setMode(live.limitValue === null ? 'unlimited' : live.limitValue === 0 ? 'off' : 'limited');
      setTyped(live.limitValue !== null && live.limitValue > 0 ? String(live.limitValue) : '');
      setExpiresLocal(live.expiresAt ? toLocalInput(new Date(live.expiresAt)) : '');
    } else {
      setMode('limited');
      setTyped(
        feature.planLimit !== null && feature.planLimit > 0 ? String(feature.planLimit) : '',
      );
      setExpiresLocal('');
    }
  }, [open, feature, override]);

  const digits = toAsciiDigits(typed).trim();
  const parsed = /^\d+$/.test(digits) ? Number(digits) : null;
  const numberValid = parsed !== null && parsed >= 0 && parsed <= MAX_LIMIT;

  /* `datetime-local` gives a wall-clock with no zone; `new Date()` reads it in
   * this device's timezone, which is the one the operator typed it in. The API
   * wants a full ISO instant and refuses anything already past. */
  const expiresDate = expiresLocal ? new Date(expiresLocal) : null;
  const expiresValid =
    expiresDate === null ||
    (!Number.isNaN(expiresDate.getTime()) && expiresDate.getTime() > Date.now());
  const expiresAt = expiresDate && expiresValid ? expiresDate.toISOString() : null;

  const noteValid = note.trim().length >= 3;
  const canSubmit =
    feature !== null &&
    noteValid &&
    (mode === 'clear' ? override !== null : expiresValid && (mode !== 'limited' || numberValid));

  const nextLimit: number | null = mode === 'unlimited' ? null : mode === 'off' ? 0 : (parsed ?? 0);

  const save = useMutation({
    mutationFn: () => {
      if (!feature) throw new Error('no feature');
      const body: OverrideBody =
        mode === 'clear'
          ? { action: 'clear', note: note.trim() }
          : {
              action: 'set',
              limitValue: nextLimit,
              /* `null` and not an empty string. `expiresAt: ''` is preprocessed
               * to undefined server-side, but sending the intent plainly is
               * cheaper to read than relying on that. */
              expiresAt,
              note: note.trim(),
            };
      return setFeatureOverride(tenant.id, feature.key, body);
    },
    onSuccess: () => {
      haptic('success');
      invalidateAdminData(queryClient);
      onOpenChange(false);
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'ওভাররাইড সংরক্ষণ করা যায়নি'),
  });

  if (!feature) return null;

  const name = featureName(feature);
  const options: readonly (readonly [Mode, string])[] = override
    ? ([
        ['limited', 'নির্দিষ্ট'],
        ['unlimited', 'সীমাহীন'],
        ['off', 'বন্ধ'],
        ['clear', 'সরান'],
      ] as const)
    : ([
        ['limited', 'নির্দিষ্ট'],
        ['unlimited', 'সীমাহীন'],
        ['off', 'বন্ধ'],
      ] as const);

  return (
    <ActionSheet
      open={open}
      onOpenChange={onOpenChange}
      title="সীমা ওভাররাইড"
      description={`${name} — ${tenant.name}`}
      destructive
      canSubmit={canSubmit}
      pending={save.isPending}
      error={error}
      confirmLabel={mode === 'clear' ? 'ওভাররাইড সরান' : 'ওভাররাইড বসান'}
      onConfirm={() => {
        setError(null);
        save.mutate();
      }}
      fields={
        <>
          <dl className="bg-greenbar flex flex-col gap-1.5 rounded-md p-3 text-xs">
            <Row
              label="প্ল্যান যা দেয়"
              value={limitText(feature.planLimit, feature.kind, feature.unit)}
            />
            <Row
              label="এখন কার্যকর"
              value={limitText(feature.effectiveLimit, feature.kind, feature.unit)}
            />
            <Row
              label="ব্যবহার"
              value={
                feature.used === null
                  ? UNMEASURED
                  : `${bnCount(feature.used)}${unitSuffix(feature.unit)}`
              }
            />
            {override ? (
              <Row
                label={override.expired ? 'আগের ওভাররাইড (মেয়াদোত্তীর্ণ)' : 'চালু ওভাররাইড'}
                value={limitText(override.limitValue, feature.kind, feature.unit)}
              />
            ) : null}
          </dl>

          <Segmented label="নতুন সীমা" value={mode} options={options} onChange={setMode} />

          {mode === 'limited' ? (
            <Field
              label={`সর্বোচ্চ কত${unitSuffix(feature.unit)}`}
              htmlFor="ov-limit"
              error={
                typed !== '' && !numberValid
                  ? `শূন্য থেকে ${bnCount(MAX_LIMIT)} পর্যন্ত একটি পূর্ণসংখ্যা লিখুন।`
                  : undefined
              }
            >
              <Input
                id="ov-limit"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                inputMode="numeric"
                className="money text-lg"
                placeholder="০"
                required
              />
            </Field>
          ) : null}

          {mode === 'clear' ? null : (
            <Field
              label="মেয়াদ শেষ (ঐচ্ছিক)"
              htmlFor="ov-expires"
              error={!expiresValid ? 'সময়টি ভবিষ্যতে হতে হবে।' : undefined}
            >
              <Input
                id="ov-expires"
                type="datetime-local"
                value={expiresLocal}
                min={toLocalInput(new Date(Date.now() + 60_000))}
                onChange={(e) => setExpiresLocal(e.target.value)}
              />
              <span className="text-ink-muted text-[11px]">
                আপনার ডিভাইসের সময় অনুযায়ী। ফাঁকা রাখলে ওভাররাইডটি নিজে থেকে শেষ হবে না।
              </span>
            </Field>
          )}

          {/* Required on both arms, by the server and by this form. An override
              is an off-books promise to one customer; in six months the only
              person who can explain it is whoever reads this note. */}
          <Field
            label="কেন"
            htmlFor="ov-note"
            error={note.length > 0 && !noteValid ? 'অন্তত তিনটি অক্ষর লিখুন।' : undefined}
          >
            <Textarea
              id="ov-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              minLength={3}
              maxLength={500}
              required
              placeholder="কার সিদ্ধান্তে, কোন টিকিটে, কত দিনের জন্য"
            />
          </Field>
        </>
      }
      summary={
        mode === 'clear' ? (
          <>
            <p>
              <span className="font-medium">{tenant.name}</span>-এর{' '}
              <span className="font-medium">{name}</span> ওভাররাইডটি মুছে যাবে।
            </p>
            <p className="mt-1">
              সীমা ফিরে যাবে প্ল্যানের নিজের মানে:{' '}
              <span className="font-medium">
                {limitText(feature.planLimit, feature.kind, feature.unit)}
              </span>
              । এখনকার কার্যকর সীমা {limitText(feature.effectiveLimit, feature.kind, feature.unit)}।
            </p>
            <p className="mt-1">নোট: {note.trim()}</p>
          </>
        ) : (
          <>
            <p>
              <span className="font-medium">{tenant.name}</span>-এর{' '}
              <span className="font-medium">{name}</span> সীমা{' '}
              <span className="font-medium">
                {limitText(feature.effectiveLimit, feature.kind, feature.unit)}
              </span>{' '}
              থেকে{' '}
              <span className="font-medium">
                {limitText(nextLimit, feature.kind, feature.unit)}
              </span>{' '}
              হবে।
            </p>
            {feature.used !== null &&
            nextLimit !== null &&
            nextLimit > 0 &&
            feature.used > nextLimit ? (
              <p className="text-expense mt-1 font-medium">
                সতর্কতা: এখনই ব্যবহার {bnCount(feature.used)}
                {unitSuffix(feature.unit)} — নতুন সীমার চেয়ে বেশি। পরের কাজেই তারা আটকে যাবেন।
              </p>
            ) : null}
            <p className="mt-1">
              {expiresAt
                ? `${bnDateTime(expiresAt)}-এ নিজে থেকেই শেষ হবে, তারপর প্ল্যানের সীমা ফিরে আসবে।`
                : 'কোনো মেয়াদ নেই — হাতে না সরালে এটি থেকেই যাবে।'}
            </p>
            <p className="mt-1">এটি প্ল্যানের উপরে বসে, তাই প্ল্যান বদলালেও থেকে যাবে।</p>
            <p className="mt-1">নোট: {note.trim()}</p>
          </>
        )
      }
    />
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2">
      <dt className="text-ink-muted min-w-0 truncate">{label}</dt>
      <dd className="text-ink shrink-0 font-medium">{value}</dd>
    </div>
  );
}
