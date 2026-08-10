/**
 * Development seed. Creates one demo user with the default category tree, a
 * few accounts and a month of realistic Bangladeshi transactions.
 *
 * Never runs against production: guarded by NODE_ENV.
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { DEFAULT_CATEGORIES, SYSTEM_ACCOUNT_SEED, expandSimpleTransaction } from '@hishab/core';
import { fromLocalDateString } from '@hishab/shared';

const prisma = new PrismaClient();

const DEMO_EMAIL = process.env.SEED_EMAIL ?? 'demo@takatracker.com';
const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'hishab1234';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_ALLOW_PRODUCTION !== 'true') {
    throw new Error('Refusing to seed a production database without SEED_ALLOW_PRODUCTION=true');
  }

  const existing = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (existing) {
    console.log(`Demo user ${DEMO_EMAIL} already exists — nothing to do.`);
    return;
  }

  const user = await prisma.user.create({
    data: {
      email: DEMO_EMAIL,
      name: 'ডেমো ব্যবহারকারী',
      passwordHash: await argon2.hash(DEMO_PASSWORD, { type: argon2.argon2id }),
    },
  });

  const workspace = await prisma.workspace.create({
    data: {
      name: 'ডেমো',
      ownerUserId: user.id,
      memberships: { create: { userId: user.id, role: 'OWNER' } },
    },
  });

  await prisma.account.createMany({
    data: SYSTEM_ACCOUNT_SEED.map((a, i) => ({
      workspaceId: workspace.id,
      name: a.name,
      type: a.type,
      systemKey: a.systemKey,
      sortOrder: 1000 + i,
    })),
  });

  await prisma.category.createMany({
    data: DEFAULT_CATEGORIES.map((c) => ({
      workspaceId: workspace.id,
      name: c.name,
      nameBn: c.nameBn,
      kind: c.kind,
      icon: c.icon,
      sortOrder: c.sortOrder,
      isSystem: true,
      searchAliases: [...c.searchAliases],
    })),
  });

  const cash = await prisma.account.create({
    data: { workspaceId: workspace.id, name: 'নগদ টাকা', type: 'CASH', sortOrder: 1 },
  });
  const bank = await prisma.account.create({
    data: {
      workspaceId: workspace.id,
      name: 'ব্র্যাক ব্যাংক',
      type: 'BANK',
      institution: 'BRAC Bank',
      accountNumberMasked: '****4521',
      matchHints: ['4521', 'BRAC BANK'],
      sortOrder: 2,
    },
  });
  const bkash = await prisma.account.create({
    data: {
      workspaceId: workspace.id,
      name: 'বিকাশ',
      type: 'MOBILE_WALLET',
      institution: 'bKash',
      accountNumberMasked: '****7788',
      matchHints: ['7788', 'bKash', 'BKASH'],
      sortOrder: 3,
    },
  });

  const system = {
    incomeAccountId: (await findSystem(workspace.id, 'SYSTEM_INCOME')).id,
    expenseAccountId: (await findSystem(workspace.id, 'SYSTEM_EXPENSE')).id,
    equityAccountId: (await findSystem(workspace.id, 'SYSTEM_EQUITY')).id,
  };

  const categories = await prisma.category.findMany({ where: { workspaceId: workspace.id } });
  const cat = (nameBn: string): string => {
    const found = categories.find((c) => c.nameBn === nameBn);
    if (!found) throw new Error(`Seed category missing: ${nameBn}`);
    return found.id;
  };

  const today = new Date();
  const month = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`;

  const rows = [
    { d: '01', t: 'OPENING_BALANCE' as const, amt: 4500000, acc: bank.id, desc: 'প্রারম্ভিক জের' },
    { d: '01', t: 'OPENING_BALANCE' as const, amt: 350000, acc: cash.id, desc: 'প্রারম্ভিক জের' },
    {
      d: '02',
      t: 'INCOME' as const,
      amt: 8500000,
      acc: bank.id,
      c: 'বেতন',
      desc: 'জুলাই মাসের বেতন',
    },
    {
      d: '03',
      t: 'EXPENSE' as const,
      amt: 1800000,
      acc: bank.id,
      c: 'বাসা ভাড়া',
      desc: 'বাসা ভাড়া',
    },
    {
      d: '04',
      t: 'TRANSFER' as const,
      amt: 500000,
      acc: bank.id,
      to: bkash.id,
      desc: 'বিকাশে পাঠানো',
    },
    {
      d: '05',
      t: 'EXPENSE' as const,
      amt: 245000,
      acc: bkash.id,
      c: 'খাবার ও বাজার',
      desc: 'সাপ্তাহিক বাজার',
    },
    { d: '06', t: 'EXPENSE' as const, amt: 34500, acc: bkash.id, c: 'যাতায়াত', desc: 'উবার' },
    {
      d: '08',
      t: 'EXPENSE' as const,
      amt: 89900,
      acc: bkash.id,
      c: 'মোবাইল/ইন্টারনেট',
      desc: 'ইন্টারনেট বিল',
    },
    {
      d: '10',
      t: 'EXPENSE' as const,
      amt: 120000,
      acc: cash.id,
      c: 'ইউটিলিটি',
      desc: 'বিদ্যুৎ বিল',
    },
    {
      d: '12',
      t: 'INCOME' as const,
      amt: 1500000,
      acc: bkash.id,
      c: 'ফ্রিল্যান্স',
      desc: 'ফ্রিল্যান্স পেমেন্ট',
    },
    { d: '15', t: 'EXPENSE' as const, amt: 65000, acc: cash.id, c: 'স্বাস্থ্য', desc: 'ওষুধ' },
    { d: '18', t: 'EXPENSE' as const, amt: 500000, acc: bank.id, c: 'শিক্ষা', desc: 'স্কুল ফি' },
    { d: '20', t: 'EXPENSE' as const, amt: 250000, acc: bank.id, c: 'দান/যাকাত', desc: 'দান' },
  ];

  for (const row of rows) {
    const entries = expandSimpleTransaction(
      {
        type: row.t,
        amountMinor: row.amt,
        accountId: row.acc,
        counterAccountId: row.to,
        categoryId: row.c ? cat(row.c) : undefined,
      },
      system,
    );
    await prisma.transaction.create({
      data: {
        workspaceId: workspace.id,
        createdByUserId: user.id,
        date: fromLocalDateString(`${month}-${row.d}`),
        type: row.t,
        description: row.desc,
        source: 'MANUAL',
        entries: {
          create: entries.map((e) => ({
            workspaceId: workspace.id,
            accountId: e.accountId,
            categoryId: e.categoryId ?? null,
            amountMinor: BigInt(e.amountMinor),
            direction: e.direction,
            currency: e.currency,
            fxRate: e.fxRate,
          })),
        },
      },
    });
  }

  console.log(`Seeded ${DEMO_EMAIL} / ${DEMO_PASSWORD} with ${rows.length} transactions.`);
}

async function findSystem(workspaceId: string, systemKey: string) {
  return prisma.account.findFirstOrThrow({ where: { workspaceId, systemKey } });
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
