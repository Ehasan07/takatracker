'use client';

import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, CircleCheck } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import * as React from 'react';
import { ApiError, api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Field, Select, Textarea } from '@/components/ui/field';
import { haptic } from '@/lib/haptics';
import { t } from '@/lib/t';

/**
 * "Tell us what is broken."
 *
 * ## Why a screen and not a floating button
 *
 * A widget pinned to the corner of every page is the usual answer and it is the
 * wrong one here. It covers the amount column on a 320px phone, it is the first
 * thing a screen reader meets on every screen, and the box it opens is too
 * small to write the paragraph that actually explains a bug. This is a page: it
 * has room, it can be linked to, and it costs nothing on any screen nobody
 * navigated to it from.
 *
 * ## Why the message is one box and not a form
 *
 * Every structured version of this — steps to reproduce, expected, actual — is
 * a form people abandon. The one field that always carries the information is
 * the one where somebody writes what happened in their own words, so that is
 * the only required field. The kind picker sits above it and defaults to
 * "something else", so ignoring it loses nothing.
 *
 * ## Where they were
 *
 * The link that brought them here carries `?from=/reports`, and the referrer is
 * read as a fallback for somebody who typed the address or came from a
 * bookmark. Neither is trusted: the server keeps the path and throws away the
 * query string, because a report about the balance sheet must not smuggle
 * account ids and date ranges into an operator's inbox. See `normaliseScreen`.
 */

const MAX_MESSAGE = 4_000;

type Kind = 'PROBLEM' | 'IDEA' | 'OTHER';

export default function FeedbackPage() {
  return (
    /* `useSearchParams` needs one, and without it Next refuses to prerender the
       route at all — the same reason the reports page has one. */
    <React.Suspense fallback={null}>
      <FeedbackForm />
    </React.Suspense>
  );
}

