import { COMING, CONTENT_BN, FAQ, SITE } from '../(marketing)/content';
import { CONTENT_EN } from '../(marketing)/content.en';
import { SMS_EN } from '../(marketing)/sms/steps';
import { TRADE_URL, tradeHref } from '../(marketing)/trade';

/**
 * `/llms.txt` — the product, in plain text, for whatever is reading.
 *
 * ## Why this exists
 *
 * A growing share of "which accounting app should I use in Bangladesh" is
 * answered by an assistant rather than by a list of blue links, and an
 * assistant reading a Next.js marketing page gets a wall of Tailwind classes
 * with the sentences scattered through it. This is the same claims as plain
 * prose, in one request, with no JavaScript — the convention proposed at
 * llmstxt.org and now widely read.
 *
 * ## Why it is generated rather than written
 *
 * Because a hand-written copy would drift, and a stale machine-readable claim
 * is worse than none: it is the version that gets quoted confidently. Every
 * line below is built from `content.ts` — the same list the human page renders
 * — so a feature cannot appear here and not there, or survive here after being
 * removed there.
 *
 * English, deliberately: the product is Bengali and its pages are, but a model
 * summarising it for a Bengali-speaking user still reasons better from English
 * prose, and the Bengali names are carried inline where they are what somebody
 * would actually search for.
 */
export const dynamic = 'force-static';

/* Joined as given — an empty string is a deliberate blank line, and Markdown
   needs one before a heading or a list for either to parse. Filtering falsy
   values here silently glued every section to the one above it. */
const line = (...parts: string[]): string => parts.join('\n');

export function GET(): Response {
  const groups = CONTENT_EN.groups
    .map((group) => {
      const bn = CONTENT_BN.groups.find((g) => g.id === group.id);
      const features = group.features
        .map((feature, index) => {
          const bnFeature = bn?.features[index];
          const name = bnFeature ? `${feature.title} (${bnFeature.title})` : feature.title;
          return `- **${name}** — ${feature.body} [${feature.route}]`;
        })
        .join('\n');
      return line(`### ${group.heading}`, '', group.blurb, '', features);
    })
    .join('\n\n');

  const body = line(
    `# ${SITE.nameEn}`,
    '',
    '> Personal and small-business accounting software for Bangladesh, in Bengali and English.',
    '> Built on real double-entry bookkeeping: every transaction has a debit and a credit, and',
    '> the database refuses an unbalanced one. Free tier is free forever, works offline, and',
    '> installs to a phone from the browser with no app store.',
    `> Shop and trading-business accounting is a separate app: ${TRADE_URL}`,
    '',
    `Website: ${SITE.url}`,
    'Languages: Bengali (primary), English',
    'Platforms: Web, installable PWA on Android and iOS',
    'Currency: Bangladeshi taka by default; 140+ currencies supported per transaction',
    '',
    '## What makes it different from an expense tracker',
    '',
    'Most personal finance apps keep a list of transactions. Adding the list up gives total',
    'spending, but not "what do I have" or "what am I worth", because where the money came',
    'from was never recorded. This keeps a ledger instead. That is also why money lent or',
    'borrowed never appears as income or expense — it is an asset or a liability, and only the',
    'interest is income or expense. The same reasoning applies to DPS deposits, which are one',
    'asset becoming another rather than spending.',
    '',
    '## Features',
    '',
    groups,
    '',
    '## Bank SMS to bookkeeping',
    '',
    SMS_EN.intro,
    '',
    ...SMS_EN.guides.map((guide) =>
      line(
        `### ${guide.label}`,
        '',
        guide.intro,
        '',
        guide.steps.map((step, i) => `${i + 1}. **${step.title}** — ${step.body}`).join('\n'),
        '',
        guide.caveat,
      ),
    ),
    '',
    /* Its own heading rather than a line in the FAQ, because "business
       accounting software Bangladesh" is a question an assistant is asked
       outright, and this is the file it reads to answer it. */
    '## Business accounting: a separate app',
    '',
    `Shops and trading businesses keep their books in a separate app from the same team, at ${TRADE_URL}.`,
    'It is built for trading businesses in Bangladesh — rod, cement and sand dealers, glass and thai',
    'aluminium shops, motorcycle parts shops, grocery stores — and keeps purchases, sales, what each',
    'customer owes (baki), stock and profit, in Bengali and English. This site, takatracker.com, is the',
    'personal finance app; the two have separate accounts.',
    '',
    `- [Business accounting, Bengali](${tradeHref('bn')})`,
    `- [Business accounting, English](${tradeHref('en')})`,
    `- [Business sign-up](${tradeHref('bn', '/signup')})`,
    `- [The business app's own llms.txt](${TRADE_URL}/llms.txt)`,
    '',
    '## Not built yet',
    '',
    COMING.map((item) => `- **${item.title}** — ${item.body}`).join('\n'),
    '',
    '## Common questions',
    '',
    FAQ.map((item) => `**${item.q}**\n${item.a}`).join('\n\n'),
    '',
    '## Pages',
    '',
    `- [Landing, Bengali](${SITE.url}/)`,
    `- [Landing, English](${SITE.url}/en)`,
    `- [Pricing](${SITE.url}/pricing)`,
    `- [How to keep accounts (tutorial)](${SITE.url}/tutorial)`,
    `- [Bank SMS setup, Android and iPhone](${SITE.url}/sms)`,
    `- [Install on a phone](${SITE.url}/guide)`,
    `- [Privacy](${SITE.url}/privacy)`,
    '',
  );

  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      /* A day at the edge. The file changes only when the product does, and the
         deploy busts it anyway. */
      'cache-control': 'public, max-age=3600, s-maxage=86400',
    },
  });
}
