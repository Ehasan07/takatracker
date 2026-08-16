import { isSupportedCurrency, parseMoneyToMinor, toAsciiDigits } from '@hishab/shared';

/**
 * Reading the currency a message states its money in.
 *
 * ## Why this exists
 *
 * `normaliseMessage` folds `৳`, `Tk`, `TK` and `BDT` into one marker so a single
 * regex covers all four spellings of the taka. Every other currency on earth
 * fell through that: an SMS reading
 *
 *     USD 4.6 transacted at OPENAI *CHATGPT SUBSCR on 16/08/26 …
 *
 * parsed as the bare number 4.6, which the review screen then offered as ৳4.60 —
 * a figure roughly a hundred and twenty times too small, presented as if it had
 * been read from the bank. A number with no units is not a smaller number, it is
 * a different fact, and this module is the part that refuses to lose the units.
 *
 * ## What it does *not* do
 *
 * It does not convert. There is no rate here, no arithmetic between two
 * currencies and no network call, on purpose: the rate that matters is the one
 * the card issuer actually applied, which is not the mid-market rate on any
 * given day and is not knowable from the message. All this produces is "the
 * message said 4.60 US dollars"; somebody who can see their statement supplies
 * the rest.
 *
 * ## The unit trap
 *
 * `amountMinor` is in the smallest unit of **the currency that was found**, not
 * of the workspace's. There are 100 cents in a dollar, 1000 fils in a Kuwaiti
 * dinar and *nothing* in a yen — ¥500 is 500, not 50,000. Multiplying by a
 * hardcoded 100 would be out by two or three orders of magnitude for a fifth of
 * the world's money, so the division comes from `parseMoneyToMinor`, which takes
 * the currency and reads its ISO minor-unit exponent.
 */

/** One amount, together with the ISO 4217 code written against it. */
export interface CurrencyAmount {
  /** ISO 4217 alphabetic code, upper case. */
  currency: string;
  /** Integer minor units **of `currency`** — cents for USD, whole yen for JPY. */
  amountMinor: number;
  /** The whole thing as the message wrote it, code included: `USD 4.6`. */
  text: string;
  /** Just the figure, as the message wrote it: `4.6`. */
  numberText: string;
  /** Offsets into the original body, so a caller can highlight it. */
  start: number;
  end: number;
}

/**
 * `1234`, `1,234`, `1,23,456.78` — thousands or lakh-crore grouping.
 *
 * Three decimal places rather than two, because a dinar has three and cutting
 * at two would silently drop a factor of ten from every Kuwaiti, Bahraini,
 * Jordanian, Omani, Tunisian and Libyan amount. `parseMoneyToMinor` truncates
 * whatever the currency does not have room for.
 */
const NUMBER = String.raw`\d+(?:,\d{2,3})*(?:\.\d{1,3})?`;

/**
 * An ISO code, and why it must be upper case.
 *
 * Case-insensitive matching would make `all`, `top`, `try`, `cup`, `bob`, `sar`
 * and a dozen other ordinary English words into currency codes — ALL, TOP, TRY,
 * CUP, BOB and SAR are all real ISO 4217 entries — and "try 5 times" would read
 * as five Turkish lira. Banks write the code in capitals, every one of them, so
 * requiring capitals costs nothing real and closes the whole class.
 *
 * The guards are explicit lookarounds rather than `\b`. `\b` is defined on ASCII
 * word characters only and cannot be trusted anywhere near Bengali text, which
 * these messages are full of; `(?<![A-Za-z])` says exactly what is meant here
 * and means it whatever script is on the other side.
 */
const CODE = String.raw`[A-Z]{3}`;

/** `USD 4.6`, `USD4.6`, `BDT 5,000.00`. */
const CODE_FIRST = new RegExp(
  String.raw`(?<![A-Za-z])(${CODE})\.?\s*(${NUMBER})(?![A-Za-z0-9.,]*\d)`,
  'g',
);

/** `4.6 USD`, `500USD` — how a statement line and some wallets write it. */
const CODE_LAST = new RegExp(
  String.raw`(?<![A-Za-z0-9.,])(${NUMBER})\s*(${CODE})(?![A-Za-z])`,
  'g',
);

