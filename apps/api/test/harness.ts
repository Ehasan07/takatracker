import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { installBigIntJson } from '../src/common/bigint-json';
import { PrismaService } from '../src/prisma/prisma.service';

installBigIntJson();

/* ---------------------------------------------------------------------------
 * Guard: never truncate a database that is not a throwaway.
 *
 * This suite wipes every table, and `src/app.module.ts` loads the repo-root
 * `.env` — which points at the developer's own working database. Following the
 * README (`pnpm db:seed` then `pnpm test`) therefore used to destroy real data.
 * `vitest.config.ts` now defaults DATABASE_URL to `hishab_test`, but an
 * exported DATABASE_URL in the shell still wins, so the last line of defence
 * lives here: refuse, loudly, unless the connection string names a database
 * that is unmistakably disposable.
 * ------------------------------------------------------------------------- */

/** Names that are always accepted, plus the `*_test` suffix rule below. */
const TEST_DATABASE_NAMES = new Set(['hishab_test', 'hishab_e2e']);

function databaseNameOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `DATABASE_URL is not a valid connection string, so the test suite cannot tell which ` +
        `database it would truncate. Refusing to run. Got: ${url}`,
    );
  }
  // "/hishab_test?schema=public" -> "hishab_test"
  return decodeURIComponent(parsed.pathname.replace(/^\//, ''));
}

/**
 * Throw unless DATABASE_URL points at a test database. Returns the database
 * name so callers can log it.
 */
export function assertTestDatabase(url = process.env.DATABASE_URL): string {
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. The API test suite truncates every table, so it refuses to ' +
        'guess. Run it from apps/api (vitest.config.ts defaults to hishab_test) or set ' +
        'DATABASE_URL to a test database explicitly.',
    );
  }

  const name = databaseNameOf(url);
  const isTestDatabase = TEST_DATABASE_NAMES.has(name) || name.endsWith('_test');

  if (!isTestDatabase) {
    throw new Error(
      `Refusing to run the API test suite against database "${name}": every table would be ` +
        `TRUNCATEd and the data is not coming back.\n` +
        `DATABASE_URL must name a test database — "hishab_test", "hishab_e2e", or any name ` +
        `ending in "_test".\n` +
        `Fix: unset DATABASE_URL and run \`pnpm test\` from apps/api (it defaults to ` +
        `hishab_test), or point it somewhere disposable. Creating and migrating that database ` +
        `is one command — \`migrate deploy\` creates it if it is missing:\n` +
        `  DATABASE_URL="postgresql://hishab:hishab@localhost:5433/hishab_test?schema=public" \\\n` +
        `    pnpm --filter @hishab/api exec prisma migrate deploy`,
    );
  }

  return name;
}

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  http: () => request.Agent;
}

export async function createTestApp(): Promise<TestContext> {
  /* Before the app connects, not just before the TRUNCATE: a suite that signs
   * users up would otherwise write into the wrong database before the first
   * resetDatabase() call ever ran. */
  assertTestDatabase();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('v1');
  app.use(cookieParser());
  await app.init();

  const prisma = app.get(PrismaService);
  return {
    app,
    prisma,
    http: () => request(app.getHttpServer() as Parameters<typeof request>[0]),
  };
}

/** Wipe every table between suites. Order matters only for readability — CASCADE does the work. */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  assertTestDatabase();
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditEvent", "LedgerEntry", "Transaction", "TransactionDraft", "IngestionMessage", "ImportBatch", "Attachment", "EmailToken", "LoanPayment", "Loan", "SavingsInstallment", "SavingsPlan", "PremiumPayment", "InsurancePolicy", "Category", "Account", "Person", "Invitation", "Membership", "TelegramConnection", "CardReminderCycle", "WorkspaceFeatureOverride", "Workspace", "RefreshToken", "User" RESTART IDENTITY CASCADE',
  );
}

let counter = 0;
export function uniqueEmail(prefix = 'user'): string {
  counter += 1;
  return `${prefix}-${process.pid}-${counter}@example.test`;
}

export interface SignedUpUser {
  id: string;
  email: string;
  workspaceId: string;
  accessToken: string;
  refreshToken: string;
}

export async function signup(ctx: TestContext, email = uniqueEmail()): Promise<SignedUpUser> {
  const res = await ctx
    .http()
    .post('/v1/auth/signup')
    .send({ email, password: 'hishab1234', name: 'পরীক্ষা ব্যবহারকারী' })
    .expect(201);

  return {
    id: res.body.user.id as string,
    email,
    workspaceId: res.body.workspace.id as string,
    accessToken: res.body.accessToken as string,
    refreshToken: res.body.refreshToken as string,
  };
}

export const auth = (user: SignedUpUser) => ({ Authorization: `Bearer ${user.accessToken}` });
