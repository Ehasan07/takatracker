import { toAsciiDigits } from '@hishab/shared';

/**
 * What two messages have in common when they are "the same message again".
 *
 * ## The problem this is the key to
 *
 * A phone forwards the same handful of shapes forever. Twenty-four one-time
 * codes from one shortcode, a promotional line from a bank, an alert for
 * somebody else's card on a shared number — every one of them raises a draft,
 * the owner rejects it, and the next one arrives identical but for a figure and
 * a reference number. Rejecting the same shape a hundred times is not review,
 * it is the app failing to listen.
 *
 * So a rejection has to be about the *shape*, and a shape needs a key. Hashing
 * the body cannot give one: no two of those messages are byte-identical, which
 * is the whole difficulty.
 *
 * ## What is thrown away, and why each
 *
 * Everything that varies between two instances of one shape:
 *
 *  - **Digits.** The amount, the balance, the date, the reference, the OTP
 *    itself. Replaced by a single `#` rather than removed, so `Card #0570` and
 *    `Card` stay different shapes — the presence of a number is part of the
 *    form even when its value is not.
 *  - **Case and whitespace.** `Avl Bal` and `AVL BAL  ` are one thing.
 *  - **Punctuation runs.** A trailing `.` or an extra `-` is not a new message.
 *
 * What survives is the sentence the bank wrote: the words, in order, with `#`
 * where its numbers went. Two OTP messages from one sender fold to the same
 * string; a purchase alert and a balance alert from that sender do not.
 *
 * ## Why it is truncated
 *
 * Long tails are where the variation lives — a URL with a token, a session id,
 * an offer code. The first 160 characters of the folded form carry the sentence
 * that identifies the shape, and stopping there makes the key stable against
 * junk nobody reads. A shape that differs only after 160 characters is one
 * shape as far as a person deciding "this is not mine" is concerned.
 */
export function messageShape(body: string): string {
  return (
    toAsciiDigits(body)
      .toLowerCase()
      /* Every run of digits — with the separators inside a number, so
       `1,250.50` and `437.77` fold to one `#` rather than three. */
      .replace(/\d[\d.,:/-]*/g, '#')
      .replace(/[^\p{L}\p{N}#]+/gu, ' ')
      .trim()
      .slice(0, 160)
  );
}

/**
 * Is this shape specific enough to act on?
 *
 * A message that folds to `# #` is every message: acting on it would suppress
 * an entire sender's traffic on the strength of one rejection. Four words is
 * the floor — enough for `your a c has been debited bdt #` and not enough for
 * a bare reference line.
 */
export function isUsableShape(shape: string): boolean {
  return shape.split(' ').filter((word) => word !== '#' && word.length > 0).length >= 4;
}
