import { describe, expect, it } from 'vitest';
import {
  allocateMinor,
  formatMinor,
  groupLakhCrore,
  MoneyParseError,
  parseMoneyToMinor,
  sumMinor,
  toAsciiDigits,
  toBengaliDigits,
} from './money.js';

describe('parseMoneyToMinor', () => {
  it('parses plain and grouped amounts', () => {
    expect(parseMoneyToMinor('1234')).toBe(123400);
    expect(parseMoneyToMinor('1,234.56')).toBe(123456);
    expect(parseMoneyToMinor('18,46,200')).toBe(184620000);
  });

  it('parses Bengali numerals', () => {
    expect(parseMoneyToMinor('১,২৩৪.৫৬')).toBe(123456);
    expect(parseMoneyToMinor('৳ ৫০০')).toBe(50000);
  });

  it('strips currency markers', () => {
    expect(parseMoneyToMinor('Tk. 1000')).toBe(100000);
    expect(parseMoneyToMinor('BDT 25.5')).toBe(2550);
    expect(parseMoneyToMinor('৳1,000.00')).toBe(100000);
  });

  it('handles negatives including accounting parentheses', () => {
    expect(parseMoneyToMinor('-45')).toBe(-4500);
    expect(parseMoneyToMinor('(1,234.00)')).toBe(-123400);
  });

  it('truncates beyond two decimals rather than rounding up', () => {
    expect(parseMoneyToMinor('1.999')).toBe(199);
  });

  it('rejects junk', () => {
    expect(() => parseMoneyToMinor('abc')).toThrow(MoneyParseError);
    expect(() => parseMoneyToMinor('')).toThrow(MoneyParseError);
    expect(() => parseMoneyToMinor('1.2.3')).toThrow(MoneyParseError);
  });
});

describe('formatMinor', () => {
  it('groups the South Asian way', () => {
    expect(formatMinor(184620000)).toBe('৳18,46,200.00');
    expect(formatMinor(100000)).toBe('৳1,000.00');
    expect(formatMinor(12345)).toBe('৳123.45');
  });

  it('renders Bengali numerals on request', () => {
    expect(formatMinor(184620000, { bengaliNumerals: true, decimals: false })).toBe('৳১৮,৪৬,২০০');
  });

  it('keeps the sign in front of the symbol', () => {
    expect(formatMinor(-50000)).toBe('-৳500.00');
    expect(formatMinor(50000, { signed: true })).toBe('+৳500.00');
  });

  it('refuses floats', () => {
    expect(() => formatMinor(12.5)).toThrow(TypeError);
  });
});

describe('digit conversion', () => {
  it('round-trips', () => {
    expect(toBengaliDigits('2026')).toBe('২০২৬');
    expect(toAsciiDigits('২০২৬')).toBe('2026');
  });
});

describe('groupLakhCrore', () => {
  it('groups by 3 then 2', () => {
    expect(groupLakhCrore('100')).toBe('100');
    expect(groupLakhCrore('1000')).toBe('1,000');
    expect(groupLakhCrore('100000')).toBe('1,00,000');
    expect(groupLakhCrore('10000000')).toBe('1,00,00,000');
  });
});

describe('sumMinor', () => {
  it('adds integers', () => {
    expect(sumMinor([100, 250, -50])).toBe(300);
  });
  it('throws on a stray float', () => {
    expect(() => sumMinor([100, 0.5])).toThrow(TypeError);
  });
});

describe('allocateMinor', () => {
  it('never loses a poisha', () => {
    const parts = allocateMinor(1000, 3);
    expect(parts).toEqual([334, 333, 333]);
    expect(sumMinor(parts)).toBe(1000);
  });
  it('handles negatives', () => {
    const parts = allocateMinor(-1000, 3);
    expect(sumMinor(parts)).toBe(-1000);
  });
});
