'use client';

/**
 * The tag screen.
 *
 * A tag is not a second category, and this screen has to keep saying so. The
 * category answers *what the money went on* — খাবার ও বাজার — and there is one
 * per transaction. A tag answers *who for* or *what project* — পারিবারিক,
 * শ্বশুরবাড়ি, রমজান, গাড়ি — and a transaction carries as many as the truth
 * needs. Somebody who cannot tell the two apart will make খাবার-পারিবারিক a
 * tag, and from then on neither report answers anything. So the distinction is
 * printed at the top, repeated in the picker, and shown by the numbers on every
 * row: a tag's money is a *cut through* the ledger, not a slice of it.
 *
 * Two actions here are more delicate than they look.
 *
 * **Delete** is safe and does not feel safe. A tag on three hundred
 * transactions is a word somebody typed once and now cannot get rid of; the API
 * detaches it and destroys nothing, and it returns the exact count so that this
 * screen can say so *before* the button is pressed rather than after.
 *
 * **Merge** is the feature people need and never find. Everybody ends up with
 * both পরিবার and পারিবারিক. It is a labelled row on every tag card, not an
 * item in a menu, because a feature reachable only through an overflow icon on
 * a phone is a feature that does not exist.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info, Merge, Pencil, Plus, Search, Tag as TagIcon, Trash2 } from 'lucide-react';
import * as React from 'react';
import { toBengaliDigits } from '@hishab/shared';
import { Money } from '@/components/money';
import { Skeleton } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { ApiError, api } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { useDisplayName } from '@/lib/display-name';
import { MergeSheet, mergeMessage } from './merge-sheet';
import { ConfirmSheet, QueryError, TagDot, Toast } from './parts';
import { fetchTags, invalidateTagData, tagKeys } from './queries';
import { TagSheet } from './tag-sheet';
import { type DeleteTagResult, type TagDto } from './types';

const bn = (value: number | string): string => toBengaliDigits(String(value));

const countLabel = (tag: TagDto): string =>
  tag.transactionCount > 0 ? `${bn(tag.transactionCount)}টি লেনদেন` : 'কোনো লেনদেন নেই';

export default function TagsPage() {
  const queryClient = useQueryClient();
  const { name: nameOf } = useDisplayName();

  const [typed, setTyped] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [addOpen, setAddOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<TagDto | null>(null);
  const [merging, setMerging] = React.useState<TagDto | null>(null);
  const [deleting, setDeleting] = React.useState<TagDto | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);

  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);

  /* The unfiltered list is always loaded: it is what the merge sheet chooses a
     survivor from, and a search that hid half the workspace's tags would offer
     to merge into only the ones matching the same word. */
  const all = useQuery({ queryKey: tagKeys.list(''), queryFn: () => fetchTags('') });
  const found = useQuery({
    queryKey: tagKeys.list(query),
    queryFn: () => fetchTags(query),
    enabled: query !== '',
    placeholderData: (previous) => previous,
  });

  const active = query === '' ? all : found;
  const rows = (query === '' ? all.data : found.data) ?? [];
  const everything = all.data ?? [];

  const remove = useMutation({
    mutationFn: (id: string) => api<DeleteTagResult>(`/tags/${id}`, { method: 'DELETE' }),
    onSuccess: (result) => {
      haptic('success');
      setDeleting(null);
      /* The tag came off live transactions, so the khata's chips and the by-tag
         report are stale, not just this list. */
      invalidateTagData(queryClient);
      setToast(result.message);
    },
    /* The sheet stays open and repeats whatever the API said, in Bengali. */
  });

  const openEdit = (tag: TagDto): void => {
    haptic('tap');
    setEditing(tag);
  };

  const openMerge = (tag: TagDto): void => {
    haptic('tap');
    setMerging(tag);
  };

  const openDelete = (tag: TagDto): void => {
    haptic('tap');
    remove.reset();
    setDeleting(tag);
  };

  const closeSheets = (open: boolean): void => {
    if (open) return;
    setAddOpen(false);
    setEditing(null);
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="hidden items-center justify-between gap-2 md:flex">
        <h1 className="text-ink text-2xl font-semibold">ট্যাগ</h1>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4" aria-hidden />
          নতুন
        </Button>
      </header>

      {/* Said once, at the top, and never assumed. Without it the first tag
          somebody makes is "খাবার", and then there are two category systems. */}
      <div className="rounded-card border-rule bg-greenbar border p-3.5">
        <p className="text-ink flex items-start gap-2 text-sm">
          <Info className="text-income mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            <span className="font-medium">ক্যাটাগরি বলে কীসে খরচ, ট্যাগ বলে কার জন্য</span> —
            বাজারের খরচ ক্যাটাগরিতে &ldquo;খাবার ও বাজার&rdquo;, আর ট্যাগে &ldquo;পারিবারিক&rdquo;
            বা &ldquo;শ্বশুরবাড়ি&rdquo;। একটি লেনদেনে ক্যাটাগরি একটাই থাকে, কিন্তু ট্যাগ যত খুশি —
            একই বাজার এই সপ্তাহে পারিবারিক, পরের সপ্তাহে ব্যবসার।
          </span>
        </p>
      </div>

      <div className="relative">
        <Search
          className="text-ink-muted pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
          aria-hidden
        />
        <Input
          aria-label="ট্যাগ খুঁজুন"
          placeholder="খুঁজুন… (বাংলা, English বা banglish)"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          type="search"
          enterKeyHint="search"
          className="pl-9"
        />
      </div>

      {active.isError ? (
        <QueryError message="ট্যাগের তালিকা আনা যায়নি।" onRetry={() => void active.refetch()} />
      ) : active.isLoading ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-card border-rule bg-surface border p-3">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="mt-2 h-3 w-3/5" />
              <Skeleton className="mt-4 h-4 w-1/3" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-card border-rule border border-dashed p-8 text-center">
          {query === '' ? (
            <>
              <TagIcon className="text-ink-muted mx-auto h-6 w-6" aria-hidden />
              <p className="text-ink mt-2">এখনও কোনো ট্যাগ নেই।</p>
              <p className="text-ink-muted mt-1 text-sm">
                প্রথম ট্যাগটি বানান — যেমন পারিবারিক, শ্বশুরবাড়ি বা রমজান।
              </p>
              <Button className="mt-3" onClick={() => setAddOpen(true)}>
                প্রথম ট্যাগ বানান
              </Button>
            </>
          ) : (
            <>
              <p className="text-ink">&ldquo;{query}&rdquo; নামে কোনো ট্যাগ পাওয়া যায়নি।</p>
              <p className="text-ink-muted mt-1 text-sm">
                অন্য বানানে খুঁজে দেখুন, অথবা এই নামে নতুন ট্যাগ বানান।
              </p>
              <Button className="mt-3" onClick={() => setAddOpen(true)}>
                নতুন ট্যাগ
              </Button>
            </>
          )}
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((tag) => (
            <li key={tag.id} className="rounded-card border-rule bg-surface overflow-hidden border">
              <div className="flex items-center gap-1 px-2 py-1.5">
                <button
                  type="button"
                  aria-label={`${nameOf(tag)} সম্পাদনা`}
                  onClick={() => openEdit(tag)}
                  className="press hover:bg-greenbar flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <TagDot color={tag.color} />
                      <span className="text-ink truncate text-sm font-medium">{nameOf(tag)}</span>
                    </span>
                    <span className="text-ink-muted block truncate text-xs">
                      {countLabel(tag)}
                      {tag.incomeMinor > 0 && tag.expenseMinor > 0 ? ' · আয় ও খরচ দুটোই আছে' : ''}
                    </span>
                    {tag.searchAliases.length > 0 ? (
                      <span className="text-ink-muted block truncate text-xs">
                        খোঁজার শব্দ: {tag.searchAliases.join(', ')}
                      </span>
                    ) : null}
                  </span>

                  {/* Net, because a tag like গাড়ি genuinely has both sides — the
                      fuel every month and the day it was sold. */}
                  <Money
                    minor={tag.netMinor}
                    colored
                    signed
                    decimals={false}
                    className="shrink-0 text-sm"
                  />
                  <Pencil className="text-ink-muted h-3.5 w-3.5 shrink-0" aria-hidden />
                </button>

                <button
                  type="button"
                  aria-label={`${nameOf(tag)} ট্যাগটি সরান`}
                  onClick={() => openDelete(tag)}
                  className="press touch-target text-expense hover:bg-greenbar flex shrink-0 items-center justify-center rounded-md"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>

              {/* Labelled, on the card, one tap away. An overflow menu is where
                  this feature goes to be never found. */}
              <button
                type="button"
                disabled={everything.length < 2}
                title={everything.length < 2 ? 'মেলানোর মতো আর কোনো ট্যাগ নেই' : undefined}
                onClick={() => openMerge(tag)}
                className="press border-rule text-income hover:bg-greenbar flex min-h-11 w-full items-center gap-2 border-t border-dashed px-3 text-left text-sm font-medium disabled:opacity-40"
              >
                <Merge className="h-4 w-4 shrink-0" aria-hidden />
                অন্য ট্যাগের সাথে মেলান
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* The phone has no header, so its way to a new tag is here. */}
      <Button className="md:hidden" onClick={() => setAddOpen(true)}>
        <Plus className="h-4 w-4" aria-hidden />
        নতুন ট্যাগ যোগ করুন
      </Button>

      <TagSheet open={addOpen || editing !== null} editing={editing} onOpenChange={closeSheets} />

      <MergeSheet
        source={merging}
        tags={everything}
        onOpenChange={(open) => {
          if (!open) setMerging(null);
        }}
        onMerged={(result) => setToast(mergeMessage(result))}
      />

      <ConfirmSheet
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="ট্যাগটি সরাবেন?"
        description={deleting ? nameOf(deleting) : undefined}
        body={
          deleting ? (
            <div className="flex flex-col gap-2">
              <p>
                {deleting.transactionCount > 0 ? (
                  <>
                    এই ট্যাগটি এখন{' '}
                    <span className="font-medium">{bn(deleting.transactionCount)}টি লেনদেনে</span>{' '}
                    আছে। ট্যাগটি সেগুলো থেকে সরে যাবে।
                  </>
                ) : (
                  'এই ট্যাগটি কোনো লেনদেনে নেই।'
                )}
              </p>
              {/* The reassurance somebody actually wants at this moment, said in
                  as many words rather than implied by the absence of a warning. */}
              <p className="text-income font-medium">
                একটি লেনদেনও মুছে যাবে না — টাকার অঙ্ক, খাত, তারিখ, রসিদ, কিছুই বদলাবে না। অন্য
                ট্যাগগুলোও যেমন আছে তেমনই থাকবে।
              </p>
              {deleting.transactionCount > 0 ? (
                <p className="text-ink-muted">
                  একই জিনিস বোঝাতে অন্য কোনো ট্যাগ থাকলে মোছার বদলে মিলিয়ে নিন — তাহলে এই{' '}
                  {bn(deleting.transactionCount)}টি লেনদেন সেই ট্যাগে চলে যাবে, হারাবে না।
                </p>
              ) : null}
            </div>
          ) : null
        }
        confirmLabel="সরিয়ে দিন"
        pending={remove.isPending}
        error={
          remove.error
            ? remove.error instanceof ApiError
              ? remove.error.message
              : 'সরানো যায়নি'
            : null
        }
        secondary={
          deleting && deleting.transactionCount > 0 && everything.length > 1
            ? {
                label: 'বরং অন্য ট্যাগে মিলিয়ে নিন',
                icon: <Merge className="h-4 w-4" aria-hidden />,
                onClick: () => {
                  const target = deleting;
                  setDeleting(null);
                  setMerging(target);
                },
              }
            : undefined
        }
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
      />

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </div>
  );
}
