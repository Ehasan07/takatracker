import { PrismaClient } from '@prisma/client';
import { TEST_TABLES, assertTestDatabase } from './harness';

/**
 * Wipe the test database **once**, before the whole run.
 *
 * It used to be wiped in every spec file's `beforeAll`, and that was the cause
 * of an intermittent failure that landed on a different test every time — a 403
 * on a delete, a 400 on a restore, an ECONNRESET. Thirteen files each truncating
 * a database they share is a race whatever the file ordering: a suite's app is
 * still shutting down, or an audit write is still in flight (deliberately
 * fire-and-forget), while the next suite pulls every table out from under it.
 *
 * Truncating per file was never buying isolation anyway. Every test signs up its
 * own workspace, and workspace scoping is the property the whole application is
 * built on and that dozens of tests assert directly. If one suite could see
 * another's rows, that would be the bug worth failing over — not something to
 * paper over by emptying the tables between them.
 */
export default async function globalSetup(): Promise<void> {
  assertTestDatabase();
  const prisma = new PrismaClient();
  try {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${TEST_TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );
  } finally {
    await prisma.$disconnect();
  }
}
