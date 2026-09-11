'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { t } from '@/lib/t';
import './print-footer-ad.css';

export interface FooterAd {
  headline: string;
  body: string | null;
  contactLine: string | null;
  linkUrl: string | null;
}

export const adKeys = {
  footer: () => ['ads', 'footer'] as const,
};

/**
 * The strip itself. No hooks, so it renders on the shared statement page, which
 * has no query client of its own.
 */
export function FooterAdBlock({ ad }: { ad: FooterAd | null }) {
  if (!ad) return null;
  return (
    <aside className="print-ad">
      <p className="print-ad-label">{t('ads.label', 'বিজ্ঞাপন')}</p>
      <p className="print-ad-headline">{ad.headline}</p>
      {ad.body ? <p className="print-ad-body">{ad.body}</p> : null}
      {ad.contactLine ? <p className="print-ad-contact">{ad.contactLine}</p> : null}
    </aside>
  );
}

/**
 * The sponsored strip a printed document carries, if this workspace has one.
 *
 * ## Where it appears, and where it does not
 *
 * Printed pages and PDFs only — the CSS hides it on screen. A spreadsheet
 * export has none either, and that is decided on the server: a CSV or an XLSX
 * is a file somebody sorts and pastes into their own workbook, and a line of
 * advertising copy in row 412 breaks their formulas. The margin of a printed
 * page is borrowed space; a cell is not.
 *
 * ## Why it fetches rather than taking a prop
 *
 * Four different screens print a document, and threading one more field through
 * four payloads is four chances to forget the fourth. One shared query, cached
 * for the session, and adding the strip to a new document is one import.
 *
 * The public statement a customer opens is the exception and renders
 * `FooterAdBlock` directly: nobody is signed in there, so the strip travels
 * with the document itself rather than being fetched by the page.
 */
export function PrintFooterAd() {
  const query = useQuery({
    queryKey: adKeys.footer(),
    queryFn: () => api<{ ad: FooterAd | null }>('/ads/footer'),
    /* Nothing on the page depends on it, and a sponsor does not change while
       somebody is reading a ledger. */
    staleTime: 10 * 60_000,
  });

  return <FooterAdBlock ad={query.data?.ad ?? null} />;
}
