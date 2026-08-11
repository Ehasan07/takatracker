/**
 * The English half of every string the app shows.
 *
 * Keyed the same way the call sites are: `t('nav.dashboard', 'ড্যাশবোর্ড')`
 * looks up `nav.dashboard` here. A key missing from this file is not an error —
 * the reader gets the Bengali written at the call site, which is what the
 * screen says today. That is why this file can be filled in screen by screen
 * without the app ever being half-broken.
 *
 * ## Written, not machine-translated
 *
 * A machine would have produced this faster and worse. "দেনাদার-পাওনাদার" is one
 * word in Bengali and "who owes you and who you owe" in English; "খাতা" is a
 * ledger, a notebook and a running account depending on the sentence. The
 * places a translator earns their keep are exactly the places this product's
 * vocabulary lives.
 *
 * ## And it is not the last word
 *
 * Anything here can be overridden per workspace from Settings → wording, and
 * the override wins. If a household says "shopping" where this says
 * "groceries", their app should say shopping — the point of the override store
 * is that being wrong here is cheap to fix rather than a support ticket.
 */
export const EN: Record<string, string> = {
  // --- navigation ------------------------------------------------------------
  'nav.dashboard': 'Dashboard',
  'nav.transactions': 'Transactions',
  'nav.loans': 'Loans',
  'nav.reports': 'Reports',
  'nav.more': 'More',
  'nav.accounts': 'Accounts',
  'nav.savings': 'Savings & DPS',
  'nav.insurance': 'Insurance',
  'nav.mail': 'Mail',
  'nav.inbox': 'Message inbox',
  'nav.tags': 'Tags',
  'nav.categories': 'Categories',
  'nav.people': 'People',
  'nav.import': 'Import & export',
  'nav.settings': 'Settings',
  'nav.plans': 'Plan & limits',
  'nav.audit': 'Activity log',
  'nav.group.money': 'Where the money is',
  'nav.group.data': 'Data & tools',
  'nav.group.app': 'App',
  'nav.group.platform': 'Platform',

  // --- navigation blurbs -----------------------------------------------------
  'nav.accounts.blurb': 'Balances across bank, mobile wallets and cash',
  'nav.savings.blurb': 'DPS and savings instalments, terms and profit',
  'nav.insurance.blurb': 'When each premium is due, how much, what is outstanding',
  'nav.mail.blurb': 'Letters from a connected mailbox — bank statements live here',
  'nav.inbox.blurb': 'Drafts from messages — nothing reaches your books unasked',
  'nav.tags.blurb': 'Who for, or what project — family, business, Ramadan',
  'nav.categories.blurb': 'Add, rename or remove income and expense categories',
  'nav.people.blurb': 'Who you owe and who owes you — fix names, phones, relationships',
  'nav.import.blurb': 'Bring transactions in from a statement, take a backup out',
  'nav.settings.blurb': 'Profile, theme, Telegram and signed-in devices',
  'nav.plans.blurb': 'What your plan gives you and how much of it you have used',
  'nav.audit.blurb': 'Who changed what, and when',

  // --- the shell -------------------------------------------------------------
  'shell.account': 'Account',
  'shell.signOut': 'Sign out',
  'shell.signingOut': 'Signing out…',
  'shell.newTransaction': 'New transaction',
  'shell.back': 'Back',
  'shell.offline': 'No connection — entries are being saved and will send themselves',

  // --- greetings -------------------------------------------------------------
  'greeting.morning': 'Good morning',
  'greeting.noon': 'Good afternoon',
  'greeting.afternoon': 'Good afternoon',
  'greeting.evening': 'Good evening',
  'greeting.night': 'Good evening',

  // --- dashboard -------------------------------------------------------------
  'dashboard.title': 'Dashboard',
  'dashboard.thisMonth': 'This month',
  'dashboard.income': 'Income',
  'dashboard.expense': 'Expense',
  'dashboard.net': 'Net',
  'dashboard.accounts': 'Accounts',
  'dashboard.recent': 'Recent entries',
  'dashboard.seeAll': 'See all',
  'dashboard.empty': 'Nothing written down yet.',

  // --- first run -------------------------------------------------------------
  'firstRun.title': 'Let’s begin',
  'firstRun.body': 'Tell us where your money is and you can start writing — two minutes.',
  'firstRun.start': 'Get started',
  'firstRun.dismiss': 'Don’t show this again',
  'firstRun.dismissing': 'Hiding…',

  // --- the wording editor ----------------------------------------------------
  'wording.title': 'Wording',
  'wording.blurb':
    'Anything the app says can be changed here. Your version is what your workspace sees.',
  'wording.search': 'Search a word',
  'wording.reset': 'Back to default',
  'wording.saved': 'Saved.',
  'wording.empty': 'Nothing matches.',
  'wording.default': 'Default',
  'wording.yours': 'Yours',
};
