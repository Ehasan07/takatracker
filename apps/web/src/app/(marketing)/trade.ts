/**
 * The business app: a shop's books, kept by a separate product at its own
 * address.
 *
 * Its own module rather than a line in `content.ts` because the sign-up and
 * sign-in screens link to it too, and they are client components — importing
 * the whole marketing copy to read one URL would ship every landing-page
 * sentence to a form that shows none of them.
 */
export const TRADE_URL = 'https://trade.takatracker.com';

/** The trade site serves the same two languages this one does, each under its own prefix. */
export const tradeHref = (locale: 'bn' | 'en', path: '' | '/signup' | '/login' = ''): string =>
  `${TRADE_URL}/${locale}${path}`;
