import { parseMoneyToMinor, toAsciiDigits } from '@hishab/shared';

/**
 * Banglish search: finding a Bengali row from a Latin query, and back again.
 *
 * A Bangladeshi user typing on a phone types one of four things and does not
 * tell you which: Bengali (`খাবার`), English (`groceries`), Banglish
 * (`khabar`), or one token of each (`করিম rent`). Only the third is hard, and
 * it is the common one. It cannot be solved by normalising harder, because
 * `খাবার` and `khabar` share no code points at all. It needs
 * **transliteration**, and the transliteration Bangladeshis actually perform is
 * many-to-many in both directions — `ভাড়া` is `bhara` *and* `vara`, `বাসা` is
 * `basa` *and* `basha`, and the inherent vowel is written `o`, written `a`, or
 * not written at all.
 *
 * So this module is a **ladder of five keys**, each computed over both the
 * query and the stored text. Each rung is strictly lossier than the one above,
 * matches strictly more, and scores strictly lower:
 *
 * ```
 * norm      NFC, ASCII digits, case-folded, punctuation → space   script-preserving
 * translit  Bengali → bounded SET of plausible spellings          script-crossing, precise
 * b1        Latin skeleton: consonant classes + collapsed vowels  script-crossing, lossy
 * b2        b1 with the word-final vowel dropped                  lossier
 * skel      b1 with every vowel dropped                           lossiest — gated, suggestions
 * ```
 *
 * Three rules run through all of it:
 *
 *  1. **The candidate set never decides whether a row matches — only how highly
 *     it ranks.** Recall is owned by the uncapped fold rungs (`b1`/`b2`/`skel`),
 *     which collapse exactly the ambiguity classes the candidate set enumerates.
 *     That is why the hard caps below can be small: if a cap truncates before
 *     reaching the spelling a user typed, they lose a rank bump, never a result.
 *  2. **Scoring bands are 100 points apart and the adjustments span 89**, so a
 *     lower tier can never outrank a higher one. Exact beating prefix beating
 *     transliterated is structural, not hoped for.
 *  3. **Search is for *finding*.** It must never be wired into identity
 *     resolution — `resolvePerson`, `resolveInterestCategory` and the import
 *     category key are exact on purpose, because merging করিম into করিমা
 *     produces a wrong ledger presented as a right one.
 *
 * No Node imports and no `Intl.Segmenter`: the same code runs in the API, in
 * the browser and in the Android WebView, and it has to produce byte-identical
 * keys in all three or a row indexed on the server becomes unsearchable on the
 * phone. The grapheme segmenter below is hand-written for that reason — and
 * because `Intl`'s grapheme boundaries are not the orthographic units we need
 * (a conjunct is one unit here, and `Intl` splits it).
 *
 * All arithmetic is integer. There are no ratios and no percentages, so nothing
 * here ever wants `Math.round` (banned by ESLint for money reasons).
 */

// --- §1 normalisation ---------------------------------------------------------

/**
 * ZWSP…RLM and the bidi controls, plus BOM — the exact class `import.ts` uses.
 *
 * The range covers **ZWNJ (U+200C)** and **ZWJ (U+200D)**, which is the point:
 * Avro, Ridmik and Gboard disagree about whether a conjunct gets a joiner
 * around its hasanta, and that disagreement must not be a search miss.
 */
const INVISIBLES = /[\u200B-\u200F\u202A-\u202E\uFEFF]/g;

/** Anything that is not a letter, a combining mark or a digit. */
const NON_SEARCHABLE = /[^\p{L}\p{M}\p{N}]+/gu;

/**
 * The one normalisation, applied identically to the query and to every indexed
 * field. The order is load-bearing.
 *
 *  1. **NFC.** The same Bengali word arrives as two byte sequences depending on
 *     the keyboard: `ো` (U+09CB) or `ে`+`া` (U+09C7 U+09BE); `ৌ` or `ে`+`ৗ`.
 *     Neither is composition-excluded, so NFC unifies them. **Not NFD** — that
 *     would split them apart again and break the segmenter in §2.
 *     Known limitation, deliberately not fixed here: `ড়` `ঢ়` `য়` *are*
 *     composition-excluded, so NFC leaves whichever form arrived. The segmenter
 *     treats base+nukta and the precomposed form as one unit instead.
 *  2. **ASCII digits**, so `৫০০০` and `5000` are the same query.
 *  3. **Strip invisibles** (see `INVISIBLES`).
 *  4. **Keep the hasanta (U+09CD).** It is not noise — it is the difference
 *     between a conjunct and two syllables, and §2 needs it to decide whether a
 *     consonant carries its inherent vowel. It disappears at the `b1` rung.
 *  5. **Case fold with `toLowerCase`, never `toLocaleLowerCase`** — under a
 *     Turkish locale the latter maps `I` to `ı` and the same query would behave
 *     differently on two devices. Bengali has no case, so this is a no-op there.
 *  6. **Punctuation → space.** This is the rule that makes
 *     `মোবাইল/ইন্টারনেট` and `মোবাইল ইন্টারনেট` the same string. It equally
 *     handles `Food & groceries`, `মুনাফা/সুদ`, `L-0001` and `A/C No.`.
 *     `\p{M}` keeps matras, hasanta, nukta and chandrabindu; `\p{N}` keeps digits.
 *
 * Consequence to accept: a query of only punctuation normalises to the empty
 * string and is treated as *no query* (§4.1), not as a query matching nothing.
 */
export function normaliseSearchText(raw: string): string {
  if (typeof raw !== 'string' || raw === '') return '';
  return toAsciiDigits(raw.normalize('NFC'))
    .replace(INVISIBLES, '')
    .toLowerCase()
    .replace(NON_SEARCHABLE, ' ')
    .trim();
}

/** `norm` output split on spaces. Empty input gives an empty list, not `['']`. */
export function searchTokens(raw: string): string[] {
  const text = normaliseSearchText(raw);
  return text === '' ? [] : text.split(' ');
}

// --- §3 the fold --------------------------------------------------------------

/**
 * Digraphs, longest match first, left to right.
 *
 * `ce`/`ci`/`cy` are listed *before* the bare `c→k` of step 4 on purpose: it is
 * what makes English `freelance` fold to the same thing as Banglish `frilanse`.
 * The replacement keeps the vowel (`ce` → `sa`) so the syllable count survives.
 */
const DIGRAPHS: ReadonlyMap<string, string> = new Map([
  ['chh', 'c'],
  ['ph', 'p'],
  ['bh', 'b'],
  ['dh', 'd'],
  ['gh', 'g'],
  ['jh', 'j'],
  ['kh', 'k'],
  ['th', 't'],
  ['ch', 'c'],
  ['sh', 's'],
  ['zh', 'j'],
  ['ck', 'k'],
  ['ce', 'sa'],
  ['ci', 'sa'],
  ['cy', 'sa'],
]);

/** Single-letter classes. Step 4, after the digraphs have had their turn. */
const LETTER_CLASSES: ReadonlyMap<string, string> = new Map([
  ['x', 'ks'],
  ['q', 'k'],
  ['v', 'b'],
  ['f', 'p'],
  ['z', 'j'],
  ['c', 'k'],
]);

/**
 * `w` is a vowel here because `ও` is written `o` *or* `w` — `showkot` and
 * `soukot` are the same name.
 */
const LATIN_VOWELS = 'aeiouw';

const DIGITS_ONLY = /^[0-9]+$/;

function isLatinVowel(ch: string): boolean {
  return LATIN_VOWELS.includes(ch);
}

function isLatinLetter(ch: string): boolean {
  return ch >= 'a' && ch <= 'z';
}

/** A Latin consonant for folding purposes: a letter that is not a vowel class. */
function isLatinConsonant(ch: string): boolean {
  return isLatinLetter(ch) && !isLatinVowel(ch);
}

function endsWithLatinVowel(s: string): boolean {
  return s.length > 0 && isLatinVowel(s[s.length - 1] as string);
}

/** Step 1. */
function applyDigraphs(input: string): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    const three = input.slice(i, i + 3);
    const threeTo = DIGRAPHS.get(three);
    if (threeTo !== undefined) {
      out += threeTo;
      i += 3;
      continue;
    }
    const two = input.slice(i, i + 2);
    const twoTo = DIGRAPHS.get(two);
    if (twoTo !== undefined) {
      out += twoTo;
      i += 2;
      continue;
    }
    out += input[i] as string;
    i += 1;
  }
  return out;
}

/** Step 2: leftover aspiration — an `h` straight after a consonant says nothing. */
function dropAspiration(input: string): string {
  let out = '';
  for (const ch of input) {
    if (ch === 'h' && out.length > 0 && isLatinConsonant(out[out.length - 1] as string)) continue;
    out += ch;
  }
  return out;
}

/**
 * Step 3. After a consonant `y` is a ya-phala and says nothing; anywhere else
 * it is the `য়` glide and is a `j`.
 *
 * This one rule makes `jatayat` and `jatajat` agree *and* `byabsa` and `bebsa`
 * agree — the two halves of the same Bengali letter behaving two ways.
 */
