import { minorUnitsFor } from '@hishab/shared';

/**
 * The arithmetic behind "this was in another currency".
 *
 * Its own module, with no React and no network in it, so the one calculation
 * that can silently corrupt an amount is a pure function a unit test can reach
 * directly.
 */

export interface FxValue {
  currency: string;
  /** Integer minor units of `currency`. */
  amountMinor: number;
}

/**
 * A rate as typed, applied to an amount, entirely in integers.
 *
 * `rate` arrives as a decimal string because that is what a person types. It is
 * split rather than parsed as a float: `110.25` becomes 11025 over 100, and the
 * multiplication happens on integers before the single final division. Doing it
 * with `Number(rate) * amount` would be the one float in the money path, and
 * the whole codebase exists to not have that.
 */
export function convert(
  fxMinor: number,
  fxCurrency: string,
  rate: string,
  baseCurrency: string,
): number | null {
  const cleaned = rate.trim();
  if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === '' || cleaned === '.') return null;

  const [whole = '0', fraction = ''] = cleaned.split('.');
  const scale = 10 ** fraction.length;
  const scaledRate = Number(whole) * scale + Number(fraction || '0');
  if (!Number.isSafeInteger(scaledRate) || scaledRate <= 0) return null;

  /* Units cancel: (fx minor / fx units) × rate = base major, × base units.
   * Kept as one expression so there is a single rounding point, at the end. */
  const baseUnits = minorUnitsFor(baseCurrency);
  const fxUnits = minorUnitsFor(fxCurrency);
  const numerator = fxMinor * scaledRate * baseUnits;
  const denominator = fxUnits * scale;
  if (!Number.isSafeInteger(numerator)) return null;

  // Truncated, never rounded up: the same rule `parseMoneyToMinor` applies.
  return Math.trunc(numerator / denominator);
}
