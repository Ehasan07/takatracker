'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Database, Download } from '@/components/icons';
import * as React from 'react';
import { startOfMonth, toLocalDateString } from '@hishab/shared';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { ApiError, endpoints } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { Notice } from './parts';
import { downloadFile, exportTransactionsPath } from './transport';

/**
 * Taking the data back out. Both downloads go through `fetch` and a blob rather
 * than an `<a href>` to the API, so the session travels with the request, a
 * failure can be said out loud in Bengali, and the file is named from the
 * response instead of from the URL.
 */
export function ExportPanel() {
  const today = toLocalDateString(new Date());
  const monthStart = toLocalDateString(startOfMonth(new Date()));

  const [from, setFrom] = React.useState(monthStart);
  const [to, setTo] = React.useState(today);
  const [accountId, setAccountId] = React.useState('');
  const [notice, setNotice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });

  const run = useMutation({
    mutationFn: ({ path, name }: { path: string; name: string }) => downloadFile(path, name),
    onSuccess: () => {
      haptic('success');
      setError(null);
      setNotice('ফাইল নামানো শুরু হয়েছে।');
    },
    onError: (err) => {
      haptic('warn');
      setNotice(null);
      setError(err instanceof ApiError ? err.message : 'ফাইল নামানো যায়নি');
    },
  });

  const rangeInvalid = from !== '' && to !== '' && from > to;

  return (
    <section className="rounded-card border-rule bg-surface flex flex-col gap-3 border p-4">
      <div>
        <h2 className="text-ink text-base font-semibold">তথ্য নামিয়ে নিন</h2>
        <p className="text-ink-muted text-xs">
          আপনার হিসাব আপনারই। এক্সেলে খুলবে এমন সিএসভি, অথবা পুরো তথ্যের একটা কপি।
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="শুরুর তারিখ" htmlFor="exp-from">
          <Input id="exp-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="শেষ তারিখ" htmlFor="exp-to">
          <Input id="exp-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="অ্যাকাউন্ট" htmlFor="exp-account">
          <Select id="exp-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">সব অ্যাকাউন্ট</option>
            {(accounts.data ?? []).map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {rangeInvalid ? <Notice tone="bad">শেষ তারিখ শুরুর তারিখের আগে হতে পারে না।</Notice> : null}
      {notice ? <Notice tone="ok">{notice}</Notice> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={run.isPending || rangeInvalid}
          onClick={() =>
            run.mutate({
              path: exportTransactionsPath({ from, to, accountId: accountId || undefined }),
              name: `hishab-lenden-${from}-${to}.csv`,
            })
          }
        >
          <Download className="h-4 w-4" aria-hidden />
          লেনদেনের সিএসভি নামান
        </Button>

        <Button
          variant="outline"
          disabled={run.isPending}
          onClick={() =>
            run.mutate({ path: '/export/full', name: `hishab-sob-tottho-${today}.json` })
          }
        >
          <Database className="h-4 w-4" aria-hidden />
          সব তথ্য নামান
        </Button>
      </div>

      <p className="text-ink-muted text-xs">
        “সব তথ্য” একটি JSON ফাইল — অ্যাকাউন্ট, খাত, লেনদেন, ধার-দেনা, সঞ্চয় সব একসঙ্গে। তারিখের
        সীমা এতে খাটে না।
      </p>
    </section>
  );
}