function resolveY(input: string): string {
  let out = '';
  for (const ch of input) {
    if (ch !== 'y') {
      out += ch;
      continue;
    }
    const prev = out.length > 0 ? (out[out.length - 1] as string) : '';
    if (prev !== '' && isLatinConsonant(prev)) continue;
    out += 'j';
  }
  return out;
}

/** Step 4. */
function applyLetterClasses(input: string): string {
  let out = '';
  for (const ch of input) out += LETTER_CLASSES.get(ch) ?? ch;
  return out;
}

/** Step 5: every vowel is `a`, and a *run* of them is one `a`. */
function classifyVowels(input: string): string {
  let out = '';
  let inRun = false;
  for (const ch of input) {
    if (isLatinVowel(ch)) {
      if (!inRun) out += 'a';
      inRun = true;
      continue;
    }
    inRun = false;
    out += ch;
  }
  return out;
}

/** Step 6. Digits are never de-duplicated — see `foldLatinToken`. */
function collapseDoubledConsonants(input: string): string {
  let out = '';
  for (const ch of input) {
    if (isLatinConsonant(ch) && out.length > 0 && out[out.length - 1] === ch) continue;
    out += ch;
  }
  return out;
}

/**
 * The `b1` rung for one token.
 *
 * **Digits are exempt at every step.** A token that is all digits comes back
 * verbatim, and digits inside a mixed token are never vowel-classed and never
 * de-duplicated. This is not cosmetic: without it `L-0001` folds to `l 01` and
 * every loan number ending in a repeated digit becomes a different loan.
 */
function foldLatinToken(token: string): string {
  if (token === '') return '';
  if (DIGITS_ONLY.test(token)) return token;

  let s = applyDigraphs(token);
  s = dropAspiration(s);
  s = resolveY(s);
  s = applyLetterClasses(s);
  s = classifyVowels(s);
  s = collapseDoubledConsonants(s);
  return s;
}

/** Map a function over the space-separated tokens of a key string. */
function perToken(text: string, fn: (token: string) => string): string {
  if (text === '') return '';
  return text
    .split(' ')
    .map((t) => fn(t))
    .join(' ');
}

/**
 * `b1` — the Latin skeleton. Defined **only on Latin text**; feed it Bengali and
 * you get the Bengali back, which is why `foldAny` exists.
 */
export function foldLatin(text: string): string {
  return perToken(text, foldLatinToken);
}

/**
 * `b2` — `b1` with a trailing `a` dropped from each token, never emptying one.
 *
 * This is the tolerance for a word-final vowel that is written by some people
 * and not by others: `mobile` → `mabala` and `mobail` → `mabal` are the same
 * word, and only this rung says so.
 */
export function trimFold(b1: string): string {
  return perToken(b1, (t) => (t.length > 1 && t.endsWith('a') ? t.slice(0, -1) : t));
}

/**
 * `skel` — `b1` with every vowel gone. Consonants and digits only.
 *
 * Catches the vowels a user simply did not type (`bikash`/`bKash` → `bks`),
 * which is also why it over-matches badly and is gated to short lists and to a
 * suggestions bucket that can never interleave with real results.
 */
export function skeleton(b1: string): string {
  return perToken(b1, (t) => (DIGITS_ONLY.test(t) ? t : t.split('a').join('')));
}

// --- §2 Bengali → Latin -------------------------------------------------------

/** Deterministic caps, checked in the tests. See §2.2. */
export const MAX_ALTS_PER_UNIT = 3;
/**
 * A unit that carries an **unwritten** inherent vowel keeps one spelling beyond
 * the cost-ranked cap: the one with no vowel at all. See `buildUnit`.
 */
export const MAX_UNIT_SPELLINGS = MAX_ALTS_PER_UNIT + 1;
export const MAX_UNITS_BRANCHED = 8;
export const MAX_CANDIDATES_PER_TOKEN = 24;
export const MAX_TOKENS_BRANCHED = 3;

/**
 * A consonant alternative costs 1; a vowel alternative costs 2.
 *
 * Both kinds of alternative are truncated by `MAX_ALTS_PER_UNIT`, so their
 * relative cost decides which survives — and the consonant ones are the ones
 * that matter. `শ`→`sh` versus `s` is a different keyboard habit that whole
 * populations have (`basa`/`basha`); `া`→`aa` is one person lengthening a
 * vowel, and it folds to the same `a` anyway. Ranking consonants first is what
 * keeps `basha`, `bazar`, `munapha` and `shastho` inside the cap.
 */
const VOWEL_ALT_COST = 2;

const BENGALI_RANGE = /[ঀ-৿]/;

/** A token "is Bengali" iff it contains any code point in the Bengali block. */
export function isBengaliText(token: string): boolean {
  return BENGALI_RANGE.test(token);
}

const HASANTA = '্';
const NUKTA = '়';

const INDEPENDENT_VOWELS: ReadonlyMap<string, readonly string[]> = new Map([
  ['অ', ['o', 'a']],
  ['আ', ['a', 'aa']],
  ['ই', ['i', 'ee']],
  ['ঈ', ['i', 'ee']],
  ['উ', ['u', 'oo']],
  ['ঊ', ['u', 'oo']],
  ['ঋ', ['ri', 'ry']],
  ['এ', ['e', 'a']],
  ['ঐ', ['oi', 'oy']],
  ['ও', ['o', 'w']],
  ['ঔ', ['ou', 'ow']],
]);

const MATRAS: ReadonlyMap<string, readonly string[]> = new Map([
  ['া', ['a', 'aa']], // া
  ['ি', ['i', 'ee']], // ি
  ['ী', ['i', 'ee']], // ী
  ['ু', ['u', 'oo']], // ু
  ['ূ', ['u', 'oo']], // ূ
  ['ৃ', ['ri']], // ৃ
  ['ৄ', ['ri']], // ৄ
  ['ে', ['e', 'a']], // ে
  ['ৈ', ['oi', 'oy']], // ৈ
  ['ো', ['o', 'ou']], // ো
  ['ৌ', ['ou', 'ow']], // ৌ
]);

/**
 * The consonants. Every row here is a real ambiguity somebody types:
 * `ভাড়া` is `bhara` or `vara`, `যাকাত` is `jakat` or `zakat`, `বাসা` is `basa`
 * or `basha`, `মুনাফা` is `munafa` or `munapha`.
 */
const CONSONANTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['ক', ['k', 'c']],
  ['খ', ['kh', 'k']],
  ['গ', ['g']],
  ['ঘ', ['gh', 'g']],
  ['ঙ', ['ng', 'n']],
  ['চ', ['ch', 'c']],
  ['ছ', ['chh', 'ch']],
  ['জ', ['j', 'z']],
  ['ঝ', ['jh', 'j']],
  ['ঞ', ['n', 'y']],
  ['ট', ['t']],
  ['ঠ', ['th', 't']],
  ['ড', ['d']],
  ['ঢ', ['dh', 'd']],
  ['ণ', ['n']],
  ['ত', ['t']],
  ['থ', ['th', 't']],
  ['দ', ['d']],
  ['ধ', ['dh', 'd']],
  ['ন', ['n']],
  ['প', ['p']],
  ['ফ', ['f', 'ph']],
  ['ব', ['b']],
  ['ভ', ['bh', 'v']],
  ['ম', ['m']],
  ['য', ['j', 'z', 'y']],
  ['র', ['r']],
  ['ল', ['l']],
  ['শ', ['sh', 's']],
  ['ষ', ['sh', 's']],
  ['স', ['s', 'sh']],
  ['হ', ['h']],
  ['\u09DC', ['r', 'rh']], // ড়
  ['\u09DD', ['rh', 'r']], // ঢ়
  ['\u09DF', ['y', '']], // য়
]);

/** Standalone signs. None of them takes an inherent vowel. */
const SIGNS: ReadonlyMap<string, readonly string[]> = new Map([
  ['ং', ['ng', 'n']],
  ['ঃ', ['h', '']],
  ['ঁ', ['', 'n']],
  ['ৎ', ['t']],
]);

interface ClusterEntry {
  readonly alts: readonly string[];
  /** Used when the cluster ends the token with no matra after it. */
  readonly final?: readonly string[];
}

/**
 * Conjuncts whose spoken form is not the concatenation of their parts.
 *
 * Without these, `শিক্ষা` never matches `shikkha` at any rung: `b1` gives
 * `saks` against `sak` and even `skel` gives `sks` against `sk`. The cluster
 * table is the only rung that can fix a conjunct nobody spells out.
 */
