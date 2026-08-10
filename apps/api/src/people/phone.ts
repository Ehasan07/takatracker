import { toAsciiDigits } from '@hishab/shared';

/**
 * One canonical shape for a Bangladeshi mobile number — and a deliberate
 * refusal to guess about anything else.
 *
 * **Why this lives here and not in the loans module.** `LoansService.resolvePerson`
 * decides whether a loan belongs to an existing person by comparing the typed
 * phone to the stored one as a trimmed exact string. So `01711223344` and
 * `+8801711223344` are two different people, the party ledger splits in two, and
 * *neither half is the answer* — each shows part of the debt while looking
 * complete. The fix is a canonical form, and a canonical form is a property of
 * the `Person` model, not of the one screen that happens to create people. It is
 * exported so the loans module can adopt it without a second copy of the rules.
 *
 * **What is normalised, exactly.** Only a Bangladeshi *mobile* number, and only
 * when the digits leave no room for interpretation. After Bengali numerals are
 * folded to ASCII and spaces, hyphens, brackets and dots are dropped, these six
 * spellings all mean the same subscriber and all become `01XXXXXXXXX`:
 *
 *     01711223344        the national form, already canonical
 *     1711223344         the leading zero eaten by a spreadsheet or a paste
 *     +8801711223344     the international form
 *     8801711223344      the same without the plus
 *     008801711223344    the same with an IDD prefix
 *     +88001711223344    country code *and* trunk zero — wrong, and very common
 *
 * The national form wins because it is the one a person in Bangladesh reads,
 * types and dials. Storing `+880…` would mean somebody who typed eleven digits
 * sees thirteen come back.
 *
 * The operator prefix is pinned to `1[3-9]`, which is every mobile block in use
 * (013 Grameenphone through 019 Banglalink). That constraint is what makes the
 * bare ten-digit rule safe: a ten-digit string starting `13`–`19` in a phone
 * field is a mobile number that lost its zero, and nothing else in this country
 * is shaped like that.
 *
 * **What is deliberately left alone**, because a wrong merge is worse than the
 * split it prevents — two real people folded into one is silent and unrecoverable
 * from the UI, while two rows for one person is visible and now fixable by hand:
 *
 *  - **Landlines.** `02-9661234`, `+880 2 9661234`, `031-712345` — the area code
 *    is variable-length, the trunk zero is written inconsistently, and there is
 *    no single form to normalise towards. Stored exactly as typed.
 *  - **Every non-880 country code.** An Indian `+919876543210` and a US
 *    `+13122334455` are untouched: they are eleven or twelve digits, and even
 *    the eleven-digit US case cannot reach the ten-digit `1[3-9]` rule because
 *    the pattern is anchored at both ends.
 *  - **Anything carrying an extension, a letter or a second number.** Those are
 *    notes, not numbers, and the honest thing is to keep the user's own text.
 *
 * Nothing here rewrites rows that already exist — there is no migration in this
 * change. That is why identity is compared through `phoneIdentity` rather than
 * with a SQL equality: a workspace opened last year still holds `+880…` strings,
 * and they have to keep matching the `01…` somebody types today.
 */

/**
 * Punctuation people put inside phone numbers.
 *
 * The invisibles are the bidi marks a Bengali or Arabic keyboard leaves behind
 * on a pasted number; without them two byte-different strings that print
 * identically would compare unequal, which is the worst kind of duplicate
 * because nothing on screen explains it. `+` is **not** here — the pattern below
 * needs it to tell an international spelling from a national one.
 */
const SEPARATORS = /[\s\u200e\u200f\u2066-\u2069().\u2010-\u2015-]/g;

/** The six accepted spellings above, and nothing else. Anchored on purpose. */
const BD_MOBILE = /^(?:\+?880|00880)?0?(1[3-9]\d{8})$/;

/** Strip what a human sprinkles into a number, and fold Bengali numerals. */
function compact(raw: string): string {
  return toAsciiDigits(raw).replace(SEPARATORS, '');
}

/**
 * The canonical `01XXXXXXXXX` for a Bangladeshi mobile, or `null` for anything
 * this module refuses to interpret. Never throws — an unrecognised number is not
 * an error, it is a number we keep verbatim.
 */
export function normaliseBdPhone(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const match = BD_MOBILE.exec(compact(raw));
  return match ? `0${match[1]!}` : null;
}

/**
 * What actually goes in the column: the canonical form when we recognise the
 * number, the user's own trimmed text when we do not, and `null` for blank.
 *
 * Trimming only. A number we cannot parse is still the best record of what the
 * user knows, and dropping it would lose the one way to reach that person.
 */
export function storablePhone(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return normaliseBdPhone(trimmed) ?? trimmed;
}

/**
 * A comparison key for "is this the same number?", or `null` when there is no
 * number to compare.
 *
 * A recognised mobile compares by its canonical form, so the `+880…` written
 * before this file existed still equals the `01…` typed after it. Anything else
 * compares by its separator-stripped text — case-folded, but with the leading
 * `+` kept, so `+919876543210` and `919876543210` stay *different*. That is the
 * conservative side of the trade on purpose: the only cost of a missed match is
 * a duplicate the user can merge, while a wrong match refuses a real person's
 * number or, worse, invites a merge of two people who are not the same.
 *
 * `toLowerCase`, never `toLocaleLowerCase` — under a Turkish locale the latter
 * folds `I` to `ı` and two devices would disagree about what is a duplicate.
 */
export function phoneIdentity(raw: string | null | undefined): string | null {
  const stored = storablePhone(raw);
  if (stored === null) return null;
  return normaliseBdPhone(stored) ?? compact(stored).toLowerCase();
}
