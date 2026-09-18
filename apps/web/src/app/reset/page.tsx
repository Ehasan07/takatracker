'use client';

import { CheckCircle2, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { t } from '@/lib/t';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { PasswordInput } from '@/components/ui/password-input';
import { api, ApiError } from '@/lib/api';
import { fmtNumber } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';

const MIN_LENGTH = 8;

/** Seconds on the success screen before we take them to login ourselves. */
const REDIRECT_SECONDS = 6;

const STRENGTH_LABEL = [
  t('pw.veryWeak', 'খুব দুর্বল'),
  t('pw.weak', 'দুর্বল'),
  t('pw.fair', 'মোটামুটি'),
  t('pw.good', 'ভালো'),
  t('pw.strong', 'শক্ত'),
] as const;

const STRENGTH_TONE = ['bg-expense', 'bg-expense', 'bg-brass', 'bg-brand', 'bg-brand'] as const;

/**
 * A rough, honest score out of four. It is advice, not a gate — the only hard
 * rule is the eight characters the API itself enforces. Integer arithmetic
 * throughout; nothing here rounds.
 */
function strengthOf(password: string): number {
  if (password.length === 0) return 0;
  let score = 0;
  if (password.length >= MIN_LENGTH) score += 1;
  if (password.length >= 12) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password)) score += 1;
  if (/[^\w\s]/.test(password)) score += 1;

  // The same character repeated is not a long password, it is a short one with
  // padding; digits alone are a PIN.
  if (/^(.)\1+$/.test(password)) score = 0;
  if (/^\d+$/.test(password) && score > 1) score = 1;

  return Math.min(4, score);
}

function hintFor(password: string): string | null {
  if (password === '') return null;
  if (password.length < MIN_LENGTH) return `আরও ${MIN_LENGTH - password.length}টি অক্ষর দরকার।`;
  if (/^\d+$/.test(password))
    return t('pw.digitsOnly', 'শুধু সংখ্যা সহজে অনুমান করা যায় — কিছু অক্ষরও রাখুন।');
  if (password.length < 12)
    return t('pw.longer', 'আরেকটু লম্বা হলে অনেক বেশি নিরাপদ হয় — একটা ছোট বাক্যও চলে।');
  return null;
}

type Failure = 'expired' | 'used' | 'invalid' | 'weak' | 'other';

function classify(err: unknown): Failure {
  if (!(err instanceof ApiError)) return 'other';
  if (err.status === 410) return 'expired';
  if (err.status === 409) return 'used';
  const text = err.message.toLowerCase();
  if (text.includes('expire') || err.message.includes(t('token.expired', 'মেয়াদ')))
    return 'expired';
  if (text.includes('used') || err.message.includes(t('token.used', 'ব্যবহৃত'))) return 'used';
  if (text.includes('weak') || text.includes('password') || err.issues?.length) return 'weak';
  if (err.status === 400 || err.status === 404) return 'invalid';
  return 'other';
}

function messageFor(failure: Failure, err: unknown): string {
  switch (failure) {
    case 'expired':
      return t(
        'reset.expired',
        'লিংকের মেয়াদ শেষ হয়ে গেছে। পাসওয়ার্ড বদলানোর লিংক এক ঘণ্টা কাজ করে — নতুন একটি নিন।',
      );
    case 'used':
      return t(
        'reset.used',
        'এই লিংকটি আগেই ব্যবহার হয়ে গেছে। প্রতিটি লিংক একবারই চলে — নতুন একটি নিন।',
      );
    case 'invalid':
      return t(
        'reset.unknown',
        'লিংকটি চেনা গেল না। ইমেইল থেকে পুরো লিংকটি আবার খুলুন, নয়তো নতুন একটি নিন।',
      );
    case 'weak':
      return err instanceof ApiError && err.issues?.length
        ? err.issues.map((i) => i.message).join(' · ')
        : t('reset.refused', 'পাসওয়ার্ডটি গ্রহণ করা যায়নি — আরেকটু শক্ত পাসওয়ার্ড দিন।');
    default:
      return err instanceof ApiError ? err.message : t('reset.failed', 'পাসওয়ার্ড বদলানো যায়নি');
  }
}

function ResetForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token') ?? '';

  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [failure, setFailure] = React.useState<Failure | null>(null);
  const [pending, setPending] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [revoked, setRevoked] = React.useState<number | null>(null);
  const [seconds, setSeconds] = React.useState(REDIRECT_SECONDS);

  const score = strengthOf(password);
  const hint = hintFor(password);
  const mismatch = confirm !== '' && confirm !== password;
  const tooShort = password !== '' && password.length < MIN_LENGTH;

  React.useEffect(() => {
    if (!done) return;
    const timer = setInterval(() => setSeconds((s) => s - 1), 1000);
    const jump = setTimeout(() => {
      router.push('/login');
      router.refresh();
    }, REDIRECT_SECONDS * 1000);
    return () => {
      clearInterval(timer);
      clearTimeout(jump);
    };
  }, [done, router]);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setFailure(null);
    if (password !== confirm) {
      setError(t('reset.mismatchDot', 'দুই ঘরের পাসওয়ার্ড এক হয়নি।'));
      return;
    }
    setPending(true);
    try {
      const result = await api<{ sessionsRevoked?: number }>('/auth/password/reset', {
        method: 'POST',
        body: { token, password },
      });
      haptic('success');
      setRevoked(typeof result?.sessionsRevoked === 'number' ? result.sessionsRevoked : null);
      setDone(true);
    } catch (err) {
      haptic('warn');
      const kind = classify(err);
      setFailure(kind);
      setError(messageFor(kind, err));
    } finally {
      setPending(false);
    }
  };

  if (done) {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <CheckCircle2 className="text-brand h-10 w-10" aria-hidden />
        <h2 className="text-ink text-lg font-semibold">
          {t('reset.done', 'পাসওয়ার্ড বদলে গেছে')}
        </h2>
        <p role="status" className="text-ink flex items-start gap-2 text-sm">
          <ShieldCheck className="text-brand mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            নিরাপত্তার জন্য{' '}
            <strong>{t('reset.signedOut', 'অন্য সব ডিভাইস থেকে লগআউট করে দেওয়া হয়েছে')}</strong>
            {revoked !== null && revoked > 0
              ? ` — ${fmtNumber(String(revoked))}টি সেশন বন্ধ হয়েছে।`
              : ' — ফোন, কম্পিউটার, ব্রাউজার, সব।'}{' '}
            নতুন পাসওয়ার্ড দিয়ে আবার লগইন করতে হবে।
          </span>
        </p>
        <p className="text-ink-muted text-sm">
          {seconds > 0
            ? `${seconds} সেকেন্ড পরে লগইন পাতায় নিয়ে যাচ্ছি…`
            : t('reset.takingYou', 'নিয়ে যাচ্ছি…')}
        </p>
        <Button asChild size="block" className="mt-2">
          <Link href="/login">{t('reset.loginNow', 'এখনই লগইন করুন')}</Link>
        </Button>
      </div>
    );
  }

  if (token === '') {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <h2 className="text-ink text-lg font-semibold">
          {t('reset.noToken', 'লিংকে কোনো টোকেন নেই')}
        </h2>
        <p className="text-ink-muted text-sm">
          ইমেইলের লিংকটি সম্ভবত পুরোটা কপি হয়নি। ইমেইলে ফিরে গিয়ে পুরো লিংকে চাপ দিন, অথবা নতুন
          একটি নিন।
        </p>
        <Button asChild size="block" className="mt-2">
          <Link href="/forgot">{t('reset.getNew', 'নতুন লিংক নিন')}</Link>
        </Button>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void onSubmit(e)}>
      <Field
        label="নতুন পাসওয়ার্ড"
        htmlFor="reset-password"
        error={tooShort ? `কমপক্ষে ${MIN_LENGTH} অক্ষর` : undefined}
      >
        <PasswordInput
          id="reset-password"
          name="password"
          autoComplete="new-password"
          required
          minLength={MIN_LENGTH}
          maxLength={200}
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-describedby="reset-strength"
        />
      </Field>

      {/* Strength is said in words as well as shown as a bar — colour and
          length are never the only signal. */}
      <div id="reset-strength" className="flex flex-col gap-1.5">
        <div className="bg-brand-tint border-rule h-2 overflow-hidden rounded-full border">
          <div
            className={cn('h-full rounded-full transition-all', STRENGTH_TONE[score])}
            style={{ width: password === '' ? '0%' : `${20 * (score + 1)}%` }}
          />
        </div>
        <p className="text-ink-muted text-xs">
          {password === ''
            ? t('reset.minLength', 'অন্তত ৮ অক্ষর দিন।')
            : `শক্তি: ${STRENGTH_LABEL[score] ?? ''}`}
          {hint ? ` — ${hint}` : ''}
        </p>
      </div>

      <Field
        label="আবার লিখুন"
        htmlFor="reset-confirm"
        error={mismatch ? t('reset.mismatch', 'দুই ঘরের পাসওয়ার্ড এক হয়নি') : undefined}
      >
        <PasswordInput
          id="reset-confirm"
          name="confirm"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </Field>

      {error ? (
        <p role="alert" className="bg-expense/10 text-expense rounded-md px-3 py-2 text-sm">
          {error}
        </p>
      ) : null}

      {failure === 'expired' || failure === 'used' || failure === 'invalid' ? (
        <Button asChild size="block" variant="outline">
          <Link href="/forgot">{t('reset.getNew', 'নতুন লিংক নিন')}</Link>
        </Button>
      ) : null}

      <Button
        type="submit"
        size="block"
        disabled={pending || password.length < MIN_LENGTH || password !== confirm}
      >
        {pending ? t('reset.changing', 'বদলানো হচ্ছে…') : t('reset.submit', 'পাসওয়ার্ড বদলান')}
      </Button>

      <p className="text-ink-muted text-center text-xs">
        পাসওয়ার্ড বদলালে আপনার অন্য সব ডিভাইস থেকে লগআউট হয়ে যাবে।
      </p>
    </form>
  );
}

export default function ResetPage() {
  return (
    <main className="app-scroll safe-x mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 py-10 [--gutter-x:1rem]">
      <header className="text-center">
        <h1 className="text-ink text-3xl font-semibold">
          {t('reset.newPassword', 'নতুন পাসওয়ার্ড')}
        </h1>
        <p className="text-ink-muted text-sm">
          {t('reset.twice', 'দুইবার লিখুন, যাতে টাইপো না থাকে')}
        </p>
      </header>
      <React.Suspense
        fallback={
          <p className="text-ink-muted text-center text-sm">
            {t('common.oneMoment', 'এক মুহূর্ত…')}
          </p>
        }
      >
        <ResetForm />
      </React.Suspense>
    </main>
  );
}