const CLUSTERS: ReadonlyMap<string, ClusterEntry> = new Map([
  ['ক্ষ', { alts: ['kkh', 'ksh', 'kh'] }],
  ['জ্ঞ', { alts: ['gg', 'gy', 'jn'] }],
  ['ঞ্চ', { alts: ['nch'] }],
  ['ঞ্জ', { alts: ['nj'] }],
  ['ঙ্গ', { alts: ['ng', 'ngg'] }],
  ['ঙ্ক', { alts: ['nk'] }],
  ['ন্ত', { alts: ['nt'] }],
  ['ন্ট', { alts: ['nt'] }],
  ['ন্য', { alts: ['nn', 'ny'], final: ['nno', 'nn'] }],
  ['ব্য', { alts: ['be', 'bya', 'ba'] }],
  ['ষ্ট', { alts: ['sht', 'st'] }],
  ['ষ্ঠ', { alts: ['shth', 'sth'] }],
  ['স্থ', { alts: ['sth', 'st'] }],
  ['স্ত', { alts: ['st'] }],
  ['দ্ধ', { alts: ['ddh', 'dh'] }],
  ['ক্ত', { alts: ['kt'] }],
  ['হ্ম', { alts: ['mh', 'hm'] }],
  ['শ্র', { alts: ['shr', 'sr'] }],
  ['ম্প', { alts: ['mp'] }],
]);

/** `ব্যবসা` is `bebsa`/`byabsa` — the ya-phala usually just colours the vowel. */
const YA_PHALA_MEDIAL: readonly string[] = ['', 'y', 'e'];
/** `স্বাস্থ্য` is `shastho`. */
const YA_PHALA_FINAL: readonly string[] = ['o', 'yo', ''];
/** **Silent by default**: `স্বাস্থ্য` is `shastho`, not `sbastho`. */
const BA_PHALA: readonly string[] = ['', 'w', 'b'];

/**
 * A bare consonant carries an unwritten `অ`, and users write it three ways.
 * This is the single largest source of variation in Banglish.
 *
 * Word-final it is usually not written at all (`মন` → `mon`, `খাবার` →
 * `khabar`). Medially it is `o`, or `a`, or nothing (`বেতন` →
 * `beton`/`betan`/`betn`). The empty medial alternative is listed **last**
 * because it is the one that breaks the fold invariant of §2.2 — but it is
 * never *dropped* for being last: `buildUnit` reserves it a slot of its own,
 * because "the user did not write the vowel" is not a rare spelling, it is one
 * of the three ordinary ones.
 */
const INHERENT_FINAL: readonly string[] = ['', 'o'];
const INHERENT_MEDIAL: readonly string[] = ['o', 'a', ''];

interface Scored {
  readonly s: string;
  readonly c: number;
}

/**
 * Cheapest first, first spelling wins on a tie, capped.
 *
 * `Array.prototype.sort` is stable, so equal-cost spellings keep the order the
 * tables list them in — which is what makes the whole module deterministic:
 * same input, same output, always.
 */
function rankAndCapScored(items: readonly Scored[], cap: number): Scored[] {
  const ordered = items.slice().sort((a, b) => a.c - b.c);
  const seen = new Set<string>();
  const out: Scored[] = [];
  for (const item of ordered) {
    if (seen.has(item.s)) continue;
    seen.add(item.s);
    out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}

function rankAndCap(items: readonly Scored[], cap: number): string[] {
  return rankAndCapScored(items, cap).map((item) => item.s);
}

/**
 * One grapheme unit's spellings: the consonant part crossed with the vowel part.
 *
 * `vowelAlts === null` means the unit takes no vowel (an independent vowel
 * already has one, and `ং` `ঃ` `ঁ` `ৎ` never do). A base that already ends in a
 * vowel — a cluster like `ব্য` → `be` — takes none either.
 *
 * ## The reserved slot
 *
 * Crossing bases with vowels and capping the product treats "which consonant
 * letter" and "did you write the vowel at all" as one question ranked on one
 * scale. They are not one question. The second has three answers — `o`, `a`,
 * nothing — and whole populations give the third; but on the crossed scale it
 * costs `2 × VOWEL_ALT_COST` and so lost every race against a second consonant
 * spelling. Twenty-two of the thirty-five consonants have one, so `ফ` kept
 * `fo`/`pho`/`fa` and dropped `f`, and with it went `afroza`, `islam`,
 * `nasrin`, `tasnim` and `riksha` — spellings that are not variants at all but
 * the ordinary way the word is written in Latin script.
 *
 * So the vowel-less spelling is **reserved rather than ranked**: one extra
 * slot, holding the primary base with no vowel. The other bases need no slot of
 * their own — `f` and `ph` both fold to `p`, which is the §2.2 invariant doing
 * precisely the job it exists for.
 */
function buildUnit(bases: readonly string[], vowelAlts: readonly string[] | null): string[] {
  const items: Scored[] = [];
  bases.forEach((base, bi) => {
    const alts = vowelAlts === null || endsWithLatinVowel(base) ? [''] : vowelAlts;
    alts.forEach((v, vi) => items.push({ s: base + v, c: bi + vi * VOWEL_ALT_COST }));
  });
  const ranked = rankAndCap(items, MAX_ALTS_PER_UNIT);

  /* Only a unit whose vowel may go unwritten gets the slot, which in practice
   * is the medial inherent vowel: word-finally the unwritten form is already
   * the primary (`মন` → `mon`), and a written matra is written. */
  const bare = bases[0];
  if (
    vowelAlts === null ||
    !vowelAlts.includes('') ||
    bare === undefined ||
    bare === '' ||
    endsWithLatinVowel(bare) ||
    ranked.includes(bare)
  ) {
    return ranked;
  }
  return [...ranked, bare];
}

/** Cross two alternative lists, cheapest first. Used for conjunct consonants. */
function crossBases(left: readonly string[], right: readonly string[]): string[] {
  const items: Scored[] = [];
  left.forEach((l, li) => right.forEach((r, ri) => items.push({ s: l + r, c: li + ri })));
  return rankAndCap(items, MAX_ALTS_PER_UNIT);
}

/**
 * `ব্য` spells its own vowel, so when a matra follows (`ব্যাংক`) the written
 * vowel has to replace the implied one rather than pile on top of it.
 */
function stripTrailingVowels(bases: readonly string[]): string[] {
  const items: Scored[] = [];
  bases.forEach((base, bi) => {
    let s = base;
    while (endsWithLatinVowel(s)) s = s.slice(0, -1);
    items.push({ s, c: bi });
  });
  return rankAndCap(items, MAX_ALTS_PER_UNIT);
}

function consonantAlts(ch: string): readonly string[] {
  return CONSONANTS.get(ch) ?? [ch];
}

function isConsonantChar(ch: string): boolean {
  return CONSONANTS.has(ch);
}

/**
 * `ড`+`়` and the precomposed `ড়` are the same letter and NFC will not unify
 * them (they are composition-excluded), so the segmenter does it. A nukta on
 * anything else is dropped rather than kept as a stray unit.
 */
function precomposeNukta(token: string): string {
  if (!token.includes(NUKTA)) return token;
  let out = '';
  for (const ch of token) {
    if (ch !== NUKTA) {
      out += ch;
      continue;
    }
    const prev = out.length > 0 ? (out[out.length - 1] as string) : '';
    if (prev === 'ড') out = `${out.slice(0, -1)}\u09DC`;
    else if (prev === 'ঢ') out = `${out.slice(0, -1)}\u09DD`;
    else if (prev === 'য') out = `${out.slice(0, -1)}\u09DF`;
    // any other base: the nukta carries no romanisation of its own
  }
  return out;
}

/** The consonants of one hasanta-joined chain, e.g. `স্থ্য` → ['স','থ','য']. */
interface Chain {
  readonly members: readonly string[];
  /** Index just past the chain in the source token. */
  readonly end: number;
  /** A hasanta with nothing behind it: an explicit hosonto, vowel suppressed. */
  readonly trailingHasanta: boolean;
}

function readChain(token: string, start: number): Chain {
  const members: string[] = [token[start] as string];
  let i = start + 1;
  let trailingHasanta = false;

  while (i < token.length && token[i] === HASANTA) {
    const next = i + 1 < token.length ? (token[i + 1] as string) : '';
    if (next !== '' && isConsonantChar(next)) {
      members.push(next);
      i += 2;
      continue;
    }
    // hasanta at the end of the token, or before a vowel sign: an explicit hosonto
    trailingHasanta = true;
    i += 1;
    break;
  }

  return { members, end: i, trailingHasanta };
}

/**
 * The consonant part of one unit, as a list of spellings.
 *
 * Longest match first, exactly as §2.3 lists it: the cluster table beats
 * everything, then reph (`র্` before a consonant, pronounced *before* it), then
 * the phalas, then a plain conjunct.
 */
function chainBases(chain: Chain, unitIsFinal: boolean): string[] {
  const { members } = chain;
  let bases: string[] = [''];
  let pos = 0;

  // reph: র + hasanta + consonant. Written above the next letter, said before it.
  if (members.length > 1 && members[0] === 'র') {
    bases = ['r'];
    pos = 1;
  }

  while (pos < members.length) {
    // The cluster table, longest match first.
    let matched = false;
    for (let k = members.length - 1; k > pos; k -= 1) {
      const key = members.slice(pos, k + 1).join(HASANTA);
      const entry = CLUSTERS.get(key);
      if (entry === undefined) continue;
      const isLastPart = k === members.length - 1;
      const alts =
        isLastPart && unitIsFinal && entry.final !== undefined ? entry.final : entry.alts;
      bases = crossBases(bases, alts);
      pos = k + 1;
      matched = true;
      break;
    }
    if (matched) continue;

    const member = members[pos] as string;
    if (pos > 0) {
      if (member === 'য') {
        const isLastPart = pos === members.length - 1;
        bases = crossBases(bases, isLastPart && unitIsFinal ? YA_PHALA_FINAL : YA_PHALA_MEDIAL);
        pos += 1;
        continue;
      }
      if (member === 'ব') {
        bases = crossBases(bases, BA_PHALA);
        pos += 1;
        continue;
      }
      if (member === 'র') {
        // ra-phala: emits `r` after the consonant it hangs off.
        bases = crossBases(bases, ['r']);
        pos += 1;
        continue;
      }
    }
    bases = crossBases(bases, consonantAlts(member));
    pos += 1;
  }

  return bases;
}

/**
 * Split a Bengali token into orthographic units, each with its capped list of
 * spellings. Latin and digit runs inside a mixed token (`bKashএ`) pass through
 * verbatim as a single unit.
 */
function segmentBengali(rawToken: string): string[][] {
  const token = precomposeNukta(rawToken.normalize('NFC'));
  const units: string[][] = [];
  let i = 0;

  while (i < token.length) {
    const ch = token[i] as string;

    // Non-Bengali run: passed through as written.
    if (!BENGALI_RANGE.test(ch)) {
      let j = i;
      while (j < token.length && !BENGALI_RANGE.test(token[j] as string)) j += 1;
      units.push([token.slice(i, j)]);
      i = j;
      continue;
    }

    const sign = SIGNS.get(ch);
    if (sign !== undefined) {
      units.push(buildUnit(sign.slice(), null));
      i += 1;
      continue;
    }

    const vowel = INDEPENDENT_VOWELS.get(ch);
    if (vowel !== undefined) {
      units.push(buildUnit([''], vowel));
      i += 1;
      continue;
    }

    if (isConsonantChar(ch)) {
      const chain = readChain(token, i);
      const matra = chain.end < token.length ? MATRAS.get(token[chain.end] as string) : undefined;
      const afterVowel = matra === undefined ? chain.end : chain.end + 1;
      const unitIsFinal = afterVowel >= token.length;

      const bases = chainBases(chain, unitIsFinal && matra === undefined);

      if (matra !== undefined) {
        units.push(buildUnit(stripTrailingVowels(bases), matra));
      } else if (chain.trailingHasanta) {
        // explicit hosonto: the inherent vowel is deliberately not there
        units.push(buildUnit(bases, null));
      } else {
        units.push(buildUnit(bases, unitIsFinal ? INHERENT_FINAL : INHERENT_MEDIAL));
      }
      i = afterVowel;
      continue;
    }

    // A stray matra, hasanta or unknown Bengali mark: nothing to romanise.
    i += 1;
  }

  return units;
}

/**
 * Breadth-first expansion over the units, cheapest spelling first, with a beam.
 *
 * The beam is provably safe. Cost is additive and never negative, so if a
 * prefix is not among the `cap` cheapest prefixes then there are already `cap`
 * cheaper prefixes, each of which extends by its all-primary suffix at no extra
 * cost — so the pruned prefix cannot have produced one of the `cap` cheapest
 * whole spellings. Truncation therefore always discards the *least* likely
 * spellings and never the most likely, and the same input gives the same output
 * every time.
 */
function expandUnits(units: readonly (readonly string[])[], cap: number): string[] {
  let beam: Scored[] = [{ s: '', c: 0 }];

  units.forEach((alts, index) => {
    // Past MAX_UNITS_BRANCHED a long word stops branching: primaries only.
    const usable = index < MAX_UNITS_BRANCHED ? alts : alts.slice(0, 1);
    const next: Scored[] = [];
    for (const partial of beam) {
      usable.forEach((alt, i) => next.push({ s: partial.s + alt, c: partial.c + i }));
    }
    beam = rankAndCapScored(next, cap);
  });

  return beam.map((item) => item.s);
}

/**
 * A Bengali token's plausible Latin spellings, **primary first**.
 *
 * There is no canonical Banglish, so this is a set rather than a string. It is
 * allowed to be incomplete: per §2.2 the set decides *ranking*, never
 * *matching*, because the fold rungs collapse the very ambiguities it
 * enumerates (`fold('bh') === fold('v')`, `fold('sh') === fold('s')`,
 * `fold('z') === fold('j')`). A cap of 24 is therefore safe and a cap of 2000
 * would be pointless.
 *
 * Latin input comes back as `[token]` — the caller does not have to check first.
 */
export function transliterateBengali(
  token: string,
  cap: number = MAX_CANDIDATES_PER_TOKEN,
): string[] {
  if (typeof token !== 'string' || token === '') return [''];
  if (!isBengaliText(token)) return [token];
  const units = segmentBengali(token);
  if (units.length === 0) return [token];
  const out = expandUnits(units, Math.max(1, cap));
  return out.length === 0 ? [token] : out;
}

/**
 * `b1` for a token in either script. Bengali goes through its **primary**
 * spelling only, per §2.7 — by the §2.2 invariant the others fold to the same
 * string anyway.
 */
export function foldAny(token: string): string {
  if (!isBengaliText(token)) return foldLatinToken(token);
  return foldLatinToken(transliterateBengali(token)[0] ?? token);
}

/**
 * Every distinct `b1` a token can produce, primary first.
 *
 * Usually one, by the §2.2 invariant. The exceptions are the two vowel-elision
 * alternatives — the omitted inherent vowel and the silent ba-phala — and they
 * are exactly the reason `intarnet` finds `ইন্টারনেট` (`antarnat`, from the
 * spelling where `র` keeps no vowel) and `byabsa` finds `ব্যবসা` (`babsa`, from
 * `bebsa`). Keeping them costs a handful of short strings per token.
 */
export function foldVariants(token: string): string[] {
  const forms = isBengaliText(token) ? transliterateBengali(token) : [token];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const form of forms) {
    const folded = foldLatinToken(form);
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push(folded);
  }
  return out;
}

