'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import {
  CURRENCIES,
  DEFAULT_CURRENCY,
  currencyLabel,
  type DeviceKind,
  type Locale,
} from '@hishab/shared';
import { guessDevice } from '@/app/(marketing)/guide/device-guide';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [locale, setLocale] = React.useState<Locale>('bn');
  const [currency, setCurrency] = React.useState(DEFAULT_CURRENCY);
  /* Guessed, shown, and changeable — not detected and hidden. The user agent is
     a string a browser may lie about, and the answer decides which set of
     "add to home screen" instructions this person is shown for the rest of
     their account's life. Getting it wrong silently would be worse than
     asking. */
  const [device, setDevice] = React.useState<DeviceKind>('ANDROID');
  React.useEffect(() => {
    setDevice(guessDevice(navigator.userAgent, navigator.maxTouchPoints ?? 0));
  }, []);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  /* Asked once, here, rather than left to a settings screen nobody opens.
   *
   * The currency in particular has to be answered before the first entry: it
   * decides how many minor units a stored integer represents, so changing it
   * after the books have amounts in them would reinterpret every one of them.
   * Asking at signup is the only moment the question is free. */

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await api('/auth/signup', {
        method: 'POST',
        body: { name, email, password, locale, currency, device },
      });
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
    <main className="app-scroll safe-x mx-auto flex h-dvh w-full max-w-sm flex-col justify-center gap-6 px-4 py-10">
      <header className="text-center">
        <h1 className="text-ink text-3xl font-semibold">নতুন অ্যাকাউন্ট</h1>
        <p className="text-ink-muted text-sm">এক মিনিটেই শুরু করুন</p>
      </header>

      <form className="flex flex-col gap-4" onSubmit={(e) => void onSubmit(e)}>
        <Field label="ভাষা / Language" htmlFor="locale">
          <Select
            id="locale"
            name="locale"
            value={locale}
            onChange={(e) => setLocale(e.target.value === 'en' ? 'en' : 'bn')}
          >
            <option value="bn">বাংলা</option>
            <option value="en">English</option>
          </Select>
        </Field>

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

        <Field label={locale === 'en' ? 'Currency' : 'কারেন্সি'} htmlFor="currency">
          <Select
            id="currency"
            name="currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
          >
            {CURRENCIES.map((info) => (
              <option key={info.code} value={info.code}>
                {info.symbol} — {currencyLabel(info, locale)}
              </option>
            ))}
          </Select>
          <p className="text-ink-muted mt-1 text-xs">
            {locale === 'en'
              ? 'Your books are kept in this currency. It cannot be changed once you have entries.'
              : 'আপনার খাতা এই কারেন্সিতেই থাকবে। এন্ট্রি বসানোর পর এটি আর বদলানো যাবে না।'}
          </p>
        </Field>

        <Field
          label={locale === 'en' ? 'Your device' : 'কোন ডিভাইস ব্যবহার করছেন'}
          htmlFor="device"
        >
          <Select
            id="device"
            name="device"
            value={device}
            onChange={(e) => setDevice(e.target.value as DeviceKind)}
          >
            <option value="ANDROID">অ্যান্ড্রয়েড ফোন</option>
            <option value="IOS">আইফোন / আইপ্যাড</option>
            <option value="DESKTOP">কম্পিউটার</option>
          </Select>
          <p className="text-ink-muted mt-1 text-xs">
            {locale === 'en'
              ? 'So we can show you the right steps to put the app on your home screen.'
              : 'হোম স্ক্রিনে অ্যাপটি বসানোর সঠিক ধাপগুলো দেখানোর জন্য।'}{' '}
            <Link href="/guide" className="text-income underline">
              {locale === 'en' ? 'See the guide' : 'নির্দেশনা দেখুন'}
            </Link>
          </p>
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
