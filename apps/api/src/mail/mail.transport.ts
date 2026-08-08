import { Logger } from '@nestjs/common';

/**
 * Outbound mail transports.
 *
 * Same shape as `TelegramClient`: the transport never throws at the caller, it
 * reports a failure. An undelivered email must not take down the request that
 * triggered it — a signup that 500s because SMTP is asleep is worse than a
 * signup with no welcome mail.
 */

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text is the real message; the HTML part is a courtesy. */
  text: string;
  html: string;
}

export interface MailSendResult {
  ok: boolean;
  /** Which transport handled it — 'log' means nothing left this machine. */
  transport: string;
  error?: string;
}

export interface MailTransport {
  readonly name: string;
  send(message: MailMessage): Promise<MailSendResult>;
}

/**
 * The default. Renders the message into the Nest logger instead of sending it.
 *
 * This is not a stub: it is how the whole verification and reset flow is
 * exercised in development and in the e2e suite. The link is printed in full
 * so it can be copied out of the terminal. That is also exactly why it must
 * never be the transport in production — see `MailService.resolveTransport`,
 * which refuses to start production on it silently.
 */
export class LogMailTransport implements MailTransport {
  readonly name = 'log';
  private readonly logger = new Logger('MailService');

  async send(message: MailMessage): Promise<MailSendResult> {
    this.logger.log(
      [
        '',
        '──────── EMAIL (log transport, nothing was sent) ────────',
        `To:      ${message.to}`,
        `Subject: ${message.subject}`,
        '',
        message.text,
        '─────────────────────────────────────────────────────────',
      ].join('\n'),
    );
    return { ok: true, transport: this.name };
  }
}

// ---------------------------------------------------------------------------
// SMTP seam
//
// `nodemailer` is deliberately NOT a dependency of @hishab/api. Nothing in the
// product sends mail over SMTP yet and adding a dependency for a transport
// nobody has configured is dead weight.
//
// TO ENABLE SMTP:
//   1. pnpm --filter @hishab/api add nodemailer
//   2. pnpm --filter @hishab/api add -D @types/nodemailer
//   3. set SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / MAIL_FROM
//
// Nothing else changes. `SmtpMailTransport` below already speaks the interface;
// it loads nodemailer at runtime, and until the package is installed it reports
// that clearly once and MailService falls back to the log transport. No code
// path here imports nodemailer statically, so the build does not need it.
// ---------------------------------------------------------------------------

export interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
}

/** The sliver of nodemailer's surface this transport uses. */
interface NodemailerLike {
  createTransport(options: Record<string, unknown>): {
    sendMail(mail: Record<string, unknown>): Promise<unknown>;
  };
}

export class SmtpMailTransport implements MailTransport {
  readonly name = 'smtp';
  private readonly logger = new Logger('MailService');
  private transporter: ReturnType<NodemailerLike['createTransport']> | null = null;

  constructor(private readonly config: SmtpConfig) {}

  /**
   * True when nodemailer is actually installed. MailService asks before
   * choosing this transport so a half-configured server degrades to logging
   * rather than throwing on the first password reset of the day.
   */
  static isAvailable(): boolean {
    return SmtpMailTransport.load() !== null;
  }

  private static load(): NodemailerLike | null {
    try {
      // Optional peer, resolved at runtime only. See the seam note above.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('nodemailer') as NodemailerLike;
    } catch {
      return null;
    }
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    try {
      if (!this.transporter) {
        const nodemailer = SmtpMailTransport.load();
        if (!nodemailer) {
          return { ok: false, transport: this.name, error: 'nodemailer is not installed' };
        }
        this.transporter = nodemailer.createTransport({
          host: this.config.host,
          port: this.config.port,
          secure: this.config.port === 465,
          ...(this.config.user ? { auth: { user: this.config.user, pass: this.config.pass } } : {}),
        });
      }

      await this.transporter.sendMail({
        from: this.config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      return { ok: true, transport: this.name };
    } catch (err) {
      // Credentials can appear in an SMTP error string; log the class of
      // failure, never the raw exception body.
      const error = (err as Error).message?.split('\n')[0] ?? 'unknown';
      this.logger.warn(`SMTP send to ${SmtpMailTransport.maskAddress(message.to)} failed`);
      return { ok: false, transport: this.name, error };
    }
  }

  /** Recipients are personal data; the logs get enough to debug and no more. */
  private static maskAddress(address: string): string {
    const [local = '', domain = ''] = address.split('@');
    return `${local.slice(0, 2)}***@${domain}`;
  }
}
