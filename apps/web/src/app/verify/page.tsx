'use client';

import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, Clock, Info, Mail, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import * as React from 'react';
import { Skeleton } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api';
import { haptic } from '@/lib/haptics';

/**
 * Four different things can be true when somebody opens a verification link,
 * and they need four different sentences:
 *
 *   verified  the link worked, right now
 *   already   the link worked earlier — nothing is wrong, nothing to do
 *   expired   the link was real but is too old — here is a new one
 *   invalid   we have never seen this link
 *
 * Collapsing them into "verification failed" turns a non-event ("you already
 * clicked this yesterday") into alarm, and hides the one case where the user
 * actually has to act.
 */
type Outcome = 'checking' | 'verified' | 'already' | 'expired' | 'invalid' | 'missing';

function readSuccess(payload: unknown): Outcome {
  const body = (payload ?? {}) as { alreadyVerified?: unknown; status?: unknown; result?: unknown };

  // The shipped API answers 200 with `{ verified: true, alreadyVerified }`.
  if (body.alreadyVerified === true) return 'already';

  const status = String(body.status ?? body.result ?? '').toUpperCase();
  if (status.includes('ALREADY') || status === 'USED') return 'already';
  if (status.includes('EXPIRED')) return 'expired';
  if (status.includes('UNKNOWN') || status.includes('INVALID')) return 'invalid';
  return 'verified';
}

function readFailure(err: unknown): Outcome {
  if (!(err instanceof ApiError)) return 'invalid';
  // 410 Gone is the natural code for a dead link, 409 for a replayed one, but
  // neither is guaranteed — fall back to reading the message.
  if (err.status === 410) return 'expired';
  if (err.status === 409) return 'already';
  const text = err.message.toLowerCase();
  if (text.includes('expire') || err.message.includes('মেয়াদ')) return 'expired';
  if (
    text.includes('already') ||
    text.includes('used') ||
    err.message.includes('ব্যবহৃত') ||
    err.message.includes('আগেই')
  ) {
    return 'already';
  }
  return 'invalid';
}

