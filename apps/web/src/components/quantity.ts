import { toBengaliDigits } from '@hishab/shared';

/**
 * Quantity arithmetic, on its own with no React and no imports from the app.
 *
 * It is money arithmetic with a different name: a float quantity summed over a
 * year drifts, and a drifting answer to "how much rice did we get through" is
 * worse than no answer. Keeping the two functions here means a unit test can
 * reach them directly, the way `fx-convert.ts` is reachable.
 */

/** Offered, not enforced. The field stays free text; see `UNIT_NOTE`. */
export const COMMON_UNITS = ['কেজি', 'গ্রাম', 'লিটার', 'পিস', 'ডজন', 'হালি', 'বস্তা', 'প্যাকেট'];

export interface QuantityValue {
  /** Thousandths of `unit`. 500 is half a kilo. */
  milli: number;
  unit: string;
}

/** Parse what somebody typed into thousandths, without a float in the middle. */
export function toMilli(text: string): number | null {
  const cleaned = text.replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d))).trim();
  if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === '' || cleaned === '.') return null;
  const [whole = '0', fraction = ''] = cleaned.split('.');
  // Padded then cut to three places — the finest anybody weighs a purchase.
  const milli = Number(whole) * 1000 + Number((fraction + '000').slice(0, 3));
  return Number.isSafeInteger(milli) && milli > 0 ? milli : null;
}

/** 3500 → "৩.৫". Trailing zeros dropped, because "৩.৫০০ লিটার" reads as a price. */
export function fromMilli(milli: number): string {
  const whole = Math.trunc(milli / 1000);
  const fraction = String(milli % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return toBengaliDigits(fraction ? `${whole}.${fraction}` : String(whole));
}
