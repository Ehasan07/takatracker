import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TS/ESM; let Next compile them.
  transpilePackages: ['@hishab/shared', '@hishab/ui'],
  poweredByHeader: false,
  // This monorepo sits inside a larger folder that has its own lockfile.
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),

  /**
   * `/api/*` is served by src/app/api/[...path]/route.ts, which forwards to the
   * NestJS API at request time. A `rewrites()` entry would bake the API address
   * into the build manifest and could not be changed at deploy time.
   */

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // Next injects inline bootstrap scripts; styles come from Tailwind.
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self' data:",
              "connect-src 'self'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
      {
        /* Shared statements. The page already carries a robots meta tag and the
           API sends this header on its own response, but neither covers the
           HTML a crawler actually fetches — and this is the one URL in the
           product that is reachable with no session, so it gets the header a
           crawler reads before parsing anything.

           `noarchive` matters as much as `noindex` here: a cache copy of
           somebody's ledger outlives the link they revoked. */
        source: '/s/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive, nosnippet' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default nextConfig;
