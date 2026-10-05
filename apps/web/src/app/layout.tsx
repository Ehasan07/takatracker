import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { Providers } from '@/components/providers';
import { ServiceWorkerRegistrar } from '@/components/service-worker-registrar';
import { APPEARANCE_BOOT } from '@/lib/theme';

/**
 * The brand's two typefaces, self-hosted from woff2 files committed to the repo.
 *
 * They used to come from `next/font/google`, which still self-hosts the result
 * — but only after fetching the files from fonts.gstatic.com *at build time*.
 * That turns Google into a hard dependency of every release, and on 15 Aug 2026
 * it took a production deploy down: the VPS could not reach gstatic, and
 * `next build` died with `Failed to fetch \`Anek Bangla\` from Google Fonts`
 * rather than shipping. Nothing about the running app needed Google; only the
 * build did. So the exact same subsets are checked into `./fonts` and read off
 * disk, and a release can now be cut from a box with no route to the internet.
 *
 * Refreshing them is a deliberate act, not a silent one: fetch the css2 URL for
 * the family, weights and subsets below, download the woff2 it points at, and
 * replace the files. Pinning bytes is the point — a font that changes under us
 * between two builds of the same commit is a reproducibility bug, not a
 * feature.
 *
 * `display: 'swap'` means text is readable in the fallback before the file
 * lands rather than invisible while it downloads.
 *
 * Ador Noirrit is the house Bengali face, but it is licensed from Lipighor
 * rather than published on Google Fonts. Dropping it in later is now just a
 * matter of swapping the woff2 in `./fonts` and the family name here.
 */

/* The Bengali subset of Anek Bangla, which is what the app is mostly set in.
 *
 * One file covers every weight because Anek Bangla is variable — so `400 800`
 * is a range, not a list, and text at 500 interpolates instead of snapping.
 * The file is the same bytes Google serves for a 400..800 request; it was
 * declared as 400–600 until the headings started using 700 and 800, and the
 * browser clamps a request to the declared range rather than to the file.
 *
 * `unicode-range` is what stops this 152 KB file from being pulled onto a page
 * that has no Bengali on it, and — more importantly — what makes the fall
 * through to the Latin face below deterministic rather than a bet on how a
 * given browser handles a missing glyph. `next/font/local` has no per-file
 * unicode-range, hence one call per subset. */
const bengali = localFont({
  src: [{ path: './fonts/anek-bangla-bengali.woff2', weight: '400 800', style: 'normal' }],
  display: 'swap',
  variable: '--font-bengali',
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0951-0952, U+0964-0965, U+0980-09FE, U+1CD0, U+1CD2, U+1CD5-1CD6, U+1CD8, U+1CE1, U+1CEA, U+1CED, U+1CF2, U+1CF5-1CF7, U+200C-200D, U+20B9, U+25CC, U+A8F1',
    },
  ],
  /* No metric-adjusted Arial fallback face. Next would insert one *ahead* of
     the rest of the stack, and since Arial has no Bengali glyphs it buys
     nothing here while shadowing the faces that do — including the Latin cut
     below. The stack in @hishab/ui names real Bengali fallbacks instead. */
  adjustFontFallback: false,
});

/* The Latin cut of the same family, so Latin inside a Bengali sentence stays in
   Anek Bangla rather than dropping to the Latin face. Second in the stack, and
   only ever reached for the code points above. */
const bengaliLatin = localFont({
  src: [{ path: './fonts/anek-bangla-latin.woff2', weight: '400 800', style: 'normal' }],
  display: 'swap',
  variable: '--font-bengali-latin',
  declarations: [
    {
      prop: 'unicode-range',
      value:
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
    },
  ],
  adjustFontFallback: false,
});

/* Bai Jamjuree is not variable, so its weights really are separate files. Four,
   not the whole family: every extra one is a file a phone has to download
   before the page settles. 700 is the wordmark's weight — the face the
   `Taka Tracker` lockup in brand/ is drawn in. */
const latin = localFont({
  src: [
    { path: './fonts/bai-jamjuree-latin-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/bai-jamjuree-latin-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/bai-jamjuree-latin-600.woff2', weight: '600', style: 'normal' },
    { path: './fonts/bai-jamjuree-latin-700.woff2', weight: '700', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-latin',
});

export const metadata: Metadata = {
  /* Absolute URLs for canonical, Open Graph and the sitemap all resolve
   * against this. Without it Next emits relative `og:url` values, which most
   * scrapers — Facebook and WhatsApp among them, the two that matter most in
   * Bangladesh — refuse to follow, so a shared link renders as a bare URL. */
  metadataBase: new URL('https://takatracker.com'),
  title: {
    default: 'Taka Tracker — বাংলাদেশের ব্যক্তিগত হিসাবের সফটওয়্যার',
    /* Public pages set their own full title; app screens inherit the suffix, so
     * a browser tab or a shared link always says which product it is. */
    /* App screens inherit the suffix so a tab always says which product it is.
       The public pages set a full title of their own and are exempt — the
       landing page already opens with the name, and "… | Personal Finance App ·
       Taka Tracker" reads like a mistake. */
    template: '%s · Taka Tracker',
  },
  description:
    'আয়, খরচ, ধার-দেনা, সঞ্চয় ও বীমার ব্যক্তিগত হিসাব — সম্পূর্ণ বাংলায়, ডাবল-এন্ট্রি হিসাবরক্ষণের উপর তৈরি। A double-entry personal finance app for Bangladesh.',
  applicationName: 'Taka Tracker',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Taka Tracker' },
  icons: {
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/icon-192.png', sizes: '192x192' }],
  },
};

export const viewport: Viewport = {
  /* One colour: the app opens light whatever the phone is set to, so a dark
     address bar above a light page would be the only dark thing on screen. */
  themeColor: '#F5F8F6',
  width: 'device-width',
  initialScale: 1,
  // Content must reach behind the notch; the shell adds safe-area padding.
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="bn"
      suppressHydrationWarning
      className={`${bengali.variable} ${bengaliLatin.variable} ${latin.variable}`}
    >
      <head>
        {/* Parser-blocking, in the head, before a single pixel is painted —
            which is the only position that removes the flash rather than
            shortening it. It sets `data-theme` and `data-mode` on <html> from
            localStorage; the reasoning, and the script itself, are in
            lib/theme.ts, so that the code which paints the theme on load and
            the code which repaints it when a button is pressed are literally
            the same function. */}
        <script dangerouslySetInnerHTML={{ __html: APPEARANCE_BOOT }} />
      </head>
      <body>
        <Providers>{children}</Providers>
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
