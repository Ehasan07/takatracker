'use client';

/**
 * Fold one tag into another.
 *
 * Everybody eventually has both পরিবার and পারিবারিক and means the same thing
 * by each. Without this the only repair is opening every transaction and
 * re-tagging it by hand, which nobody does — so both live on and every by-tag
 * report is quietly split down the middle by a spelling.
 *
 * The screen's whole job is to make the *direction* impossible to misread. Both
 * names appear in every sentence, in the order the merge will happen, and the
 * three consequences are stated before the button rather than discovered after
 * it: the transactions move, the old name survives as a search word, the old
 * tag goes. And the fourth, which is the one somebody is actually worried
 * about: no transaction is deleted.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Merge } from '@/components/icons';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { ApiError, api } from '@/lib/api';
import { fmtNumber } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import { useDisplayName } from '@/lib/display-name';
import { TagDot } from './parts';
import { invalidateTagData } from './queries';
import { type MergeTagResult, type TagDto } from './types';

const bn = (value: number | string): string => fmtNumber(String(value));

export function MergeSheet({
  source,
  tags,
  onOpenChange,
  onMerged,
}: {
  /** The tag that will disappear. `null` closes the sheet. */
  source: TagDto | null;
  /** Every tag in the workspace; the survivor is chosen from these. */
  tags: TagDto[];
  onOpenChange: (open: boolean) => void;
  onMerged: (result: MergeTagResult) => void;
}) {
  const queryClient = useQueryClient();
  const { name: nameOf } = useDisplayName();
  const [intoId, setIntoId] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const sourceId = source?.id ?? null;
  React.useEffect(() => {
    setIntoId('');
    setError(null);
  }, [sourceId]);

  const candidates = tags.filter((tag) => tag.id !== sourceId);
  const into = candidates.find((tag) => tag.id === intoId) ?? null;

  const merge = useMutation({
    mutationFn: (targetId: string) =>
      api<MergeTagResult>(`/tags/${sourceId}/merge`, {
        method: 'POST',
        body: { intoTagId: targetId },
      }),
    onSuccess: (result) => {
      haptic('success');
      /* Join rows moved, so the khata's chips and the by-tag report are both
         wrong until they refetch — not only this list. */
      invalidateTagData(queryClient);
      onMerged(result);
      onOpenChange(false);
    },
    onError: (err) => {
      haptic('warn');
      setError(err instanceof ApiError ? err.message : 'মেলানো যায়নি');
    },
  });

  const fromName = source ? nameOf(source) : '';
  const intoName = into ? nameOf(into) : '';

  return (
    <Sheet
      open={source !== null}
      onOpenChange={onOpenChange}
      title="ট্যাগ মেলান"
      description={source ? `"${fromName}" অন্য একটি ট্যাগের সাথে` : undefined}
    >
      <div className="flex flex-col gap-4">
        <p className="text-ink text-sm">
          একই জিনিস বোঝাতে দুটো ট্যাগ হয়ে গেলে সেগুলো এক করে নিন — যেমন{' '}
          <span className="font-medium">পরিবার</span> আর{' '}
          <span className="font-medium">পারিবারিক</span>। দুটো আলাদা থাকলে প্রতিবেদনে একই খরচ দুই
          ভাগে ভাগ হয়ে যায়।
        </p>

        {candidates.length === 0 ? (
          <p className="text-ink-muted text-sm">
            মেলানোর মতো আর কোনো ট্যাগ নেই — এটিই একমাত্র ট্যাগ।
          </p>
        ) : (
          <>
            <Field label="কোন ট্যাগের সাথে মেলাবেন?" htmlFor="merge-into">
              <Select
                id="merge-into"
                value={intoId}
                onChange={(e) => {
                  setError(null);
                  setIntoId(e.target.value);
                }}
              >
                <option value="">বেছে নিন</option>
                {candidates.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {nameOf(tag)}
                    {tag.transactionCount > 0 ? ` — ${bn(tag.transactionCount)}টি লেনদেন` : ''}
                  </option>
                ))}
              </Select>
            </Field>

            {/* The direction, drawn. A sentence can be misread; an arrow between
                two named chips cannot. */}
            <div className="rounded-card border-rule bg-greenbar flex items-center gap-2 border-[1.5px] p-3">
              <span className="text-ink flex min-w-0 items-center gap-1.5 text-sm">
                <TagDot color={source?.color ?? null} />
                <span className="truncate line-through">{fromName}</span>
              </span>
              <ArrowRight className="text-ink-muted h-4 w-4 shrink-0" aria-hidden />
              <span className="text-ink flex min-w-0 items-center gap-1.5 text-sm font-medium">
                <TagDot color={into?.color ?? null} />
                <span className="truncate">{intoName || 'কোন ট্যাগ?'}</span>
              </span>
            </div>

            {into && source ? (
              <ul className="text-ink flex list-disc flex-col gap-1.5 pl-5 text-sm">
                <li>
                  <span className="font-medium">&ldquo;{fromName}&rdquo;</span>-এর{' '}
                  {bn(source.transactionCount)}টি লেনদেন{' '}
                  <span className="font-medium">&ldquo;{intoName}&rdquo;</span>-এ চলে যাবে।
                </li>
                <li>
                  &ldquo;{fromName}&rdquo; নামটি &ldquo;{intoName}&rdquo;-এর খোঁজার শব্দ হয়ে থাকবে
                  — পুরনো নাম দিয়ে খুঁজলেও লেনদেনগুলো পাওয়া যাবে।
                </li>
                <li>&ldquo;{fromName}&rdquo; ট্যাগটি আর থাকবে না।</li>
                <li className="text-income">
                  কোনো লেনদেন মুছে যাবে না — টাকার অঙ্ক, খাত, তারিখ কিছুই বদলাবে না।
                </li>
              </ul>
            ) : (
              <p className="text-ink-muted text-xs">
                উপরে একটি ট্যাগ বেছে নিলে ঠিক কী হবে তা এখানে লেখা থাকবে।
              </p>
            )}

            {error ? (
              <p role="alert" className="bg-expense/10 text-expense rounded-xl px-3 py-2 text-sm">
                {error}
              </p>
            ) : null}

            <Button
              size="block"
              disabled={!into || merge.isPending}
              onClick={() => {
                if (!into) return;
                haptic('warn');
                merge.mutate(into.id);
              }}
            >
              <Merge className="h-4 w-4" aria-hidden />
              {merge.isPending ? 'মেলানো হচ্ছে…' : 'মিলিয়ে দিন'}
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

/**
 * What to tell the user after a merge.
 *
 * The API's own `message` covers the common case. Two things it leaves out are
 * worth saying, and one of them is a promise this screen made two paragraphs
 * earlier: when the survivor's alias list is already full the old name is *not*
 * kept as a search word, and `aliasesAdded: 0` is the only sign of it.
 */
export function mergeMessage(result: MergeTagResult): string {
  const parts = [result.message];
  if (result.alreadyTaggedCount > 0) {
    parts.push(`${bn(result.alreadyTaggedCount)}টি লেনদেনে দুটো ট্যাগই আগে থেকেই ছিল।`);
  }
  if (result.aliasesAdded === 0) {
    parts.push(
      `তবে "${result.from.name}" নামটি খোঁজার শব্দ হিসেবে রাখা যায়নি — "${result.into.name}"-এর খোঁজার শব্দের তালিকা পূর্ণ।`,
    );
  }
  return parts.join(' ');
}
