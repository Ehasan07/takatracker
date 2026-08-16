'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  CornerDownRight,
  Info,
  Merge,
  Pencil,
  Plus,
  RotateCw,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import * as React from 'react';
import { t } from '@/lib/t';
import { Skeleton } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { CategoryOptions } from '@/components/category-options';
import { Sheet } from '@/components/ui/sheet';
import { api, ApiError, type CategoryDto } from '@/lib/api';
import { fmtNumber } from '@/lib/format';
import { useDisplayName } from '@/lib/display-name';
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

/** What `POST /categories/:id/move` hands back. */
interface MoveResult {
  movedCount: number;
  deleted: boolean;
  from: { id: string; name: string };
  into: { id: string; name: string };
  /** Bengali, already written by the API. Shown as-is. */
  message: string;
}

const bn = (n: number): string => fmtNumber(String(n));
const usageLabel = (c: CategoryRow): string =>
  c.usageCount > 0 ? `${bn(c.usageCount)}টি লেনদেন` : t('cat.noTransactions', 'কোনো লেনদেন নেই');

export default function CategoriesPage() {
  const queryClient = useQueryClient();
  const { name: nameOf } = useDisplayName();
  const [kind, setKind] = React.useState<Kind>('EXPENSE');
  const [editing, setEditing] = React.useState<CategoryRow | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  /** Set when adding a sub-category, so the sheet knows its parent. */
  const [addUnder, setAddUnder] = React.useState<CategoryRow | null>(null);
  const [deleting, setDeleting] = React.useState<CategoryRow | null>(null);
  /** The খাত whose transactions are being re-filed. `null` closes the sheet. */
  const [moving, setMoving] = React.useState<CategoryRow | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);

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

  const openMove = (category: CategoryRow): void => {
    haptic('tap');
    setMoving(category);
  };

  /**
   * Every khat of the same kind, in the order the list is already in.
   *
   * The picker is built from this and never from the group tree: a sub-খাত is a
   * perfectly good destination — "রিকশা under যাতায়াত" is exactly where somebody
   * folding a stray "CNG" wants it — and a tree-shaped picker would hide half
   * the legal answers. The other kind is not offered at all, because the API
   * refuses it and an option that always errors is a trap, not a choice.
   */
  const sameKind = React.useMemo(
    () => (categories.data ?? []).filter((c) => c.kind === (moving?.kind ?? kind)),
    [categories.data, moving, kind],
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="hidden items-center justify-between gap-2 md:flex">
        <h1 className="text-ink text-2xl font-semibold">{t('cat.title', 'ক্যাটাগরি')}</h1>
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
            ['EXPENSE', t('cat.expense', 'খরচের খাত')],
            ['INCOME', t('cat.income', 'আয়ের খাত')],
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
            <span className="font-medium">
              {t('cat.subHint', 'উপ-খাত হলো বড় খাতের ভেতরের ছোট ভাগ')}
            </span>{' '}
            — যেমন ইউটিলিটির নিচে বিদ্যুৎ, গ্যাস আর পানির বিল। লেনদেন লেখার সময় উপ-খাত বেছে নিলে
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
            {kind === 'EXPENSE'
              ? t('cat.noneExpense', 'এখনও কোনো খরচের খাত নেই।')
              : t('cat.noneIncome', 'এখনও কোনো আয়ের খাত নেই।')}
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
                childCount={children.length}
                deleteBlockedBy={
                  parent.usageCount > 0
                    ? t('cat.hasTransactions', 'এই খাতে লেনদেন আছে')
                    : children.length > 0
                      ? t('cat.deleteChildrenFirst', 'আগে উপ-খাতগুলো মুছুন')
                      : null
                }
                onEdit={() => openEdit(parent)}
                onDelete={() => openDelete(parent)}
                onMove={() => openMove(parent)}
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
                        childCount={0}
                        deleteBlockedBy={
                          child.usageCount > 0
                            ? t('cat.hasTransactions', 'এই খাতে লেনদেন আছে')
                            : null
                        }
                        onEdit={() => openEdit(child)}
                        onDelete={() => openDelete(child)}
                        onMove={() => openMove(child)}
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

      <MoveSheet
        source={moving}
        candidates={sameKind}
        onOpenChange={(open) => {
          if (!open) setMoving(null);
        }}
        onMoved={(result) => setToast(result.message)}
      />

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
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
 *
 * ## Why the trailing control changes rather than doubling
 *
 * Two icons is the ceiling this row can carry, and the two actions are almost
 * never both available anyway: a খাত with history cannot be deleted, and a খাত
 * with no history has nothing to move. So the slot shows whichever one is real.
 *
 * That also repairs the oldest dead end on this screen. The bin used to sit
 * there greyed out with `title="এই খাতে লেনদেন আছে"` — a tooltip, on a phone,
 * where there is no hover — and the API's refusal told people to "আগে সেগুলো
 * অন্য ক্যাটাগরিতে সরান" while offering nowhere to do it. Now the row that
 * cannot be deleted offers the thing that would make it deletable.
 *
 * A parent that still has sub-খাত keeps the disabled bin, because the API
 * refuses to move one too and an enabled button that always errors is worse
 * than a disabled one that says why.
 */
function CategoryLine({
  category,
  meta,
  childCount,
  deleteBlockedBy,
  onEdit,
  onDelete,
  onMove,
  nested = false,
}: {
  category: CategoryRow;
  meta: string;
  /** Live sub-categories. Above zero the server refuses to move this row. */
  childCount: number;
  deleteBlockedBy: string | null;
  onEdit: () => void;
  onDelete: () => void;
  onMove: () => void;
  nested?: boolean;
}) {
  const { name: nameOf } = useDisplayName();
  const canMove = category.usageCount > 0 && childCount === 0;
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
      {canMove ? (
        <button
          type="button"
          aria-label={`${nameOf(category)}-এর লেনদেন অন্য খাতে সরান`}
          title={t('cat.moveTitle', 'লেনদেনগুলো অন্য খাতে সরান')}
          onClick={onMove}
          className="press touch-target text-income hover:bg-greenbar flex shrink-0 items-center justify-center rounded-md"
        >
          <Merge className="h-4 w-4" aria-hidden />
        </button>
      ) : (
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
      )}
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
      <p className="text-ink text-sm">{t('cat.listFailed', 'খাতের তালিকা আনা যায়নি।')}</p>
      <p className="text-ink-muted text-xs">
        {t('common.checkConnectionRetry', 'ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।')}
      </p>
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

/**
 * Said once, at the bottom of the screen, and gone. A local copy of the same
 * six-second banner the tags screen uses, for the reason given above: a feature
 * folder reaching into another one's internals is how a shared module gets
 * created without anybody deciding to create one.
 */
function Toast({
  message,
  onDismiss,
  seconds = 6,
}: {
  message: string;
  onDismiss: () => void;
  seconds?: number;
}) {
  React.useEffect(() => {
    const timer = setTimeout(onDismiss, seconds * 1000);
    return () => clearTimeout(timer);
  }, [seconds, onDismiss, message]);

  return (
    <div
      role="status"
      className="toast-enter bg-ink text-paper no-print fixed inset-x-3 z-40 rounded-lg px-4 py-3 text-sm shadow-xl md:inset-x-auto md:bottom-6 md:right-6 md:w-96"
      style={{ bottom: 'calc(5.5rem + env(safe-area-inset-bottom))' }}
    >
      {message}
    </div>
  );
}

/**
 * Re-file every transaction under one খাত beneath another.
 *
 * ## Why the screen needs this at all
 *
 * The books coming across from the other product have two hundred categories,
 * and a good number of them are the same thing written twice — a "Transport"
 * and a "যাতায়াত", a "Grocery" and a "বাজার". Repairing that one transaction at
 * a time is four hundred taps per pair, so nobody does it, and every spending
 * report is split down the middle by a spelling forever.
 *
 * ## What the sheet is actually for
 *
 * Not the picking — the *saying*. This is a bulk write over a person's whole
 * history, and the only defence against a misfire is that the number and the
 * direction are stated in words before the button, not discovered after it. So
 * the count is spelled out in Bengali digits ("৪১২টি লেনদেন সরানো হবে"), both
 * names appear either side of an arrow, and the sentence nobody would think to
 * ask about — that no money moves — is the last line rather than an omission.
 *
 * The কেবল-একই-ধরন rule is enforced by not offering the other side at all: the
 * API refuses a cross-kind move because it would flip the sign of every amount,
 * and an option that always errors is a trap rather than a choice.
 */
function MoveSheet({
  source,
  candidates,
  onOpenChange,
  onMoved,
}: {
  /** The খাত being emptied. `null` closes the sheet. */
  source: CategoryRow | null;
  /** Every খাত of the same kind, the source included; it is filtered out here. */
  candidates: CategoryRow[];
  onOpenChange: (open: boolean) => void;
  onMoved: (result: MoveResult) => void;
}) {
  const queryClient = useQueryClient();
  const { name: nameOf } = useDisplayName();
  const [toId, setToId] = React.useState('');
  const [deleteAfter, setDeleteAfter] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const sourceId = source?.id ?? null;
  React.useEffect(() => {
    setToId('');
    /* Unticked every time the sheet opens. Deleting a খাত is a second decision
       and it must never be inherited from the last one somebody made. */
    setDeleteAfter(false);
    setError(null);
  }, [sourceId]);

  const targets = candidates.filter((c) => c.id !== sourceId);
  const into = targets.find((c) => c.id === toId) ?? null;

  const move = useMutation({
    mutationFn: (targetId: string) =>
      api<MoveResult>(`/categories/${sourceId}/move`, {
        method: 'POST',
        body: { toCategoryId: targetId, deleteAfter },
      }),
    onSuccess: (result) => {
      haptic('success');
      /* Everything, not just this list: the by-category report, the খাতা's
         chips and the entry sheet's picker all name the খাত that just changed
         under a thousand rows. */
      void queryClient.invalidateQueries();
      onMoved(result);
      onOpenChange(false);
    },
    onError: (err) => {
      haptic('warn');
      setError(err instanceof ApiError ? err.message : t('cat.moveFailed', 'সরানো যায়নি'));
    },
  });

  const fromName = source ? nameOf(source) : '';
  const intoName = into ? nameOf(into) : '';
  const count = source?.usageCount ?? 0;

  return (
    <Sheet
      open={source !== null}
      onOpenChange={onOpenChange}
      title={t('cat.moveTitle', 'লেনদেনগুলো অন্য খাতে সরান')}
      description={source ? fromName : undefined}
    >
      <div className="flex flex-col gap-4">
        <p className="text-ink text-sm">
          একই জিনিসের জন্য দুটো খাত হয়ে গেলে একটিকে অন্যটির ভেতরে নিয়ে আসুন। এই খাতের{' '}
          <span className="font-medium">{bn(count)}টি লেনদেন</span> নতুন খাতে চলে যাবে — টাকার অঙ্ক,
          তারিখ বা অ্যাকাউন্ট কিছুই বদলাবে না।
        </p>

        {targets.length === 0 ? (
          <p className="text-ink-muted text-sm">
            {t('cat.moveNoTarget', 'সরানোর মতো একই ধরনের আর কোনো খাত নেই।')}
          </p>
        ) : (
          <>
            <Field label="কোন খাতে সরাবেন?" htmlFor="cat-move-to">
              <Select
                id="cat-move-to"
                value={toId}
                onChange={(e) => {
                  setError(null);
                  setToId(e.target.value);
                }}
              >
                <option value="">বেছে নিন</option>
                {/* Grouped, like every other category picker in the app. The
                    parent heading is what tells two sub-খাত both called ভাড়া
                    apart, and it says it once per group rather than on every
                    row. `targets` is already this khat's own kind and already
                    excludes itself, so the scope here only has to match. */}
                <CategoryOptions categories={targets} kind={source?.kind ?? 'EXPENSE'} />
              </Select>
            </Field>

            {/* The direction, drawn. A sentence can be misread; an arrow between
                two named boxes cannot. */}
            <div className="rounded-card border-rule bg-greenbar flex items-center gap-2 border p-3">
              <span className="text-ink min-w-0 truncate text-sm line-through">{fromName}</span>
              <ArrowRight className="text-ink-muted h-4 w-4 shrink-0" aria-hidden />
              <span className="text-ink min-w-0 truncate text-sm font-medium">
                {intoName || t('cat.moveWhich', 'কোন খাতে?')}
              </span>
            </div>

            <label className="flex min-h-11 items-center gap-2">
              <input
                type="checkbox"
                checked={deleteAfter}
                onChange={(e) => setDeleteAfter(e.target.checked)}
                className="accent-brand h-5 w-5 shrink-0"
              />
              <span className="text-ink text-sm">
                {t('cat.moveThenDelete', 'সরানোর পর খালি খাতটি মুছে ফেলুন')}
              </span>
            </label>

            {into ? (
              <ul className="text-ink flex list-disc flex-col gap-1.5 pl-5 text-sm">
                <li>
                  <span className="font-medium">{bn(count)}টি লেনদেন</span> সরানো হবে — &ldquo;
                  {fromName}&rdquo; থেকে &ldquo;{intoName}&rdquo;-এ।
                </li>
                <li>
                  প্রতিবেদনে এই খরচগুলো এখন থেকে &ldquo;{intoName}&rdquo;-এর মোটের সঙ্গে যোগ হবে।
                </li>
                {deleteAfter ? (
                  <li>
                    &ldquo;{fromName}&rdquo; খাতটি আর থাকবে না — পুরনো লেনদেন পড়তে অসুবিধা হবে না।
                  </li>
                ) : (
                  <li>&ldquo;{fromName}&rdquo; খাতটি খালি অবস্থায় থেকে যাবে।</li>
                )}
                <li className="text-income">
                  কোনো টাকা সরছে না — কোনো অ্যাকাউন্টের ব্যালেন্স বদলাবে না, কোনো লেনদেন মুছবে না।
                </li>
              </ul>
            ) : (
              <p className="text-ink-muted text-xs">
                {t('cat.movePickFirst', 'উপরে একটি খাত বেছে নিলে ঠিক কী হবে তা এখানে লেখা থাকবে।')}
              </p>
            )}

            {error ? (
              <p role="alert" className="bg-expense/10 text-expense rounded-md px-3 py-2 text-sm">
                {error}
              </p>
            ) : null}

            <Button
              size="block"
              disabled={!into || move.isPending}
              onClick={() => {
                if (!into) return;
                haptic('warn');
                move.mutate(into.id);
              }}
            >
              <Merge className="h-4 w-4" aria-hidden />
              {move.isPending
                ? t('cat.moving', 'সরানো হচ্ছে…')
                : t('cat.moveConfirm', 'সরিয়ে দিন')}
            </Button>
          </>
        )}

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
  /* For naming the parent this খাত will sit under — a name *about* another row,
     so it follows the reader's language. The two boxes below do not: each edits
     one specific column and must show that column. */
  const { name: nameOf } = useDisplayName();
  /* Two boxes, two columns, and neither ever written from the other's value.
     One box that wrote both — `{ name, nameBn: name }` — was fine while every
     screen was Bengali and becomes a data loss as soon as the box can prefill
     with the English name: saving an untouched খাত would overwrite the Bengali
     one with it. */
  const [name, setName] = React.useState('');
  const [nameEn, setNameEn] = React.useState('');
  const [kind, setKind] = React.useState<Kind>(defaultKind);
  /* One box, comma separated, prefilled with whatever is already stored: the API
     replaces the list whole, so a blind save must send back what it was shown. */
  const [aliases, setAliases] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  /* Which head this খাত sits under. Empty string is the top level — a `<select>`
     value can only be a string, and `null` would render as the literal "null". */
  const [parentId, setParentId] = React.useState('');

  /* The same key the page itself uses, so this is the page's cached list rather
     than a second request. */
  const allCategories = useQuery({
    queryKey: ['categories'],
    queryFn: () => api<CategoryRow[]>('/categories'),
    enabled: open,
  });

  /**
   * The heads this row could move under: same kind, top-level, and never
   * itself.
   *
   * Rows that already have children of their own are left out, because the tree
   * is two levels deep on purpose and the API refuses to bury them a third —
   * better to not offer the move than to offer it and fail.
   */
  const hasChildren = React.useMemo(
    () =>
      Boolean(editing) && (allCategories.data ?? []).some((row) => row.parentId === editing!.id),
    [allCategories.data, editing],
  );

  const parentOptions = React.useMemo(() => {
    const rows = allCategories.data ?? [];
    if (!editing || hasChildren) return [];
    return rows
      .filter((row) => row.kind === kind && !row.parentId && row.id !== editing.id)
      .sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'bn'));
  }, [allCategories.data, editing, hasChildren, kind, nameOf]);

  /* Empty means free to flip. A খাত with history cannot change sides — every
     transaction under it was booked with a direction — and one with sub-khat
     would leave them stranded on the side it left. */
  const canFlipKind = Boolean(editing) && editing!.usageCount === 0 && !hasChildren;

  React.useEffect(() => {
    if (!open) return;
    setParentId(editing?.parentId ?? '');
    setName(editing ? (editing.nameBn ?? editing.name) : '');
    /* Empty when the two columns hold the same string — what every খাত the
       user made before this box existed looks like. Showing the Bengali name
       in a box labelled "ইংরেজি নাম" would claim an English name was set. */
    setNameEn(editing && editing.name !== (editing.nameBn ?? editing.name) ? editing.name : '');
    setKind(editing ? (editing.kind as Kind) : parent ? (parent.kind as Kind) : defaultKind);
    setAliases(editing ? (editing.searchAliases ?? []).join(', ') : '');
    setError(null);
  }, [open, editing, parent, defaultKind]);

  /* Switching sides invalidates the chosen parent — the heads listed a moment
     ago all belong to the side being left. Clearing it here means the picker
     below never shows a selection that is no longer in its own options, which
     a `<select>` renders as blank and saves as the top level anyway. */
  React.useEffect(() => {
    if (editing && kind !== editing.kind) setParentId('');
  }, [kind, editing]);

  const save = useMutation({
    mutationFn: () =>
      editing
        ? api(`/categories/${editing.id}`, {
            method: 'PATCH',
            /* No English name given means the two mirror, exactly as every খাত
               made before this box did. `name` is NOT NULL, so it can never be
               written as the empty string. */
            body: {
              name: nameEn.trim() || name,
              nameBn: name,
              searchAliases: aliases,
              /* Only when the side actually changed. Sending the unchanged kind
                 on every save would make the API treat a rename as a flip and
                 resettle the parent for no reason. */
              ...(kind !== editing.kind ? { kind } : {}),
              /* Sent only when the box was offered, so a খাত with children —
                 which has no picker — cannot have its parent cleared by a
                 blind save. `null` is the top level and is meaningful, so it
                 has to go on the wire rather than be dropped as falsy. */
              ...(parentOptions.length > 0 ? { parentId: parentId || null } : {}),
            },
          })
        : api('/categories', {
            method: 'POST',
            body: {
              name: nameEn.trim() || name,
              nameBn: name,
              kind,
              parentId: parent?.id,
              searchAliases: aliases,
            },
          }),
    onSuccess: () => {
      haptic('success');
      void queryClient.invalidateQueries();
      onOpenChange(false);
    },
    onError: (err) =>
      setError(
        err instanceof ApiError ? err.message : t('common.saveFailed2', 'সংরক্ষণ করা যায়নি'),
      ),
  });

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={
        editing
          ? t('cat.edit', 'খাত সম্পাদনা')
          : parent
            ? t('cat.newSub', 'নতুন উপ-খাত')
            : t('cat.new', 'নতুন খাত')
      }
      description={parent ? `${nameOf(parent)}-এর ভেতরে` : undefined}
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
            placeholder={
              parent
                ? t('cat.exampleExpense', 'যেমন: বিদ্যুৎ বিল')
                : t('cat.exampleSub', 'যেমন: গাড়ির তেল')
            }
          />
        </Field>

        <Field label="ইংরেজি নাম (ঐচ্ছিক)" htmlFor="cat-name-en">
          <Input
            id="cat-name-en"
            value={nameEn}
            onChange={(e) => setNameEn(e.target.value)}
            maxLength={60}
            placeholder={parent ? 'Electricity bill' : 'Fuel'}
          />
        </Field>
        <p className="text-ink-muted -mt-2 text-xs">
          অ্যাপ ইংরেজিতে দেখলে এই নামটি দেখাবে। না দিলে উপরের নামটিই থাকবে।
        </p>

        {parent ? (
          <p className="text-ink-muted -mt-2 text-xs">
            এটি{' '}
            {parent.kind === 'INCOME' ? t('cat.incomeAdj', 'আয়ের') : t('cat.expenseAdj', 'খরচের')}{' '}
            খাত {nameOf(parent)}-এর ভেতরে বসবে। প্রতিবেদনে এর খরচ {nameOf(parent)}-এর মোটের সঙ্গেই
            যোগ হবে।
          </p>
        ) : editing ? (
          <>
            {canFlipKind ? (
              <Field label={t('cat.kind', 'ধরন')} htmlFor="cat-kind">
                <Select
                  id="cat-kind"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as Kind)}
                >
                  <option value="EXPENSE">খরচ</option>
                  <option value="INCOME">আয়</option>
                </Select>
                <p className="text-ink-muted mt-1 text-xs">
                  {t(
                    'cat.kindFlipHint',
                    'এই খাতে এখনও কোনো লেনদেন নেই, তাই আয় ↔ খরচ বদলানো যাবে। ধরন বদলালে খাতটি উপরে চলে আসবে।',
                  )}
                </p>
              </Field>
            ) : (
              /* A খাত with history cannot change sides: every transaction under
                 it was booked with a direction, and renaming the side does not
                 turn money that left into money that arrived. */
              <p className="text-ink-muted text-xs">
                {editing.kind === 'INCOME' ? 'আয়ের খাত' : 'খরচের খাত'}। এতে{' '}
                {bn(editing.usageCount)}টি লেনদেন আছে, তাই আয় ↔ খরচ বদলানো যাবে না — আগে লেনদেনগুলো
                অন্য খাতে সরান।
              </p>
            )}
            {parentOptions.length > 0 ? (
              <Field label={t('cat.parent', 'মূল খাত')} htmlFor="cat-parent">
                <Select
                  id="cat-parent"
                  value={parentId}
                  onChange={(e) => setParentId(e.target.value)}
                >
                  <option value="">{t('cat.noParent', 'কোনোটির নিচে নয় (মূল খাত)')}</option>
                  {parentOptions.map((row) => (
                    <option key={row.id} value={row.id}>
                      {nameOf(row)}
                    </option>
                  ))}
                </Select>
                <p className="text-ink-muted mt-1 text-xs">
                  {t(
                    'cat.parentHint',
                    'খাতটি অন্য কোনো খাতের নিচে সরাতে পারেন। আগের লেনদেনগুলো এর সঙ্গেই যাবে, কিছু হারাবে না।',
                  )}
                </p>
              </Field>
            ) : (
              <p className="text-ink-muted text-xs">
                {t(
                  'cat.parentLocked',
                  'এই খাতের নিচে উপ-খাত আছে, তাই একে অন্য খাতের নিচে নেওয়া যায় না। আগে উপ-খাতগুলো সরান।',
                )}
              </p>
            )}
          </>
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
