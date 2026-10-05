import { cn } from '@/lib/utils';

/**
 * Placeholders shaped like the content that is coming. A spinner tells the user
 * to wait; a skeleton tells them what they are waiting for, and the layout does
 * not jump when the data lands.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('bg-greenbar animate-pulse rounded-xl', className)} aria-hidden />;
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="divide-rule divide-y" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-3">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
          <Skeleton className="h-4 w-20 shrink-0" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn('rounded-card border-rule bg-surface border-[1.5px] p-5', className)}>
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-7 w-40" />
      <div className="mt-4 space-y-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
      </div>
    </div>
  );
}
