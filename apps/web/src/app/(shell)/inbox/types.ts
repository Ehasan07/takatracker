/**
 * The shapes `apps/api/src/ingestion` actually returns.
 *
 * Hand-written rather than imported: the API's `DraftView` is declared inside
 * a Nest service that pulls in Prisma, and dragging that into a browser bundle
 * to borrow six field names is not a trade worth making. The enums below are
 * mirrors of the Prisma ones for the same reason the controller keeps its own
 * copies — see the note at the top of `ingestion.controller.ts`.
 */

export type DraftStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'DUPLICATE';
export type Direction = 'IN' | 'OUT';
export type IngestionChannel = 'SMS' | 'EMAIL' | 'WEBHOOK';
export type RejectReason = 'DUPLICATE' | 'NOT_MINE' | 'BAD_PARSE' | 'OTHER';

export interface DraftMessageView {
  id: string;
  channel: IngestionChannel;
  sender: string | null;
  receivedAt: string;
  /** Exactly as it arrived — never trimmed, never normalised, never HTML. */
  body: string;
}

export interface DraftView {
  id: string;
  status: DraftStatus;
  /** `YYYY-MM-DD`, or null when the parser could not read one. */
  date: string | null;
  /**
   * Integer minor units of the **workspace's own** currency.
   *
   * Null when the message carried no figure at all — and also, deliberately,
   * whenever `fxCurrency` is set. A message reading "USD 4.6" states no taka
   * figure and the server refuses to invent one; that null is what makes this
   * screen ask instead of quietly offering ৳4.60 for a $4.60 charge.
   */
  amountMinor: number | null;
  /** ISO 4217 the message stated, when that was not the currency of the books. */
  fxCurrency: string | null;
  /**
   * The amount in `fxCurrency`, integer minor units of *that* currency — cents
   * for a dollar, whole yen for a yen. The rate is never carried: it is
   * `amountMinor / fxAmountMinor` once a person has supplied the first.
   */
  fxAmountMinor: number | null;
  direction: Direction | null;
  payee: string | null;
  accountId: string | null;
  categoryId: string | null;
  /** 0–100. Zero means "no amount was read", not "20% sure". */
  confidence: number;
  /** True below the server's review threshold: something was guessed. */
  needsReview: boolean;
  /**
   * Field name → the exact substring of `message.body` it was read from.
   * A field present on the draft but absent here was **inferred, not read**.
   */
  evidence: Record<string, string>;
  parserName: string | null;
  /** Which model proposed the category and account, when one did. */
  suggestedBy?: string | null;
  /**
   * The account number this accept taught the workspace, when it taught one.
   *
   * Only ever set on the response to an accept. The app changed a setting off
   * the back of one tap, so it says so — somebody who does not know it happened
   * cannot go and undo it.
   */
  learnedHint?: string | null;
  /** True when saying no taught the inbox to stop asking about this shape. */
  learnedRule?: boolean;
  transactionId: string | null;
  reviewedAt: string | null;
  createdAt: string;
  /** Null once retention has purged the message behind the draft. */
  message: DraftMessageView | null;
}

export interface DraftPage {
  items: DraftView[];
  nextCursor: string | null;
}

/**
 * Everything optional, everything overrides the parser. The server validates
 * the *merged* result, so `accountId` and `categoryId` have to be present in
 * the draft or in here — and the parser never fills either, so in practice
 * they are always sent.
 */
export interface AcceptDraftBody {
  date?: string;
  amountMinor?: number;
  direction?: Direction;
  payee?: string | null;
  accountId?: string;
  /** The other side, when the reviewer says this was a transfer of their own money. */
  counterAccountId?: string;
  categoryId?: string;
  description?: string;
  notes?: string;
  /**
   * What the money actually was, when it was not the workspace's own.
   *
   * Left out by this screen in the ordinary case: the server already holds both
   * halves on the draft and merges whatever the request omits, so sending them
   * back unchanged would only tell the accept audit that the person had to
   * correct the parser. Sent as an explicit pair when they *are* corrected, and
   * as `null` twice when somebody says it was not another currency after all.
   */
  fxCurrency?: string | null;
  fxAmountMinor?: number | null;
  /**
   * A repayment on a loan that already exists.
   *
   * The case this screen could not record at all: ৳3,000 arrives in bKash and
   * it is the money somebody borrowed coming back. Accepted as income it
   * invents earnings and leaves the debt at its full size.
   */
  /** What the entry is *for* — the venture, the trip, the family. */
  tagIds?: string[];
  loanId?: string;
  /** A loan being *made* from this message. Needs `personId` or `personName`. */
  loanDirection?: 'LENT' | 'BORROWED';
  personId?: string;
  personName?: string;
}

/** One row of "everything this phone sent me", from `GET /ingestion/messages`. */
export interface MessageRow {
  id: string;
  channel: string;
  sender: string | null;
  receivedAt: string;
  body: string;
  parserName: string | null;
  /** Null when the message was never about money, so no decision was raised. */
  /**
   * True when a rule the owner taught kept this message out of the queue.
   *
   * Without it a suppressed message is indistinguishable on screen from one the
   * parser could make nothing of, and somebody would have no way to know the
   * inbox is acting on a rule they taught it.
   */
  suppressed?: boolean;
  draftId: string | null;
  draftStatus: string | null;
}

export interface MessagePage {
  items: MessageRow[];
  nextCursor: string | null;
}
