import { parseMoneyToMinor, toAsciiDigits } from '@hishab/shared';
import {
  scoreConfidence,
  type MessageParser,
  type ParseResult,
  type RawMessage,
} from '../ingestion.js';

/**
 * United Commercial Bank (UCB/UCBL) alerts.
 *
 * ## Why a bank-specific parser at all
 *
 * The generic parser finds an amount and guesses a direction from whatever verb
 * it can see, and on these messages it scores 30–40 out of 100 — enough to
 * raise a draft, not enough to fill it in. Everything it is unsure about, a
 * person has to type. A parser that knows one bank's wording reads the same
 * message at 90 and the draft arrives complete.
 *
 * The trade is that it is one bank. That is fine: the registry tries the
 * specific parsers first and falls through to the generic one, so a bank
 * nobody has written a parser for is no worse off than before, and this file
 * is the template for the next one.
 *
 * ## The three shapes UCB actually sends
 *
 * From real messages, not from documentation — the bank publishes none:
 *
 *     BDT10,000.00 withdrawn fm Card#0570 (CL ID:1471642) on 14/08/26 19:01
 *       at UCBL ATM. Avl Bal:2004.96. …
 *
 *     Your A/C (***5650) has been credited BDT 5,000.00 for SALARY CREDIT.
 *       Avl Bal: BDT 6,504.96 @ 05:18 PM. …
 *
 *     Your A/C (***5650) has been debited BDT 3,400.00 for …
 *
 * Two things are constant across all of them and are what `matches` keys on:
 * the hotline `16419`, and the bank's own initials. Matching on the hotline is
 * the stronger of the two — a promotional message mentioning UCB has no reason
 * to carry it, and a transaction alert always does.
 *
 * ## What it deliberately does not do
 *
 * It does not reconcile `Avl Bal` against the account's own balance. That
 * comparison is worth making and belongs on the review screen, where a person
 * can see both numbers and decide; a parser that silently corrected a balance
 * would be editing the ledger from an SMS.
 */

/** The bank's hotline, on every transaction alert and on nothing else. */
const HOTLINE = /\b16419\b/;
const BANK = /\bUCBL?\b/i;

/** `BDT10,000.00`, `BDT 5,000.00` — with or without the space. */
const AMOUNT = /BDT\s*([\d,]+(?:\.\d{1,2})?)/i;

/** `Avl Bal:2004.96`, `Avl Bal: BDT 6,504.96`. */
const BALANCE = /Avl\s*Bal\s*:?\s*(?:BDT\s*)?([\d,]+(?:\.\d{1,2})?)/i;

/** `Card#0570` or `A/C (***5650)` — whichever the message names. */
const CARD = /Card\s*#\s*(\d{3,4})/i;
const ACCOUNT = /A\/C\s*\(?\**(\d{3,4})\)?/i;

/** `on 14/08/26`, day-first, two-digit year. */
const DATE = /\bon\s+(\d{1,2})\/(\d{1,2})\/(\d{2}(?:\d{2})?)/i;

/** `for SALARY CREDIT`, `at UCBL ATM` — what the money was for. */
const PURPOSE_FOR = /\bfor\s+([A-Za-z][A-Za-z0-9 .&/-]{2,60}?)\s*(?:\.|,|Avl|$)/i;
const PURPOSE_AT = /\bat\s+([A-Za-z][A-Za-z0-9 .&/-]{2,60}?)\s*(?:\.|,|Avl|$)/i;

/**
 * Which way the money went.
 *
 * Ordered, and the order matters: `withdrawn` and `debited` both appear in
 * messages that also say `deposit` further along — the UCB ATM alert ends
 * "Use UCB Cash Recycler to deposit 24/7", which a naive keyword search reads
 * as money coming in. Checking the outward words first is what stops a cash
 * withdrawal being filed as income.
 */
function directionOf(body: string): 'IN' | 'OUT' | undefined {
  if (/\b(withdrawn|debited|debit|purchase|payment made)\b/i.test(body)) return 'OUT';
  if (/\b(credited|credit|received|deposited)\b/i.test(body)) return 'IN';
  return undefined;
}

/** `14/08/26` → `2026-08-14`. Day first, and a two-digit year means 20xx. */
function isoDateFrom(day: string, month: string, year: string): string | undefined {
  const d = Number(day);
  const m = Number(month);
  const y = year.length === 2 ? 2000 + Number(year) : Number(year);
  if (d < 1 || d > 31 || m < 1 || m > 12) return undefined;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export const ucblParser: MessageParser = {
  name: 'bd.ucbl',

  matches(msg: RawMessage): boolean {
    const body = msg.body;
    return HOTLINE.test(body) || (BANK.test(body) && /BDT/i.test(body));
  },

  parse(msg: RawMessage): ParseResult | null {
    const body = msg.body;
    /* Bengali numerals folded to ASCII, one character per character, so every
       index below is valid in `body` as well — the same contract the generic
       parser relies on. */
    const scan = toAsciiDigits(body);

    const amountMatch = AMOUNT.exec(scan);
    /* No amount, no parse. Returning null hands the message to the generic
       parser rather than producing a confident empty draft — a UCB balance
       enquiry reply is a real message and this is not the parser for it. */
    if (!amountMatch) return null;

    const amountMinor = parseMoneyToMinor(amountMatch[1] as string);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) return null;

    const fields: ParseResult['fields'] = { amountMinor };
    const evidence: Record<string, string> = { amountMinor: amountMatch[0] };

    const direction = directionOf(scan);
    if (direction) {
      fields.direction = direction;
      evidence.direction = direction === 'OUT' ? 'withdrawn/debited' : 'credited';
    }

    const dateMatch = DATE.exec(scan);
    if (dateMatch) {
      const iso = isoDateFrom(
        dateMatch[1] as string,
        dateMatch[2] as string,
        dateMatch[3] as string,
      );
      if (iso) {
        fields.date = iso;
        evidence.date = dateMatch[0];
      }
    }
    /* No date in the message — the salary alerts carry a time and no day. The
       day it arrived is the right fallback and is deliberately left out of
       `evidence`, so the confidence score treats it as the guess it is. */
    if (!fields.date && msg.receivedOn) fields.date = msg.receivedOn;

    const balanceMatch = BALANCE.exec(scan);
    if (balanceMatch) {
      const balance = parseMoneyToMinor(balanceMatch[1] as string);
      if (Number.isFinite(balance)) {
        fields.balanceMinor = balance;
        evidence.balanceMinor = balanceMatch[0];
      }
    }

    const cardMatch = CARD.exec(scan) ?? ACCOUNT.exec(scan);
    if (cardMatch) {
      fields.accountHint = cardMatch[1] as string;
      evidence.accountHint = cardMatch[0];
    }

    /* `for SALARY CREDIT` beats `at UCBL ATM`: when a message says both, the
       reason is more useful on a ledger row than the place. */
    const purposeMatch = PURPOSE_FOR.exec(scan) ?? PURPOSE_AT.exec(scan);
    if (purposeMatch) {
      const text = (purposeMatch[1] as string).trim();
      if (text.length >= 3) {
        fields.payee = text.slice(0, 120);
        evidence.payee = text;
      }
    }

    return {
      fields,
      confidence: scoreConfidence(fields, evidence),
      evidence,
      parserName: ucblParser.name,
    };
  },
};
