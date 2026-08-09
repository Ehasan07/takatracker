import { describe, expect, it } from 'vitest';
import { DEFAULT_CATEGORIES, SYSTEM_ACCOUNT_KEYS } from './categories.js';
import {
  boundedDamerauLevenshtein,
  buildSearchKeys,
  buildStoredSearchKeys,
  FIELD_BONUS,
  foldAny,
  foldLatin,
  foldVariants,
  isBengaliText,
  MAX_ALTS_PER_UNIT,
  MAX_CANDIDATES_PER_TOKEN,
  MAX_LENGTH_PENALTY,
  MAX_TOKENS_BRANCHED,
  maxDistanceFor,
  MIN_QUERY_LENGTH,
  normaliseSearchText,
  prepareQuery,
  probeAmountMinor,
  scoreFor,
  searchDocs,
  searchField,
  searchTokens,
  skeleton,
  storedFoldNeedle,
  TIER_BASE,
  TIER_BUCKET,
  transliterateBengali,
  trimFold,
  type FieldWeight,
  type SearchDoc,
  type SearchTier,
} from './search.js';

/**
 * The whole of §9 of the specification appears below as `it.each`, verbatim by
 * number. It *is* the specification: if the table and the code disagree, one of
 * them is wrong and the disagreement is visible here rather than in a support
 * message six months from now.
 *
 * A handful of rows land on a **higher** tier than the spec predicted, and four
 * land somewhere the spec did not anticipate at all. Each one carries a `why`
 * note saying which and why; they are collected in the report that ships with
 * this file. Nothing below is an expectation written to match the code — every
 * number was derived by hand from §1–§5 first and then checked.
 */

// --- fixtures -----------------------------------------------------------------

interface Row {
  readonly label: string;
}

const field = (
  name: string,
  weight: FieldWeight,
  text: string | null,
): ReturnType<typeof searchField> => searchField(name, weight, text);

/** A picker row: a Bengali name and an English one, both PRIMARY. */
function categoryDoc(nameBn: string, name: string, sortOrder: number): SearchDoc<Row> {
  return {
    id: name,
    row: { label: name },
    order: sortOrder,
    fields: [field('nameBn', 'PRIMARY', nameBn), field('name', 'PRIMARY', name)],
  };
}

/** Exactly the seeded tree, which is what a brand-new workspace searches. */
const categories: readonly SearchDoc<Row>[] = DEFAULT_CATEGORIES.map((c, i) =>
  categoryDoc(c.nameBn, c.name, i),
);

/**
 * The seed plus one row the user added themselves. `খবরের কাগজ` is the
 * over-match §9 #47 is about: `khabar` reaches it, and the band invariant is
 * what guarantees it can never displace `খাবার ও বাজার`.
 */
const categoriesPlusNewspaper: readonly SearchDoc<Row>[] = [
  ...categories,
  categoryDoc('খবরের কাগজ', 'Newspaper', 500),
];

const people: readonly SearchDoc<Row>[] = [
  {
    id: 'p-karim-bn',
    row: { label: 'করিম' },
    order: 0,
    fields: [field('name', 'PRIMARY', 'করিম'), field('phone', 'SECONDARY', null)],
  },
  {
    id: 'p-karim-en',
    row: { label: 'Karim Uddin' },
    order: 1,
    fields: [field('name', 'PRIMARY', 'Karim Uddin'), field('phone', 'SECONDARY', '01712345678')],
  },
  {
    // The row §9 #51 says `sud` must not reach.
    id: 'p-sada',
    row: { label: 'সাদা' },
    order: 2,
    fields: [field('name', 'PRIMARY', 'সাদা')],
  },
];

/**
 * `আয়` (SYSTEM_INCOME) is deliberately **absent**: scope is applied before any
 * key is built, exactly as `requireCashAccount` already enforces. See the
 * separate scope tests for the proof that this is the caller's job.
 */
const accounts: readonly SearchDoc<Row>[] = [
  { id: 'a-nagad', row: { label: 'নগদ' }, order: 0, fields: [field('name', 'PRIMARY', 'নগদ')] },
  { id: 'a-bkash', row: { label: 'bKash' }, order: 1, fields: [field('name', 'PRIMARY', 'bKash')] },
];

/** ৳5,000.00 and ৳5,000.50 — fifty poisha apart, which is the point of #55. */
const loans: readonly SearchDoc<Row>[] = [
  {
    id: 'L-0001',
    row: { label: 'L-0001' },
    order: 0,
    fields: [
      field('loanNumber', 'SECONDARY', 'L-0001'),
      field('person.name', 'PRIMARY', 'করিম'),
      field('person.phone', 'SECONDARY', '01712345678'),
      field('note', 'FREE', null),
      field('account.name', 'FREE', 'bKash'),
    ],
    amounts: [{ name: 'principalMinor', weight: 'SECONDARY', minor: 500_000 }],
  },
  {
    id: 'L-0002',
    row: { label: 'L-0002' },
    order: 1,
    fields: [
      field('loanNumber', 'SECONDARY', 'L-0002'),
      field('person.name', 'PRIMARY', 'Karim Uddin'),
      field('person.phone', 'SECONDARY', '01712345678'),
      field('note', 'FREE', 'অফিসের টাকা, ফেরত দেবে'),
      field('account.name', 'FREE', 'নগদ'),
    ],
    amounts: [{ name: 'principalMinor', weight: 'SECONDARY', minor: 500_050 }],
  },
];

const transactions: readonly SearchDoc<Row>[] = [
  {
    id: 't-recharge',
    row: { label: 'মোবাইল রিচার্জ' },
    order: 0,
    fields: [field('description', 'PRIMARY', 'মোবাইল রিচার্জ')],
  },
  {
    id: 't-rent',
    row: { label: 'Rent — করিম' },
    order: 1,
    fields: [field('description', 'FREE', 'Rent — March'), field('payee', 'PRIMARY', 'করিম')],
  },
];

const FIXTURES = {
  categories,
  categoriesPlusNewspaper,
  people,
  accounts,
  loans,
  transactions,
} as const;

type FixtureName = keyof typeof FIXTURES;

// --- helpers ------------------------------------------------------------------

function labels(docs: readonly SearchDoc<Row>[], q: string): string[] {
  return searchDocs(docs, q).hits.map((h) => h.row.label);
}

function suggestionLabels(docs: readonly SearchDoc<Row>[], q: string): string[] {
  return searchDocs(docs, q).suggestions.map((h) => h.row.label);
}

function hitFor(docs: readonly SearchDoc<Row>[], q: string, label: string) {
  const result = searchDocs(docs, q);
  return (
    result.hits.find((h) => h.row.label === label) ??
    result.suggestions.find((h) => h.row.label === label) ??
    null
  );
}

// --- §1 normalisation ----------------------------------------------------------

describe('normaliseSearchText — §1', () => {
  it('turns punctuation into a space, which is the whole rule', () => {
    // The pair that makes #18 and #19 the same query.
    expect(normaliseSearchText('মোবাইল/ইন্টারনেট')).toBe('মোবাইল ইন্টারনেট');
    expect(normaliseSearchText('মোবাইল ইন্টারনেট')).toBe('মোবাইল ইন্টারনেট');

    expect(normaliseSearchText('Food & groceries')).toBe('food groceries');
    expect(normaliseSearchText('মুনাফা/সুদ')).toBe('মুনাফা সুদ');
    expect(normaliseSearchText('L-0001')).toBe('l 0001');
    expect(normaliseSearchText('A/C No.')).toBe('a c no');
    expect(normaliseSearchText('  দান  /  যাকাত  ')).toBe('দান যাকাত');
  });

  it('maps every digit system to ASCII, so ৫০০০ and 5000 are one query', () => {
    expect(normaliseSearchText('৫০০০')).toBe('5000');
    expect(normaliseSearchText('٥٠٠٠')).toBe('5000'); // Arabic-Indic
    expect(normaliseSearchText('۵۰۰۰')).toBe('5000'); // Extended Arabic-Indic
    expect(normaliseSearchText('৫,০০০')).toBe('5 000'); // the comma became a break
  });

  it('case-folds without a locale, so two devices agree', () => {
    // toLocaleLowerCase under tr-TR maps I to ı; this must not.
    expect(normaliseSearchText('BILL')).toBe('bill');
    expect(normaliseSearchText('bKash')).toBe('bkash');
  });

  it('keeps letters, marks and digits — including the hasanta', () => {
    const withHasanta = normaliseSearchText('স্বাস্থ্য');
    expect(withHasanta).toContain('্');
    expect(withHasanta).toBe('স্বাস্থ্য');
  });

  it('strips the invisibles the three Bengali keyboards disagree about', () => {
    const zwnj = 'ইন‍্‌টারনেট';
    expect(normaliseSearchText(zwnj)).toBe(normaliseSearchText('ইন্টারনেট'));
    expect(normaliseSearchText('﻿খাবার​')).toBe('খাবার');
  });

  it('unifies the two byte sequences a Bengali keyboard can produce (NFC)', () => {
    const composed = 'মো'; // ম + U+09CB
    const decomposed = 'মো'; // ম + U+09C7 + U+09BE
    expect(composed).not.toBe(decomposed); // genuinely different input
    expect(normaliseSearchText(composed)).toBe(normaliseSearchText(decomposed));
    expect(buildSearchKeys(composed).b1Text).toBe(buildSearchKeys(decomposed).b1Text);
  });

  it('is idempotent for every fixture string', () => {
    const strings = [
      ...DEFAULT_CATEGORIES.flatMap((c) => [c.nameBn, c.name]),
      'L-0001',
      'A/C No.',
      '০১৭১২৩৪৫৬৭৮',
      'Rent — March',
      'মোবাইল/ইন্টারনেট',
      'স্বাস্থ্য',
      'ভাড়া',
      '',
      '   ',
      '...',
    ];
    for (const s of strings) {
      const once = normaliseSearchText(s);
      expect(normaliseSearchText(once)).toBe(once);
    }
  });

  it('treats a punctuation-only query as no query, not as a query matching nothing', () => {
    expect(normaliseSearchText('...')).toBe('');
    expect(searchTokens('...')).toEqual([]);
    expect(searchTokens('')).toEqual([]);
  });
});

