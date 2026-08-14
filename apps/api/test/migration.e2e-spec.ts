import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WalletClient } from '../src/migration/wallet.client';
import { auth, createTestApp, resetDatabase, signup, type TestContext } from './harness';

/**
 * Bringing another product's chart of accounts across.
 *
 * The CSV arithmetic is covered in packages/core/src/migration.test.ts, so
 * nothing here re-parses a comma. What these defend is the property the whole
 * feature rests on: **nothing exists until it is applied, and applying it can
 * be taken back**. Every test below is one way that could stop being true —
 * a pull that creates something, an apply that half-finishes and leaves no
 * record, a rollback that deletes an account somebody has since used.
 *
 * The Wallet API is replaced with a fixed answer. Testing that `fetch` can page
 * a third-party server tests their server; what matters here is what this does
 * with the reply.
 */

/** Two accounts and four categories — one of each interesting kind. */
const WALLET_ACCOUNTS = [
  {
    id: 'w-acc-1',
    name: 'বিকাশ',
    accountType: 'General',
    currencyCode: 'BDT',
    archived: false,
    bankAccountNumber: '01711••••88',
    recordStats: { recordCount: 412 },
  },
  {
    id: 'w-acc-2',
    name: 'DBBL Savings',
    accountType: 'SavingAccount',
    currencyCode: 'BDT',
    archived: false,
    recordStats: { recordCount: 12 },
  },
];

const WALLET_CATEGORIES = [
  { id: 'w-cat-1', name: 'Groceries', group: { name: 'Food & Drinks' }, customCategory: false },
  /* The one the whole four-way choice exists for: Wallet had no savings plan,
     so a DPS became a category and stayed one for years. */
  { id: 'w-cat-2', name: 'DPS Sonali', group: { name: 'Investments' }, customCategory: true },
  { id: 'w-cat-3', name: 'Life insurance premium', group: { name: 'Financial expenses' } },
  { id: 'w-cat-4', name: 'Salary', group: { name: 'Income' }, customCategory: false },
];

interface Item {
  id: string;
  kind: 'ACCOUNT' | 'CATEGORY';
  sourceId: string;
  sourceName: string;
  usageCount: number;
  decision: string;
  targetType: string | null;
  targetId: string | null;
  createdEntityId: string | null;
  createdEntityKind: string | null;
  skippedReason: string | null;
}

interface Batch {
  id: string;
  status: string;
  items: Item[];
  counts: { accounts: number; categories: number; created: number; skipped: number };
}

