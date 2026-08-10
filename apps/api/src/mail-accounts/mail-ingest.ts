import type { MailFolder } from '@prisma/client';

/**
 * Which synced messages are worth asking a human about, and what an eligible one
 * looks like by the time it reaches the ingestion pipeline.
 *
 * ## Why there is a gate at all
 *
 * A forwarded SMS was already chosen: somebody's phone decided that message was
 * a bank alert before it ever left the handset. A synced mailbox was not chosen
 * by anybody. It holds newsletters, calendar invites, a colleague arguing about
 * a deadline, forty receipts for things already in the ledger — and one bank
 * statement. Routed unfiltered, every one of those becomes a `TransactionDraft`
 * sitting in the review inbox waiting for a person.
 *
 * The cost of being wrong is asymmetric, and that asymmetry sets the dial. A
 * missed bank alert costs one entry typed by hand: annoying, recoverable, and
 * *visible* to the user, because they know the transaction happened. A review
 * inbox with forty newsletters in it costs the habit of opening the inbox — and
 * then the bank alert underneath them is missed too, silently, forever. So the
 * rule below is deliberately tight, and any relaxation of it should be argued
 * against that.
 *
 * ## Two gates in two modules, on purpose
 *
 * This file holds the **contextual** half: facts about email that only the mail
 * module knows. Which folder it was in. Whether it is the user's own writing.
 * Whether it carries the footprint of bulk mail. Whether it is a reply in a
 * thread. None of it looks at money, and none of it knows what a parser is.
 *
 * The **content** half lives in `IngestionService.ingestFromWorker`, which asks
 * the parser registry whether it could actually *read* an amount and a direction
 * out of the text rather than infer them. That question belongs there because
 * the registry does, and because it then sharpens for free: when a real BRAC,
 * City, DBBL or EBL parser lands (M8), the gate improves without this file
 * changing a line.
 *
 * ## What this costs the sweep
 *
 * Nothing that matters. Everything here is pure string work over a body already
 * in memory, it performs no I/O, and it runs *before* the hash and the two
 * queries the ingestion pipeline would otherwise do — so the cheap rejections
 * are what keep the expensive path off the majority of a mailbox.
 */

/**
 * The largest body the ingestion pipeline accepts.
 *
 * Matches the `body` cap on the webhook's own schema (`MAX_BODY_LENGTH` in
 * `ingestion.controller.ts`, 32 KB per spec §4.2), restated here because the
 * controller does not export it and a background worker has no business
 * importing from the request layer. The two doors into ingestion must agree
 * about what is too big, so if that number moves this one moves with it.
 *
 * Over the cap a message is **refused, not truncated**. `IngestionMessage.body`
 * is promised to be the text exactly as it arrived and the draft's evidence
 * spans are offsets into it; half a message would make both of those a lie. A
 * transaction alert is a few hundred characters. Thirty-two kilobytes of text is
 * a digest, a thread, or a statement PDF's fallback rendering.
 */
const MAX_INGEST_BODY_CHARS = 32_768;

/**
 * Folders a transaction alert can arrive in.
 *
 * `SENT` and `DRAFTS` are the user's own writing and are never inbound money
 * news — "I've paid you Tk 500" in a sent mail would parse beautifully and mean
 * nothing. `ARCHIVE` is admitted because on Gmail it *is* All Mail: a user who
 * files their bank alerts, or has a filter that does it for them, would
 * otherwise never see a single draft. Admitting All Mail also admits the copies
 * of their own sent mail that live in it, which is why the own-address rule
 * below exists instead of leaving the folder list to do that job.
 *
 * The same message in INBOX and in ARCHIVE is two `MailMessage` rows (the IMAP
 * UID is per-mailbox, so `externalId` differs) but one identical body, and the
 * ingestion dedup key is content-derived — so it collapses to one draft. See
 * `MailSyncService.draftFrom`.
 */
const INBOUND_FOLDERS: ReadonlySet<MailFolder> = new Set<MailFolder>(['INBOX', 'ARCHIVE']);

/**
 * The plain-text footprint of bulk mail.
 *
 * The headers that would answer this properly — `List-Unsubscribe`,
 * `Precedence: bulk`, `Auto-Submitted` — are not stored: `MailMessage` keeps a
 * body and an envelope, not a header set. So the visible footer is what is left,
 * and it is a good signal precisely because it is a legal and platform
 * obligation: mail sent to a list has to carry a way off the list, and a bank's
 * transaction alert does not.
 *
 * Every entry here is a phrase that only appears in mail sent to many people. A
 * bank alert saying "to stop these alerts, call 16221" is *not* matched, and
 * deliberately so — that is a service instruction, not a subscription. The
 * closest thing to a false positive is a promotional footer stapled onto a real
 * statement mail, which does happen; the message is then refused and the user
 * types that one entry by hand. That is the cheap failure, and it is the one to
 * choose.
 */
const BULK_MAIL_MARKERS: readonly RegExp[] = [
  /unsubscrib/i,
  /opt[\s-]?out\b/i,
  /view\s+(?:this\s+)?(?:e-?mail|message|newsletter)\s+in\s+(?:your\s+)?browser/i,
  /manage\s+(?:your\s+)?(?:e-?mail\s+)?(?:preferences|subscriptions?)/i,
  /(?:update|change)\s+your\s+(?:e-?mail\s+)?preferences/i,
  /you\s+(?:are\s+)?receiv\w*\s+this\s+(?:e-?mail|message)\s+because/i,
  /আনসাবস্ক্রাইব/,
  /সাবস্ক্রিপশন\s*বাতিল/,
  /ব্রাউজারে\s*দেখুন/,
];

