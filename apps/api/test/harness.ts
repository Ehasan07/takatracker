import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { installBigIntJson } from '../src/common/bigint-json';
import { PrismaService } from '../src/prisma/prisma.service';

installBigIntJson();

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
  http: () => request.Agent;
}

export async function createTestApp(): Promise<TestContext> {
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
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "AuditEvent", "LedgerEntry", "Transaction", "LoanPayment", "Loan", "SavingsInstallment", "SavingsPlan", "PremiumPayment", "InsurancePolicy", "Category", "Account", "Person", "Invitation", "Membership", "TelegramConnection", "CardReminderCycle", "WorkspaceFeatureOverride", "Workspace", "RefreshToken", "User" RESTART IDENTITY CASCADE',
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
