'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { api } from '@/lib/api';
import { t } from '@/lib/t';

/**
 * The eighteen categories and the tag, in one press.
 *
 * ## Why this is a button and not a page of instructions
 *
 * The guide above it can say "make a tag, then add ব্যবসার আয় with five
 * children and ব্যবসার খরচ with eleven" perfectly clearly, and almost nobody
 * will do it — twenty minutes of typing with a dozen chances to file a share
 * purchase under খরচ. Worse, the names are load-bearing: the month-end stock
 * count posts to `বিক্রীত পণ্যের ব্যয়` by name, and a workspace that called it
 * something else would have the count landing in a line that already holds the
 * purchases, counting the same money twice.
 *
 * So the tree is the app's job. What is left for the person is the one thing
 * only they know: what the business is called.
 *
 * Pressing it twice is safe and says so — everything is matched by name on the
 * server, so a second press reports what already existed rather than building a
 * duplicate set somebody then has to merge.
 */
export interface SetupResult {
  tagId: string;
  tagName: string;
  createdCategories: number;
  existingCategories: number;
}

export function SetupCard({ onDone }: { onDone: (result: SetupResult) => void }) {
  const [name, setName] = React.useState('');
  const queryClient = useQueryClient();

  const setup = useMutation({
    mutationFn: (businessName: string) =>
      api<SetupResult>('/business/setup', {
        method: 'POST',
        body: { name: businessName },
      }),
    onSuccess: async (result) => {
      /* The tag picker, the category pickers and every report are all now out
         of date at once — eighteen categories and a tag appeared. */
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tags'] }),
        queryClient.invalidateQueries({ queryKey: ['categories'] }),
        queryClient.invalidateQueries({ queryKey: ['reports'] }),
      ]);
      onDone(result);
    },
  });

  const trimmed = name.trim();

  return (
    <section className="rounded-card border-rule bg-surface border-[1.5px] p-4">
      <h2 className="text-ink text-base font-semibold">
        {t('segment.setupTitle', 'ব্যবসার হিসাব চালু করুন')}
      </h2>
      <p className="text-ink-muted mt-1 text-sm">
        {t(
          'segment.setupBody',
          'ব্যবসার নামে একটা ট্যাগ আর আঠারোটা খাত — বিক্রি, বিক্রীত পণ্যের ব্যয়, দোকান ভাড়া, বেতন, ব্রোকারেজ — সব এক চাপে তৈরি হয়ে যাবে। আপনাকে শুধু নামটা দিতে হবে।',
        )}
      </p>

      <form
        className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed) setup.mutate(trimmed);
        }}
      >
        <div className="min-w-0 flex-1">
          <Field label={t('segment.setupName', 'ব্যবসার নাম')} htmlFor="sg-setup-name">
            <Input
              id="sg-setup-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('segment.setupPlaceholder', 'যেমন: দোকান, শেয়ার')}
              maxLength={60}
            />
          </Field>
        </div>
        <Button type="submit" disabled={!trimmed || setup.isPending}>
          {setup.isPending
            ? t('segment.setupWorking', 'তৈরি হচ্ছে…')
            : t('segment.setupGo', 'তৈরি করে দিন')}
        </Button>
      </form>

      {setup.isError ? (
        <p className="text-expense mt-2 text-sm">
          {(setup.error as Error).message ||
            t('segment.setupFailed', 'তৈরি করা গেল না — আবার চেষ্টা করুন')}
        </p>
      ) : null}

      {setup.isSuccess ? (
        <p className="text-income mt-2 text-sm">
          {setup.data.createdCategories === 0
            ? t('segment.setupAlready', 'আগেই তৈরি ছিল — নতুন করে কিছু বানানো হয়নি')
            : t(
                'segment.setupDone',
                '{n}টি খাত তৈরি হয়েছে। এবার লেনদেনে ট্যাগটা লাগাতে শুরু করুন।',
              ).replace('{n}', String(setup.data.createdCategories))}
        </p>
      ) : null}
    </section>
  );
}
