import { describe, expect, it } from 'vitest';
import { EN } from '@/i18n/en';
import { ACCOUNTING_NOTES, accountingNote } from './info-note';

/**
 * The notes behind the ⓘ icons on the reports screen.
 *
 * What is worth testing here is not the disclosure — a button that flips
 * `aria-expanded` is covered where it can actually be pressed, in
 * `e2e/feedback.spec.ts` — but the catalogue. Every row is a claim about what
 * this codebase does, printed beside a figure somebody may act on, and the two
 * ways it can go wrong are both silent:
 *
 *  - **The English half never arrives.** `t(key, bengali)` falls back to the
 *    Bengali, so an English reader gets an untranslated footnote and nothing
 *    fails. Same failure mode `nav-model` has, tested the same way.
 *  - **A row loses its reference.** A note that says "this is how it is done"
 *    without saying under what rule is an assertion, not a disclosure, and
 *    there is nothing for a reader to go and check.
 */
describe('the accounting notes', () => {
  it('names every note once', () => {
    const keys = ACCOUNTING_NOTES.map((note) => note.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps every key under the note. prefix', () => {
    /* The prefix is what lets the catalogue be merged into `en.ts` and audited
       there without reading this file. */
    const stray = ACCOUNTING_NOTES.filter((note) => !note.key.startsWith('note.'));
    expect(stray.map((note) => note.key)).toEqual([]);
  });

  it('carries a standard reference on every note', () => {
    /* `IAS 1.27`, `IAS 16.39`, `IFRS 15` — the paragraph is optional, the
       standard is not. A note with no citation cannot be checked. */
    const uncited = ACCOUNTING_NOTES.filter(
      (note) => !/^(IAS|IFRS) \d+(\.\d+[a-z()]*)?$/.test(note.standard),
    );
    expect(uncited.map((note) => `${note.key}: ${note.standard}`)).toEqual([]);
  });

  it('says something in Bengali, in both halves', () => {
    for (const note of ACCOUNTING_NOTES) {
      expect(note.label.trim(), note.key).not.toBe('');
      expect(note.body.trim(), note.key).not.toBe('');
      /* Written for somebody who is not an accountant, which starts with it
         being in the language they read the app in. */
      expect(note.label, note.key).toMatch(/[ঀ-৿]/);
      expect(note.body, note.key).toMatch(/[ঀ-৿]/);
    }
  });

  it('does not repeat the reference inside the body', () => {
    /* The citation is rendered separately and set apart. A body that also spells
       it out prints it twice, which reads as a mistake. */
    for (const note of ACCOUNTING_NOTES) {
      expect(note.body, note.key).not.toContain(note.standard);
    }
  });

  it('has an English entry for both halves of every note', () => {
    /* The check that keeps the catalogue from silently falling behind. A missing
       key renders the Bengali on an English screen and nothing else notices. */
    const keys = ACCOUNTING_NOTES.flatMap((note) => [`${note.key}.label`, `${note.key}.body`]);
    expect(keys.filter((key) => !(key in EN)).sort()).toEqual([]);
  });

  it('refuses a name it has never heard of', () => {
    /* A typo at a call site must fail where it is written, not render an empty
       footnote beside a balance sheet. */
    expect(() => accountingNote('note.nothing')).toThrow(/note.nothing/);
    expect(accountingNote('note.cashBasis').standard).toBe('IAS 1.27');
  });
});
