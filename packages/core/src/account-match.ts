/**
 * Which of the workspace's accounts a message is about.
 *
 * ## Why this exists
 *
 * The parsers have always read the account out of the message — `A/C (***6948)`,
 * `Card#0570` — and stored it as `accountHint`. The review screen highlighted
 * it and labelled it, and then the account picker below opened empty, because
 * nothing ever compared the hint to the accounts. The `matchHints` column on
 * `Account` and the field on the accounts screen that fills it in existed for
 * exactly this comparison and had no reader at all: a person could type their
 * account number into a box called "মেলানোর সংকেত" and nothing anywhere would
 * match on it. This is that reader.
 *
 * ## What it will and will not claim
 *
 * A wrong account is worse than an empty one. An empty picker costs one tap; a
 * confidently wrong pre-selection costs a ledger entry against the wrong
 * balance, and the person accepting the draft has no reason to look twice at a
 * field the app filled in for them. So:
 *
 *  - **Digits beat words.** A four-digit tail identifies an account; the word
 *    "UCB" identifies a bank, and a bank can hold several.
 *  - **Ambiguity returns nothing.** Two accounts matching equally well is not a
 *    coin toss, it is a question for the person, and they are already looking at
 *    the screen.
 *  - **Nothing is written to the ledger here.** The result pre-selects a picker.
 *
 * ## Why not just ask the model
 *
 * `AiSuggestService` sends account *names* and a message and asks which fits.
 * It cannot see the numbers — they are not in the list it is given — so for the
 * one case that has an exact answer it is guessing, and it costs a round trip
 * and somebody's tokens to guess. This runs first, offline, on a comparison
 * that is either right or absent.
 */

import { toAsciiDigits } from '@hishab/shared';

/** An account as far as matching is concerned. */
export interface AccountMatchCandidate {
  id: string;
  name: string;
  institution?: string | null;
  /** `****6948`, `4521 **** **** 0570` — whatever the owner typed. */
  accountNumberMasked?: string | null;
  /** Free text the owner added on the accounts screen: `6948`, `bKash`, `DBBL`. */
  matchHints?: readonly string[] | null;
}

/** What the parser and the transport know about the message. */
export interface AccountMatchInput {
  /** The digits the parser read, already reduced to the last four. */
  accountHint?: string | null;
  /** Shortcode or sender name: `UCB.`, `bKash`, `01711…`. */
  sender?: string | null;
  /** The whole message, for word hints that appear in the text but not the sender. */
  body?: string | null;
}

export interface AccountMatch {
  accountId: string;
  /** How sure the match is, strongest first — see the tiers below. */
  by: 'number' | 'hint' | 'sender';
  /** The account's own text that matched, so a screen can say why. */
  matchedOn: string;
}

/** Everything that is not a digit, gone: `A/C (***6948)` and `6948` are one hint. */
function digitsOf(text: string): string {
  return toAsciiDigits(text).replace(/\D+/g, '');
}

/**
 * The account numbers buried in an account's *name*.
 *
 * People name accounts after them — `UCB SALARY- 1043204000006948`,
 * `THE CITY BANK-2101696107001`, `৩০কে ডিপিএস — ব্র্যাক ব্যাংক ৩০১১৯৫২১৫০০০৪`.
 * That is the number the bank quotes, already typed in, and refusing to read it
 * would have every one of those accounts fail to match its own alerts.
 *
 * Runs of six digits or more, and each run on its own — never the digits of the
 * name concatenated. `CBL-Term Loan 2019 (900k)` concatenates to `2019900`,
 * whose last four are `9900`, which is a number that appears nowhere and would
 * match somebody's card by coincidence. A real account number is long and
 * unbroken; a year and a round figure are neither.
 */
function numbersInName(name: string): string[] {
  return toAsciiDigits(name).match(/\d{6,}/g) ?? [];
}

/** Lowercased, punctuation dropped: `UCB.` and `ucb` are one word. */
function foldOf(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\u0980-\u09ff]+/g, '');
}

/**
 * Do two account numbers name the same account?
 *
 * Four digits, compared as tails, because that is what banks send and what
 * people write down. Three would be far too weak — `1948` and `6948` share
 * their last three — so anything shorter than four has to match in full.
 */
function sameAccountNumber(a: string, b: string): boolean {
  if (a.length < 2 || b.length < 2) return false;
  if (a.length < 4 || b.length < 4) return a === b;
  return a.slice(-4) === b.slice(-4);
}

/**
 * A word hint is only a match when it appears as itself.
 *
 * `includes` on the folded text, not on the raw: the sender arrives as `UCB.`
 * and the hint was typed as `ucb`. Two characters is the floor — a hint of `a`
 * would match every message ever sent.
 */
function mentions(haystack: string, needle: string): boolean {
  return needle.length >= 2 && haystack.includes(needle);
}

/** The single candidate, or nothing if there are none or several. */
function only(matches: readonly AccountMatch[]): AccountMatch | null {
  return matches.length === 1 ? (matches[0] as AccountMatch) : null;
}

