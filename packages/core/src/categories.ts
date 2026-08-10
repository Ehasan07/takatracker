import type { CategoryKind } from '@hishab/shared';

/** Bangladesh-appropriate default category tree, seeded for every new user. */
export interface DefaultCategory {
  nameBn: string;
  name: string;
  kind: CategoryKind;
  icon: string;
  sortOrder: number;
  /**
   * Extra words that must find this row, matched as whole words and nothing
   * less. The note below the interface says what belongs here and what does not.
   */
  searchAliases: readonly string[];
}

/*
 * **Why `searchAliases` exists at all, and what belongs in it.**
 *
 * The matcher transliterates: `khabar` finds খাবার because they are the same
 * word written in two scripts, and no table of aliases is needed for that. What
 * a letter mapping provably cannot do is cross from one word to a *different*
 * word with the same meaning. `poribohon` (পরিবহন) means the same as যাতায়াত
 * and shares not one letter with it, so the fold of one can never equal the fold
 * of the other — measured live, `khabar` and `bajar` both ranked first while
 * `poribohon` returned nothing. `restaurant` → খাবার ও বাজার and `rickshaw` →
 * যাতায়াত are the same failure.
 *
 * So the rule for what goes in the list is **what a person types**, not what the
 * word means:
 *
 *  1. **Banglish spellings that differ from the transliteration.** `Shastho`
 *     next to স্বাস্থ্য, `Bebsha` next to ব্যবসা. Redundant spellings are kept
 *     deliberately — the transliterator caps how many candidates one word may
 *     branch into, and an alias is a guarantee that does not depend on that cap.
 *  2. **English synonyms.** `Restaurant`, `Grocery`, `Doctor`, `Rent`.
 *  3. **The brand names Dhaka actually uses.** `Uber` and `Pathao` are যাতায়াত;
 *     `DESCO`, `WASA` and `Titas` are ইউটিলিটি; `GP` and `Robi` are
 *     মোবাইল/ইন্টারনেট. This is the case that turns a wrong answer into a right
 *     one rather than merely adding a new one: before aliases, `uber` reached
 *     খাবার ও বাজার — `b1('uber')` is `abar`, which sits inside the fold of
 *     `khabar o bajar` — and `robi` reached পরিবার ও সহায়তা the same way. Both
 *     were coincidences of a collapsed vowel. Now they are answers.
 *
 * What does **not** belong here: anything that would be found anyway, where
 * "anyway" means at a *higher* rung. An alias is matched whole-word only, so a
 * fragment (`kha`, `tran`) buys nothing the prefix rungs do not already give.
 */

