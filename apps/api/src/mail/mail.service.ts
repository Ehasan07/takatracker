import { Injectable, Logger } from '@nestjs/common';
import { passwordChangedEmail, passwordResetEmail, verificationEmail } from './mail.templates';
import {
  LogMailTransport,
  SmtpMailTransport,
  type MailMessage,
  type MailSendResult,
  type MailTransport,
} from './mail.transport';

const APP_URL = process.env.APP_URL ?? 'https://takatracker.com';

/**
 * The one place the product sends email.
 *
 * Configuration-driven and fail-soft, same contract as `TelegramClient`:
 * nothing here throws at the caller. A verification mail that does not go out
 * must not roll back the token that was issued for it — the user can ask again,
 * and in development the log transport means the link is on screen anyway.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transport: MailTransport;

  constructor() {
    this.transport = this.resolveTransport();
  }

  /** Which transport is live. Surfaced so a health check can assert on it. */
  get transportName(): string {
    return this.transport.name;
  }

  private resolveTransport(): MailTransport {
    const host = process.env.SMTP_HOST?.trim();
    if (!host) {
      // No SMTP configured — the documented default, not an error.
      if (process.env.NODE_ENV === 'production') {
        this.logger.warn(
          'SMTP_HOST is not set: email is being written to the log, not delivered. ' +
            'Verification and password-reset links will not reach users.',
        );
      }
      return new LogMailTransport();
    }

    if (!SmtpMailTransport.isAvailable()) {
      // Configured but the optional dependency is missing. Say so loudly once
      // at boot rather than failing silently on the first reset request.
      this.logger.error(
        'SMTP_HOST is set but `nodemailer` is not installed — falling back to the log ' +
          'transport. Run: pnpm --filter @hishab/api add nodemailer',
      );
      return new LogMailTransport();
    }

    return new SmtpMailTransport({
      host,
      port: Number(process.env.SMTP_PORT ?? 587),
      user: process.env.SMTP_USER || undefined,
      pass: process.env.SMTP_PASS || undefined,
      from: process.env.MAIL_FROM ?? 'হিসাব <no-reply@takatracker.com>',
    });
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    try {
      const result = await this.transport.send(message);
      if (!result.ok) {
        this.logger.warn(`Mail "${message.subject}" not delivered: ${result.error ?? 'unknown'}`);
      }
      return result;
    } catch (err) {
      // Belt and braces: a transport is contractually not supposed to throw.
      this.logger.error(`Mail transport threw: ${(err as Error).message}`);
      return { ok: false, transport: this.transport.name, error: 'transport threw' };
    }
  }

  // --- the three messages the product actually sends -------------------------

  sendVerification(params: {
    to: string;
    name: string;
    token: string;
    expiresInHours: number;
  }): Promise<MailSendResult> {
    return this.send(
      verificationEmail({
        to: params.to,
        name: params.name,
        // The token rides in the query string of a web route, never in a path
        // segment — proxies and analytics log paths far more eagerly.
        url: `${APP_URL}/verify-email?token=${encodeURIComponent(params.token)}`,
        expiresInHours: params.expiresInHours,
      }),
    );
  }

  sendPasswordReset(params: {
    to: string;
    name: string;
    token: string;
    expiresInMinutes: number;
  }): Promise<MailSendResult> {
    return this.send(
      passwordResetEmail({
        to: params.to,
        name: params.name,
        url: `${APP_URL}/reset-password?token=${encodeURIComponent(params.token)}`,
        expiresInMinutes: params.expiresInMinutes,
      }),
    );
  }

  sendPasswordChanged(params: { to: string; name: string }): Promise<MailSendResult> {
    return this.send(passwordChangedEmail(params));
  }
}
