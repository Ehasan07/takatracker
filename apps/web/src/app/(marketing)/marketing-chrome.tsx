'use client';

import { Menu, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';
import { Languages } from 'lucide-react';
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
    <header className="border-rule bg-paper/85 sticky top-0 z-40 border-b backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Link href="/" className="press flex min-h-11 items-center" onClick={() => setOpen(false)}>
          <BrandMark />
        </Link>

        <nav aria-label="প্রধান" className="ml-4 hidden items-center gap-1 md:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="press text-ink-muted hover:text-ink hover:bg-brand-tint inline-flex min-h-11 items-center rounded-md px-3 text-sm"
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
            className="press text-ink-muted hover:text-ink hover:bg-brand-tint inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm"
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
            className="press text-ink hover:bg-brand-tint hidden min-h-11 items-center rounded-md px-3 text-sm font-medium sm:inline-flex"
          >
            {ui.login}
          </Link>
          <Link
            href="/signup"
            className="press bg-brand text-brand-contrast inline-flex min-h-11 items-center rounded-md px-4 text-sm font-medium hover:opacity-90"
          >
            {ui.startFree}
          </Link>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="marketing-menu"
            aria-label={open ? 'মেনু বন্ধ করুন' : 'মেনু খুলুন'}
            className="press text-ink hover:bg-brand-tint -mr-2 inline-flex h-11 w-11 items-center justify-center rounded-md md:hidden"
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
          className="border-rule bg-paper border-t px-4 pb-3 md:hidden"
        >
          {[...NAV, { href: '/login', label: ui.login }].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className="press text-ink border-rule flex min-h-12 items-center border-b text-sm last:border-b-0"
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
  const { nav: NAV } = contentFor(pathname);
  return (
    <footer className="border-rule bg-brand-tint mt-16 border-t">
      <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-10 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
        <div>
          <p className="text-ink flex items-center gap-2 font-semibold">
            <span
              aria-hidden
              className="bg-brand text-brand-contrast flex h-6 w-6 items-center justify-center rounded text-xs font-bold"
            >
              ৳
            </span>
            {SITE.name}
          </p>
          <p className="text-ink-muted mt-2 max-w-xs text-sm">{SITE.tagline}</p>
          <p className="text-ink-muted mt-2 text-xs">
            Hishab — a double-entry personal finance app for Bangladesh.
          </p>
        </div>

        <nav aria-label="ফুটার">
          <h2 className="text-ink text-sm font-medium">পণ্য</h2>
          <ul className="mt-1">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="press text-ink-muted hover:text-ink inline-flex min-h-11 items-center text-sm"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <nav aria-label="যোগাযোগ">
          <h2 className="text-ink text-sm font-medium">যোগাযোগ</h2>
          <ul className="mt-1">
            <li>
              <a
                href={CONTACT.hotlineHref}
                className="press text-ink hover:text-brand inline-flex min-h-11 items-center text-sm font-medium"
              >
                হটলাইন {CONTACT.hotline}
              </a>
            </li>
            <li>
              <a
                href={CONTACT.telegram}
                target="_blank"
                rel="noopener noreferrer"
                className="press text-ink-muted hover:text-ink inline-flex min-h-11 items-center text-sm"
              >
                টেলিগ্রাম চ্যানেল
              </a>
            </li>
            <li>
              <a
                href={CONTACT.whatsapp}
                target="_blank"
                rel="noopener noreferrer"
                className="press text-ink-muted hover:text-ink inline-flex min-h-11 items-center text-sm"
              >
                হোয়াটসঅ্যাপ চ্যানেল
              </a>
            </li>
          </ul>
        </nav>

        <nav aria-label="অ্যাকাউন্ট">
          <h2 className="text-ink text-sm font-medium">অ্যাকাউন্ট</h2>
          <ul className="mt-1">
            <li>
              <Link
                href="/signup"
                className="press text-ink-muted hover:text-ink inline-flex min-h-11 items-center text-sm"
              >
                ফ্রি অ্যাকাউন্ট খুলুন
              </Link>
            </li>
            <li>
              <Link
                href="/login"
                className="press text-ink-muted hover:text-ink inline-flex min-h-11 items-center text-sm"
              >
                লগইন
              </Link>
            </li>
            <li>
              <Link
                href="/forgot"
                className="press text-ink-muted hover:text-ink inline-flex min-h-11 items-center text-sm"
              >
                পাসওয়ার্ড ভুলে গেছেন
              </Link>
            </li>
          </ul>
        </nav>
      </div>

      <div className="border-rule border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-4 sm:px-6">
          <p className="text-ink-muted text-xs">
            © {SITE.name} · takatracker.com ·{' '}
            <Link href="/privacy" className="hover:text-ink underline">
              গোপনীয়তা
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
                className="press text-ink-muted hover:text-ink inline-flex min-h-11 items-center text-xs"
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