// --- keys ---------------------------------------------------------------------

/** Every rung of the ladder, precomputed once for one field or one query. */
export interface SearchKeys {
  /** `norm` of the whole field. */
  readonly text: string;
  readonly tokens: readonly string[];
  /** Latin spellings per token; the identity list for a Latin token. */
  readonly latin: readonly (readonly string[])[];
  /** Distinct `b1` values per token, primary first. */
  readonly b1: readonly (readonly string[])[];
  readonly b2: readonly (readonly string[])[];
  readonly skel: readonly (readonly string[])[];
  /** Primary `b1` of every token, space-joined — the key for `B1-substr`. */
  readonly b1Text: string;
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Build every key for one field. Called once per field per row and memoised by
 * the caller: for a 40-row category list with four fields this is roughly
 * 11,000 short strings and under 5ms — cheaper than the round trip that fetched
 * the rows.
 *
 * `MAX_TOKENS_BRANCHED` stops the fourth and later tokens of a long name from
 * branching. A four-word note is a `FREE`-weighted field nobody is ranking on.
 */
export function buildSearchKeys(raw: string | null | undefined): SearchKeys {
  const text = normaliseSearchText(raw ?? '');
  const tokens = text === '' ? [] : text.split(' ');

  const latin: string[][] = [];
  const b1: string[][] = [];
  const b2: string[][] = [];
  const skel: string[][] = [];

  tokens.forEach((token, index) => {
    const branched = index < MAX_TOKENS_BRANCHED;
    const forms = isBengaliText(token)
      ? transliterateBengali(token, branched ? MAX_CANDIDATES_PER_TOKEN : 1)
      : [token];
    const folded = distinct(forms.map(foldLatinToken));
    latin.push(forms);
    b1.push(folded);
    b2.push(distinct(folded.map((f) => trimFold(f))));
    skel.push(distinct(folded.map((f) => skeleton(f))));
  });

  return {
    text,
    tokens,
    latin,
    b1,
    b2,
    skel,
    b1Text: b1.map((forms) => forms[0] ?? '').join(' '),
  };
}

// --- §4 matching --------------------------------------------------------------

/** Below this many normalised characters a query is not a filter at all. */
export const MIN_QUERY_LENGTH = 2;

/**
 * `b1(q)` must be at least this long before the B1-exact rung may fire.
 *
 * **Five, not three.** At `b1` every vowel is the single character `a`, so a key
 * of length L carries at most ⌈L/2⌉ consonants: a four-character key carries
 * two, and two consonants plus two collapsed vowel slots is a few hundred
 * shapes for the whole of English to land in. `b1('water') === b1('other') ===
 * 'atar'` is not bad luck, it is the pigeonhole principle — and it put
 * `অন্যান্য` at the top of the list for `water`, at 640, looking certain.
 * Five is the shortest key that *can* carry three consonants, and it is where a
 * fold-level identity stops being a coincidence. Nothing short is lost: the
 * shorter the token, the likelier the candidate set already enumerated the
 * spelling the user typed, so short words are answered a rung higher, at T.
 */
export const MIN_B1_EXACT = 5;
export const MIN_B1_PARTIAL = 4;
/**
 * The same rung, against an **alias**, needs nine. Measured, not guessed.
 *
 * `MIN_B1_EXACT` is calibrated for a row with two name fields. An alias set is
 * a different object: the seeded tree carries 188 one-word aliases against 57
 * distinct words of Bengali and English names, so opening the fold rung to them
 * at five roughly quadruples the number of short keys a collapsed vowel can
 * land on. Counted against the 234,289 distinct words of `/usr/share/dict/words`
 * (three letters or more, `a-z` only), the whole-key fold rung on the seeded
 * aliases collides with a word that is not itself an alias this many times:
 *
 * | gate | accidental collisions | example                 |
 * | ---- | --------------------- | ----------------------- |
 * |    5 |                   494 | `vivid` = `bibidh`      |
 * |    6 |                   113 | `bookish` = `bikash`    |
 * |    7 |                    34 | `carbine` = `korbani`   |
 * |    8 |                     8 | `antirust` = `interest` |
 * |    9 |                     0 |                         |
 *
 * At five it took the whole matcher's main-bucket rate against that corpus from
 * 0.336% to 0.525%. Nine is where the measurement reaches zero, and it is not
 * an arbitrary cliff: the words that need fold tolerance at all are the long
 * Banglish ones whose vowels nobody agrees on — `poribohon` folds to
 * `parabahan`, exactly nine — while `bus`, `uber` and `robi` are spelled one way
 * by everybody and are already answered two rungs higher, at `A_EXACT`.
 *
 * It is a gate on the *query's* fold, so a user who adds a short alias of their
 * own loses nothing they had: the exact and transliteration rungs above are
 * untouched, and only the tolerance for a spelling they did not list is gated.
 */
export const MIN_ALIAS_B1_EXACT = 9;
/** `b2(q)` is looser still, so it needs a longer query in every form. */
export const MIN_B2 = 4;
/**
 * How many consonants a fold key must carry before the *partial* B rungs — B1
 * prefix and substring, and both B2 rungs — may fire.
 *
 * The same reasoning as `MIN_B1_EXACT`, applied where the match is not even a
 * whole key: a length gate counts collapsed vowels as if they were information,
 * and they are not. Counting consonants instead is exactly what the C rung
 * already does with `MIN_C_CONSONANTS`, one rung further down the same ladder,
 * and for the same reason. Measured against 86,032 English dictionary words and
 * the seeded tree, this gate alone removes `uber` → খাবার ও বাজার, `robi` →
 * পরিবার ও সহায়তা, `dhaka` → শিক্ষা and `water` → অন্যান্য.
 */
export const MIN_B_CONSONANTS = 3;
/** `skel(q)` must carry this many consonants before the C rung is allowed. */
export const MIN_C_CONSONANTS = 3;
export const MIN_C_PREFIX_CONSONANTS = 4;
/** Tiers C and D only run when A and B between them found fewer than this. */
export const SUGGESTION_THRESHOLD = 5;

export type SearchTier =
  | 'A_EXACT'
  | 'A_PREFIX'
  | 'A_BOUNDARY'
  | 'A_SUBSTR'
  | 'T_EXACT'
  | 'T_PREFIX'
  | 'B1_EXACT'
  | 'B1_PREFIX'
  | 'B2_EXACT'
  | 'B2_PREFIX'
  | 'C_EXACT'
  | 'C_PREFIX'
  | 'D_FUZZY'
  | 'B1_SUBSTR';

export type SearchBucket = 'main' | 'suggestion';

/**
 * Bands 100 points apart. The gap is the whole design: with a field bonus of at
 * most +40 and a length penalty of at most −49 the adjustments span 89, so a
 * lower tier can never outrank a higher one.
 */
export const TIER_BASE: Readonly<Record<SearchTier, number>> = {
  A_EXACT: 1200,
  A_PREFIX: 1100,
  A_BOUNDARY: 1000,
  A_SUBSTR: 900,
  T_EXACT: 800,
  T_PREFIX: 700,
  B1_EXACT: 600,
  B1_PREFIX: 500,
  B2_EXACT: 400,
  B2_PREFIX: 300,
  // A separate scale, 10 points apart, that can never interleave with the main
  // results above: the best possible suggestion (100 + 40) still sits below the
  // worst possible real match (300 − 49).
  C_EXACT: 100,
  C_PREFIX: 90,
  D_FUZZY: 80,
  B1_SUBSTR: 70,
};

export const TIER_BUCKET: Readonly<Record<SearchTier, SearchBucket>> = {
  A_EXACT: 'main',
  A_PREFIX: 'main',
  A_BOUNDARY: 'main',
  A_SUBSTR: 'main',
  T_EXACT: 'main',
  T_PREFIX: 'main',
  B1_EXACT: 'main',
  B1_PREFIX: 'main',
  B2_EXACT: 'main',
  B2_PREFIX: 'main',
  C_EXACT: 'suggestion',
  C_PREFIX: 'suggestion',
  D_FUZZY: 'suggestion',
  /* **A suggestion, not a result.** Every other rung matches a whole key
   * against a whole key, or anchors at a word boundary. This one asks whether
   * the query's fold appears *anywhere inside* the row's folded name, which
   * after the vowels have collapsed is close to asking whether a four-gram
   * appears in a sentence: `uber` → `abar` sits inside `kabar a bajar`, `robi`
   * → `raba` inside `parabar`, `dhaka` → `daka` inside `adakatan`. It supplied
   * half of every false positive measured against the English dictionary and
   * not one of the ninety-eight true matches in the recall suite. It stays,
   * because a fragment is a real hint when nothing else matched — but it is a
   * hint, and hints go in the bucket the client labels as hints. */
  B1_SUBSTR: 'suggestion',
};

/** Exact tiers take no length penalty — there is nothing left over to penalise. */
const EXACT_TIERS: ReadonlySet<SearchTier> = new Set<SearchTier>([
  'A_EXACT',
  'T_EXACT',
  'B1_EXACT',
  'B2_EXACT',
  'C_EXACT',
  'D_FUZZY',
]);

export type FieldWeight = 'PRIMARY' | 'SECONDARY' | 'FREE';

export const FIELD_BONUS: Readonly<Record<FieldWeight, number>> = {
  PRIMARY: 40,
  SECONDARY: 20,
  FREE: 0,
};

export const MAX_LENGTH_PENALTY = 49;

/**
 * `tierBase + fieldBonus − lengthPenalty`, all integers.
 *
 * The penalty is the slack left over by the match — the matched key is longer
 * than what the user typed — clamped to 49 so it can never eat a whole band.
 * Shorter fields win, which is what makes a five-character name beat a
 * forty-character note.
 */
export function scoreFor(
  tier: SearchTier,
  weight: FieldWeight,
  matchedLength: number,
  queryLength: number,
  distance = 0,
): number {
  const base = TIER_BASE[tier] - (tier === 'D_FUZZY' ? 10 * distance : 0);
  const penalty = EXACT_TIERS.has(tier)
    ? 0
    : Math.max(0, Math.min(MAX_LENGTH_PENALTY, matchedLength - queryLength));
  return base + FIELD_BONUS[weight] - penalty;
}

/**
 * Damerau–Levenshtein with a budget, aborting as soon as the cheapest cell in a
 * row exceeds it.
 *
 * Bounded because it is O(n·m) per pair: on a 40-row category list against a
 * six-character query that is a rounding error, and on 50,000 transactions it
 * is 50,000 DP tables per keystroke that no index can help with. This never
 * runs in SQL and never runs against transactions.
 */
export function boundedDamerauLevenshtein(a: string, b: string, budget: number): number {
  if (a === b) return 0;
  if (budget < 0) return budget + 1;
  if (Math.abs(a.length - b.length) > budget) return budget + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let twoBack: number[] = [];
  let previous: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  let current: number[] = new Array<number>(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        (current[j - 1] as number) + 1, // insertion
        (previous[j] as number) + 1, // deletion
        (previous[j - 1] as number) + cost, // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (twoBack[j - 2] as number) + 1); // transposition
      }
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > budget) return budget + 1;
    twoBack = previous;
    previous = current;
    current = new Array<number>(b.length + 1).fill(0);
  }

  return previous[b.length] as number;
}

