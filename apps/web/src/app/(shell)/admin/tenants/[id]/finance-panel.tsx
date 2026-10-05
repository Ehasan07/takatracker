'use client';

import { useQuery } from '@tanstack/react-query';
import { Eye } from '@/components/icons';
import * as React from 'react';
import { formatMinor } from '@hishab/shared';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { adminKeys } from '../../queries';
import type { TenantFinance } from '../../types';

/**
 * A tenant's balances, behind a deliberate press.
 *
 * ## Why it does not load with the page
 *
 * Opening a customer's plan page is routine — support does it to check a limit
 * or a renewal date. Reading their bank balances is not, and the audit row for
 * it is a different row with a different name. If this panel fetched on mount,
 * every routine visit would file "looked at their money" and the log would stop
 * distinguishing the two, which is the same as not recording the difference.
 *
 * So it is a button. One press, one request, one row that means what it says.
 *
 * ## What it deliberately does not show
 *
 * No transaction list. An operator gets positions and totals; the line-by-line
 * story of what somebody bought is what the time-boxed, audited impersonation
 * session is for, and that leaves a far clearer record of a support visit than
 * a quiet read of somebody's grocery history.
 */
export function FinancePanel({ workspaceId }: { workspaceId: string }) {
  const [asked, setAsked] = React.useState(false);

  const finance = useQuery({
    queryKey: adminKeys.finance(workspaceId),
    queryFn: () => api<TenantFinance>(`/admin/tenants/${workspaceId}/finance`),
    enabled: asked,
    /* Never silently refetched. Every fetch is an audited read of somebody's
       balances, so a background refresh would write rows nobody asked for. */
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const money = (minor: number) =>
    formatMinor(minor, { currency: finance.data?.currency ?? 'BDT', bengaliNumerals: true });

  return (
    <section className="rounded-card border-rule bg-surface border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-ink font-medium">আর্থিক অবস্থা</h2>
          <p className="text-ink-muted mt-1 max-w-prose text-xs">
            ব্যালেন্স, নিট সম্পদ, সঞ্চয় ও ঋণ। দেখলে কার্যবিবরণীতে আপনার নামে একটি সারি লেখা হবে —
            গ্রাহকের খাতায় নয়, প্ল্যাটফর্মের লগে।
          </p>
        </div>
        {!asked ? (
          <Button size="sm" variant="outline" onClick={() => setAsked(true)}>
            <Eye className="h-4 w-4" aria-hidden />
            দেখুন
          </Button>
        ) : null}
      </div>

      {!asked ? null : finance.isPending ? (
        <p className="text-ink-muted mt-4 text-sm">আনা হচ্ছে…</p>
      ) : finance.isError ? (
        <p className="text-expense mt-4 text-sm">আর্থিক তথ্য আনা যায়নি।</p>
      ) : (
        <div className="mt-4 space-y-4">
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              ['নিট সম্পদ', money(finance.data.netWorthMinor)],
              ['সম্পদ', money(finance.data.assetsMinor)],
              ['দায়', money(finance.data.liabilitiesMinor)],
              ['মুদ্রা', finance.data.currency],
            ].map(([label, value]) => (
              <div key={label} className="rounded-card border-rule border p-3">
                <dt className="text-ink-muted text-xs">{label}</dt>
                <dd className="text-ink money mt-1 text-sm font-medium">{value}</dd>
              </div>
            ))}
          </dl>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] border-collapse text-sm">
              <caption className="sr-only">অ্যাকাউন্ট ও ব্যালেন্স</caption>
              <thead>
                <tr className="border-rule text-ink-muted border-b text-left">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    অ্যাকাউন্ট
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    ধরন
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    নম্বর
                  </th>
                  <th scope="col" className="py-2 pl-3 text-right font-medium">
                    ব্যালেন্স
                  </th>
                </tr>
              </thead>
              <tbody>
                {finance.data.accounts.map((account) => (
                  <tr key={account.id} className="border-rule border-b last:border-b-0">
                    <th scope="row" className="text-ink py-2 pr-3 text-left font-normal">
                      {account.name}
                      {account.institution ? (
                        <span className="text-ink-muted block text-xs">{account.institution}</span>
                      ) : null}
                    </th>
                    <td className="text-ink-muted px-3 py-2">{account.type}</td>
                    {/* Whatever the user typed for their own recognition. This
                        product has never asked for a full account number, so
                        there is none to show. */}
                    <td className="text-ink-muted money px-3 py-2">
                      {account.accountNumberMasked ?? '—'}
                    </td>
                    <td className="text-ink money py-2 pl-3 text-right">
                      {money(account.balanceMinor)}
                    </td>
                  </tr>
                ))}
                {finance.data.accounts.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="text-ink-muted py-3">
                      কোনো অ্যাকাউন্ট নেই।
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              ['সঞ্চয়ে জমা', money(finance.data.savings.paidInMinor)],
              ['প্রিমিয়াম দেওয়া', money(finance.data.insurance.premiumPaidMinor)],
              ['পাওনা (ঋণ)', money(finance.data.loans.lentOutstandingMinor)],
              ['দেনা (ঋণ)', money(finance.data.loans.borrowedOutstandingMinor)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-card border-rule border p-3">
                <dt className="text-ink-muted text-xs">{label}</dt>
                <dd className="text-ink money mt-1 text-sm font-medium">{value}</dd>
              </div>
            ))}
          </dl>

          <p className="text-ink-muted text-xs">
            লেনদেনের তালিকা এখানে নেই — কেউ কী কিনেছে সেটা দেখতে হলে সাপোর্ট সেশন ব্যবহার করুন,
            যেটির শুরু ও শেষ দুটোই লেখা থাকে।
          </p>
        </div>
      )}
    </section>
  );
}
