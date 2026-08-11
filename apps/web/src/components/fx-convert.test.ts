import { describe, expect, it } from 'vitest';
import { convert } from './fx-convert';

/**
 * The conversion, which is the only arithmetic in this feature and the only
 * place a float could get into the money path.
 *
 * `convert` deliberately does not do `Number(rate) * amount`. A rate is typed
 * as a decimal string, so it is split into an integer and a scale — 110.25
 * becomes 11025 over 100 — and every multiplication happens on integers before
 * one final division. The tests below are the ones that would fail if somebody
 * "simplified" it back to floats.
 */

describe('converting a foreign amount at a declared rate', () => {
  it('turns $100 at 110 into ৳11,000', () => {
    // 10,000 cents × 110 → 1,100,000 poisha.
    expect(convert(10_000, 'USD', '110', 'BDT')).toBe(1_100_000);
  });

  it('keeps a fractional rate exact', () => {
    // 110.25 × $100 = ৳11,025 exactly. `0.1 + 0.2` arithmetic would drift here.
    expect(convert(10_000, 'USD', '110.25', 'BDT')).toBe(1_102_500);
    expect(convert(10_000, 'USD', '110.253', 'BDT')).toBe(1_102_530);
  });

  it('crosses currencies with different minor units', () => {
    /* A yen has none and a taka has a hundred, so the units have to cancel
       rather than be assumed. ¥1,000 at 0.75 is ৳750. */
    expect(convert(1_000, 'JPY', '0.75', 'BDT')).toBe(75_000);
    // The other way: ৳750 at 1.3333 yen per taka is ¥999 (truncated).
    expect(convert(75_000, 'BDT', '1.3333', 'JPY')).toBe(999);
    // A dinar's thousand fils: 1.500 KWD at 400 is ৳600.
    expect(convert(1_500, 'KWD', '400', 'BDT')).toBe(60_000);
  });

  it('truncates rather than rounding up', () => {
    // The same rule `parseMoneyToMinor` has always applied to extra decimals.
    expect(convert(1, 'USD', '110.999', 'BDT')).toBe(110);
  });

  it('refuses a rate that is not a number, so nothing is silently written', () => {
    for (const bad of ['', '.', 'abc', '-5', '1,10', '1.2.3']) {
      expect(convert(10_000, 'USD', bad, 'BDT'), `"${bad}" should not convert`).toBeNull();
    }
    expect(convert(10_000, 'USD', '0', 'BDT')).toBeNull();
  });

  it('refuses an amount large enough to leave safe integer range', () => {
    /* Better a null and a visible "—" than a number that has quietly stopped
       being exact. */
    expect(convert(Number.MAX_SAFE_INTEGER, 'USD', '110', 'BDT')).toBeNull();
  });
});
