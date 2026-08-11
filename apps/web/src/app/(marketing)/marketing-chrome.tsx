'use client';

import { Menu, X } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';
import { NAV, SITE } from './content';

/**
 * The public header.
 *
 * A client component only because of the phone menu; everything it renders is
 * in the server HTML either way, which is what a crawler and a slow connection
 * both need. The links are real `<a href>` values, so the page works with
 * JavaScript still downloading.
 */
export function MarketingHeader() {
  const [open, setOpen] = React.useState(false);

  return (
    <header className="border-rule bg-paper/85 sticky top-0 z-40 border-b backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Link
          href="/"
          className="press flex min-h-11 items-center gap-2 font-semibold"
          onClick={() => setOpen(false)}
        >
          <span
            aria-hidden
            className="bg-income flex h-7 w-7 items-center justify-center rounded-md text-sm font-bold text-white"
          >
            ৳
          </span>
          <span className="text-ink">{SITE.name}</span>
        </Link>

        <nav aria-label="প্রধান" className="ml-4 hidden items-center gap-1 md:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="press text-ink-muted hover:text-ink hover:bg-greenbar inline-flex min-h-11 items-center rounded-md px-3 text-sm"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Link
            href="/login"
            className="press text-ink hover:bg-greenbar hidden min-h-11 items-center rounded-md px-3 text-sm font-medium sm:inline-flex"
          >
            লগইন
          </Link>
          <Link
            href="/signup"
            className="press bg-income inline-flex min-h-11 items-center rounded-md px-4 text-sm font-medium text-white hover:opacity-90"
          >
            ফ্রি শুরু করুন
          </Link>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="marketing-menu"
            aria-label={open ? 'মেনু বন্ধ করুন' : 'মেনু খুলুন'}
            className="press text-ink hover:bg-greenbar -mr-2 inline-flex h-11 w-11 items-center justify-center rounded-md md:hidden"
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
          {[...NAV, { href: '/login', label: 'লগইন' }].map((item) => (
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
  return (
    <footer className="border-rule bg-greenbar mt-16 border-t">
      <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-10 sm:px-6 md:grid-cols-3">
        <div>
          <p className="text-ink flex items-center gap-2 font-semibold">
            <span
              aria-hidden
              className="bg-income flex h-6 w-6 items-center justify-center rounded text-xs font-bold text-white"
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
        <p className="text-ink-muted mx-auto w-full max-w-6xl px-4 py-4 text-xs sm:px-6">
          © {SITE.name} · takatracker.com
        </p>
      </div>
    </footer>
  );
}
