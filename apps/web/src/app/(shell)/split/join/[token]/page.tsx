'use client';

import { useMutation } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, api } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { t } from '@/lib/t';

/**
 * Taking up an invitation to a group.
 *
 * ## Why this asks rather than just doing it
 *
 * Following a link is not consent to have somebody else's records attached to
 * your books. The page says exactly what accepting does — bills you are on
 * arrive as drafts, each one posts only when you say so — and then asks. A
 * screen that silently linked two workspaces on page load would be the kind of
 * thing people are right to distrust.
 *
 * ## Why it lives inside the app shell
 *
 * Unlike a shared statement, this needs an account: the whole point is to reach
 * *your* ledger. Somebody following the link signed out lands on the login
 * screen and comes back here, which the middleware already handles for every
 * other private route.
 */
export default function JoinGroupPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [joined, setJoined] = React.useState<{ groupName: string; drafts: number } | null>(null);

  const join = useMutation({
    mutationFn: () =>
      api<{ groupName: string; drafts: number }>(`/split/join/${params.token}`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: (data) => {
      haptic('success');
      setJoined(data);
    },
    onError: (err) => {
      haptic('warn');
      setError(
        err instanceof ApiError ? err.message : t('split.joinFailed', 'আমন্ত্রণটি আর কাজ করছে না'),
      );
    },
  });

  if (joined) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col gap-4 text-center">
        <h1 className="text-ink text-xl font-bold">
          {t('split.joined', 'যুক্ত হয়েছেন')} — {joined.groupName}
        </h1>
        <p className="text-ink-muted text-sm">
          {joined.drafts > 0
            ? t('split.joinedWithDrafts', 'আগের খরচগুলো খসড়া হিসেবে অপেক্ষা করছে — দেখে নিন।')
            : t('split.joinedEmpty', 'নতুন খরচ যোগ হলে আপনার কাছে খসড়া আসবে।')}
        </p>
        <Button type="button" onClick={() => router.push('/split')}>
          {t('split.goToSplit', 'ভাগাভাগিতে যান')}
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <h1 className="text-ink text-xl font-bold">{t('split.joinTitle', 'গ্রুপে যুক্ত হবেন?')}</h1>

      <div className="rounded-card border-rule bg-surface border-[1.5px] p-4">
        <p className="text-ink text-sm">
          {t(
            'split.joinExplain',
            'রাজি হলে আপনি যে খরচগুলোতে আছেন সেগুলো আপনার কাছে খসড়া হিসেবে আসবে।',
          )}
        </p>
        {/* Said plainly, because it is the question somebody actually has. */}
        <ul className="text-ink-muted mt-2 space-y-1 text-xs">
          <li>{t('split.joinPoint1', 'আপনার অনুমতি ছাড়া কিছুই আপনার খাতায় উঠবে না।')}</li>
          <li>
            {t('split.joinPoint2', 'আপনার নিজের ভাগটুকুই দেখানো হবে — গ্রুপের বাকি হিসাব নয়।')}
          </li>
          <li>{t('split.joinPoint3', 'যিনি আমন্ত্রণ দিয়েছেন তিনি আপনার খাতা দেখতে পাবেন না।')}</li>
        </ul>
      </div>

      {error ? (
        <p role="alert" className="bg-expense/10 text-expense rounded-xl px-3 py-2 text-sm">
          {error}
        </p>
      ) : null}

      <Button type="button" size="block" disabled={join.isPending} onClick={() => join.mutate()}>
        {join.isPending
          ? t('common.saving', 'সংরক্ষণ হচ্ছে…')
          : t('split.joinYes', 'হ্যাঁ, যুক্ত হব')}
      </Button>
    </div>
  );
}
