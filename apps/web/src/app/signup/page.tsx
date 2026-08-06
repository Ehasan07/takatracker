'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await api('/auth/signup', { method: 'POST', body: { name, email, password } });
      router.push('/');
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.issues?.length) {
        setError(err.issues.map((i) => i.message).join(' · '));
      } else {
        setError(err instanceof ApiError ? err.message : 'অ্যাকাউন্ট তৈরি করা যায়নি');
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-4 py-10">
      <header className="text-center">
        <h1 className="text-ink text-3xl font-semibold">নতুন অ্যাকাউন্ট</h1>
        <p className="text-ink-muted text-sm">এক মিনিটেই শুরু করুন</p>
      </header>

      <form className="flex flex-col gap-4" onSubmit={(e) => void onSubmit(e)}>
        <Field label="নাম" htmlFor="name">
          <Input
            id="name"
            name="name"
            autoComplete="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>

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
            autoComplete="new-password"
            required
            minLength={8}
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
          {pending ? 'তৈরি হচ্ছে…' : 'অ্যাকাউন্ট খুলুন'}
        </Button>

        <p className="text-ink-muted text-center text-sm">
          আগে থেকেই অ্যাকাউন্ট আছে?{' '}
          <Link href="/login" className="text-income font-medium underline">
            লগইন করুন
          </Link>
        </p>
      </form>
    </main>
  );
}