// --- §3 the fold ----------------------------------------------------------------

describe('foldLatin / trimFold / skeleton — the worked table of §3', () => {
  const table: ReadonlyArray<[string, string, string, string]> = [
    // input        b1            b2            skel
    ['khabar', 'kabar', 'kabar', 'kbr'],
    ['khaabaar', 'kabar', 'kabar', 'kbr'],
    ['khabor', 'kabar', 'kabar', 'kbr'],
    ['beton', 'batan', 'batan', 'btn'],
    ['betan', 'batan', 'batan', 'btn'],
    ['bethon', 'batan', 'batan', 'btn'],
    // §3 printed `bas bar` in the b1 column for these two; that is their b2.
    // b1 must keep the trailing vowel or §9 #48 and #51 could not hold.
    ['basha vara', 'basa bara', 'bas bar', 'bs br'],
    ['basa bhara', 'basa bara', 'bas bar', 'bs br'],
    ['mobile', 'mabala', 'mabal', 'mbl'],
    ['mobail', 'mabal', 'mabal', 'mbl'],
    ['utility', 'atalat', 'atalat', 'tlt'],
    ['iutiliti', 'atalata', 'atalat', 'tlt'], // §3 printed the b2 here too
    ['freelance', 'pralansa', 'pralans', 'prlns'],
    ['frilanse', 'pralansa', 'pralans', 'prlns'],
    ['bkash', 'bkas', 'bkas', 'bks'],
    ['bikash', 'bakas', 'bakas', 'bks'],
    ['l 0001', 'l 0001', 'l 0001', 'l 0001'],
  ];

  it.each(table)('%s folds to %s / %s / %s', (input, b1, b2, skel) => {
    expect(foldLatin(input)).toBe(b1);
    expect(trimFold(foldLatin(input))).toBe(b2);
    expect(skeleton(foldLatin(input))).toBe(skel);
  });

  it('collapses the ambiguity classes the candidate set enumerates', () => {
    // Every consonant alternative in §2.4 has to fold to one thing, or the
    // candidate set would be carrying recall instead of ranking.
    expect(foldLatin('bh')).toBe(foldLatin('v'));
    expect(foldLatin('sh')).toBe(foldLatin('s'));
    expect(foldLatin('z')).toBe(foldLatin('j'));
    expect(foldLatin('ph')).toBe(foldLatin('f'));
    expect(foldLatin('kh')).toBe(foldLatin('k'));
    expect(foldLatin('chh')).toBe(foldLatin('ch'));
  });

  it('makes ya-phala and the য় glide agree, which is one rule doing two jobs', () => {
    expect(foldLatin('jatayat')).toBe(foldLatin('jatajat')); // y after a vowel is j
    expect(foldLatin('byabsa')).toBe(foldLatin('bebsa')); // y after a consonant is nothing
  });

  it('exempts digits at every step', () => {
    expect(foldLatin('0001')).toBe('0001');
    expect(trimFold('0001')).toBe('0001');
    expect(skeleton('0001')).toBe('0001');

    // All four zeros survive — without the exemption this is `l 01` and every
    // loan number ending in a repeated digit becomes a different loan.
    const key = foldLatin(normaliseSearchText('L-0001'));
    expect(key).toBe('l 0001');
    expect(key.split(' ')[1]).toHaveLength(4);
    expect(foldLatin(normaliseSearchText('L-1100'))).toBe('l 1100');
  });

  it('never empties a token at b2', () => {
    expect(trimFold('a')).toBe('a');
    expect(trimFold('ba')).toBe('b');
  });

  it('is defined only on Latin text — foldAny is what crosses scripts', () => {
    expect(foldLatin('খাবার')).toBe('খাবার'); // untouched, as documented
    expect(foldAny('খাবার')).toBe('kabar');
    expect(foldAny('khabar')).toBe('kabar');
  });
});

// --- §2 transliteration ----------------------------------------------------------

describe('transliterateBengali — §2', () => {
  it('offers the primary spelling first, and it is the one a person would write', () => {
    const primary = (w: string): string => transliterateBengali(w)[0] as string;
    expect(primary('খাবার')).toBe('khabar');
    expect(primary('বাজার')).toBe('bajar');
    expect(primary('বেতন')).toBe('beton');
    expect(primary('বাসা')).toBe('basa');
    expect(primary('ভাড়া')).toBe('bhara');
    expect(primary('বাড়ি')).toBe('bari');
    expect(primary('করিম')).toBe('korim');
    expect(primary('যাতায়াত')).toBe('jatayat');
    expect(primary('যাকাত')).toBe('jakat');
    expect(primary('সুদ')).toBe('sud');
    expect(primary('মুনাফা')).toBe('munafa');
    expect(primary('অন্যান্য')).toBe('onnanno');
    expect(primary('ব্যবসা')).toBe('bebosa');
    expect(primary('শিক্ষা')).toBe('shikkha');
    expect(primary('স্বাস্থ্য')).toBe('sastho');
    expect(primary('মোবাইল')).toBe('mobail');
    expect(primary('পোশাক')).toBe('poshak');
    expect(primary('মন')).toBe('mon'); // §2.6: word-final inherent vowel unwritten
  });

  it('carries the alternatives real people actually type', () => {
    expect(transliterateBengali('বাসা')).toContain('basha'); // স → sh
    expect(transliterateBengali('ভাড়া')).toContain('vara'); // ভ → v, ড় → r
    expect(transliterateBengali('বাজার')).toContain('bazar'); // জ → z
    expect(transliterateBengali('বেতন')).toContain('betan'); // ে → a
    expect(transliterateBengali('মুনাফা')).toContain('munapha'); // ফ → ph
    expect(transliterateBengali('স্বাস্থ্য')).toContain('shastho'); // শ/স interchange
    expect(transliterateBengali('শিক্ষা')).toContain('shiksha'); // ক্ষ → ksh
    expect(transliterateBengali('ব্যবসা')).toContain('bebsa'); // elided medial vowel
    expect(transliterateBengali('করিম')).toContain('karim'); // medial inherent → a
  });

  it('spells the clusters that are not the sum of their parts (§2.5)', () => {
    // Without the cluster table `শিক্ষা` never reaches `shikkha` at any rung:
    // b1 gives `saks` against `sak` and even skel gives `sks` against `sk`.
    expect(transliterateBengali('শিক্ষা')[0]).toBe('shikkha');
    // ba-phala silent by default, word-final ya-phala → o.
    expect(transliterateBengali('স্বাস্থ্য')).toContain('shastho');
    // ন্য final → nno.
    expect(transliterateBengali('অন্যান্য')[0]).toBe('onnanno');
  });

  it('reads reph, ra-phala and the nukta letters', () => {
    expect(transliterateBengali('রিচার্জ')[0]).toBe('richarj'); // reph before জ
    expect(transliterateBengali('ফ্রিল্যান্স')[0]).toBe('frilans'); // ra-phala
    // base+nukta and the precomposed letter are the same unit, which NFC alone
    // cannot do because these three are composition-excluded.
    expect(transliterateBengali('ভাড়া')).toEqual(transliterateBengali('ভাড়া'));
  });

  it('passes Latin through untouched, in either direction', () => {
    expect(transliterateBengali('bkash')).toEqual(['bkash']);
    expect(isBengaliText('bkash')).toBe(false);
    expect(isBengaliText('bKashএ')).toBe(true);
    // A mixed token keeps its Latin run verbatim.
    expect(transliterateBengali('bKashএ')[0]).toBe('bKashe'); // এ is the locative -e
  });

  it('respects every cap in §2.2', () => {
    // One unit never offers more than three spellings.
    expect(transliterateBengali('খা').length).toBeLessThanOrEqual(MAX_ALTS_PER_UNIT);
    expect(transliterateBengali('খা')).toEqual(['kha', 'ka', 'khaa']);

    // A token never offers more than 24.
    for (const word of DEFAULT_CATEGORIES.flatMap((c) => c.nameBn.split(/[\s/]/))) {
      expect(transliterateBengali(word).length).toBeLessThanOrEqual(MAX_CANDIDATES_PER_TOKEN);
    }
    expect(transliterateBengali('ব্যবসা')).toHaveLength(MAX_CANDIDATES_PER_TOKEN);

    // Past the eighth unit a long word stops branching: every candidate shares
    // the primary tail, so truncation can never lose the likely spellings.
    const nine = 'করিমকরিমকরিম'; // ক রি ম ক রি ম ক রি ম = 9 units
    const candidates = transliterateBengali(nine);
    expect(candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES_PER_TOKEN);
    expect(candidates.every((c) => c.endsWith('m'))).toBe(true);

    // Tokens four and later of a long name use primaries only.
    const keys = buildSearchKeys('বেতন বেতন বেতন বেতন বেতন');
    expect(keys.latin[MAX_TOKENS_BRANCHED - 1]?.length).toBeGreaterThan(1);
    expect(keys.latin[MAX_TOKENS_BRANCHED]).toHaveLength(1);
    expect(keys.latin[MAX_TOKENS_BRANCHED]?.[0]).toBe('beton');
  });

  it('is deterministic — same input, same array, every time', () => {
    for (const word of ['ব্যবসা', 'ইন্টারনেট', 'স্বাস্থ্য', 'খাবার', 'অন্যান্য']) {
      const a = transliterateBengali(word);
      const b = transliterateBengali(word);
      expect(a).toEqual(b);
      expect(a[0]).toBe(b[0]); // the primary is stable, which is what ranks
      expect(new Set(a).size).toBe(a.length); // and no duplicates
    }
  });

  it('truncates stably: a smaller cap is a prefix of a larger one', () => {
    const full = transliterateBengali('ব্যবসা', MAX_CANDIDATES_PER_TOKEN);
    for (const cap of [1, 2, 3, 8, 12]) {
      expect(transliterateBengali('ব্যবসা', cap)).toEqual(full.slice(0, cap));
    }
  });
});

