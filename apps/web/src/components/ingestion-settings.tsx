'use client';

import { useQuery } from '@tanstack/react-query';
import { Check, Copy, Eye, EyeOff, Inbox, RotateCw, TriangleAlert } from '@/components/icons';
import Link from 'next/link';
import * as React from 'react';
import { api } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { Skeleton } from './skeleton';
import { Button } from './ui/button';
import { Input } from './ui/field';

/** What `GET /v1/ingestion/webhook-config` returns. */
interface WebhookConfig {
  /** False until INGESTION_WEBHOOK_SECRET is set on the server. */
  configured: boolean;
  url: string;
  workspaceHeader: string;
  workspaceId: string;
  secretHeader: string;
  /** Null when the server has no root secret — then there is nothing to show. */
  secret: string | null;
}

/** Fixed width, so the mask never leaks how long the real secret is. */
const MASK = '••••••••••••••••••••••••';

/** The JSON an SMS-forwarder app should POST. `%from%` / `%text%` are its tokens, not ours. */
const BODY_TEMPLATE = '{"channel":"SMS","sender":"%from%","body":"%text%"}';

/**
 * The same request with the credentials in the body instead of in headers.
 *
 * Offered because the header editor is where people come unstuck: in iOS
 * Shortcuts it is a list of unlabelled `Key`/`name` rows, and filling one in
 * backwards — the workspace id typed as a header *name* — produces a 401 with
 * nothing on screen to explain it. A forwarder that already builds a JSON body
 * can add two more fields to it and never open that sheet.
 *
 * Not less safe: the same secret, over the same TLS, in a POST body rather than
 * a header. It is safer than a URL would be, because nginx writes the path of
 * every request to disk and does not write the body.
 */
const NO_HEADER_TEMPLATE =
  '{"workspace":"%workspace%","secret":"%secret%","channel":"SMS","sender":"%from%","body":"%text%"}';

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied, or an insecure context. The caller falls back to "select it yourself".
  }
  return false;
}

/**
 * Turning message ingestion on.
 *
 * The webhook secret is derived server-side per workspace and stored nowhere,
 * so this screen is the only way anybody can learn their own — without it the
 * whole feature is unreachable. It is treated as a password: masked until
 * asked for, never shown by default, and never put in a screenshot by
 * accident.
 *
 * Self-contained on purpose: it is mounted from the settings page and shares
 * nothing with `(shell)/inbox` but a query-key prefix, so one
 * `invalidateQueries({ queryKey: ['ingestion'] })` still refreshes both.
 */