function VerifyView() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [outcome, setOutcome] = React.useState<Outcome>(token ? 'checking' : 'missing');
  const [serverSaid, setServerSaid] = React.useState<string | null>(null);
  const [resent, setResent] = React.useState<string | null>(null);
  const confirmed = React.useRef(false);

  const resend = useMutation({
    mutationFn: () => api('/auth/verify/send', { method: 'POST', body: {} }),
    onSuccess: () => {
      haptic('success');
      setResent('নতুন একটি লিংক পাঠানো হয়েছে। ইমেইলের ইনবক্স আর স্প্যাম — দুটোই দেখুন।');
    },
    onError: (err) => {
      haptic('warn');
      if (err instanceof ApiError && err.status === 401) {
        setResent('নতুন লিংক পাঠাতে আগে লগইন করতে হবে।');
      } else if (err instanceof ApiError && err.status === 429) {
        setResent('একটু আগেই একটি লিংক পাঠানো হয়েছে। এক মিনিট পরে আবার চেষ্টা করুন।');
      } else {
        setResent(err instanceof ApiError ? err.message : 'লিংক পাঠানো যায়নি');
      }
    },
  });

  React.useEffect(() => {
    if (!token || confirmed.current) return;
    // A verification token is single-use: React's double-invoked effect in
    // development must not burn it and turn "verified" into "already used".
    confirmed.current = true;

    void api<unknown>('/auth/verify/confirm', { method: 'POST', body: { token } })
      .then((payload) => {
        const next = readSuccess(payload);
        if (next === 'verified') haptic('success');
        setOutcome(next);
      })
      .catch((err: unknown) => {
        haptic('warn');
        // The API's own sentence is better than ours: it knows, for instance,
        // that it has already mailed a replacement link.
        if (err instanceof ApiError && err.status !== 0) setServerSaid(err.message);
        setOutcome(readFailure(err));
      });
  }, [token]);

  if (outcome === 'checking') {
    return (
      <div className="flex flex-col items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-full" />
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-64" />
        <p className="text-ink-muted text-sm">লিংকটি যাচাই করা হচ্ছে…</p>
      </div>
    );
  }

  if (outcome === 'verified') {
    return (
      <OutcomeCard
        icon={<CheckCircle2 className="text-brand h-10 w-10" aria-hidden />}
        title="ইমেইল যাচাই হয়ে গেছে"
        body="ধন্যবাদ। পাসওয়ার্ড ভুলে গেলে বা নিরাপত্তার দরকারে এখন এই ঠিকানাতেই আমরা যোগাযোগ করতে পারব।"
      >
        <Button asChild size="block">
          <Link href="/">হিসাবে যান</Link>
        </Button>
      </OutcomeCard>
    );
  }

  if (outcome === 'already') {
    return (
      <OutcomeCard
        icon={<Info className="text-brand h-10 w-10" aria-hidden />}
        title="এই লিংকটি আগেই ব্যবহার হয়েছে"
        body="কিছু ভুল হয়নি — আপনার ইমেইল আগেই যাচাই হয়ে গেছে। নতুন করে কিছু করতে হবে না।"
      >
        <Button asChild size="block" variant="outline">
          <Link href="/">হিসাবে যান</Link>
        </Button>
      </OutcomeCard>
    );
  }

  const expired = outcome === 'expired';

  return (
    <OutcomeCard
      icon={
        expired ? (
          <Clock className="text-brass h-10 w-10" aria-hidden />
        ) : (
          <TriangleAlert className="text-expense h-10 w-10" aria-hidden />
        )
      }
      title={
        expired
          ? 'লিংকের মেয়াদ শেষ'
          : outcome === 'missing'
            ? 'লিংকে কোনো টোকেন নেই'
            : 'লিংকটি চেনা গেল না'
      }
      body={
        serverSaid ??
        (expired
          ? 'যাচাইয়ের লিংক ২৪ ঘণ্টা পর্যন্ত কাজ করে। নিচের বোতামে চাপ দিলে নতুন একটি লিংক পাঠিয়ে দেব।'
          : outcome === 'missing'
            ? 'ইমেইলের লিংকটি সম্ভবত পুরোটা কপি হয়নি। ইমেইলে ফিরে গিয়ে পুরো লিংকে চাপ দিন, অথবা নতুন একটি লিংক নিন।'
            : 'লিংকটি হয়তো ভেঙে গেছে, নয়তো এটি অন্য কোনো অ্যাকাউন্টের। নতুন একটি লিংক নিয়ে দেখুন।')
      }
    >
      <Button size="block" disabled={resend.isPending} onClick={() => resend.mutate()}>
        <Mail className="h-4 w-4" aria-hidden />
        {resend.isPending ? 'পাঠানো হচ্ছে…' : 'নতুন লিংক পাঠান'}
      </Button>
      {resent ? (
        <p role="status" className="text-ink-muted text-center text-sm">
          {resent}
        </p>
      ) : null}
      <p className="text-ink-muted text-center text-sm">
        <Link href="/login" className="text-brand font-medium underline">
          লগইনে ফিরে যান
        </Link>
      </p>
    </OutcomeCard>
  );
}

function OutcomeCard({
  icon,
  title,
  body,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      {icon}
      <h2 className="text-ink text-lg font-semibold">{title}</h2>
      <p className="text-ink-muted text-sm">{body}</p>
      <div className="mt-2 flex w-full flex-col gap-3">{children}</div>
    </div>
  );
}

export default function VerifyPage() {
  return (
    <main className="app-scroll safe-x mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-4 py-10">
      <header className="text-center">
        <h1 className="text-ink text-3xl font-semibold">হিসাব</h1>
        <p className="text-ink-muted text-sm">ইমেইল যাচাই</p>
      </header>
      <React.Suspense fallback={<p className="text-ink-muted text-center text-sm">এক মুহূর্ত…</p>}>
        <VerifyView />
      </React.Suspense>
    </main>
  );
}
