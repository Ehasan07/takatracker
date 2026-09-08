/**
 * Make somebody a platform operator, or take it away.
 *
 *   pnpm --filter @hishab/api exec tsx scripts/grant-super-admin.ts admin@example.com
 *   pnpm --filter @hishab/api exec tsx scripts/grant-super-admin.ts admin@example.com --revoke
 *   pnpm --filter @hishab/api exec tsx scripts/grant-super-admin.ts --list
 *
 * ## Why this is a script and not a screen
 *
 * `User.isSuperAdmin` is a column on the user rather than a workspace role,
 * precisely so that no amount of workspace administration can grant it —
 * inviting somebody to a workspace must never be able to make them an operator
 * of the platform. That reasoning only holds while there is no route that sets
 * it, so there is none, and there should not be one. Granting it is a
 * deliberate act performed on the server by whoever holds the server.
 *
 * ## What it deliberately does not do
 *
 * It does not touch `tokenVersion`, so nobody is signed out. It does not create
 * accounts: the person must already have signed up, because an operator with no
 * ordinary account is an identity nobody can attribute anything to. And it
 * writes no audit row — `AuditEvent` is per-workspace and this event belongs to
 * no workspace; the record is this script's output and the shell history of
 * whoever ran it.
 *
 * ## The DATABASE_URL it needs
 *
 * The API's own role can write this column, so the ordinary `DATABASE_URL`
 * works. On a server provisioned with split roles that is `hishab_app`, which
 * is correct: this is a row update, not a schema change.
 *
 * On the server the value is already in the environment — the deploy writes it
 * to `/etc/hishab/hishab.env` and a shell that has sourced that file has it. In
 * a checkout it is in the repo-root `.env`, which nothing has loaded, so the
 * loader below reaches for that file and only that file. It refuses to guess
 * any further: a script that silently found *some* database and then wrote to
 * it is how a development change lands in production.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

if (!process.env.DATABASE_URL) {
  const envFile = resolve(import.meta.dirname, '../../../.env');
  if (!existsSync(envFile)) {
    console.error(
      'DATABASE_URL is not set and there is no .env at the repository root.\n' +
        'On the server: set -a; . /etc/hishab/hishab.env; set +a',
    );
    process.exit(2);
  }
  process.loadEnvFile(envFile);
}

function usage(): never {
  console.error(
    'usage: tsx scripts/grant-super-admin.ts <email> [--revoke]\n' +
      '       tsx scripts/grant-super-admin.ts --list',
  );
  process.exit(2);
}

/* Constructed after the env is loaded, not at import time: Prisma validates its
 * datasource in the constructor, so a top-level client would throw before the
 * loader above ever ran — and the message it throws is not one anybody could
 * act on. */
const prisma = new PrismaClient();

async function list(): Promise<void> {
  const operators = await prisma.user.findMany({
    where: { isSuperAdmin: true },
    select: { id: true, email: true, name: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  if (operators.length === 0) {
    console.log('No platform operators. Nobody can reach /admin.');
    return;
  }

  console.log(`${operators.length} platform operator(s):`);
  for (const operator of operators) {
    console.log(`  ${operator.email}  ${operator.name}  (${operator.id})`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--list')) return list();

  const email = args
    .find((arg) => !arg.startsWith('--'))
    ?.trim()
    .toLowerCase();
  if (!email) usage();
  const revoke = args.includes('--revoke');

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, isSuperAdmin: true },
  });

  if (!user) {
    /* Not created here on purpose — see the note above. The likeliest cause is
     * a typo, and the second likeliest is that this person signed up with a
     * different address; inventing an account would hide both. */
    console.error(`No user with email ${email}. They must sign up first.`);
    process.exit(1);
  }

  const target = !revoke;
  if (user.isSuperAdmin === target) {
    console.log(
      `${user.email} is already ${target ? 'a platform operator' : 'an ordinary user'} — nothing to do.`,
    );
    return;
  }

  await prisma.user.update({ where: { id: user.id }, data: { isSuperAdmin: target } });

  console.log(
    target
      ? `${user.email} (${user.name}) is now a platform operator. /admin is open to them on their next request.`
      : `${user.email} (${user.name}) is no longer a platform operator. Access ends on their next request — SuperAdminGuard re-reads this column every time, so no session has to be killed.`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