export function IngestionSettings() {
  const config = useQuery({
    queryKey: ['ingestion', 'webhook-config'],
    queryFn: () => api<WebhookConfig>('/ingestion/webhook-config'),
  });

  const [revealed, setRevealed] = React.useState(false);
  const [copied, setCopied] = React.useState<string | null>(null);
  const [copyFailed, setCopyFailed] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const onCopy = async (key: string, value: string): Promise<void> => {
    const ok = await copyText(value);
    haptic(ok ? 'success' : 'warn');
    setCopyFailed(!ok);
    setCopied(ok ? key : null);
  };

  const data = config.data;

  /* The header-free template with this workspace's own two values already in
     it, so the whole thing is one copy rather than a template plus two
     substitutions somebody has to make by hand on a phone. */
  const noHeaderBody = data
    ? NO_HEADER_TEMPLATE.replace('%workspace%', data.workspaceId).replace(
        '%secret%',
        data.secret ?? '',
      )
    : '';
  const maskedNoHeaderBody = data
    ? NO_HEADER_TEMPLATE.replace('%workspace%', data.workspaceId).replace('%secret%', MASK)
    : '';

  return (
    <section className="rounded-card border-rule bg-surface min-w-0 border-[1.5px] p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-ink text-lg font-bold">বার্তা থেকে লেনদেন (ওয়েবহুক)</h2>
        <Link href="/inbox" className="text-income inline-flex items-center gap-1 text-xs">
          <Inbox className="h-3.5 w-3.5" aria-hidden />
          ইনবক্স দেখুন
        </Link>
      </div>

      <p className="text-ink-muted mt-1 text-sm">
        ফোনে আসা ব্যাংক বা মোবাইল ওয়ালেটের এসএমএস এখানে পাঠালে সেগুলো খসড়া হয়ে ইনবক্সে জমা হবে।
        আপনি দেখে না বললে খাতায় কোনো লেনদেন যোগ হবে না।
      </p>

      {config.isError ? (
        <div
          role="alert"
          className="border-rule mt-3 rounded-xl border border-dashed p-4 text-center"
        >
          <TriangleAlert className="text-expense mx-auto h-5 w-5" aria-hidden />
          <p className="text-ink mt-1 text-sm">ওয়েবহুকের তথ্য আনা যায়নি।</p>
          <p className="text-ink-muted text-xs">ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void config.refetch()}
          >
            <RotateCw className="h-4 w-4" aria-hidden />
            আবার চেষ্টা করুন
          </Button>
        </div>
      ) : config.isLoading || !data ? (
        <div className="mt-3 flex flex-col gap-3">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-11 w-full" />
        </div>
      ) : (
        <>
          {/* The server has no root secret: nothing this screen shows can be
              made to work until somebody sets it, so say that rather than
              handing over an empty box that looks broken. */}
          {!data.configured ? (
            <p
              role="status"
              className="bg-brass/10 text-brass mt-3 flex items-start gap-2 rounded-xl px-3 py-2 text-sm"
            >
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                সার্ভারে এই সুবিধাটি এখন <strong>বন্ধ</strong> আছে, তাই কোনো সিক্রেট তৈরি হয়নি এবং
                কোনো বার্তা গ্রহণ করা হবে না। যিনি সার্ভার চালান তাঁকে{' '}
                <code className="font-mono text-xs">INGESTION_WEBHOOK_SECRET</code> সেট করতে বলুন।
              </span>
            </p>
          ) : null}

          <div className="mt-4 flex flex-col gap-4">
            <CopyRow
              id="ing-url"
              label="ঠিকানা (URL)"
              hint="অ্যাপের URL ঘরে এটি বসান, method হবে POST"
              value={data.url}
              copied={copied === 'url'}
              onCopy={() => void onCopy('url', data.url)}
            />

            <CopyRow
              id="ing-workspace-header"
              label="প্রথম হেডারের নাম"
              value={data.workspaceHeader}
              copied={copied === 'workspaceHeader'}
              onCopy={() => void onCopy('workspaceHeader', data.workspaceHeader)}
            />

            <CopyRow
              id="ing-workspace"
              label="প্রথম হেডারের মান (আপনার ওয়ার্কস্পেস আইডি)"
              value={data.workspaceId}
              copied={copied === 'workspaceId'}
              onCopy={() => void onCopy('workspaceId', data.workspaceId)}
            />

            <CopyRow
              id="ing-secret-header"
              label="দ্বিতীয় হেডারের নাম"
              value={data.secretHeader}
              copied={copied === 'secretHeader'}
              onCopy={() => void onCopy('secretHeader', data.secretHeader)}
            />

            {data.secret ? (
              <CopyRow
                id="ing-secret"
                label="দ্বিতীয় হেডারের মান (সিক্রেট)"
                hint="পাসওয়ার্ডের মতোই গোপন — কাউকে দেবেন না, স্ক্রিনশটে রাখবেন না"
                value={data.secret}
                display={revealed ? data.secret : MASK}
                copied={copied === 'secret'}
                onCopy={() => void onCopy('secret', data.secret ?? '')}
                extra={
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={revealed ? 'সিক্রেট লুকান' : 'সিক্রেট দেখান'}
                    aria-pressed={revealed}
                    onClick={() => {
                      haptic('tap');
                      setRevealed((v) => !v);
                    }}
                  >
                    {revealed ? (
                      <EyeOff className="h-4 w-4" aria-hidden />
                    ) : (
                      <Eye className="h-4 w-4" aria-hidden />
                    )}
                  </Button>
                }
              />
            ) : null}

            <CopyRow
              id="ing-body"
              label="Body (JSON)"
              hint="%from% আর %text% অ্যাপের নিজস্ব টোকেন — আপনার অ্যাপে নাম আলাদা হতে পারে"
              value={BODY_TEMPLATE}
              copied={copied === 'body'}
              onCopy={() => void onCopy('body', BODY_TEMPLATE)}
            />

            {data.secret ? (
              <CopyRow
                id="ing-body-nohead"
                label="হেডার ছাড়া পাঠাতে চাইলে — Body (JSON)"
                hint="এটি ব্যবহার করলে কোনো হেডার লাগবে না। ভেতরে সিক্রেট আছে, তাই কাউকে পাঠাবেন না।"
                value={noHeaderBody}
                display={revealed ? noHeaderBody : maskedNoHeaderBody}
                copied={copied === 'bodyNoHeader'}
                onCopy={() => void onCopy('bodyNoHeader', noHeaderBody)}
              />
            ) : null}
          </div>

          {copyFailed ? (
            <p role="status" className="text-ink-muted mt-2 text-xs">
              কপি করা গেল না — ঘরের লেখায় চাপ দিলে পুরোটা বেছে যাবে, সেখান থেকে নিজে কপি করুন।
            </p>
          ) : null}

          <AndroidSteps />
          <IphoneSteps />
        </>
      )}
    </section>
  );
}