/**
 * How wrong a typo is allowed to be, by how much the user typed.
 *
 * Zero below four characters: at three characters a single edit reaches half
 * the dictionary, and `bus` would "nearly" match `basa`, `bosa` and `bas`.
 */
export function maxDistanceFor(b1Length: number): number {
  if (b1Length <= 3) return 0;
  if (b1Length <= 6) return 1;
  return 2;
}

function countConsonants(skel: string): number {
  let n = 0;
  for (const ch of skel) if (isLatinLetter(ch)) n += 1;
  return n;
}

// --- query --------------------------------------------------------------------

export interface PreparedToken {
  readonly text: string;
  readonly latin: readonly string[];
  readonly b1: string;
  readonly b1All: readonly string[];
  readonly b2: string;
  readonly skel: string;
  /** This token read as money, poisha, or null. Lets `karim 5000` AND across a
   * name and an amount — see §7, deliberate widening 3. */
  readonly amountMinor: number | null;
}

export interface PreparedQuery {
  readonly raw: string;
  readonly text: string;
  readonly tokens: readonly PreparedToken[];
  /**
   * Probed on the **raw trimmed** query, never on `norm(q)` — `norm` turns `.`
   * and `,` into spaces and would destroy `1,234.56`.
   */
  readonly amountMinor: number | null;
  /** False when the query is not a filter at all: show the unfiltered list. */
  readonly isFilter: boolean;
}

