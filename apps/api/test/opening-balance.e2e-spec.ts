import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toLocalDateString } from '@hishab/shared';
import {
  auth,
  createTestApp,
  resetDatabase,
  signup,
  unlimit,
  type SignedUpUser,
  type TestContext,
} from './harness';

/**
 * An opening balance is a transaction, and it has a date.
 *
 * It used to be two things at once: an `Account.openingBalance` column that
 * posted no ledger entry and carried no date, and an `OPENING_BALANCE`
 * transaction type that did the job properly. The column won every balance and
 * lost every audit — a figure inside every total with nothing behind it, and
 * because it had no date, a balance sheet dated last January showed the opening
 * balance of an account opened in June. Two periods were therefore not
 * comparable, which is what IAS 1.38 is about.
 *
 * Three things are asserted here, and the middle one is the whole point:
 *
 *   1. the balance is the same as it always was, and there is now a dated
 *      transaction to account for it;
 *   2. a balance sheet dated before that day does **not** include it;
 *   3. the data migration that moved the old column can run twice and still
 *      leaves one transaction.
 */
describe('an opening balance', () => {
  let ctx: TestContext;
  let user: SignedUpUser;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    user = await signup(ctx);
    // Several accounts, and the free plan grants two. This suite is about
    // opening balances, not about what a plan sells.
    await unlimit(ctx, user.workspaceId);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  const post = (path: string, body: Record<string, unknown>) =>
    ctx.http().post(path).set(auth(user)).send(body);
  const get = (path: string) => ctx.http().get(path).set(auth(user));

  const account = async (body: Record<string, unknown>) =>
    (await post('/v1/accounts', body).expect(201)).body as {
      id: string;
      openingBalance: number;
      openingBalanceDate: string | null;
      balanceMinor: number;
    };

  it('books a dated ledger transaction and lands on the same balance as before', async () => {
    const made = await account({
      name: 'নগদ',
      type: 'CASH',
      openingBalance: 1_000_000,
      openingBalanceDate: '2026-06-01',
    });

    // The API shape is unchanged: openingBalance in, openingBalance out.
    expect(made.openingBalance).toBe(1_000_000);
    expect(made.openingBalanceDate).toBe('2026-06-01');
    expect(made.balanceMinor).toBe(1_000_000);

    /* And now there is something behind it. Under the column there was no
       transaction, no entry and no audit row — the balance simply was. */
    const tx = await ctx.prisma.transaction.findFirst({
      where: {
        workspaceId: user.workspaceId,
        type: 'OPENING_BALANCE',
        deletedAt: null,
        entries: { some: { accountId: made.id } },
      },
      include: { entries: { include: { account: true } } },
    });
    expect(tx).toBeTruthy();
    expect(toLocalDateString(tx!.date, 'Asia/Dhaka')).toBe('2026-06-01');

    /* Two legs, balanced, with the other side on the workspace's equity
       account — never on income, so an opening balance can never be mistaken
       for a month's earnings. */
    expect(tx!.entries).toHaveLength(2);
    const own = tx!.entries.find((e) => e.accountId === made.id);
    const other = tx!.entries.find((e) => e.accountId !== made.id);
    expect(own!.direction).toBe('DEBIT');
    expect(Number(own!.amountMinor)).toBe(1_000_000);
    expect(other!.direction).toBe('CREDIT');
    expect(other!.account.systemKey).toBe('SYSTEM_EQUITY');

    // It is in the transaction list, which the column never was.
    const list = await get('/v1/transactions').expect(200);
    expect(
      list.body.items.some(
        (i: { type: string; date: string }) =>
          i.type === 'OPENING_BALANCE' && i.date === '2026-06-01',
      ),
    ).toBe(true);
  });

  it('carries a debt in as a negative balance, the way every other balance is signed', async () => {
    const card = await account({
      name: 'ক্রেডিট কার্ড',
      type: 'CREDIT_CARD',
      openingBalance: -1_500_000,
      openingBalanceDate: '2026-06-01',
    });
    expect(card.openingBalance).toBe(-1_500_000);
    expect(card.balanceMinor).toBe(-1_500_000);

    const entry = await ctx.prisma.ledgerEntry.findFirst({
      where: { accountId: card.id, transaction: { type: 'OPENING_BALANCE' } },
    });
    // Credit the card, debit equity: the mirror of the cash case above.
    expect(entry!.direction).toBe('CREDIT');
  });

  it('is left off a balance sheet dated before the day it was true', async () => {
    /* The defect, restated as a test. The old column had no date, so this
       account's ৳50,000 appeared on every balance sheet ever run, including
       ones covering months before the account existed — and two periods that
       both contain a figure that belongs to neither cannot be compared. */
    const gold = await account({
      name: 'স্বর্ণ',
      type: 'ASSET',
      openingBalance: 5_000_000,
      openingBalanceDate: '2026-07-15',
    });

    const before = await get('/v1/reports/balance-sheet?asOf=2026-07-14').expect(200);
    expect(before.body.assets.some((row: { id: string }) => row.id === gold.id)).toBe(false);

    const on = await get('/v1/reports/balance-sheet?asOf=2026-07-15').expect(200);
    const row = on.body.assets.find((r: { id: string }) => r.id === gold.id);
    expect(row.amountMinor).toBe(5_000_000);

    // The two sheets differ by exactly the opening balance, and by nothing else.
    expect(on.body.netWorthMinor - before.body.netWorthMinor).toBe(5_000_000);
  });

  it('moves the transaction rather than writing a second one when it is edited', async () => {
    const bank = await account({
      name: 'ব্যাংক',
      type: 'BANK',
      openingBalance: 2_000_000,
      openingBalanceDate: '2026-06-01',
    });

    const patched = await ctx
      .http()
      .patch(`/v1/accounts/${bank.id}`)
      .set(auth(user))
      .send({ openingBalance: 3_000_000, openingBalanceDate: '2026-05-01' })
      .expect(200);

    expect(patched.body.openingBalance).toBe(3_000_000);
    expect(patched.body.openingBalanceDate).toBe('2026-05-01');
    expect(patched.body.balanceMinor).toBe(3_000_000);

    /* One transaction, not two. Two would both be counted: the balance would be
       ৳50,000 by accident and the statement would show the opening figure
       twice. */
    const count = await ctx.prisma.transaction.count({
      where: {
        workspaceId: user.workspaceId,
        type: 'OPENING_BALANCE',
        deletedAt: null,
        entries: { some: { accountId: bank.id } },
      },
    });
    expect(count).toBe(1);
  });

  it('flips the sign in place when an edit turns a balance into a debt', async () => {
    const loanish = await account({
      name: 'হাওলাত',
      type: 'LIABILITY',
      openingBalance: 400_000,
      openingBalanceDate: '2026-06-01',
    });

    const patched = await ctx
      .http()
      .patch(`/v1/accounts/${loanish.id}`)
      .set(auth(user))
      .send({ openingBalance: -400_000 })
      .expect(200);
    expect(patched.body.openingBalance).toBe(-400_000);
    expect(patched.body.balanceMinor).toBe(-400_000);
    // The date it was true is not what changed, so it stays where it was.
    expect(patched.body.openingBalanceDate).toBe('2026-06-01');

    const entries = await ctx.prisma.ledgerEntry.findMany({
      where: { accountId: loanish.id, transaction: { deletedAt: null } },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].direction).toBe('CREDIT');
  });

  it('retires the transaction when the opening balance is set back to zero', async () => {
    const wallet = await account({
      name: 'বিকাশ',
      type: 'MOBILE_WALLET',
      openingBalance: 700_000,
      openingBalanceDate: '2026-06-01',
    });

    const patched = await ctx
      .http()
      .patch(`/v1/accounts/${wallet.id}`)
      .set(auth(user))
      .send({ openingBalance: 0 })
      .expect(200);

    expect(patched.body.openingBalance).toBe(0);
    expect(patched.body.openingBalanceDate).toBeNull();
    expect(patched.body.balanceMinor).toBe(0);

    /* Soft-deleted rather than erased: the books said something for a while and
       the audit trail keeps it. What matters is that it stops counting. */
    const live = await ctx.prisma.transaction.count({
      where: {
        workspaceId: user.workspaceId,
        deletedAt: null,
        entries: { some: { accountId: wallet.id } },
      },
    });
    expect(live).toBe(0);
  });

  it('writes an audit row for setting and for changing one', async () => {
    const acc = await account({
      name: 'ডিপিএস',
      type: 'SAVINGS',
      openingBalance: 900_000,
      openingBalanceDate: '2026-06-01',
    });
    await ctx
      .http()
      .patch(`/v1/accounts/${acc.id}`)
      .set(auth(user))
      .send({ openingBalance: 950_000 })
      .expect(200);

    const actions = (
      await ctx.prisma.auditEvent.findMany({
        where: { workspaceId: user.workspaceId, entityId: acc.id },
        select: { action: true },
      })
    ).map((row) => row.action);

    /* The other half of the old defect: a column change left no trace at all,
       so a figure that moved somebody's net worth was invisible afterwards. */
    expect(actions).toContain('account.openingBalanceSet');
    expect(actions).toContain('account.openingBalanceChanged');
  });

  it('defaults to today when nobody says which day', async () => {
    const today = toLocalDateString(new Date(), 'Asia/Dhaka');
    const acc = await account({ name: 'হাতের নগদ', type: 'CASH', openingBalance: 300_000 });
    expect(acc.openingBalanceDate).toBe(today);
  });

  it('refuses to edit the field when the account has opening balances it did not write', async () => {
    /* A user may post OPENING_BALANCE transactions by hand from the transaction
       screen — money surfacing from an older book. This field addresses exactly
       one row, so when there are others it says so rather than guessing which
       of them the user meant. */
    const acc = await account({
      name: 'পুরোনো খাতা',
      type: 'CASH',
      openingBalance: 100_000,
      openingBalanceDate: '2026-06-01',
    });
    await post('/v1/transactions', {
      date: '2026-06-02',
      type: 'OPENING_BALANCE',
      amountMinor: 50_000,
      accountId: acc.id,
      description: 'পুরোনো বইয়ের বাকি',
    }).expect(201);

    const refused = await ctx
      .http()
      .patch(`/v1/accounts/${acc.id}`)
      .set(auth(user))
      .send({ openingBalance: 200_000 })
      .expect(400);
    expect(refused.body.message).toContain('একাধিক');

    // And nothing moved: both figures are still exactly where they were.
    const after = await get(`/v1/accounts/${acc.id}`).expect(200);
    expect(after.body.balanceMinor).toBe(150_000);
  });
});

