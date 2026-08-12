'use client';

import type { QueryClient } from '@tanstack/react-query';

/**
 * What goes stale when a transaction is written.
 *
 * Named rather than `invalidateQueries()` with no filter, which is what this
 * replaced. The unfiltered call marks *every* query in the cache stale — the
 * plan comparison, the category tree, the audit log, the operator probe — and
 * awaiting it makes a write wait for a fan-out of reads that have nothing to do
 * with it. On a connection a second away from the server that is the difference
 * between a form that closes and a form that hangs.
 *
 * The list is what a transaction can actually change:
 *
 *   transactions  the khata's own list
 *   summary       this month's income, expense and net
 *   accounts      every balance moves
 *   reports       every figure on them is derived from entries
 *   entitlements  the monthly transaction meter counts up
 *   people        `transactionCount` on whoever it named
 *   loans         a repayment is a transaction; the party ledger follows
 *
 * Deliberately absent: `me`, `categories`, `tags`, `plans`, `admin`. A
 * transaction cannot change any of them, and refetching them is a request that
 * can only ever return the same answer.
 *
 * Nothing here is awaited by callers. The write has already succeeded; the
 * refresh is for the screens behind the sheet, not for the person closing it.
 */
const AFTER_WRITE = [
  ['transactions'],
  ['summary'],
  ['accounts'],
  ['reports'],
  ['entitlements'],
  ['people'],
  ['loans'],
] as const;

export function invalidateAfterWrite(queryClient: QueryClient): void {
  for (const key of AFTER_WRITE) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}
