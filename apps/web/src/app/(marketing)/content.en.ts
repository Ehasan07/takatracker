import type { FeatureGroup, Hero, SiteContent, UiStrings } from './content';

/**
 * The English site, written rather than translated.
 *
 * Machine translation is the right answer for the *app*, where a user can
 * correct anything wrong on their own screen. It is the wrong answer here: this
 * page is read once, by somebody deciding whether to trust a stranger with
 * their bank statements, and a sentence that is grammatical but slightly off is
 * the exact thing that loses them. So the claims are the same claims and the
 * words are their own.
 *
 * It also is not a mirror of the Bengali page's *phrasing*. "দেনাদার-পাওনাদার"
 * is one word in Bengali and "the people who owe you and the people you owe" in
 * English; translating it literally would produce something no English speaker
 * would type into a search box.
 *
 * Typed against `SiteContent`, so a section added to the Bengali page and
 * forgotten here is a compile error rather than a blank space on one of them.
 */

const HERO: Hero = {
  eyebrow: 'Double-entry personal finance, built for Bangladesh',
  title: 'Know where every taka went — down to the last poisha',
  subtitle:
    'Income, expenses, money lent and borrowed, DPS savings and insurance in one ledger. Built on double-entry bookkeeping, so the books cannot disagree with themselves.',
  subtitleEn: 'Free forever plan. Works offline. Installs to your phone from the browser.',
  primaryCta: 'Create a free account',
  secondaryCta: 'See pricing',
};

const PROOF: { value: string; label: string }[] = [
  { value: 'Double-entry', label: 'Both sides of every transaction, debit and credit' },
  { value: 'Integer money', label: 'Every amount is whole minor units — no rounding drift' },
  { value: '140+ currencies', label: 'Yen, dinar, dollar — each with its own real precision' },
  { value: 'Works offline', label: 'Entries queue when the network goes and send themselves back' },
];

const STEPS: { title: string; body: string }[] = [
  {
    title: 'Say where your money is',
    body: 'Bank, mobile wallet, cash in hand, credit card — enter each one once with its balance. Two minutes.',
  },
  {
    title: 'Write things down the easy way',
    body: 'Type in the app, or send it to Telegram. Bank messages become drafts that wait for you — nothing reaches your books unless you say so.',
  },
  {
    title: 'Get an answer at month end',
    body: 'Where it went, who owes you, who you owe, how it compares with last month. The reports do the arithmetic.',
  },
];

