'use client';

import { Languages, Menu, Phone, X } from '@/components/icons';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';
import { BrandMark } from '@/components/brand-mark';
import { CONTACT, CONTENT_BN, SITE, SOCIAL } from './content';
import { CONTENT_EN } from './content.en';

/** Which language this page is in, decided by the URL rather than a cookie. */
export const contentFor = (pathname: string) =>
  pathname === '/en' || pathname.startsWith('/en/') ? CONTENT_EN : CONTENT_BN;

/**
 * The public header.
 *
 * A client component only because of the phone menu; everything it renders is
 * in the server HTML either way, which is what a crawler and a slow connection
 * both need. The links are real `<a href>` values, so the page works with
 * JavaScript still downloading.
 */
export function MarketingHeader() {
  const pathname = usePathname();
  const { nav: NAV, ui } = contentFor(pathname);
  const [open, setOpen] = React.useState(false);

  return (
    <header className="border-rule/70 bg-surface/85 sticky top-0 z-40 border-b backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-3 px-4 sm:h-[72px] sm:px-6">
        <Link href="/" className="press flex min-h-11 items-center" onClick={() => setOpen(false)}>
          {/* The mark alone below 420px: a 390px phone has room for the mark,
              the language switch, the call to action and the menu, and the
              wordmark beside them wrapped onto two lines. */}
          <BrandMark size="sm" wordmark={false} className="min-[420px]:hidden" />
          <BrandMark size="sm" className="hidden min-[420px]:flex sm:hidden" />
          <BrandMark size="md" className="hidden sm:flex" />
          <span className="sr-only min-[420px]:hidden">{SITE.name}</span>
        </Link>

        {/* `lg`, not `md`. Seven links, the language toggle, a sign-in link and
            a call to action do not fit across a 768px tablet — they pushed the
            header 53px past the viewport and took the whole page sideways with
            it. Below `lg` the same links live in the ⋮ menu, which is where a
            reader on a narrow screen looks for them anyway. */}
        <nav aria-label="প্রধান" className="ml-5 hidden items-center gap-0.5 lg:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="press text-ink-muted hover:text-ink decoration-expense inline-flex min-h-11 items-center rounded-lg px-2.5 text-[15px] font-medium underline-offset-[10px] hover:underline hover:decoration-2"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {/* The switch is a plain link to the other language's URL rather than
              a cookie or a client-side toggle: the two pages are separate
              documents with their own `hreflang`, and a crawler has to be able
              to follow it. */}
          <Link
            href={ui.otherLocaleHref}
            hrefLang={ui.otherLocaleHref === '/en' ? 'en' : 'bn'}
            aria-label={ui.otherLocaleLabel}
            className="press text-ink-muted hover:text-ink bg-greenbar hover:bg-brand-tint inline-flex min-h-10 items-center gap-1.5 rounded-full px-3 text-sm font-medium"
          >
            <Languages className="h-4 w-4" aria-hidden />
            {/* The label is hidden below 400px and the icon carries it there.
                A 320px phone has room for the logo, the switch, the signup
                button and the menu — and not for a fourth word, which pushed
                the header 10px wider than the viewport. */}
            <span className="hidden min-[400px]:inline">{ui.otherLocaleLabel}</span>
          </Link>
          <Link
            href="/login"
            className="press text-ink hover:bg-greenbar hidden min-h-11 items-center rounded-xl px-3 text-[15px] font-semibold sm:inline-flex"
          >
            {ui.login}
          </Link>
          <Link
            href="/signup"
            className="press bg-brand text-brand-contrast hover:bg-brand-soft inline-flex min-h-11 items-center whitespace-nowrap rounded-[14px] px-3.5 text-sm font-semibold shadow-[0_3px_0_var(--hishab-brand-strong)] sm:px-5 sm:text-[15px]"
          >
            {ui.startFree}
          </Link>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="marketing-menu"
            aria-label={open ? 'মেনু বন্ধ করুন' : 'মেনু খুলুন'}
            className="press text-ink bg-greenbar hover:bg-brand-tint -mr-1 inline-flex h-11 w-11 items-center justify-center rounded-xl lg:hidden"
          >
            {open ? (
              <X className="h-5 w-5" aria-hidden />
            ) : (
              <Menu className="h-5 w-5" aria-hidden />
            )}
          </button>
        </div>
      </div>

      {open ? (
        <nav
          id="marketing-menu"
          aria-label="মোবাইল"
          className="border-rule bg-surface menu-drop border-t px-4 pb-4 lg:hidden"
        >
          {[...NAV, { href: '/login', label: ui.login }].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className="press text-ink border-rule min-h-13 flex items-center border-b text-base font-medium last:border-b-0"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </header>
  );
}

export function MarketingFooter() {
  const pathname = usePathname();
  const { nav: NAV, doors } = contentFor(pathname);
  return (
    <footer className="border-rule bg-surface mt-24 border-t">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-14 sm:grid-cols-2 sm:px-6 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div>
          <p className="flex items-center">
            <BrandMark size="md" />
            <span className="sr-only">{SITE.name}</span>
          </p>
          <span aria-hidden className="bg-gold mt-4 block h-1.5 w-12 rounded-full" />
          <p className="text-ink-muted mt-4 max-w-xs text-[15px] leading-relaxed">{SITE.tagline}</p>
          <p className="text-ink-muted mt-2 text-xs">
            Hishab — a double-entry personal finance app for Bangladesh.
          </p>
        </div>

        <nav aria-label="ফুটার">
          <h2 className="text-ink text-sm font-bold">পণ্য</h2>
          <ul className="mt-1">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="press text-ink-muted hover:text-brand inline-flex min-h-10 items-center text-[15px]"
                >
                  {item.label}
                </Link>
              </li>
            ))}
            {/* On every public page, not only the landing one, so the trade
                site is linked from the whole domain under the words people
                search it by. */}
            <li>
              <a
                href={doors.business.href}
                className="press text-ink-muted hover:text-brand inline-flex min-h-10 items-center text-[15px]"
              >
                {doors.business.footerLabel}
              </a>
            </li>
          </ul>
        </nav>

        <nav aria-label="যোগাযোগ">
          <h2 className="text-ink text-sm font-bold">যোগাযোগ</h2>
          <ul className="mt-1">
            <li>
              <a
                href={CONTACT.hotlineHref}
                className="press text-ink hover:text-brand inline-flex min-h-11 items-center gap-2 text-[15px] font-bold"
              >
                <Phone className="text-brand h-[18px] w-[18px]" aria-hidden />
                হটলাইন {CONTACT.hotline}
              </a>
            </li>
            <li>
              <a
                href={CONTACT.telegram}
                target="_blank"
                rel="noopener noreferrer"
                className="press text-ink-muted hover:text-brand inline-flex min-h-10 items-center text-[15px]"
              >
                টেলিগ্রাম চ্যানেল
              </a>
            </li>
            <li>
              <a
                href={CONTACT.whatsapp}
                target="_blank"
                rel="noopener noreferrer"
                className="press text-ink-muted hover:text-brand inline-flex min-h-10 items-center text-[15px]"
              >
                হোয়াটসঅ্যাপ চ্যানেল
              </a>
            </li>
          </ul>
        </nav>

        <nav aria-label="অ্যাকাউন্ট">
          <h2 className="text-ink text-sm font-bold">অ্যাকাউন্ট</h2>
          <ul className="mt-1">
            <li>
              <Link
                href="/signup"
                className="press text-ink-muted hover:text-brand inline-flex min-h-10 items-center text-[15px]"
              >
                ফ্রি অ্যাকাউন্ট খুলুন
              </Link>
            </li>
            <li>
              <Link
                href="/login"
                className="press text-ink-muted hover:text-brand inline-flex min-h-10 items-center text-[15px]"
              >
                লগইন
              </Link>
            </li>
            <li>
              <Link
                href="/forgot"
                className="press text-ink-muted hover:text-brand inline-flex min-h-10 items-center text-[15px]"
              >
                পাসওয়ার্ড ভুলে গেছেন
              </Link>
            </li>
          </ul>
        </nav>
      </div>

      <div className="border-rule border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-4 sm:px-6">
          <p className="text-ink-muted text-sm">
            © {SITE.name} · takatracker.com ·{' '}
            <Link href="/privacy" className="hover:text-ink underline">
              গোপনীয়তা
            </Link>{' '}
            ·{' '}
            <Link href="/delete-account" className="hover:text-ink underline">
              অ্যাকাউন্ট মুছে ফেলা
            </Link>
          </p>
          <nav aria-label="সোশ্যাল" className="ml-auto flex flex-wrap items-center gap-x-3">
            {SOCIAL.map((item) => (
              <a
                key={item.label}
                href={item.href}
                /* `noopener` is the security half and `noreferrer` the privacy
                   half; a target="_blank" without the first hands the opened
                   page a live `window.opener` back into this one. */
                target="_blank"
                rel="noopener noreferrer"
                className="press text-ink-muted hover:text-brand inline-flex min-h-11 items-center text-sm"
              >
                {item.label}
              </a>
            ))}
          </nav>
        </div>
      </div>
    </footer>
  );
}