/**
 * The taka's own spellings, which are not an ISO code and never will be.
 *
 * `BDT` is covered by `CODE` above; the other five are not, and every one of
 * them is on a real message. `Tk 500` and `Tk. 500` are what a bank sends,
 * `Taka 5,000 debited` is what one of them writes out, `৳500` is the symbol, and
 * bKash and Nagad send `৫০০ টাকা কাটা হয়েছে` in Bengali with no Latin character
 * in it at all.
 *
 * Reading them matters even though the answer is nearly always the workspace's
 * own currency, because "nearly always" is not always: a workspace kept in
 * dollars that receives `Tk 500` has exactly this file's original bug pointed
 * the other way, and ৳500 would be booked as $500 — a hundred and twentyfold
 * *over*statement — unless something says out loud that the message was in taka.
 *
 * ## Two expressions, one per script
 *
 * `\b` is an ASCII word boundary. Beside a Bengali letter it matches nothing
 * useful, so `\bটাকা\b` never fires and folding these into the Latin
 * alternation would mean the Bengali half silently stopped matching — a mistake
 * this repository has made before, and the reason `suggestNonCategory` in
 * `packages/core/src/migration.ts` is written the same way.
 *
 * The Latin branch is guarded on both sides. `Taka` without a closing guard eats
 * the front of `Takaful` — which is insurance, and a category name in this
 * product — and a bare `tk` without one turns `TKS` into money.
 */
const TAKA_LATIN = String.raw`(?<![A-Za-z])(?:BDT|Tk|TK|tk|Taka|TAKA|taka)\.?(?![A-Za-z])`;
/** `৳` and `টাকা`, plain: no boundary assertion works around either. */
const TAKA_BENGALI = String.raw`(?:৳|টাকা)`;
const TAKA_MARK = `(?:${TAKA_LATIN}|${TAKA_BENGALI})`;

/** `Tk 500`, `Tk.500`, `Taka 5,000`, `৳1000`. */
const TAKA_FIRST = new RegExp(String.raw`${TAKA_MARK}\s*(${NUMBER})(?![A-Za-z0-9.,]*\d)`, 'g');

/** `500 Taka`, `৫০০ টাকা`, `২টাকা` — the Bengali order, and some English banks'. */
const TAKA_LAST = new RegExp(String.raw`(?<![A-Za-z0-9.,])(${NUMBER})\s*${TAKA_MARK}`, 'g');

/**
 * Words that mean "this figure is not the transaction".
 *
 * A closing balance carries the same currency code as the movement and is
 * usually the larger of the two — `Available balance: USD 538.24` against a
 * `USD 4.6` charge. Picking it would file the whole account as one purchase. A
 * fee is the same class of mistake in the other direction.
 *
 * Split in two, deliberately. The Latin branch can use `\b` because every
 * character in it is ASCII; the Bengali branch cannot, because `\b` is defined
 * on ASCII word characters and never fires between two Bengali letters — a
 * single combined pattern would silently stop matching the Bengali half. This
 * has bitten this codebase before.
 */
const NOT_THE_AMOUNT_LATIN =
  /(?<![A-Za-z])(?:avl|avail(?:able)?|bal(?:ance)?|closing|limit|fee|charge|vat|tax|comm(?:ission)?)\b[^A-Za-z0-9]{0,6}$/i;
const NOT_THE_AMOUNT_BENGALI =
  /(?:ব্যালেন্স|ব্যালান্স|স্থিতি|অবশিষ্ট|জের|চার্জ|ফি|ভ্যাট|কর)[^A-Za-z0-9]{0,6}$/;

/** How far back to look for a word that changes what a number means. */
const LOOKBACK = 28;

/** Sort key so two overlapping readings of the same text resolve left to right. */
const byStart = (a: CurrencyAmount, b: CurrencyAmount): number => a.start - b.start;

function isDisqualified(scan: string, start: number): boolean {
  const preceding = scan.slice(Math.max(0, start - LOOKBACK), start);
  return NOT_THE_AMOUNT_LATIN.test(preceding) || NOT_THE_AMOUNT_BENGALI.test(preceding);
}