const GROUPS: FeatureGroup[] = [
  {
    id: 'ledger',
    heading: 'A ledger, not a list',
    headingEn: 'Double-entry bookkeeping',
    blurb:
      'Most expense apps keep a list. This keeps books — where each amount came from and where it went, both written down.',
    features: [
      {
        title: 'Double-entry ledger',
        titleEn: 'Debits equal credits, enforced',
        body: 'Every transaction balances. Not by convention — by a database constraint. An unbalanced entry cannot be written at all.',
        route: '/transactions',
      },
      {
        title: 'Accounts and balances',
        titleEn: 'Bank, wallet, cash, credit card',
        body: 'From an opening balance to today’s figure, kept current by the entries themselves rather than by you.',
        route: '/accounts',
      },
      {
        title: 'Revaluing an asset',
        titleEn: 'Land and gold, marked to today',
        body: 'Enter what it is worth now, with the history kept. Not income and not cash flow — only net worth moves, because nothing was sold.',
        route: '/accounts',
      },
      {
        title: 'Property and vehicles, kept apart',
        titleEn: 'A plot of land is not spending money',
        body: 'Land, a flat, a car, gold — what you paid beside what it is worth now, and never mixed in with the money in your bank. Asking how much you have on hand does not get answered with the value of a plot of land.',
        route: '/assets',
      },
      {
        title: 'Selling an asset',
        titleEn: 'Only the gain is income',
        body: 'The proceeds land in the account that received them, and only the amount above what you paid is income. Sell for less and the shortfall is a loss. What you have sold stays on its own list rather than disappearing.',
        route: '/assets',
      },
      {
        title: 'Categories and sub-categories',
        titleEn: 'A tree, not a flat list',
        body: 'Twenty-one categories seeded, as many sub-categories under them as you need. Reports roll children up into the parent.',
        route: '/categories',
      },
      {
        title: 'Tags',
        titleEn: 'Who for, not what on',
        body: 'The category says what the money went on; a tag says who for or which project. One transaction can carry several.',
        route: '/tags',
      },
      {
        title: 'Statement of account',
        titleEn: 'The document a bank issues',
        body: 'Opening balance, debit and credit columns, a running balance down the page, closing balance. Print it, export it, or send a link somebody can open without an account.',
        route: '/accounts',
      },
      {
        title: 'Reconciliation',
        titleEn: 'Match the bank',
        body: 'Type the real balance and the difference is booked as an adjustment. Your books and your statement stop drifting apart.',
        route: '/accounts',
      },
      {
        title: 'Annual costs, spread across the months',
        titleEn: 'One payment, twelve months of use',
        body: 'An insurance premium or a licence paid once a year lands in one month and makes that month look ruinous. A separate view lays it flat across the months it buys. The books stay on a cash basis; only the reading changes.',
        route: '/transactions/prepaid',
      },
      {
        title: 'Transactions in another currency',
        titleEn: 'The rate your bank actually used',
        body: 'A card charge in dollars stays in dollars, with what it cost in taka beside it. You supply the rate, because what your bank charged is not published anywhere. 140+ currencies, each with its own real precision.',
        route: '/transactions',
      },
    ],
  },
  {
    id: 'loans',
    heading: 'Debts, the way accountants do them',
    headingEn: 'Loans and party ledger',
    blurb:
      'Who owes you, who you owe, what is left on each instalment. The rule QuickBooks and Zoho Books follow: a loan is never income and never an expense.',
    features: [
      {
        title: 'Money lent and borrowed',
        titleEn: 'Two directions, kept apart',
        body: 'Borrowing is a liability, lending is an asset. Both move your cash; neither touches your income or expense reports.',
        route: '/loans',
      },
      {
        title: 'Instalments with a running balance',
        titleEn: 'Interest handled properly',
        body: 'What is left after each payment, with interest separated out. Interest stops accruing on the day the debt was cleared, not the next morning.',
        route: '/loans',
      },
      {
        title: 'Party ledger',
        titleEn: 'One person, one page',
        body: 'Every loan with the same person on a single running balance. "What is between us" is one number, before you pick up the phone.',
        route: '/loans',
      },
      {
        title: 'Statements and CSV export',
        titleEn: 'Cut by date, hand it over',
        body: 'Filter to any window, download a CSV Excel opens correctly, print a clean page.',
        route: '/loans',
      },
      {
        title: 'Contacts',
        titleEn: 'Fixable, and mergeable',
        body: 'Correct a name, a phone or a relationship. Typed the same person twice? Merge them, and their history stops being in two halves.',
        route: '/people',
      },
      {
        title: 'A code for every person',
        titleEn: 'P-0001, and it stays theirs',
        body: 'Two people with one name stay two people. Give a phone number and the same person is never created twice, so their loans and their trips sit together.',
        route: '/people',
      },
    ],
  },
  {
    id: 'split',
    heading: 'Splitting a bill — ShareCost',
    headingEn: 'Shared expenses',
    blurb:
      'Trips, flatshares, the office. Who paid, whose share is what, and who owes whom at the end — while your own books take only your share.',
    features: [
      {
        title: 'Split an expense',
        titleEn: 'Equally, by percent, by share or by exact amounts',
        body: 'A ৳3,000 dinner split four ways puts ৳750 in your month, not ৳3,000. Your books stay yours.',
        route: '/split',
      },
      {
        title: 'Settle up in the fewest payments',
        titleEn: 'Not everybody paying everybody',
        body: 'Seven people on a trip do not need twenty-one transfers. The app works out the shortest way to square up.',
        route: '/split',
      },
      {
        title: 'Advances, adjusted on their own',
        titleEn: 'Money handed over before the bill',
        body: 'Record what you paid ahead of time and it comes off their share of the next expense automatically.',
        route: '/split',
      },
      {
        title: 'A pot everybody pays into',
        titleEn: 'Family fund, office collection, trip kitty',
        body: 'Contributions in, spending out. Somebody else’s contribution stays money you owe them — the pot may be in your hands, but it is theirs.',
        route: '/split',
      },
      {
        title: 'A public link for the trip',
        titleEn: 'No account needed to read it',
        body: 'The total, who paid what, each person’s share. Nothing outside the group travels with the link.',
        route: '/split',
      },
    ],
  },
  {
    id: 'planning',
    heading: 'Savings, insurance, cards',
    headingEn: 'What is due, and when',
    blurb:
      'Money does not only come and go; some of it accumulates. Remembering what falls due is the software’s job.',
    features: [
      {
        title: 'DPS and savings schemes',
        titleEn: 'Instalments, term, profit',
        body: 'How much has gone in and how much is left, on each scheme’s own page.',
        route: '/savings',
      },
      {
        title: 'Profit where profit belongs',
        titleEn: 'A DPS deposit is a transfer, not an expense',
        body: 'Record a scheme’s profit as income on the transactions screen, tagged to the scheme it came from. Paying into a DPS is not spending — one asset simply becomes another — so it is recorded as a transfer, and the monthly report keeps the two apart.',
        route: '/savings',
      },
      {
        title: 'Insurance policies',
        titleEn: 'Premiums and renewals',
        body: 'When the premium is due, how much, which one is outstanding. Policy number and term in one place.',
        route: '/insurance',
      },
      {
        title: 'Credit-card reminders',
        titleEn: 'Before the due date',
        body: 'A Telegram nudge before the bill. Pay it and that cycle’s reminders stop on their own.',
        route: '/settings',
      },
      {
        title: 'Which account the instalment leaves from',
        titleEn: 'A DPS is a standing instruction',
        body: 'The same wallet or the same salary account is debited on the same day every month for five years. Say it once and the deposit screen stops asking.',
        route: '/savings',
      },
      {
        title: 'Renewals and expiry dates',
        titleEn: 'Domains, licences, papers',
        body: 'Hosting, a trade licence, vehicle papers, a passport — when each runs out and what it will cost. They climb the list as the date approaches.',
        route: '/renewals',
      },
    ],
  },
  {
    id: 'insight',
    heading: 'Reports and search',
    headingEn: 'Answers, not just numbers',
    blurb: 'Collecting figures is easy. Answering a question with them is the hard part.',
    features: [
      {
        title: 'Income, expense and cash flow',
        titleEn: 'By month, category or account',
        body: 'Compare with last month in one click.',
        route: '/reports',
      },
      {
        title: 'Income, spending and savings together',
        titleEn: 'The third figure no statement can give',
        body: 'What came in, what went out, and what actually went into savings — three figures side by side, month by month. The savings rate is the share of income you put away, not what happened to be left over; money left over can simply be sitting in a wallet.',
        route: '/reports',
      },
      {
        title: 'Charts',
        titleEn: 'Readable without relying on colour',
        body: 'Category shares, monthly trends, income against spending — a picture beside the figures. Colour is never the only signal, so they read on a colour-blind screen too.',
        route: '/reports',
      },
      {
        title: 'How this month is going',
        titleEn: 'Eighteen days against eighteen days',
        body: 'This month measured against the same stretch of last month, never against all of it — that comparison says spending has halved when nothing has changed. Beside it: the pace of the month, the trend by month, and which categories moved most.',
        route: '/',
      },
      {
        title: 'Balance sheet, as of any date',
        titleEn: 'Assets, liabilities, net worth',
        body: 'Today’s position, or the 30th of June’s. Both dates and the movement between them in one request.',
        route: '/reports',
      },
      {
        title: 'Reporting by tag',
        titleEn: 'Slice it your way',
        body: 'Only family spending, only the business. Whatever you tagged, you can total.',
        route: '/reports',
      },
      {
        title: 'The four financial statements',
        titleEn: 'Income, balance sheet, cash flow, net worth',
        body: 'For any date range, on one printable page — the same four statements an accountant would ask for.',
        route: '/reports/statements',
      },
      {
        title: 'Cash flow in three sections',
        titleEn: 'Operating, investing, financing',
        body: 'Classified the way IAS 7 requires, by the account on the other side of the entry. A salary and a borrowed lakh never blur into one number.',
        route: '/reports/statements',
      },
      {
        title: 'Current and non-current',
        titleEn: 'IAS 1 presentation',
        body: 'Assets and liabilities split the way a balance sheet is meant to be read, so working capital falls out of it.',
        route: '/reports/statements',
      },
      {
        title: 'Quantities, not just amounts',
        titleEn: 'Kilos, litres, bhori, katha',
        body: 'Fifty-six units, local ones included. It is how you tell a price rise apart from a change of habit.',
        route: '/reports',
      },
      {
        title: 'Share a statement by link',
        titleEn: 'For a lender, a bank or an insurer',
        body: 'They open and print it without an account. The link expires, you can revoke it, and you are told how often it was opened.',
        route: '/loans',
      },
      {
        title: 'Bangla, English and Banglish search',
        titleEn: 'karim finds করিম',
        body: 'Type it however you type it. The matcher transliterates, so three spellings find one person.',
        route: '/transactions',
      },
    ],
  },
  {
    id: 'input',
    heading: 'Less typing',
    headingEn: 'Getting data in',
    blurb:
      'People stop keeping books because writing them down is tiring, not because they stopped caring.',
    features: [
      {
        title: 'Telegram entry',
        titleEn: 'Send it and forget it',
        body: 'Message the bot and it becomes a draft. "rickshaw 60" on the bus; one tap when you get home.',
        route: '/settings',
      },
      {
        title: 'Draft inbox',
        titleEn: 'Nothing lands unreviewed',
        body: 'Whatever arrives waits as a draft. It does not reach your books until you say so.',
        route: '/inbox',
      },
      {
        title: 'Mailbox connector',
        titleEn: 'Read your statements in-app',
        body: 'Connect a mailbox and read bank letters here. Read only — it never sends and never deletes.',
        route: '/mail',
      },
      {
        title: 'CSV import and backup',
        titleEn: 'Bring the old spreadsheet',
        body: 'Map your columns and import. Download your whole ledger any day you like.',
        route: '/import',
      },
      {
        title: 'Bringing an old app across',
        titleEn: 'Wallet by BudgetBakers, balance for balance',
        body: 'Your whole history from Wallet by BudgetBakers — accounts, categories, transfers, years of transactions. Whatever cannot be matched comes back as a spreadsheet, and every balance is checked against the old app’s own figure.',
        route: '/settings',
      },
      {
        title: 'Receipt attachments',
        titleEn: 'Photograph the paper',
        body: 'Attach a receipt to a transaction. Unlimited on premium.',
        route: '/transactions',
      },
    ],
  },
  {
    id: 'trust',
    heading: 'Your data, yours',
    headingEn: 'Privacy and control',
    blurb:
      'Personal finance means bank statements, salaries and what you owe. There is no casual way to handle that.',
    features: [
      {
        title: 'Hard tenant isolation',
        titleEn: 'One workspace, one set of books',
        // The original line, less "with no exception" — see `content.ts`.
        body: 'Every query is scoped by workspace. Not most of them — every one.',
        route: '/settings',
      },
      {
        title: 'Audit trail',
        titleEn: 'Who changed what, when',
        body: 'The full list, and you can read it yourself.',
        route: '/audit',
      },
      {
        title: 'Session control',
        titleEn: 'See and revoke devices',
        body: 'Which devices are signed in, and one tap to sign any of them out.',
        route: '/settings',
      },
      {
        title: 'Export without friction',
        titleEn: 'Leave whenever you like',
        body: 'Your whole ledger as CSV. Nobody holds your data hostage to keep you.',
        route: '/import',
      },
    ],
  },
  {
    id: 'comfort',
    heading: 'Making it yours',
    headingEn: 'Themes, language, wording',
    blurb:
      'Bookkeeping is a daily habit. The screen has to be bearable and the words have to be the ones you use.',
    features: [
      {
        title: 'Eight themes',
        titleEn: 'Light, dark, high contrast, calm',
        body: 'Four faces in light and dark. Money in and money out are never the same colour in any of them, so they stay distinguishable on a colour-blind screen.',
        route: '/settings',
      },
      {
        title: 'Bangla and English',
        titleEn: 'The whole app, either way',
        body: 'Both languages throughout, and Bengali or Western digits as a separate choice — some people want Bangla words with English numerals.',
        route: '/settings',
      },
      {
        title: 'Rename anything on screen',
        titleEn: 'Your words, not ours',
        body: 'Prefer "head" to "category", or "customer" to "party"? Change any label in your own books. The change is recorded on your workspace timeline, so it is never a mystery who renamed what.',
        route: '/settings',
      },
      {
        title: 'The manual, inside the app',
        titleEn: 'No tab-switching to read the docs',
        body: 'What every screen does and what every rule means, written in the app itself.',
        route: '/help',
      },
      {
        title: 'Send feedback from inside',
        titleEn: 'With the screen you sent it from',
        body: 'Report something wrong or ask for something missing without leaving the app. Which screen you were on travels with it.',
        route: '/feedback',
      },
    ],
  },
];