export const DEFAULT_CATEGORIES: readonly DefaultCategory[] = [
  // Income
  {
    nameBn: 'বেতন',
    name: 'Salary',
    kind: 'INCOME',
    icon: 'wallet',
    sortOrder: 10,
    // `Maine` (মাইনে) is the older word and still the one older users type.
    searchAliases: ['Beton', 'Betan', 'Maine', 'Salary', 'Bonus'],
  },
  {
    nameBn: 'ব্যবসা',
    name: 'Business',
    kind: 'INCOME',
    icon: 'store',
    sortOrder: 20,
    searchAliases: ['Bebsha', 'Bebsa', 'Byabsa', 'Business', 'Dokan', 'Shop', 'Bikri', 'Sales'],
  },
  {
    nameBn: 'ফ্রিল্যান্স',
    name: 'Freelance',
    kind: 'INCOME',
    icon: 'laptop',
    sortOrder: 30,
    // `Outsourcing` is what freelancing is called in Bangladesh, by everyone.
    searchAliases: ['Frilanse', 'Frilancing', 'Outsourcing', 'Upwork', 'Fiverr'],
  },
  {
    nameBn: 'বাড়ি ভাড়া',
    name: 'Rental income',
    kind: 'INCOME',
    icon: 'home',
    sortOrder: 40,
    /* `Bhara` is deliberately on both this row and বাসা ভাড়া: the word itself
     * does not say who is paying. `kind` separates them for a picker that has
     * already chosen a side, and an unscoped search should show both. */
    searchAliases: ['Bari Bhara', 'Bari Vara', 'Bhara', 'Vara', 'Rent income', 'Tenant'],
  },
  {
    nameBn: 'মুনাফা/সুদ',
    name: 'Profit / interest',
    kind: 'INCOME',
    icon: 'trending-up',
    sortOrder: 50,
    // FDR and সঞ্চয়পত্র are where most household interest in Bangladesh comes from.
    searchAliases: [
      'Munafa',
      'Shud',
      'Sud',
      'Labh',
      'Interest',
      'Profit',
      'Dividend',
      'FDR',
      'Sanchaypatra',
    ],
  },
  {
    nameBn: 'উপহার',
    name: 'Gift',
    kind: 'INCOME',
    icon: 'gift',
    sortOrder: 60,
    // সালামি/ঈদি arrive at Eid and are the commonest gift anyone records.
    searchAliases: ['Upohar', 'Uphar', 'Gift', 'Salami', 'Eidi', 'Hadiya'],
  },
  {
    nameBn: 'অন্যান্য',
    name: 'Other income',
    kind: 'INCOME',
    icon: 'dots',
    sortOrder: 999,
    searchAliases: ['Onnanno', 'Ononno', 'Bibidh', 'Other', 'Misc'],
  },

  // Expense
  {
    nameBn: 'খাবার ও বাজার',
    name: 'Food & groceries',
    kind: 'EXPENSE',
    icon: 'basket',
    sortOrder: 10,
    /* `Hotel` is not a hotel: in Bangladesh it is where you eat. Foodpanda,
     * Chaldal, Shwapno, Agora and Meena Bazar are where the money actually goes. */
    searchAliases: [
      'Khabar',
      'Bajar',
      'Khabar O Bajar',
      'Kacha Bajar',
      'Restaurant',
      'Grocery',
      'Food',
      'Hotel',
      'Nasta',
      'Foodpanda',
      'Chaldal',
      'Shwapno',
      'Agora',
      'Meena Bazar',
    ],
  },
  {
    nameBn: 'বাসা ভাড়া',
    name: 'House rent',
    kind: 'EXPENSE',
    icon: 'home',
    sortOrder: 20,
    searchAliases: [
      'Basa Bhara',
      'Basa Vara',
      'Barir Bhara',
      'Flat Bhara',
      'Bhara',
      'Vara',
      'Rent',
    ],
  },
  {
    nameBn: 'ইউটিলিটি',
    name: 'Utilities',
    kind: 'EXPENSE',
    icon: 'bolt',
    sortOrder: 30,
    /* The bill is never called a utility bill. It is called DESCO, WASA, Titas
     * or পল্লী বিদ্যুৎ — the name of whoever sent it. */
    searchAliases: [
      'Utility',
      'Bidyut',
      'Biddut',
      'Electricity',
      'Current Bill',
      'Gas',
      'Pani',
      'Water',
      'Bill',
      'WASA',
      'DESCO',
      'DPDC',
      'Titas',
      'Palli Bidyut',
    ],
  },
  {
    nameBn: 'মোবাইল/ইন্টারনেট',
    name: 'Mobile & internet',
    kind: 'EXPENSE',
    icon: 'wifi',
    sortOrder: 40,
    /* `Robi` used to reach পরিবার ও সহায়তা by fold coincidence and now reaches
     * the row it names. `Flexiload` is the word for topping a number up. */
    searchAliases: [
      'Mobile',
      'Mobail',
      'Internet',
      'Net Bill',
      'Recharge',
      'Flexiload',
      'Wifi',
      'Broadband',
      'GP',
      'Grameenphone',
      'Robi',
      'Banglalink',
      'Airtel',
      'Teletalk',
    ],
  },
  {
    nameBn: 'যাতায়াত',
    name: 'Transport',
    kind: 'EXPENSE',
    icon: 'bus',
    sortOrder: 50,
    /* পরিবহন and যাতায়াত are two words for one thing and share no letters, which
     * is the case that made this column necessary. `Launch` is the river ferry,
     * `Leguna` the shared minibus, `Uber`/`Pathao`/`Shohoz` the apps. */
    searchAliases: [
      'Poribohon',
      'Transport',
      'Jatayat',
      'Rickshaw',
      'Riksha',
      'Uber',
      'Pathao',
      'Shohoz',
      'CNG',
      'Bus',
      'Taxi',
      'Train',
      'Launch',
      'Petrol',
      'Octane',
      'Bus Bhara',
      'Leguna',
    ],
  },
  {
    nameBn: 'স্বাস্থ্য',
    name: 'Health',
    kind: 'EXPENSE',
    icon: 'heart',
    sortOrder: 60,
    searchAliases: [
      'Shastho',
      'Sastho',
      'Health',
      'Doctor',
      'Daktar',
      'Ousudh',
      'Osudh',
      'Medicine',
      'Pharmacy',
      'Hospital',
      'Clinic',
      'Diagnostic',
    ],
  },
  {
    nameBn: 'শিক্ষা',
    name: 'Education',
    kind: 'EXPENSE',
    icon: 'book',
    sortOrder: 70,
    // `Private` and `Coaching` are the two names for paid tutoring here.
    searchAliases: [
      'Shikkha',
      'Sikkha',
      'Porashona',
      'Education',
      'School',
      'College',
      'University',
      'Coaching',
      'Tuition',
      'Private',
      'Boi',
      'Exam',
      'Exam Fee',
    ],
  },
  {
    nameBn: 'পোশাক',
    name: 'Clothing',
    kind: 'EXPENSE',
    icon: 'shirt',
    sortOrder: 80,
    searchAliases: [
      'Poshak',
      'Clothing',
      'Clothes',
      'Kapor',
      'Kapod',
      'Jama',
      'Shirt',
      'Panjabi',
      'Saree',
      'Shari',
      'Juta',
      'Shoe',
      'Aarong',
    ],
  },
  {
    nameBn: 'পরিবার ও সহায়তা',
    name: 'Family & support',
    kind: 'EXPENSE',
    icon: 'users',
    sortOrder: 90,
    // `Barite Taka` — money sent home — is how this line is described out loud.
    searchAliases: [
      'Poribar',
      'Paribar',
      'Family',
      'Sohayota',
      'Shohayota',
      'Support',
      'Ma Baba',
      'Barite Taka',
      'Khoraki',
    ],
  },
  {
    nameBn: 'দান/যাকাত',
    name: 'Charity / zakat',
    kind: 'EXPENSE',
    icon: 'hand',
    sortOrder: 100,
    searchAliases: [
      'Dan',
      'Daan',
      'Zakat',
      'Jakat',
      'Charity',
      'Donation',
      'Sadaka',
      'Sadaqah',
      'Fitra',
      'Masjid',
      'Korbani',
    ],
  },
  {
    nameBn: 'মেরামত',
    name: 'Repairs',
    kind: 'EXPENSE',
    icon: 'tool',
    sortOrder: 110,
    // The entry is usually filed under whoever did the work: মিস্ত্রি.
    searchAliases: [
      'Meramot',
      'Meramat',
      'Repair',
      'Servicing',
      'Maintenance',
      'Mistri',
      'Plumber',
      'Electrician',
      'Rong',
    ],
  },
  {
    nameBn: 'বিনোদন',
    name: 'Entertainment',
    kind: 'EXPENSE',
    icon: 'film',
    sortOrder: 120,
    // Chorki, Hoichoi and Bongo are the streaming subscriptions people here pay for.
    searchAliases: [
      'Binodon',
      'Binodan',
      'Entertainment',
      'Cinema',
      'Movie',
      'Netflix',
      'Chorki',
      'Hoichoi',
      'Bongo',
      'Ghora',
      'Picnic',
      'Concert',
      'Game',
    ],
  },
  {
    nameBn: 'ব্যাংক চার্জ',
    name: 'Bank charges',
    kind: 'EXPENSE',
    icon: 'bank',
    sortOrder: 130,
    /* bKash, Nagad, Rocket and Upay are accounts, not categories — but the only
     * *category* their name ever belongs to is the cash-out fee, so a person
     * typing `bkash` into a category picker is looking for this row. */
    searchAliases: [
      'Bank Charge',
      'Bank Charj',
      'Charge',
      'Fee',
      'Cash Out',
      'Cashout',
      'Send Money',
      'bKash',
      'Bikash',
      'Nagad',
      'Rocket',
      'Upay',
      'ATM',
      'Excise Duty',
      'Abgari Shulko',
    ],
  },
  {
    nameBn: 'অন্যান্য',
    name: 'Other expense',
    kind: 'EXPENSE',
    icon: 'dots',
    sortOrder: 999,
    searchAliases: ['Onnanno', 'Ononno', 'Bibidh', 'Kharoch', 'Other', 'Misc'],
  },
] as const;

/** Hidden nominal accounts that make the double entry balance. */
export const SYSTEM_ACCOUNT_KEYS = {
  income: 'SYSTEM_INCOME',
  expense: 'SYSTEM_EXPENSE',
  equity: 'SYSTEM_EQUITY',
} as const;

export const SYSTEM_ACCOUNT_SEED = [
  { systemKey: SYSTEM_ACCOUNT_KEYS.income, name: 'আয়', type: 'EQUITY' as const },
  { systemKey: SYSTEM_ACCOUNT_KEYS.expense, name: 'ব্যয়', type: 'EQUITY' as const },
  {
    systemKey: SYSTEM_ACCOUNT_KEYS.equity,
    name: 'প্রারম্ভিক জের ও সমন্বয়',
    type: 'EQUITY' as const,
  },
] as const;
