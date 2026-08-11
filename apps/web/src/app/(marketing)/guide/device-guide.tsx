'use client';

import Link from 'next/link';
import * as React from 'react';
import type { DeviceKind } from '@hishab/shared';
import { GUIDES, StepArt, guideFor } from './steps';

/**
 * Guess which phone this is.
 *
 * A guess, not a detection: `userAgent` is a string a browser is free to lie
 * about and several do. It only picks which tab opens first — every device's
 * instructions stay one tap away, and the tabs are real buttons rather than a
 * detected-and-hidden panel, so a wrong guess costs a tap and never a dead end.
 *
 * iPad is the case worth the extra clause: since iPadOS 13 it reports itself as
 * a Macintosh, and the only reliable tell is that a Mac has no touch screen.
 */
export function guessDevice(ua: string, touchPoints: number): DeviceKind {
  const s = ua.toLowerCase();
  if (/iphone|ipod/.test(s)) return 'IOS';
  if (/ipad/.test(s) || (/macintosh/.test(s) && touchPoints > 1)) return 'IOS';
  if (/android/.test(s)) return 'ANDROID';
  return 'DESKTOP';
}

export function DeviceGuidePanel({ initial }: { initial?: DeviceKind }) {
  /* Starts on the server-rendered default so the HTML a crawler reads is a
     complete set of instructions, then corrects to the reader's own device
     after mount. Detecting during render would be a hydration mismatch. */
  const [kind, setKind] = React.useState<DeviceKind>(initial ?? 'ANDROID');

  React.useEffect(() => {
    if (initial) return;
    setKind(guessDevice(navigator.userAgent, navigator.maxTouchPoints ?? 0));
  }, [initial]);

  const guide = guideFor(kind);

  return (
    <div>
      <div role="tablist" aria-label="ডিভাইস" className="flex flex-wrap gap-2">
        {GUIDES.map((g) => (
          <button
            key={g.kind}
            type="button"
            role="tab"
            aria-selected={g.kind === kind}
            onClick={() => setKind(g.kind)}
            className={`press inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium ${
              g.kind === kind
                ? 'border-income bg-income text-white'
                : 'border-rule bg-surface text-ink hover:bg-greenbar'
            }`}
          >
            {g.label}
          </button>
        ))}
      </div>

      <p className="text-ink-muted mt-4 text-sm">
        <strong className="text-ink font-medium">{guide.browser}</strong> দিয়ে করলে সবচেয়ে সহজ।{' '}
        {guide.caveat}
      </p>

      <ol aria-label={`${guide.label} — ধাপ`} className="mt-6 space-y-3">
        {guide.steps.map((step, index) => (
          <li
            key={step.title}
            className="rounded-card border-rule bg-surface flex items-start gap-4 border p-4"
          >
            <span
              aria-hidden
              className="bg-greenbar text-income flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
            >
              {['১', '২', '৩', '৪', '৫'][index]}
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-ink text-sm font-medium">{step.title}</h3>
              <p className="text-ink-muted mt-1 text-sm">{step.body}</p>
            </div>
            {step.art ? <StepArt art={step.art} /> : null}
          </li>
        ))}
      </ol>

      <div className="rounded-card border-rule bg-greenbar mt-6 border p-5">
        <h3 className="text-ink text-sm font-medium">বসানোর পর কী বদলায়</h3>
        <ul className="mt-2 space-y-1">
          {[
            'হোম স্ক্রিন থেকে সরাসরি খুলবে, ব্রাউজারের ঠিকানার ঘর ছাড়াই',
            'নেট না থাকলেও খুলবে, আর তখন লেখা এন্ট্রি জমা থাকবে — সংযোগ ফিরলে নিজে থেকেই চলে যাবে',
            'ক্রেডিট কার্ডের তাগাদা আর অন্যান্য নোটিফিকেশন ফোনে পাবেন',
          ].map((line) => (
            <li key={line} className="text-ink-muted text-sm">
              • {line}
            </li>
          ))}
        </ul>
        <Link
          href="/signup"
          className="press bg-income mt-4 inline-flex min-h-11 items-center rounded-md px-5 text-sm font-medium text-white hover:opacity-90"
        >
          ফ্রি অ্যাকাউন্ট খুলুন
        </Link>
      </div>
    </div>
  );
}
