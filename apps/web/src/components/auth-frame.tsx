import Link from 'next/link';
import type { ReactNode } from 'react';
import { Notes } from '@/app/(marketing)/hero-preview';
import { Check } from '@/components/icons';
import { LogoGlyph } from '@/components/brand-mark';
import { HERO, UI_BN } from '@/app/(marketing)/content';

/**
 * The frame every sign-in page sits in: the brand on a green panel, the form
 * beside it.
 *
 * On a wide screen the panel holds the left half still while the form side
 * scrolls; on a phone it shrinks to a band across the top, so the first thing
 * under a thumb is still the first field. The panel is decoration and the
 * product's promise — the page's own heading stays in the form column, where
 * the page has always put it.
 *
 * `<main>` is the scroller, as it was on each page before: a centred column
 * taller than its scroller loses its top, so the form is centred with auto
 * margins rather than `justify-center`.
 */
export function AuthFrame({ children }: { children: ReactNode }) {
  const promises = UI_BN.heroNote
    .split('·')
    .map((part) => part.trim())
    .filter(Boolean);
  return (
    <main className="app-scroll bg-paper h-dvh">
      <div className="flex min-h-full flex-col lg:flex-row">
        <aside className="relative flex shrink-0 flex-col overflow-hidden rounded-b-[28px] bg-[#1F6F4A] px-5 pb-6 pt-5 text-white lg:sticky lg:top-0 lg:h-dvh lg:w-[46%] lg:rounded-b-none lg:rounded-r-[40px] lg:px-14 lg:pb-12 lg:pt-12">
          <Link href="/" className="press flex min-h-11 items-center gap-3 self-start">
            <LogoGlyph className="h-10 w-10" />
            <span className="font-wordmark text-xl font-bold">Taka Tracker</span>
          </Link>
          <p className="mt-16 hidden max-w-[11em] text-[44px] font-extrabold leading-[1.15] lg:block">
            {HERO.title}
          </p>
          <span aria-hidden className="bg-gold mt-6 hidden h-2 w-[88px] rounded-full lg:block" />
          <ul className="mt-6 hidden flex-col gap-2.5 text-base text-white/90 lg:flex">
            {promises.map((promise) => (
              <li key={promise} className="flex items-center gap-2.5">
                <Check className="h-5 w-5 text-[#F1D9A8]" aria-hidden />
                {promise}
              </li>
            ))}
          </ul>
          <div aria-hidden className="mt-auto hidden pt-10 lg:block">
            <Notes isBn className="w-full max-w-[400px] overflow-visible" />
          </div>
        </aside>

        <div className="flex flex-1 flex-col">
          <div className="safe-x mx-auto my-auto flex w-full max-w-sm flex-col gap-6 py-10 [--gutter-x:1rem] lg:max-w-[420px]">
            {children}
          </div>
        </div>
      </div>
    </main>
  );
}
