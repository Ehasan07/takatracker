'use client';

import * as React from 'react';
import { BrandMark } from '@/components/brand-mark';

/**
 * Something threw while rendering, said in the app's own voice.
 *
 * ## Why a boundary at all
 *
 * Without one, a single component throwing takes the whole page to Next's
 * default error screen — the same black page as the built-in 404, with a stack
 * trace in development and a bare apology in production. Neither tells the
 * person what to do, and neither offers the one thing that usually works, which
 * is trying again: most of what throws here is a render against data that
 * arrived half-formed, and a re-render with the query refetched fixes it.
 *
 * `reset()` is that retry. It re-renders the segment rather than reloading the
 * document, so a phone on a bad connection does not pay for the whole app
 * again.
 *
 * ## What it does not do
 *
 * It does not show the error text. A message like `Cannot read properties of
 * undefined` tells a bookkeeper nothing and reads as though their money is at
 * risk. It goes to the console, where whoever is debugging can find it, and the
 * screen says the two things that are true: nothing was written to the ledger,
 * and here is how to carry on.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    /* The one place the detail is kept. Not on screen — see above. */
    console.error('[app] render failed', error);
  }, [error]);

  return (
    <main className="bg-paper text-ink flex min-h-dvh flex-col items-center justify-center gap-6 px-5 py-12 text-center">
      <BrandMark size="md" />

      <div className="max-w-sm">
        <h1 className="text-ink text-xl font-semibold sm:text-2xl">কিছু একটা ভুল হয়েছে</h1>
        <p className="text-ink-muted mt-2 text-sm leading-relaxed">
          পাতাটি দেখাতে গিয়ে সমস্যা হয়েছে। খাতায় কিছু লেখা হয়নি — আপনার হিসাব যেমন ছিল তেমনই
          আছে। আবার চেষ্টা করে দেখুন।
        </p>
        {error.digest ? (
          <p className="text-ink-muted mt-2 font-mono text-xs">
            {/* The id a support conversation can be hung on. Not the message. */}
            {error.digest}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={reset}
          className="press bg-brand text-brand-contrast hover:bg-brand-strong flex min-h-11 items-center rounded-md px-4 text-sm font-medium"
        >
          আবার চেষ্টা করুন
        </button>
        <a
          href="/"
          className="press border-rule text-ink hover:bg-greenbar flex min-h-11 items-center rounded-md border px-4 text-sm"
        >
          হোমে ফিরুন
        </a>
      </div>
    </main>
  );
}
