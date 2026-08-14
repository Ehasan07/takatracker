import { beforeEach, describe, expect, it } from 'vitest';
import { GUIDE } from '@/content/guide';
import { EN } from '@/i18n/en';
import { setActiveLocale } from '@/lib/format';
import { setTranslationOverrides, t } from '@/lib/t';
import {
  ALL_DESTINATIONS,
  GROUPS,
  OPERATOR_PRIMARY,
  PRIMARY,
  blurbOf,
  groupTitleOf,
  labelOf,
  matchesQuery,
  tabLabelOf,
  titleFor,
} from '@/components/nav-model';

/**
 * The three layers, and the one property that matters more than any of them:
 * a string can never come out empty or as its own key.
 */
describe('t', () => {
  beforeEach(() => {
    setActiveLocale('bn');
    setTranslationOverrides({});
  });

  it('gives the Bengali written at the call site', () => {
    expect(t('nav.dashboard', 'ড্যাশবোর্ড')).toBe('ড্যাশবোর্ড');
  });

  it('gives the shipped English when the books are in English', () => {
    setActiveLocale('en');
    expect(t('nav.dashboard', 'ড্যাশবোর্ড')).toBe('Dashboard');
  });

  it('falls back to the Bengali for a key the catalogue has not got', () => {
    /* The worst failure this design allows is the string the screen already
       says — never a blank, and never `some.dotted.key` in the interface. */
    setActiveLocale('en');
    expect(t('nothing.here.yet', 'বাকি আছে')).toBe('বাকি আছে');
  });

  it('lets a workspace override either language', () => {
    setTranslationOverrides({ 'nav.transactions': 'Cashbook' });
    setActiveLocale('en');
    expect(t('nav.transactions', 'খাতা')).toBe('Cashbook');
    setActiveLocale('bn');
    expect(t('nav.transactions', 'খাতা')).toBe('Cashbook');
  });
});

describe('navigation', () => {
  beforeEach(() => {
    setActiveLocale('en');
    setTranslationOverrides({});
  });

  it('has an English name for every destination', () => {
    /* The check that keeps the catalogue honest as screens are added: a new row
       in `nav-model.ts` with no entry here would render Bengali on an English
       sidebar, and nothing else would notice. */
    const missing = ALL_DESTINATIONS.filter((item) => labelOf(item) === item.label);
    expect(missing.map((item) => item.href)).toEqual([]);
  });

  it('has an English blurb for every destination that has one', () => {
    const missing = ALL_DESTINATIONS.filter(
      (item) => item.blurb !== undefined && blurbOf(item) === item.blurb,
    );
    expect(missing.map((item) => item.href)).toEqual([]);
  });

  it('never prints a Bengali short label on an English tab bar', () => {
    /* Five cells across 320px, so the tab label is not the full name — which
       means it cannot fall back to one either. */
    for (const item of [...PRIMARY, ...OPERATOR_PRIMARY]) {
      const tab = tabLabelOf(item);
      expect(tab).not.toBe(item.tabLabel);
      expect(tab).not.toMatch(/[ঀ-৿]/);
    }
  });

  it('names every group', () => {
    for (const group of GROUPS) {
      expect(groupTitleOf(group)).not.toMatch(/[ঀ-৿]/);
    }
  });

  it('titles a route the shell knows, and the brand when it does not', () => {
    expect(titleFor('/transactions')).toBe('Transactions');
    expect(titleFor('/loans/abc/statement')).toBe('Loan statement');
    /* Longest-prefix, so a screen below a known one inherits its title. */
    expect(titleFor('/loans/abc')).toBe('Loans');
    /* Not a translation — the brand is the same word in both. */
    expect(titleFor('/nowhere-at-all')).toBe('Taka Tracker');
  });

  it('finds a destination by a word the reader can actually see', () => {
    const transactions = PRIMARY.find((item) => item.href === '/transactions')!;
    expect(matchesQuery(transactions, 'Transactions')).toBe(true);
    /* And still by the Bengali, which is what the row is written as. */
    expect(matchesQuery(transactions, 'খাতা')).toBe(true);
  });

  it('leaves the Bengali alone when the books are in Bengali', () => {
    setActiveLocale('bn');
    const dashboard = PRIMARY[0]!;
    expect(labelOf(dashboard)).toBe('ড্যাশবোর্ড');
    expect(tabLabelOf(dashboard)).toBe('হোম');
    expect(titleFor('/transactions')).toBe('খাতা');
  });
});

describe('the catalogue', () => {
  it('has no empty strings in it', () => {
    /* An empty value resolves as falsy and silently hands back the Bengali,
       which looks exactly like a missing key and is much harder to find. */
    const empty = Object.entries(EN).filter(([, value]) => value.trim() === '');
    expect(empty.map(([key]) => key)).toEqual([]);
  });

  it('has nothing Bengali left in it', () => {
    /* ৳ (U+09F3) is cut out of the block. It lives in the Bengali range but it
       is not Bengali text — `formatMinor` prints it on an English screen too,
       because the currency of these books is the taka whichever language they
       are read in. An English sentence quoting an amount has to be allowed to
       spell it the way the screen does. */
    const untranslated = Object.entries(EN).filter(([, value]) => /[ঀ-৲৴-৿]/.test(value));
    expect(untranslated.map(([key]) => key)).toEqual([]);
  });
});

describe('every key a screen asks for', () => {
  /**
   * The check that keeps the catalogue from silently falling behind.
   *
   * A `t('some.key', 'বাংলা')` with no entry in `en.ts` is not an error at
   * runtime — the reader gets the Bengali, which is the whole point of the
   * fallback. That is exactly why it needs a test: nothing else would ever
   * notice, and the screen would quietly stay Bengali for an English reader.
   *
   * Read off the source rather than a hand-kept list, so adding a string to a
   * screen and forgetting the translation fails here rather than shipping.
   */
  it('has an English entry', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');

    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) return walk(full);
        return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
      });

    const used = new Set<string>();
    for (const file of walk(join(process.cwd(), 'src'))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/[^a-zA-Z0-9_]t\(\s*'([a-zA-Z0-9._]+)'\s*,/g)) {
        used.add(match[1]!);
      }
    }

    expect(used.size).toBeGreaterThan(50);
    expect([...used].filter((key) => !(key in EN)).sort()).toEqual([]);
  });

  /**
   * The guide, whose keys the scan above cannot see.
   *
   * Its hundred-odd strings are a table, and each one is rendered with a key
   * built from a stem — `t(`${entry.key}.b`, …)`. A regular expression over the
   * source finds none of them, so the table is imported and its keys are
   * derived here the same way the component derives them. Miss this and the
   * one screen whose entire job is to explain the product is also the one
   * screen that quietly stays Bengali.
   */
  it('has an English entry for every line of the guide', () => {
    const keys = GUIDE.flatMap((group) => [
      `${group.key}.h`,
      ...(group.blurb ? [`${group.key}.s`] : []),
      ...group.entries.flatMap((entry) => [
        `${entry.key}.t`,
        `${entry.key}.w`,
        `${entry.key}.b`,
        ...(entry.note ? [`${entry.key}.n`] : []),
      ]),
    ]);

    expect(keys.length).toBeGreaterThan(80);
    expect(keys.filter((key) => !(key in EN)).sort()).toEqual([]);
  });

  /** Two entries sharing a stem would render one and hide the other. */
  it('gives every line of the guide its own key', () => {
    const stems = GUIDE.flatMap((group) => [group.key, ...group.entries.map((e) => e.key)]);
    expect(stems.length).toBe(new Set(stems).size);
  });
});
