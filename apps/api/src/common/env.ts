import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';

/**
 * Boot-time configuration checks.
 *
 * The failure this exists to stop: the systemd unit points `EnvironmentFile` at
 * `/etc/hishab/hishab.env`, and if that file is mistyped, moved, or chmod'ed so
 * the service user cannot read it, systemd starts the process anyway with none
 * of those variables set. Every `?? 'change-me-...'` default in the codebase
 * then quietly becomes the live configuration — and for `JWT_ACCESS_SECRET`
 * that means the API both signs and accepts access tokens with a constant
 * printed in `.env.example`. Anyone who can read this repository can mint an
 * administrator's token. Nothing about that is visible in the logs, the health
 * check, or the UI; the box just looks fine.
 *
 * So production refuses to boot instead. Outside production the same problems
 * are only logged: the e2e suite and a developer's laptop must keep working
 * without a fully provisioned secret file.
 */

const logger = new Logger('Env');

const isProduction = (): boolean => process.env.NODE_ENV === 'production';

/**
 * Strings that are published — in `.env.example`, in this repository's history,
 * in every fork of it. A value matching one of these is known to everybody who
 * can read GitHub, so it is not a secret regardless of which variable holds it.
 *
 * Prefix matching, because the placeholders are conventions rather than a fixed
 * list. `openssl rand -base64 48` emits `A-Za-z0-9+/=` only, so a real secret
 * cannot begin with `change-me` or `dev-`; if a hand-written one ever does, the
 * operator regenerates it, which is the outcome we want anyway.
 */
const PLACEHOLDER_PREFIXES = ['change-me', 'changeme', 'dev-', 'your-', 'replace-me', 'todo'];

/** The example `DATABASE_URL` ships these credentials. Real deploys generate a password. */
const PUBLISHED_DB_CREDENTIALS = 'hishab:hishab@';

/**
 * Is this value blank, or one of the examples the repository publishes?
 *
 * Exported because `mail-accounts/mail-crypto.ts` refuses to derive a key from
 * one, and it used to keep its own copy of the prefix list — two lists that
 * could drift, in a check whose entire job is to notice that a secret is not
 * secret.
 */
export function isPlaceholder(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === '') return true;
  if (v.includes(PUBLISHED_DB_CREDENTIALS)) return true;
  return PLACEHOLDER_PREFIXES.some((prefix) => v.startsWith(prefix));
}

interface Secret {
  name: string;
  /** What concretely breaks when this is wrong. Printed in the failure message. */
  why: string;
}

/** Absent or placeholder is fatal: the code reads these on the request path. */
const REQUIRED: Secret[] = [
  {
    name: 'JWT_ACCESS_SECRET',
    why: 'access tokens would be signed and accepted with a constant published in .env.example, which is a complete authentication bypass',
  },
  {
    name: 'DATABASE_URL',
    why: 'Prisma would fail at the first user request rather than at boot, and a URL still carrying the published example credentials points production at the wrong database',
  },
];

/**
 * Placeholder is fatal, absent is not.
 *
 * `infra/deploy/10-provision.sh` writes some of these and deliberately leaves
 * others empty (the Telegram bot token is set out of band; the ingestion
 * webhook is closed until someone opens it). An empty value is a feature that
 * is switched off. A *published* value is a feature that is switched on and
 * wide open, which is the opposite.
 */
const NEVER_PLACEHOLDER: Secret[] = [
  {
    name: 'JWT_REFRESH_SECRET',
    why: 'a published value would make refresh tokens forgeable the moment anything starts signing them',
  },
  {
    name: 'INGEST_ENCRYPTION_KEY',
    why: 'inbound message bodies would be encrypted under a key everyone has, which is worse than not encrypting them because it reads as protection',
  },
  {
    name: 'INGESTION_WEBHOOK_SECRET',
    why: 'every workspace webhook secret is derived from it, so a published root makes all of them guessable',
  },
  {
    name: 'TELEGRAM_WEBHOOK_SECRET',
    why: 'anyone could post forged Telegram updates to the webhook',
  },
  { name: 'TELEGRAM_BOT_TOKEN', why: 'that is full control of the bot' },
  { name: 'SMTP_PASS', why: 'that is the mailbox verification and reset links are sent from' },
];

/** Wrong-but-not-dangerous. Logged in production, never fatal. */
const ADVISORY: Array<{ name: string; fallback: string; why: string }> = [
  {
    name: 'APP_URL',
    fallback: 'https://takatracker.com',
    why: 'every verification and password-reset link in outgoing email points at that host',
  },
  {
    name: 'CORS_ORIGINS',
    fallback: 'http://localhost:3000',
    why: 'the browser would refuse every call the deployed web app makes',
  },
];

/** `openssl rand -base64 48` gives 64 characters; anything far under is hand-typed. */
const MIN_SECRET_LENGTH = 32;

