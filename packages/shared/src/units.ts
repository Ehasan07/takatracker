/**
 * The units a quantity can be counted in.
 *
 * ## Offered, never enforced
 *
 * `Transaction.quantityUnit` is free text and stays free text. Nothing below is
 * a whitelist: a unit typed straight into the entry sheet saves exactly as it
 * always did. The catalogue is a shortcut, so the common case is a tap instead
 * of switching to a Bengali keyboard and spelling মিলিলিটার.
 *
 * ## Why it is long now, and grouped
 *
 * It started as eight strings behind a `<datalist>`. That element renders
 * nothing at all in Safari on iOS, so on an iPhone — most of this product's
 * traffic — the field was a bare text box and the shortcut did not exist. The
 * replacement is a real `<select>`, and a select is only worth opening if what
 * is inside covers the question: metric for everyday shopping, US and imperial
 * because half the packaging in a Dhaka supermarket is labelled in them, and
 * the Bangladeshi units — মণ, সের, ভরি, কাঠা, বিঘা, শতক — that no international
 * list contains and that a jeweller, a farmer or anybody buying land needs
 * before they need litres.
 *
 * ## Why each unit carries two spellings
 *
 * Reports group by the stored string, so `kg` and `কেজি` are two different
 * units to every sum in the product. Rather than fold them — which would make a
 * report disagree with the rows it added up — each entry knows both spellings
 * and the workspace's own language decides which one is stored. A workspace
 * that switches language mid-year will see both in its report, correctly: those
 * really are two different strings on two sets of rows, and pretending
 * otherwise is how a total ends up wrong.
 *
 * ## Why it lives in shared rather than in the web bundle
 *
 * A workspace can add its own units, and the API refuses one that duplicates a
 * shipped unit. That check has to read the same strings the client shows, or
 * somebody adds `কেজি` to their own list, sees it twice, and the second one is
 * unremovable through the screen that only manages theirs.
 */

export interface CatalogueUnit {
  bn: string;
  en: string;
}

export interface UnitGroup {
  key: 'weight' | 'volume' | 'length' | 'area' | 'count' | 'time' | 'utility';
  bn: string;
  en: string;
  units: readonly CatalogueUnit[];
}

/**
 * Everything the picker offers, grouped the way somebody looks for it.
 *
 * Order inside a group is by how often a household will reach for it, not
 * alphabetically and not by magnitude: কেজি before মিলিগ্রাম, পিস before রিম.
 */
export const UNIT_CATALOGUE: readonly UnitGroup[] = [
  {
    key: 'weight',
    bn: 'ওজন',
    en: 'Weight',
    units: [
      { bn: 'কেজি', en: 'kg' },
      { bn: 'গ্রাম', en: 'g' },
      { bn: 'মিলিগ্রাম', en: 'mg' },
      { bn: 'পাউন্ড', en: 'lb' },
      { bn: 'আউন্স', en: 'oz' },
      { bn: 'টন', en: 'ton' },
      /* The bazaar and the jeweller. মণ is still how rice and jute are bought
         in bulk, and gold is priced in ভরি in every shop in the country. */
      { bn: 'মণ', en: 'maund' },
      { bn: 'সের', en: 'seer' },
      { bn: 'ছটাক', en: 'chhatak' },
      { bn: 'ভরি', en: 'bhori' },
      { bn: 'আনা', en: 'ana' },
      { bn: 'রতি', en: 'roti' },
    ],
  },
  {
    key: 'volume',
    bn: 'আয়তন',
    en: 'Volume',
    units: [
      { bn: 'লিটার', en: 'L' },
      { bn: 'মিলিলিটার', en: 'mL' },
      { bn: 'গ্যালন', en: 'gal' },
      { bn: 'কোয়ার্ট', en: 'qt' },
      { bn: 'পাইন্ট', en: 'pt' },
      { bn: 'ফ্লুইড আউন্স', en: 'fl oz' },
      { bn: 'ব্যারেল', en: 'barrel' },
    ],
  },
  {
    key: 'length',
    bn: 'দৈর্ঘ্য',
    en: 'Length',
    units: [
      { bn: 'মিটার', en: 'm' },
      { bn: 'সেন্টিমিটার', en: 'cm' },
      { bn: 'মিলিমিটার', en: 'mm' },
      { bn: 'কিলোমিটার', en: 'km' },
      { bn: 'ইঞ্চি', en: 'inch' },
      { bn: 'ফুট', en: 'ft' },
      { bn: 'গজ', en: 'yard' },
      { bn: 'মাইল', en: 'mile' },
      { bn: 'হাত', en: 'haat' },
    ],
  },
  {
    key: 'area',
    bn: 'জমি ও ক্ষেত্রফল',
    en: 'Land and area',
    units: [
      { bn: 'বর্গফুট', en: 'sq ft' },
      { bn: 'বর্গমিটার', en: 'sq m' },
      { bn: 'শতক', en: 'decimal' },
      { bn: 'কাঠা', en: 'katha' },
      { bn: 'বিঘা', en: 'bigha' },
      { bn: 'একর', en: 'acre' },
      { bn: 'হেক্টর', en: 'hectare' },
    ],
  },
  {
    key: 'count',
    bn: 'সংখ্যা ও প্যাকেট',
    en: 'Count and packaging',
    units: [
      { bn: 'পিস', en: 'pcs' },
      { bn: 'ডজন', en: 'dozen' },
      /* Four of something. There is no English word for it, and every fish and
         egg purchase in the country is counted this way. */
      { bn: 'হালি', en: 'hali' },
      { bn: 'জোড়া', en: 'pair' },
      { bn: 'সেট', en: 'set' },
      { bn: 'প্যাকেট', en: 'packet' },
      { bn: 'বস্তা', en: 'sack' },
      { bn: 'বাক্স', en: 'box' },
      { bn: 'কার্টন', en: 'carton' },
      { bn: 'বান্ডিল', en: 'bundle' },
      { bn: 'স্ট্রিপ', en: 'strip' },
      { bn: 'পাতা', en: 'sheet' },
      { bn: 'রিম', en: 'ream' },
      { bn: 'বোতল', en: 'bottle' },
    ],
  },
  {
    key: 'time',
    bn: 'সময় ও সেবা',
    en: 'Time and service',
    units: [
      { bn: 'ঘণ্টা', en: 'hour' },
      { bn: 'দিন', en: 'day' },
      { bn: 'মাস', en: 'month' },
      { bn: 'বছর', en: 'year' },
      { bn: 'ট্রিপ', en: 'trip' },
    ],
  },
  {
    key: 'utility',
    bn: 'বিদ্যুৎ ও জ্বালানি',
    en: 'Utilities and fuel',
    units: [
      /* What a DESCO or NESCO bill calls a kilowatt-hour, in the word printed
         on the bill itself. */
      { bn: 'ইউনিট', en: 'unit' },
      { bn: 'কিলোওয়াট-ঘণ্টা', en: 'kWh' },
      { bn: 'ঘনফুট', en: 'cft' },
      { bn: 'ঘনমিটার', en: 'cubic m' },
    ],
  },
] as const;

