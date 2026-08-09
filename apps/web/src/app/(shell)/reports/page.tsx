'use client';

/**
 * The route. Everything is in `./view`, behind a Suspense boundary because the
 * range is read from the URL with `useSearchParams`, and Next will not
 * prerender a client component that reads the query string without one.
 */

import * as React from 'react';
import { SkeletonCard } from '@/components/skeleton';
import { ReportsView } from './view';

function ReportsFallback() {
  return (
    <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-3 md:grid-cols-2">
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
      <SkeletonCard />
    </div>
  );
}

export default function ReportsPage() {
  return (
    <React.Suspense fallback={<ReportsFallback />}>
      <ReportsView />
    </React.Suspense>
  );
}
