'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CornerDownRight, Info, Pencil, Plus, RotateCw, Trash2, TriangleAlert } from 'lucide-react';
import * as React from 'react';
import { toBengaliDigits } from '@hishab/shared';
import { Skeleton } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { api, ApiError, type CategoryDto } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';

type Kind = 'INCOME' | 'EXPENSE';

interface CategoryRow extends CategoryDto {
  isSystem: boolean;
  usageCount: number;
  parentId: string | null;
  parentName: string | null;
  /** The extra words that also find this row. Returned on every list response. */
  searchAliases?: string[];
}

/** A top-level category with whatever sits under it. Two levels, never three. */
interface Group {
  parent: CategoryRow;
  children: CategoryRow[];
}

const bn = (n: number): string => toBengaliDigits(String(n));
const nameOf = (c: CategoryRow): string => c.nameBn ?? c.name;
const usageLabel = (c: CategoryRow): string =>
  c.usageCount > 0 ? `${bn(c.usageCount)}টি লেনদেন` : 'কোনো লেনদেন নেই';

export default function CategoriesPage() {
  const queryClient = useQueryClient();
  const [kind, setKind] = React.useState<Kind>('EXPENSE');
  const [editing, setEditing] = React.useState<CategoryRow | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  /** Set when adding a sub-category, so the sheet knows its parent. */
  const [addUnder, setAddUnder] = React.useState<CategoryRow | null>(null);
  const [deleting, setDeleting] = React.useState<CategoryRow | null>(null);

  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => api<CategoryRow[]>('/categories'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/categories/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      haptic('success');
      setDeleting(null);
      void queryClient.invalidateQueries();
    },
    /* A category with history, or one that still has sub-categories, cannot be
       deleted. The API says which in Bengali; the sheet stays open and repeats it
       rather than closing over a failure. */
  });

  /* Grouped rather than flattened: a parent and its children are one card, so a
     parent that has none is visibly a parent with none — not a leaf. */
  const groups = React.useMemo<Group[]>(() => {
    const all = (categories.data ?? []).filter((c) => c.kind === kind);
    return all
      .filter((c) => !c.parentId)
      .map((parent) => ({
        parent,
        children: all.filter((c) => c.parentId === parent.id),
      }));
  }, [categories.data, kind]);

  const openAddUnder = (parent: CategoryRow): void => {
    haptic('tap');
    setAddUnder(parent);
  };

  const openEdit = (category: CategoryRow): void => {
    haptic('tap');
    setEditing(category);
  };

  const openDelete = (category: CategoryRow): void => {
    haptic('tap');
    remove.reset();
    setDeleting(category);
  };

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
              // 44px, like every other target on the screen.
              kind === value
                ? 'press bg-surface text-ink min-h-11 rounded-md text-sm font-semibold shadow-sm'
                : 'press text-ink-muted min-h-11 rounded-md text-sm'
            }
          >
            {label}
          </button>
        ))}
      </div>

      {/* Said once, at the top: what the second level is for and why there is no
          third. Nobody who has not used sub-categories knows either. */}
      <div className="rounded-card border-rule bg-greenbar border p-3.5">
        <p className="text-ink flex items-start gap-2 text-sm">
          <Info className="text-income mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            <span className="font-medium">উপ-খাত হলো বড় খাতের ভেতরের ছোট ভাগ</span> — যেমন
            ইউটিলিটির নিচে বিদ্যুৎ, গ্যাস আর পানির বিল। লেনদেন লেখার সময় উপ-খাত বেছে নিলে
            প্রতিবেদনে খরচটি বড় খাতের মোটের সঙ্গেই যোগ হয়, আবার চাইলে ভেঙে দেখা যায়। ভাগ দুই ধাপ
            পর্যন্তই — উপ-খাতের নিচে আর উপ-খাত রাখা যায় না।
          </span>
        </p>
      </div>

      {categories.isError ? (
        <QueryError onRetry={() => void categories.refetch()} />
      ) : categories.isLoading ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-card border-rule bg-surface border p-3">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="mt-2 h-3 w-3/5" />
              <Skeleton className="mt-4 h-4 w-1/3" />
            </div>
          ))}
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-card border-rule border border-dashed p-8 text-center">
          <p className="text-ink">
            {kind === 'EXPENSE' ? 'এখনও কোনো খরচের খাত নেই।' : 'এখনও কোনো আয়ের খাত নেই।'}
          </p>
          <Button className="mt-3" onClick={() => setAddOpen(true)}>
            প্রথম খাত যোগ করুন
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {groups.map(({ parent, children }) => (
            <li
              key={parent.id}
              className="rounded-card border-rule bg-surface overflow-hidden border"
            >
              <CategoryLine
                category={parent}
                /* The count only when there is one to give: at 320px a second
                   clause truncates, and "no sub-categories" is already said by
                   the invitation at the foot of the card. */
                meta={
                  children.length > 0
                    ? `${bn(children.length)}টি উপ-খাত · ${usageLabel(parent)}`
                    : usageLabel(parent)
                }
                deleteBlockedBy={
                  parent.usageCount > 0
                    ? 'এই খাতে লেনদেন আছে'
                    : children.length > 0
                      ? 'আগে উপ-খাতগুলো মুছুন'
                      : null
                }
                onEdit={() => openEdit(parent)}
                onDelete={() => openDelete(parent)}
              />

              {children.length > 0 ? (
                /* The rail is the point: at 320px an indent on its own is a few
                   pixels of whitespace nobody reads as nesting. */
                <ul className="border-rule ml-4 border-l">
                  {children.map((child) => (
                    <li key={child.id} className="border-rule border-t">
                      <CategoryLine
                        category={child}
                        meta={`উপ-খাত · ${usageLabel(child)}`}
                        deleteBlockedBy={child.usageCount > 0 ? 'এই খাতে লেনদেন আছে' : null}
                        onEdit={() => openEdit(child)}
                        onDelete={() => openDelete(child)}
                        nested
                      />
                    </li>
                  ))}
                </ul>
              ) : null}

              {/* The whole reason this screen was rewritten. It used to be a bare
                  `+` whose only label was a tooltip, which on a phone is nothing
                  at all — the feature existed and could not be found. */}
              <button
                type="button"
                aria-label={`${nameOf(parent)}-এ উপ-খাত যোগ করুন`}
                onClick={() => openAddUnder(parent)}
                className="press border-rule text-income hover:bg-greenbar flex min-h-11 w-full items-center gap-2 border-t border-dashed px-3 text-left text-sm font-medium"
              >
                <Plus className="h-4 w-4 shrink-0" aria-hidden />
                উপ-খাত যোগ করুন
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* The phone has no header, so its way to a new top-level khat is here. */}
      <Button className="md:hidden" onClick={() => setAddOpen(true)}>
        <Plus className="h-4 w-4" aria-hidden />
        নতুন খাত যোগ করুন
      </Button>

      <CategorySheet
        open={addOpen || editing !== null || addUnder !== null}
        editing={editing}
        parent={addUnder}
        defaultKind={kind}
        onOpenChange={(open) => {
          if (!open) {
            setAddOpen(false);
            setEditing(null);
            setAddUnder(null);
          }
        }}
      />

      <ConfirmSheet
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="খাতটি মুছে ফেলবেন?"
        description={deleting ? nameOf(deleting) : undefined}
        body={
          deleting?.parentId
            ? 'উপ-খাতটি তালিকা থেকে সরে যাবে এবং নতুন লেনদেনের ঘরে আর বেছে নেওয়া যাবে না। এতে কোনো লেনদেন নেই, তাই কোনো হিসাব বদলাবে না।'
            : 'খাতটি তালিকা থেকে সরে যাবে এবং নতুন লেনদেনের ঘরে আর বেছে নেওয়া যাবে না। এতে কোনো লেনদেন বা উপ-খাত নেই, তাই কোনো হিসাব বদলাবে না।'
        }
        confirmLabel="মুছে ফেলুন"
        pending={remove.isPending}
        error={remove.error ? remove.error.message : null}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
      />
    </div>
  );
}