describe('migration', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();

    /* The provider is a singleton, so replacing its two methods replaces the
       whole third-party API for the suite. No network, no token. */
    const wallet = ctx.app.get(WalletClient);
    wallet.accounts = async () => WALLET_ACCOUNTS as never;
    wallet.categories = async () => WALLET_CATEGORIES as never;
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  type User = Awaited<ReturnType<typeof signup>>;

  const pull = (user: User) =>
    ctx
      .http()
      .post('/v1/migration/wallet/pull')
      .set(auth(user))
      .send({ token: 'a-token-long-enough-to-pass-validation' });

  const detail = (user: User, id: string) =>
    ctx.http().get(`/v1/migration/batches/${id}`).set(auth(user));

  const decide = (user: User, batch: string, item: string, body: Record<string, unknown>) =>
    ctx.http().patch(`/v1/migration/batches/${batch}/items/${item}`).set(auth(user)).send(body);

  const apply = (user: User, id: string) =>
    ctx.http().post(`/v1/migration/batches/${id}/apply`).set(auth(user)).send({});

  const rollback = (user: User, id: string) =>
    ctx.http().post(`/v1/migration/batches/${id}/rollback`).set(auth(user)).send({});

  const find = (batch: Batch, sourceId: string): Item =>
    batch.items.find((i) => i.sourceId === sourceId) as Item;

  it('stages everything and creates nothing', async () => {
    /* The promise the owner was given in as many words: drafts until approved.
       If a pull ever creates an account, this is the test that says so. */
    const user = await signup(ctx);
    const before = await ctx.prisma.account.count({ where: { workspaceId: user.workspaceId } });

    const res = await pull(user);
    expect(res.status).toBe(201);
    const batch = res.body as Batch;

    expect(batch.status).toBe('DRAFT');
    expect(batch.counts).toMatchObject({ accounts: 2, categories: 4, created: 0 });
    expect(await ctx.prisma.account.count({ where: { workspaceId: user.workspaceId } })).toBe(
      before,
    );
    expect(await ctx.prisma.savingsPlan.count({ where: { workspaceId: user.workspaceId } })).toBe(
      0,
    );
  });

  it('guesses the account type, and guesses savings and insurance from the name', async () => {
    const user = await signup(ctx);
    const batch = (await pull(user)).body as Batch;

    expect(find(batch, 'w-acc-1').targetType).toBe('BANK');
    /* `SavingAccount` mapped to a spending-report category is the error that
       hides for a year because the totals still add up. */
    expect(find(batch, 'w-acc-2').targetType).toBe('SAVINGS');

    expect(find(batch, 'w-cat-2').decision).toBe('SAVINGS');
    expect(find(batch, 'w-cat-3').decision).toBe('INSURANCE');
    expect(find(batch, 'w-cat-1').decision).not.toBe('SAVINGS');
  });

  it('defaults a name that already exists here to merge, not to a second copy', async () => {
    const user = await signup(ctx);
    await ctx.prisma.category.create({
      data: { workspaceId: user.workspaceId, name: 'Groceries', nameBn: 'বাজার', kind: 'EXPENSE' },
    });

    const batch = (await pull(user)).body as Batch;
    const groceries = find(batch, 'w-cat-1');
    expect(groceries.decision).toBe('MERGE');
    expect(groceries.targetId).toBeTruthy();
  });

  it('creates what the decisions say, and nothing the decisions do not', async () => {
    const user = await signup(ctx);
    const batch = (await pull(user)).body as Batch;

    await decide(user, batch.id, find(batch, 'w-cat-1').id, { decision: 'SKIP' });

    const applied = (await apply(user, batch.id)).body as Batch;
    expect(applied.status).toBe('APPLIED');

    const accounts = await ctx.prisma.account.findMany({
      where: { workspaceId: user.workspaceId, systemKey: null, deletedAt: null },
      select: { name: true, type: true, accountNumberMasked: true },
    });
    expect(accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'বিকাশ',
          type: 'BANK',
          accountNumberMasked: '01711••••88',
        }),
        expect.objectContaining({ name: 'DBBL Savings', type: 'SAVINGS' }),
      ]),
    );

    /* The category that was really a DPS is a savings plan, and the one that
       was really a policy is a policy. Neither is a category. */
    const plans = await ctx.prisma.savingsPlan.findMany({
      where: { workspaceId: user.workspaceId },
    });
    expect(plans.map((p) => p.planName)).toEqual(['DPS Sonali']);
    const policies = await ctx.prisma.insurancePolicy.findMany({
      where: { workspaceId: user.workspaceId },
    });
    expect(policies.map((p) => p.insurer)).toEqual(['Life insurance premium']);

    expect(
      await ctx.prisma.category.count({
        where: { workspaceId: user.workspaceId, name: 'DPS Sonali', deletedAt: null },
      }),
    ).toBe(0);
    /* Skipped means skipped. */
    expect(
      await ctx.prisma.category.count({
        where: { workspaceId: user.workspaceId, name: 'Groceries', deletedAt: null },
      }),
    ).toBe(0);
    expect(find(applied, 'w-cat-1').skippedReason).toBeTruthy();
  });

  it('reads the income group as income and everything else as spending', async () => {
    const user = await signup(ctx);
    const batch = (await pull(user)).body as Batch;
    await apply(user, batch.id);

    const salary = await ctx.prisma.category.findFirst({
      where: { workspaceId: user.workspaceId, name: 'Salary' },
    });
    expect(salary?.kind).toBe('INCOME');
  });

  it('takes the whole batch back, softly', async () => {
    const user = await signup(ctx);
    const batch = (await pull(user)).body as Batch;
    await apply(user, batch.id);

    const res = await rollback(user, batch.id);
    expect(res.status).toBe(200);
    expect(res.body.kept).toEqual([]);

    expect(
      await ctx.prisma.account.count({
        where: { workspaceId: user.workspaceId, systemKey: null, deletedAt: null },
      }),
    ).toBe(0);
    expect(
      await ctx.prisma.savingsPlan.count({
        where: { workspaceId: user.workspaceId, deletedAt: null },
      }),
    ).toBe(0);
  });

  it('keeps an account that has been posted to, and says why', async () => {
    /* The safety property. A rollback that could take a real transaction with
       it is a button nobody should ever press. */
    const user = await signup(ctx);
    /* A category that was here before the import, so the only thing this test
       expects to be kept is the account. */
    const category = await ctx.prisma.category.findFirstOrThrow({
      where: { workspaceId: user.workspaceId, kind: 'EXPENSE', deletedAt: null },
    });

    const batch = (await pull(user)).body as Batch;
    await apply(user, batch.id);

    const bkash = await ctx.prisma.account.findFirstOrThrow({
      where: { workspaceId: user.workspaceId, name: 'বিকাশ' },
    });
    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({
        type: 'EXPENSE',
        date: '2026-08-15',
        amountMinor: 50_000,
        accountId: bkash.id,
        categoryId: category.id,
        description: 'রিকশা',
      })
      .expect(201);

    const res = await rollback(user, batch.id);
    expect(res.status).toBe(200);
    expect(res.body.kept).toHaveLength(1);
    expect(res.body.kept[0].name).toBe('বিকাশ');
    expect(res.body.kept[0].reason).toContain('লেনদেন');

    expect(
      await ctx.prisma.account.findFirst({ where: { id: bkash.id, deletedAt: null } }),
    ).toBeTruthy();
  });

  it('applies twice without doubling anything', async () => {
    const user = await signup(ctx);
    const batch = (await pull(user)).body as Batch;
    await apply(user, batch.id);
    /* A second apply on an applied batch is refused outright — but the row-level
       guard matters too, so the count is the assertion. */
    const second = await apply(user, batch.id);
    expect(second.status).toBe(400);

    expect(
      await ctx.prisma.account.count({
        where: { workspaceId: user.workspaceId, name: 'বিকাশ', deletedAt: null },
      }),
    ).toBe(1);
  });

  it('refuses a second draft while one is still undecided', async () => {
    const user = await signup(ctx);
    await pull(user);
    const second = await pull(user);
    expect(second.status).toBe(400);
  });

  it('sends the spreadsheet out and takes the decisions back', async () => {
    const user = await signup(ctx);
    const batch = (await pull(user)).body as Batch;

    const csv = await ctx.http().get(`/v1/migration/batches/${batch.id}/csv`).set(auth(user));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.startsWith('\uFEFF')).toBe(true);
    expect(csv.text).toContain('DPS Sonali');

    /* What somebody actually does in Excel: change one word in one column. */
    const edited = csv.text.replace(
      'CATEGORY,w-cat-1,Groceries,0,CREATE',
      'CATEGORY,w-cat-1,Groceries,0,SKIP',
    );
    expect(edited).not.toBe(csv.text);

    const back = await ctx
      .http()
      .post(`/v1/migration/batches/${batch.id}/csv`)
      .set(auth(user))
      .send({ csv: edited });
    expect(back.status).toBe(200);
    expect(back.body.errors).toEqual([]);
    expect(back.body.updated).toBe(6);

    const after = (await detail(user, batch.id)).body as Batch;
    expect(find(after, 'w-cat-1').decision).toBe('SKIP');
  });

  it('refuses a spreadsheet naming something that is not here', async () => {
    const user = await signup(ctx);
    const batch = (await pull(user)).body as Batch;

    const csv = [
      'kind,sourceId,name,usageCount,decision,targetType,mergeInto,note',
      'CATEGORY,w-cat-1,Groceries,0,MERGE,,কোনো এক খাত,',
    ].join('\n');

    const res = await ctx
      .http()
      .post(`/v1/migration/batches/${batch.id}/csv`)
      .set(auth(user))
      .send({ csv });
    expect(res.body.updated).toBe(0);
    expect(res.body.errors[0]).toContain('কোনো এক খাত');

    /* And the row it could not resolve is untouched, not defaulted. */
    const after = (await detail(user, batch.id)).body as Batch;
    expect(find(after, 'w-cat-1').decision).toBe('CREATE');
  });

  it('will not let one workspace read or apply another’s batch', async () => {
    const mine = await signup(ctx);
    const theirs = await signup(ctx);
    const batch = (await pull(mine)).body as Batch;

    expect((await detail(theirs, batch.id)).status).toBe(404);
    expect((await apply(theirs, batch.id)).status).toBe(404);
    expect(
      (await ctx.http().delete(`/v1/migration/batches/${batch.id}`).set(auth(theirs))).status,
    ).toBe(404);
  });

  it('discards a draft, but not an applied batch', async () => {
    const user = await signup(ctx);
    const batch = (await pull(user)).body as Batch;

    expect(
      (await ctx.http().delete(`/v1/migration/batches/${batch.id}`).set(auth(user))).status,
    ).toBe(200);
    expect(await ctx.prisma.migrationItem.count({ where: { batchId: batch.id } })).toBe(0);

    const second = (await pull(user)).body as Batch;
    await apply(user, second.id);
    expect(
      (await ctx.http().delete(`/v1/migration/batches/${second.id}`).set(auth(user))).status,
    ).toBe(400);
  });
});
