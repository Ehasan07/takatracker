import Link from 'next/link';
import { BrandMark } from '@/components/brand-mark';

/**
 * A page that is not there, said in the app's own voice.
 *
 * ## Why this file exists
 *
 * Without it Next serves its built-in 404: black background, `This page could
 * not be found.`, and nothing else — no header, no navigation, no Bengali, no
 * way back except the browser's own button. It does not look like this product
 * because it is not part of it, and somebody who lands on it has no way to tell
 * whether the app is broken or they simply followed a stale link.
 *
 * That page is not hypothetical. The সম্পদ screen linked every asset to
 * `/accounts/[id]`, a route nobody ever wrote, so tapping any row served
 * exactly it. The link is fixed and `routes.test.ts` now refuses the whole
 * class — but a 404 will always be reachable by typing, by an old bookmark, by
 * a link shared after a page was renamed, and what it should do then is say so
 * in the language of the person reading it and offer a way onwards.
 *
 * ## Deliberately server-rendered
 *
 * No `use client`, no hooks, no `t()`. This has to render when something has
 * already gone wrong, so it depends on nothing that could be the thing that
 * went wrong — no query client, no workspace settings, no locale fetched from
 * an API. The Bengali is literal for the same reason.
 */
export default function NotFound() {
  return (
    <main className="bg-paper text-ink flex min-h-dvh flex-col items-center justify-center gap-6 px-5 py-12 text-center">
      <BrandMark size="md" />

      <div className="max-w-sm">
        <p className="text-ink-muted text-sm font-medium">৪০৪</p>
        <h1 className="text-ink mt-1 text-xl font-semibold sm:text-2xl">
          পাতাটি খুঁজে পাওয়া গেল না
        </h1>
        <p className="text-ink-muted mt-2 text-sm leading-relaxed">
          ঠিকানাটি হয়তো বদলে গেছে, নয়তো পাতাটি আর নেই। আপনার হিসাবের কিছু হারায়নি — খাতায় সব
          আগের মতোই আছে।
        </p>
      </div>

      {/* Two ways on, and the first is the one that always works. */}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Link
          href="/"
          className="press bg-brand text-brand-contrast hover:bg-brand-strong flex min-h-11 items-center rounded-md px-4 text-sm font-medium"
        >
          হোমে ফিরুন
        </Link>
        <Link
          href="/transactions"
          className="press border-rule text-ink hover:bg-greenbar flex min-h-11 items-center rounded-md border px-4 text-sm"
        >
          খাতা দেখুন
        </Link>
      </div>
    </main>
  );
}