function read(
  body: string,
  code: string,
  numberText: string,
  start: number,
  end: number,
): CurrencyAmount | null {
  const currency = code.toUpperCase();
  /* Three capitals next to a number are not a currency until ISO says so.
     `REF 12345`, `TXN 90210` and every other reference label in every bank
     message on earth land here and are turned away. */
  if (!isSupportedCurrency(currency)) return null;

  let amountMinor: number;
  try {
    amountMinor = parseMoneyToMinor(numberText, currency);
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return null;

  return { currency, amountMinor, text: body.slice(start, end), numberText, start, end };
}

/**
 * Every amount in the message that says what currency it is in, in order.
 *
 * Four passes: an ISO code before the figure, an ISO code after it, and the
 * taka's own spellings on either side. They run in that order and a later pass
 * never takes characters an earlier one has already claimed — `BDT 5,000` is one
 * amount, found twice, not two amounts.
 *
 * Matching runs on `toAsciiDigits(body)`, which maps Bengali and Arabic-Indic
 * numerals to ASCII **one character to one character**, so every offset below is
 * equally valid in the original. The slices come out of the original, which is
 * why the evidence a review screen shows reads `USD ৪.৬` when that is what the
 * bank sent — the person checking it has to see their own message, not our
 * transcription of it.
 */
export function findCurrencyAmounts(body: string): CurrencyAmount[] {
  const scan = toAsciiDigits(body);
  const found: CurrencyAmount[] = [];

  /* A span another pass has already read. `USD 4.6 USD` is one charge written
     clumsily, and `BDT 500` is matched by both the ISO pass and the taka pass. */
  const taken = (start: number, end: number): boolean =>
    found.some((other) => start < other.end && other.start < end);

  const collect = (pattern: RegExp, codeGroup: 1 | 2, numberGroup: 1 | 2, code?: string): void => {
    for (const match of scan.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (taken(start, end) || isDisqualified(scan, start)) continue;
      const entry = read(
        body,
        code ?? (match[codeGroup] as string),
        match[numberGroup] as string,
        start,
        end,
      );
      if (entry) found.push(entry);
    }
  };

  collect(CODE_FIRST, 1, 2);
  collect(CODE_LAST, 2, 1);
  /* The code is supplied rather than read: `৳`, `Tk` and `টাকা` all mean BDT
     and none of them is the string "BDT". */
  collect(TAKA_FIRST, 1, 1, 'BDT');
  collect(TAKA_LAST, 1, 1, 'BDT');

  return found.sort(byStart);
}

/**
 * The currency written against one particular figure, or null.
 *
 * `amountText` is what a parser already decided the transaction amount was —
 * `ParseResult.evidence.amountMinor`, the exact substring it read. Tying the
 * answer to that figure rather than to "the first code in the message" is what
 * keeps a reference number out of the books: in
 *
 *     BDT 5,000.00 credited … Ref SAR 12345
 *
 * there are two capitalised codes beside two numbers, and only one of them is
 * the money. The parser has already picked the money; this says what units it
 * was in. When the two readers do not agree on a figure, the honest answer is
 * null — the draft then behaves exactly as it did before this module existed,
 * rather than acquiring a currency nobody read.
 *
 * Comparison is on the digits alone: markers, spaces and non-breaking spaces are
 * stripped from both sides and Bengali numerals are folded, so `৳ ১,২৩৪` and
 * `1,234` are the same figure and `BDT 5,000.00` matches `5,000.00`.
 */
export function currencyForAmount(body: string, amountText: string): CurrencyAmount | null {
  const wanted = digitsOf(amountText);
  if (!wanted) return null;
  return findCurrencyAmounts(body).find((entry) => digitsOf(entry.numberText) === wanted) ?? null;
}

/**
 * Just the figure: no currency marker, no grouping, no spaces, ASCII digits.
 *
 * Everything that is not a digit or a decimal point is dropped, which takes the
 * Latin markers, the `৳`, the Bengali letters of `টাকা` and the grouping commas
 * in one pass rather than in a list of replacements somebody would have to keep
 * in step with the patterns above. The stray dot a stripped `Tk.` leaves at the
 * front goes with the full stop at the end of a sentence, so `Tk. 1234.5` and
 * `1234.5` compare equal, which is the whole job.
 */
function digitsOf(text: string): string {
  const stripped = toAsciiDigits(text)
    .replace(/[^\d.]/g, '')
    .replace(/^\.+|\.+$/g, '');
  return /^\d+(?:\.\d+)?$/.test(stripped) ? stripped : '';
}
