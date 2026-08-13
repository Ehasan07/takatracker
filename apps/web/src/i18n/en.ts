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

  /* Operator destinations. Only one person sees these, but a half-translated
     sidebar is the sort of thing that makes the rest look unfinished. */
  'nav.admin': 'Overview',
  'nav.admin.tenants': 'Workspaces',
  'nav.admin.plans': 'Plans',
  'nav.admin.features': 'Features',
  'nav.admin.analytics': 'Analytics',
  'nav.admin.broadcast': 'Send a message',
  'nav.admin.audit': 'All activity',
  'nav.loans.statement': 'Loan statement',

  /* The phone tab bar. Five cells across 320px, so these are shorter than the
     full names above and not derived from them — "Ledger" fits where
     "Transactions" does not. Every one is spelled out rather than falling back,
     because a fallback here would print the Bengali short label on an English
     tab bar, which is the one place a stray word is unmissable. */
  'nav.dashboard.tab': 'Home',
  'nav.transactions.tab': 'Ledger',
  'nav.loans.tab': 'Loans',
  'nav.reports.tab': 'Reports',
  'nav.more.tab': 'More',
  'nav.admin.tab': 'Overview',
  'nav.admin.tenants.tab': 'Customers',
  'nav.admin.analytics.tab': 'Analytics',
  'nav.admin.broadcast.tab': 'Message',
  'nav.admin.plans.tab': 'Plans',

  // --- navigation blurbs -----------------------------------------------------
  'nav.dashboard.blurb': 'This month’s income, spending and balances at a glance',
  'nav.transactions.blurb': 'Every entry, with filters and search',
  'nav.loans.blurb': 'What you have lent out, and what you owe',
  'nav.reports.blurb': 'Income and spending by month and by category',
  'nav.admin.blurb': 'Every workspace and its limits',
  'nav.admin.tenants.blurb': 'The customer list',
  'nav.admin.broadcast.blurb': 'To everyone who has connected Telegram',
  'nav.admin.analytics.blurb': 'By category, across every tenant',
  'nav.admin.audit.blurb': 'Across every tenant',
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

  // --- words that appear on more than one screen -----------------------------
  'common.choose': 'Choose',
  'common.save': 'Save',
  'common.saving': 'Saving…',
  'common.saveFailed': 'Could not save',
  'common.searching': 'Searching…',
  'common.searchResults': 'Search results',
  'common.clearSearch': 'Clear the search',
  'common.close': 'Close',
  'password.show': 'Show',
  'password.hide': 'Hide',
  'common.new': 'New',
  'common.edit': 'Edit',
  'common.delete': 'Delete',
  'common.search': 'Search',
  'common.checkConnection': 'Check your connection and try again.',

  // --- the shell -------------------------------------------------------------
  'shell.mainMenu': 'Main menu',
  /* The initial in the avatar when there is no name yet. A glyph, not a word:
     a Bengali letter on otherwise English chrome reads as a rendering bug. */
  'shell.avatarFallback': 'T',
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
  'dashboard.liquid': 'Cash and bank',
  'dashboard.netWorth': 'Net worth',
  'dashboard.netWorthHint': 'Land, savings and money owed to you, less what you owe',
  'dashboard.isAsset': '· asset',
  'dashboard.isLiability': '· liability',
  'dashboard.topCategories': 'Top 5 spending categories',
  'dashboard.noSpendYet': 'Nothing spent this month yet.',
  'dashboard.noAccounts': 'No accounts yet.',
  'dashboard.addOne': 'Add one',
  'dashboard.empty': 'Nothing written down yet. Tap + below to add your first entry.',

  // --- shared spending -------------------------------------------------------
  /* "Split" is the word every app in this space uses and the word Bangladeshi
     users of those apps already know. The Bengali says ভাগাভাগি; this does not
     try to translate the concept twice. */
  'nav.split': 'Split',
  'nav.split.blurb': 'Spending together — trips, flats, the office; who owes what',
  'split.title': 'Split',
  'split.blurb': 'Spending together — who paid, who owes',
  'split.groups': 'Groups',
  'split.newGroup': 'New group',
  'split.newGroupHint': 'The people you share costs with',
  'split.name': 'Group name',
  'split.namePlaceholder': 'e.g. Cox’s Bazar trip',
  'split.nameRequired': 'Give the group a name',
  'split.purpose': 'Kind',
  'split.people': 'Who is in it',
  'split.peoplePlaceholder': 'Karim, Rahim, Salam',
  'split.peopleHint':
    'Separate names with commas. You are in the group already — and they need no account of their own.',
  'split.archived': 'Archived groups',
  'split.emptyTitle': 'No groups yet',
  'split.emptyBody':
    'Make a group when a trip, a flat or an office lunch is shared. Only your own share becomes your expense; the rest is recorded as money owed.',
  'split.settled': 'All square',
  'split.youGet': 'you get back',
  'split.youOwe': 'you owe',
  'split.notFound': 'That group was not found.',
  'split.me': 'Me',
  'split.left': '· left the group',
  'split.square': 'All square',
  'split.getsBack': 'gets back',
  'split.owes': 'owes',
  'split.addPerson': 'Person',
  'split.personName': 'Name',
  'split.personHint':
    'They need no account. The name is added to your People list too, so loans and shared costs stay in one place.',
  'split.expense': 'Expense',
  'split.expenses': 'Expenses',
  'split.noExpenses': 'Nothing recorded yet.',
  'split.addExpense': 'Add an expense',
  'split.amount': 'How much',
  'split.amountRequired': 'Enter an amount',
  'split.date': 'Date',
  'split.what': 'What for',
  'split.whatFor': 'Say what it was for',
  'split.whatPlaceholder': 'e.g. dinner',
  'split.paidBy': 'Paid by',
  'split.paidByName': '{name} paid',
  'split.youPaid': 'you paid',
  'split.yourShare': 'Your share',
  'split.fromAccount': 'From which account',
  'split.account': 'Account',
  'split.accountRequired': 'Choose the account it came from',
  'split.someoneElsePaid':
    'Somebody else paid, so no money leaves your account — only your share is recorded as owed.',
  'split.method': 'How it divides',
  'split.who': 'Who was there',
  'split.whoRequired': 'Choose at least one person',
  'split.shares': 'shares',
  'split.more': 'Category and note',
  'split.category': 'Category',
  'split.noCategory': 'No category',
  'split.note': 'Note',
  'split.deleteExpense': 'Delete this expense',
  'split.settleUp': 'To settle up',
  'split.settleHint':
    'The fewest payments that clear the group. Tapping one fills in the amount — nothing reaches your books until you confirm it.',
  'split.settleTitle': 'Settle up',
  'split.recordPayment': 'Record the payment',
  'split.betweenOthers':
    'This is between two other people — nothing is added to your books, only the group’s balances change.',

  // --- the entry sheet -------------------------------------------------------
  'entry.tab.expense': 'Expense',
  'entry.tab.income': 'Income',
  'entry.tab.transfer': 'Transfer',
  'entry.edit': 'Edit entry',
  'entry.kind': 'Kind',
  'entry.amount': 'Amount',
  'entry.date': 'Date',
  'entry.account': 'Account',
  'entry.fromAccount': 'From account',
  'entry.toAccount': 'To account',
  'entry.category': 'Category',
  'entry.subCategory': 'Sub-category',
  /* `{name}` is filled in with the parent's name at the call site. Kept as a
     placeholder rather than concatenated, because Bengali puts the possessive
     after the name and English puts "of" before it. */
  'entry.subOf': 'Inside {name}',
  'entry.subCategoryHint':
    'Optional. A sub-category still adds into its parent’s total on the report.',
  'entry.description': 'Description',
  'entry.descriptionHint': 'e.g. weekly grocery run',
  'entry.notes': 'Notes',
  'entry.quickPick': 'Quick pick',
  'entry.repeat': 'Add again',
  'entry.transaction': 'Entry',
  'entry.withWhom': 'With whom',
  'entry.nobody': 'Nobody',
  'entry.none': 'None',
  'entry.personHint': 'Optional. To add somebody new, go to People.',
  'entry.searchCategory': 'Search categories',
  'entry.searchCategoryHint': 'Search — rickshaw, khabar, electricity',
  'entry.searchFailed': 'Could not search — pick from the list below.',
  'entry.noSuchCategory': 'No category by that name — see the list below.',
  'entry.pickCategory': 'Choose a category',
  'entry.amountPositive': 'The amount has to be more than zero',
  'entry.badRate': 'The rate or the original amount is not right',

  // --- quantity --------------------------------------------------------------
  'quantity.open': 'Record a quantity? (how many kilos, how many litres)',
  'quantity.title': 'Quantity',
  'quantity.remove': 'Remove',
  'quantity.howMuch': 'How much',
  'quantity.unit': 'Unit',
  'quantity.unitCommon': 'Most used',
  'quantity.unitMine': 'Your units',
  'quantity.unitOther': 'Type another unit…',
  'quantity.unitOwnHint': 'e.g. tola, crate',
  'quantity.unitFromList': 'Pick from the list',
  'quantity.hint': 'At month end you will see how much was bought — under “Quantity” in reports.',

  // --- another currency ------------------------------------------------------
  'fx.open': 'Spent in another currency?',
  'fx.title': 'Spent in another currency',
  'fx.currency': 'Currency',
  'fx.original': 'Original amount',
  'fx.rate': 'Rate',
  'fx.fetching': 'Fetching today’s rate…',
  'fx.suggested':
    'Today’s published rate has been filled in. You can change it — whatever is here is what goes into the books.',
  'fx.failed': 'Could not fetch a rate — type one in.',
  'fx.willSave': 'Goes into the books as:',

  // --- accounts --------------------------------------------------------------
  'account.group.liquid': 'In hand and in the bank',
  'account.group.asset': 'Assets',
  'account.group.liability': 'Liabilities',
  'account.type.CASH': 'Cash',
  'account.type.BANK': 'Bank',
  'account.type.MOBILE_WALLET': 'Mobile wallet',
  'account.type.SAVINGS': 'Savings / DPS',
  'account.type.ASSET': 'Asset (land, gold, a car)',
  'account.type.RECEIVABLE': 'Receivable (owed to me)',
  'account.type.CREDIT_CARD': 'Credit card',
  'account.type.LIABILITY': 'Loan / liability',
  'account.type.PAYABLE': 'Payable (owed by me)',
  'account.colour.green': 'Green',
  'account.colour.blue': 'Blue',
  'account.colour.gold': 'Gold',
  'account.colour.red': 'Red',
  'account.colour.purple': 'Purple',
  'account.colour.grey': 'Grey',
  'account.name': 'Name',
  'account.nameHint': 'e.g. BRAC Bank',
  'account.total': 'Total',
  'account.empty': 'No accounts yet.',
  'account.new': 'New account',
  'account.edit': 'Edit account',
  'account.opening': 'Opening balance',
  'account.institution': 'Institution',
  'account.masked': 'Account number (last few digits)',
  'account.matchHints': 'Matching hints',
  'account.matchHintsHint': 'e.g. 4521, bKash, DBBL',
  'account.icon': 'Icon (emoji)',
  'account.colour': 'Colour',
  'account.noColour': 'No colour',
  'account.sortOrder': 'Order in the list (smaller first)',
  'account.dueDay': 'Payment due (day of the month)',
  'account.statementDay': 'Statement date (day of the month)',
  'account.leadDays': 'How many days ahead to remind',
  'account.leadDaysHint': 'Leave blank for the workspace rule',
  /* `{day}` is filled in at the call site, in the reader's own digits. */
  'account.dueOn': 'payment on day {day} of each month',
  'account.muteReminder': 'Mute this month’s reminder',
  'account.reconcile': 'Reconcile',
  'account.reconcileTitle': 'Reconcile the balance',
  'account.realBalance': 'Actual balance',
  'account.alreadyMatched': 'It already matched.',
  'account.adjusted': 'The difference has been added as an adjustment.',
  'account.badOpening': 'Could not read the opening balance.',
  'account.atLimit': 'Plan limit reached',
  'account.atLimitHint':
    'Plan limit reached. Press an old account’s name to archive it, or upgrade the plan.',
  'account.archiveTitle': 'Archive it?',
  'account.archive': 'Archive',
  'account.archiveBody':
    'The account leaves the list and can no longer be chosen on a new entry. Past entries, balances and every report stay exactly as they are, and it stops counting against the plan limit. You can bring it back later.',
  'account.hideArchived': 'Hide archived',
  'account.showArchived': 'Show archived accounts',

  // --- the ledger ------------------------------------------------------------
  'txn.type.INCOME': 'Income',
  'txn.type.EXPENSE': 'Expense',
  'txn.type.TRANSFER': 'Transfer',
  'txn.type.ADJUSTMENT': 'Adjustment',
  'txn.type.OPENING_BALANCE': 'Opening balance',
  'txn.type.LOAN_GIVEN': 'Lent out',
  'txn.type.LOAN_REPAID': 'Loan repaid to me',
  'txn.type.BORROWED': 'Borrowed',
  'txn.type.BORROW_REPAID': 'Loan I repaid',
  'txn.type.SAVINGS_DEPOSIT': 'Into savings',
  'txn.type.SAVINGS_WITHDRAWAL': 'Out of savings',
  'txn.type.PREMIUM_PAID': 'Insurance premium',
  'txn.source.MANUAL': 'Written by hand',
  'txn.source.SMS': 'SMS',
  'txn.source.EMAIL': 'Email',
  'txn.source.WEBHOOK': 'Webhook',
  'txn.source.OCR': 'From a photo',
  'txn.source.IMPORT': 'From a file',
  'txn.source.RECURRING': 'Recurring',
  'txn.detail': 'Entry detail',
  'txn.receipts': 'Receipts',
  'txn.noReceipts': 'No receipt added.',
  'txn.receiptFailed':
    'The receipt could not be saved — the server cannot yet keep a receipt attached to an entry.',
  'txn.empty': 'Nothing written down yet.',
  'txn.emptyHint': 'Tap + to add your first entry.',
  'txn.emptyFiltered': 'No entries match this filter.',
  'txn.emptyFilteredHint': 'Try changing the filters above.',
  'txn.listFailed': 'Could not load the entries.',
  'txn.loading': 'Loading…',
  'txn.loadMore': 'Show more',
  'txn.deleted': 'Deleted',
  'txn.tagGone': 'That tag no longer exists.',
  /* `{n}` is filled in at the call site, in the reader's own digits. */
  'txn.showingN': 'showing {n}',
  'txn.countN': '{n} entries',
  'txn.activeFilters': 'Active filters',
  'txn.removeFilter': 'Remove the filter',
  'txn.fromDate': 'From date',
  'txn.toDate': 'To date',
  'txn.allAccounts': 'Every account',
  'txn.allCategories': 'Every category',
  'txn.allTags': 'Every tag',
  'txn.allKinds': 'Every kind',
  'txn.allSources': 'Every source',
  'txn.everyone': 'Everyone',
  'txn.source': 'Where it came from',
  'txn.person': 'Person',
  'txn.personFilter': 'Person (loans)',
  'txn.savingsInsurance': 'Savings & insurance',
  'txn.filterByTag': 'filter by this tag',
  'txn.unfilterTag': 'remove this tag filter',
  'txn.searchHint': 'family, last month',

  // --- date ranges -----------------------------------------------------------
  'range.thisMonth': 'This month',
  'range.lastMonth': 'Last month',
  'range.thisYear': 'This year',
  'range.from': 'onwards',
  'range.to': 'and before',

  // --- settings --------------------------------------------------------------
  'settings.plan': 'Plan',
  'settings.perMonth': 'month',
  'settings.monthlyEntries': 'Entries this month',
  'settings.members': 'Members',
  'settings.categories': 'Managing categories',
  'settings.seeCategories': 'See categories',
  'settings.theme': 'Theme',
  'settings.theme.system': 'System',
  'settings.theme.light': 'Light',
  'settings.theme.dark': 'Dark',
  'settings.nextUp': 'Coming next',
  'settings.next.sms': 'Drafts read from bank SMS — once we have samples of your real messages',
  'settings.next.email': 'Verification and password-reset links by email',
  'settings.next.mobile': 'A mobile app',

  // --- reports ---------------------------------------------------------------
  'reports.asOf': 'As things stand',
  'reports.summary': 'Summary',
  'reports.summaryFailed': 'Could not load the summary.',
  'reports.comparisonFailed': 'Could not load the comparison',
  'reports.netWorth': 'Net worth',
  'reports.netWorthFailed': 'Could not load net worth.',
  'reports.assets': 'Assets',
  'reports.liabilities': 'Liabilities',
  'reports.liquid': 'Cash on hand',
  'reports.trend': 'Income and spending by month',
  'reports.trendFailed': 'Could not load the monthly figures.',
  /* `{n}` is filled in at the call site, in the reader's own digits. */
  'reports.trendTooFar':
    'This chart reaches back {n} months at most, so the months in this period cannot be shown.',
  'reports.trendEmpty': 'No months to show for this period.',
  'reports.monthCount': '{n} months',
  'reports.wholeMonths': 'this chart shows whole months, not part of the chosen period',
  'reports.trendLimit': 'months older than {n} are not available',
  'reports.byCategory': 'By category',
  'reports.byCategoryKind': 'Income or spending, by category',
  'reports.byCategoryFailed': 'Could not load the category figures.',
  'reports.byTagKind': 'Income or spending, by tag',
  'reports.cashFlow': 'Cash flow',
  'reports.cashFlowFailed': 'Could not load cash flow.',
  'reports.opening': 'Opening',
  'reports.inflow': 'In',
  'reports.outflow': 'Out',
  'reports.closing': 'Closing',
  'reports.cashFlowHint':
    'Opening is where things stood before the chosen period; closing is where they stand at the end of it.',
  'reports.accountsCounted': 'Accounts counted',
  'reports.balanceSheet': 'Assets and liabilities',
  'reports.balanceSheetFailed': 'Could not load assets and liabilities.',
  'reports.none': 'Nothing',
  'reports.detail': 'Detail',
  'reports.detailFailed': 'Could not load the detail.',
  'reports.total': 'total',
  'reports.emptyPeriod': 'Nothing in this period.',

  // --- first run -------------------------------------------------------------
  'firstRun.title': 'Let’s begin',
  'firstRun.body': 'Tell us where your money is and you can start writing — two minutes.',
  'firstRun.start': 'Get started',
  'firstRun.dismiss': 'Don’t show this again',
  'firstRun.dismissing': 'Hiding…',

  // --- the offline bar -------------------------------------------------------
  'offline.offline': 'Offline',
  'offline.back': 'Back online',
  /* `{n}` is filled in at the call site, in the reader's own digits. */
  'offline.pendingN': '{n} changes waiting',
  'offline.failedN': '{n} changes the server refused',
  'offline.hide': 'Hide',
  'offline.details': 'Details',
  'offline.refused': 'The server did not accept the change',
  'offline.saveTxn': 'Saving an entry',
  'offline.deleteTxn': 'Deleting an entry',
  'offline.loan': 'A loan',
  'offline.change': 'A change',

  // --- the keypad ------------------------------------------------------------
  'keypad.label': 'Number pad',

  // --- receipts --------------------------------------------------------------
  'attach.badType': 'Only images (JPEG, PNG, WebP, HEIC) or PDF files can be attached',
  'attach.empty': 'The file is empty — try again',
  'attach.offline': 'No connection',
  'attach.cancelled': 'Cancelled',
  'attach.cancel': 'Cancel the upload',
  'attach.duplicate': 'This receipt has been attached once already.',
  'attach.failed': 'Could not upload',
  'attach.remove': 'Remove the attachment',
  'attach.retry': 'Try again',

  // --- proving the email address ---------------------------------------------
  'verify.title': 'Verify your email',
  /* `{email}` and `{n}` are filled in at the call site. Placeholders rather
     than sentence fragments joined around a tag: the address sits in a
     different place in each language. */
  'verify.sentTo':
    'A six-digit code has been sent to {email}. Type it in below — or press the button in the email.',
  'verify.expiry':
    'The code works for {n} minutes. If it has not arrived, check your spam folder, or press “Send again”.',
  'verify.code': 'Code',
  'verify.check': 'Verify',
  'verify.checking': 'Checking…',
  'verify.mismatch': 'That code did not match',
  'verify.resend': 'Send again',
  'verify.resent': 'A new code is on its way.',
  'verify.sending': 'Sending…',
  'verify.sendFailed': 'Could not send',

  // --- sharing a statement ---------------------------------------------------
  'share.title': 'Share a statement',
  'share.short': 'Share',
  'share.blurb':
    'This makes a link. Whoever you send it to can read and print the statement without an account — and cannot change it.',
  'share.from': 'From date',
  'share.to': 'To date',
  'share.wholeLife': 'Leave both empty for everything from the beginning to today.',
  'share.wholeLifeShort': 'Everything',
  'share.label': 'A note for yourself (optional)',
  'share.labelHint': 'e.g. for BRAC Bank',
  'share.create': 'Make the link',
  'share.ready': 'Link ready — copy it now',
  /* True and surprising, so it is said rather than implied. Only the hash is
     stored, so there is genuinely nothing to show a second time. */
  'share.onceOnly': 'This link cannot be shown again. If you lose it, make another.',
  'share.link': 'Share link',
  'share.copy': 'Copy',
  'share.copied': 'Copied',
  'share.existing': 'Links you have made',
  /* `{date}` and `{n}` are filled in at the call site, in the reader's digits. */
  'share.until': 'Works until {date}',
  'share.views': 'opened {n} times',
  'share.revoked': 'Revoked',
  'share.expired': 'Expired',
  'share.revokeOne': 'Revoke this link',

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
