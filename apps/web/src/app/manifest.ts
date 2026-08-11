import type { MetadataRoute } from 'next';

/**
 * Everything the browser needs to stop treating this as a tab.
 *
 * `id` is the one field with no visible effect and real consequences: without
 * it the install identity is derived from `start_url`, so the day `start_url`
 * changes the installed app becomes a *different* app — the old icon keeps
 * pointing at a stale entry and the prompt offers to install a second copy.
 * It is declared explicitly and must never change again.
 *
 * `screenshots` are what turn Chrome's one-line "Install?" bar into the richer
 * install dialogue with a preview. They are generated from the real running app
 * by scripts/screenshots.mjs rather than drawn, so they cannot drift from what
 * a person actually gets. Chrome wants every image in a form factor to share an
 * aspect ratio and to be no more than 2.3× longer than it is wide; 390×844 and
 * 1280×800 are inside that.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Taka Tracker',
    short_name: 'Taka Tracker',
    description: 'আয়, খরচ, ধার-দেনা ও সঞ্চয়ের ব্যক্তিগত হিসাব।',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'portrait',
    background_color: '#FAFBF7',
    theme_color: '#1F6F4A',
    lang: 'bn',
    dir: 'ltr',
    categories: ['finance', 'productivity'],
    prefer_related_applications: false,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    screenshots: [
      {
        src: '/screenshots/phone-dashboard.png',
        sizes: '390x844',
        type: 'image/png',
        form_factor: 'narrow',
        label: 'ড্যাশবোর্ড — এই মাসের আয়, খরচ ও ব্যালেন্স',
      },
      {
        src: '/screenshots/phone-more.png',
        sizes: '390x844',
        type: 'image/png',
        form_factor: 'narrow',
        label: 'আরও — অ্যাপের সব পাতা এক জায়গায়',
      },
      {
        src: '/screenshots/desktop-dashboard.png',
        sizes: '1280x800',
        type: 'image/png',
        form_factor: 'wide',
        label: 'ডেস্কটপে Taka Tracker',
      },
    ],
    /* Four is what a long-press menu shows on Android. Each one lands on a
     * screen that exists and does something — `?quickadd=` is read by the shell
     * and opens the sheet, rather than quietly doing nothing the way it used
     * to. */
    shortcuts: [
      { name: 'নতুন লেনদেন', short_name: 'নতুন', url: '/?quickadd=1' },
      { name: 'খাতা', url: '/transactions' },
      { name: 'বার্তার ইনবক্স', short_name: 'ইনবক্স', url: '/inbox' },
      { name: 'রিপোর্ট', url: '/reports' },
    ],
  };
}
