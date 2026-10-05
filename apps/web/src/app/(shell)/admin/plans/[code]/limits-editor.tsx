'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toAsciiDigits } from '@hishab/shared';
import { ListChecks, RotateCw, TriangleAlert } from '@/components/icons';
import * as React from 'react';
import { SkeletonCard } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { ApiError } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import {
  fetchAdminCatalogue,
  featureCatalogueKeys,
  invalidatePlatformCaches,
} from '../../features/queries';
import { kindLabel } from '../../features/labels';
import { featureTitle, type AdminFeature } from '../../features/types';
import { bnCount, bnNum, categoryLabel, periodLabel, unitSuffix } from '../../labels';
import { QueryError } from '../../parts';
import { isNotHere } from '../../queries';
import {
  APPLIES_NEXT_REQUEST,
  NOT_PRICED_MEANS,
  OVER_LIMIT_MEANS,
  OVERRIDES_NOT_COUNTED,
  planLimitText,
  SWEEP_TRUNCATED,
  UNMEASURED_CUT,
} from '../labels';
import {
  Danger,
  LimitStateChips,
  limitStateOf,
  limitStateOptions,
  Note,
  PlanLimitValue,
  type LimitState,
} from '../parts';
import { dryRunPlanFeatures, limitBodyOf, putPlanFeatures } from '../queries';
import { limitMapOf, type AdminPlan, type DryRunResult } from '../types';

const MAX_LIMIT = 1_000_000_000;

/** What one row's control is currently saying. `text` only matters for `fixed`. */
interface Draft {
  state: LimitState;
  text: string;
}

/** A ceiling that is present, absent, or being typed wrong. */
type Resolved = { ok: true; value: number | null | undefined } | { ok: false };

function resolve(draft: Draft): Resolved {
  switch (draft.state) {
    case 'unset':
      return { ok: true, value: undefined };
    case 'unlimited':
      return { ok: true, value: null };
    case 'off':
      return { ok: true, value: 0 };
    case 'on':
      return { ok: true, value: 1 };
    case 'fixed': {
      const digits = toAsciiDigits(draft.text).trim();
      if (!/^\d+$/.test(digits)) return { ok: false };
      const n = Number(digits);
      if (!Number.isFinite(n) || n > MAX_LIMIT) return { ok: false };
      return { ok: true, value: n };
    }
  }
}

interface Change {
  key: string;
  feature: AdminFeature;
  before: number | null | undefined;
  after: number | null | undefined;
}

/**
 * Is this change a cut?
 *
 * Only the unambiguous ones are claimed. Unlimited to anything is a cut, a
 * smaller number is a cut, and switching a feature off is a cut. Everything
 * else — in particular removing a row, whose effect depends on what the
 * fallback package says — is left to the dry run, which can count rather than
 * reason.
 */
function isCut(change: Change): boolean {
  const { before, after } = change;
  if (before === undefined || after === undefined) return false;
  if (before === null) return true; // unlimited → any ceiling
  if (after === null) return false; // any ceiling → unlimited
  return after < before;
}

/**
 * The limits table.
 *
 * ## Why the save is two presses
 *
 * Lowering a ceiling is the one edit on this screen that can hurt somebody who
 * is not in the room. So the first press does not save: it asks the API the
 * same question with `dryRun: true` and comes back with how many workspaces
 * would already be over each new limit. The operator then presses again, or
 * does not. Repricing is legitimate — this never refuses — but it is never done
 * blind.
 *
 * The review step is drawn in the page rather than in an `ActionSheet` because
 * the sheet's two steps are synchronous by construction: it flips to its
 * summary the instant the form submits, and there is nowhere in it to put a
 * request that has to come back first. Everything else about the pattern is the
 * same — read back what is about to happen, in numbers, then agree to it.
 *
 * ## Why the whole map is sent
 *
 * `PUT .../features` replaces the map. That is what makes "not priced" sayable
 * at all: a key left out is a feature this package stops pricing, which is a
 * different outcome from setting it to zero. A patch-shaped request could not
 * express it.
 */
