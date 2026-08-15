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
    id: 'w-acc-3',
    name: 'ব্র্যাক কার্ড',
    accountType: 'CreditCard',
    currencyCode: 'BDT',
    archived: false,
    recordStats: { recordCount: 40 },
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
  /* A person, filed as a category because the other product had nowhere else to
     put somebody you lend to. Typed the way four years of real rows are. */
  {
    id: 'w-cat-5',
    name: 'Miza Kaka Ram — 017 80241477',
    group: { name: 'Financial expenses' },
    customCategory: true,
  },
  { id: 'w-cat-1', name: 'Groceries', group: { name: 'Food & Drinks' }, customCategory: false },
  /* The one the whole four-way choice exists for: Wallet had no savings plan,
     so a DPS became a category and stayed one for years. */
  { id: 'w-cat-2', name: 'DPS Sonali', group: { name: 'Investments' }, customCategory: true },
  { id: 'w-cat-3', name: 'Life insurance premium', group: { name: 'Financial expenses' } },
  { id: 'w-cat-4', name: 'Salary', group: { name: 'Income' }, customCategory: false },
];

interface Item {
  id: string;
  targetName: string | null;
  group: string | null;
  isGroup: boolean;
  needs: string | null;
  needsComplete: boolean;
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
  counts: {
    accounts: number;
    categories: number;
    created: number;
    skipped: number;
    needsDetail: number;
  };
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
    process.env.MIGRATION_ALLOWED_EMAILS = '';
  });

  afterAll(async () => {
    await ctx.app.close();
    delete process.env.MIGRATION_ALLOWED_EMAILS;
  });

  type User = Awaited<ReturnType<typeof signup>>;

  /**
   * Sign up somebody the migration screen is open for.
   *
   * The allowlist lives in the environment and is read on every request, so
   * naming the address after the account exists is enough — and it keeps every
   * test honest about the fact that this is off by default.
   */
  async function allowedUser(): Promise<User> {
    const user = await signup(ctx);
    process.env.MIGRATION_ALLOWED_EMAILS = user.email;
    return user;
  }

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
    const user = await allowedUser();
    const before = await ctx.prisma.account.count({ where: { workspaceId: user.workspaceId } });

    const res = await pull(user);
    expect(res.status).toBe(201);
    const batch = res.body as Batch;

    expect(batch.status).toBe('DRAFT');
    /* Four categories and the four groups they sit in — the groups are staged
       too, because they are the parents and none of them exists here. */
    expect(batch.counts).toMatchObject({ accounts: 3, categories: 9, created: 0 });
    expect(await ctx.prisma.account.count({ where: { workspaceId: user.workspaceId } })).toBe(
      before,
    );
    expect(await ctx.prisma.savingsPlan.count({ where: { workspaceId: user.workspaceId } })).toBe(
      0,
    );
  });

  it('guesses the account type, and guesses savings and insurance from the name', async () => {
    const user = await allowedUser();
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
    const user = await allowedUser();
    await ctx.prisma.category.create({
      data: { workspaceId: user.workspaceId, name: 'Groceries', nameBn: 'বাজার', kind: 'EXPENSE' },
    });

    const batch = (await pull(user)).body as Batch;
    const groceries = find(batch, 'w-cat-1');
    expect(groceries.decision).toBe('MERGE');
    expect(groceries.targetId).toBeTruthy();
  });

  it('creates what the decisions say, and nothing the decisions do not', async () => {
    const user = await allowedUser();
    const batch = (await pull(user)).body as Batch;

    await decide(user, batch.id, find(batch, 'w-cat-1').id, { decision: 'SKIP' });

    const applied = (await apply(user, batch.id)).body as Batch;
    expect(applied.status).toBe('APPLIED');

    const accounts = await ctx.prisma.account.findMany({
      where: { workspaceId: user.workspaceId, systemKey: null, deletedAt: null },
      select: { name: true, type: true, accountNumberMasked: true },
    });
    /* Two, not three: the plan's account ceiling. The busiest rows go in first
       and the one that did not fit says why on its own row, which is the whole
       point of a batch that never aborts part-way. */
    expect(accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'বিকাশ',
          type: 'BANK',
          accountNumberMasked: '01711••••88',
        }),
        expect.objectContaining({ name: 'ব্র্যাক কার্ড', type: 'CREDIT_CARD' }),
      ]),
    );
    const overflow = find(applied, 'w-acc-2');
    expect(overflow.createdEntityId).toBeNull();
    expect(overflow.skippedReason).toBeTruthy();

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
    const user = await allowedUser();
    const batch = (await pull(user)).body as Batch;
    await apply(user, batch.id);

    const salary = await ctx.prisma.category.findFirst({
      where: { workspaceId: user.workspaceId, name: 'Salary' },
    });
    expect(salary?.kind).toBe('INCOME');
  });

  it('takes the whole batch back, softly', async () => {
    const user = await allowedUser();
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
    const user = await allowedUser();
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

  it('approves a few rows now and keeps the rest open', async () => {
    /* 312 categories is not one sitting. A batch that could only be approved
       whole meant either finishing every row first or approving rows nobody
       had looked at. */
    const user = await allowedUser();
    const batch = (await pull(user)).body as Batch;

    const first = find(batch, 'w-cat-1');
    const res = await ctx
      .http()
      .post(`/v1/migration/batches/${batch.id}/apply`)
      .set(auth(user))
      .send({ itemIds: [first.id] });
    expect(res.status).toBe(200);

    const after = res.body as Batch;
    /* Still a draft: there is work left in it. */
    expect(after.status).toBe('DRAFT');
    expect(find(after, 'w-cat-1').createdEntityId).toBeTruthy();
    expect(find(after, 'w-cat-4').createdEntityId).toBeNull();

    /* The rest can still be decided, and approved later. */
    await decide(user, batch.id, find(after, 'w-cat-4').id, { decision: 'SKIP' }).expect(200);
    const rest = (await apply(user, batch.id)).body as Batch;
    expect(find(rest, 'w-cat-4').skippedReason).toBeTruthy();
    /* And a second pass does not create the first row again. */
    expect(
      await ctx.prisma.category.count({
        where: { workspaceId: user.workspaceId, name: 'Groceries', deletedAt: null },
      }),
    ).toBe(1);
  });

  it('takes back what a part-approved draft created', async () => {
    /* Rollback is about what was created, not what state the batch is in — a
       batch approved a group at a time is still a draft. */
    const user = await allowedUser();
    const batch = (await pull(user)).body as Batch;
    const row = find(batch, 'w-cat-1');

    await ctx
      .http()
      .post(`/v1/migration/batches/${batch.id}/apply`)
      .set(auth(user))
      .send({ itemIds: [row.id] })
      .expect(200);

    const undone = await rollback(user, batch.id);
    expect(undone.status).toBe(200);
    expect(undone.body.removed).toBe(1);

    /* Back to a plain draft, because there is still work in it. */
    const after = (await detail(user, batch.id)).body as Batch;
    expect(after.status).toBe('DRAFT');
    expect(
      await ctx.prisma.category.count({
        where: { workspaceId: user.workspaceId, name: 'Groceries', deletedAt: null },
      }),
    ).toBe(0);
  });

  it('refuses a rollback when nothing was ever created', async () => {
    const user = await allowedUser();
    const batch = (await pull(user)).body as Batch;
    expect((await rollback(user, batch.id)).status).toBe(400);
  });

  it('keeps the batch open for rows put off until later', async () => {
    /* "Later" and "skip" were one word until somebody who wanted to approve a
       hundred rows and think about the rest had to mark those with the word for
       "leave it behind". Skip is a decision; later is the absence of one. */
    const user = await allowedUser();
    const batch = (await pull(user)).body as Batch;

    for (const item of batch.items) {
      const decision = item.sourceId === 'w-cat-1' ? 'LATER' : 'SKIP';
      await decide(user, batch.id, item.id, { decision }).expect(200);
    }

    const applied = (await apply(user, batch.id)).body as Batch;
    /* Nothing created for it, no reason written against it, and the batch is
       still open because of it. */
    const deferred = find(applied, 'w-cat-1');
    expect(deferred.createdEntityId).toBeNull();
    expect(deferred.skippedReason).toBeNull();
    expect(applied.status).toBe('DRAFT');

    /* Weeks later, it is picked up and approved on its own. */
    await decide(user, batch.id, deferred.id, { decision: 'CREATE' }).expect(200);
    const done = (await apply(user, batch.id)).body as Batch;
    expect(find(done, 'w-cat-1').createdEntityId).toBeTruthy();
    expect(done.status).toBe('APPLIED');
  });

  it('lets a skipped row be picked up again after the batch was closed', async () => {
    /* Skipping 200 rows to get the other hundred in is deferring them, not
       throwing them away. A batch that closed over that decision would make it
       permanent, which is not what the person meant by "skip for now". */
    const user = await allowedUser();
    const batch = (await pull(user)).body as Batch;

    /* Skip everything, so applying closes the batch with nothing created. */
    for (const item of batch.items) {
      await decide(user, batch.id, item.id, { decision: 'SKIP' }).expect(200);
    }
    const closed = (await apply(user, batch.id)).body as Batch;
    expect(closed.status).toBe('APPLIED');

    /* Months later, one of them turns out to be wanted after all. */
    const again = await decide(user, batch.id, find(closed, 'w-cat-1').id, { decision: 'CREATE' });
    expect(again.status).toBe(200);
    /* The reason it was left behind no longer holds, and the batch is open. */
    expect(again.body.skippedReason).toBeNull();
    expect(((await detail(user, batch.id)).body as Batch).status).toBe('DRAFT');

    await apply(user, batch.id);
    expect(
      await ctx.prisma.category.count({
        where: { workspaceId: user.workspaceId, name: 'Groceries', deletedAt: null },
      }),
    ).toBe(1);
  });

  it('will not let a decision change after it has been carried out', async () => {
    /* The one thing that cannot be changed: altering a decision already in the
       books would say something untrue about what happened. Rollback is how
       that gets undone. */
    const user = await allowedUser();
    const batch = (await pull(user)).body as Batch;
    const row = find(batch, 'w-cat-1');

    await ctx
      .http()
      .post(`/v1/migration/batches/${batch.id}/apply`)
      .set(auth(user))
      .send({ itemIds: [row.id] })
      .expect(200);

    const refused = await decide(user, batch.id, row.id, { decision: 'SKIP' });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('ফিরিয়ে');
  });

  it('applies twice without doubling anything', async () => {
    const user = await allowedUser();
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
    const user = await allowedUser();
    await pull(user);
    const second = await pull(user);
    expect(second.status).toBe(400);
  });

  it('sends the spreadsheet out and takes the decisions back', async () => {
    const user = await allowedUser();
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
    expect(back.body.updated).toBe(12);

    const after = (await detail(user, batch.id)).body as Batch;
    expect(find(after, 'w-cat-1').decision).toBe('SKIP');
  });

  it('refuses a spreadsheet naming something that is not here', async () => {
    const user = await allowedUser();
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
    const mine = await allowedUser();
    /* Both on the allowlist: this is about workspaces, not about the door. */
    const theirs = await signup(ctx);
    process.env.MIGRATION_ALLOWED_EMAILS = `${mine.email},${theirs.email}`;
    const batch = (await pull(mine)).body as Batch;

    expect((await detail(theirs, batch.id)).status).toBe(404);
    expect((await apply(theirs, batch.id)).status).toBe(404);
    expect(
      (await ctx.http().delete(`/v1/migration/batches/${batch.id}`).set(auth(theirs))).status,
    ).toBe(404);
  });

  it('fills a card and a DPS in on the draft, and creates them with those figures', async () => {
    /* The whole reason the questions are asked before anything is created: a
       plan created with an invented term is indistinguishable afterwards from
       one whose term somebody chose. */
    const user = await allowedUser();
    const batch = (await pull(user)).body as Batch;

    const card = batch.items.find((i) => i.sourceName === 'ব্র্যাক কার্ড') as Item;
    expect(card.needs).toBe('CARD');
    expect(card.needsComplete).toBe(false);

    await decide(user, batch.id, card.id, {
      detail: { statementDay: 20, dueDay: 8, reminderLeadDays: 3 },
    }).expect(200);

    const dps = find(batch, 'w-cat-2');
    expect(dps.needs).toBe('SAVINGS');
    await decide(user, batch.id, dps.id, {
      detail: { installmentMinor: 1_000_000, termMonths: 60, profitRateBps: 950 },
    }).expect(200);

    /* The policy is the third row that raises questions, so the batch is not
       finished until it has been answered too. */
    const policy = find(batch, 'w-cat-3');
    expect(policy.needs).toBe('INSURANCE');
    await decide(user, batch.id, policy.id, {
      detail: { premiumMinor: 350_000, sumAssuredMinor: 50_000_000 },
    }).expect(200);

    const ready = (await detail(user, batch.id)).body as Batch;
    expect(ready.counts.needsDetail).toBe(0);

    await apply(user, batch.id);

    const created = await ctx.prisma.account.findFirstOrThrow({
      where: { workspaceId: user.workspaceId, name: 'ব্র্যাক কার্ড' },
    });
    expect(created.statementDayOfMonth).toBe(20);
    expect(created.dueDayOfMonth).toBe(8);
    expect(created.reminderLeadDays).toBe(3);

    const plan = await ctx.prisma.savingsPlan.findFirstOrThrow({
      where: { workspaceId: user.workspaceId, planName: 'DPS Sonali' },
    });
    expect(Number(plan.installmentMinor)).toBe(1_000_000);
    expect(plan.termMonths).toBe(60);
    expect(plan.profitRateBps).toBe(950);
    /* And the note stops apologising once the figures are real. */
    expect(plan.note).not.toContain('ধরে নেওয়া');
  });

  it('says so on the plan when it had to assume a term', async () => {
    /* Left blank on purpose. The plan is still created — a migration must not
       be blocked by a figure somebody cannot find this morning — but the note
       says the term was assumed, because an invented number that looks chosen
       is the thing to avoid. */
    const user = await allowedUser();
    const batch = (await pull(user)).body as Batch;
    await apply(user, batch.id);

    const plan = await ctx.prisma.savingsPlan.findFirstOrThrow({
      where: { workspaceId: user.workspaceId, planName: 'DPS Sonali' },
    });
    expect(plan.termMonths).toBe(12);
    expect(plan.note).toContain('ধরে নেওয়া');
  });

  it('only asks the rows that have something to answer', async () => {
    const user = await allowedUser();
    const batch = (await pull(user)).body as Batch;

    /* A bank account is asked nothing at all — that is the difference between
       28 forms and 320. */
    expect(find(batch, 'w-acc-1').needs).toBeNull();
    expect(find(batch, 'w-cat-3').needs).toBe('INSURANCE');

    /* An ordinary category opens the same sheet, for search words — but it is
       never *wanting*, because a category without them is finished and marking
       296 rows unfinished over an optional field would make the filter
       useless. */
    const ordinary = find(batch, 'w-cat-1');
    expect(ordinary.needs).toBe('CATEGORY');
    expect(ordinary.needsComplete).toBe(true);
    expect((await detail(user, batch.id)).body.counts.needsDetail).toBeGreaterThan(0);
  });

  it('starts a batch from a spreadsheet somebody typed, with no API at all', async () => {
    /* The other door, and the one that is open to everybody: not everyone is
       leaving a product with a REST API. */
    const stranger = await signup(ctx);
    process.env.MIGRATION_ALLOWED_EMAILS = '';

    const csv = [
      'name,kind,decision,targetType,statementDay,dueDay',
      'হাতের নগদ,ACCOUNT,CREATE,CASH,,',
      'সিটি কার্ড,ACCOUNT,CREATE,CREDIT_CARD,20,8',
      'বাজার,CATEGORY,CREATE,EXPENSE,,',
    ].join('\n');

    const started = await ctx
      .http()
      .post('/v1/migration/csv/start')
      .set(auth(stranger))
      .send({ csv });
    expect(started.status).toBe(201);

    const batch = started.body as Batch;
    expect(batch.counts).toMatchObject({ accounts: 2, categories: 1, created: 0 });
    /* The card's dates came in with the file, so it asks nothing further. */
    expect(batch.items.find((i) => i.sourceName === 'সিটি কার্ড')?.needsComplete).toBe(true);

    await ctx
      .http()
      .post(`/v1/migration/batches/${batch.id}/apply`)
      .set(auth(stranger))
      .send({})
      .expect(200);

    const card = await ctx.prisma.account.findFirstOrThrow({
      where: { workspaceId: stranger.workspaceId, name: 'সিটি কার্ড' },
    });
    expect(card.type).toBe('CREDIT_CARD');
    expect(card.dueDayOfMonth).toBe(8);
  });

  it("holds a spreadsheet to the plan's account ceiling", async () => {
    /* Mandatory, and the reason the spreadsheet door can be open to everybody:
       it creates through the same `AccountsService` ceiling every other route
       obeys. A free plan that allows two accounts allows two here — a CSV is
       not a way around a plan.

       The rows that do not fit are not lost. Each says why on its own row, so
       somebody who uploaded forty gets a list rather than a silence. */
    const user = await signup(ctx);

    const csv = [
      'name,kind,decision,targetType',
      ...Array.from({ length: 6 }, (_, i) => `অ্যাকাউন্ট ${i + 1},ACCOUNT,CREATE,BANK`),
    ].join('\n');

    const started = await ctx
      .http()
      .post('/v1/migration/csv/start')
      .set(auth(user))
      .send({ csv })
      .expect(201);

    const applied = (
      await ctx
        .http()
        .post(`/v1/migration/batches/${(started.body as Batch).id}/apply`)
        .set(auth(user))
        .send({})
        .expect(200)
    ).body as Batch;

    const created = await ctx.prisma.account.count({
      where: { workspaceId: user.workspaceId, systemKey: null, deletedAt: null },
    });
    expect(created).toBeLessThan(6);

    const refused = applied.items.filter((i) => !i.createdEntityId && i.skippedReason);
    expect(refused.length).toBe(6 - created);
    expect(refused[0]?.skippedReason).toBeTruthy();
  });

  it("brings the source's own groups across as parents, with the categories under them", async () => {
    /* The other product keeps two levels — a group and the categories in it —
       and none of the groups exists here. Without staging them too, a tree
       somebody spent years arranging arrives as a flat list of 296 headings. */
    const user = await allowedUser();
    const batch = (await pull(user)).body as Batch;

    /* One row per group, named after it. */
    const groups = batch.items.filter((i) => i.sourceId.startsWith('group:'));
    expect(groups.map((g) => g.sourceName).sort()).toEqual([
      'Financial expenses',
      'Food & Drinks',
      'Income',
      'Investments',
    ]);
    /* An income group is an income category, so its children can sit under it. */
    expect(groups.find((g) => g.sourceName === 'Income')?.targetType).toBe('INCOME');
    /* Marked, and filed under itself so it sits with the rows it holds. */
    expect(groups.every((g) => g.isGroup)).toBe(true);
    expect(groups.find((g) => g.sourceName === 'Income')?.group).toBe('Income');
    expect(find(batch, 'w-cat-1').isGroup).toBe(false);

    await apply(user, batch.id);

    const groceries = await ctx.prisma.category.findFirstOrThrow({
      where: { workspaceId: user.workspaceId, name: 'Groceries', deletedAt: null },
      include: { parent: true },
    });
    expect(groceries.parent?.name).toBe('Food & Drinks');
    /* And the parent is a heading in its own right, not a child of anything. */
    expect(groceries.parent?.parentId).toBeNull();
  });

  it('leaves a category standing on its own when its group was skipped', async () => {
    /* The name is what somebody came for. A child whose parent was refused
       becomes a heading rather than disappearing — a top-level category is a
       thing they can move; a missing one is a thing they have to notice. */
    const user = await allowedUser();
    const batch = (await pull(user)).body as Batch;

    const foodGroup = batch.items.find((i) => i.sourceName === 'Food & Drinks') as Item;
    await decide(user, batch.id, foodGroup.id, { decision: 'SKIP' }).expect(200);

    await apply(user, batch.id);

    const groceries = await ctx.prisma.category.findFirstOrThrow({
      where: { workspaceId: user.workspaceId, name: 'Groceries', deletedAt: null },
    });
    expect(groceries.parentId).toBeNull();
  });

  it('creates a category with the words somebody will actually search for', async () => {
    /* Postgres cannot transliterate — `khabar` and `খাবার` share no trigrams,
       and no collation makes them match — so the app folds these in TypeScript.
       A name imported from an English-speaking product is not what anybody
       types when they are standing in a shop. */
    const user = await allowedUser();
    const batch = (await pull(user)).body as Batch;

    await decide(user, batch.id, find(batch, 'w-cat-1').id, {
      detail: { aliases: ['bajar', 'বাজার', 'grocery'] },
    }).expect(200);

    await apply(user, batch.id);

    const created = await ctx.prisma.category.findFirstOrThrow({
      where: { workspaceId: user.workspaceId, name: 'Groceries', deletedAt: null },
    });
    expect(created.searchAliases).toEqual(['bajar', 'বাজার', 'grocery']);
  });

  it('creates a row under the name it was given, not the one it arrived with', async () => {
    /* "Financial expenses" is the other product's English heading over 68 rows
       and these books are kept in Bengali. Renaming after approval means
       creating the wrong name first and hunting it down on another screen. */
    const user = await allowedUser();
    const batch = (await pull(user)).body as Batch;
    const row = find(batch, 'w-cat-1');

    const named = await decide(user, batch.id, row.id, { name: 'বাজার সদাই' });
    expect(named.status).toBe(200);
    expect(named.body.targetName).toBe('বাজার সদাই');
    /* The source name survives: it is what a second pull matches on and what
       somebody recognises from the other product. */
    expect(named.body.sourceName).toBe('Groceries');

    await apply(user, batch.id);

    expect(
      await ctx.prisma.category.count({
        where: { workspaceId: user.workspaceId, name: 'বাজার সদাই', deletedAt: null },
      }),
    ).toBe(1);
    expect(
      await ctx.prisma.category.count({
        where: { workspaceId: user.workspaceId, name: 'Groceries', deletedAt: null },
      }),
    ).toBe(0);
  });

  it('undoes a rename when the name is cleared', async () => {
    const user = await allowedUser();
    const batch = (await pull(user)).body as Batch;
    const row = find(batch, 'w-cat-1');

    await decide(user, batch.id, row.id, { name: 'বাজার সদাই' }).expect(200);
    const cleared = await decide(user, batch.id, row.id, { name: '  ' });
    expect(cleared.body.targetName).toBeNull();
  });

  it('puts a new category under an existing one when told to', async () => {
    /* Some of the 296 are headings of their own; some belong under a heading
       that already exists here. Both are "create" — the difference is only
       where it sits, so it is a second control on the same decision rather than
       a decision of its own. */
    const user = await allowedUser();
    const parent = await ctx.prisma.category.findFirstOrThrow({
      where: { workspaceId: user.workspaceId, kind: 'EXPENSE', parentId: null, deletedAt: null },
    });

    const batch = (await pull(user)).body as Batch;
    const row = find(batch, 'w-cat-1');
    await decide(user, batch.id, row.id, { decision: 'CREATE', targetId: parent.id }).expect(200);

    await apply(user, batch.id);

    const created = await ctx.prisma.category.findFirstOrThrow({
      where: { workspaceId: user.workspaceId, name: 'Groceries', deletedAt: null },
    });
    expect(created.parentId).toBe(parent.id);
  });

  it('refuses a parent of the wrong kind, and one that is already a child', async () => {
    /* Two levels only, and income under income. Said while somebody is
       deciding rather than as a row that quietly did nothing. */
    const user = await allowedUser();
    const expenseParent = await ctx.prisma.category.findFirstOrThrow({
      where: { workspaceId: user.workspaceId, kind: 'EXPENSE', parentId: null, deletedAt: null },
    });
    const child = await ctx.prisma.category.create({
      data: {
        workspaceId: user.workspaceId,
        name: 'উপ-খাত',
        nameBn: 'উপ-খাত',
        kind: 'EXPENSE',
        parentId: expenseParent.id,
      },
    });

    const batch = (await pull(user)).body as Batch;
    /* `Salary` is income; an expense heading cannot hold it. */
    const income = find(batch, 'w-cat-4');
    expect(
      (await decide(user, batch.id, income.id, { decision: 'CREATE', targetId: expenseParent.id }))
        .status,
    ).toBe(400);

    const expense = find(batch, 'w-cat-1');
    expect(
      (await decide(user, batch.id, expense.id, { decision: 'CREATE', targetId: child.id })).status,
    ).toBe(400);
  });

  it('sets a whole group in one request, and one bad row does not undo the rest', async () => {
    /* 296 categories is not 296 decisions: they arrive grouped the way the
       other product grouped them, and that grouping is very close to the
       answer. Doing it as 40 requests would be 40 chances to lose one. */
    const user = await allowedUser();
    const batch = (await pull(user)).body as Batch;

    const expenses = batch.items.filter((i) => i.kind === 'CATEGORY' && i.targetType === 'EXPENSE');
    expect(expenses.length).toBeGreaterThan(1);

    const res = await ctx
      .http()
      .patch(`/v1/migration/batches/${batch.id}/items`)
      .set(auth(user))
      .send({ decision: 'SKIP', itemIds: expenses.map((i) => i.id) });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(expenses.length);
    expect(res.body.errors).toEqual([]);

    const after = (await detail(user, batch.id)).body as Batch;
    for (const row of expenses) {
      expect(find(after, row.sourceId).decision).toBe('SKIP');
    }

    /* A row the batch does not hold is reported, and the others still change. */
    const mixed = await ctx
      .http()
      .patch(`/v1/migration/batches/${batch.id}/items`)
      .set(auth(user))
      .send({
        decision: 'CREATE',
        itemIds: [expenses[0]?.id, 'cmsu000000000000000000000'],
      });
    expect(mixed.body.updated).toBe(1);
    expect(mixed.body.errors).toHaveLength(1);
    expect(find((await detail(user, batch.id)).body as Batch, expenses[0]!.sourceId).decision).toBe(
      'CREATE',
    );
  });

  it('carries the group across, because that is what a bulk decision works on', async () => {
    const user = await allowedUser();
    const batch = (await pull(user)).body as Batch;
    /* Wallet's own heading for the row — "Food & Drinks", "Investments". */
    expect(find(batch, 'w-cat-1').group).toBe('Food & Drinks');
    /* An account has no group, so its type stands in. */
    expect(find(batch, 'w-acc-3').group).toBe('CreditCard');
  });

  it('turns a row that is really somebody into a contact, with their number', async () => {
    /* Left as a spending head, every loan to him reads as an expense and every
       repayment as income, and there is nowhere to see what he still owes. */
    const user = await allowedUser();
    const batch = (await pull(user)).body as Batch;

    await decide(user, batch.id, find(batch, 'w-cat-5').id, { decision: 'PERSON' }).expect(200);
    await apply(user, batch.id);

    const person = await ctx.prisma.person.findFirstOrThrow({
      where: { workspaceId: user.workspaceId, deletedAt: null, name: { contains: 'Miza' } },
    });
    /* The number comes out of the name, because that is what makes him
       findable — and it goes through PeopleService, so he has a code. */
    expect(person.name).toBe('Miza Kaka Ram');
    expect(person.phone).toBe('01780241477');
    expect(person.code).toMatch(/^P-\d+$/);

    /* And he is not also a category. */
    expect(
      await ctx.prisma.category.count({
        where: { workspaceId: user.workspaceId, name: { contains: 'Miza' }, deletedAt: null },
      }),
    ).toBe(0);
  });

  it('takes a contact back out again, unless somebody is using them', async () => {
    const user = await allowedUser();
    const batch = (await pull(user)).body as Batch;
    await decide(user, batch.id, find(batch, 'w-cat-5').id, { decision: 'PERSON' }).expect(200);
    await apply(user, batch.id);

    const undone = await rollback(user, batch.id);
    expect(undone.status).toBe(200);
    expect(
      await ctx.prisma.person.count({
        where: { workspaceId: user.workspaceId, deletedAt: null, name: { contains: 'Miza' } },
      }),
    ).toBe(0);
  });

  it('turns a category that is really a debt into a liability account', async () => {
    /* "ALICO LOAN" was a category in the other product because a category was
       the only shape it had. Left as one, every repayment reads as an expense
       and the debt itself appears on no balance sheet.

       It becomes an account, not a `Loan`: a loan posts a disbursement
       transaction, and nothing here knows the principal or which account the
       money moved through. An account of the right type puts the debt where it
       belongs with nothing invented. */
    const user = await allowedUser();
    const batch = (await pull(user)).body as Batch;

    /* The three account rows are skipped first: they would otherwise fill the
       plan's account ceiling before the categories are reached, and this test
       is about the decision, not the limit — which has a test of its own. */
    for (const sourceId of ['w-acc-1', 'w-acc-2', 'w-acc-3']) {
      await decide(user, batch.id, find(batch, sourceId).id, { decision: 'SKIP' }).expect(200);
    }

    await decide(user, batch.id, find(batch, 'w-cat-1').id, { decision: 'LIABILITY' }).expect(200);
    /* Nothing further is asked of it — no account brings a balance across. */
    const staged = (await detail(user, batch.id)).body as Batch;
    expect(find(staged, 'w-cat-1').needs).toBeNull();

    await apply(user, batch.id);

    const account = await ctx.prisma.account.findFirst({
      where: { workspaceId: user.workspaceId, name: 'Groceries', deletedAt: null },
    });
    expect(account?.type).toBe('LIABILITY');
    expect(Number(account?.openingBalance)).toBe(0);

    /* And it is not also a category. */
    expect(
      await ctx.prisma.category.count({
        where: { workspaceId: user.workspaceId, name: 'Groceries', deletedAt: null },
      }),
    ).toBe(0);
  });

  it('lets a row be told to merge before what it merges into is chosen', async () => {
    /* Refusing this was a deadlock: the control for choosing a target only
       appears once the row is a merge, so demanding the target at the moment
       somebody picks "merge" made the option impossible to pick. */
    const user = await allowedUser();
    const batch = (await pull(user)).body as Batch;
    /* A row with no name match here, so the pull left it as CREATE with no
       target — `Salary` would already carry one from the seeded category. */
    const row = find(batch, 'w-acc-1');

    const saved = await decide(user, batch.id, row.id, { decision: 'MERGE' });
    expect(saved.status).toBe(200);
    expect(saved.body.decision).toBe('MERGE');
    expect(saved.body.targetId).toBeNull();

    /* And an unfinished one creates nothing, saying so on its own row rather
       than being quietly treated as a skip — which would read as a decision
       somebody had made. */
    const applied = (await apply(user, batch.id)).body as Batch;
    const after = find(applied, 'w-acc-1');
    expect(after.createdEntityId).toBeNull();
    expect(after.skippedReason).toContain('বেছে নেওয়া হয়নি');
  });

  it('refuses a spreadsheet with no name column, and says which', async () => {
    const user = await signup(ctx);
    const res = await ctx
      .http()
      .post('/v1/migration/csv/start')
      .set(auth(user))
      .send({ csv: 'kind,decision\nACCOUNT,CREATE' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('name');
  });

  it('is closed to everybody who is not named in the allowlist', async () => {
    /* The screen asks for a live credential to another finance app. Every
       account that was not given it must find a closed door, whatever its
       browser believes — and an empty or missing variable must close the door
       rather than open it to everyone. */
    const stranger = await signup(ctx);
    process.env.MIGRATION_ALLOWED_EMAILS = '';

    /* The Wallet pull is the only gated route, because it is the only one that
       asks for somebody's credential to another product. */
    expect((await pull(stranger)).status).toBe(403);
    /* The spreadsheet door stays open — there is nothing to protect anybody
       from in a list of headings. */
    expect((await ctx.http().get('/v1/migration/batches').set(auth(stranger))).status).toBe(200);

    /* One route answers rather than refuses, so the navigation can ask. */
    const asked = await ctx.http().get('/v1/migration/availability').set(auth(stranger));
    expect(asked.status).toBe(200);
    expect(asked.body.allowed).toBe(false);

    process.env.MIGRATION_ALLOWED_EMAILS = stranger.email.toUpperCase();
    /* Case is not part of an address for this purpose. */
    const again = await ctx.http().get('/v1/migration/availability').set(auth(stranger));
    expect(again.body.allowed).toBe(true);

    /* A whole domain is allowed to be an entry — but `@` alone is not a domain
       and must not become a way to open this to everybody. */
    const domain = stranger.email.slice(stranger.email.lastIndexOf('@'));
    process.env.MIGRATION_ALLOWED_EMAILS = domain;
    expect(
      (await ctx.http().get('/v1/migration/availability').set(auth(stranger))).body.allowed,
    ).toBe(true);

    process.env.MIGRATION_ALLOWED_EMAILS = '@';
    expect(
      (await ctx.http().get('/v1/migration/availability').set(auth(stranger))).body.allowed,
    ).toBe(false);
  });

  it('discards a draft, but not an applied batch', async () => {
    const user = await allowedUser();
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
