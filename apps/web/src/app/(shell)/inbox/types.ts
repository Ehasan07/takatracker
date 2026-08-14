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
  /** Integer poisha, or null when the message carried no figure at all. */
  amountMinor: number | null;
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
  categoryId?: string;
  description?: string;
  notes?: string;
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
  draftId: string | null;
  draftStatus: string | null;
}

export interface MessagePage {
  items: MessageRow[];
  nextCursor: string | null;
}
