import { describe, expect, it } from 'vitest';
import {
  COMMON_QUANTITY_UNITS,
  MAX_CUSTOM_UNITS,
  UNIT_CATALOGUE,
  commonUnits,
  normaliseUnit,
  normaliseUnitList,
  shippedUnits,
  unitGroups,
  unitSuggestions,
} from './units.js';

/* গজ, ভরি and স্ট্রিপ were the custom units in these tests until the catalogue
   grew to include all three. Anything used as "a unit the workspace added" has
   to be one the build does not ship, or the test is asserting the opposite of
   what it reads like. */
const MINE = ['তোলা', 'খাঁচা', 'ফাইল'] as const;

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

describe('the catalogue', () => {
  it('carries the units this country buys in and no international list has', () => {
    const bengali = new Set(UNIT_CATALOGUE.flatMap((g) => g.units.map((u) => u.bn)));
    for (const unit of ['মণ', 'সের', 'ভরি', 'কাঠা', 'বিঘা', 'শতক', 'হালি']) {
      expect(bengali.has(unit)).toBe(true);
    }
  });

  it('carries the US and imperial ones too', () => {
    const english = new Set(UNIT_CATALOGUE.flatMap((g) => g.units.map((u) => u.en)));
    for (const unit of ['lb', 'oz', 'gal', 'pt', 'inch', 'ft', 'acre']) {
      expect(english.has(unit)).toBe(true);
    }
  });

  it('never lists the same unit twice in one language', () => {
    const bengali = UNIT_CATALOGUE.flatMap((g) => g.units.map((u) => u.bn));
    const english = UNIT_CATALOGUE.flatMap((g) => g.units.map((u) => u.en));
    expect(new Set(bengali).size).toBe(bengali.length);
    expect(new Set(english).size).toBe(english.length);
  });

  it('keeps every unit inside what the field can save', () => {
    for (const group of UNIT_CATALOGUE) {
      for (const unit of group.units) {
        expect(unit.bn.length).toBeLessThanOrEqual(20);
        expect(unit.en.length).toBeLessThanOrEqual(20);
      }
    }
  });
});

describe('commonUnits', () => {
  it('is the Bengali shortcut list as it always was', () => {
    expect(commonUnits('bn')).toEqual([...COMMON_QUANTITY_UNITS]);
  });

  it('offers an English workspace kg rather than কেজি', () => {
    /* The picked string is *stored*, and a report groups by it. An English
       workspace being handed Bengali strings would leave its own report in a
       script it does not read. */
    expect(commonUnits('en')).toContain('kg');
    expect(commonUnits('en')).not.toContain('কেজি');
    expect(commonUnits('en')).toHaveLength(COMMON_QUANTITY_UNITS.length);
  });
});

describe('unitGroups', () => {
  it('leaves the shortcuts out, so no unit appears twice in one wheel', () => {
    const listed = unitGroups('bn').flatMap((group) => group.units);
    for (const shortcut of COMMON_QUANTITY_UNITS) {
      expect(listed).not.toContain(shortcut);
    }
  });

  it('speaks the language it is asked for', () => {
    const english = unitGroups('en').flatMap((group) => group.units);
    expect(english).toContain('maund');
    expect(english).not.toContain('মণ');
  });
});

describe('normaliseUnitList', () => {
  it('keeps the order the workspace chose', () => {
    expect(normaliseUnitList([...MINE])).toEqual([...MINE]);
  });

  it('drops a duplicate of a shipped unit', () => {
    expect(normaliseUnitList(['কেজি', MINE[0]])).toEqual([MINE[0]]);
  });

  it('drops a duplicate of anything in the catalogue, not just the shortcuts', () => {
    /* ভরি ships now. Somebody who added it first would otherwise keep a private
       copy, see it twice, and be able to remove only one of them. */
    expect(normaliseUnitList(['ভরি', 'কাঠা', MINE[0]])).toEqual([MINE[0]]);
  });

  it('drops a duplicate of the English spelling too', () => {
    expect(normaliseUnitList(['kg', 'maund', MINE[0]])).toEqual([MINE[0]]);
  });

  it('drops a duplicate of a shipped unit that differs only in case or spacing', () => {
    expect(normaliseUnitList([' কেজি ', MINE[0]])).toEqual([MINE[0]]);
  });

  it('drops a repeat within the submitted list', () => {
    expect(normaliseUnitList([MINE[0], `${MINE[0]} `, 'TOLA'])).toEqual([MINE[0], 'TOLA']);
  });

  it('drops empties and whitespace-only entries', () => {
    expect(normaliseUnitList(['', '   ', MINE[0]])).toEqual([MINE[0]]);
  });

  it('drops an entry longer than a unit can be saved as', () => {
    const tooLong = 'অ'.repeat(21);
    expect(normaliseUnitList([tooLong, MINE[0]])).toEqual([MINE[0]]);
  });

  it('caps the list', () => {
    const many = Array.from({ length: MAX_CUSTOM_UNITS + 10 }, (_, i) => `unit${i}`);
    expect(normaliseUnitList(many)).toHaveLength(MAX_CUSTOM_UNITS);
  });
});

describe('shippedUnits', () => {
  it('covers both spellings of everything the build offers', () => {
    const all = new Set(shippedUnits());
    expect(all.has('কেজি')).toBe(true);
    expect(all.has('kg')).toBe(true);
    expect(all.has('ভরি')).toBe(true);
    expect(all.has('bhori')).toBe(true);
  });
});

describe('unitSuggestions', () => {
  it('offers the shipped units when the workspace has added none', () => {
    expect(unitSuggestions([])).toEqual([...COMMON_QUANTITY_UNITS]);
    expect(unitSuggestions(null)).toEqual([...COMMON_QUANTITY_UNITS]);
  });

  it('puts the workspace’s own after the shipped ones', () => {
    const suggestions = unitSuggestions([MINE[0]]);
    expect(suggestions[suggestions.length - 1]).toBe(MINE[0]);
    expect(suggestions).toHaveLength(COMMON_QUANTITY_UNITS.length + 1);
  });

  it('never shows a unit twice, whatever is stored', () => {
    /* The column could already hold a duplicate from before the API cleaned
       the list; the dropdown must still show each unit once. */
    const suggestions = unitSuggestions(['কেজি', MINE[0], MINE[0]]);
    expect(new Set(suggestions).size).toBe(suggestions.length);
  });
});