/**
 * The amount the query might be, in poisha, or null.
 *
 * `parseMoneyToMinor` already knows about Bengali digits, `৳`, `Tk`, `BDT`,
 * accounting negatives and lakh-crore commas; anything it refuses is text.
 */
export function probeAmountMinor(raw: string): number | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed === '') return null;
  try {
    return parseMoneyToMinor(trimmed);
  } catch {
    return null;
  }
}

/**
 * Everything the matcher needs from one query string, computed once.
 *
 * A query shorter than `MIN_QUERY_LENGTH` normalised characters is **not a
 * filter**. A single character would match every row at `A-substr`, which is
 * indistinguishable from no filter but far more expensive and far more
 * surprising — and `4` returning every loan whose number contains a four is the
 * concrete bug this prevents.
 */
export function prepareQuery(raw: string): PreparedQuery {
  const text = normaliseSearchText(raw ?? '');
  const isFilter = text.length >= MIN_QUERY_LENGTH;

  if (!isFilter) {
    return { raw: raw ?? '', text, tokens: [], amountMinor: null, isFilter: false };
  }

  const tokens: PreparedToken[] = text.split(' ').map((token) => {
    const latin = isBengaliText(token) ? transliterateBengali(token) : [token];
    const b1All = distinct(latin.map(foldLatinToken));
    const b1 = b1All[0] ?? '';
    return {
      text: token,
      latin,
      b1All,
      b1,
      b2: trimFold(b1),
      skel: skeleton(b1),
      /* Only a purely numeric token is read as money. Probing `l` or `karim`
       * would be noise, and probing a token with punctuation in it cannot
       * happen — `norm` already turned the punctuation into a token break. */
      amountMinor: DIGITS_ONLY.test(token) ? probeAmountMinor(token) : null,
    };
  });

  return { raw, text, tokens, amountMinor: probeAmountMinor(raw), isFilter: true };
}

// --- documents ----------------------------------------------------------------

export interface SearchField {
  /** For diagnostics and for the caller's own tie-breaks. */
  readonly name: string;
  readonly weight: FieldWeight;
  readonly keys: SearchKeys;
}

/** A money field the raw query can be probed against, e.g. a loan's principal. */
export interface SearchAmount {
  readonly name: string;
  readonly weight: FieldWeight;
  /** Integer poisha. */
  readonly minor: number;
}

/**
 * Extra whole words that should find a row — a category's `searchAliases`.
 *
 * **Not a field.** A field is indexed text and every rung of the ladder is
 * allowed at it, right down to an unanchored fragment of its fold. An alias is
 * a word somebody wrote down on purpose, so it is matched as a *whole word and
 * nothing less*: exact, exact-after-transliteration, exact-after-folding, and
 * then it stops. Two reasons, both measured.
 *
 * The first is that the partial rungs would buy nothing here. `restaurant` is
 * already reached by its own exact spelling; letting `resta` prefix-match it
 * only duplicates what the row's real name already does at a higher tier.
 *
 * The second is the false-positive budget. A seeded category carries ten
 * aliases on average, so opening the substring and fold-fragment rungs to them
 * would grow the searchable surface of the tree several-fold — and `A_SUBSTR`
 * alone would hand `ant` to খাবার ও বাজার through `Restaurant`, and `roc` to it
 * through `Grocery`. The rungs that produced every measured false positive
 * against the English dictionary are exactly the partial ones; aliases never
 * reach them. Even the one non-literal rung they do reach, the whole-key fold,
 * carries a stricter gate than a name does — see `MIN_ALIAS_B1_EXACT`, which is
 * the constant that cost the most measurement.
 */
export interface SearchAliases {
  /** Reported as `matchedField`, so a hit says it came from an alias. */
  readonly name: string;
  /**
   * **`SECONDARY` is the intended weight**, and the twenty points it costs are
   * the whole ordering rule. An alias hit lands on `A_EXACT`, so it scores 1220
   * — below a row whose own name *is* the query (1240, `A_EXACT` + `PRIMARY`)
   * and above every partial match there is (`A_PREFIX` peaks at 1140). Somebody
   * typing `restaurant` knows what they want, so it must not rank under a fuzzy
   * transliteration; somebody typing a category's actual name wants that row
   * first. Both hold, by arithmetic, at every field bonus and every penalty.
   */
  readonly weight: FieldWeight;
  /** One key set per alias, empty aliases already dropped. */
  readonly keys: readonly SearchKeys[];
}

export interface SearchDoc<T> {
  /** Stable identity, the last tie-break, so the order is total. */
  readonly id: string;
  readonly row: T;
  readonly fields: readonly SearchField[];
  readonly amounts?: readonly SearchAmount[];
  readonly aliases?: SearchAliases;
  /**
   * The entity's own natural order, ascending — `sortOrder` for categories and
   * accounts, the epoch of `createdAt` for people, the negated epoch of
   * `loanDate` for loans. Applied only after score and matched-field length.
   */
  readonly order?: number;
}

export function searchField(
  name: string,
  weight: FieldWeight,
  raw: string | null | undefined,
): SearchField {
  return { name, weight, keys: buildSearchKeys(raw) };
}

/**
 * Build the alias candidate set for one row. Blank entries are dropped rather
 * than indexed: an alias of `''` would carry an empty key that matches nothing
 * and costs a comparison on every token of every query.
 *
 * Aliases are stored as the user wrote them and normalised here, so `Khabar O
 * Bajar` and `khabar o bajar` are one key. De-duplication is the caller's job —
 * it is the one that can refuse a duplicate with a message.
 */
export function searchAliasField(
  name: string,
  weight: FieldWeight,
  values: readonly string[] | null | undefined,
): SearchAliases {
  const keys = (values ?? []).map((value) => buildSearchKeys(value)).filter((k) => k.text !== '');
  return { name, weight, keys };
}

export interface SearchHit<T> {
  readonly id: string;
  readonly row: T;
  readonly score: number;
  /** Null only in the unfiltered result of a query that is not a filter. */
  readonly tier: SearchTier | null;
  readonly bucket: SearchBucket;
  /** The field that produced the row's decisive (weakest) token match. */
  readonly matchedField: string | null;
}

export interface SearchResult<T> {
  /** False when the query was not a filter: `hits` is the untouched list. */
  readonly filtered: boolean;
  readonly hits: readonly SearchHit<T>[];
  /** The C/D bucket, empty unless A+B found fewer than `SUGGESTION_THRESHOLD`. */
  readonly suggestions: readonly SearchHit<T>[];
}

export interface SearchOptions {
  /**
   * Turn the suggestion bucket off entirely. Set by every caller that returns a
   * bare list with nowhere to mark a row as a guess — the loans list, and the
   * category/person resolution behind the transaction filter.
   */
  readonly allowSuggestions?: boolean;
  readonly suggestionThreshold?: number;
}

interface TokenHit {
  readonly tier: SearchTier;
  readonly score: number;
  readonly field: string;
  readonly fieldLength: number;
}

function better(a: TokenHit | null, b: TokenHit | null): TokenHit | null {
  if (a === null) return b;
  if (b === null) return a;
  if (b.score > a.score) return b;
  if (b.score === a.score && b.fieldLength < a.fieldLength) return b;
  return a;
}

/**
 * The best tier one query token reaches against one field, and its score.
 *
 * Checked highest band first and returned on the first hit, so the tiers below
 * never need to know they were beaten. `A-prefix` is the *field-initial* case
 * and `A-boundary` is any later token: two tiers rather than one because
 * `খাবার` starting the name is a better answer than `বাজার` sitting in the
 * middle of it, and both are better than a bare substring.
 */