/**
 * The fold invariant of §2.2, stated as the tables actually behave.
 *
 * The spec claims every candidate of a Bengali token folds to one string, with
 * two vowel-elision alternatives excepted. Run against the seeded tree that is
 * *nearly* true and the exceptions are worth naming, because each one is a
 * different rung of the ladder doing its job:
 *
 *  - the **written vs unwritten word-final inherent vowel** (`khabar`/`khabaro`)
 *    splits at `b1` and is reunited at `b2`. Not an exception at all — it is
 *    what `b2` is for.
 *  - the **omitted medial inherent vowel** (`beton`/`betn`) survives to `b2` and
 *    is reunited at `skel`. This is the first documented exception.
 *  - the **silent alternatives** — `য়` → `` and the silent ba-phala — behave the
 *    same way and are the second.
 *  - a **cluster or sign with two genuinely different spoken forms** (`ক্ষ` =
 *    `kkh`/`ksh`, `ং` = `ng`/`n`, `প` after an elided vowel absorbing an `h`)
 *    no rung can reunite, and none has to: both spellings are *in the candidate
 *    set*, so both reach the row at T-exact, which is a better tier than any
 *    fold would have given.
 *
 * The list below is exhaustive and checked. If a table changes, this test tells
 * you which word changed class.
 */
describe('the fold invariant — §2.2', () => {
  /** Tokens whose candidates do not all agree at `b2`, and why. */
  const B2_SPLITS: Readonly<Record<string, string>> = {
    বেতন: 'omitted medial inherent vowel: beton / betn',
    ব্যবসা: 'omitted medial inherent vowel: bebosa / bebsa',
    উপহার: 'omitted medial inherent vowel: upohar / uphar (the h is then absorbed)',
    ইন্টারনেট: 'omitted medial inherent vowel: intaronet / intarnet',
    পরিবার: 'omitted medial inherent vowel: poribar / pribar',
    মেরামত: 'omitted medial inherent vowel: meramot / meramt',
    বিনোদন: 'omitted medial inherent vowel: binodon / binodn',
    যাতায়াত: 'silent য়: jatayat / jataat',
    সহায়তা: 'silent য়: sohayota / sohaota',
    শিক্ষা: 'ক্ষ is genuinely kkh or ksh; the candidate set carries both at T-exact',
    ব্যাংক: 'ং is genuinely ng or n; the candidate set carries both at T-exact',
  };

  const seededTokens = [
    ...new Set(DEFAULT_CATEGORIES.flatMap((c) => normaliseSearchText(c.nameBn).split(' '))),
  ];

  it.each(seededTokens)('%s folds to one b2 unless it is a documented exception', (token) => {
    const folds = new Set(transliterateBengali(token).map((c) => trimFold(foldLatin(c))));
    if (B2_SPLITS[token] === undefined) {
      expect(folds.size, `${token} → ${[...folds].join(', ')}`).toBe(1);
    } else {
      expect(folds.size, `${token}: ${B2_SPLITS[token]}`).toBeGreaterThan(1);
    }
  });

  it('names no exception that is not real', () => {
    for (const token of Object.keys(B2_SPLITS)) {
      expect(seededTokens, `${token} is not in the seeded tree any more`).toContain(token);
    }
  });

  it('reunites the elided-vowel exceptions at skel, which is why that rung exists', () => {
    for (const token of ['বেতন', 'ব্যবসা', 'ইন্টারনেট', 'পরিবার', 'মেরামত', 'বিনোদন']) {
      const skels = new Set(transliterateBengali(token).map((c) => skeleton(foldLatin(c))));
      expect(skels.size, `${token} → ${[...skels].join(', ')}`).toBe(1);
    }
  });

  it('keeps foldVariants small — this is a handful of short strings per token', () => {
    for (const token of seededTokens) {
      expect(foldVariants(token).length).toBeLessThanOrEqual(4);
    }
  });
});

// --- §5 scoring -------------------------------------------------------------------

describe('the band invariant — §5.1', () => {
  const MAIN: readonly SearchTier[] = [
    'A_EXACT',
    'A_PREFIX',
    'A_BOUNDARY',
    'A_SUBSTR',
    'T_EXACT',
    'T_PREFIX',
    'B1_EXACT',
    'B1_PREFIX',
    'B1_SUBSTR',
    'B2_EXACT',
    'B2_PREFIX',
  ];

  const weights: readonly FieldWeight[] = ['PRIMARY', 'SECONDARY', 'FREE'];

  /** Every score a tier can possibly take, over the whole bonus/penalty range. */
  function range(tier: SearchTier): { min: number; max: number } {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const weight of weights) {
      for (let slack = 0; slack <= 200; slack += 1) {
        const score = scoreFor(tier, weight, slack, 0);
        if (score < min) min = score;
        if (score > max) max = score;
      }
    }
    return { min, max };
  }

  it('gives a lower tier no way to outrank a higher one', () => {
    for (let i = 0; i < MAIN.length - 1; i += 1) {
      const higher = MAIN[i] as SearchTier;
      const lower = MAIN[i + 1] as SearchTier;
      expect(range(higher).min, `${higher} vs ${lower}`).toBeGreaterThan(range(lower).max);
    }
  });

  it('leaves the arithmetic room it claims: +40 and −49 span 89, bands are 100', () => {
    expect(Math.max(...Object.values(FIELD_BONUS))).toBe(40);
    expect(MAX_LENGTH_PENALTY).toBe(49);
    expect(Math.max(...Object.values(FIELD_BONUS)) + MAX_LENGTH_PENALTY).toBeLessThan(100);
    for (let i = 0; i < MAIN.length - 1; i += 1) {
      const gap = TIER_BASE[MAIN[i] as SearchTier] - TIER_BASE[MAIN[i + 1] as SearchTier];
      expect(gap).toBe(100);
    }
  });

  it('keeps the suggestions bucket entirely below the main results', () => {
    // The suggestion tiers are only 10 points apart, so they can and do reorder
    // among themselves once the field bonus is applied. What must hold — and
    // what §5.1 actually asks for — is that no suggestion can ever interleave
    // with a real match.
    const worstMain = range('B2_PREFIX').min;
    const bestSuggestion = Math.max(
      range('C_EXACT').max,
      range('C_PREFIX').max,
      scoreFor('D_FUZZY', 'PRIMARY', 0, 0, 0),
    );
    expect(worstMain).toBeGreaterThan(bestSuggestion);
    expect(worstMain).toBe(151);
    expect(bestSuggestion).toBe(140);
  });

  it('charges nothing for an exact match and caps the penalty at 49', () => {
    expect(scoreFor('A_EXACT', 'PRIMARY', 400, 3)).toBe(1240);
    expect(scoreFor('A_PREFIX', 'PRIMARY', 6, 6)).toBe(1140);
    expect(scoreFor('A_PREFIX', 'PRIMARY', 400, 3)).toBe(1100 + 40 - MAX_LENGTH_PENALTY);
    // §5.3, traced by hand: b1('kabar') prefixes b1('kabarar'), 7 − 5 = 2.
    expect(scoreFor('B1_PREFIX', 'PRIMARY', 7, 5)).toBe(538);
  });

  it('prices a typo by how wrong it is', () => {
    expect(scoreFor('D_FUZZY', 'FREE', 0, 0, 0)).toBe(80);
    expect(scoreFor('D_FUZZY', 'FREE', 0, 0, 1)).toBe(70);
    expect(scoreFor('D_FUZZY', 'FREE', 0, 0, 2)).toBe(60);
  });

  it('agrees with itself about which bucket each tier is in', () => {
    for (const tier of MAIN) expect(TIER_BUCKET[tier]).toBe('main');
    for (const tier of ['C_EXACT', 'C_PREFIX', 'D_FUZZY'] as const) {
      expect(TIER_BUCKET[tier]).toBe('suggestion');
    }
  });
});

