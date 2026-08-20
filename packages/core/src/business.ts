import type { CategoryKind } from '@hishab/shared';

/**
 * The category tree a personal business needs, and nothing more.
 *
 * ## Why this is a seed and not something the owner types
 *
 * Eighteen categories in the right shape is twenty minutes of typing and a
 * dozen chances to file a share purchase under খরচ. Worse, the names matter:
 * "বিক্রীত পণ্যের ব্যয়" is where the month-end stock count posts, and a
 * workspace that called it "মাল কেনা" would have the count landing in a line
 * that already holds the purchases — counting the same money twice.
 *
 * So the tree is defined once, here, beside the accounting it belongs to.
 *
 * ## What is in it, and what deliberately is not
 *
 * The lines a proprietor in Bangladesh actually has: sales, the cost of what
 * was sold, rent, wages, utilities, transport, packaging, brokerage, the trade
 * licence. Nothing for depreciation — this codebase does not compute it and
 * saying otherwise on a screen would be a lie with a category to file it under.
 * Nothing for VAT either: a business large enough to file a VAT return needs a
 * second set of books, not a category.
 *
 * Both halves of the share trading pair are here — মুনাফা on the income side,
 * ক্ষতি on the expense side — because a loss is not "no income". A month that
 * lost money has to be able to say so, and a book with only the winning half of
 * the pair reports a business as more profitable than it was, every time.
 */
export interface BusinessCategorySeed {
  nameBn: string;
  name: string;
  icon: string;
  /** Banglish spellings and English synonyms — see `DEFAULT_CATEGORIES`. */
  searchAliases: readonly string[];
}

export interface BusinessCategoryGroup extends BusinessCategorySeed {
  kind: CategoryKind;
  children: readonly BusinessCategorySeed[];
}

/**
 * The exact name the month-end stock count posts against.
 *
 * Named as a constant rather than repeated as a string: the seed below writes
 * it and `BusinessService.stockCount` looks it up, and the two drifting apart
 * would put the cost of goods sold in a category nobody reads.
 */
export const COST_OF_GOODS_SOLD_BN = 'বিক্রীত পণ্যের ব্যয়';

export const BUSINESS_CATEGORY_SEED: readonly BusinessCategoryGroup[] = [
  {
    nameBn: 'ব্যবসার আয়',
    name: 'Business income',
    kind: 'INCOME',
    icon: 'briefcase',
    searchAliases: ['Bebsha', 'Business', 'Byabsha'],
    children: [
      {
        nameBn: 'পণ্য বিক্রি',
        name: 'Sales',
        icon: 'shopping-bag',
        searchAliases: ['Bikri', 'Bikroy', 'Sales', 'Sale'],
      },
      {
        nameBn: 'সেবা বিক্রি',
        name: 'Service income',
        icon: 'wrench',
        searchAliases: ['Seba', 'Service', 'Fee'],
      },
      {
        nameBn: 'শেয়ার বিক্রয়ে মুনাফা',
        name: 'Gain on shares',
        icon: 'trending-up',
        searchAliases: ['Share', 'Capital gain', 'Munafa', 'Stock'],
      },
      {
        nameBn: 'লভ্যাংশ',
        name: 'Dividend',
        icon: 'coins',
        searchAliases: ['Dividend', 'Lovyangsho'],
      },
      {
        nameBn: 'অন্যান্য ব্যবসায়িক আয়',
        name: 'Other business income',
        icon: 'circle-ellipsis',
        searchAliases: ['Onnanno', 'Other'],
      },
    ],
  },
  {
    nameBn: 'ব্যবসার খরচ',
    name: 'Business costs',
    kind: 'EXPENSE',
    icon: 'briefcase',
    searchAliases: ['Bebsha', 'Business', 'Byabsha'],
    children: [
      {
        nameBn: COST_OF_GOODS_SOLD_BN,
        name: 'Cost of goods sold',
        icon: 'package',
        searchAliases: ['COGS', 'Cost of goods', 'Mojud', 'Stock'],
      },
      {
        nameBn: 'দোকান ভাড়া',
        name: 'Shop rent',
        icon: 'store',
        searchAliases: ['Bhara', 'Vara', 'Rent', 'Dokan'],
      },
      {
        nameBn: 'কর্মচারীর বেতন',
        name: 'Wages',
        icon: 'users',
        searchAliases: ['Beton', 'Salary', 'Wages', 'Staff'],
      },
      {
        nameBn: 'বিদ্যুৎ ও পানি',
        name: 'Utilities',
        icon: 'zap',
        searchAliases: ['Bidyut', 'Electricity', 'Water', 'Utility', 'DESCO', 'WASA'],
      },
      {
        nameBn: 'পরিবহন ও ডেলিভারি',
        name: 'Transport and delivery',
        icon: 'truck',
        searchAliases: ['Poribohon', 'Transport', 'Delivery', 'Van', 'Courier'],
      },
      {
        nameBn: 'প্যাকেজিং',
        name: 'Packaging',
        icon: 'box',
        searchAliases: ['Packaging', 'Packet', 'Carton'],
      },
      {
        nameBn: 'ব্রোকারেজ ও কমিশন',
        name: 'Brokerage and commission',
        icon: 'percent',
        searchAliases: ['Brokerage', 'Commission', 'Laga', 'Howla', 'CDBL'],
      },
      {
        nameBn: 'ট্রেড লাইসেন্স ও সরকারি ফি',
        name: 'Licence and government fees',
        icon: 'file-badge',
        searchAliases: ['Trade licence', 'Trade license', 'License', 'Fee', 'Renewal'],
      },
      {
        nameBn: 'মেরামত',
        name: 'Repairs',
        icon: 'hammer',
        searchAliases: ['Meramot', 'Repair', 'Maintenance'],
      },
      {
        nameBn: 'শেয়ার বিক্রয়ে ক্ষতি',
        name: 'Loss on shares',
        icon: 'trending-down',
        searchAliases: ['Share', 'Capital loss', 'Khoti', 'Stock'],
      },
      {
        nameBn: 'অন্যান্য ব্যবসায়িক খরচ',
        name: 'Other business costs',
        icon: 'circle-ellipsis',
        searchAliases: ['Onnanno', 'Other'],
      },
    ],
  },
];

/** Every category the seed would create, parents and children alike. */
export function businessCategoryCount(): number {
  return BUSINESS_CATEGORY_SEED.reduce((n, group) => n + 1 + group.children.length, 0);
}
