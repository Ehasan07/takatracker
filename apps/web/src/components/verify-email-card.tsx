'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MailCheck } from '@/components/icons';
import * as React from 'react';
import { api, ApiError, endpoints } from '@/lib/api';
import { t } from '@/lib/t';
import { fmtNumber } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { haptic } from '@/lib/haptics';

/**
 * Prove the email address, by typing six digits.
 *
 * ## Why a code and not just the link
 *
 * The link works and is still in the same email. But the person who needs to
 * act is, almost always, holding a phone with this app open — and a link asks
 * them to leave it, find the mail app, tap through, and be bounced back into a
 * browser tab that is not the app they installed. Six digits they can read and
 * type without going anywhere. The link stays for whoever is at a laptop.
 *
 * ## Why the app never said anything before
 *
 * It did not: `emailVerifiedAt` was returned by `/auth/me` and rendered only on
 * the *operator's* tenant screen. A customer could be unverified for months and
 * the only place that fact appeared was a page they cannot open.
 *
 * ## What it does not do
 *
 * It does not block anything. Nothing in the product is gated on a verified
 * address today, and pretending otherwise — a modal, a locked screen — would be
 * inventing a consequence that does not exist. It is a card that can be
 * dismissed by verifying, and that is all.
 */

interface MeShape {
  email?: string;
  emailVerifiedAt?: string | null;
}

export function VerifyEmailCard() {
  const queryClient = useQueryClient();
  const [code, setCode] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  const me = useQuery({
    queryKey: ['me'],
    queryFn: endpoints.me,
    staleTime: 5 * 60_000,
    retry: false,
    networkMode: 'always',
  });

  const confirm = useMutation({
    mutationFn: () =>
      api<{ verified: boolean }>('/auth/verify/code', { method: 'POST', body: { code } }),
    onSuccess: async () => {
      haptic('success');
      /* The card disappears because `/auth/me` now carries a timestamp — there
         is no local "done" flag, so a reload cannot bring it back. */
      await queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : t('verify.mismatch', 'কোডটি মেলেনি')),
  });

  const resend = useMutation({
    mutationFn: () => api<{ message: string }>('/auth/verify/send', { method: 'POST', body: {} }),
    onSuccess: (res) => {
      setError(null);
      setNote(res.message ?? t('verify.resent', 'নতুন কোড পাঠানো হয়েছে।'));
    },
    /* The cooldown is a 429 carrying its own Bengali sentence with the seconds
       left in it — far more use than "try again later", so it is shown as-is. */
    onError: (err) =>
      setNote(err instanceof ApiError ? err.message : t('verify.sendFailed', 'পাঠানো যায়নি')),
  });

  const data = me.data as MeShape | undefined;
  if (!data || data.emailVerifiedAt) return null;

  return (
    <section className="rounded-card border-brand/40 bg-brand-tint border-[1.5px] p-4">
      <h2 className="text-ink flex items-center gap-2 text-base font-semibold">
        <MailCheck className="text-brand h-4 w-4" aria-hidden />
        {t('verify.title', 'ইমেইল যাচাই করুন')}
      </h2>
      <p className="text-ink-muted mt-1 text-sm">
        {/* The address is a span in the middle of the sentence, and the two
            languages put it in different places — so the sentence carries a
            placeholder rather than being split around the tag. */}
        {t(
          'verify.sentTo',
          '{email} ঠিকানায় ছয় সংখ্যার একটি কোড পাঠানো হয়েছে। কোডটি নিচে লিখুন — অথবা ইমেইলের বোতামে ক্লিক করুন।',
        )
          .split('{email}')
          .flatMap((part, i) =>
            i === 0
              ? [part]
              : [
                  <span key="email" className="text-ink font-medium">
                    {data.email}
                  </span>,
                  part,
                ],
          )}
      </p>

      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          setNote(null);
          confirm.mutate();
        }}
      >
        <Field label={t('verify.code', 'কোড')} htmlFor="verify-code" className="min-w-40 flex-1">
          <Input
            id="verify-code"
            /* `one-time-code` is what lets iOS and Android offer the digits
               from the notification, which removes the trip to the mail app
               entirely. `numeric` brings up the right keyboard. */
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={6}
            placeholder={fmtNumber('000000')}
            value={code}
            /* Everything that is not a digit is dropped as it is typed, so a
               pasted "714 987" — or one with a dash, or a stray space from a
               mail client — becomes a code that works. The server strips too;
               this is so the box *shows* what will be sent. */
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            className="money tracking-widest"
          />
        </Field>
        <Button type="submit" disabled={confirm.isPending || code.trim().length < 4}>
          {confirm.isPending
            ? t('verify.checking', 'দেখা হচ্ছে…')
            : t('verify.check', 'যাচাই করুন')}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={resend.isPending}
          onClick={() => {
            setError(null);
            resend.mutate();
          }}
        >
          {resend.isPending
            ? t('verify.sending', 'পাঠানো হচ্ছে…')
            : t('verify.resend', 'আবার পাঠান')}
        </Button>
      </form>

      {error ? (
        <p role="alert" className="text-expense mt-2 text-sm">
          {error}
        </p>
      ) : null}
      {note ? <p className="text-ink-muted mt-2 text-sm">{note}</p> : null}

      <p className="text-ink-muted mt-2 text-xs">
        {t(
          'verify.expiry',
          'কোডটি {n} মিনিট কাজ করে। ইমেইল না পেলে স্প্যাম ফোল্ডার দেখুন, অথবা “আবার পাঠান” চাপুন।',
        ).replace('{n}', fmtNumber('15'))}
      </p>
    </section>
  );
}
