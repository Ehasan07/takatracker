import { describe, expect, it } from 'vitest';
import { fromMilli, toMilli } from './quantity';

/**
 * Quantity arithmetic, which is money arithmetic with a different name.
 *
 * A float quantity summed over a year drifts, and a drifting answer to "how
 * much rice did we get through" is worse than no answer — so the stored value
 * is an integer in thousandths and nothing here goes near `parseFloat`.
 */
describe('quantity in thousandths', () => {
  it('reads whole and fractional amounts', () => {
    expect(toMilli('2')).toBe(2_000);
    expect(toMilli('1.5')).toBe(1_500);
    expect(toMilli('0.25')).toBe(250);
    // Three places is the finest anybody weighs a household purchase.
    expect(toMilli('1.234')).toBe(1_234);
    expect(toMilli('1.2345')).toBe(1_234);
  });

  it('reads Bengali numerals, because that is what the keyboard types', () => {
    expect(toMilli('২')).toBe(2_000);
    expect(toMilli('১.৫')).toBe(1_500);
  });

  it('refuses anything that is not a positive number', () => {
    for (const bad of ['', '.', 'abc', '-1', '0', '1,5', '1.2.3']) {
      expect(toMilli(bad), `"${bad}" should not parse`).toBeNull();
    }
  });

  it('prints without a false precision', () => {
    // "৩.৫০০ লিটার" reads as a price; the trailing zeros go.
    expect(fromMilli(3_500)).toBe('৩.৫');
    expect(fromMilli(5_000)).toBe('৫');
    expect(fromMilli(1_234)).toBe('১.২৩৪');
    expect(fromMilli(250)).toBe('০.২৫');
  });
});