/**
 * Throw in production when a secret is missing or still at a published
 * placeholder; log the same findings everywhere else. Call it from `main.ts`
 * before the app listens, and after `AppModule` has been imported — importing
 * it is what runs `ConfigModule.forRoot`, which is what puts a local `.env`
 * into `process.env`.
 */
export function assertProductionEnv(): void {
  const problems: string[] = [];
  const warnings: string[] = [];

  for (const { name, why } of REQUIRED) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') {
      problems.push(`${name} is not set — ${why}.`);
    } else if (isPlaceholder(raw)) {
      problems.push(`${name} is still at a placeholder value published in .env.example — ${why}.`);
    }
  }

  for (const { name, why } of NEVER_PLACEHOLDER) {
    const raw = process.env[name];
    if (raw !== undefined && raw.trim() !== '' && isPlaceholder(raw)) {
      problems.push(`${name} is still at a placeholder value published in .env.example — ${why}.`);
    }
  }

  /* A short but genuinely random secret is weak, not public, so this warns
   * rather than refusing to start. Bricking a box that is serving traffic over
   * a key-length opinion would be a worse outage than the one it prevents. */
  const accessSecret = process.env.JWT_ACCESS_SECRET?.trim() ?? '';
  if (
    accessSecret !== '' &&
    !isPlaceholder(accessSecret) &&
    accessSecret.length < MIN_SECRET_LENGTH
  ) {
    warnings.push(
      `JWT_ACCESS_SECRET is only ${accessSecret.length} characters. Regenerate it with ` +
        '`openssl rand -base64 48`.',
    );
  }

  for (const { name, fallback, why } of ADVISORY) {
    if (!process.env[name]?.trim()) {
      warnings.push(`${name} is not set, so it falls back to ${fallback} — ${why}.`);
    }
  }

  if (!isProduction()) {
    // Never fatal here: the e2e suite and a fresh clone both run on .env.example
    // values on purpose. Say what would stop a real deploy and carry on.
    if (problems.length > 0 || warnings.length > 0) {
      logger.warn(
        [
          `Environment check (NODE_ENV=${process.env.NODE_ENV ?? 'undefined'}): ` +
            `${problems.length} of these would stop a production boot.`,
          ...problems.map((p) => `  - ${p}`),
          ...warnings.map((w) => `  - ${w}`),
        ].join('\n'),
      );
    }
    return;
  }

  for (const warning of warnings) logger.warn(warning);

  if (problems.length > 0) {
    throw new Error(
      [
        `Refusing to start: ${problems.length} production environment problem(s).`,
        ...problems.map((p) => `  - ${p}`),
        'A missing or unreadable EnvironmentFile (/etc/hishab/hishab.env) leaves every one of ' +
          'these unset at once — check the path in the systemd unit and that the service user ' +
          'can read the file.',
      ].join('\n'),
    );
  }
}

let cachedAccessSecret: string | undefined;

/**
 * The one source of the access-token signing key.
 *
 * Read through this and never through `process.env` directly. Three places need
 * the value — `JwtModule` in auth.module.ts, `JwtStrategy`, and the signing call
 * in auth.service.ts — and they used to read it at three different moments:
 * `JwtModule.register` runs while the module file is still being imported, i.e.
 * *before* `ConfigModule.forRoot` has copied `.env` into `process.env`, while
 * the other two run later and saw a different value. It only ever worked
 * because the `?? 'change-me-access'` default happened to equal what `.env`
 * contained. Memoising here means all three get one value whatever order they
 * ask in.
 *
 * There is deliberately no published fallback. In production a missing secret
 * throws — `assertProductionEnv` should already have caught it, this is the
 * backstop for the case where something bypasses that. Outside production a
 * missing secret becomes a random per-process value: tokens stop working across
 * a restart, which is mildly annoying, and that is a much better failure than a
 * constant anyone can read signing tokens that look genuine.
 */
export function jwtAccessSecret(): string {
  if (cachedAccessSecret !== undefined) return cachedAccessSecret;

  const configured = process.env.JWT_ACCESS_SECRET?.trim();

  if (isProduction()) {
    if (!configured || isPlaceholder(configured)) {
      throw new Error(
        'JWT_ACCESS_SECRET is missing or still at a placeholder value. Refusing to sign or ' +
          'accept access tokens with a key that is published in .env.example.',
      );
    }
    cachedAccessSecret = configured;
    return cachedAccessSecret;
  }

  if (configured) {
    // Development and test keep whatever is configured, placeholder included, so
    // a checked-out repo behaves the same on every machine and across restarts.
    if (isPlaceholder(configured)) {
      logger.warn(
        'JWT_ACCESS_SECRET is a placeholder. Fine here, fatal in production — see env.ts.',
      );
    }
    cachedAccessSecret = configured;
    return cachedAccessSecret;
  }

  cachedAccessSecret = randomBytes(48).toString('base64url');
  logger.warn(
    'JWT_ACCESS_SECRET is not set. Using a random key for this process only; every session ' +
      'ends when the API restarts.',
  );
  return cachedAccessSecret;
}
