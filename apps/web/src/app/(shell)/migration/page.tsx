'use client';

import { migrationToCsv, type MigrationDecision, type MigrationRow } from '@hishab/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Download, RotateCcw, Trash2, Upload } from 'lucide-react';
import * as React from 'react';
import { Skeleton } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { ApiError, api, endpoints } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { DecisionRow } from './decision-row';
import type {
  CsvResult,
  MigrationBatch,
  MigrationBatchDetail,
  MigrationItem,
  RollbackResult,
} from './types';

/**
 * Moving in from another product.
 *
 * ## One screen, three states
 *
 * Nothing staged, something staged and undecided, something applied. Each state
 * shows only its own controls, because the alternative — every button always
 * visible, most of them disabled — is a screen where the next step has to be
 * worked out rather than seen.
 *
 * ## Why the token box says what it says
 *
 * Pasting a credential to another finance account into a web form is a real
 * thing to ask of somebody. The copy says where it goes, how long it is kept
 * (the length of one request) and what to do afterwards, in the same size type
 * as the button. Anything less and the honest answer is buried in a policy page
 * nobody opens.
 */

const BATCHES_KEY = ['migration', 'batches'];

export default function MigrationPage() {
  const queryClient = useQueryClient();
  const [token, setToken] = React.useState('');
  const [csvResult, setCsvResult] = React.useState<CsvResult | null>(null);
  const [rolledBack, setRolledBack] = React.useState<RollbackResult | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = React.useState(false);
  const fileInput = React.useRef<HTMLInputElement>(null);

  const batches = useQuery({
    queryKey: BATCHES_KEY,
    queryFn: () => api<MigrationBatch[]>('/migration/batches'),
  });

  /* The one that matters: a draft if there is one, otherwise the most recent.
     The list is already newest-first from the API. */
  const current = React.useMemo(() => {
    const all = batches.data ?? [];
    return all.find((b) => b.status === 'DRAFT') ?? all[0] ?? null;
  }, [batches.data]);

  const detail = useQuery({
    queryKey: ['migration', 'batch', current?.id],
    queryFn: () => api<MigrationBatchDetail>(`/migration/batches/${current?.id}`),
    enabled: Boolean(current),
  });

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });
  const categories = useQuery({ queryKey: ['categories'], queryFn: endpoints.categories });

  const refresh = React.useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['migration'] });
    await queryClient.invalidateQueries({ queryKey: ['accounts'] });
    await queryClient.invalidateQueries({ queryKey: ['categories'] });
  }, [queryClient]);

  const pull = useMutation({
    mutationFn: (value: string) =>
      api<MigrationBatchDetail>('/migration/wallet/pull', {
        method: 'POST',
        body: { token: value },
      }),
    onSuccess: async () => {
      /* Cleared the moment it has been used. It was never going to be stored
         server-side, and leaving it in a React state that survives a route
         change would be the same mistake one layer up. */
      setToken('');
      haptic('success');
      await refresh();
    },
  });

  const decide = useMutation({
    mutationFn: (input: {
      itemId: string;
      patch: { decision?: MigrationDecision; targetType?: string; targetId?: string };
    }) =>
      api<MigrationItem>(`/migration/batches/${current?.id}/items/${input.itemId}`, {
        method: 'PATCH',
        body: input.patch,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['migration', 'batch'] }),
  });

  const apply = useMutation({
    mutationFn: () =>
      api<MigrationBatchDetail>(`/migration/batches/${current?.id}/apply`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: async () => {
      haptic('success');
      await refresh();
    },
  });

  const rollback = useMutation({
    mutationFn: () =>
      api<RollbackResult>(`/migration/batches/${current?.id}/rollback`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: async (result) => {
      setRolledBack(result);
      haptic('tap');
      await refresh();
    },
  });

  const discard = useMutation({
    mutationFn: () =>
      api<{ id: string }>(`/migration/batches/${current?.id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setConfirmingDiscard(false);
      await refresh();
    },
  });

  const importCsv = useMutation({
    mutationFn: (csv: string) =>
      api<CsvResult>(`/migration/batches/${current?.id}/csv`, { method: 'POST', body: { csv } }),
    onSuccess: async (result) => {
      setCsvResult(result);
      await refresh();
    },
  });

  const items = detail.data?.items ?? [];
  const accountItems = items.filter((i) => i.kind === 'ACCOUNT');
  const categoryItems = items.filter((i) => i.kind === 'CATEGORY');

  const accountTargets = React.useMemo(
    () => (accounts.data ?? []).map((a) => ({ id: a.id, name: a.name })),
    [accounts.data],
  );
  const categoryTargets = React.useMemo(
    () => (categories.data ?? []).map((c) => ({ id: c.id, name: c.nameBn ?? c.name })),
    [categories.data],
  );

  /* Built here rather than fetched: the browser already has every row, and
     `@hishab/core` is the same module the server would have used — including
     the BOM Excel needs. One less round trip, one less way for the two to
     disagree. */
  function downloadSpreadsheet(): void {
    if (!detail.data) return;
    const nameById = new Map<string, string>();
    for (const target of [...accountTargets, ...categoryTargets]) {
      nameById.set(target.id, target.name);
    }
    const rows: MigrationRow[] = detail.data.items.map((item) => ({
      kind: item.kind,
      sourceId: item.sourceId,
      name: item.sourceName,
      usageCount: item.usageCount,
      decision: item.decision,
      targetType: item.targetType ?? '',
      mergeInto: item.targetId ? (nameById.get(item.targetId) ?? '') : '',
      note: item.detail,
    }));

    const blob = new Blob([migrationToCsv(rows)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'migration.csv';
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Safari needs the URL alive past the click.
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function onFileChosen(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setCsvResult(null);
    importCsv.mutate(await file.text());
  }

  const busy = pull.isPending || apply.isPending || rollback.isPending || importCsv.isPending;
  const draft = current?.status === 'DRAFT';

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header>
        <h1 className="text-ink text-xl font-semibold sm:text-2xl">আগের সফটওয়্যার থেকে আনুন</h1>
        <p className="text-ink-muted mt-1 text-sm">
          BudgetBakers Wallet-এর অ্যাকাউন্ট আর খাতগুলো এখানে আনুন। সবকিছু আগে খসড়া হিসেবে থাকবে —
          আপনি দেখে অনুমোদন না দিলে খাতায় কিছুই তৈরি হবে না, আর অনুমোদনের পরেও ফিরিয়ে নেওয়া যাবে।
        </p>
      </header>

      {batches.isLoading ? <Skeleton className="h-40 w-full" /> : null}

      {!batches.isLoading && !draft ? (
        <section className="rounded-card border-rule bg-surface border p-4">
          <h2 className="text-ink text-sm font-medium">সংযোগ করুন</h2>
          <p className="text-ink-muted mt-1 text-sm">
            Wallet-এর ওয়েব অ্যাপে সাইন ইন করে API টোকেনটি কপি করে এখানে বসান।
          </p>

          <form
            className="mt-3 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (token.trim().length >= 20) pull.mutate(token.trim());
            }}
          >
            <Field label="Wallet API টোকেন" htmlFor="wallet-token">
              <Input
                id="wallet-token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="eyJhbGciOi…"
              />
            </Field>

            {/* The cost, beside the benefit, in the same size type. */}
            <p className="text-ink-muted text-xs">
              টোকেনটি শুধু এই একবারের পড়ার কাজে লাগে — কোথাও জমা রাখা হয় না। কাজ শেষ হলে Wallet-এ
              গিয়ে টোকেনটি বাতিল করে দিন।
            </p>

            <div>
              <Button type="submit" disabled={busy || token.trim().length < 20}>
                {pull.isPending ? 'আনা হচ্ছে…' : 'অ্যাকাউন্ট ও খাত আনুন'}
              </Button>
            </div>

            {pull.error ? (
              <p role="alert" className="text-expense text-sm">
                {pull.error instanceof ApiError ? pull.error.message : 'আনা গেল না'}
              </p>
            ) : null}
          </form>
        </section>
      ) : null}

      {current && current.status !== 'DRAFT' ? (
        <AppliedPanel
          batch={current}
          rolledBack={rolledBack}
          busy={busy}
          onRollback={() => rollback.mutate()}
          error={rollback.error}
        />
      ) : null}

      {draft && detail.data ? (
        <>
          <section className="rounded-card border-rule bg-surface border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-ink text-sm font-medium">খসড়া তৈরি আছে</h2>
                <p className="text-ink-muted mt-1 text-sm">
                  {detail.data.counts.accounts}টি অ্যাকাউন্ট, {detail.data.counts.categories}টি খাত।
                  প্রতিটির পাশে কী হবে সেটি ঠিক করুন।
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={downloadSpreadsheet} disabled={busy}>
                  <Download className="h-4 w-4" aria-hidden />
                  এক্সেলে নামান
                </Button>
                <Button
                  variant="outline"
                  onClick={() => fileInput.current?.click()}
                  disabled={busy}
                >
                  <Upload className="h-4 w-4" aria-hidden />
                  এক্সেল ফেরত দিন
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => void onFileChosen(e)}
                />
              </div>
            </div>

            {/* Two hundred rows are faster to decide in a column in Excel than
                in two hundred controls, and the person already knows which of
                these are their savings plans. */}
            <p className="text-ink-muted mt-2 text-xs">
              অনেকগুলো সারি হলে এক্সেলে নামিয়ে <code>decision</code> কলামে CREATE, MERGE, SAVINGS,
              INSURANCE বা SKIP লিখে ফাইলটা ফেরত দিন।
            </p>

            {csvResult ? (
              <div className="mt-3 text-sm">
                <p className="text-ink">{csvResult.updated}টি সারি নেওয়া হয়েছে।</p>
                {csvResult.errors.length > 0 ? (
                  <ul className="text-expense mt-1 list-inside list-disc">
                    {csvResult.errors.slice(0, 10).map((error) => (
                      <li key={error}>{error}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </section>

          <ItemList
            title="অ্যাকাউন্ট"
            items={accountItems}
            targets={accountTargets}
            busy={busy}
            onChange={(itemId, patch) => decide.mutate({ itemId, patch })}
          />
          <ItemList
            title="খাত"
            items={categoryItems}
            targets={categoryTargets}
            busy={busy}
            onChange={(itemId, patch) => decide.mutate({ itemId, patch })}
          />

          <section className="rounded-card border-rule bg-surface flex flex-wrap items-center gap-3 border p-4">
            <Button onClick={() => apply.mutate()} disabled={busy}>
              {apply.isPending ? 'তৈরি হচ্ছে…' : 'অনুমোদন করে তৈরি করুন'}
            </Button>

            {/* Two presses, because one press throws away every decision made
                so far and there is no way back to them. The second press is the
                sentence, not a dialog: a modal here would be one more thing to
                dismiss on a phone. */}
            {confirmingDiscard ? (
              <>
                <Button variant="ghost" onClick={() => discard.mutate()} disabled={busy}>
                  <Trash2 className="h-4 w-4" aria-hidden />
                  হ্যাঁ, সব সিদ্ধান্ত মুছে দিন
                </Button>
                <Button variant="ghost" onClick={() => setConfirmingDiscard(false)}>
                  থাক
                </Button>
              </>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmingDiscard(true)} disabled={busy}>
                <Trash2 className="h-4 w-4" aria-hidden />
                খসড়া বাতিল
              </Button>
            )}
            <p className="text-ink-muted w-full text-xs">
              তৈরি করার পরেও পুরোটা এক চাপে ফিরিয়ে নেওয়া যাবে — যেগুলোতে ইতিমধ্যে লেনদেন হয়ে গেছে
              সেগুলো ছাড়া।
            </p>
            {apply.error ? (
              <p role="alert" className="text-expense w-full text-sm">
                {apply.error instanceof ApiError ? apply.error.message : 'তৈরি করা গেল না'}
              </p>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}

function ItemList({
  title,
  items,
  targets,
  busy,
  onChange,
}: {
  title: string;
  items: MigrationItem[];
  targets: { id: string; name: string }[];
  busy: boolean;
  onChange: (
    itemId: string,
    patch: { decision?: MigrationDecision; targetType?: string; targetId?: string },
  ) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="rounded-card border-rule bg-surface border p-4">
      <h2 className="text-ink text-sm font-medium">
        {title} <span className="text-ink-muted">({items.length})</span>
      </h2>
      <ul className="mt-1">
        {items.map((item) => (
          <DecisionRow
            key={item.id}
            item={item}
            targets={targets}
            disabled={busy}
            onChange={(patch) => onChange(item.id, patch)}
          />
        ))}
      </ul>
    </section>
  );
}

function AppliedPanel({
  batch,
  rolledBack,
  busy,
  onRollback,
  error,
}: {
  batch: MigrationBatch;
  rolledBack: RollbackResult | null;
  busy: boolean;
  onRollback: () => void;
  error: unknown;
}) {
  const done = batch.status === 'ROLLED_BACK';
  return (
    <section className="rounded-card border-rule bg-surface border p-4">
      <h2 className="text-ink text-sm font-medium">
        {done ? 'ফিরিয়ে নেওয়া হয়েছে' : 'তৈরি হয়ে গেছে'}
      </h2>
      <p className="text-ink-muted mt-1 text-sm">
        {batch.counts.created}টি তৈরি হয়েছে, {batch.counts.skipped}টি বাদ পড়েছে।
      </p>

      {!done ? (
        <div className="mt-3">
          <Button variant="outline" onClick={onRollback} disabled={busy}>
            <RotateCcw className="h-4 w-4" aria-hidden />
            {busy ? 'ফেরানো হচ্ছে…' : 'পুরোটা ফিরিয়ে নিন'}
          </Button>
        </div>
      ) : null}

      {rolledBack ? (
        <div className="mt-3 text-sm">
          <p className="text-ink">{rolledBack.removed}টি সরানো হয়েছে।</p>
          {rolledBack.kept.length > 0 ? (
            <>
              {/* Kept, with the reason. Silence here would read as "removed". */}
              <p className="text-ink-muted mt-2 flex items-center gap-1.5 text-xs">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                যেগুলো ব্যবহার হয়ে গেছে সেগুলো রেখে দেওয়া হয়েছে:
              </p>
              <ul className="text-ink-muted mt-1 list-inside list-disc text-xs">
                {rolledBack.kept.map((kept) => (
                  <li key={kept.name}>
                    {kept.name} — {kept.reason}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-expense mt-2 text-sm">
          {error instanceof ApiError ? error.message : 'ফেরানো গেল না'}
        </p>
      ) : null}
    </section>
  );
}