describe('boundedDamerauLevenshtein', () => {
  it('counts the four edits', () => {
    expect(boundedDamerauLevenshtein('karam', 'karam', 2)).toBe(0);
    expect(boundedDamerauLevenshtein('karam', 'karan', 2)).toBe(1); // substitution
    expect(boundedDamerauLevenshtein('karam', 'karm', 2)).toBe(1); // deletion
    expect(boundedDamerauLevenshtein('karm', 'karam', 2)).toBe(1); // insertion
    expect(boundedDamerauLevenshtein('karam', 'karma', 2)).toBe(1); // transposition
  });

  it('gives up rather than finish, once the budget is gone', () => {
    // Anything over budget reports budget + 1: the caller only ever asks
    // "is this within tolerance", never "how far away exactly".
    expect(boundedDamerauLevenshtein('batan', 'banadan', 1)).toBe(2);
    expect(boundedDamerauLevenshtein('a', 'zzzzzzzzzz', 2)).toBe(3);
    expect(boundedDamerauLevenshtein('', 'abc', 5)).toBe(3);
  });

  it('scales the tolerance to how much was typed', () => {
    expect(maxDistanceFor(2)).toBe(0);
    expect(maxDistanceFor(3)).toBe(0); // no fuzzy at all below four
    expect(maxDistanceFor(4)).toBe(1);
    expect(maxDistanceFor(6)).toBe(1);
    expect(maxDistanceFor(7)).toBe(2);
  });
});

// --- §9 the worked examples --------------------------------------------------------

type Expectation =
  | { readonly kind: 'hit'; readonly label: string; readonly tier: SearchTier }
  | { readonly kind: 'first'; readonly label: string; readonly tier: SearchTier }
  | { readonly kind: 'suggestion'; readonly label: string; readonly tier: SearchTier }
  | { readonly kind: 'miss'; readonly label: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'unfiltered' };

interface Worked extends Record<string, unknown> {
  readonly n: number;
  readonly typed: string;
  readonly where: FixtureName;
  readonly expect: Expectation;
  /** Why, in the spec's words, plus any deviation from what it predicted. */
  readonly why: string;
}