function matchTokenAgainstField(
  token: PreparedToken,
  query: PreparedQuery,
  field: SearchField,
  allowSuggestions: boolean,
): { main: TokenHit | null; suggestion: TokenHit | null } {
  const keys = field.keys;
  const w = field.weight;
  const fieldLength = keys.text.length;
  if (keys.text === '') return { main: null, suggestion: null };

  const hit = (tier: SearchTier, matched: number, qlen: number, distance = 0): TokenHit => ({
    tier,
    score: scoreFor(tier, w, matched, qlen, distance),
    field: field.name,
    fieldLength,
  });

  // --- A: the same bytes ------------------------------------------------------
  if (query.text === keys.text || token.text === keys.text) {
    return { main: hit('A_EXACT', 0, 0), suggestion: null };
  }
  const first = keys.tokens[0];
  if (first !== undefined && first.startsWith(token.text)) {
    return { main: hit('A_PREFIX', first.length, token.text.length), suggestion: null };
  }
  {
    let shortest = -1;
    for (const t of keys.tokens) {
      if (!t.startsWith(token.text)) continue;
      if (shortest < 0 || t.length < shortest) shortest = t.length;
    }
    if (shortest >= 0) {
      return { main: hit('A_BOUNDARY', shortest, token.text.length), suggestion: null };
    }
  }
  /* `MIN_QUERY_LENGTH` applies per token at the substring tier, not only to the
   * whole query. Its own justification — "a one-character query would return
   * everything at A-substr, which is indistinguishable from no filter but far
   * more expensive and far more surprising" — is just as true of one token of
   * several: without this, `৳5,000.00` splits into `5`, `000`, `00` and the
   * bare `5` finds every loan with a five anywhere in its phone number. Exact,
   * prefix and boundary matches are still allowed at any length. */
  if (token.text.length >= MIN_QUERY_LENGTH && keys.text.includes(token.text)) {
    return { main: hit('A_SUBSTR', keys.text.length, token.text.length), suggestion: null };
  }

  // --- T: transliterated, whichever side is Bengali ---------------------------
  for (const forms of keys.latin) {
    if (forms.includes(token.text)) return { main: hit('T_EXACT', 0, 0), suggestion: null };
  }
  for (const t of keys.tokens) {
    if (token.latin.includes(t)) return { main: hit('T_EXACT', 0, 0), suggestion: null };
  }
  {
    let best: TokenHit | null = null;
    for (const forms of keys.latin) {
      for (const form of forms) {
        if (!form.startsWith(token.text)) continue;
        best = better(best, hit('T_PREFIX', form.length, token.text.length));
      }
    }
    for (const t of keys.tokens) {
      for (const form of token.latin) {
        if (form === '' || !t.startsWith(form)) continue;
        best = better(best, hit('T_PREFIX', t.length, form.length));
      }
    }
    if (best !== null) return { main: best, suggestion: null };
  }

  // --- B1 / B2: the folds -----------------------------------------------------
  /* Every B rung below the whole-key identity is gated on consonants rather
   * than characters, because `a` at this rung is not a vowel, it is the place
   * where a vowel used to be. See `MIN_B_CONSONANTS`. */
  const consonants = countConsonants(token.skel);
  const partialB = consonants >= MIN_B_CONSONANTS;

  if (token.b1.length >= MIN_B1_EXACT) {
    for (const forms of keys.b1) {
      if (forms.some((f) => token.b1All.includes(f))) {
        return { main: hit('B1_EXACT', 0, 0), suggestion: null };
      }
    }
  }
  if (partialB && token.b1.length >= MIN_B1_PARTIAL) {
    let best: TokenHit | null = null;
    for (const forms of keys.b1) {
      for (const form of forms) {
        if (!form.startsWith(token.b1)) continue;
        best = better(best, hit('B1_PREFIX', form.length, token.b1.length));
      }
    }
    if (best !== null) return { main: best, suggestion: null };
  }
  if (partialB && token.b2.length >= MIN_B2) {
    for (const forms of keys.b2) {
      if (forms.includes(token.b2)) return { main: hit('B2_EXACT', 0, 0), suggestion: null };
    }
    let best: TokenHit | null = null;
    for (const forms of keys.b2) {
      for (const form of forms) {
        if (!form.startsWith(token.b2)) continue;
        best = better(best, hit('B2_PREFIX', form.length, token.b2.length));
      }
    }
    if (best !== null) return { main: best, suggestion: null };
  }

  if (!allowSuggestions) return { main: null, suggestion: null };

  // --- C / D / B1-substr: the suggestions bucket ------------------------------
  if (consonants >= MIN_C_CONSONANTS) {
    for (const forms of keys.skel) {
      if (forms.includes(token.skel)) return { main: null, suggestion: hit('C_EXACT', 0, 0) };
    }
  }
  if (consonants >= MIN_C_PREFIX_CONSONANTS) {
    let best: TokenHit | null = null;
    for (const forms of keys.skel) {
      for (const form of forms) {
        if (!form.startsWith(token.skel)) continue;
        best = better(best, hit('C_PREFIX', form.length, token.skel.length));
      }
    }
    if (best !== null) return { main: null, suggestion: best };
  }

  /* The last two rungs score within ten points of each other, so neither may
   * return early over the other: they are compared, not ordered. */
  let weakest: TokenHit | null = null;

  /* Never fuzzy-match digits. `L-0001` and `L-0002` are one edit apart and are
   * two different loans; a typo tolerance that cannot tell them apart is the
   * same bug the digit exemption in the fold exists to prevent. */
  const budget = /[0-9]/.test(token.b1) ? 0 : maxDistanceFor(token.b1.length);
  if (budget > 0) {
    let bestDistance = budget + 1;
    for (const forms of keys.b1) {
      const form = forms[0];
      if (form === undefined || form === '') continue;
      const d = boundedDamerauLevenshtein(token.b1, form, budget);
      if (d < bestDistance) bestDistance = d;
    }
    if (bestDistance <= budget) weakest = better(weakest, hit('D_FUZZY', 0, 0, bestDistance));
  }

  /* B1-substr, the weakest rung there is: the query's fold appears somewhere
   * inside the row's, aligned to nothing. See `TIER_BUCKET`. */
  if (partialB && token.b1.length >= MIN_B1_PARTIAL && keys.b1Text.includes(token.b1)) {
    weakest = better(weakest, hit('B1_SUBSTR', keys.b1Text.length, token.b1.length));
  }

  return { main: null, suggestion: weakest };
}

/**
 * The best rung one query token reaches against one row's **one-word** aliases.
 *
 * Three ways in, and no fourth:
 *
 *  - the token **is** the alias after normalisation — `uber`. `A_EXACT`.
 *  - the two share a transliteration, which is the Bengali query `রিকশা`
 *    reaching the Latin alias `Riksha`, and equally a Latin query reaching an
 *    alias somebody typed in Bengali. `T_EXACT`. Symmetric, and free of any
 *    false-positive cost in Latin: for two Latin words it degenerates to the
 *    check above, because a Latin token's only "transliteration" is itself.
 *  - the two share a whole `b1` key, which is the Banglish spelling nobody
 *    agrees on: `poribahan` and `poribohon` fold to the same thing. `B1_EXACT`
 *    — the same rung a fold identity against a *name* earns, because it is the
 *    same evidence, and putting it higher would price a collapsed vowel as if
 *    the user had written the word out.
 *
 * **A phrase alias matches as a phrase, and only there** — `Cash Out` is
 * reached by typing `cash out`, never by typing `out`. Letting each word of a
 * phrase satisfy a token on its own was measured against the English
 * dictionary and it is where the noise came from: `out`, `send`, `current`,
 * `flat` and `duty` each became a category, and `?q=out` would then scope the
 * transaction filter to ব্যাংক চার্জ. A word worth matching alone is worth
 * listing alone, which is why `Bhara`, `Bill` and `Charge` are each their own
 * alias next to the phrases that contain them.
 */
function matchTokenAgainstAliases(token: PreparedToken, aliases: SearchAliases): TokenHit | null {
  let best: TokenHit | null = null;

  for (const keys of aliases.keys) {
    if (keys.tokens.length !== 1) continue;
    const aliasToken = keys.tokens[0] as string;
    if (aliasToken.length < MIN_QUERY_LENGTH) continue;

    const hit = (tier: SearchTier): TokenHit => ({
      tier,
      score: scoreFor(tier, aliases.weight, 0, 0),
      field: aliases.name,
      fieldLength: keys.text.length,
    });

    if (token.text === aliasToken) {
      best = better(best, hit('A_EXACT'));
      continue;
    }
    const forms = keys.latin[0] ?? [];
    if (forms.some((form) => token.latin.includes(form))) {
      best = better(best, hit('T_EXACT'));
      continue;
    }
    if (token.b1.length < MIN_ALIAS_B1_EXACT) continue;
    const folds = keys.b1[0] ?? [];
    if (folds.some((fold) => token.b1All.includes(fold))) best = better(best, hit('B1_EXACT'));
  }

  return best;
}

interface DocEvaluation<T> {
  readonly main: SearchHit<T> | null;
  readonly suggestion: SearchHit<T> | null;
  /** Sum across tokens, the tie-break between two equally weak rows. */
  readonly sum: number;
  /**
   * Length of whatever produced the decisive hit — a field's text, or the one
   * alias that matched. Carried out of here rather than looked up again by
   * name, because an alias has no entry in `fields` to look up.
   */
  readonly length: number;
}

