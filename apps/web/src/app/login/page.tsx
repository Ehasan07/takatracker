'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import * as React from 'react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { PasswordInput } from '@/components/ui/password-input';
import { fmtNumber } from '@/lib/format';

/**
 * Two ways in, on one screen.
 *
 * The password is the default because it is what almost everybody uses and
 * costs no round trip. The code is for the person who cannot remember one and
 * would otherwise reset it — a heavier action that logs them out everywhere.
 *
 * They share the email box deliberately. Somebody who typed their address,
 * failed on the password and then switched should not have to type it again;
 * that is the moment they are least patient.
 */
type Mode = 'password' | 'code';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = React.useState<Mode>('password');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  /** Set once a code has been asked for, so the screen shows the code box. */
  const [codeSent, setCodeSent] = React.useState(false);
  const [code, setCode] = React.useState('');
  const [note, setNote] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const land = (): void => {
    router.push(params.get('next') ?? '/');
    router.refresh();
  };

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      if (mode === 'password') {
        await api('/auth/login', { method: 'POST', body: { identifier: email, password } });
        land();
      } else if (!codeSent) {
        const res = await api<{ message: string }>('/auth/otp/request', {
          method: 'POST',
          body: { email },
        });
        /* The server answers the same whether or not the address is
           registered, on purpose. The screen must not undo that by behaving
           differently — so it always moves to the code box. */
        setCodeSent(true);
        setNote(res.message);
      } else {
        await api('/auth/otp/verify', { method: 'POST', body: { email, code } });
        land();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'লগইন করা যায়নি');
    } finally {
      setPending(false);
    }
  };

  const switchMode = (next: Mode): void => {
    setMode(next);
    setError(null);
    setNote(null);
    setCodeSent(false);
    setCode('');
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void onSubmit(e)}>
      {/* One box for both. Asking somebody to pick "email or phone" first is a
          decision they should not have to make about their own account, and
          telling a Bangladeshi user "enter a valid email" after they typed a
          real, working mobile number is the wall that ends a session. The
          server works out which it is.

          `type="text"`, not `email`: the browser's own validation would refuse
          a phone number before the request was ever built. `username` for
          autocomplete, which is what a password manager stores either way. */}
      <Field label="ইমেইল বা মোবাইল নম্বর" htmlFor="email">
        <Input
          id="email"
          name="identifier"
          type="text"
          autoComplete="username"
          required
          placeholder="01712345678"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>

      {mode === 'password' ? (
        <Field label="পাসওয়ার্ড" htmlFor="password">
          <PasswordInput
            id="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      ) : codeSent ? (
        <Field label="ইমেইলে পাঠানো কোড" htmlFor="otp">
          <Input
            id="otp"
            name="code"
            /* `one-time-code` is what lets a phone offer the digits straight
               from the notification. `numeric` brings up the right keypad —
               which has no space key, so non-digits are stripped as they are
               typed and a pasted "714 987" still works. */
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={6}
            required
            autoFocus
            placeholder={fmtNumber('000000')}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            className="money tracking-widest"
          />
        </Field>
      ) : null}

      {error ? (
        <p role="alert" className="bg-expense/10 text-expense rounded-md px-3 py-2 text-sm">
          {error}
        </p>
      ) : null}

      {note ? <p className="text-ink-muted text-sm">{note}</p> : null}

      <Button type="submit" size="block" disabled={pending}>
        {pending
          ? 'অপেক্ষা করুন…'
          : mode === 'password'
            ? 'লগইন'
            : codeSent
              ? 'কোড দিয়ে ঢুকুন'
              : 'কোড পাঠান'}
      </Button>

      {/* The other way in. Not a tab strip: two tabs over a two-field form is
          more chrome than the choice deserves, and the password is the path
          almost everybody takes. */}
      <p className="text-center text-sm">
        <button
          type="button"
          onClick={() => switchMode(mode === 'password' ? 'code' : 'password')}
          className="press text-ink-muted hover:text-ink min-h-11 underline"
        >
          {mode === 'password'
            ? 'পাসওয়ার্ড ছাড়া, ইমেইলে কোড নিয়ে ঢুকুন'
            : 'পাসওয়ার্ড দিয়ে ঢুকুন'}
        </button>
      </p>

      {/* `/forgot`, the page it posts to and the reset screen it mails a link
          to have all existed since the account routes were built. Nothing on
          this screen linked to any of them, so the only way to reach a password
          reset was to know the URL — which is the same as not having one. */}
      <p className="text-center text-sm">
        <Link href="/forgot" className="text-ink-muted hover:text-ink underline">
          পাসওয়ার্ড ভুলে গেছেন?
        </Link>
      </p>

      <p className="text-ink-muted text-center text-sm">
        অ্যাকাউন্ট নেই?{' '}
        <Link href="/signup" className="text-brand font-medium underline">
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
        <h1 className="text-ink text-3xl font-semibold">Taka Tracker</h1>
        <p className="text-ink-muted text-sm">আয়, খরচ ও সঞ্চয়ের ব্যক্তিগত খাতা</p>
      </header>
      <React.Suspense fallback={null}>
        <LoginForm />
      </React.Suspense>
    </main>
  );
}