/**
 * The data migration, run twice.
 *
 * The production database is live, so the file has to be safe to re-apply. The
 * proof is not a re-reading of the migration's comments: the block is sliced
 * out of `migration.sql` itself and executed against a row seeded to look like
 * a legacy one, twice, and the count is taken afterwards.
 *
 * The column is gone, so the test puts it back for the duration. That is the
 * only way to exercise the real SQL rather than a paraphrase of it, and the
 * column is dropped again at the end — nothing else in the schema or in any
 * other suite reads it, and the migration's own `DROP COLUMN IF EXISTS` means a
 * failure part-way through leaves nothing that breaks the next run.
 */
describe('the opening balance data migration', () => {
  let ctx: TestContext;
  let user: SignedUpUser;

  const MIGRATION = join(
    __dirname,
    '../prisma/migrations/20260816230000_opening_balance_to_ledger/migration.sql',
  );

  /** The `DO $$ ... $$;` block, between the markers the file carries for this. */
  function backfillSql(): string {
    const sql = readFileSync(MIGRATION, 'utf8');
    const from = sql.indexOf('-- >>> BACKFILL BEGIN');
    const to = sql.indexOf('-- <<< BACKFILL END');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    /* One statement, not several: Prisma speaks the extended query protocol and
       refuses a multi-statement string, which is exactly why the migration puts
       the whole backfill inside a single DO block. */
    return sql.slice(from, to);
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    user = await signup(ctx);
    await unlimit(ctx, user.workspaceId);
  });

  afterAll(async () => {
    await ctx.prisma.$executeRawUnsafe(
      'ALTER TABLE "Account" DROP COLUMN IF EXISTS "openingBalance"',
    );
    await ctx.app.close();
  });

  it('creates one transaction, not two, when it runs twice', async () => {
    const acc = (
      await ctx
        .http()
        .post('/v1/accounts')
        .set(auth(user))
        .send({ name: 'পুরোনো ব্যাংক', type: 'BANK' })
        .expect(201)
    ).body as { id: string };

    /* A row exactly as the live database held it before this change: a balance
       in a column, and nothing in the ledger to account for it. */
    await ctx.prisma.$executeRawUnsafe(
      'ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "openingBalance" BIGINT NOT NULL DEFAULT 0',
    );
    await ctx.prisma.$executeRawUnsafe(
      'UPDATE "Account" SET "openingBalance" = 2500000 WHERE id = $1',
      acc.id,
    );

    const sql = backfillSql();
    await ctx.prisma.$executeRawUnsafe(sql);
    await ctx.prisma.$executeRawUnsafe(sql);

    const created = await ctx.prisma.transaction.findMany({
      where: {
        workspaceId: user.workspaceId,
        type: 'OPENING_BALANCE',
        deletedAt: null,
        entries: { some: { accountId: acc.id } },
      },
      include: { entries: true },
    });

    // One transaction after two runs. Two would double the account's balance.
    expect(created).toHaveLength(1);
    expect(created[0].entries).toHaveLength(2);
    expect(created[0].externalRef).toBe(`opening-balance:${acc.id}`);

    /* And the balance the API reports is the column's old value, once. This is
       the property the whole migration is judged on: nobody's money moves. */
    const read = await ctx.http().get(`/v1/accounts/${acc.id}`).set(auth(user)).expect(200);
    expect(read.body.balanceMinor).toBe(2_500_000);
    expect(read.body.openingBalance).toBe(2_500_000);
  });

  it('dates a back-filled account at its first entry, not at the day the row was made', async () => {
    /* The date choice, defended in the migration's header. An account created
       today and then loaded with history from June is the shape this workspace
       is actually in — the Wallet import brought 9,625 back-dated records. An
       opening balance dated today would sit *after* movements it is supposed to
       precede, and June's balance sheet would show a month of spending with no
       money to spend it from. */
    const acc = (
      await ctx
        .http()
        .post('/v1/accounts')
        .set(auth(user))
        .send({ name: 'ব্যাক-ফিল', type: 'CASH' })
        .expect(201)
    ).body as { id: string };

    const cats = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    const salary = cats.body.find((c: { nameBn: string }) => c.nameBn === 'বেতন').id;
    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        date: '2026-06-10',
        type: 'INCOME',
        amountMinor: 100_000,
        accountId: acc.id,
        categoryId: salary,
      })
      .expect(201);

    await ctx.prisma.$executeRawUnsafe(
      'ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "openingBalance" BIGINT NOT NULL DEFAULT 0',
    );
    await ctx.prisma.$executeRawUnsafe(
      'UPDATE "Account" SET "openingBalance" = 400000 WHERE id = $1',
      acc.id,
    );
    await ctx.prisma.$executeRawUnsafe(backfillSql());

    const read = await ctx.http().get(`/v1/accounts/${acc.id}`).set(auth(user)).expect(200);
    expect(read.body.openingBalanceDate).toBe('2026-06-10');
    expect(read.body.balanceMinor).toBe(500_000);
  });
});