function FeedbackForm() {
  const params = useSearchParams();
  const [kind, setKind] = React.useState<Kind>('OTHER');
  const [message, setMessage] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState(false);

  /* Read once, after mount. `document.referrer` does not exist during the
     server render, and reading it in the body would hydrate to a different
     value than it rendered with. */
  const [screen, setScreen] = React.useState<string | null>(null);
  React.useEffect(() => {
    const fromLink = params.get('from');
    if (fromLink) return setScreen(fromLink);

    try {
      const referrer = document.referrer ? new URL(document.referrer) : null;
      /* Same origin only. An external referrer says where they came from on the
         internet, which is none of our business and not what the field means. */
      if (referrer && referrer.origin === window.location.origin) setScreen(referrer.pathname);
    } catch {
      /* A malformed referrer is not worth a broken form. */
    }
  }, [params]);

  const submit = useMutation({
    mutationFn: () =>
      api<{ id: string }>('/feedback', {
        method: 'POST',
        body: { kind, message: message.trim(), screen },
        /* Not queued offline, deliberately, unlike a transaction. A parked
           mutation that reappears tomorrow would tell somebody their message
           was sent when it was not, and there is no undo for that. The refusal
           is honest and they can try again. */
      }),
    onSuccess: () => {
      haptic('tap');
      setSent(true);
      setMessage('');
    },
    onError: (err) => {
      setError(
        err instanceof ApiError
          ? err.message
          : t('common.checkConnection', 'সংযোগ দেখে আবার চেষ্টা করুন।'),
      );
    },
  });

  const remaining = MAX_MESSAGE - message.trim().length;

  return (
    <div data-testid="feedback" className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <Link
        href="/settings"
        className="press text-ink-muted hover:text-ink flex min-h-11 w-fit items-center gap-1.5 text-sm"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        {t('nav.settings', 'সেটিংস')}
      </Link>

      <header>
        <h1 className="text-ink text-xl font-semibold sm:text-2xl">
          {t('feedback.title', 'মতামত পাঠান')}
        </h1>
        <p className="text-ink-muted mt-1 text-sm">
          {t(
            'feedback.blurb',
            'কোথাও ভুল দেখছেন, নাকি এমন কিছু চান যা এখনো নেই — দুটোই এখানে লিখুন। যিনি অ্যাপটা বানিয়েছেন তিনিই পড়বেন।',
          )}
        </p>
      </header>

      {sent ? (
        <section
          data-testid="feedback-sent"
          className="rounded-card border-income/40 bg-surface border p-4"
        >
          <h2 className="text-ink flex items-center gap-2 text-sm font-medium">
            <CircleCheck className="text-income h-4 w-4" aria-hidden />
            {t('feedback.sentTitle', 'পৌঁছে গেছে')}
          </h2>
          <p className="text-ink-muted mt-1 text-sm">
            {t(
              'feedback.sentBody',
              'ধন্যবাদ। উত্তর দেওয়ার মতো কিছু থাকলে আপনার ইমেইলেই লেখা হবে।',
            )}
          </p>
          <Button variant="outline" className="mt-3" onClick={() => setSent(false)}>
            {t('feedback.sendAnother', 'আরেকটা কথা আছে')}
          </Button>
        </section>
      ) : (
        <form
          className="rounded-card border-rule bg-surface flex flex-col gap-3 border p-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            /* Refused here as well as on the server, so somebody who taps send
               on an empty box learns it now rather than after a round trip. */
            if (message.trim().length === 0) {
              return setError(t('feedback.empty', 'কিছু একটা লিখুন — খালি পাঠানো যাবে না।'));
            }
            submit.mutate();
          }}
        >
          <Field label={t('feedback.kind', 'কী নিয়ে বলছেন')} htmlFor="feedback-kind">
            <Select
              id="feedback-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as Kind)}
            >
              <option value="PROBLEM">{t('feedback.kind.problem', 'কিছু একটা ভুল হচ্ছে')}</option>
              <option value="IDEA">{t('feedback.kind.idea', 'এমন কিছু চাই যা নেই')}</option>
              <option value="OTHER">{t('feedback.kind.other', 'অন্য কিছু')}</option>
            </Select>
          </Field>

          <Field label={t('feedback.message', 'কী বলতে চান')} htmlFor="feedback-message">
            <Textarea
              id="feedback-message"
              /* Tall enough that a paragraph does not feel unwelcome. The one
                 field that carries the information should not look like a
                 search box. */
              rows={7}
              maxLength={MAX_MESSAGE}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t(
                'feedback.placeholder',
                'যা হয়েছে, আর যা হওয়ার কথা ছিল — নিজের ভাষায় লিখলেই হবে।',
              )}
            />
          </Field>

          {/* Only near the end. A counter that ticks from the first keystroke
              reads as a limit on what you are allowed to say. */}
          {remaining <= 400 ? (
            <p className="text-ink-muted text-xs" aria-live="polite">
              {t('feedback.remaining', 'আর {n} অক্ষর লেখা যাবে').replace('{n}', String(remaining))}
            </p>
          ) : null}

          {screen ? (
            <p className="text-ink-muted text-xs">
              {t('feedback.screen', 'যে পাতা থেকে এসেছেন')}: <code>{screen}</code>
            </p>
          ) : null}

          {error ? (
            <p role="alert" className="text-expense text-sm">
              {error}
            </p>
          ) : null}

          <div>
            <Button type="submit" disabled={submit.isPending}>
              {submit.isPending ? t('common.saving', 'হচ্ছে…') : t('feedback.send', 'পাঠান')}
            </Button>
          </div>
        </form>
      )}

      <p className="text-ink-muted pb-4 text-xs">
        {t(
          'feedback.privacy',
          'আপনার নাম, ইমেইল আর কোন পাতা থেকে লিখছেন সেটুকু বার্তার সঙ্গে যায় — যাতে উত্তর দেওয়া যায়। আপনার লেনদেন বা টাকার অঙ্ক কিছুই যায় না।',
        )}
      </p>
    </div>
  );
}