export function LimitsEditor({ plan, onGone }: { plan: AdminPlan; onGone: () => void }) {
  const queryClient = useQueryClient();
  const catalogue = useQuery({
    queryKey: featureCatalogueKeys.list(),
    queryFn: fetchAdminCatalogue,
    staleTime: 60_000,
  });

  const [edits, setEdits] = React.useState<Map<string, Draft>>(new Map());
  const [review, setReview] = React.useState<DryRunResult | null>(null);
  const [reviewing, setReviewing] = React.useState(false);
  const [dryRunError, setDryRunError] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const base = React.useMemo(() => limitMapOf(plan), [plan]);

  /* Every feature the operator may price: the live catalogue, plus anything
   * this package already prices — a retired feature, or a key from a database
   * this build has never met. A retired feature is not offered to a package
   * that does not already sell it, which is what retiring one means. */
  const rows = React.useMemo(() => {
    const known = new Map((catalogue.data?.items ?? []).map((f) => [f.key, f]));
    const list: AdminFeature[] = [];

    for (const feature of catalogue.data?.items ?? []) {
      if (feature.isActive || base.has(feature.key)) list.push(feature);
    }
    for (const row of plan.limits) {
      if (known.has(row.key)) continue;
      list.push({
        key: row.key,
        labelBn: '',
        labelEn: '',
        kind: 'LIMIT',
        unit: 'count',
        period: 'LIFETIME',
        category: '__unknown',
        isActive: false,
        sortOrder: 0,
        grantedByPlans: [],
      });
    }
    return list;
  }, [catalogue.data, plan.limits, base]);

  const draftFor = React.useCallback(
    (feature: AdminFeature): Draft => {
      const edited = edits.get(feature.key);
      if (edited) return edited;
      const value = base.has(feature.key) ? (base.get(feature.key) ?? null) : undefined;
      return {
        state: limitStateOf(feature.kind, value),
        text: typeof value === 'number' && value > 0 ? String(value) : '',
      };
    },
    [edits, base],
  );

  const setDraft = (key: string, next: Draft): void => {
    setEdits((current) => {
      const copy = new Map(current);
      copy.set(key, next);
      return copy;
    });
    // Any edit invalidates a review that was computed from the previous map.
    setReview(null);
    setDryRunError(null);
    setSaveError(null);
  };

  const { changes, invalid, nextMap } = React.useMemo(() => {
    const next = new Map(base);
    const list: Change[] = [];
    const bad: AdminFeature[] = [];

    for (const feature of rows) {
      const resolved = resolve(draftFor(feature));
      if (!resolved.ok) {
        bad.push(feature);
        continue;
      }
      const before = base.has(feature.key) ? (base.get(feature.key) ?? null) : undefined;
      const after = resolved.value;

      if (after === undefined) next.delete(feature.key);
      else next.set(feature.key, after);

      /* `undefined` is only ever "not priced" and `null` only ever "unlimited",
       * so one comparison covers the value and its presence at once. */
      if (before !== after) list.push({ key: feature.key, feature, before, after });
    }

    return { changes: list, invalid: bad, nextMap: next };
  }, [rows, base, draftFor]);

  const cuts = changes.filter(isCut);

  const runDryRun = useMutation({
    mutationFn: () => dryRunPlanFeatures(plan.code, limitBodyOf(nextMap)),
    onSuccess: (result) => {
      setReview(result);
      setReviewing(true);
    },
    onError: (err) => {
      if (isNotHere(err)) {
        onGone();
        return;
      }
      /* The question could not be asked. The answer is not "nobody is
       * affected" — it is "unknown", and the review step below says so and
       * makes the operator press a differently-worded button. */
      setDryRunError(err instanceof ApiError ? err.message : 'শুকনো চালনা করা যায়নি');
      setReview(null);
      setReviewing(true);
    },
  });

  const save = useMutation({
    mutationFn: () => putPlanFeatures(plan.code, limitBodyOf(nextMap), false),
    onSuccess: () => {
      haptic('success');
      invalidatePlatformCaches(queryClient);
      setEdits(new Map());
      setReview(null);
      setReviewing(false);
      setDryRunError(null);
    },
    onError: (err) => {
      if (isNotHere(err)) {
        onGone();
        return;
      }
      setSaveError(err instanceof ApiError ? err.message : 'সীমা সংরক্ষণ করা যায়নি');
    },
  });

  /* A 404 on the catalogue is the same statement as a 404 anywhere else under
   * `/admin`: there is nothing here. It is reported to the page rather than
   * rendered locally — half a screen of not-found inside a section would leave
   * the package's name and price still on display above it. In an effect, not
   * in the render, because setting a parent's state during a child's render is
   * not a thing React allows. */
  const catalogueGone = isNotHere(catalogue.error);
  React.useEffect(() => {
    if (catalogueGone) onGone();
  }, [catalogueGone, onGone]);
  if (catalogueGone) return null;

  const byCategory = new Map<string, AdminFeature[]>();
  for (const feature of rows) {
    const bucket = byCategory.get(feature.category);
    if (bucket) bucket.push(feature);
    else byCategory.set(feature.category, [feature]);
  }

  return (
    <section className="rounded-card border-rule bg-surface border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-ink text-base font-semibold">সীমা</h2>
        {changes.length > 0 ? (
          <p className="text-brass text-xs font-medium">
            {bnNum(changes.length)}টি বদল সংরক্ষণের অপেক্ষায়
          </p>
        ) : (
          <p className="text-ink-muted text-xs">কোনো বদল নেই</p>
        )}
      </div>

      {catalogue.isError ? (
        <div className="mt-3">
          <QueryError
            message="ফিচার ক্যাটালগ আনা যায়নি — সীমা দেখানো বা বদলানো যাচ্ছে না।"
            onRetry={() => void catalogue.refetch()}
          />
        </div>
      ) : catalogue.isLoading ? (
        <div className="mt-3 flex flex-col gap-3" aria-busy>
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-ink-muted mt-3 text-sm">
          ক্যাটালগে একটিও ফিচার নেই। আগে <span className="font-medium">ফিচার ক্যাটালগ</span> পাতায়
          ফিচার তৈরি করুন, তারপর এখানে দাম বসানো যাবে।
        </p>
      ) : (
        <>
          <p className="text-ink-muted mt-1 text-xs">{NOT_PRICED_MEANS}</p>

          <div className="mt-3 flex flex-col gap-4">
            {[...byCategory.entries()].map(([category, features]) => (
              <div key={category}>
                <h3 className="text-ink-muted text-xs font-medium">
                  {category === '__unknown' ? 'ক্যাটালগে নেই' : categoryLabel(category)}
                </h3>
                <ul className="divide-rule mt-1 flex flex-col divide-y">
                  {features.map((feature) => (
                    <li key={feature.key}>
                      <LimitRow
                        feature={feature}
                        before={base.has(feature.key) ? (base.get(feature.key) ?? null) : undefined}
                        draft={draftFor(feature)}
                        invalid={invalid.includes(feature)}
                        onChange={(next) => setDraft(feature.key, next)}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-col gap-3">
            {invalid.length > 0 ? (
              <p role="alert" className="text-expense text-xs">
                {bnNum(invalid.length)}টি সারিতে সংখ্যাটি ঠিক নেই — ০ থেকে {bnCount(MAX_LIMIT)}{' '}
                পর্যন্ত পূর্ণসংখ্যা লিখুন।
              </p>
            ) : null}

            {!reviewing ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={changes.length === 0 || invalid.length > 0 || runDryRun.isPending}
                  onClick={() => {
                    haptic('select');
                    setSaveError(null);
                    runDryRun.mutate();
                  }}
                >
                  <ListChecks className="h-4 w-4" aria-hidden />
                  {runDryRun.isPending ? 'হিসাব করা হচ্ছে…' : 'পরের ধাপ — কী হবে দেখুন'}
                </Button>
                {changes.length > 0 ? (
                  <Button
                    variant="outline"
                    disabled={runDryRun.isPending}
                    onClick={() => {
                      haptic('tap');
                      setEdits(new Map());
                    }}
                  >
                    বদলগুলো বাতিল করুন
                  </Button>
                ) : null}
              </div>
            ) : (
              <ReviewPanel
                plan={plan}
                changes={changes}
                cuts={cuts}
                result={review}
                dryRunError={dryRunError}
                saveError={saveError}
                pending={save.isPending}
                onRetryDryRun={() => {
                  setDryRunError(null);
                  runDryRun.mutate();
                }}
                onBack={() => {
                  setReviewing(false);
                  setSaveError(null);
                }}
                onApply={() => {
                  haptic('warn');
                  setSaveError(null);
                  save.mutate();
                }}
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------
 * One feature
 * ---------------------------------------------------------------------- */

/**
 * A card on a phone, two columns from `md` up.
 *
 * Not a `<table>`: eleven features by four columns does not survive 320px, and
 * a table in a horizontal scroller hides the controls behind a gesture nobody
 * makes on a support call. The same markup lays out as a row when there is room
 * for one.
 */
function LimitRow({
  feature,
  before,
  draft,
  invalid,
  onChange,
}: {
  feature: AdminFeature;
  before: number | null | undefined;
  draft: Draft;
  invalid: boolean;
  onChange: (draft: Draft) => void;
}) {
  const resolved = resolve(draft);
  const after = resolved.ok ? resolved.value : undefined;
  const differs = resolved.ok && before !== after;
  const inputId = `limit-${feature.key}`;

  return (
    <div className="flex flex-col gap-2 py-3 md:grid md:grid-cols-[minmax(0,1fr)_20rem] md:items-start md:gap-4">
      <div className="min-w-0">
        <p className="text-ink truncate text-sm">
          {featureTitle(feature)}
          {!feature.isActive && feature.category !== '__unknown' ? (
            <span className="bg-ink-muted/15 text-ink-muted ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium">
              অবসরপ্রাপ্ত ফিচার
            </span>
          ) : null}
          {feature.category === '__unknown' ? (
            <span className="bg-brass/15 text-brass ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium">
              ক্যাটালগে নেই
            </span>
          ) : null}
        </p>
        <p className="text-ink-muted truncate text-[11px]" title={feature.key}>
          {feature.key} · {kindLabel(feature.kind)} · {periodLabel(feature.period)}
        </p>
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="text-ink-muted text-[11px]">এখন</span>
          <PlanLimitValue value={before} kind={feature.kind} unit={feature.unit} />
          {differs ? (
            <>
              <span className="text-ink-muted text-[11px]">→</span>
              <PlanLimitValue
                value={after}
                kind={feature.kind}
                unit={feature.unit}
                className="font-medium"
              />
            </>
          ) : null}
        </div>

        <LimitStateChips
          label={`${featureTitle(feature)} — সীমা`}
          state={draft.state}
          options={limitStateOptions(feature.kind, draft.state)}
          onChange={(state) =>
            onChange({
              state,
              // Keep whatever was typed, so flipping to সীমাহীন and back does
              // not throw the number away.
              text: draft.text,
            })
          }
        />

        {draft.state === 'fixed' ? (
          <div className="flex flex-col gap-1">
            <label htmlFor={inputId} className="sr-only">
              {featureTitle(feature)} — সর্বোচ্চ কত
            </label>
            <Input
              id={inputId}
              value={draft.text}
              onChange={(e) => onChange({ state: 'fixed', text: e.target.value })}
              inputMode="numeric"
              className={cn('money', invalid && 'border-expense')}
              placeholder="সংখ্যা"
              aria-invalid={invalid || undefined}
            />
            {/* Only once something has been typed. An empty box the operator
                has not reached yet is not a mistake to shout about — the count
                under the list is what says the save is blocked. */}
            {invalid && draft.text.trim() !== '' ? (
              <p role="alert" className="text-expense text-[11px]">
                ০ থেকে {bnCount(MAX_LIMIT)} পর্যন্ত একটি পূর্ণসংখ্যা লিখুন।
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------
 * What is about to happen
 * ---------------------------------------------------------------------- */

function ReviewPanel({
  plan,
  changes,
  cuts,
  result,
  dryRunError,
  saveError,
  pending,
  onRetryDryRun,
  onBack,
  onApply,
}: {
  plan: AdminPlan;
  changes: Change[];
  cuts: Change[];
  result: DryRunResult | null;
  dryRunError: string | null;
  saveError: string | null;
  pending: boolean;
  onRetryDryRun: () => void;
  onBack: () => void;
  onApply: () => void;
}) {
  /* The server reports only the features that would actually push somebody
   * over — a tightened ceiling nobody breaches is left out of `byFeature` — so
   * an absent key means "measured, nobody over", and only a key in
   * `unmeasured` means "nobody counts this". Those two must not print the same
   * sentence: one is a zero, the other is a shrug. */
  const impactOf = new Map((result?.impacts ?? []).map((impact) => [impact.featureKey, impact]));
  /* Keys the server itself decided were tightened but could not measure. Its
   * judgement, not this screen's: it resolves both sides through the same
   * entitlement code the enforcer uses, so it catches tightenings a diff of the
   * two maps would miss — a row removed from the package falling back to a
   * lower default, for one. */
  const unmeasured = new Set(result?.unmeasured ?? []);
  const tenantCount = result?.tenantCount ?? null;

  /* An impact for a key that is not in this edit's change list. It should not
   * happen, and if it does the operator must still see it — the alternative is
   * a warning the server took the trouble to compute and this screen dropped. */
  const changedKeys = new Set(changes.map((change) => change.key));
  const strays = (result?.impacts ?? []).filter(
    (impact) => !changedKeys.has(impact.featureKey) && (impact.overCount ?? 0) > 0,
  );

  const blind = dryRunError !== null || result === null || !result.understood;
  const dangerous =
    blind || (tenantCount !== null && tenantCount > 0) || unmeasured.size > 0 || strays.length > 0;

  return (
    <div
      className={cn(
        'rounded-card flex flex-col gap-3 border p-3 text-sm',
        dangerous ? 'border-expense/40 bg-expense/10 text-ink' : 'border-rule bg-greenbar text-ink',
      )}
    >
      <p className="font-medium">
        {bnNum(changes.length)}টি সীমা বদলাবে
        {plan.workspaceCount === null
          ? ' — এই প্যাকেজে কতজন আছেন তা জানা যায়নি।'
          : plan.workspaceCount === 0
            ? ' — এই প্যাকেজে কোনো ওয়ার্কস্পেস নেই।'
            : `, আর এই প্যাকেজে ${bnNum(plan.workspaceCount)}টি ওয়ার্কস্পেস আছে।`}
      </p>

      {/* The headline the whole two-step exists for. */}
      {tenantCount !== null ? (
        <p className={cn('text-sm', tenantCount > 0 ? 'text-expense font-semibold' : 'text-ink')}>
          {tenantCount > 0
            ? `${bnNum(tenantCount)}টি ওয়ার্কস্পেস অন্তত একটি নতুন সীমার বাইরে চলে যাবে।`
            : 'কোনো ওয়ার্কস্পেস নতুন কোনো সীমার বাইরে যাবে না।'}
        </p>
      ) : null}

      <ul className="flex flex-col gap-2">
        {changes.map((change) => {
          const impact = impactOf.get(change.key) ?? null;
          const cut = isCut(change);
          return (
            <li key={change.key} className="flex min-w-0 flex-col">
              <span className="flex min-w-0 flex-wrap items-baseline gap-1 text-xs">
                <span className="text-ink font-medium">{featureTitle(change.feature)}</span>
                <span className="text-ink-muted">
                  {planLimitText(change.before, change.feature.kind, change.feature.unit)}
                </span>
                <span className="text-ink-muted">→</span>
                <span className="text-ink font-medium">
                  {planLimitText(change.after, change.feature.kind, change.feature.unit)}
                </span>
              </span>

              {impact !== null && impact.overCount !== null && impact.overCount > 0 ? (
                <>
                  <span className="text-expense text-xs font-medium">
                    {bnNum(impact.overCount)}টি ওয়ার্কস্পেস এখনই এই সীমার বাইরে
                    {impact.maxUsed !== null && impact.maxUsed > 0
                      ? ` — সবচেয়ে বেশি ব্যবহার ${bnCount(impact.maxUsed)}${unitSuffix(change.feature.unit)}`
                      : ''}
                    ।
                  </span>
                  {impact.sample.length > 0 ? (
                    <span className="text-ink-muted text-[11px]">
                      যেমন{' '}
                      {impact.sample
                        .map((tenant) => `${tenant.name} (${bnCount(tenant.used)})`)
                        .join(', ')}
                      {impact.overCount > impact.sample.length
                        ? ` — আরও ${bnNum(impact.overCount - impact.sample.length)}টি`
                        : ''}
                    </span>
                  ) : null}
                </>
              ) : unmeasured.has(change.key) ? (
                <span className="text-brass text-[11px]">
                  এই ফিচারের ব্যবহার কেউ গোনে না — কতজন বাইরে পড়বেন তা অজানা, শূন্য নয়।
                </span>
              ) : blind && cut ? (
                <span className="text-brass text-[11px]">
                  সীমা কমছে, কিন্তু কতজন বাইরে যাবেন তা এখন জানা নেই।
                </span>
              ) : cut ? (
                <span className="text-ink-muted text-[11px]">
                  কোনো ওয়ার্কস্পেস এই সীমার বাইরে যাবে না।
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>

      {dryRunError !== null ? (
        <Danger>
          <p className="font-medium">শুকনো চালনা করা যায়নি: {dryRunError}</p>
          <p className="mt-1">
            কারা সীমার বাইরে পড়বেন তা এখন জানা নেই। সংরক্ষণ করলে না জেনেই করা হবে।
          </p>
          <button
            type="button"
            onClick={onRetryDryRun}
            className="press text-income mt-1 inline-flex min-h-11 items-center gap-1 text-xs font-medium md:min-h-9"
          >
            <RotateCw className="h-3.5 w-3.5" aria-hidden />
            আবার চেষ্টা করুন
          </button>
        </Danger>
      ) : result !== null && !result.understood ? (
        <Danger>
          <p className="font-medium">সার্ভারের উত্তরটি এই বিল্ড পড়তে পারেনি।</p>
          <p className="mt-1">
            হিসাবটি চলেছে, কিন্তু কোন ফিচারে কতজন বাইরে যাবেন তা এখানে দেখানো যাচ্ছে না। উপরের
            তালিকাটি তাই অসম্পূর্ণ।
          </p>
        </Danger>
      ) : null}

      {strays.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {strays.map((impact) => (
            <li key={impact.featureKey} className="text-expense text-xs font-medium">
              {impact.labelBn}: {bnNum(impact.overCount ?? 0)}টি ওয়ার্কস্পেস সীমার বাইরে যাবে।
            </li>
          ))}
        </ul>
      ) : null}

      {unmeasured.size > 0 ? <p className="text-brass text-xs">{UNMEASURED_CUT}</p> : null}

      {result?.truncated === true ? (
        <p className="text-expense text-xs">{SWEEP_TRUNCATED}</p>
      ) : null}

      {cuts.length > 0 || (tenantCount !== null && tenantCount > 0) ? (
        <div className="flex flex-col gap-1 text-xs">
          <p className="flex items-start gap-1.5">
            <TriangleAlert className="text-expense mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{OVER_LIMIT_MEANS}</span>
          </p>
          {/* The sweep resolves each tenant through their own overrides, so a
              customer whose ceiling was granted by hand is not in these counts
              and will not be touched by this save. */}
          <p className="text-ink-muted">{OVERRIDES_NOT_COUNTED}</p>
        </div>
      ) : null}

      <Note>{APPLIES_NEXT_REQUEST}</Note>

      {saveError !== null ? (
        <p role="alert" className="text-expense text-sm">
          {saveError}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <Button
          variant={dangerous ? 'danger' : 'primary'}
          size="block"
          disabled={pending}
          onClick={onApply}
        >
          {pending ? 'পাঠানো হচ্ছে…' : blind ? 'তবু প্রয়োগ করুন' : 'সীমা প্রয়োগ করুন'}
        </Button>
        <Button variant="outline" size="block" disabled={pending} onClick={onBack}>
          পিছনে
        </Button>
      </div>
    </div>
  );
}