function CopyRow({
  id,
  label,
  hint,
  value,
  display,
  copied,
  onCopy,
  extra,
}: {
  id: string;
  label: string;
  hint?: string;
  /** What gets copied. Always the real thing, even while masked. */
  value: string;
  /** What is shown, when that differs from what is copied. */
  display?: string;
  copied: boolean;
  onCopy: () => void;
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-ink text-sm font-medium">
        {label}
      </label>
      <div className="flex min-w-0 items-center gap-2">
        <Input
          id={id}
          readOnly
          value={display ?? value}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          // Tapping it selects the lot, which is the manual path when the
          // clipboard API is unavailable (http:, or permission refused).
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 font-mono text-xs md:text-xs"
        />
        {extra}
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={`${label} কপি করুন`}
          onClick={onCopy}
        >
          {copied ? (
            <Check className="text-income h-4 w-4" aria-hidden />
          ) : (
            <Copy className="h-4 w-4" aria-hidden />
          )}
        </Button>
      </div>
      {hint ? <p className="text-ink-muted text-xs">{hint}</p> : null}
      <span aria-live="polite" className="sr-only">
        {copied ? `${label} কপি হয়েছে` : ''}
      </span>
    </div>
  );
}

/**
 * The iPhone has no forwarder app worth trusting with bank SMS, so the route is
 * Apple's own Shortcuts automation. It is fiddlier than Android's — four things
 * have to be typed into one screen and none of them is discoverable — which is
 * exactly why the steps below name the buttons.
 *
 * The mistake worth pre-empting: people paste a bare IP and port. The address
 * here is HTTPS on the real hostname, because the secret travels in a header
 * and plain HTTP would put it on the wire in the clear.
 */