/**
 * One category, parent or child.
 *
 * The name block is the edit button, the way an account row is: a third icon
 * would leave nothing of the name at 320px. `nested` adds the arrow and the
 * indent that mark a child — the "উপ-খাত" in `meta` says it in words, because
 * neither an arrow nor an indent survives a glance on a small phone.
 */
function CategoryLine({
  category,
  meta,
  deleteBlockedBy,
  onEdit,
  onDelete,
  nested = false,
}: {
  category: CategoryRow;
  meta: string;
  deleteBlockedBy: string | null;
  onEdit: () => void;
  onDelete: () => void;
  nested?: boolean;
}) {
  return (
    <div className={cn('flex items-center gap-1 px-2 py-1.5', nested && 'pl-1')}>
      {nested ? (
        <CornerDownRight className="text-ink-muted h-3.5 w-3.5 shrink-0" aria-hidden />
      ) : null}
      <button
        type="button"
        aria-label={`${nameOf(category)} সম্পাদনা`}
        onClick={onEdit}
        className="press hover:bg-greenbar flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left"
      >
        <span className="min-w-0 flex-1">
          <span
            className={cn('text-ink block truncate', nested ? 'text-sm' : 'text-sm font-medium')}
          >
            {nameOf(category)}
          </span>
          <span className="text-ink-muted block truncate text-xs">{meta}</span>
        </span>
        <Pencil className="text-ink-muted h-3.5 w-3.5 shrink-0" aria-hidden />
      </button>
      <button
        type="button"
        aria-label={`${nameOf(category)} মুছুন`}
        disabled={deleteBlockedBy !== null}
        title={deleteBlockedBy ?? undefined}
        onClick={onDelete}
        className="press touch-target text-expense hover:bg-greenbar flex shrink-0 items-center justify-center rounded-md disabled:opacity-30"
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

/**
 * Local copies of two patterns that also live in `(shell)/loans/parts.tsx` and
 * `(shell)/accounts/page.tsx`. Duplicated on purpose: a feature folder importing
 * another feature folder's internals is how a de-facto shared module gets created
 * without anyone deciding to create one.
 */
function QueryError({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="rounded-card border-rule bg-surface flex flex-col items-center gap-2 border border-dashed p-6 text-center"
    >
      <TriangleAlert className="text-expense h-6 w-6" aria-hidden />
      <p className="text-ink text-sm">খাতের তালিকা আনা যায়নি।</p>
      <p className="text-ink-muted text-xs">ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।</p>
      <Button variant="outline" size="sm" className="mt-1" onClick={onRetry}>
        <RotateCw className="h-4 w-4" aria-hidden />
        আবার চেষ্টা করুন
      </Button>
    </div>
  );
}

/** Deleting asks first — as a sheet, not a modal. `error` is what the API said. */
function ConfirmSheet({
  open,
  onOpenChange,
  title,
  description,
  body,
  confirmLabel,
  onConfirm,
  pending = false,
  error = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
  error?: string | null;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title} description={description}>
      <div className="flex flex-col gap-4">
        <p className="text-ink text-sm">{body}</p>
        {error ? (
          <p role="alert" className="bg-expense/10 text-expense rounded-md px-3 py-2 text-sm">
            {error}
          </p>
        ) : null}
        <Button
          variant="danger"
          size="block"
          disabled={pending}
          onClick={() => {
            haptic('warn');
            onConfirm();
          }}
        >
          {confirmLabel}
        </Button>
        <Button variant="outline" size="block" onClick={() => onOpenChange(false)}>
          থাক
        </Button>
      </div>
    </Sheet>
  );
}

function CategorySheet({
  open,
  editing,
  parent,
  defaultKind,
  onOpenChange,
}: {
  open: boolean;
  editing: CategoryRow | null;
  parent: CategoryRow | null;
  defaultKind: Kind;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState('');
  const [kind, setKind] = React.useState<Kind>(defaultKind);
  /* One box, comma separated, prefilled with whatever is already stored: the API
     replaces the list whole, so a blind save must send back what it was shown. */
  const [aliases, setAliases] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setName(editing ? (editing.nameBn ?? editing.name) : '');
    setKind(editing ? (editing.kind as Kind) : parent ? (parent.kind as Kind) : defaultKind);
    setAliases(editing ? (editing.searchAliases ?? []).join(', ') : '');
    setError(null);
  }, [open, editing, parent, defaultKind]);

  const save = useMutation({
    mutationFn: () =>
      editing
        ? api(`/categories/${editing.id}`, {
            method: 'PATCH',
            body: { name, nameBn: name, searchAliases: aliases },
          })
        : api('/categories', {
            method: 'POST',
            body: { name, nameBn: name, kind, parentId: parent?.id, searchAliases: aliases },
          }),
    onSuccess: () => {
      haptic('success');
      void queryClient.invalidateQueries();
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'সংরক্ষণ করা যায়নি'),
  });

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? 'খাত সম্পাদনা' : parent ? 'নতুন উপ-খাত' : 'নতুন খাত'}
      description={parent ? `${parent.nameBn ?? parent.name}-এর ভেতরে` : undefined}
    >
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
            placeholder={parent ? 'যেমন: বিদ্যুৎ বিল' : 'যেমন: গাড়ির তেল'}
          />
        </Field>

        {parent ? (
          <p className="text-ink-muted -mt-2 text-xs">
            এটি {parent.kind === 'INCOME' ? 'আয়ের' : 'খরচের'} খাত {parent.nameBn ?? parent.name}-এর
            ভেতরে বসবে। প্রতিবেদনে এর খরচ {parent.nameBn ?? parent.name}-এর মোটের সঙ্গেই যোগ হবে।
          </p>
        ) : editing ? (
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

        {/* Deliberately not labelled "খোঁজার নাম": two boxes whose labels both
            contain "নাম" is one box too many to tell apart at a glance. */}
        <Field label="খোঁজার শব্দ" htmlFor="cat-aliases">
          <Input
            id="cat-aliases"
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder="যেমন: rickshaw, uber, সিএনজি"
          />
        </Field>
        <p className="text-ink-muted -mt-2 text-xs">
          এই শব্দগুলো দিয়েও খাতটি খুঁজে পাওয়া যাবে। নিজের মতো নাম দিলে পুরনো বা ইংরেজি বানানটি
          এখানে রাখুন। কমা দিয়ে আলাদা করুন।
        </p>

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
