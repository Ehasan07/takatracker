import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from '@/components/providers';
import { ServiceWorkerRegistrar } from '@/components/service-worker-registrar';

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
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FAFBF7' },
    { media: '(prefers-color-scheme: dark)', color: '#101614' },
  ],
  width: 'device-width',
  initialScale: 1,
  // Content must reach behind the notch; the shell adds safe-area padding.
  viewportFit: 'cover',
};

/**
 * Runs before the first paint, which is the only time it is any use.
 *
 * The theme choice was written to localStorage by the settings screen and read
 * back by the settings screen — and by nothing else. Every other route loaded
 * with no `.dark` class at all, so somebody who had chosen dark got the light
 * palette everywhere until they visited settings again, and a launch from the
 * home screen flashed white before showing the wrong theme. Applying it here
 * costs one synchronous statement and fixes both.
 *
 * It deliberately leaves `theme-color` alone. The two media-scoped tags below
 * are right whenever the app follows the OS, which is the default and the
 * common case; rewriting them here for someone who has overridden the OS holds
 * only until the first client-side navigation, when Next re-renders its own
 * metadata and puts them back. A tint that is right on launch and flips on the
 * first tap is worse than one that is consistently OS-driven.
 */
const THEME_BOOT = `(function(){try{
var t=localStorage.getItem('hishab.theme');
if(t!=='dark'&&t!=='light')return;
var r=document.documentElement;r.classList.remove('dark','light');r.classList.add(t);
}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="bn" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <Providers>{children}</Providers>
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