const WORKED: readonly Worked[] = [
  {
    n: 1,
    typed: 'খাবার ও বাজার',
    where: 'categories',
    expect: { kind: 'first', label: 'Food & groceries', tier: 'A_EXACT' },
    why: 'identical after norm',
  },
  {
    n: 2,
    typed: 'খাবার',
    where: 'categories',
    expect: { kind: 'first', label: 'Food & groceries', tier: 'A_PREFIX' },
    why: 'first token of nameBn',
  },
  {
    n: 3,
    typed: 'বাজার',
    where: 'categories',
    expect: { kind: 'first', label: 'Food & groceries', tier: 'A_BOUNDARY' },
    why: 'second token of nameBn',
  },
  {
    n: 4,
    typed: 'Food',
    where: 'categories',
    expect: { kind: 'first', label: 'Food & groceries', tier: 'A_PREFIX' },
    why: 'English column',
  },
  {
    n: 5,
    typed: 'groceries',
    where: 'categories',
    expect: { kind: 'first', label: 'Food & groceries', tier: 'A_BOUNDARY' },
    why: 'the & became a space, so groceries starts a token',
  },
  {
    n: 6,
    typed: 'khabar',
    where: 'categories',
    expect: { kind: 'first', label: 'Food & groceries', tier: 'T_EXACT' },
    why: 'primary transliteration of খাবার — 800 + 40 = 840',
  },
  {
    n: 7,
    typed: 'khabor',
    where: 'categories',
    expect: { kind: 'first', label: 'Food & groceries', tier: 'B1_EXACT' },
    why: 'o is not a candidate for া, but both fold to kabar',
  },
  {
    n: 8,
    typed: 'khaabaar',
    where: 'categories',
    expect: { kind: 'first', label: 'Food & groceries', tier: 'T_EXACT' },
    why: 'spec said B1-exact; khaabaar is inside the candidate set, so T-exact — a higher tier',
  },
  {
    n: 9,
    typed: 'bajar',
    where: 'categories',
    expect: { kind: 'first', label: 'Food & groceries', tier: 'T_EXACT' },
    why: 'candidate of token 2',
  },
  {
    n: 10,
    typed: 'bazar',
    where: 'categories',
    expect: { kind: 'first', label: 'Food & groceries', tier: 'T_EXACT' },
    why: 'জ → z alternative',
  },
  {
    n: 11,
    typed: 'bazaar',
    where: 'categories',
    expect: { kind: 'first', label: 'Food & groceries', tier: 'B1_EXACT' },
    why: 'zaa falls outside the cap, so the fold catches it — both fold to bajar',
  },
  {
    n: 12,
    typed: 'beton',
    where: 'categories',
    expect: { kind: 'first', label: 'Salary', tier: 'T_EXACT' },
    why: 'primary: ে → e, medial inherent → o',
  },
  {
    n: 13,
    typed: 'betan',
    where: 'categories',
    expect: { kind: 'first', label: 'Salary', tier: 'T_EXACT' },
    why: 'ে → a alternative',
  },
  {
    n: 14,
    typed: 'bethon',
    where: 'categories',
    expect: { kind: 'first', label: 'Salary', tier: 'B1_EXACT' },
    why: 'th → t, both fold to batan',
  },
  {
    n: 15,
    typed: 'basha vara',
    where: 'categories',
    expect: { kind: 'first', label: 'House rent', tier: 'T_EXACT' },
    why: 'স → sh, ভ → v, ড় → r; AND across both tokens',
  },
  {
    n: 16,
    typed: 'basa bhara',
    where: 'categories',
    expect: { kind: 'first', label: 'House rent', tier: 'T_EXACT' },
    why: 'the other spelling of the same two units',
  },
  {
    n: 17,
    typed: 'bari vara',
    where: 'categories',
    expect: { kind: 'first', label: 'Rental income', tier: 'T_EXACT' },
    why: 'bari misses বাসা — but not ভাড়া, which both rows share; see the deviation test',
  },
  {
    n: 18,
    typed: 'মোবাইল/ইন্টারনেট',
    where: 'categories',
    expect: { kind: 'first', label: 'Mobile & internet', tier: 'A_EXACT' },
    why: 'the slash became a space',
  },
  {
    n: 19,
    typed: 'মোবাইল ইন্টারনেট',
    where: 'categories',
    expect: { kind: 'first', label: 'Mobile & internet', tier: 'A_EXACT' },
    why: 'the punctuation rule: #18 and #19 are the same query',
  },
  {
    n: 20,
    typed: 'mobile',
    where: 'categories',
    expect: { kind: 'first', label: 'Mobile & internet', tier: 'A_PREFIX' },
    why: 'the English column wins outright',
  },
  {
    n: 21,
    typed: 'mobile',
    where: 'transactions',
    expect: { kind: 'first', label: 'মোবাইল রিচার্জ', tier: 'B1_EXACT' },
    why: 'spec said B2-exact; keeping every fold variant puts mabala in the b1 set, so B1-exact',
  },
  {
    n: 22,
    typed: 'intarnet',
    where: 'categories',
    expect: { kind: 'first', label: 'Mobile & internet', tier: 'T_EXACT' },
    why: 'spec said B1-exact; intarnet is inside the candidate set, so T-exact',
  },
  {
    n: 23,
    typed: 'utility',
    where: 'categories',
    expect: { kind: 'first', label: 'Utilities', tier: 'B1_PREFIX' },
    why: 'spec said A-prefix, but "utilities" does not start with "utility" — the Bengali side carries it',
  },
  {
    n: 24,
    typed: 'jatayat',
    where: 'categories',
    expect: { kind: 'first', label: 'Transport', tier: 'T_EXACT' },
    why: 'য় → y',
  },
  {
    n: 25,
    typed: 'zatayat',
    where: 'categories',
    expect: { kind: 'first', label: 'Transport', tier: 'T_EXACT' },
    why: 'spec said B1-exact; য → z is a candidate, so T-exact',
  },
  {
    n: 26,
    typed: 'shastho',
    where: 'categories',
    expect: { kind: 'first', label: 'Health', tier: 'T_EXACT' },
    why: 'ba-phala silent, word-final ya-phala → o',
  },
  {
    n: 27,
    typed: 'sastho',
    where: 'categories',
    expect: { kind: 'first', label: 'Health', tier: 'T_EXACT' },
    why: 'শ/স are interchangeable in the table',
  },
  {
    n: 28,
    typed: 'shikkha',
    where: 'categories',
    expect: { kind: 'first', label: 'Education', tier: 'T_EXACT' },
    why: 'requires the ক্ষ → kkh cluster; misses at B1 (sak vs saks) and C (sk vs sks)',
  },
  {
    n: 29,
    typed: 'bebsa',
    where: 'categories',
    expect: { kind: 'first', label: 'Business', tier: 'T_EXACT' },
    why: 'ব্য → be cluster plus the elided medial inherent vowel',
  },
  {
    n: 30,
    typed: 'byabsa',
    where: 'categories',
    expect: { kind: 'first', label: 'Business', tier: 'T_EXACT' },
    why: 'spec said B1-exact; byabsa is itself a candidate of ব্যবসা, so T-exact',
  },
  {
    n: 31,
    typed: 'jakat',
    where: 'categories',
    expect: { kind: 'first', label: 'Charity / zakat', tier: 'T_EXACT' },
    why: 'য → j primary',
  },
  {
    n: 32,
    typed: 'zakat',
    where: 'categories',
    expect: { kind: 'first', label: 'Charity / zakat', tier: 'A_BOUNDARY' },
    why: 'spec said A-substr; zakat starts the second token of the English name, so A-boundary. A wins over T either way',
  },
  {
    n: 33,
    typed: 'sud',
    where: 'categories',
    expect: { kind: 'first', label: 'Profit / interest', tier: 'T_EXACT' },
    why: 'the slash split gives সুদ as its own token',
  },
  {
    n: 34,
    typed: 'munapha',
    where: 'categories',
    expect: { kind: 'first', label: 'Profit / interest', tier: 'T_EXACT' },
    why: 'spec said B1-exact; ফ → ph is a candidate, so T-exact',
  },
  {
    n: 35,
    typed: 'onnanno',
    where: 'categories',
    expect: { kind: 'first', label: 'Other income', tier: 'T_EXACT' },
    why: 'two legitimate hits, ordered by the caller’s kind filter then sortOrder',
  },
  {
    n: 36,
    typed: 'karim',
    where: 'people',
    expect: { kind: 'first', label: 'Karim Uddin', tier: 'A_PREFIX' },
    why: 'A-prefix 1140 outranks করিম',
  },
  {
    n: 37,
    typed: 'korim',
    where: 'people',
    expect: { kind: 'first', label: 'করিম', tier: 'T_EXACT' },
    why: 'the primary transliteration (medial inherent → o)',
  },
  {
    n: 38,
    typed: 'করিম',
    where: 'people',
    expect: { kind: 'hit', label: 'Karim Uddin', tier: 'T_EXACT' },
    why: 'reverse direction — the query is transliterated. Spec said B1-exact; karim is a candidate of করিম, so T-exact',
  },
  {
    n: 39,
    typed: 'krim',
    where: 'people',
    expect: { kind: 'suggestion', label: 'করিম', tier: 'C_EXACT' },
    why: 'omitted vowel: krm = krm, three consonants passes the gate',
  },
  {
    n: 40,
    typed: 'korin',
    where: 'people',
    expect: { kind: 'suggestion', label: 'করিম', tier: 'D_FUZZY' },
    why: 'one substitution: karan vs karam; skel differs so C cannot catch it',
  },
  {
    n: 41,
    typed: 'bikash',
    where: 'accounts',
    expect: { kind: 'suggestion', label: 'bKash', tier: 'C_EXACT' },
    why: 'bakas vs bkas at B1; bks = bks at C',
  },
  {
    n: 42,
    typed: 'intrnet',
    where: 'categories',
    expect: { kind: 'suggestion', label: 'Mobile & internet', tier: 'C_EXACT' },
    why: 'dropped vowel: ntrnt = ntrnt',
  },
  {
    n: 43,
    typed: '০১৭১২',
    where: 'people',
    expect: { kind: 'first', label: 'Karim Uddin', tier: 'A_PREFIX' },
    why: 'toAsciiDigits in step 2 of norm',
  },
  {
    n: 44,
    typed: '৫,০০০',
    where: 'loans',
    expect: { kind: 'first', label: 'L-0001', tier: 'A_EXACT' },
    why: 'parseMoneyToMinor on the raw query → 500000 poisha',
  },
  {
    n: 45,
    typed: 'L-0001',
    where: 'loans',
    expect: { kind: 'first', label: 'L-0001', tier: 'A_EXACT' },
    why: '- became a space on both sides; digits exempt from the fold',
  },
  {
    n: 46,
    typed: 'করিম rent',
    where: 'transactions',
    expect: { kind: 'first', label: 'Rent — করিম', tier: 'A_PREFIX' },
    why: 'mixed script; করিম is A-exact on payee, rent is A-prefix on the description, and the row scores its weakest token',
  },
  {
    n: 47,
    typed: 'khabar',
    where: 'categoriesPlusNewspaper',
    expect: { kind: 'first', label: 'Food & groceries', tier: 'T_EXACT' },
    why: 'খবরের কাগজ is a real over-match; the band invariant guarantees it cannot displace the 840',
  },
  {
    n: 48,
    typed: 'bus',
    where: 'categories',
    expect: { kind: 'miss', label: 'House rent' },
    why: 'three gates, all needed: b1 differs, b2 is three chars, skel has two consonants',
  },
  {
    n: 49,
    typed: 'beton',
    where: 'categories',
    expect: { kind: 'miss', label: 'Entertainment' },
    why: 'batan vs banadan; btn vs bndn; distance 3 > max 1',
  },
  {
    n: 50,
    typed: 'vara',
    where: 'categories',
    expect: { kind: 'miss', label: 'Food & groceries' },
    why: 'bar vs bajar; br vs bjr — বাজার is not reachable',
  },
  {
    n: 51,
    typed: 'sud',
    where: 'people',
    expect: { kind: 'empty' },
    why: 'sad vs sada at B1; B2 would agree but is gated at four chars',
  },
  {
    n: 52,
    typed: 'gari',
    where: 'categories',
    expect: { kind: 'empty' },
    why: 'gara/bara; gr/br — no main result. See the deviation test for the D-fuzzy suggestion',
  },
  {
    n: 53,
    typed: 'jj',
    where: 'categories',
    expect: { kind: 'empty' },
    why: 'doubled-consonant collapse makes b1(jj) = j, length 1, below every gate',
  },
  {
    n: 54,
    typed: '4',
    where: 'loans',
    expect: { kind: 'unfiltered' },
    why: 'below MIN_QUERY_LENGTH — the unfiltered list, not every loan containing a 4',
  },
  {
    n: 55,
    typed: '5000',
    where: 'loans',
    expect: { kind: 'miss', label: 'L-0002' },
    why: 'exact poisha equality: 500000 ≠ 500050',
  },
];

describe('§9 — the worked examples, verbatim', () => {
  it.each(WORKED)('#$n typing $typed', ({ typed, where, expect: want }: Worked) => {
    const docs = FIXTURES[where];
    const result = searchDocs(docs, typed);

    switch (want.kind) {
      case 'first': {
        expect(result.hits[0]?.row.label, `main = ${labels(docs, typed).join(', ')}`).toBe(
          want.label,
        );
        expect(result.hits[0]?.tier).toBe(want.tier);
        break;
      }
      case 'hit': {
        const hit = result.hits.find((h) => h.row.label === want.label);
        expect(hit, `main = ${labels(docs, typed).join(', ')}`).toBeDefined();
        expect(hit?.tier).toBe(want.tier);
        break;
      }
      case 'suggestion': {
        expect(result.hits).toHaveLength(0);
        expect(result.suggestions[0]?.row.label).toBe(want.label);
        expect(result.suggestions[0]?.tier).toBe(want.tier);
        break;
      }
      case 'miss': {
        expect(labels(docs, typed)).not.toContain(want.label);
        break;
      }
      case 'empty': {
        expect(labels(docs, typed)).toEqual([]);
        break;
      }
      case 'unfiltered': {
        expect(result.filtered).toBe(false);
        expect(result.hits).toHaveLength(docs.length);
        expect(result.hits.every((h) => h.tier === null)).toBe(true);
        break;
      }
    }
  });

  it('#5.3 traced: khabar puts Food & groceries 300 points clear', () => {
    const result = searchDocs(categoriesPlusNewspaper, 'khabar');
    expect(result.hits[0]?.row.label).toBe('Food & groceries');
    expect(result.hits[0]?.score).toBe(840); // T-exact 800 + PRIMARY 40
    // §5.3 predicted the runner-up at B1-prefix 538. Keeping the whole
    // candidate set lifts it to T-prefix 738 (khaborer starts with khabar),
    // which is still 102 points clear — the band invariant is what guarantees
    // no lower tier can ever close a gap like that.
    expect(result.hits[1]?.row.label).toBe('Newspaper');
    expect(result.hits[1]?.tier).toBe('T_PREFIX');
    expect(result.hits[1]?.score).toBe(738);
    expect(result.hits[0]?.score).toBeGreaterThan(result.hits[1]?.score ?? 0);
  });

  it('#36 scores exactly as §9 says: 1140 over the Bengali row', () => {
    const result = searchDocs(people, 'karim');
    expect(result.hits.map((h) => [h.row.label, h.tier, h.score])).toEqual([
      ['Karim Uddin', 'A_PREFIX', 1140],
      ['করিম', 'T_EXACT', 840],
    ]);
  });

  it('#35 returns both অন্যান্য rows, in sortOrder', () => {
    expect(labels(categories, 'onnanno')).toEqual(['Other income', 'Other expense']);
  });

  it('#15/#16 need both tokens to hit, and both spellings do', () => {
    expect(labels(categories, 'basha vara')).toEqual(['House rent']);
    expect(labels(categories, 'basa bhara')).toEqual(['House rent']);
    // ...and one token alone is not enough to make a two-token query pass.
    expect(labels(categories, 'basha bikash')).toEqual([]);
  });

  it('#43 finds a person by the first five digits of their phone', () => {
    const hit = hitFor(people, '০১৭১২', 'Karim Uddin');
    expect(hit?.matchedField).toBe('phone');
    expect(hit?.score).toBe(1114); // 1100 + SECONDARY 20 − (11 − 5)
  });
});

