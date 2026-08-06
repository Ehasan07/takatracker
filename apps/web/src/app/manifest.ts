import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'হিসাব — Taka Tracker',
    short_name: 'হিসাব',
    description: 'আয়, খরচ, ধার-দেনা ও সঞ্চয়ের ব্যক্তিগত হিসাব।',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#FAFBF7',
    theme_color: '#1F6F4A',
    lang: 'bn',
    dir: 'ltr',
    categories: ['finance', 'productivity'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'নতুন খরচ', url: '/?quickadd=expense' },
      { name: 'খাতা', url: '/transactions' },
    ],
  };
}