const COMING: { title: string; body: string }[] = [
  {
    title: 'Reading bank SMS directly',
    body: 'Drafts straight from bKash, Nagad and bank messages. The pipeline is built; the per-bank templates are not.',
  },
  {
    title: 'Budgets',
    body: 'A monthly limit per category, and a warning before you pass it. You can see the pace of your spending today, but you cannot yet set a ceiling on it.',
  },
  {
    title: 'Android and iOS store apps',
    body: 'Today it installs to your home screen from the browser and works offline. A store listing is the next step.',
  },
  {
    title: 'AI monthly review',
    body: '"Where did it go, what could come down" — over your own books, in your own words.',
  },
  {
    title: 'Recurring transactions',
    body: 'Rent, salary, instalments — entered once, then automatic.',
  },
  {
    title: 'Income tax computation',
    body: 'Slabs, the investment rebate, minimum tax and the wealth surcharge, worked from your own books. The machinery is built; the Finance Act rates still have to be transcribed against the gazette, and nothing computes until a person has checked every figure.',
  },
  {
    title: 'Family members',
    body: 'Several people on one set of books, with separate permissions.',
  },
  {
    title: 'Receipt OCR',
    body: 'Photograph a receipt and have the amount and date fill themselves in.',
  },
];

const FAQ: { q: string; a: string }[] = [
  {
    q: 'Is Taka Tracker really free?',
    a: 'Yes. The free plan is free for good — not a trial, and no card at the end. Two accounts, unlimited transactions, unlimited debtors and creditors. Only receipt attachments are held back for premium.',
  },
  {
    q: 'What is double-entry, and do I need it?',
    a: 'Double-entry means both sides of every amount are written down — where it came from and where it went. You never have to learn debits and credits; the screens never show them. What you get is books that cannot silently disagree with themselves.',
  },
  {
    q: 'Can you see my bank account?',
    a: 'We are not connected to any bank, never ask for banking credentials, and never ask for a full account number — only what you type, or what arrives in a mailbox you connected yourself. Each workspace is isolated, and every read of your data is recorded.',
  },
  {
    q: 'Does it work without internet?',
    a: 'Yes. Add it to your home screen and it opens like an app; with no connection, entries queue and send themselves when the network returns. Step-by-step instructions for iPhone and Android are at takatracker.com/guide.',
  },
  {
    q: 'Which currency can I use?',
    a: 'Any of more than 140, chosen when you sign up. Each is handled at its own real precision — a yen has no minor unit, a Kuwaiti dinar has a thousand fils, and the arithmetic respects both rather than assuming everything has cents.',
  },
  {
    q: 'Do loans count as income or expense?',
    a: 'Never. Money borrowed is a liability and money lent is an asset — both move your cash, neither touches income or expense. Only the interest is. QuickBooks and Zoho Books follow the same rule.',
  },
  {
    q: 'Can I bring in an old spreadsheet?',
    a: 'Yes. Map your CSV columns and import. If it comes out wrong, the whole batch can be reverted at once.',
  },
  {
    q: 'How do I pay?',
    a: 'Premium is ৳350 a month (৳3600 a year, saving ৳600) and Pro is ৳499 a month. Each paid plan has its own payment button on the pricing page — pay by bKash or card. Write the plan name on the invoice: matching a payment to an account is still done by hand, and we switch the plan on once it clears.',
  },
];