/** Every number this account is known by: its masked number, its hints, its name. */
function numbersOf(account: AccountMatchCandidate): { text: string; digits: string }[] {
  const typed = [account.accountNumberMasked ?? '', ...(account.matchHints ?? [])]
    .map((text) => ({ text, digits: digitsOf(text) }))
    .filter((entry) => entry.digits.length >= 2);
  return [
    ...typed,
    ...numbersInName(account.name).map((digits) => ({ text: account.name, digits })),
  ];
}

/**
 * The part of a quoted account number worth keeping: its last four digits.
 *
 * What a person writes down and what a bank prints. Anything shorter than four
 * is kept whole — some wallets quote three — and anything under two is not an
 * account number at all.
 */
export function accountTailOf(quoted: string | null | undefined): string | null {
  if (!quoted) return null;
  const digits = digitsOf(quoted);
  if (digits.length < 2) return null;
  return digits.length > 4 ? digits.slice(-4) : digits;
}

/** Is this account already known by that number — from its name, its masked number, or a hint? */
export function accountKnowsNumber(account: AccountMatchCandidate, quoted: string): boolean {
  const digits = digitsOf(quoted);
  if (digits.length < 2) return false;
  return numbersOf(account).some((entry) => sameAccountNumber(entry.digits, digits));
}

/**
 * The account a message is about, or null when the answer is not certain.
 *
 * Pass only accounts a draft could legitimately name — not archived, not
 * deleted, not a system control account.
 *
 * ## How the three signals combine
 *
 * The number decides. When the message quotes an account number, every account
 * whose own number is known and different is *out* — not ranked lower, out.
 * That is the rule that stops a City Bank alert for `1422***8001` landing on
 * the City Bank current account just because the sender said "CITY BANK": the
 * app knows that account's number and it is not this one. An account with no
 * number on file is not excluded, because nothing is known about it to
 * contradict the message — a workspace whose accounts are named `বিকাশ` and
 * `নগদ` still matches on its sender exactly as it did before.
 *
 * Several accounts sharing a number tail — three wallets on one phone number is
 * the ordinary case — are then separated by the word hints and the sender, and
 * only by those. If that still leaves more than one, the answer is nothing: an
 * empty picker costs one tap, and a wrong pre-selection costs a ledger entry
 * against the wrong balance that nobody will re-check.
 */
export function matchAccount(
  candidates: readonly AccountMatchCandidate[],
  input: AccountMatchInput,
): AccountMatch | null {
  const hintDigits = input.accountHint ? digitsOf(input.accountHint) : '';
  const quoted = hintDigits.length >= 2;
  const haystack = foldOf(`${input.sender ?? ''} ${input.body ?? ''}`);
  const senderFold = foldOf(input.sender ?? '');

  const byNumber: AccountMatch[] = [];
  const byHint: AccountMatch[] = [];
  const bySender: AccountMatch[] = [];

  for (const account of candidates) {
    const numbers = numbersOf(account);
    const hit = quoted
      ? numbers.find((entry) => sameAccountNumber(entry.digits, hintDigits))
      : undefined;
    if (hit) byNumber.push({ accountId: account.id, by: 'number', matchedOn: hit.text });

    /* Word hints, against the sender *and* the body. A bKash alert comes from
       `bKash` and an EFTN alert names the bank inside the text; the owner
       should not have to know which. */
    const word = (account.matchHints ?? []).find((hint) => mentions(haystack, foldOf(hint)));
    if (word !== undefined) {
      byHint.push({ accountId: account.id, by: 'hint', matchedOn: word });
      continue;
    }

    /* Known number, and it is not the one the message quoted — so this account
       is out, and the sender below is not allowed to argue.
       
       Checked *after* the word hints on purpose. Not every number on file is
       the number a bank quotes: a card is filed under the customer id printed
       in its own alerts, and excluding it for failing a comparison against a
       card number would throw away the strongest evidence there is — the
       owner's own hint, appearing verbatim in the message. */
    if (!hit && quoted && numbers.length > 0) continue;

    /* The account's own name or its institution, against the sender only.
       Against the body this would be a trap: "I Banking EFTN Transfer" is a
       payee, and an account called `Transfer Account` would swallow it. */
    if (senderFold.length >= 3) {
      const label = [account.institution ?? '', account.name]
        .filter(Boolean)
        .find((text) => mentions(foldOf(text), senderFold) || mentions(senderFold, foldOf(text)));
      if (label) bySender.push({ accountId: account.id, by: 'sender', matchedOn: label });
    }
  }

  if (byNumber.length === 1) return byNumber[0] as AccountMatch;
  if (byNumber.length > 1) {
    /* One number, several accounts — three wallets registered to one phone
       number. The tie is broken by the other two signals or not at all. */
    const ids = new Set(byNumber.map((m) => m.accountId));
    const narrow = (tier: readonly AccountMatch[]) => tier.filter((m) => ids.has(m.accountId));
    return only(narrow(byHint)) ?? only(narrow(bySender));
  }

  return only(byHint) ?? only(bySender);
}
