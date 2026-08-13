import { describe, expect, it } from 'vitest';
import {
  COMMON_QUANTITY_UNITS,
  MAX_CUSTOM_UNITS,
  normaliseUnit,
  normaliseUnitList,
  unitSuggestions,
} from './units.js';

describe('normaliseUnit', () => {
  it('folds case and collapses whitespace', () => {
    expect(normaliseUnit('  Half  Litre ')).toBe('half litre');
  });

  it('does not transliterate', () => {
    /* `kg` and `কেজি` are one unit to a person and two strings to every report
       that groups by unit. Folding them here would make the report disagree
       with the rows it summed. */
    expect(normaliseUnit('kg')).not.toBe(normaliseUnit('কেজি'));
  });
});

describe('normaliseUnitList', () => {
  it('keeps the order the workspace chose', () => {
    expect(normaliseUnitList(['গজ', 'ভরি', 'স্ট্রিপ'])).toEqual(['গজ', 'ভরি', 'স্ট্রিপ']);
  });

  it('drops a duplicate of a shipped unit', () => {
    expect(normaliseUnitList(['কেজি', 'গজ'])).toEqual(['গজ']);
  });

  it('drops a duplicate of a shipped unit that differs only in case or spacing', () => {
    expect(normaliseUnitList([' কেজি ', 'গজ'])).toEqual(['গজ']);
  });

  it('drops a repeat within the submitted list', () => {
    expect(normaliseUnitList(['গজ', 'গজ ', 'GOJ'])).toEqual(['গজ', 'GOJ']);
  });

  it('drops empties and whitespace-only entries', () => {
    expect(normaliseUnitList(['', '   ', 'গজ'])).toEqual(['গজ']);
  });

  it('drops an entry longer than a unit can be saved as', () => {
    const tooLong = 'অ'.repeat(21);
    expect(normaliseUnitList([tooLong, 'গজ'])).toEqual(['গজ']);
  });

  it('caps the list', () => {
    const many = Array.from({ length: MAX_CUSTOM_UNITS + 10 }, (_, i) => `unit${i}`);
    expect(normaliseUnitList(many)).toHaveLength(MAX_CUSTOM_UNITS);
  });
});

describe('unitSuggestions', () => {
  it('offers the shipped units when the workspace has added none', () => {
    expect(unitSuggestions([])).toEqual([...COMMON_QUANTITY_UNITS]);
    expect(unitSuggestions(null)).toEqual([...COMMON_QUANTITY_UNITS]);
  });

  it('puts the workspace’s own after the shipped ones', () => {
    const suggestions = unitSuggestions(['গজ']);
    expect(suggestions[suggestions.length - 1]).toBe('গজ');
    expect(suggestions).toHaveLength(COMMON_QUANTITY_UNITS.length + 1);
  });

  it('never shows a unit twice, whatever is stored', () => {
    /* The column could already hold a duplicate from before the API cleaned
       the list; the dropdown must still show each unit once. */
    const suggestions = unitSuggestions(['কেজি', 'গজ', 'গজ']);
    expect(new Set(suggestions).size).toBe(suggestions.length);
  });
});
