import type { MetadataRoute } from 'next';
import { SITE } from './(marketing)/content';

/**
 * What a crawler may read.
 *
 * Everything behind a session is disallowed — not as a security measure (the
 * middleware is that, and a crawler has no cookie anyway) but because a
 * disallowed path is one that cannot show up as a bare redirect-to-login in
 * search results, competing with the page that should rank.
 *
 * `/home` is allowed rather than blocked: it is the landing page, and its
 * canonical tag points at `/`, which is how duplicate content is meant to be
 * resolved. Blocking it would stop the crawler reading the tag that does the
 * resolving.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/api/',
          '/admin',
          '/admin/',
          '/settings',
          '/transactions',
          '/accounts',
          '/loans',
          '/reports',
          '/savings',
          '/insurance',
          '/categories',
          '/tags',
          '/people',
          '/inbox',
          '/mail',
          '/import',
          '/audit',
          '/plans',
          '/more',
          '/onboarding',
          '/verify',
          '/reset',
          '/offline',
        ],
      },
    ],
    sitemap: `${SITE.url}/sitemap.xml`,
    host: SITE.url,
  };
}
