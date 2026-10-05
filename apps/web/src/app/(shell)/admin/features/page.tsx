'use client';

import { useQuery } from '@tanstack/react-query';
import { Layers, Plus, Tags } from '@/components/icons';
import Link from 'next/link';
import * as React from 'react';
import { SkeletonRows } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { bnNum, categoryLabel, periodLabel } from '../labels';
import { NotFoundScreen, QueryError } from '../parts';
import { isNotHere } from '../queries';
import { FeatureSheet } from './feature-sheet';
import { kindLabel, NEW_FEATURE_DEFAULT, NO_FEATURE_DELETE, unitLabel } from './labels';
import { fetchAdminCatalogue, featureCatalogueKeys } from './queries';
import { featureTitle, type AdminFeature } from './types';

/**
 * The feature catalogue.
 *
 * What can be sold, as data. It used to be a `const` tuple in
 * `packages/core`, which meant that adding a sellable feature was a pull
 * request and a deploy, and that a super admin could never assemble a bespoke
 * package — the thing packages exist for. The code now holds only the defaults
 * and seeds them if they are absent; this screen is the catalogue itself.
 *
 * Nothing here changes what any customer has. A feature is inert until a
 * package prices it — that is `limitFor`'s `whenUnknown: 0`, and it is
 * deliberate: if an unpriced key resolved to "unlimited", creating a row on
 * this screen would hand the feature to every workspace in the system.
 */
export default function AdminFeaturesPage() {
  const catalogue = useQuery({
    queryKey: featureCatalogueKeys.list(),
    queryFn: fetchAdminCatalogue,
  });

  const [gone, setGone] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editKey, setEditKey] = React.useState<string | null>(null);

  const onGone = React.useCallback(() => setGone(true), []);

  if (gone || isNotHere(catalogue.error)) return <NotFoundScreen />;

  const items = catalogue.data?.items ?? [];
  const orientation = catalogue.data?.orientation ?? 'unknown';
  const editing = items.find((row) => row.key === editKey) ?? null;
  const active = items.filter((row) => row.isActive);

  const byCategory = new Map<string, AdminFeature[]>();
  for (const feature of items) {
    const bucket = byCategory.get(feature.category);
    if (bucket) bucket.push(feature);
    else byCategory.set(feature.category, [feature]);
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h1 className="text-ink text-xl font-semibold sm:text-2xl">ফিচার ক্যাটালগ</h1>
        {items.length > 0 ? (
          <p className="text-ink-muted text-xs">
            {bnNum(active.length)}টি চালু
            {items.length !== active.length
              ? `, ${bnNum(items.length - active.length)}টি অবসরে`
              : ''}
          </p>
        ) : null}
      </header>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" aria-hidden />
          নতুন ফিচার
        </Button>
        <Button size="sm" variant="outline" asChild>
          <Link href="/admin/plans" onClick={() => haptic('tap')}>
            <Layers className="h-4 w-4" aria-hidden />
            প্যাকেজ ও দাম
          </Link>
        </Button>
      </div>

      <p className="rounded-card border-rule bg-greenbar text-ink-muted border p-3 text-xs">
        {NEW_FEATURE_DEFAULT}
      </p>

      {catalogue.isError ? (
        <QueryError message="ফিচার ক্যাটালগ আনা যায়নি।" onRetry={() => void catalogue.refetch()} />
      ) : catalogue.isLoading ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border" aria-busy>
          <SkeletonRows rows={6} />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-card border-rule border border-dashed p-8 text-center">
          <Tags className="text-ink-muted mx-auto h-6 w-6" aria-hidden />
          <p className="text-ink mt-2">ক্যাটালগ খালি।</p>
          <p className="text-ink-muted mt-1 text-sm">
            এপিআই চালু হলে বিল্ডের সঙ্গে আসা ফিচারগুলো নিজে থেকেই বসে যায়। নিজে একটি বানাতে উপরের
            বোতামটি ব্যবহার করুন।
          </p>
        </div>
      ) : (
        <>
          {[...byCategory.entries()].map(([category, features]) => (
            <section key={category} className="rounded-card border-rule bg-surface border p-4">
              <h2 className="text-ink text-base font-semibold">{categoryLabel(category)}</h2>
              <ul className="divide-rule mt-1 flex flex-col divide-y">
                {features.map((feature) => (
                  <li key={feature.key}>
                    <button
                      type="button"
                      onClick={() => {
                        haptic('tap');
                        setEditKey(feature.key);
                      }}
                      className="press-row -mx-2 flex min-h-11 w-[calc(100%+1rem)] items-start gap-2 rounded-md px-2 py-2.5 text-left"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-ink truncate text-sm">
                          {featureTitle(feature)}
                          {!feature.isActive ? (
                            <span className="bg-ink-muted/15 text-ink-muted ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium">
                              অবসরে
                            </span>
                          ) : null}
                        </p>
                        <p className="text-ink-muted break-all text-[11px]">{feature.key}</p>
                        {feature.labelEn !== '' && feature.labelEn !== feature.labelBn ? (
                          <p className="text-ink-muted truncate text-[11px]">{feature.labelEn}</p>
                        ) : null}
                        {/* Which packages price it. This is what makes retiring
                            a feature a decision rather than a guess: these are
                            the packages that keep it afterwards. */}
                        <p
                          className={cn(
                            'mt-0.5 truncate text-[11px]',
                            feature.grantedByPlans.length === 0 ? 'text-brass' : 'text-ink-muted',
                          )}
                        >
                          {feature.grantedByPlans.length === 0
                            ? 'কোনো প্যাকেজে দাম বসানো নেই — সবার জন্য বন্ধ'
                            : `${bnNum(feature.grantedByPlans.length)}টি প্যাকেজে: ${feature.grantedByPlans
                                .map((grant) => grant.code)
                                .join(', ')}`}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-ink text-xs">{kindLabel(feature.kind)}</p>
                        <p className="text-ink-muted text-[11px]">{unitLabel(feature.unit)}</p>
                        <p className="text-ink-muted text-[11px]">{periodLabel(feature.period)}</p>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <p className="rounded-card border-rule bg-greenbar text-ink-muted border p-3 text-xs">
            {NO_FEATURE_DELETE}
          </p>
        </>
      )}

      <FeatureSheet
        mode="create"
        feature={null}
        features={items}
        orientation={orientation}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onGone={onGone}
      />
      <FeatureSheet
        mode="edit"
        feature={editing}
        features={items}
        orientation={orientation}
        open={editing !== null}
        onOpenChange={(next) => {
          if (!next) setEditKey(null);
        }}
        onGone={onGone}
      />
    </div>
  );
}