/**
 * Four rows of §9 predict an outcome the rest of the specification does not
 * produce. Each is asserted here rather than quietly dropped, because the next
 * person to read the spec will hit exactly these.
 */
describe('§9 — where the specification predicts something it does not produce', () => {
  it('#17: House rent also matches, because both rows contain ভাড়া', () => {
    // §9 says "Rental income only", reasoning that `bari` misses বাসা. True —
    // but the AND is per *token* over the *whole row*, and `bari` folds to the
    // same `bara` as ভাড়া, which House rent also has. Ranking is still right:
    // Rental income is T-exact on both tokens, House rent only B1-exact on one.
    const result = searchDocs(categories, 'bari vara');
    expect(result.hits.map((h) => [h.row.label, h.tier])).toEqual([
      ['Rental income', 'T_EXACT'],
      ['House rent', 'B1_EXACT'],
    ]);
  });

  it('#48: `bus` finds Business, because the English name really does start with it', () => {
    // The intent of #48 — three gates keeping `bus` away from বাসা ভাড়া —
    // holds exactly. What it missed is that `Business` is an A-tier prefix
    // match on plain bytes, which is not the lossy ladder at all.
    expect(labels(categories, 'bus')).toEqual(['Business']);
    expect(hitFor(categories, 'bus', 'Business')?.tier).toBe('A_PREFIX');
    expect(labels(categories, 'bus')).not.toContain('House rent');
  });

  it('#52: `gari` misses the main list but is a distance-1 suggestion', () => {
    // gara vs bara is one substitution and b1(q) is four characters, so §4.2's
    // own maxDistance table admits it. It lands in the suggestions bucket,
    // where by construction it can never interleave with a real result.
    expect(labels(categories, 'gari')).toEqual([]);
    expect(suggestionLabels(categories, 'gari')).toEqual(['House rent', 'Rental income']);
    expect(searchDocs(categories, 'gari').suggestions[0]?.tier).toBe('D_FUZZY');
  });

  it('#7: with a user-added খবরের কাগজ in the list, T-prefix outranks B1-exact', () => {
    // Not a bug — 738 > 640 is the band invariant working. Worth pinning so
    // nobody "fixes" it: `khaborer` genuinely starts with `khabor`.
    const result = searchDocs(categoriesPlusNewspaper, 'khabor');
    expect(result.hits.map((h) => [h.row.label, h.tier])).toEqual([
      ['Newspaper', 'T_PREFIX'],
      ['Food & groceries', 'B1_EXACT'],
    ]);
  });
});

// --- §4.3 the gates ------------------------------------------------------------------

describe('the gates — §4.3, each justified by a verified false positive', () => {
  it('MIN_QUERY_LENGTH: one character is not a filter', () => {
    expect(MIN_QUERY_LENGTH).toBe(2);
    expect(prepareQuery('4').isFilter).toBe(false);
    expect(prepareQuery('খ').isFilter).toBe(false);
    expect(prepareQuery('ab').isFilter).toBe(true);
  });

  it('B1-exact needs three characters: `jj` collapses to `j` and is refused', () => {
    expect(foldLatin('jj')).toBe('j');
    expect(labels(categories, 'jj')).toEqual([]);
    expect(suggestionLabels(categories, 'jj')).toEqual([]);
  });

  it('B1-prefix/substr needs four: `ss` collapses to `s` and cannot reach পোশাক', () => {
    expect(foldLatin('ss')).toBe('s');
    expect(labels(categories, 'ss')).not.toContain('Clothing');
  });

  it('B2 needs four characters, which is the gate that stops `bus` reaching বাসা', () => {
    // The B2 keys genuinely agree; only the length gate keeps them apart.
    expect(trimFold(foldLatin('bus'))).toBe('bas');
    expect(trimFold(foldAny('বাসা'))).toBe('bas');
    expect(trimFold(foldLatin('bus'))).toHaveLength(3);
    expect(labels(categories, 'bus')).not.toContain('House rent');
  });

  it('C needs three consonants, which is what keeps `taka` away from an account TK', () => {
    const tk: SearchDoc<Row>[] = [
      { id: 'tk', row: { label: 'TK' }, order: 0, fields: [field('name', 'PRIMARY', 'TK')] },
    ];
    expect(skeleton(foldLatin('taka'))).toBe('tk');
    expect(labels(tk, 'taka')).toEqual([]);
    expect(suggestionLabels(tk, 'taka')).toEqual([]);
  });

  it('C and D stay silent while A and B are finding things', () => {
    // `khabar` never shows skeleton noise, because A/B already found the answer.
    expect(suggestionLabels(categories, 'khabar')).toEqual([]);
    // Force the threshold down and the same query still produces a clean list.
    const forced = searchDocs(categories, 'khabar', { suggestionThreshold: 0 });
    expect(forced.suggestions).toEqual([]);
  });

  it('C and D can be switched off entirely, which is what transactions do', () => {
    expect(searchDocs(people, 'krim', { allowSuggestions: false }).suggestions).toEqual([]);
    expect(searchDocs(people, 'krim', { allowSuggestions: false }).hits).toEqual([]);
    expect(searchDocs(people, 'krim').suggestions.length).toBeGreaterThan(0);
  });

  it('never fuzzy-matches digits — two loan numbers are not a typo apart', () => {
    const result = searchDocs(loans, 'L-0001');
    expect(result.hits.map((h) => h.row.label)).toEqual(['L-0001']);
    expect(result.suggestions).toEqual([]);
  });
});

// --- the cases the specification did not list ---------------------------------------

describe('the cases §9 did not list', () => {
  it('an empty query is not a filter', () => {
    const result = searchDocs(categories, '');
    expect(result.filtered).toBe(false);
    expect(result.hits).toHaveLength(categories.length);
    expect(result.hits.map((h) => h.row.label)).toEqual(categories.map((d) => d.row.label));
  });

  it('a query of only spaces is not a filter either', () => {
    expect(searchDocs(categories, '     ').filtered).toBe(false);
    expect(searchDocs(categories, ' \t\n').filtered).toBe(false);
  });

  it('a query of only punctuation returns the unfiltered list, not an empty one', () => {
    // §7, deliberate narrowing 4: this used to return nothing.
    const result = searchDocs(loans, '///');
    expect(result.filtered).toBe(false);
    expect(result.hits).toHaveLength(loans.length);
  });

  it('a single letter is not a filter, in either script', () => {
    expect(searchDocs(categories, 'a').filtered).toBe(false);
    expect(searchDocs(categories, 'খ').filtered).toBe(false);
    // Two characters is, even if nothing matches.
    expect(searchDocs(categories, 'qq').filtered).toBe(true);
    expect(searchDocs(categories, 'qq').hits).toEqual([]);
  });

  it('a very long query is a filter and simply finds nothing', () => {
    const long = 'a'.repeat(500);
    const result = searchDocs(categories, long);
    expect(result.filtered).toBe(true);
    expect(result.hits).toEqual([]);
    expect(result.suggestions).toEqual([]);
  });

  it('a very long Bengali query stays inside the caps', () => {
    const long = 'খাবার'.repeat(40);
    const started = Date.now();
    const result = searchDocs(categoriesPlusNewspaper, long);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.filtered).toBe(true);
    expect(transliterateBengali(long).length).toBeLessThanOrEqual(MAX_CANDIDATES_PER_TOKEN);
  });

  it('Bengali digits reach the same rows as ASCII ones', () => {
    expect(labels(people, '০১৭১২৩৪৫৬৭৮')).toEqual(labels(people, '01712345678'));
    expect(labels(loans, '৫০০০')).toEqual(labels(loans, '5000'));
    expect(probeAmountMinor('৫,০০০')).toBe(500_000);
    expect(probeAmountMinor('৳ ৫,০০০.৫০')).toBe(500_050);
    expect(probeAmountMinor('khabar')).toBeNull();
    expect(probeAmountMinor('')).toBeNull();
  });

  it('a query that must match nothing matches nothing, in either bucket', () => {
    for (const nonsense of ['zzzzz', 'qwrtpq', 'xkcdxkcd', 'plplplpl']) {
      const result = searchDocs(categories, nonsense);
      expect(result.filtered, nonsense).toBe(true);
      expect(result.hits, nonsense).toEqual([]);
      expect(result.suggestions, nonsense).toEqual([]);
    }
  });

  it('nonsense that happens to be one edit from a real word is a suggestion, not a result', () => {
    // `ঞঞঞঞ` folds to `nanana`, which is two edits from `anana` (অন্যান্য).
    // That is the suggestions bucket behaving exactly as designed: it never
    // reaches the main list, and it can never outscore anything that did.
    const result = searchDocs(categories, 'ঞঞঞঞ');
    expect(result.hits).toEqual([]);
    expect(result.suggestions.every((h) => h.tier === 'D_FUZZY')).toBe(true);
    expect(Math.max(...result.suggestions.map((h) => h.score))).toBeLessThan(151);
  });

  it('an empty field never matches anything', () => {
    const blank: SearchDoc<Row>[] = [
      {
        id: 'blank',
        row: { label: 'blank' },
        order: 0,
        fields: [field('name', 'PRIMARY', ''), field('note', 'FREE', null)],
      },
    ];
    expect(labels(blank, 'ab')).toEqual([]);
    expect(buildSearchKeys(null).tokens).toEqual([]);
    expect(buildSearchKeys(undefined).text).toBe('');
  });

  it('caps the length penalty so one long field cannot fall out of its band', () => {
    const wordy: SearchDoc<Row>[] = [
      {
        id: 'w',
        row: { label: 'wordy' },
        order: 0,
        fields: [field('note', 'FREE', `ab${'c'.repeat(200)}`)],
      },
    ];
    const hit = hitFor(wordy, 'ab', 'wordy');
    expect(hit?.tier).toBe('A_PREFIX');
    expect(hit?.score).toBe(TIER_BASE.A_PREFIX - MAX_LENGTH_PENALTY);
  });
});

