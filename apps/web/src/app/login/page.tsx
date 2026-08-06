'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import * as React from 'react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await api('/auth/login', { method: 'POST', body: { email, password } });
      router.push(params.get('next') ?? '/');
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'লগইন করা যায়নি');
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void onSubmit(e)}>
      <Field label="ইমেইল" htmlFor="email">
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>

      <Field label="পাসওয়ার্ড" htmlFor="password">
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>

      {error ? (
        <p role="alert" className="bg-expense/10 text-expense rounded-md px-3 py-2 text-sm">
          {error}
        </p>
      ) : null}

      <Button type="submit" size="block" disabled={pending}>
        {pending ? 'অপেক্ষা করুন…' : 'লগইন'}
      </Button>

      <p className="text-ink-muted text-center text-sm">
        অ্যাকাউন্ট নেই?{' '}
        <Link href="/signup" className="text-income font-medium underline">
          নতুন অ্যাকাউন্ট খুলুন
        </Link>
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="app-scroll safe-x mx-auto flex h-dvh w-full max-w-sm flex-col justify-center gap-6 px-4 py-10">
      <header className="text-center">
        <h1 className="text-ink text-3xl font-semibold">হিসাব</h1>
        <p className="text-ink-muted text-sm">আয়, খরচ ও সঞ্চয়ের ব্যক্তিগত খাতা</p>
      </header>
      <React.Suspense fallback={null}>
        <LoginForm />
      </React.Suspense>
    </main>
  );
}
