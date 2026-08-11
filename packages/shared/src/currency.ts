/**
 * ISO 4217, and the one field in it that can corrupt a ledger.
 *
 * Every amount in this system is an integer in the currency's *smallest* unit,
 * and `money.ts` has assumed since day one that there are 100 of those in a
 * major unit — true for taka, dollars and euros, and false for a fifth of the
 * world's currencies. A yen has **no** minor unit at all: ¥500 is 500, not
 * 50,000. A Kuwaiti dinar has a thousand fils. A workspace on either, formatted
 * with a hardcoded 100, is out by two or three orders of magnitude on every
 * screen and in every export.
 *
 * So `digits` is not decoration. It is the number that decides what an integer
 * in the database *means*, and it is the reason this file exists rather than a
 * bare list of codes and symbols.
 *
 * `symbol` is the mark a person expects to see, which is not always the ISO
 * code and not always unique — several countries write `$`, and disambiguating
 * them (`US$`, `A$`) belongs to a locale-aware formatter, not to a symbol
 * column. Where a currency has no widely-recognised mark, the code is the
 * symbol, which is what every bank statement does too.
 */

export interface CurrencyInfo {
  /** ISO 4217 alphabetic code. The primary key everywhere in the system. */
  code: string;
  /** English name, as ISO writes it. */
  name: string;
  /** Bengali name where one is in common use, otherwise the English one. */
  nameBn: string;
  /** What to print in front of the amount. */
  symbol: string;
  /**
   * Minor units per major, as an exponent: 2 means 100, 0 means none, 3 means
   * 1000. Straight from ISO 4217's own "minor unit" column.
   */
  digits: 0 | 2 | 3;
}

/**
 * The currencies a person can choose.
 *
 * Ordered alphabetically by code, except that BDT comes first: this is a
 * Bangladeshi product and the default should not be seventeen scrolls down.
 * The rest is the ISO 4217 active list, minus the funds codes (`XAU`, `XDR`,
 * and the rest of the `X…` family) which are not money anybody keeps a
 * household ledger in.
 */