const NAV: { href: string; label: string }[] = [
  { href: '/en#features', label: 'Features' },
  { href: '/en/pricing', label: 'Pricing' },
  { href: '/en/tutorial', label: 'How to' },
  { href: '/en/sms', label: 'Bank SMS' },
  { href: '/guide', label: 'Install' },
  { href: '/en#coming', label: 'Roadmap' },
  { href: '/en#faq', label: 'FAQ' },
];

const UI: UiStrings = {
  featuresHeading: 'What it does',
  featuresBlurb: [
    'Everything below works today. What does not exist yet is kept separately, under ',
    '.',
  ],
  stepsHeading: 'Three steps to start',
  stepsBlurb: 'You do not have to back-fill a year on day one. Starting from today is enough.',
  comingHeading: 'Coming',
  comingBlurb:
    'These are not built yet. The list is here so that when you sign up you know what you are getting and what you are not.',
  faqHeading: 'Questions',
  ledgerHeading: 'Why this is not another expense app',
  ledgerBodyA:
    'Most apps keep a list: date, amount, category. Add the list up and you get total spending — but not "how much do I have right now" or "what am I worth", because where the money came from was never written down.',
  ledgerBodyB:
    'Taka Tracker writes both sides. A ৳500 grocery run is ৳500 debited to food and ৳500 credited from cash. If the two sides are not equal, the database refuses the write.',
  ledgerResultHeading: 'Which means',
  ledgerResults: [
    'Every account balance stays correct on its own',
    'You get a real balance sheet — assets, liabilities, net worth',
    'Loans cannot leak into income and ruin a report',
    'Money never disappears; if it moved, where it went is written down',
  ],
  ledgerFootnote:
    'QuickBooks and Zoho Books run business books on exactly this rule. The difference here is that you never have to see a debit or a credit — the screens say income, expense and transfer.',
  closingHeading: 'Start today',
  closingBody:
    'A minute to open an account, ten seconds for the first expense. At the end of the month the answer is yours to read.',
  closingSecondary: 'Sign in to an existing account',
  heroNote: 'No card required · Free plan free for good · Export everything whenever you like',
  proofLabel: 'Why trust it',
  login: 'Sign in',
  startFree: 'Start free',
  otherLocaleLabel: 'বাংলা',
  otherLocaleHref: '/',
};

export const CONTENT_EN: SiteContent = {
  hero: HERO,
  proof: PROOF,
  steps: STEPS,
  groups: GROUPS,
  coming: COMING,
  faq: FAQ,
  nav: NAV,
  ui: UI,
};