// --- §4.1 / §5 the matching and ranking rules ----------------------------------------

describe('multi-token queries are AND, and a row is only as good as its worst token', () => {
  it('every token must hit some field, and they may be different fields', () => {
    // করিম on payee, rent on the description.
    expect(labels(transactions, 'করিম rent')).toEqual(['Rent — করিম']);
    // One token that hits nothing sinks the row.
    expect(labels(transactions, 'করিম zzzz')).toEqual([]);
  });

  it('scores the row at its minimum token, not its maximum', () => {
    const hit = hitFor(transactions, 'করিম rent', 'Rent — করিম');
    // করিম is A-exact on a PRIMARY field (1240); rent is A-prefix on a FREE
    // field (1100). The row takes the weaker of the two.
    expect(hit?.score).toBe(1100);
    expect(hit?.tier).toBe('A_PREFIX');
  });

  it('breaks a tie on the sum across tokens, then on the shorter field', () => {
    const rows: SearchDoc<Row>[] = [
      {
        id: 'short',
        row: { label: 'short' },
        order: 1,
        fields: [field('name', 'PRIMARY', 'khabar')],
      },
      {
        id: 'long',
        row: { label: 'long' },
        order: 0,
        fields: [field('name', 'PRIMARY', 'khabar')],
      },
    ];
    // Identical scores, identical field lengths: natural order decides, then id.
    expect(labels(rows, 'khabar')).toEqual(['long', 'short']);
  });

  it('is a total order — the same list comes back in the same order every time', () => {
    const once = labels(categoriesPlusNewspaper, 'khabar');
    for (let i = 0; i < 5; i += 1) {
      expect(labels(categoriesPlusNewspaper, 'khabar')).toEqual(once);
    }
  });
});

// --- §7 subsuming the old loans q -----------------------------------------------------

/**
 * The subsumption proof, at the level `packages/core` can carry it.
 *
 * `LoansService.searchClauses` today ORs five case-insensitive `contains`
 * clauses plus one exact amount equality. Tier A-substr over `norm` is a
 * superset of `contains` + `mode: 'insensitive'` because `norm` only ever
 * removes or unifies — case, invisibles, punctuation to space, Bengali digits
 * to ASCII. This test runs the old predicate and the new matcher over the same
 * rows and asserts the new one never loses a row.
 */
describe('§7 — nothing that matched before stops matching', () => {
  interface LoanRecord {
    readonly loanNumber: string;
    readonly personName: string;
    readonly personPhone: string | null;
    readonly note: string | null;
    readonly paymentRefs: readonly string[];
    readonly accountName: string;
    readonly principalMinor: number;
  }

  const records: readonly LoanRecord[] = [
    {
      loanNumber: 'L-0001',
      personName: 'করিম',
      personPhone: '01712345678',
      note: null,
      paymentRefs: ['TRX9F2K1'],
      accountName: 'bKash',
      principalMinor: 500_000,
    },
    {
      loanNumber: 'L-0002',
      personName: 'Karim Uddin',
      personPhone: '01812345678',
      note: 'অফিসের টাকা, ফেরত দেবে',
      paymentRefs: [],
      accountName: 'নগদ',
      principalMinor: 500_050,
    },
    {
      loanNumber: 'L-5000',
      personName: 'Rahim Mia',
      personPhone: null,
      note: 'Shop advance',
      paymentRefs: ['CASH-1'],
      accountName: 'নগদ',
      principalMinor: 1_000_000,
    },
  ];

  /** The old `where` clause, exactly: five `contains` plus one amount equality. */
  function oldMatches(record: LoanRecord, q: string): boolean {
    const needle = q.toLowerCase();
    const contains = (s: string | null): boolean => s !== null && s.toLowerCase().includes(needle);
    let amount: number | null = null;
    try {
      amount = probeAmountMinor(q);
    } catch {
      amount = null;
    }
    return (
      contains(record.loanNumber) ||
      contains(record.personName) ||
      contains(record.personPhone) ||
      contains(record.note) ||
      record.paymentRefs.some((r) => contains(r)) ||
      (amount !== null && record.principalMinor === amount)
    );
  }

  const docs: readonly SearchDoc<Row>[] = records.map((r, i) => ({
    id: r.loanNumber,
    row: { label: r.loanNumber },
    order: i,
    fields: [
      field('loanNumber', 'SECONDARY', r.loanNumber),
      field('person.name', 'PRIMARY', r.personName),
      field('person.phone', 'SECONDARY', r.personPhone),
      field('note', 'FREE', r.note),
      ...r.paymentRefs.map((ref, n) => field(`payment.${n}.referenceNumber`, 'SECONDARY', ref)),
      field('account.name', 'FREE', r.accountName),
    ],
    amounts: [{ name: 'principalMinor', weight: 'SECONDARY', minor: r.principalMinor }],
  }));

  const fixtures = [
    'L-0001',
    'l-0001',
    '0002',
    'করিম',
    'Karim',
    'karim',
    'RAHIM',
    '01712',
    '01812345678',
    'অফিস',
    'ফেরত',
    'TRX9F2K1',
    'trx9f2k1',
    'CASH-1',
    'Shop',
    'advance',
    '5000',
    '5000.50',
    '10000',
    'zzz-not-there',
  ];

  it.each(fixtures)('the new matcher returns a superset for %s', (q) => {
    const before = records.filter((r) => oldMatches(r, q)).map((r) => r.loanNumber);
    const after = searchDocs(docs, q).hits.map((h) => h.row.label);
    for (const loanNumber of before) {
      expect(after, `${q}: lost ${loanNumber}`).toContain(loanNumber);
    }
  });

  it('widening 1: ৫০০০ now reaches loanNumber L-5000 (different code points before)', () => {
    // The old amount equality already understood Bengali digits, so ৫০০০ found
    // the ৳5,000 loan. What it could not do was match the *text* `L-5000`:
    // `'L-5000'.includes('৫০০০')` is false and always would be.
    expect(records.filter((r) => oldMatches(r, '৫০০০')).map((r) => r.loanNumber)).toEqual([
      'L-0001',
    ]);
    expect(searchDocs(docs, '৫০০০').hits.map((h) => h.row.label)).toContain('L-5000');
  });

  it('widening 2: account.name is searched, so bkash finds the loan it funded', () => {
    expect(records.filter((r) => oldMatches(r, 'bkash')).map((r) => r.loanNumber)).toEqual([]);
    expect(searchDocs(docs, 'bkash').hits.map((h) => h.row.label)).toEqual(['L-0001']);
  });

  it('widening 3: karim 5000 is now "করিম AND ৳5,000", not a literal string', () => {
    expect(records.filter((r) => oldMatches(r, 'karim 5000'))).toEqual([]);
    expect(searchDocs(docs, 'karim 5000').hits.map((h) => h.row.label)).toEqual(['L-0001']);
  });

  it('narrowing 4: a punctuation-only query returns the unfiltered list', () => {
    const result = searchDocs(docs, '-');
    expect(result.filtered).toBe(false);
    expect(result.hits).toHaveLength(docs.length);
  });

  it('the amount probe is exact poisha, not "about ৳5,000"', () => {
    // L-5000 comes along too, but on its *number*, not its amount — the two
    // ways in are separate and both are visible in `matchedField`.
    const byAmount = searchDocs(docs, '5000').hits;
    expect(byAmount.map((h) => [h.row.label, h.matchedField])).toEqual([
      ['L-0001', 'principalMinor'],
      ['L-5000', 'loanNumber'],
    ]);
    // `5000.50` probes as ৳5,000.50 on the *raw* query — norm would have
    // destroyed the decimal point — and separately splits into the tokens
    // `5000` and `50`, both of which sit inside the text `l 5000`.
    expect(searchDocs(docs, '5000.50').hits.map((h) => [h.row.label, h.matchedField])).toEqual([
      ['L-0002', 'principalMinor'],
      ['L-5000', 'loanNumber'],
    ]);
    // The currency marker and the separators are punctuation, so this splits
    // into `5`, `000`, `00`. The bare `5` cannot reach the substring tier (see
    // the per-token MIN_QUERY_LENGTH gate), which is what keeps L-0002 — whose
    // phone number happens to contain a five — out of the list.
    expect(searchDocs(docs, '৳5,000.00').hits.map((h) => h.row.label)).toEqual([
      'L-0001',
      'L-5000',
    ]);
    // ৳5,000.00 and ৳5,000.50 are fifty poisha and one whole loan apart.
    expect(searchDocs(docs, '5000').hits.map((h) => h.row.label)).not.toContain('L-0002');
  });
});

