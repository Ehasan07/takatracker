import type { MetadataRoute } from 'next';
import { SITE } from './(marketing)/content';

/**
 * The four URLs worth indexing.
 *
 * Only public pages, and only ones with content of their own — `/login` and
 * `/signup` are here because a person searching the product by name expects to
 * find the way in, and they are the two paths a crawler would otherwise reach
 * through a header link with no context.
 *
 * `lastModified` is the build time. There is no CMS behind these pages, so the
 * deployment *is* the edit, and a fabricated fresher date would be exactly the
 * signal a crawler learns to distrust.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return [
    /* No trailing slash, because that is what `metadataBase` resolves the
       landing page's canonical tag to. A sitemap that lists a URL the canonical
       tag spells differently asks a crawler to pick, and it will pick once and
       remember. */
    { url: SITE.url, lastModified, changeFrequency: 'weekly', priority: 1 },
    { url: `${SITE.url}/pricing`, lastModified, changeFrequency: 'monthly', priority: 0.9 },
    /* The tutorial ranks for questions nobody searches the brand for — "is a
       loan an expense", "how to keep personal accounts" — so it is worth more
       to a crawler than the install guide and is listed above it. */
    { url: `${SITE.url}/tutorial`, lastModified, changeFrequency: 'monthly', priority: 0.9 },
    { url: `${SITE.url}/guide`, lastModified, changeFrequency: 'monthly', priority: 0.8 },
    /* Listed rather than left to the footer link. Somebody deciding whether to
       trust a finance app with their ledger searches for this page by name, and
       it is the page that names what an operator can see. */
    { url: `${SITE.url}/privacy`, lastModified, changeFrequency: 'yearly', priority: 0.5 },
    /* The English pages are separate URLs with their own content, so they are
       listed rather than left for the hreflang tags alone to surface. */
    { url: `${SITE.url}/en`, lastModified, changeFrequency: 'weekly', priority: 0.9 },
    { url: `${SITE.url}/en/pricing`, lastModified, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${SITE.url}/en/tutorial`, lastModified, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${SITE.url}/signup`, lastModified, changeFrequency: 'yearly', priority: 0.6 },
    { url: `${SITE.url}/login`, lastModified, changeFrequency: 'yearly', priority: 0.4 },
  ];
}