/**
 * A reply, which is a conversation and not an alert.
 *
 * `Fwd:` is deliberately **not** here. A reply is somebody talking to the user;
 * a forward is the user, or someone helping them, deliberately putting a
 * document in front of this mailbox — which is one of the more likely ways a
 * bank statement gets here at all. Rejecting both would have been tidier and
 * wrong.
 */
const REPLY_SUBJECT_RE = /^\s*(?:re|উত্তর)\s*:/i;

/** Why a synced message did not earn a draft. Used for the sweep's log line only. */
export type MailIngestRejection =
  /** Sent or drafts — the user's own writing. */
  | 'folder'
  /** From the mailbox's own address: a sent copy living in Gmail's All Mail. */
  | 'own_mail'
  /** `Re:` — a thread, not an alert. */
  | 'reply'
  /** Carries an unsubscribe footer or equivalent. */
  | 'bulk'
  /** No text at all after the HTML-to-text conversion. */
  | 'empty'
  /** Larger than the ingestion pipeline's body cap; refused rather than cut. */
  | 'too_long';

/** An eligible message, in the shape the ingestion pipeline takes. */
export interface MailIngestCandidate {
  /** The From address. Part of the ingestion dedup key, so it is never invented. */
  sender: string | null;
  /** Subject and body as one plain-text block — see `composeBody`. */
  body: string;
  receivedAt: Date;
}

export type MailIngestDecision =
  | { readonly eligible: true; readonly candidate: MailIngestCandidate }
  | { readonly eligible: false; readonly reason: MailIngestRejection };

/**
 * The fields of a stored `MailMessage` this decision reads.
 *
 * Deliberately not the Prisma row type: the caller passes the values it is about
 * to write, *after* clamping, so the text this gate judges and the text the user
 * later sees on the mail screen are the same text.
 */
export interface SyncedMailMessage {
  folder: MailFolder;
  fromAddress: string | null;
  subject: string | null;
  /** Plain text. `mail-body.ts` has already converted any HTML — see below. */
  body: string | null;
  receivedAt: Date;
}

/**
 * Does this synced message earn a place in the review inbox?
 *
 * **Admits**, in one sentence: inbound mail, from somebody else, that is not a
 * reply and not a mailing-list send, whose text fits in the pipeline's body cap
 * — and which the parser registry can then read both an amount and a direction
 * out of (that second half is `ingestFromWorker`'s, not this function's).
 *
 * So a BRAC alert saying "your A/C ***4521 has been debited by BDT 2,500.00 on
 * 10-Aug-2026" is admitted. A Daraz sale mail is refused by its unsubscribe
 * footer. An OTP mail is refused for naming no money. A colleague's "Re: lunch"
 * is refused twice over. A bKash receipt for a payment the user already typed in
 * *is* admitted — it is a real movement of money and nothing here can know it is
 * already recorded; the review screen is where that gets said, with one tap and
 * a `DUPLICATE` reason.
 *
 * `ownAddress` is the connected mailbox's own address, and is compared
 * case-insensitively because envelope addresses are not normalised anywhere on
 * the way in.
 */
export function mailIngestDecision(
  message: SyncedMailMessage,
  ownAddress: string,
): MailIngestDecision {
  if (!INBOUND_FOLDERS.has(message.folder)) return { eligible: false, reason: 'folder' };

  const from = message.fromAddress?.trim().toLowerCase() ?? '';
  if (from !== '' && from === ownAddress.trim().toLowerCase()) {
    return { eligible: false, reason: 'own_mail' };
  }

  const subject = message.subject?.trim() ?? '';
  if (REPLY_SUBJECT_RE.test(subject)) return { eligible: false, reason: 'reply' };

  const body = composeBody(subject, message.body);
  if (body === null) return { eligible: false, reason: 'empty' };
  if (body.length > MAX_INGEST_BODY_CHARS) return { eligible: false, reason: 'too_long' };

  /* Subject included: a promotional subject with a clean body is still bulk, and
   * "Unsubscribe from these alerts" appears in a subject often enough to be
   * worth the two extra scans. */
  if (BULK_MAIL_MARKERS.some((marker) => marker.test(body))) {
    return { eligible: false, reason: 'bulk' };
  }

  return {
    eligible: true,
    candidate: { sender: message.fromAddress, body, receivedAt: message.receivedAt },
  };
}

/**
 * The text the parser reads, which is also the text that gets stored — one
 * string, not two.
 *
 * That identity is load-bearing. The draft's `evidence` spans are substrings of
 * `IngestionMessage.body`, and the review screen shows them against it; if the
 * parser saw the subject and the stored body did not contain it, an evidence
 * span would point at text nobody can find.
 *
 * The subject is on the front because a bank alert routinely puts the whole
 * transaction in it — "BRAC Bank: BDT 2,500.00 debited from A/C **4521" — while
 * the body is a greeting and a helpline number. Dropping it would throw away the
 * best line in the message. A blank line separates the two so that a word ending
 * the subject cannot be read as context for the number starting the body.
 *
 * **No HTML is handled here and none may be.** `mail-body.ts` converted the
 * message to plain text on the way in, on purpose and with a long argument
 * behind it, and `MailMessage.body` is plain text by contract. A second markup
 * path on this side would reintroduce exactly the category of risk that decision
 * deleted.
 */
function composeBody(subject: string, body: string | null): string | null {
  const text = body?.trim() ?? '';
  if (subject === '' && text === '') return null;
  if (subject === '') return text;
  if (text === '') return subject;
  return `${subject}\n\n${text}`;
}
