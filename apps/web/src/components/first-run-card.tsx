'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useCompleteOnboarding, useMe } from '@/app/(shell)/onboarding/queries';
import { Button } from '@/components/ui/button';
import { endpoints } from '@/lib/api';
import { t } from '@/lib/t';
import { haptic } from '@/lib/haptics';

/**
 * The dashboard's one invitation into first run.
 *
 * Shown only when `/auth/me` says onboarding was never marked done *and* the
 * workspace has no accounts. Both conditions, not either: somebody who skipped
 * has said no and must not be asked again, and somebody who has accounts is
 * already past the only step that matters, whatever the flag says.
 *
 * It invites rather than nags — a sentence, a way in, and a way to be rid of
 * it. Dismissing calls the same `POST /auth/onboarding/complete` the route's
 * skip button calls, so "no thanks" from here is as durable as "no thanks" from
 * in there.
 *
 * Mount it at the top of the dashboard's card grid, above `এই মাসের হিসাব`, as
 * a full-width child (`className="md:col-span-2"` inside that grid) or as a
 * sibling directly above it. It renders nothing at all in every other case, so
 * it costs the dashboard no layout when there is nothing to say.
 */
export function FirstRunCard() {
  const me = useMe();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });
  const dismiss = useCompleteOnboarding();

  /* Nothing until both answers are in. A card that appears a beat after the
     dashboard has settled — and might not appear at all — moves everything
     under it just as the reader's eye lands. */
  if (me.data === undefined || accounts.data === undefined) return null;
  if (me.data.onboardingCompletedAt) return null;
  if (accounts.data.length > 0) return null;

  return (
    <section className="rounded-card border-income/40 bg-surface border-[1.5px] p-4">
      <h2 className="text-ink text-base font-semibold">{t('firstRun.title', 'শুরু করা যাক')}</h2>
      <p className="text-ink-muted mt-1 text-sm">
        {t('firstRun.body', 'টাকা কোথায় আছে একবার বলে দিলে খাতা লেখা শুরু — দুই মিনিটের কাজ।')}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button asChild size="sm">
          <Link href="/onboarding" onClick={() => haptic('tap')}>
            {t('firstRun.start', 'শুরু করুন')}
          </Link>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={dismiss.isPending}
          onClick={() => {
            haptic('tap');
            dismiss.mutate();
          }}
        >
          {dismiss.isPending
            ? t('firstRun.dismissing', 'সরানো হচ্ছে…')
            : t('firstRun.dismiss', 'আর দেখাবেন না')}
        </Button>
      </div>
      {dismiss.isError ? (
        <p role="alert" className="text-expense mt-2 text-xs">
          {dismiss.error.message}
        </p>
      ) : null}
    </section>
  );
}
