'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TriangleAlert } from '@/components/icons';
import * as React from 'react';
import { ApiError, api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { fmtDate } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import { t } from '@/lib/t';

/**
 * Closing an account, from inside the account.
 *
 * ## Why it is here rather than in a support inbox
 *
 * Somebody who put their bank balances into a product must be able to take them
 * out again, and "email us and wait" is not a way out — it is a way of hoping
 * they give up. The app stores require this path and so does anything resembling
 * data protection, but neither is the reason it should exist.
 *
 * ## Why it asks for the password
 *
 * The threat is a phone left unlocked on a table, and a valid session is exactly
 * what that phone has. So the destructive direction asks for something the phone
 * does not carry, while cancelling asks for nothing at all: the asymmetry is
 * deliberate, because somebody who arrives here having changed their mind should
 * not meet a second obstacle.
 *
 * ## Why it does not delete anything today
 *
 * Seven days stand between the request and the erasure, and signing in during
 * them calls it off without being asked. What happens after that is real —
 * the ledger, the loans, the messages and the audit trail all go — so the
 * screen says so in those words rather than "your account will be closed".
 */

interface DeletionStatus {
  requestedAt: string | null;
  scheduledFor: string | null;
}

export function CloseAccount() {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [password, setPassword] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const status = useQuery({
    queryKey: ['account', 'deletion'],
    queryFn: () => api<DeletionStatus>('/auth/account/deletion'),
    staleTime: 60_000,
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['account', 'deletion'] });
  };

  const request = useMutation({
    mutationFn: () =>
      api<DeletionStatus>('/auth/account/deletion', {
        method: 'POST',
        body: { password, reason: reason.trim() || undefined },
      }),
    onSuccess: () => {
      haptic('tap');
      setOpen(false);
      setPassword('');
      setReason('');
      refresh();
    },
    onError: (err) => {
      setError(
        err instanceof ApiError
          ? err.message
          : t('common.checkConnection', 'সংযোগ দেখে আবার চেষ্টা করুন।'),
      );
    },
  });

  const cancel = useMutation({
    mutationFn: () => api<DeletionStatus>('/auth/account/deletion', { method: 'DELETE' }),
    onSuccess: () => {
      haptic('tap');
      refresh();
    },
  });

  const pending = status.data?.scheduledFor ?? null;

  /* Already asked for. The screen stops offering the thing they have and offers
     the way back instead — and says the date, because "soon" is not something
     anybody can plan around. */
  if (pending) {
    return (
      <section className="rounded-card border-expense/40 bg-surface border-[1.5px] p-4">
        <h2 className="text-ink flex items-center gap-2 text-sm font-medium">
          <TriangleAlert className="text-expense h-4 w-4" aria-hidden />
          {t('close.pendingTitle', 'অ্যাকাউন্ট বন্ধ হওয়ার অপেক্ষায়')}
        </h2>
        <p className="text-ink-muted mt-1 text-sm">
          {t(
            'close.pendingBody',
            'আপনার সব তথ্য মুছে ফেলা হবে {date} তারিখে। এর আগে যেকোনো সময় থামানো যাবে — লগইন করলেই নিজে থেকেই থেমে যায়।',
          ).replace('{date}', fmtDate(pending))}
        </p>
        <Button
          variant="outline"
          className="mt-3"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate()}
        >
          {t('close.keepAccount', 'থাক, অ্যাকাউন্ট রাখব')}
        </Button>
      </section>
    );
  }

  return (
    <section className="rounded-card border-rule bg-surface border-[1.5px] p-4">
      <h2 className="text-ink text-lg font-bold">{t('close.title', 'অ্যাকাউন্ট বন্ধ করা')}</h2>

      {!open ? (
        <>
          <p className="text-ink-muted mt-1 text-sm">
            {t(
              'close.blurb',
              'আপনার খাতা, লেনদেন, ঋণ, বার্তা — সব স্থায়ীভাবে মুছে যাবে। ফেরানোর কোনো উপায় থাকবে না।',
            )}
          </p>
          <p className="text-ink-muted mt-1 text-xs">
            {t(
              'close.exportFirst',
              'যাওয়ার আগে হিসাবগুলো নামিয়ে নিতে চাইলে ইমপোর্ট ও এক্সপোর্ট পাতা থেকে নিতে পারেন।',
            )}
          </p>
          <Button variant="outline" className="mt-3" onClick={() => setOpen(true)}>
            {t('close.start', 'অ্যাকাউন্ট বন্ধ করতে চাই')}
          </Button>
        </>
      ) : (
        <form
          className="mt-3 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (!password) {
              return setError(t('close.passwordRequired', 'পাসওয়ার্ড দিন'));
            }
            request.mutate();
          }}
        >
          {/* Said in full before the password is asked for, not after. */}
          <p className="text-ink text-sm">
            {t(
              'close.confirmBody',
              'সাত দিন পর সব মুছে যাবে। এই সাত দিনের মধ্যে লগইন করলে বন্ধ করার অনুরোধ নিজে থেকেই বাতিল হয়ে যাবে।',
            )}
          </p>

          <Field label={t('close.password', 'পাসওয়ার্ড দিয়ে নিশ্চিত করুন')} htmlFor="close-pass">
            <Input
              id="close-pass"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          <Field label={t('close.reason', 'কেন বন্ধ করছেন? (ঐচ্ছিক)')} htmlFor="close-reason">
            <Input
              id="close-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
            />
          </Field>

          {error ? (
            <p role="alert" className="text-expense text-sm">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="outline" disabled={request.isPending}>
              {request.isPending
                ? t('common.saving', 'হচ্ছে…')
                : t('close.confirm', 'হ্যাঁ, বন্ধ করুন')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setOpen(false);
                setError(null);
                setPassword('');
              }}
            >
              {t('close.nevermind', 'থাক')}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