/**
 * The handful the quantity field puts at the top, before the grouped rest.
 *
 * These are the grocery entries: eight units that cover most of what a
 * household buys by measure. Everything else is one scroll away, which is the
 * right trade when nine entries in ten are one of these.
 */
export const COMMON_QUANTITY_UNITS = [
  'কেজি',
  'গ্রাম',
  'লিটার',
  'পিস',
  'ডজন',
  'হালি',
  'বস্তা',
  'প্যাকেট',
] as const;

/** Every spelling the build ships, in both languages. */
export function shippedUnits(): string[] {
  const out: string[] = [...COMMON_QUANTITY_UNITS];
  for (const group of UNIT_CATALOGUE) {
    for (const unit of group.units) out.push(unit.bn, unit.en);
  }
  return out;
}

/**
 * The eight shortcuts, spelled the workspace's way.
 *
 * `COMMON_QUANTITY_UNITS` is the Bengali spelling because that is what the API
 * has always compared against; this maps each one onto its catalogue entry so
 * an English workspace is offered `kg` rather than কেজি.
 */
export function commonUnits(locale: 'bn' | 'en'): string[] {
  if (locale !== 'en') return [...COMMON_QUANTITY_UNITS];
  const byBengali = new Map<string, string>();
  for (const group of UNIT_CATALOGUE) {
    for (const unit of group.units) byBengali.set(unit.bn, unit.en);
  }
  return COMMON_QUANTITY_UNITS.map((unit) => byBengali.get(unit) ?? unit);
}

/**
 * The catalogue in one language, grouped, for a `<select>`.
 *
 * The eight shortcuts are left out: they are offered above the groups, and the
 * same unit twice in one wheel makes a reader check whether the two are
 * actually different.
 */
export function unitGroups(locale: 'bn' | 'en'): { label: string; units: string[] }[] {
  const shortcuts = new Set<string>(COMMON_QUANTITY_UNITS);
  return UNIT_CATALOGUE.map((group) => ({
    label: locale === 'en' ? group.en : group.bn,
    units: group.units
      .filter((unit) => !shortcuts.has(unit.bn))
      .map((unit) => (locale === 'en' ? unit.en : unit.bn)),
  })).filter((group) => group.units.length > 0);
}

/** As long as `quantityUnit` itself accepts; see `simpleTransactionSchema`. */
export const MAX_UNIT_LENGTH = 20;

/**
 * How many units one workspace may add.
 *
 * Not a storage limit — the whole array is a few hundred bytes. It is a limit on
 * the dropdown: a suggestion list longer than a screen has stopped being a
 * shortcut and become a second thing to search through, which is the problem the
 * free-text field already solves better.
 */
export const MAX_CUSTOM_UNITS = 30;

/**
 * One canonical spelling, for deciding whether two units are the same one.
 *
 * Whitespace and case only. Deliberately *not* transliteration: `kg` and `কেজি`
 * are the same unit to a person and two different strings to every report that
 * groups by unit, and quietly folding them here would make the report disagree
 * with the rows it summed. If somebody wants both spellings to add together,
 * that is a rename of the saved rows, not a display trick.
 */
export function normaliseUnit(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Clean a submitted list: trimmed, de-duplicated, shipped units dropped, capped.
 *
 * Order is preserved, because it is the order the dropdown shows and the person
 * who typed the list chose it.
 */
export function normaliseUnitList(raw: readonly string[]): string[] {
  /* Every shipped spelling in both languages, not just the eight shortcuts.
     Somebody who added মণ before it shipped would otherwise keep a private copy
     of it, see it twice in the picker, and be able to remove only one. */
  const shipped = new Set(shippedUnits().map(normaliseUnit));
  const seen = new Set<string>();
  const out: string[] = [];

  for (const entry of raw) {
    const value = entry.trim().replace(/\s+/g, ' ');
    if (!value || value.length > MAX_UNIT_LENGTH) continue;
    const key = normaliseUnit(value);
    if (shipped.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= MAX_CUSTOM_UNITS) break;
  }

  return out;
}

/** What the quantity field should offer: the shipped eight, then this workspace's. */
export function unitSuggestions(custom: readonly string[] | null | undefined): string[] {
  return [...COMMON_QUANTITY_UNITS, ...normaliseUnitList(custom ?? [])];
}