// --- §4.3 scope ------------------------------------------------------------------------

/**
 * Scope is applied **before any key is built**. These three cases are not
 * behaviours of the matcher — they are behaviours of the caller, and the tests
 * exist to say so out loud: nothing in this module can rescue a row that should
 * never have been in the list, and nothing in it will hide one that was.
 */
describe('§9 #56–#58 — scope is the caller’s job, applied before indexing', () => {
  interface PersonRecord {
    readonly id: string;
    readonly name: string;
    readonly workspaceId: string;
    readonly deletedAt: Date | null;
  }

  const rows: readonly PersonRecord[] = [
    { id: 'ok', name: 'করিম', workspaceId: 'w1', deletedAt: null },
    { id: 'deleted', name: 'করিম', workspaceId: 'w1', deletedAt: new Date() },
    { id: 'other-workspace', name: 'করিম', workspaceId: 'w2', deletedAt: null },
  ];

  const inScope = (r: PersonRecord): boolean => r.workspaceId === 'w1' && r.deletedAt === null;

  const docs: SearchDoc<Row>[] = rows.filter(inScope).map((r, i) => ({
    id: r.id,
    row: { label: r.id },
    order: i,
    fields: [field('name', 'PRIMARY', r.name)],
  }));

  it('#56: a soft-deleted করিম is never indexed, so `karim` cannot find it', () => {
    expect(labels(docs, 'karim')).toEqual(['ok']);
  });

  it('#57: another workspace’s খাবার is never indexed either', () => {
    expect(labels(docs, 'korim')).toEqual(['ok']);
    expect(labels(docs, 'korim')).not.toContain('other-workspace');
  });

  it('#58: the hidden SYSTEM_INCOME account আয় is out of the picker list', () => {
    const all = [
      { systemKey: null, name: 'নগদ' },
      { systemKey: null, name: 'bKash' },
      { systemKey: SYSTEM_ACCOUNT_KEYS.income, name: 'আয়' },
    ];
    const pickable: SearchDoc<Row>[] = all
      .filter((a) => a.systemKey === null)
      .map((a, i) => ({
        id: a.name,
        row: { label: a.name },
        order: i,
        fields: [field('name', 'PRIMARY', a.name)],
      }));

    expect(labels(pickable, 'আয়')).toEqual([]);
    // ...and it would have matched, had it been in the list. That is the point.
    const unscoped: SearchDoc<Row>[] = all.map((a, i) => ({
      id: a.name,
      row: { label: a.name },
      order: i,
      fields: [field('name', 'PRIMARY', a.name)],
    }));
    expect(labels(unscoped, 'আয়')).toEqual(['আয়']);
  });
});

// --- §8 where this must NOT be used -------------------------------------------------------

describe('§8 — search is for finding; identity resolution is a different question', () => {
  /** Exactly what `resolvePerson` does today: NFC, case-insensitive, exact. */
  const identityKey = (name: string): string => name.normalize('NFC').trim().toLowerCase();

  it('`korim` finds করিম but must never resolve to it', () => {
    // Search says yes, loudly.
    expect(labels(people, 'korim')).toContain('করিম');
    // Identity says no, and has to keep saying no: a wrong merge produces a
    // wrong ledger presented as a right one.
    expect(identityKey('korim')).not.toBe(identityKey('করিম'));
  });

  it('করিম and করিমা are two people, however close their keys look', () => {
    expect(identityKey('করিম')).not.toBe(identityKey('করিমা'));
    // The fold deliberately cannot tell them apart, which is precisely why it
    // must not be the thing deciding whether to reuse a Person row.
    expect(trimFold(foldAny('করিম'))).toBe(trimFold(foldAny('করিমা')));
  });

  it('an exact category name still beats a near-duplicate, as resolveInterestCategory needs', () => {
    expect(identityKey('ঋণের সুদ')).toBe(identityKey('ঋণের সুদ '));
    expect(identityKey('ঋণের সুদ')).not.toBe(identityKey('ঋণ সুদ'));
  });
});

// --- §6.2 the materialised columns -----------------------------------------------------

describe('§6.2 — the stored keys a transaction row carries', () => {
  it('stores norm and the b2 fold, space-joined across every searchable field', () => {
    const keys = buildStoredSearchKeys(['খাবার — বাজার', 'করিম', null, 'L-0001']);
    expect(keys.searchNorm).toBe('খাবার বাজার করিম l 0001');
    expect(keys.searchFold).toBe('kabar bajar karam l 0001');
  });

  it('is null, not empty, when there is nothing to index', () => {
    expect(buildStoredSearchKeys([null, undefined, '', '   '])).toEqual({
      searchNorm: null,
      searchFold: null,
    });
  });

  it('is what makes #21 reachable in SQL at all', () => {
    // Postgres cannot transliterate. The only reason `?q=mobile` can find a
    // transaction described মোবাইল রিচার্জ is that this column exists.
    const stored = buildStoredSearchKeys(['মোবাইল রিচার্জ']);
    const needle = storedFoldNeedle('mobile');
    expect(needle).toBe('mabal');
    expect(stored.searchFold?.includes(needle as string)).toBe(true);
    // The plain ILIKE the clause keeps alongside it finds nothing, as expected.
    expect('মোবাইল রিচার্জ'.toLowerCase().includes('mobile')).toBe(false);
  });

  it('gates the SQL needle at four characters, because ILIKE has no ranking', () => {
    expect(storedFoldNeedle('bus')).toBeNull(); // b2 is `bas`, three characters
    expect(storedFoldNeedle('a')).toBeNull(); // not a filter at all
    expect(storedFoldNeedle('')).toBeNull();
    expect(storedFoldNeedle('khabar')).toBe('kabar');
    expect(storedFoldNeedle('করিম')).toBe('karam');
  });

  it('keeps every digit of a reference intact', () => {
    const keys = buildStoredSearchKeys(['Ref L-0001 / TRX 1100']);
    expect(keys.searchNorm).toBe('ref l 0001 trx 1100');
    expect(keys.searchFold).toBe('rap l 0001 trks 1100');
  });

  it('produces identical columns for the two byte sequences of the same word', () => {
    const composed = buildStoredSearchKeys(['মোবাইল']);
    const decomposed = buildStoredSearchKeys(['মোবাইল']);
    expect(composed).toEqual(decomposed);
  });
});

// --- keys ---------------------------------------------------------------------------------

describe('buildSearchKeys', () => {
  it('carries every rung, per token', () => {
    const keys = buildSearchKeys('খাবার ও বাজার');
    expect(keys.text).toBe('খাবার ও বাজার');
    expect(keys.tokens).toEqual(['খাবার', 'ও', 'বাজার']);
    expect(keys.latin[0]?.[0]).toBe('khabar');
    expect(keys.b1[0]).toContain('kabar');
    expect(keys.b2[0]).toContain('kabar');
    expect(keys.skel[0]).toContain('kbr');
    expect(keys.b1Text).toBe('kabar a bajar');
  });

  it('leaves Latin fields alone', () => {
    const keys = buildSearchKeys('Food & groceries');
    expect(keys.tokens).toEqual(['food', 'groceries']);
    expect(keys.latin).toEqual([['food'], ['groceries']]);
    expect(keys.b1Text).toBe('pad grasaras'); // f→p, oo→a; ce→sa then the vowel runs
  });

  it('is deterministic and idempotent over its own normalisation', () => {
    expect(buildSearchKeys('  Food  &  groceries ')).toEqual(buildSearchKeys('Food & groceries'));
  });
});
