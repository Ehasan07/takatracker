import { Injectable, Logger } from '@nestjs/common';
import { normaliseBdPhone } from '@hishab/shared';

/**
 * Sending an SMS, through the workspace operator's own gateway.
 *
 * ## What this is for, and what it is not
 *
 * One thing: a short code somebody is waiting for. Not reminders, not
 * marketing, not receipts — every one of those is a message the reader did not
 * ask for at that second, and Telegram already carries them for free. An SMS
 * costs money per message and lands on a lock screen, so it is reserved for the
 * case where the alternative is somebody unable to get into their own books.
 *
 * ## Only Bangladeshi numbers
 *
 * Enforced here rather than trusted from the caller. The gateway is a
 * Bangladeshi provider on a Bangladeshi route; an international number would
 * either be rejected downstream or, worse, be billed at a rate nobody budgeted
 * for. `normaliseBdPhone` returns null for anything that is not a real BD
 * mobile, and null is refused.
 *
 * ## Credentials come from the environment, never the repository
 *
 * `SMS_API_KEY` and `SMS_SENDER_ID` live in `/etc/hishab/hishab.env`. A key in
 * a file that git tracks is a key in every clone, every CI log and every
 * backup of the repository.
 */

export type SmsFailure = 'NOT_CONFIGURED' | 'NOT_BD_NUMBER' | 'REJECTED' | 'UNREACHABLE';

export interface SmsResult {
  ok: boolean;
  failure?: SmsFailure;
  /** Whatever the gateway said, for the log. Never shown to a user. */
  detail?: string;
}

/** Long enough for a slow gateway, short enough that a login does not hang. */
const TIMEOUT_MS = 8_000;

const DEFAULT_ENDPOINT = 'https://msg.mram.com.bd/smsapi';

@Injectable()
export class SmsSender {
  private readonly logger = new Logger(SmsSender.name);

  /** False when the operator has not configured a gateway; callers fall back. */
  get configured(): boolean {
    return Boolean(process.env.SMS_API_KEY && process.env.SMS_SENDER_ID);
  }

  async send(rawPhone: string, message: string): Promise<SmsResult> {
    const phone = normaliseBdPhone(rawPhone);
    if (!phone) return { ok: false, failure: 'NOT_BD_NUMBER' };

    const apiKey = process.env.SMS_API_KEY;
    const senderId = process.env.SMS_SENDER_ID;
    if (!apiKey || !senderId) {
      /* Not an error the caller should surface. A gateway that is not set up
         is a reason to use email instead, not a reason to fail a sign-in. */
      this.logger.warn('SMS gateway is not configured; nothing sent');
      return { ok: false, failure: 'NOT_CONFIGURED' };
    }

    const url = new URL(process.env.SMS_API_URL ?? DEFAULT_ENDPOINT);
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('type', 'text');
    /* The gateway's documented parameter takes a comma-separated list. Exactly
       one number is passed, always: a bug that turned a code into a broadcast
       would be expensive in both senses. */
    url.searchParams.set('contacts', phone);
    url.searchParams.set('senderid', senderId);
    url.searchParams.set('msg', message);

    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = (await response.text()).trim();

      /* The provider answers 200 with a body that says what happened, so the
         status alone proves nothing. Anything that is not a success token is
         treated as a refusal and logged verbatim. */
      const ok = response.ok && /^(smsid|ok|success)/i.test(body);
      if (!ok) {
        this.logger.warn(`SMS refused for ${maskPhone(phone)}: ${body.slice(0, 200)}`);
        return { ok: false, failure: 'REJECTED', detail: body.slice(0, 200) };
      }
      return { ok: true, detail: body.slice(0, 200) };
    } catch (err) {
      const detail = (err as Error).message;
      this.logger.warn(`SMS gateway unreachable for ${maskPhone(phone)}: ${detail}`);
      return { ok: false, failure: 'UNREACHABLE', detail };
    }
  }
}

/**
 * `01712***678` for the log.
 *
 * A phone number is how you find a person. Writing whole ones into a log file
 * that gets shipped, rotated and read over somebody's shoulder is a leak with
 * no upside — the masked form is enough to match a complaint to a line.
 */
export function maskPhone(phone: string): string {
  return phone.length <= 7 ? '***' : `${phone.slice(0, 5)}***${phone.slice(-3)}`;
}
