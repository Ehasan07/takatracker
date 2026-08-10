import {
  BadgeCheck,
  Building2,
  ChartColumn,
  Ellipsis,
  FileSpreadsheet,
  HandCoins,
  Inbox,
  LayoutDashboard,
  LayoutGrid,
  Mail,
  NotebookText,
  PiggyBank,
  ScrollText,
  Settings,
  ShieldCheck,
  Tag as TagIcon,
  Tags,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

/**
 * One list of destinations, three presentations.
 *
 *   phone tab bar   PRIMARY, five items, short labels
 *   আরও hub         GROUPS, every destination the tab bar cannot hold
 *   desktop sidebar PRIMARY (without আরও) followed by GROUPS, all thirteen
 *
 * Keeping the model here rather than in the shell is what makes "every route is
 * reachable" checkable: a route that is not in this file appears in no menu, and
 * `ROUTE_TITLES` below is derived from it, so a screen cannot be added to the
 * navigation and forgotten by the title bar.
 */
export interface Destination {
  href: string;
  /** Full name. Title bar, sidebar and hub row. */
  label: string;
  /** Tab-bar name. Five Bengali labels only fit across 320px if they are short. */
  tabLabel?: string;
  icon: LucideIcon;
  /** What the screen is for, one line. Only the hub shows it. */
  blurb?: string;
  /** Words a person might search for that are not in the label. */
  synonyms?: string;
}

export interface Group {
  id: string;
  title: string;
  items: Destination[];
}

export const MORE_HREF = '/more';

/**
 * The five that earn a permanent seat.
 *
 * Chosen by how often a hand reaches for them, not by how much of the product
 * they represent. ড্যাশবোর্ড and খাতা are daily. ধার-দেনা is the screen this app
 * exists for in a Bangladeshi household — money lent to relatives, tracked over
 * months — and is opened weekly. রিপোর্ট is monthly but is the reason people
 * keep a ledger at all. Everything else is either set up once (অ্যাকাউন্ট,
 * ক্যাটাগরি), used in bursts (ইমপোর্ট, ইনবক্স) or consulted rarely (কার্যবিবরণী,
 * প্ল্যান), which is exactly what a hub is for.
 */
export const PRIMARY: Destination[] = [
  {
    href: '/',
    label: 'ড্যাশবোর্ড',
    tabLabel: 'হোম',
    icon: LayoutDashboard,
    blurb: 'এই মাসের আয়, খরচ ও ব্যালেন্স এক নজরে',
    synonyms: 'dashboard home হোম প্রথম পাতা',
  },
  {
    href: '/transactions',
    label: 'খাতা',
    tabLabel: 'খাতা',
    icon: NotebookText,
    blurb: 'সব লেনদেনের তালিকা, ছাঁকনি ও খোঁজ',
    synonyms: 'transactions ledger লেনদেন খরচ আয়',
  },
  {
    href: '/loans',
    label: 'ধার-দেনা',
    tabLabel: 'ঋণ',
    icon: HandCoins,
    blurb: 'কাকে কত দিয়েছেন, কার কাছে কত পাওনা',
    synonyms: 'loans ঋণ পাওনা দেনা কিস্তি',
  },
  {
    href: '/reports',
    label: 'রিপোর্ট',
    tabLabel: 'রিপোর্ট',
    icon: ChartColumn,
    blurb: 'মাস ও খাত ধরে আয়-খরচের বিশ্লেষণ',
    synonyms: 'reports চার্ট গ্রাফ বিশ্লেষণ',
  },
  {
    href: MORE_HREF,
    label: 'আরও',
    tabLabel: 'আরও',
    icon: Ellipsis,
    synonyms: 'more সব মেনু',
  },
];

/**
 * The hub, grouped by the question the person is actually asking.
 *
 *   টাকা কোথায়      the screens that answer "where is my money".
 *   তথ্য ও সরঞ্জাম   the screens that get data in and keep it tidy.
 *   অ্যাপ            the screens about the app rather than the money.
 *
 * Grouping by question rather than by feature is why বীমা is no longer four taps
 * behind অ্যাকাউন্ট: it is a place money goes, so it sits beside সঞ্চয়.
 */
export const GROUPS: Group[] = [
  {
    id: 'money',
    title: 'টাকা কোথায়',
    items: [
      {
        href: '/accounts',
        label: 'অ্যাকাউন্ট',
        icon: Wallet,
        blurb: 'ব্যাংক, বিকাশ-নগদ ও হাতের নগদের ব্যালেন্স',
        synonyms: 'accounts wallet ব্যাংক বিকাশ নগদ রকেট ব্যালেন্স',
      },
      {
        href: '/savings',
        label: 'সঞ্চয় ও ডিপিএস',
        icon: PiggyBank,
        blurb: 'ডিপিএস ও সঞ্চয় স্কিমের কিস্তি, মেয়াদ ও মুনাফা',
        synonyms: 'savings dps সঞ্চয়পত্র জমা',
      },
      {
        href: '/insurance',
        label: 'বীমা',
        icon: ShieldCheck,
        blurb: 'পলিসির প্রিমিয়াম কবে, কত, কোনটা বাকি',
        synonyms: 'insurance পলিসি প্রিমিয়াম লাইফ',
      },
    ],
  },
  {
    id: 'data',
    title: 'তথ্য ও সরঞ্জাম',
    items: [
      {
        href: '/mail',
        label: 'মেইল',
        icon: Mail,
        blurb: 'যুক্ত করা মেইলবক্সের চিঠি — ব্যাংকের বিবরণী এখান থেকে দেখুন',
        synonyms: 'mail email ইমেইল চিঠি inbox gmail',
      },
      {
        href: '/inbox',
        label: 'বার্তার ইনবক্স',
        icon: Inbox,
        blurb: 'এসএমএস থেকে তৈরি খসড়া — আপনি না বললে খাতায় যাবে না',
        synonyms: 'inbox sms খসড়া বার্তা টেলিগ্রাম draft',
      },
      {
        href: '/tags',
        label: 'ট্যাগ',
        icon: TagIcon,
        blurb: 'কার জন্য বা কোন কাজে — পারিবারিক, ব্যবসা, রমজান',
        synonyms: 'tag ট্যাগ label পারিবারিক purpose',
      },
      {
        href: '/categories',
        label: 'ক্যাটাগরি',
        icon: Tags,
        blurb: 'আয় ও খরচের খাত যোগ করুন, নাম বদলান, মুছুন',
        synonyms: 'categories খাত ট্যাগ',
      },
      {
        href: '/import',
        label: 'ইমপোর্ট ও এক্সপোর্ট',
        icon: FileSpreadsheet,
        blurb: 'স্টেটমেন্ট থেকে লেনদেন আনুন, ব্যাকআপ নামান',
        synonyms: 'import export csv excel এক্সেল ব্যাকআপ স্টেটমেন্ট',
      },
    ],
  },
  {
    id: 'app',
    title: 'অ্যাপ',
    items: [
      {
        href: '/settings',
        label: 'সেটিংস',
        icon: Settings,
        blurb: 'প্রোফাইল, থিম, টেলিগ্রাম ও সাইন-ইন করা ডিভাইস',
        synonyms: 'settings থিম ডার্ক লগআউট টেলিগ্রাম প্রোফাইল',
      },
      {
        href: '/plans',
        label: 'প্ল্যান ও সীমা',
        icon: BadgeCheck,
        blurb: 'আপনার প্ল্যান কী দেয় আর তার কতটা ব্যবহার হয়েছে',
        synonyms: 'plans billing সাবস্ক্রিপশন দাম সীমা',
      },
      {
        href: '/audit',
        label: 'কার্যবিবরণী',
        icon: ScrollText,
        blurb: 'কে কখন কী বদলেছে তার পূর্ণ তালিকা',
        synonyms: 'audit log ইতিহাস পরিবর্তন',
      },
    ],
  },
];

/** Everything the hub lists, flattened. */
export const HUB_DESTINATIONS: Destination[] = GROUPS.flatMap((group) => group.items);

/** Every destination, tab bar included — what the hub's search box searches. */
export const ALL_DESTINATIONS: Destination[] = [
  ...PRIMARY.filter((item) => item.href !== MORE_HREF),
  ...HUB_DESTINATIONS,
];

/**
 * The desktop sidebar carries the whole product: the four tabs, then the same
 * three groups under the same three headings as the hub.
 *
 * আরও is a phone constraint — five cells of 64px — and there is no reason to
 * impose it on a 1280px window. Using the hub's own grouping means somebody who
 * works on a laptop and checks a balance on the bus meets one mental model,
 * with the small screen showing a subset of the large one rather than a
 * different idea. There is no আরও row here because there is nothing left for it
 * to hold.
 */
/**
 * The operator's own destination.
 *
 * Kept out of `ALL_DESTINATIONS` and `HUB_DESTINATIONS` on purpose, so the আরও
 * hub's search can never surface it to somebody who is not an operator — the
 * panel's whole design premise is that it does not advertise itself. It is
 * appended to the sidebar only when `/auth/me` says `isSuperAdmin`.
 */
export const ADMIN_GROUP: Group = {
  id: 'platform',
  title: 'প্ল্যাটফর্ম',
  items: [
    { href: '/admin', label: 'প্ল্যাটফর্ম', icon: LayoutGrid, blurb: 'সব ওয়ার্কস্পেস ও সীমা' },
    { href: '/admin/tenants', label: 'ওয়ার্কস্পেস', icon: Building2, blurb: 'গ্রাহকের তালিকা' },
    {
      href: '/admin/audit',
      label: 'সব কার্যবিবরণী',
      icon: ScrollText,
      blurb: 'সব টেন্যান্ট জুড়ে',
    },
  ],
};

export const SIDEBAR_GROUPS: Group[] = [
  { id: 'primary', title: '', items: PRIMARY.filter((item) => item.href !== MORE_HREF) },
  ...GROUPS,
];

/**
 * Phone title-bar names.
 *
 * Derived from the model so a destination can never be listed in a menu and be
 * nameless in the title bar — the failure that left `/inbox` printing its own
 * `<h1>` on a phone because the shell only knew how to say "হিসাব".
 *
 * The two loan *person* routes are deliberately not named after their contents.
 * They print the counterparty's name as their own `<h1>`, which is the right
 * heading for them and one the shell cannot know; repeating it here would put
 * two identical headings on one phone screen, wrong for a screen reader and a
 * strict-mode failure for the tests that look them up by role. The statement is
 * different — its name is fixed — so it is titled below and its own `<h1>` is
 * hidden under `md:`, the two halves of one change.
 */
export const ROUTE_TITLES: Record<string, string> = {
  ...Object.fromEntries(ALL_DESTINATIONS.map((item) => [item.href, item.label])),
  [MORE_HREF]: 'আরও',
  /* Deliberately different from each page's own `<h1>` ("প্ল্যাটফর্মের
   * সারসংক্ষেপ", "সব ওয়ার্কস্পেস"), so the phone title bar never repeats a
   * heading that is already on the screen. */
  '/admin': 'প্ল্যাটফর্ম',
  '/admin/tenants': 'ওয়ার্কস্পেস',
  '/admin/plans': 'প্যাকেজ',
  '/admin/features': 'ফিচার',
  '/admin/audit': 'কার্যবিবরণী',
};

/**
 * Screens whose path carries an id, so they cannot be a literal key above.
 *
 * Only for routes whose name is the same every time. A screen titled after its
 * contents belongs to the screen, not to the shell.
 */
const ROUTE_PATTERNS: {
  match: RegExp;
  title: string;
  parent: (groups: RegExpMatchArray) => string;
}[] = [
  {
    match: /^\/loans\/([^/]+)\/statement\/?$/,
    title: 'ঋণের বিবরণী',
    parent: (groups) => `/loans/${groups[1]}`,
  },
];

/** Exact, then the id-bearing patterns, then longest prefix. */
export function titleFor(pathname: string): string {
  const exact = ROUTE_TITLES[pathname];
  if (exact) return exact;

  for (const pattern of ROUTE_PATTERNS) {
    if (pattern.match.test(pathname)) return pattern.title;
  }

  const segments = pathname.split('/').filter(Boolean);
  for (let depth = segments.length - 1; depth > 0; depth -= 1) {
    const candidate = `/${segments.slice(0, depth).join('/')}`;
    const hit = ROUTE_TITLES[candidate];
    if (hit) return hit;
  }
  return 'হিসাব';
}

const PRIMARY_HREFS = new Set(PRIMARY.map((item) => item.href));

/** A tab is a root: it gets no back arrow, because there is nowhere above it. */
export const isPrimaryRoute = (pathname: string): boolean => PRIMARY_HREFS.has(pathname);

/**
 * Where "back" goes when there is no history to go back to — someone opened a
 * notification, or restored a standalone window onto a deep link. A native app
 * still shows the parent screen rather than a dead arrow.
 */
export function parentOf(pathname: string): string {
  for (const pattern of ROUTE_PATTERNS) {
    const groups = pattern.match.exec(pathname);
    if (groups) return pattern.parent(groups);
  }

  const segments = pathname.split('/').filter(Boolean);
  // Walk up to the nearest ancestor that is a real screen. `/loans/people/<id>`
  // has no `/loans/people` page, so the honest parent is `/loans`.
  for (let depth = segments.length - 1; depth > 0; depth -= 1) {
    const candidate = `/${segments.slice(0, depth).join('/')}`;
    if (ROUTE_TITLES[candidate]) return candidate;
  }
  return HUB_DESTINATIONS.some((item) => item.href === pathname) ? MORE_HREF : '/';
}

/** Case-insensitive substring match over label, blurb and synonyms. */
export function matchesQuery(item: Destination, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = `${item.label} ${item.blurb ?? ''} ${item.synonyms ?? ''}`.toLowerCase();
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}
