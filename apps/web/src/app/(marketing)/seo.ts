import type { Metadata } from 'next';
import { FAQ, SITE } from './content';

/**
 * Everything the search engines are told, in one place.
 *
 * Three things matter here and only three, whatever else gets written about
 * SEO: the page has to say what it is in a language the searcher used, it has
 * to load fast on a cheap Android phone on 3G, and the answer to the visitor's
 * question has to be *in the HTML* rather than fetched afterwards. The public
 * pages are server-rendered with no client data fetching for exactly that
 * reason — everything below is the smaller half of the job.
 *
 * `bn-BD` is the primary locale because the product is Bengali. English
 * keywords ride in the descriptions and the structured data, which is where a
 * Bengali-speaking person searching "personal finance app bangladesh" — the
 * common case, since the queries are typed on an English keyboard — is
 * actually matched. A full English locale under `/en` is a bigger change and is
 * not pretended at here.
 */

const OG_IMAGE = `${SITE.url}/icons/icon-512.png`;

export function pageMetadata(input: {
  title: string;
  description: string;
  path: string;
  keywords?: string[];
  /** `bn` unless the page is under `/en`. Drives `og:locale` and `hreflang`. */
  locale?: 'bn' | 'en';
  /** The same page in the other language, if there is one. */
  alternatePath?: string;
}): Metadata {
  const url = `${SITE.url}${input.path}`;
  const locale = input.locale ?? 'bn';
  return {
    /* Absolute, so the root layout's `%s · Taka Tracker` template does not run.
     * A public page writes its own full title — the landing page already opens
     * with the product name, and appending it again reads as a mistake in the
     * one place a search result is judged. */
    title: { absolute: input.title },
    description: input.description,
    keywords: input.keywords,
    /* One canonical per page. The landing page is reachable at `/` through a
     * middleware rewrite and at `/home` directly; both point here, so the two
     * URLs are one document as far as a crawler is concerned. */
    alternates: {
      canonical: url,
      /* `hreflang` in both directions, plus `x-default` pointing at Bengali.
       * Without it the two pages read as duplicates of each other and a crawler
       * picks one to keep — usually the wrong one for half the audience. */
      ...(input.alternatePath
        ? {
            languages: {
              'bn-BD': locale === 'bn' ? url : `${SITE.url}${input.alternatePath}`,
              en: locale === 'en' ? url : `${SITE.url}${input.alternatePath}`,
              'x-default': locale === 'bn' ? url : `${SITE.url}${input.alternatePath}`,
            },
          }
        : {}),
    },
    openGraph: {
      type: 'website',
      url,
      siteName: SITE.name,
      title: input.title,
      description: input.description,
      locale: locale === 'en' ? 'en' : 'bn_BD',
      images: [{ url: OG_IMAGE, width: 512, height: 512, alt: SITE.name }],
    },
    twitter: {
      card: 'summary_large_image',
      title: input.title,
      description: input.description,
      images: [OG_IMAGE],
    },
    robots: {
      index: true,
      follow: true,
      googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 },
    },
  };
}

/**
 * `SoftwareApplication`, which is what this actually is.
 *
 * The `offers` block carries both tiers with real prices, so a rich result can
 * say "Free" rather than guessing. `aggregateRating` is deliberately absent:
 * Google's guidelines require it to reflect genuine user reviews, and inventing
 * one is the fastest way to earn a manual action — the thing that would undo
 * every other line in this file.
 */
export function softwareApplicationJsonLd(priceYearlyMinor: number): Record<string, unknown> {
  /* schema.org wants a bare decimal — no symbol, no grouping — so `formatMinor`
   * is the wrong tool here. Integer arithmetic on poisha rather than a divide:
   * money never touches a float in this codebase, and a price in a rich result
   * is exactly where a rounding artefact would be read as the real number. */
  const whole = (priceYearlyMinor - (priceYearlyMinor % 100)) / 100;
  const paisa = priceYearlyMinor % 100;
  const price = paisa === 0 ? String(whole) : `${whole}.${String(paisa).padStart(2, '0')}`;

  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE.nameEn,
    alternateName: 'হিসাব',
    applicationCategory: 'FinanceApplication',
    applicationSubCategory: 'Personal Finance',
    operatingSystem: 'Web, Android, iOS',
    url: SITE.url,
    inLanguage: 'bn-BD',
    description:
      'Double-entry personal finance app for Bangladesh. Track income, expenses, loans given and taken, DPS savings and insurance in Bangla. Works offline, installs to your phone.',
    featureList: [
      'Double-entry bookkeeping',
      'Income and expense tracking',
      'Loan and debt ledger (দেনা-পাওনা)',
      'DPS and savings schemes',
      'Insurance premium tracking',
      'Reports and balance sheet',
      'CSV import and export',
      'Offline support (PWA)',
      'Bangla, English and Banglish search',
    ],
    offers: [
      {
        '@type': 'Offer',
        name: 'ফ্রি',
        price: '0',
        priceCurrency: 'BDT',
        description: 'Lifetime free. Two accounts, unlimited transactions, unlimited debtors.',
      },
      {
        '@type': 'Offer',
        name: 'প্রিমিয়াম',
        price,
        priceCurrency: 'BDT',
        description: 'Everything unlimited, billed monthly.',
      },
    ],
    publisher: { '@type': 'Organization', name: SITE.nameEn, url: SITE.url },
  };
}

/** Takes the questions rather than importing them: the English page has its own. */
export function faqJsonLd(faq: { q: string; a: string }[] = FAQ): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  };
}

/**
 * Rendered as a `<script type="application/ld+json">`.
 *
 * `JSON.stringify` cannot produce `</script>`, but it can produce the `<` that
 * starts one if a string ever contains it, so the escape below is not
 * theoretical — it is the standard XSS hole in every hand-rolled JSON-LD
 * helper.
 */
export const jsonLdScript = (data: Record<string, unknown>): string =>
  JSON.stringify(data).replace(/</g, '\\u003c');
