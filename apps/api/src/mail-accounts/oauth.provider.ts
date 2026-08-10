import { Injectable } from '@nestjs/common';
import type { MailProvider as MailProviderKind } from '@prisma/client';
import {
  MailProviderUnavailableError,
  type MailConnectionConfig,
  type MailProvider,
  type MailSession,
} from './mail-provider';

/**
 * Gmail and Microsoft over OAuth — **not implemented**, and the enum values
 * exist so that they can be, behind this same interface.
 *
 * ================================================================
 *  NOT IMPLEMENTED. `POST /mail-accounts` refuses `GMAIL_OAUTH`
 *  and `OUTLOOK_OAUTH` with 503 before it reaches this class.
 * ================================================================
 *
 * ## Why they are the ones that will matter
 *
 * `imap.provider.ts` sets out the problem: Microsoft has already removed basic
 * authentication, so no Microsoft-hosted address can ever be connected over
 * IMAP, and Google keeps narrowing app passwords. Between them that is most
 * business email in the world. IMAP remains right for self-hosted, cPanel, Zoho
 * and the local hosts a lot of Bangladeshi businesses actually use — but it is
 * not the path to Gmail and it is not a path to Microsoft at all.
 *
 * ## What OAuth needs that IMAP did not
 *
 * None of this is code that belongs in a provider class, which is why the stub
 * is a stub rather than a half-attempt:
 *
 *  - **A registered application per vendor** — a Google Cloud project with the
 *    Gmail API enabled, and an Azure app registration. Both require the
 *    deployment's own client id and secret, so two more entries in
 *    `/etc/hishab/hishab.env`.
 *  - **A verified restricted scope.** `gmail.readonly` is a *restricted* scope:
 *    Google requires a security assessment by a third-party auditor, renewed
 *    annually, before an app may hold it for public users. That review has a
 *    real cost and a lead time measured in weeks. It is the actual blocker here,
 *    not the code.
 *  - **A redirect flow**, which means two endpoints this module does not have:
 *    one to start the consent screen and one to receive the code. Neither fits
 *    the `POST /mail-accounts` shape — a browser round-trip through a third
 *    party cannot be a JSON request body.
 *  - **Token refresh, and revocation that is not our decision.** The refresh
 *    token goes in `secretCipher` exactly like a password does (`OAuthSecret` in
 *    `mail-provider.ts` is already the right shape). Access tokens are minted
 *    per session and never stored. A user revoking access in their Google
 *    account must surface as `AUTH_FAILED` on the next sweep — the same path a
 *    rejected IMAP password takes, which is the point of putting these behind
 *    one interface.
 *
 * When it is built, the mail transport underneath can still be IMAP —
 * `XOAUTH2` against `imap.gmail.com` with a minted access token — so `open()`
 * would reuse whatever `imap.provider.ts` grows, with a different auth step.
 * That is the cheapest version and it is why the seam is where it is.
 */
abstract class UnimplementedOAuthProvider implements MailProvider {
  abstract readonly kind: MailProviderKind;
  /** Never null on these two by definition — the class is the unimplemented case. */
  abstract readonly unavailableReason: string;
  protected abstract readonly label: string;

  private unavailable(): never {
    throw new MailProviderUnavailableError(
      `${this.label} is not implemented. See oauth.provider.ts for what it needs.`,
      this.unavailableReason,
    );
  }

  verify(_config: MailConnectionConfig): Promise<void> {
    return this.unavailable();
  }

  open(_config: MailConnectionConfig): Promise<MailSession> {
    return this.unavailable();
  }
}

@Injectable()
export class GmailOAuthProvider extends UnimplementedOAuthProvider {
  readonly kind: MailProviderKind = 'GMAIL_OAUTH';
  protected readonly label = 'Gmail OAuth';
  readonly unavailableReason =
    'Gmail সরাসরি সংযোগ (OAuth) এখনো চালু হয়নি। আপাতত অ্যাপ পাসওয়ার্ড দিয়ে IMAP ব্যবহার করুন।';
}

@Injectable()
export class OutlookOAuthProvider extends UnimplementedOAuthProvider {
  readonly kind: MailProviderKind = 'OUTLOOK_OAUTH';
  protected readonly label = 'Outlook OAuth';
  /* No "use IMAP instead" here, unlike Gmail — for a Microsoft-hosted mailbox
   * there is no instead. Basic auth is gone and OAuth is the only door. */
  readonly unavailableReason =
    'Outlook / Microsoft 365 সংযোগ এখনো চালু হয়নি। Microsoft পুরোনো পদ্ধতি (IMAP পাসওয়ার্ড) বন্ধ করে দিয়েছে, তাই এই মেইলবক্স এখন যুক্ত করা যাবে না।';
}
