'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import { toBengaliDigits } from '@hishab/shared';
import { SkeletonRows } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { api, ApiError, type CategoryDto } from '@/lib/api';
import { haptic } from '@/lib/haptics';

type Kind = 'INCOME' | 'EXPENSE';

interface CategoryRow extends CategoryDto {
  isSystem: boolean;
  usageCount: number;
}

export default function CategoriesPage() {
  const queryClient = useQueryClient();
  const [kind, setKind] = React.useState<Kind>('EXPENSE');
  const [editing, setEditing] = React.useState<CategoryRow | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => api<CategoryRow[]>('/categories'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/categories/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      haptic('success');
      setError(null);
      void queryClient.invalidateQueries();
    },
    // A category with history cannot be deleted; say why rather than failing mutely.
    onError: (err) => setError(err instanceof ApiError ? err.message : 'মুছে ফেলা যায়নি'),
  });

  const rows = (categories.data ?? []).filter((c) => c.kind === kind);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="hidden items-center justify-between gap-2 md:flex">
        <h1 className="text-ink text-2xl font-semibold">ক্যাটাগরি</h1>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4" aria-hidden />
          নতুন
        </Button>
      </header>

      <div
        role="tablist"
        aria-label="ধরন"
        className="bg-greenbar grid grid-cols-2 gap-1 rounded-lg p-1"
      >
        {(
          [
            ['EXPENSE', 'খরচের খাত'],
            ['INCOME', 'আয়ের খাত'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={kind === value}
            onClick={() => {
              haptic('tap');
              setKind(value);
            }}
            className={
              kind === value
                ? 'press bg-surface text-ink min-h-10 rounded-md text-sm font-semibold shadow-sm'
                : 'press text-ink-muted min-h-10 rounded-md text-sm'
            }
          >
            {label}
          </button>
        ))}
      </div>

      {error ? (
        <p role="alert" className="bg-expense/10 text-expense rounded-md px-3 py-2 text-sm">
          {error}
        </p>
      ) : null}

      {categories.isLoading ? (
        <div className="rounded-card border-rule bg-surface overflow-hidden border">
          <SkeletonRows rows={6} />
        </div>
      ) : (
        <ul className="rounded-card border-rule bg-surface overflow-hidden border">
          {rows.map((category) => (
            <li
              key={category.id}
              className="ledger-row border-rule flex items-center gap-2 border-b px-3 py-2.5 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <p className="text-ink truncate text-sm">{category.nameBn ?? category.name}</p>
                <p className="text-ink-muted truncate text-xs">
                  {category.usageCount > 0
                    ? `${toBengaliDigits(String(category.usageCount))}টি লেনদেন`
                    : 'কোনো লেনদেন নেই'}
                </p>
              </div>
              <button
                type="button"
                aria-label={`${category.nameBn ?? category.name} সম্পাদনা`}
                onClick={() => setEditing(category)}
                className="press touch-target text-ink-muted hover:bg-greenbar flex items-center justify-center rounded-md"
              >
                <Pencil className="h-4 w-4" aria-hidden />
              </button>
              <button
                type="button"
                aria-label={`${category.nameBn ?? category.name} মুছুন`}
                disabled={category.usageCount > 0}
                title={category.usageCount > 0 ? 'এই খাতে লেনদেন আছে' : undefined}
                onClick={() => remove.mutate(category.id)}
                className="press touch-target text-expense hover:bg-greenbar flex items-center justify-center rounded-md disabled:opacity-30"
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* The phone reaches this through the floating button below. */}
      <Button className="md:hidden" onClick={() => setAddOpen(true)}>
        <Plus className="h-4 w-4" aria-hidden />
        নতুন খাত যোগ করুন
      </Button>

      <CategorySheet
        open={addOpen || editing !== null}
        editing={editing}
        defaultKind={kind}
        onOpenChange={(open) => {
          if (!open) {
            setAddOpen(false);
            setEditing(null);
          }
        }}
      />
    </div>
  );
}

function CategorySheet({
  open,
  editing,
  defaultKind,
  onOpenChange,
}: {
  open: boolean;
  editing: CategoryRow | null;
  defaultKind: Kind;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState('');
  const [kind, setKind] = React.useState<Kind>(defaultKind);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setName(editing ? (editing.nameBn ?? editing.name) : '');
    setKind(editing ? (editing.kind as Kind) : defaultKind);
    setError(null);
  }, [open, editing, defaultKind]);

  const save = useMutation({
    mutationFn: () =>
      editing
        ? api(`/categories/${editing.id}`, {
            method: 'PATCH',
            body: { name, nameBn: name },
          })
        : api('/categories', { method: 'POST', body: { name, nameBn: name, kind } }),
    onSuccess: () => {
      haptic('success');
      void queryClient.invalidateQueries();
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'সংরক্ষণ করা যায়নি'),
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={editing ? 'খাত সম্পাদনা' : 'নতুন খাত'}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <Field label="নাম" htmlFor="cat-name">
          <Input
            id="cat-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
            placeholder="যেমন: গাড়ির তেল"
          />
        </Field>

        {editing ? (
          /* Flipping a category from expense to income would silently invert
             every transaction already filed under it. */
          <p className="text-ink-muted text-xs">
            ধরন বদলানো যায় না ({editing.kind === 'INCOME' ? 'আয়' : 'খরচ'})। অন্য ধরন লাগলে নতুন
            খাত বানান।
          </p>
        ) : (
          <Field label="ধরন" htmlFor="cat-kind">
            <Select id="cat-kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              <option value="EXPENSE">খরচ</option>
              <option value="INCOME">আয়</option>
            </Select>
          </Field>
        )}

        {error ? (
          <p role="alert" className="text-expense text-sm">
            {error}
          </p>
        ) : null}

        <Button type="submit" size="block" disabled={save.isPending}>
          সংরক্ষণ করুন
        </Button>
      </form>
    </Sheet>
  );
}
