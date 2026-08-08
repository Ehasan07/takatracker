'use client';

import { MailCheck } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { api, ApiError } from '@/lib/api';
import { haptic } from '@/lib/haptics';

/**
 * "Forgot password" is an account-enumeration oracle if it is honest about
 * whether an address exists: anybody could type addresses in and learn which
 * ones have accounts here. So the answer is the same either way — and we say
 * so on the screen, because a user who is told nothing assumes the form is
 * broken and tries again with three more spellings.
 *
 * Two things are still worth saying out loud, since neither leaks anything:
 * a dead network, and a rate limit.
 */
export default function ForgotPage() {
  const [email, setEmail] = React.useState('');
  const [sent, setSent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await api('/auth/password/forgot', { method: 'POST', body: { email } });
      haptic('success');
      setSent(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) {
        haptic('warn');
        setError('সংযোগ পাওয়া যাচ্ছে না। ইন্টারনেট দেখে আবার চেষ্টা করুন।');
      } else if (err instanceof ApiError && err.status === 429) {
        haptic('warn');
        setError('একটু আগেই অনুরোধ করা হয়েছে। এক মিনিট পরে আবার চেষ্টা করুন।');
      } else {
        // Anything else — unknown address, disabled account, a 4xx we did not
        // plan for — gets the same answer as success. That is the point.
        haptic('success');
        setSent(true);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="app-scroll safe-x mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-4 py-10">
      <header className="text-center">
        <h1 className="text-ink text-3xl font-semibold">পাসওয়ার্ড ভুলে গেছেন?</h1>
        <p className="text-ink-muted text-sm">ইমেইলে একটি লিংক পাঠিয়ে দেব</p>
      </header>

      {sent ? (
        <div className="flex flex-col items-center gap-3 text-center">
          <MailCheck className="text-income h-10 w-10" aria-hidden />
          <h2 className="text-ink text-lg font-semibold">দেখে নিন আপনার ইমেইল</h2>
          <p role="status" className="text-ink-muted text-sm">
            এই ঠিকানায় যদি কোনো অ্যাকাউন্ট থেকে থাকে, তাহলে পাসওয়ার্ড বদলানোর একটি লিংক পাঠানো
            হয়েছে। লিংকটি এক ঘণ্টা কাজ করবে। ইনবক্সে না পেলে স্প্যাম ফোল্ডারও দেখুন।
          </p>
          <p className="text-ink-muted bg-greenbar rounded-md p-3 text-xs">
            অ্যাকাউন্ট আছে কি নেই — আমরা দুই ক্ষেত্রেই একই কথা বলি। তা না হলে যে কেউ এই পাতায়
            ঠিকানা লিখে লিখে জেনে নিতে পারত কার হিসাব এখানে আছে।
          </p>
          <div className="mt-2 flex w-full flex-col gap-3">
            <Button asChild size="block" variant="outline">
              <Link href="/login">লগইনে ফিরে যান</Link>
            </Button>
            <button
              type="button"
              className="press text-income min-h-11 text-sm underline"
              onClick={() => setSent(false)}
            >
              অন্য একটি ঠিকানা দিন
            </button>
          </div>
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={(e) => void onSubmit(e)}>
          <Field label="ইমেইল" htmlFor="forgot-email">
            <Input
              id="forgot-email"
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>

          {error ? (
            <p role="alert" className="bg-expense/10 text-expense rounded-md px-3 py-2 text-sm">
              {error}
            </p>
          ) : null}

          <Button type="submit" size="block" disabled={pending}>
            {pending ? 'পাঠানো হচ্ছে…' : 'লিংক পাঠান'}
          </Button>

          <p className="text-ink-muted text-center text-sm">
            মনে পড়ে গেছে?{' '}
            <Link href="/login" className="text-income font-medium underline">
              লগইন করুন
            </Link>
          </p>
        </form>
      )}
    </main>
  );
}
