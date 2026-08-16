/**
 * Dividing a payment that covers a year across the twelve months it covers.
 *
 * ## What this is not
 *
 * It is not amortisation. Nothing here writes a row, adjusts a balance or moves
 * a date: the ৳12,000 insurance premium posted in full on the day it was paid
 * and it stays posted in full on that day. These functions take a number and a
 * span and hand back twelve numbers for a screen to draw. Every figure they
 * produce is a *view* of money that has already moved, and the screen that
 * shows them says so.
 *
 * The reason is stated once, properly, in `prepaid.service.ts`. The short form:
 * this ledger is cash basis, four statement responses declare that they are,
 * and an accrual that made those declarations false would be a worse thing to
 * own than an imperfect monthly figure.
 *
 * ## Integer poisha, and the poisha that will not divide
 *
 * ৳10,000 over twelve months is 83,333 poisha and change, twelve times, and the
 * change matters: twelve rounded shares that add up to ৳9,999.96 would show a
 * spread that does not equal the payment it spreads, and somebody checking the
 * arithmetic would be right and the screen would be wrong. So each month gets
 * the floor of its exact share and the poisha left over go one each to the
 * earliest months — the same "distribute, never drop" rule `split.ts` follows,
 * with equal weights, which makes the tie-break simply "first come first".
 *
 * Nothing here rounds. `Math.round` is banned in this repository and this is
 * exactly the file it was banned for.
 */

/** A calendar month, `YYYY-MM`. The only unit anything in here counts in. */
export type Month = string;

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** `2026-04-17` or `2026-04` → `2026-04`. */
export function monthOf(isoDate: string): Month {
  return isoDate.slice(0, 7);
}

/** Months since year zero, so two months can be compared and subtracted. */
function ordinalOf(month: Month): number {
  return Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1);
}

function monthFromOrdinal(ordinal: number): Month {
  return `${String(Math.floor(ordinal / 12)).padStart(4, '0')}-${pad2((ordinal % 12) + 1)}`;
}

/** `2026-04` plus five months is `2026-09`. Negative offsets go backwards. */
export function addMonthsTo(month: Month, offset: number): Month {
  return monthFromOrdinal(ordinalOf(month) + offset);
}

/** The `count` months beginning at `from`, in order. */
export function monthRange(from: Month, count: number): Month[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => addMonthsTo(from, i));
}

/**
 * `totalMinor` divided into `months` shares that add up to exactly
 * `totalMinor`.
 *
 * The floor to everybody, then the leftover poisha one at a time to the
 * earliest months. Twelve months of ৳10,000 come back as four months of 833.34
 * and eight of 833.33 — which is a spread somebody can add up and check, and
 * that is the only property worth having here.
 */
export function spreadEvenly(totalMinor: number, months: number): number[] {
  if (months <= 0) return [];
  const base = Math.trunc(totalMinor / months);
  const left = totalMinor - base * months;
  return Array.from({ length: months }, (_, i) => base + (i < left ? 1 : 0));
}

/** One payment, as the spread needs to know it. */
export interface PrepaidSource {
  transactionId: string;
  /** The day the money actually left. Kept because the screen shows it. */
  date: string;
  description: string | null;
  categoryName: string | null;
  accountName: string | null;
  /** The whole payment, positive poisha. */
  totalMinor: number;
  /** First month covered. */
  startMonth: Month;
  /** How many months it covers, counting `startMonth` as the first. */
  months: number;
}

/** What one payment contributes to one month. */
export interface PrepaidLine {
  transactionId: string;
  label: string;
  categoryName: string | null;
  amountMinor: number;
}

/** One month of the window, and everything reaching into it. */
export interface PrepaidMonthView {
  month: Month;
  totalMinor: number;
  lines: PrepaidLine[];
}

/**
 * Every marked payment laid across a window of months.
 *
 * Payments that finish before the window starts or begin after it ends simply
 * contribute nothing — they are still in the caller's item list, because a
 * screen that hid last year's premium the moment the window moved would look
 * like it had lost it.
 */
export function spreadOverWindow(
  sources: readonly PrepaidSource[],
  from: Month,
  count: number,
): PrepaidMonthView[] {
  const window = monthRange(from, count);
  const byMonth = new Map<Month, PrepaidMonthView>(
    window.map((month) => [month, { month, totalMinor: 0, lines: [] }]),
  );

  for (const source of sources) {
    const shares = spreadEvenly(source.totalMinor, source.months);
    for (let i = 0; i < shares.length; i += 1) {
      const month = addMonthsTo(source.startMonth, i);
      const bucket = byMonth.get(month);
      if (!bucket) continue;
      const amountMinor = shares[i] as number;
      bucket.totalMinor += amountMinor;
      bucket.lines.push({
        transactionId: source.transactionId,
        /* The description, or the category when there is none. A row labelled
           with nothing is a row nobody can identify a year later, and "কী বাবদ"
           is the first question anybody asks of a spread. */
        label: source.description?.trim() || source.categoryName || source.accountName || '—',
        categoryName: source.categoryName,
        amountMinor,
      });
    }
  }

  /* Largest first inside each month: the ৳1,000 insurance is what somebody
     came to look at, and the ৳45 magazine subscription under it is noise. */
  for (const bucket of byMonth.values()) {
    bucket.lines.sort((a, b) => b.amountMinor - a.amountMinor);
  }

  return window.map((month) => byMonth.get(month) as PrepaidMonthView);
}