function evaluateDoc<T>(
  doc: SearchDoc<T>,
  query: PreparedQuery,
  allowSuggestions: boolean,
): DocEvaluation<T> {
  /* The amount probe is an OR, not part of the AND: `5000` finds the loan whose
   * principal is exactly ৳5,000.00 whatever its text says, which is the
   * behaviour the loans list has today and must not lose. Exact poisha
   * equality, so ৳5,000.50 is a different loan. */
  if (query.amountMinor !== null) {
    for (const amount of doc.amounts ?? []) {
      if (amount.minor !== query.amountMinor) continue;
      const score = scoreFor('A_EXACT', amount.weight, 0, 0);
      return {
        main: {
          id: doc.id,
          row: doc.row,
          score,
          tier: 'A_EXACT',
          bucket: 'main',
          matchedField: amount.name,
        },
        suggestion: null,
        sum: score,
        length: 0,
      };
    }
  }

  /* The whole query **is** one of the aliases, spaces and all.
   *
   * Satisfies the per-token AND on its own, because a multi-word alias may
   * contain a word too short to be a token of anything — the `ও` of `Khabar O
   * Bajar` — and no per-token rule should be allowed to lose a match the user
   * typed out in full and exactly right.
   *
   * Merged at the end rather than returned here, unlike the amount probe above.
   * Returning early would have made `transport` score 1220 through যাতায়াত's
   * alias list instead of 1240 through যাতায়াত's own name: the same row and the
   * same answer, but the wrong reason and a rank the next row could beat. */
  const wholeQueryAlias =
    doc.aliases === undefined ? null : wholeQueryAliasHit(doc.aliases, query.text);

  let mainMin: TokenHit | null = null;
  let mainSum = 0;
  let allMain = true;

  let anyMin: TokenHit | null = null;
  let anySum = 0;
  let allAny = true;

  for (const token of query.tokens) {
    let bestMain: TokenHit | null = null;
    let bestAny: TokenHit | null = null;

    /* A numeric token satisfies its half of the AND by being the amount, which
     * is what turns `karim 5000` into "করিম and ৳5,000" instead of a literal
     * string that matches nothing. Exact poisha equality, always. */
    if (token.amountMinor !== null) {
      for (const amount of doc.amounts ?? []) {
        if (amount.minor !== token.amountMinor) continue;
        const hit: TokenHit = {
          tier: 'A_EXACT',
          score: scoreFor('A_EXACT', amount.weight, 0, 0),
          field: amount.name,
          fieldLength: 0,
        };
        bestMain = better(bestMain, hit);
        bestAny = better(bestAny, hit);
      }
    }

    for (const field of doc.fields) {
      const { main, suggestion } = matchTokenAgainstField(token, query, field, allowSuggestions);
      bestMain = better(bestMain, main);
      bestAny = better(better(bestAny, main), suggestion);
    }

    /* Aliases produce main results only, whatever `allowSuggestions` says: an
     * exact word is never a guess, and the callers that switch suggestions off
     * — the loans list, the category resolution behind the transaction filter —
     * are precisely the ones that most need `poribohon` to work. */
    if (doc.aliases !== undefined) {
      const alias = matchTokenAgainstAliases(token, doc.aliases);
      bestMain = better(bestMain, alias);
      bestAny = better(bestAny, alias);
    }

    if (bestMain === null) allMain = false;
    else {
      mainSum += bestMain.score;
      /* A row is only as good as its worst-matching token: the minimum decides
       * the rank and the sum only breaks ties between rows that are equally
       * weak. Taking the maximum instead would let one strong token drag a row
       * up past rows that matched the whole query. */
      if (mainMin === null || bestMain.score < mainMin.score) mainMin = bestMain;
    }

    if (bestAny === null) allAny = false;
    else {
      anySum += bestAny.score;
      if (anyMin === null || bestAny.score < anyMin.score) anyMin = bestAny;
    }
  }

  /* The decisive token hit, or the whole-query alias where that did better.
   * `better` is the same comparison every token already used, so the alias wins
   * only where it genuinely scores higher — and a row whose own name is the
   * query keeps its 1240. */
  const decisive = better(allMain ? mainMin : null, wholeQueryAlias);

  const main =
    decisive !== null
      ? {
          id: doc.id,
          row: doc.row,
          score: decisive.score,
          tier: decisive.tier,
          bucket: 'main' as const,
          matchedField: decisive.field,
        }
      : null;

  const suggestion =
    main === null && allAny && anyMin !== null
      ? {
          id: doc.id,
          row: doc.row,
          score: anyMin.score,
          tier: anyMin.tier,
          bucket: 'suggestion' as const,
          matchedField: anyMin.field,
        }
      : null;

  /* `sum` is per-token, so a whole-query alias that carried the row on its own
   * contributes its score once per token — it did satisfy all of them. */
  const aliasSum = wholeQueryAlias === null ? 0 : wholeQueryAlias.score * query.tokens.length;

  return {
    main,
    suggestion,
    sum: main === null ? anySum : Math.max(allMain ? mainSum : 0, aliasSum),
    length: (main !== null ? decisive?.fieldLength : anyMin?.fieldLength) ?? 0,
  };
}

/**
 * The alias a whole query reproduces exactly, if any. Normalised on both sides,
 * so `Khabar O Bajar` and `khabar o bajar` are the same query.
 */
function wholeQueryAliasHit(aliases: SearchAliases, queryText: string): TokenHit | null {
  for (const keys of aliases.keys) {
    if (keys.text !== queryText) continue;
    return {
      tier: 'A_EXACT',
      score: scoreFor('A_EXACT', aliases.weight, 0, 0),
      field: aliases.name,
      fieldLength: keys.text.length,
    };
  }
  return null;
}

interface Ranked<T> {
  readonly hit: SearchHit<T>;
  readonly sum: number;
  readonly fieldLength: number;
  readonly order: number;
}

function rank<T>(rows: readonly Ranked<T>[]): SearchHit<T>[] {
  return rows
    .slice()
    .sort((a, b) => {
      if (b.hit.score !== a.hit.score) return b.hit.score - a.hit.score;
      if (b.sum !== a.sum) return b.sum - a.sum;
      if (a.fieldLength !== b.fieldLength) return a.fieldLength - b.fieldLength;
      if (a.order !== b.order) return a.order - b.order;
      return a.hit.id < b.hit.id ? -1 : a.hit.id > b.hit.id ? 1 : 0;
    })
    .map((r) => r.hit);
}

/**
 * Match and rank a short list in memory: categories, accounts, people, loans.
 *
 * Multi-token queries are **AND** — every token must hit *some* field, and
 * different tokens may hit different fields, so `karim 5000` means "করিম and
 * ৫০০০" rather than the literal string. Tie-breaks run score, then the sum
 * across tokens, then the shorter matched field, then the entity's own natural
 * order, then `id`, so the order is total and deterministic.
 *
 * Scope — `workspaceId`, `deletedAt: null`, `isArchived: false` for pickers,
 * `systemKey: null` for accounts — is the caller's job and must be applied
 * *before* any key is built. Nothing here can rescue a row that should never
 * have been in the list.
 */
export function searchDocs<T>(
  docs: readonly SearchDoc<T>[],
  rawQuery: string,
  options: SearchOptions = {},
): SearchResult<T> {
  const query = prepareQuery(rawQuery);

  if (!query.isFilter) {
    return {
      filtered: false,
      hits: docs.map((doc) => ({
        id: doc.id,
        row: doc.row,
        score: 0,
        tier: null,
        bucket: 'main' as const,
        matchedField: null,
      })),
      suggestions: [],
    };
  }

  const allowSuggestions = options.allowSuggestions ?? true;
  const threshold = options.suggestionThreshold ?? SUGGESTION_THRESHOLD;

  const mains: Ranked<T>[] = [];
  const suggestions: Ranked<T>[] = [];

  docs.forEach((doc, index) => {
    const evaluation = evaluateDoc(doc, query, allowSuggestions);
    const order = doc.order ?? index;
    if (evaluation.main !== null) {
      mains.push({
        hit: evaluation.main,
        sum: evaluation.sum,
        fieldLength: evaluation.length,
        order,
      });
      return;
    }
    if (evaluation.suggestion !== null) {
      suggestions.push({
        hit: evaluation.suggestion,
        sum: evaluation.sum,
        fieldLength: evaluation.length,
        order,
      });
    }
  });

  /* C and D only run when A and B between them found almost nothing. `khabar`
   * never shows skeleton noise, because A/B already found the answer. */
  const showSuggestions = allowSuggestions && mains.length < threshold;

  return {
    filtered: true,
    hits: rank(mains),
    suggestions: showSuggestions ? rank(suggestions) : [],
  };
}

// --- what is deliberately not here --------------------------------------------

/*
 * **There is no `buildStoredSearchKeys`, and there should not be.**
 *
 * A pair of exported helpers used to live here — `buildStoredSearchKeys` and
 * `storedFoldNeedle` — that computed a `searchNorm`/`searchFold` pair for a
 * transaction row to carry in two materialised columns. They were thoroughly
 * tested and called from nowhere, which is the worst state code can be in: it
 * reads as a shipped feature, and a comment in `categories.service.ts` had
 * already started citing it as "what transactions do". Transactions did not.
 *
 * The design was rejected, not merely unbuilt. Materialising the fold means
 * copying the category name and the counterparty name onto every transaction
 * row; the copy is correct exactly until somebody renames a category, and then
 * it is silently wrong, with nothing on screen to say a row has stopped being
 * findable. The fix would be a backfill nobody knows to run.
 *
 * `transactions.service.ts` does it the way that cannot drift: it resolves the
 * query against the category and person lists — dozens of rows, already
 * matched in memory by `searchDocs` — and filters the ledger on the ids that
 * come back. Two small reads on a search, none at all on the unfiltered list,
 * no schema change, no backfill, and no second copy of a name to go stale.
 */