export const CURRENCIES: readonly CurrencyInfo[] = [
  { code: 'BDT', name: 'Bangladeshi Taka', nameBn: 'বাংলাদেশি টাকা', symbol: '৳', digits: 2 },
  {
    code: 'AED',
    name: 'UAE Dirham',
    nameBn: 'সংযুক্ত আরব আমিরাত দিরহাম',
    symbol: 'د.إ',
    digits: 2,
  },
  { code: 'AFN', name: 'Afghan Afghani', nameBn: 'আফগান আফগানি', symbol: '؋', digits: 2 },
  { code: 'ALL', name: 'Albanian Lek', nameBn: 'আলবেনীয় লেক', symbol: 'L', digits: 2 },
  { code: 'AMD', name: 'Armenian Dram', nameBn: 'আর্মেনীয় দ্রাম', symbol: '֏', digits: 2 },
  {
    code: 'ANG',
    name: 'Netherlands Antillean Guilder',
    nameBn: 'অ্যান্টিলিয়ান গিল্ডার',
    symbol: 'ƒ',
    digits: 2,
  },
  { code: 'AOA', name: 'Angolan Kwanza', nameBn: 'অ্যাঙ্গোলান কোয়ানজা', symbol: 'Kz', digits: 2 },
  { code: 'ARS', name: 'Argentine Peso', nameBn: 'আর্জেন্টাইন পেসো', symbol: '$', digits: 2 },
  { code: 'AUD', name: 'Australian Dollar', nameBn: 'অস্ট্রেলীয় ডলার', symbol: 'A$', digits: 2 },
  { code: 'AWG', name: 'Aruban Florin', nameBn: 'আরুবান ফ্লোরিন', symbol: 'ƒ', digits: 2 },
  { code: 'AZN', name: 'Azerbaijani Manat', nameBn: 'আজারবাইজানি মানাত', symbol: '₼', digits: 2 },
  {
    code: 'BAM',
    name: 'Bosnia-Herzegovina Convertible Mark',
    nameBn: 'বসনিয়ান মার্ক',
    symbol: 'KM',
    digits: 2,
  },
  { code: 'BBD', name: 'Barbadian Dollar', nameBn: 'বার্বাডিয়ান ডলার', symbol: 'Bds$', digits: 2 },
  { code: 'BGN', name: 'Bulgarian Lev', nameBn: 'বুলগেরীয় লেভ', symbol: 'лв', digits: 2 },
  { code: 'BHD', name: 'Bahraini Dinar', nameBn: 'বাহরাইনি দিনার', symbol: '.د.ب', digits: 3 },
  { code: 'BIF', name: 'Burundian Franc', nameBn: 'বুরুন্ডি ফ্রাঁ', symbol: 'FBu', digits: 0 },
  { code: 'BMD', name: 'Bermudian Dollar', nameBn: 'বারমুডিয়ান ডলার', symbol: 'BD$', digits: 2 },
  { code: 'BND', name: 'Brunei Dollar', nameBn: 'ব্রুনাই ডলার', symbol: 'B$', digits: 2 },
  { code: 'BOB', name: 'Bolivian Boliviano', nameBn: 'বলিভিয়ানো', symbol: 'Bs.', digits: 2 },
  { code: 'BRL', name: 'Brazilian Real', nameBn: 'ব্রাজিলীয় রিয়াল', symbol: 'R$', digits: 2 },
  { code: 'BSD', name: 'Bahamian Dollar', nameBn: 'বাহামিয়ান ডলার', symbol: 'B$', digits: 2 },
  {
    code: 'BTN',
    name: 'Bhutanese Ngultrum',
    nameBn: 'ভুটানি এনগুলট্রাম',
    symbol: 'Nu.',
    digits: 2,
  },
  { code: 'BWP', name: 'Botswanan Pula', nameBn: 'বতসোয়ানা পুলা', symbol: 'P', digits: 2 },
  { code: 'BYN', name: 'Belarusian Ruble', nameBn: 'বেলারুশীয় রুবল', symbol: 'Br', digits: 2 },
  { code: 'BZD', name: 'Belize Dollar', nameBn: 'বেলিজ ডলার', symbol: 'BZ$', digits: 2 },
  { code: 'CAD', name: 'Canadian Dollar', nameBn: 'কানাডীয় ডলার', symbol: 'C$', digits: 2 },
  { code: 'CDF', name: 'Congolese Franc', nameBn: 'কঙ্গোলিজ ফ্রাঁ', symbol: 'FC', digits: 2 },
  { code: 'CHF', name: 'Swiss Franc', nameBn: 'সুইস ফ্রাঁ', symbol: 'CHF', digits: 2 },
  { code: 'CLP', name: 'Chilean Peso', nameBn: 'চিলিয়ান পেসো', symbol: '$', digits: 0 },
  { code: 'CNY', name: 'Chinese Yuan', nameBn: 'চীনা ইউয়ান', symbol: '¥', digits: 2 },
  { code: 'COP', name: 'Colombian Peso', nameBn: 'কলম্বিয়ান পেসো', symbol: '$', digits: 2 },
  { code: 'CRC', name: 'Costa Rican Colón', nameBn: 'কোস্টারিকান কোলন', symbol: '₡', digits: 2 },
  { code: 'CUP', name: 'Cuban Peso', nameBn: 'কিউবান পেসো', symbol: '$', digits: 2 },
  { code: 'CVE', name: 'Cape Verdean Escudo', nameBn: 'কেপ ভার্দে এসকুডো', symbol: '$', digits: 2 },
  { code: 'CZK', name: 'Czech Koruna', nameBn: 'চেক কোরুনা', symbol: 'Kč', digits: 2 },
  { code: 'DJF', name: 'Djiboutian Franc', nameBn: 'জিবুতি ফ্রাঁ', symbol: 'Fdj', digits: 0 },
  { code: 'DKK', name: 'Danish Krone', nameBn: 'ড্যানিশ ক্রোন', symbol: 'kr', digits: 2 },
  { code: 'DOP', name: 'Dominican Peso', nameBn: 'ডোমিনিকান পেসো', symbol: 'RD$', digits: 2 },
  { code: 'DZD', name: 'Algerian Dinar', nameBn: 'আলজেরীয় দিনার', symbol: 'د.ج', digits: 2 },
  { code: 'EGP', name: 'Egyptian Pound', nameBn: 'মিশরীয় পাউন্ড', symbol: 'E£', digits: 2 },
  { code: 'ERN', name: 'Eritrean Nakfa', nameBn: 'ইরিত্রিয়ান নাকফা', symbol: 'Nfk', digits: 2 },
  { code: 'ETB', name: 'Ethiopian Birr', nameBn: 'ইথিওপিয়ান বির', symbol: 'Br', digits: 2 },
  { code: 'EUR', name: 'Euro', nameBn: 'ইউরো', symbol: '€', digits: 2 },
  { code: 'FJD', name: 'Fijian Dollar', nameBn: 'ফিজিয়ান ডলার', symbol: 'FJ$', digits: 2 },
  { code: 'GBP', name: 'British Pound', nameBn: 'ব্রিটিশ পাউন্ড', symbol: '£', digits: 2 },
  { code: 'GEL', name: 'Georgian Lari', nameBn: 'জর্জিয়ান লারি', symbol: '₾', digits: 2 },
  { code: 'GHS', name: 'Ghanaian Cedi', nameBn: 'ঘানাইয়ান সেডি', symbol: '₵', digits: 2 },
  { code: 'GMD', name: 'Gambian Dalasi', nameBn: 'গাম্বিয়ান ডালাসি', symbol: 'D', digits: 2 },
  { code: 'GNF', name: 'Guinean Franc', nameBn: 'গিনি ফ্রাঁ', symbol: 'FG', digits: 0 },
  {
    code: 'GTQ',
    name: 'Guatemalan Quetzal',
    nameBn: 'গুয়াতেমালান কেৎসাল',
    symbol: 'Q',
    digits: 2,
  },
  { code: 'GYD', name: 'Guyanaese Dollar', nameBn: 'গায়ানিজ ডলার', symbol: 'G$', digits: 2 },
  { code: 'HKD', name: 'Hong Kong Dollar', nameBn: 'হংকং ডলার', symbol: 'HK$', digits: 2 },
  { code: 'HNL', name: 'Honduran Lempira', nameBn: 'হন্ডুরান লেম্পিরা', symbol: 'L', digits: 2 },
  { code: 'HRK', name: 'Croatian Kuna', nameBn: 'ক্রোয়েশীয় কুনা', symbol: 'kn', digits: 2 },
  { code: 'HTG', name: 'Haitian Gourde', nameBn: 'হাইতিয়ান গুর্দ', symbol: 'G', digits: 2 },
  { code: 'HUF', name: 'Hungarian Forint', nameBn: 'হাঙ্গেরীয় ফোরিন্ট', symbol: 'Ft', digits: 2 },
  {
    code: 'IDR',
    name: 'Indonesian Rupiah',
    nameBn: 'ইন্দোনেশীয় রুপিয়া',
    symbol: 'Rp',
    digits: 2,
  },
  { code: 'ILS', name: 'Israeli New Shekel', nameBn: 'ইসরায়েলি শেকেল', symbol: '₪', digits: 2 },
  { code: 'INR', name: 'Indian Rupee', nameBn: 'ভারতীয় রুপি', symbol: '₹', digits: 2 },
  { code: 'IQD', name: 'Iraqi Dinar', nameBn: 'ইরাকি দিনার', symbol: 'ع.د', digits: 3 },
  { code: 'IRR', name: 'Iranian Rial', nameBn: 'ইরানি রিয়াল', symbol: '﷼', digits: 2 },
  { code: 'ISK', name: 'Icelandic Króna', nameBn: 'আইসল্যান্ডীয় ক্রোনা', symbol: 'kr', digits: 0 },
  { code: 'JMD', name: 'Jamaican Dollar', nameBn: 'জ্যামাইকান ডলার', symbol: 'J$', digits: 2 },
  { code: 'JOD', name: 'Jordanian Dinar', nameBn: 'জর্ডানীয় দিনার', symbol: 'د.ا', digits: 3 },
  { code: 'JPY', name: 'Japanese Yen', nameBn: 'জাপানি ইয়েন', symbol: '¥', digits: 0 },
  { code: 'KES', name: 'Kenyan Shilling', nameBn: 'কেনীয় শিলিং', symbol: 'KSh', digits: 2 },
  { code: 'KGS', name: 'Kyrgystani Som', nameBn: 'কিরগিজ সোম', symbol: 'с', digits: 2 },
  { code: 'KHR', name: 'Cambodian Riel', nameBn: 'কম্বোডিয়ান রিয়েল', symbol: '៛', digits: 2 },
  { code: 'KMF', name: 'Comorian Franc', nameBn: 'কোমোরিয়ান ফ্রাঁ', symbol: 'CF', digits: 0 },
  { code: 'KRW', name: 'South Korean Won', nameBn: 'দক্ষিণ কোরীয় ওন', symbol: '₩', digits: 0 },
  { code: 'KWD', name: 'Kuwaiti Dinar', nameBn: 'কুয়েতি দিনার', symbol: 'د.ك', digits: 3 },
  { code: 'KYD', name: 'Cayman Islands Dollar', nameBn: 'কেম্যান ডলার', symbol: 'CI$', digits: 2 },
  { code: 'KZT', name: 'Kazakhstani Tenge', nameBn: 'কাজাখ টেঙ্গে', symbol: '₸', digits: 2 },
  { code: 'LAK', name: 'Laotian Kip', nameBn: 'লাও কিপ', symbol: '₭', digits: 2 },
  { code: 'LBP', name: 'Lebanese Pound', nameBn: 'লেবানিজ পাউন্ড', symbol: 'ل.ل', digits: 2 },
  { code: 'LKR', name: 'Sri Lankan Rupee', nameBn: 'শ্রীলঙ্কান রুপি', symbol: 'Rs', digits: 2 },
  { code: 'LRD', name: 'Liberian Dollar', nameBn: 'লাইবেরিয়ান ডলার', symbol: 'L$', digits: 2 },
  { code: 'LSL', name: 'Lesotho Loti', nameBn: 'লেসোথো লোটি', symbol: 'L', digits: 2 },
  { code: 'LYD', name: 'Libyan Dinar', nameBn: 'লিবীয় দিনার', symbol: 'ل.د', digits: 3 },
  { code: 'MAD', name: 'Moroccan Dirham', nameBn: 'মরক্কোন দিরহাম', symbol: 'د.م.', digits: 2 },
  { code: 'MDL', name: 'Moldovan Leu', nameBn: 'মলদোভান লেউ', symbol: 'L', digits: 2 },
  { code: 'MGA', name: 'Malagasy Ariary', nameBn: 'মালাগাসি আরিয়ারি', symbol: 'Ar', digits: 0 },
  {
    code: 'MKD',
    name: 'Macedonian Denar',
    nameBn: 'ম্যাসিডোনিয়ান দিনার',
    symbol: 'ден',
    digits: 2,
  },
  { code: 'MMK', name: 'Myanmar Kyat', nameBn: 'মিয়ানমার কিয়াট', symbol: 'K', digits: 2 },
  { code: 'MNT', name: 'Mongolian Tugrik', nameBn: 'মঙ্গোলীয় তুগ্রিক', symbol: '₮', digits: 2 },
  { code: 'MOP', name: 'Macanese Pataca', nameBn: 'ম্যাকানিজ পাতাকা', symbol: 'MOP$', digits: 2 },
  { code: 'MUR', name: 'Mauritian Rupee', nameBn: 'মরিশিয়ান রুপি', symbol: '₨', digits: 2 },
  {
    code: 'MVR',
    name: 'Maldivian Rufiyaa',
    nameBn: 'মালদ্বীপীয় রুফিয়া',
    symbol: 'Rf',
    digits: 2,
  },
  { code: 'MWK', name: 'Malawian Kwacha', nameBn: 'মালাউইয়ান কোয়াচা', symbol: 'MK', digits: 2 },
  { code: 'MXN', name: 'Mexican Peso', nameBn: 'মেক্সিকান পেসো', symbol: 'Mex$', digits: 2 },
  { code: 'MYR', name: 'Malaysian Ringgit', nameBn: 'মালয়েশীয় রিঙ্গিত', symbol: 'RM', digits: 2 },
  {
    code: 'MZN',
    name: 'Mozambican Metical',
    nameBn: 'মোজাম্বিকান মেটিকাল',
    symbol: 'MT',
    digits: 2,
  },
  { code: 'NAD', name: 'Namibian Dollar', nameBn: 'নামিবিয়ান ডলার', symbol: 'N$', digits: 2 },
  { code: 'NGN', name: 'Nigerian Naira', nameBn: 'নাইজেরীয় নাইরা', symbol: '₦', digits: 2 },
  {
    code: 'NIO',
    name: 'Nicaraguan Córdoba',
    nameBn: 'নিকারাগুয়ান কর্দোবা',
    symbol: 'C$',
    digits: 2,
  },
  { code: 'NOK', name: 'Norwegian Krone', nameBn: 'নরওয়েজীয় ক্রোন', symbol: 'kr', digits: 2 },
  { code: 'NPR', name: 'Nepalese Rupee', nameBn: 'নেপালি রুপি', symbol: 'रू', digits: 2 },
  {
    code: 'NZD',
    name: 'New Zealand Dollar',
    nameBn: 'নিউজিল্যান্ড ডলার',
    symbol: 'NZ$',
    digits: 2,
  },
  { code: 'OMR', name: 'Omani Rial', nameBn: 'ওমানি রিয়াল', symbol: 'ر.ع.', digits: 3 },
  {
    code: 'PAB',
    name: 'Panamanian Balboa',
    nameBn: 'পানামানিয়ান বালবোয়া',
    symbol: 'B/.',
    digits: 2,
  },
  { code: 'PEN', name: 'Peruvian Sol', nameBn: 'পেরুভিয়ান সোল', symbol: 'S/', digits: 2 },
  {
    code: 'PGK',
    name: 'Papua New Guinean Kina',
    nameBn: 'পাপুয়া নিউ গিনি কিনা',
    symbol: 'K',
    digits: 2,
  },
  { code: 'PHP', name: 'Philippine Peso', nameBn: 'ফিলিপিন পেসো', symbol: '₱', digits: 2 },
  { code: 'PKR', name: 'Pakistani Rupee', nameBn: 'পাকিস্তানি রুপি', symbol: '₨', digits: 2 },
  { code: 'PLN', name: 'Polish Zloty', nameBn: 'পোলিশ জলোটি', symbol: 'zł', digits: 2 },
  {
    code: 'PYG',
    name: 'Paraguayan Guarani',
    nameBn: 'প্যারাগুয়ান গুয়ারানি',
    symbol: '₲',
    digits: 0,
  },
  { code: 'QAR', name: 'Qatari Riyal', nameBn: 'কাতারি রিয়াল', symbol: 'ر.ق', digits: 2 },
  { code: 'RON', name: 'Romanian Leu', nameBn: 'রোমানীয় লেউ', symbol: 'lei', digits: 2 },
  { code: 'RSD', name: 'Serbian Dinar', nameBn: 'সার্বীয় দিনার', symbol: 'дин.', digits: 2 },
  { code: 'RUB', name: 'Russian Ruble', nameBn: 'রুশ রুবল', symbol: '₽', digits: 2 },
  { code: 'RWF', name: 'Rwandan Franc', nameBn: 'রুয়ান্ডান ফ্রাঁ', symbol: 'FRw', digits: 0 },
  { code: 'SAR', name: 'Saudi Riyal', nameBn: 'সৌদি রিয়াল', symbol: 'ر.س', digits: 2 },
  { code: 'SBD', name: 'Solomon Islands Dollar', nameBn: 'সলোমন ডলার', symbol: 'SI$', digits: 2 },
  { code: 'SCR', name: 'Seychellois Rupee', nameBn: 'সেশেলোয়া রুপি', symbol: '₨', digits: 2 },
  { code: 'SDG', name: 'Sudanese Pound', nameBn: 'সুদানি পাউন্ড', symbol: 'ج.س.', digits: 2 },
  { code: 'SEK', name: 'Swedish Krona', nameBn: 'সুইডিশ ক্রোনা', symbol: 'kr', digits: 2 },
  { code: 'SGD', name: 'Singapore Dollar', nameBn: 'সিঙ্গাপুর ডলার', symbol: 'S$', digits: 2 },
  {
    code: 'SLE',
    name: 'Sierra Leonean Leone',
    nameBn: 'সিয়েরা লিওনি লিওন',
    symbol: 'Le',
    digits: 2,
  },
  { code: 'SOS', name: 'Somali Shilling', nameBn: 'সোমালি শিলিং', symbol: 'Sh', digits: 2 },
  { code: 'SRD', name: 'Surinamese Dollar', nameBn: 'সুরিনামিজ ডলার', symbol: '$', digits: 2 },
  {
    code: 'SSP',
    name: 'South Sudanese Pound',
    nameBn: 'দক্ষিণ সুদানি পাউন্ড',
    symbol: '£',
    digits: 2,
  },
  { code: 'STN', name: 'São Tomé and Príncipe Dobra', nameBn: 'ডোবরা', symbol: 'Db', digits: 2 },
  { code: 'SYP', name: 'Syrian Pound', nameBn: 'সিরীয় পাউন্ড', symbol: '£S', digits: 2 },
  { code: 'SZL', name: 'Swazi Lilangeni', nameBn: 'সোয়াজি লিলাঙ্গেনি', symbol: 'E', digits: 2 },
  { code: 'THB', name: 'Thai Baht', nameBn: 'থাই বাত', symbol: '฿', digits: 2 },
  { code: 'TJS', name: 'Tajikistani Somoni', nameBn: 'তাজিক সোমোনি', symbol: 'ЅМ', digits: 2 },
  { code: 'TMT', name: 'Turkmenistani Manat', nameBn: 'তুর্কমেন মানাত', symbol: 'm', digits: 2 },
  { code: 'TND', name: 'Tunisian Dinar', nameBn: 'তিউনিসীয় দিনার', symbol: 'د.ت', digits: 3 },
  { code: 'TOP', name: 'Tongan Paʻanga', nameBn: 'টোঙ্গান পাআঙ্গা', symbol: 'T$', digits: 2 },
  { code: 'TRY', name: 'Turkish Lira', nameBn: 'তুর্কি লিরা', symbol: '₺', digits: 2 },
  {
    code: 'TTD',
    name: 'Trinidad & Tobago Dollar',
    nameBn: 'ত্রিনিদাদ ডলার',
    symbol: 'TT$',
    digits: 2,
  },
  { code: 'TWD', name: 'New Taiwan Dollar', nameBn: 'তাইওয়ান ডলার', symbol: 'NT$', digits: 2 },
  {
    code: 'TZS',
    name: 'Tanzanian Shilling',
    nameBn: 'তানজানিয়ান শিলিং',
    symbol: 'TSh',
    digits: 2,
  },
  { code: 'UAH', name: 'Ukrainian Hryvnia', nameBn: 'ইউক্রেনীয় রিভনিয়া', symbol: '₴', digits: 2 },
  { code: 'UGX', name: 'Ugandan Shilling', nameBn: 'উগান্ডান শিলিং', symbol: 'USh', digits: 0 },
  { code: 'USD', name: 'US Dollar', nameBn: 'মার্কিন ডলার', symbol: '$', digits: 2 },
  { code: 'UYU', name: 'Uruguayan Peso', nameBn: 'উরুগুয়ান পেসো', symbol: '$U', digits: 2 },
  { code: 'UZS', name: 'Uzbekistani Som', nameBn: 'উজবেক সোম', symbol: "so'm", digits: 2 },
  {
    code: 'VES',
    name: 'Venezuelan Bolívar',
    nameBn: 'ভেনেজুয়েলান বলিভার',
    symbol: 'Bs.',
    digits: 2,
  },
  { code: 'VND', name: 'Vietnamese Dong', nameBn: 'ভিয়েতনামি ডং', symbol: '₫', digits: 0 },
  { code: 'VUV', name: 'Vanuatu Vatu', nameBn: 'ভানুয়াতু ভাতু', symbol: 'VT', digits: 0 },
  { code: 'WST', name: 'Samoan Tala', nameBn: 'সামোয়ান তালা', symbol: 'WS$', digits: 2 },
  {
    code: 'XAF',
    name: 'Central African CFA Franc',
    nameBn: 'মধ্য আফ্রিকান ফ্রাঁ',
    symbol: 'FCFA',
    digits: 0,
  },
  {
    code: 'XCD',
    name: 'East Caribbean Dollar',
    nameBn: 'পূর্ব ক্যারিবীয় ডলার',
    symbol: 'EC$',
    digits: 2,
  },
  {
    code: 'XOF',
    name: 'West African CFA Franc',
    nameBn: 'পশ্চিম আফ্রিকান ফ্রাঁ',
    symbol: 'CFA',
    digits: 0,
  },
  { code: 'XPF', name: 'CFP Franc', nameBn: 'সিএফপি ফ্রাঁ', symbol: '₣', digits: 0 },
  { code: 'YER', name: 'Yemeni Rial', nameBn: 'ইয়েমেনি রিয়াল', symbol: '﷼', digits: 2 },
  {
    code: 'ZAR',
    name: 'South African Rand',
    nameBn: 'দক্ষিণ আফ্রিকান র‍্যান্ড',
    symbol: 'R',
    digits: 2,
  },
  { code: 'ZMW', name: 'Zambian Kwacha', nameBn: 'জাম্বিয়ান কোয়াচা', symbol: 'ZK', digits: 2 },
  { code: 'ZWL', name: 'Zimbabwean Dollar', nameBn: 'জিম্বাবুয়ে ডলার', symbol: 'Z$', digits: 2 },
];

const BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]));

export const DEFAULT_CURRENCY = 'BDT';

/**
 * The currency, or taka.
 *
 * Never throws and never returns undefined. A workspace row carrying a code
 * this build has not heard of — a currency added after it shipped, or a bad
 * migration — must still be able to render its own balances; falling back to a
 * known entry keeps the numbers readable and the *code* is still stored, so
 * nothing is lost. Throwing here would take a whole ledger down over a label.
 */
export function currencyOf(code: string | null | undefined): CurrencyInfo {
  return BY_CODE.get((code ?? '').toUpperCase()) ?? BY_CODE.get(DEFAULT_CURRENCY)!;
}

export function isSupportedCurrency(code: string): boolean {
  return BY_CODE.has(code.toUpperCase());
}

/**
 * How many of the smallest unit make one major unit — 100 for taka, 1 for yen,
 * 1000 for a dinar.
 *
 * This is the number `parseMoneyToMinor` multiplies by and `formatMinor`
 * divides by. Getting it from the currency rather than from a constant is the
 * whole point of this module.
 */
export function minorUnitsFor(code: string | null | undefined): number {
  const { digits } = currencyOf(code);
  return digits === 0 ? 1 : digits === 3 ? 1000 : 100;
}

/** `৳ — বাংলাদেশি টাকা (BDT)`, for a picker. */
export function currencyLabel(info: CurrencyInfo, locale: 'bn' | 'en'): string {
  const name = locale === 'bn' ? info.nameBn : info.name;
  return `${name} (${info.code})`;
}
