import type { CategoryKind } from '@hishab/shared';

/** Bangladesh-appropriate default category tree, seeded for every new user. */
export interface DefaultCategory {
  nameBn: string;
  name: string;
  kind: CategoryKind;
  icon: string;
  sortOrder: number;
}

export const DEFAULT_CATEGORIES: readonly DefaultCategory[] = [
  // Income
  { nameBn: 'বেতন', name: 'Salary', kind: 'INCOME', icon: 'wallet', sortOrder: 10 },
  { nameBn: 'ব্যবসা', name: 'Business', kind: 'INCOME', icon: 'store', sortOrder: 20 },
  { nameBn: 'ফ্রিল্যান্স', name: 'Freelance', kind: 'INCOME', icon: 'laptop', sortOrder: 30 },
  { nameBn: 'বাড়ি ভাড়া', name: 'Rental income', kind: 'INCOME', icon: 'home', sortOrder: 40 },
  {
    nameBn: 'মুনাফা/সুদ',
    name: 'Profit / interest',
    kind: 'INCOME',
    icon: 'trending-up',
    sortOrder: 50,
  },
  { nameBn: 'উপহার', name: 'Gift', kind: 'INCOME', icon: 'gift', sortOrder: 60 },
  { nameBn: 'অন্যান্য', name: 'Other income', kind: 'INCOME', icon: 'dots', sortOrder: 999 },

  // Expense
  {
    nameBn: 'খাবার ও বাজার',
    name: 'Food & groceries',
    kind: 'EXPENSE',
    icon: 'basket',
    sortOrder: 10,
  },
  { nameBn: 'বাসা ভাড়া', name: 'House rent', kind: 'EXPENSE', icon: 'home', sortOrder: 20 },
  { nameBn: 'ইউটিলিটি', name: 'Utilities', kind: 'EXPENSE', icon: 'bolt', sortOrder: 30 },
  {
    nameBn: 'মোবাইল/ইন্টারনেট',
    name: 'Mobile & internet',
    kind: 'EXPENSE',
    icon: 'wifi',
    sortOrder: 40,
  },
  { nameBn: 'যাতায়াত', name: 'Transport', kind: 'EXPENSE', icon: 'bus', sortOrder: 50 },
  { nameBn: 'স্বাস্থ্য', name: 'Health', kind: 'EXPENSE', icon: 'heart', sortOrder: 60 },
  { nameBn: 'শিক্ষা', name: 'Education', kind: 'EXPENSE', icon: 'book', sortOrder: 70 },
  { nameBn: 'পোশাক', name: 'Clothing', kind: 'EXPENSE', icon: 'shirt', sortOrder: 80 },
  {
    nameBn: 'পরিবার ও সহায়তা',
    name: 'Family & support',
    kind: 'EXPENSE',
    icon: 'users',
    sortOrder: 90,
  },
  { nameBn: 'দান/যাকাত', name: 'Charity / zakat', kind: 'EXPENSE', icon: 'hand', sortOrder: 100 },
  { nameBn: 'মেরামত', name: 'Repairs', kind: 'EXPENSE', icon: 'tool', sortOrder: 110 },
  { nameBn: 'বিনোদন', name: 'Entertainment', kind: 'EXPENSE', icon: 'film', sortOrder: 120 },
  { nameBn: 'ব্যাংক চার্জ', name: 'Bank charges', kind: 'EXPENSE', icon: 'bank', sortOrder: 130 },
  { nameBn: 'অন্যান্য', name: 'Other expense', kind: 'EXPENSE', icon: 'dots', sortOrder: 999 },
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