function IphoneSteps() {
  const steps: [string, React.ReactNode][] = [
    [
      'অটোমেশন খুলুন',
      <>
        Shortcuts অ্যাপ খুলুন → নিচে <em>Automation</em> → <em>+</em> → নিচে নেমে <em>Message</em>{' '}
        বেছে নিন।
      </>,
    ],
    [
      'কখন চলবে',
      <>
        <em>Message Contains</em>-এ ব্যাংকের বার্তায় থাকে এমন একটি শব্দ দিন — যেমন <code>BDT</code>{' '}
        বা <code>Tk</code>। ঘরটি খালি রাখলে অটোমেশন চালু হবে না। নিচে <em>Run Immediately</em> বেছে
        নিন, নাহলে প্রতিবার হাতে অনুমতি দিতে হবে।
      </>,
    ],
    [
      'অ্যাকশন যোগ করুন',
      <>
        <em>Next</em> → <em>New Blank Automation</em> → খোঁজার ঘরে <em>Get Contents of URL</em> লিখে
        সেটি যোগ করুন।
      </>,
    ],
    [
      'ঠিকানা',
      <>
        URL-এর ঘরে উপরের <strong>ঠিকানাটি</strong> বসান। কোনো IP বা পোর্ট নয় — ঠিকানাটি{' '}
        <code>https://</code> দিয়ে শুরু হতে হবে, কারণ সিক্রেটটি হেডারে যায় এবং সাধারণ{' '}
        <code>http</code>-এ সেটি খোলা তারে চলে যাবে।
      </>,
    ],
    [
      'Method',
      <>
        <em>Get Contents of</em>-এর পাশের তীরটিতে চাপ দিন। <em>Method</em> করুন <code>POST</code>।
      </>,
    ],
    [
      'বার্তার ঘর — হেডার ছাড়াই',
      <>
        <em>Request Body</em> করুন <em>JSON</em>, আর <em>Headers</em> খালিই রাখুন। পাঁচটি ঘর যোগ
        করুন: <code>workspace</code> ও <code>secret</code> (উপরের ঘর দুটি থেকে কপি করে),{' '}
        <code>channel</code> = <code>SMS</code>, <code>sender</code> = বার্তা পাঠানো নম্বর, আর{' '}
        <code>body</code>-তে <em>Shortcut Input</em> ভেরিয়েবলটি (কীবোর্ডের উপরে{' '}
        <em>Shortcut Input</em> লেখা নীল চিপটি)। ওই ভেরিয়েবলেই আসল বার্তাটি থাকে।
      </>,
    ],
    [
      'হেডার দিয়েও করা যায়',
      <>
        <em>Headers</em> ব্যবহার করতে চাইলে <code>workspace</code> আর <code>secret</code> ঘর দুটি
        বাদ দিয়ে উপরের দুই জোড়া নাম ও মান হেডারে বসান। খেয়াল রাখবেন বাঁ পাশে <em>নাম</em>, ডান
        পাশে <em>মান</em> — উল্টে গেলে সাড়া আসবে <code>401</code>।
      </>,
    ],
    [
      'পরীক্ষা করুন',
      <>
        <em>Done</em> চাপুন। এবার নিজের নম্বরে <code>BDT 100 test</code> লিখে একটি বার্তা পাঠান —
        সেটি <a href="/inbox">এসএমএস ইনবক্সে</a> খসড়া হয়ে আসবে। একই বার্তা দুইবার এলে দ্বিতীয়বার
        নতুন কিছু যোগ হবে না।
      </>,
    ],
  ];

  return (
    <details className="border-rule mt-4 rounded-xl border p-3">
      <summary className="text-ink cursor-pointer text-sm font-medium">
        আইফোনে কীভাবে সেট করবেন
      </summary>
      <ol className="mt-3 flex flex-col gap-3">
        {steps.map(([title, body], index) => (
          <li key={title} className="flex min-w-0 gap-3">
            <span
              aria-hidden
              className="bg-greenbar text-ink-muted flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
            >
              {'১২৩৪৫৬৭৮৯'[index] ?? String(index + 1)}
            </span>
            <div className="min-w-0">
              <p className="text-ink text-sm font-medium">{title}</p>
              <p className="text-ink-muted text-sm [&_code]:font-mono [&_code]:text-xs">{body}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="text-ink-muted mt-3 text-xs">
        আইফোনের অটোমেশন কেবল Messages অ্যাপে আসা বার্তাতেই চলে, আর ফোনটি আনলক থাকতে হয় না। WhatsApp
        বা অন্য অ্যাপের বার্তা এভাবে পাঠানো যায় না।
      </p>
    </details>
  );
}

/**
 * Nobody works this out unaided, so it is spelled out.
 *
 * Deliberately app-agnostic: the Play Store has a dozen of these and they come
 * and go, so the steps name the *fields* every one of them has rather than
 * one app's menu path.
 */
function AndroidSteps() {
  const steps: readonly (readonly [string, React.ReactNode])[] = [
    [
      'অ্যাপ নামান',
      <>
        অ্যান্ড্রয়েড ফোনে প্লে স্টোর থেকে এসএমএস ফরওয়ার্ড করার একটি অ্যাপ নামান — খুঁজুন{' '}
        <em>“SMS Forwarder”</em> বা <em>“SMS to URL Forwarder”</em> লিখে।
      </>,
    ],
    [
      'নতুন নিয়ম বানান',
      <>অ্যাপে একটি নতুন rule / forwarder যোগ করুন এবং ধরন হিসেবে ওয়েবহুক বা URL বেছে নিন।</>,
    ],
    [
      'ঠিকানা ও পদ্ধতি',
      <>
        URL-এর ঘরে উপরের <strong>ঠিকানাটি</strong> বসান। Method রাখুন <code>POST</code> এবং
        Content-Type <code>application/json</code>।
      </>,
    ],
    [
      'দুটি হেডার',
      <>
        Headers অংশে উপরের দুই জোড়া নাম ও মান হুবহু বসান — একটি ওয়ার্কস্পেস আইডি, আরেকটি সিক্রেট।
        একটিও ভুল হলে বার্তা গ্রহণ করা হবে না।
      </>,
    ],
    [
      'বার্তার ঘর',
      <>
        Body-তে উপরের JSON বসান। যে অংশে বার্তার লেখা যায় সেখানে অ্যাপের নিজের টোকেন দিন — কোনো
        অ্যাপে <code>%text%</code>, কোনোটিতে <code>{'{{message}}'}</code>।
      </>,
    ],
    [
      'কোন নম্বরগুলো',
      <>
        শুধু ব্যাংক, বিকাশ বা নগদের শর্টকোডগুলো বেছে দিন। সব এসএমএস পাঠালে ইনবক্স অকারণে ভরে যাবে।
      </>,
    ],
    [
      'পরীক্ষা করুন',
      <>
        অ্যাপ থেকে একটি বার্তা পাঠান — সেটি{' '}
        <Link href="/inbox" className="text-income underline">
          এসএমএস ইনবক্সে
        </Link>{' '}
        খসড়া হয়ে আসবে। একই বার্তা দুইবার এলে দ্বিতীয়বার নতুন করে কিছু যোগ হবে না।
      </>,
    ],
  ];

  return (
    <details className="border-rule mt-4 rounded-xl border p-3">
      <summary className="text-ink cursor-pointer text-sm font-medium">
        অ্যান্ড্রয়েড ফোনে কীভাবে সেট করবেন
      </summary>
      <ol className="mt-3 flex flex-col gap-3">
        {steps.map(([title, body], index) => (
          <li key={title} className="flex min-w-0 gap-3">
            <span
              aria-hidden
              className="bg-greenbar text-ink-muted flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
            >
              {'১২৩৪৫৬৭৮৯'[index] ?? String(index + 1)}
            </span>
            <div className="min-w-0">
              <p className="text-ink text-sm font-medium">{title}</p>
              <p className="text-ink-muted text-sm [&_code]:font-mono [&_code]:text-xs">{body}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="text-ink-muted mt-3 text-xs">
        সিক্রেটটি বদলাতে হলে সার্ভারের সেটিং বদলাতে হয়, আর তাতে সব ওয়ার্কস্পেসের সিক্রেট একসাথে
        বদলে যায় — তখন প্রতিটি ফোনের অ্যাপে নতুন সিক্রেট বসাতে হবে।
      </p>
    </details>
  );
}
