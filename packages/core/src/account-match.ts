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
  return text.replace(/\D+/g, '');
}

/** Lowercased, punctuation dropped: `UCB.` and `ucb` are one word. */
function foldOf(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9ঀ-৿]+/g, '');
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

/** The single candidate at this tier, or nothing if the tier is empty or split. */
function only(matches: readonly AccountMatch[]): AccountMatch | null {
  return matches.length === 1 ? (matches[0] as AccountMatch) : null;
}

/**
 * The account a message is about, or null when the answer is not certain.
 *
 * Pass only accounts a draft could legitimately name — not archived, not
 * deleted, not a system control account. Ranked in three tiers, and the first
 * tier with exactly one candidate wins; a tier with several is abandoned
 * rather than resolved, and so is the whole match, because a lower tier
 * agreeing with one of two equally-good numbers is not evidence.
 */
export function matchAccount(
  candidates: readonly AccountMatchCandidate[],
  input: AccountMatchInput,
): AccountMatch | null {
  const hintDigits = input.accountHint ? digitsOf(input.accountHint) : '';
  const haystack = foldOf(`${input.sender ?? ''} ${input.body ?? ''}`);
  const senderFold = foldOf(input.sender ?? '');

  const byNumber: AccountMatch[] = [];
  const byHint: AccountMatch[] = [];
  const bySender: AccountMatch[] = [];

  for (const account of candidates) {
    const hints = account.matchHints ?? [];

    if (hintDigits.length >= 2) {
      const numbers = [account.accountNumberMasked ?? '', ...hints]
        .map((text) => ({ text, digits: digitsOf(text) }))
        .filter((entry) => entry.digits.length >= 2);
      const hit = numbers.find((entry) => sameAccountNumber(entry.digits, hintDigits));
      if (hit) {
        byNumber.push({ accountId: account.id, by: 'number', matchedOn: hit.text });
        continue;
      }
    }

    /* Word hints, against the sender *and* the body. A bKash alert comes from
       `bKash` and an EFTN alert names the bank inside the text; the owner
       should not have to know which. */
    const word = hints.map(foldOf).find((hint) => mentions(haystack, hint));
    if (word) {
      const original = hints.find((hint) => foldOf(hint) === word) ?? word;
      byHint.push({ accountId: account.id, by: 'hint', matchedOn: original });
      continue;
    }

    /* The account's own name or its institution, against the sender only.
       Against the body this would be a trap: "I Banking EFTN Transfer" is a
       payee, and an account called `Transfer Account` would swallow it. */
    if (senderFold.length >= 3) {
      const labels = [account.institution ?? '', account.name].filter(Boolean);
      const label = labels.find(
        (text) => mentions(foldOf(text), senderFold) || mentions(senderFold, foldOf(text)),
      );
      if (label) bySender.push({ accountId: account.id, by: 'sender', matchedOn: label });
    }
  }

  return only(byNumber) ?? only(byHint) ?? only(bySender);
}
