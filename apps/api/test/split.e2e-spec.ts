import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, createTestApp, resetDatabase, signup, type TestContext } from './harness';

/**
 * Spending together.
 *
 * The tests that matter here are not about groups and members — they are about
 * what reaches the ledger. A shared bill has to put **only the owner's own
 * share** into expenses, everybody else's into a receivable, and the cash out of
 * one account, in one balanced transaction. Get that wrong and the expense
 * report, the income statement and every budget built on top of them are wrong
 * by however much your friends owe you.
 */
describe('shared spending', () => {
  let ctx: TestContext;
  let user: Awaited<ReturnType<typeof signup>>;
  let accountId: string;
  let groupId: string;
  let meId: string;
  let karimId: string;
  let rahimId: string;

  const post = (path: string, body: Record<string, unknown>, as = user) =>
    ctx.http().post(path).set(auth(as)).send(body);
  const get = (path: string, as = user) => ctx.http().get(path).set(auth(as));

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    user = await signup(ctx);

    const account = await post('/v1/accounts', {
      name: 'নগদ',
      type: 'CASH',
      openingBalance: 10_000_000,
    }).expect(201);
    accountId = account.body.id;

    const group = await post('/v1/split/groups', {
      name: 'কক্সবাজার ট্রিপ',
      purpose: 'TRIP',
      members: [{ name: 'করিম' }, { name: 'রহিম' }],
    }).expect(201);
    groupId = group.body.id;
    meId = group.body.members.find((m: { isSelf: boolean }) => m.isSelf).id;
    karimId = group.body.members.find((m: { displayName: string }) => m.displayName === 'করিম').id;
    rahimId = group.body.members.find((m: { displayName: string }) => m.displayName === 'রহিম').id;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('puts the owner in their own group, first', async () => {
    const group = await get(`/v1/split/groups/${groupId}`).expect(200);
    expect(group.body.members[0].isSelf).toBe(true);
    expect(group.body.members).toHaveLength(3);
  });

  it('makes a Person for a new member, so the debt follows them out of the group', async () => {
    /* Not a group-only row. Somebody who is on this trip and borrowed money last
       year is one person with one balance, which is the whole reason the split
       ledger reuses the loan ledger's control accounts. */
    const people = await get('/v1/people').expect(200);
    const names = people.body.map((p: { name: string }) => p.name);
    expect(names).toContain('করিম');
    expect(names).toContain('রহিম');
  });

  it('books only the owner’s share as expense when the owner pays', async () => {
    const expense = await post(`/v1/split/groups/${groupId}/expenses`, {
      description: 'রাতের খাবার',
      date: '2026-08-10',
      totalMinor: 300_000,
      payerMemberId: meId,
      splitMethod: 'EQUAL',
      shares: [{ memberId: meId }, { memberId: karimId }, { memberId: rahimId }],
      accountId,
    }).expect(201);

    expect(expense.body.myShareMinor).toBe(100_000);
    expect(expense.body.transactionId).toBeTruthy();

    /* The entries are the point. ৳1,000 of expense, ৳2,000 of receivable,
       ৳3,000 out of the cash account — not ৳3,000 of expense, which is what a
       splitting app that ignores the ledger would have written. */
    const entries = await ctx.prisma.ledgerEntry.findMany({
      where: { transactionId: expense.body.transactionId },
      include: { account: true },
    });
    const debit = (type: string) =>
      entries
        .filter((e) => e.direction === 'DEBIT' && e.account.type === type)
        .reduce((sum, e) => sum + Number(e.amountMinor), 0);

    expect(debit('EQUITY')).toBe(100_000); // the nominal expense account
    expect(debit('RECEIVABLE')).toBe(200_000);
    const credit = entries
      .filter((e) => e.direction === 'CREDIT' && e.accountId === accountId)
      .reduce((sum, e) => sum + Number(e.amountMinor), 0);
    expect(credit).toBe(300_000);
  });

  it('leaves the month’s expense total at the owner’s share alone', async () => {
    /* The assertion a budget will one day depend on: a ৳3,000 dinner four people
       shared must not make it look like ৳3,000 was spent by this household. */
    const summary = await get('/v1/transactions/summary?month=2026-08').expect(200);
    expect(summary.body.expenseMinor).toBe(100_000);
  });

  it('takes the cash out of the account in full, because it did leave', async () => {
    const accounts = await get('/v1/accounts').expect(200);
    const cash = accounts.body.find((a: { id: string }) => a.id === accountId);
    expect(cash.balanceMinor).toBe(10_000_000 - 300_000);
  });

  it('shows who owes whom, and it sums to zero', async () => {
    const group = await get(`/v1/split/groups/${groupId}`).expect(200);
    const net = new Map<string, number>(
      group.body.positions.map((p: { memberId: string; netMinor: number }) => [
        p.memberId,
        p.netMinor,
      ]),
    );
    expect(net.get(meId)).toBe(200_000);
    expect(net.get(karimId)).toBe(-100_000);
    expect(net.get(rahimId)).toBe(-100_000);
    expect([...net.values()].reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('suggests the fewest payments that clear it', async () => {
    const group = await get(`/v1/split/groups/${groupId}`).expect(200);
    expect(group.body.suggestions).toHaveLength(2);
    for (const s of group.body.suggestions) {
      expect(s.toMemberId).toBe(meId);
      expect(s.amountMinor).toBe(100_000);
    }
  });

  it('books a debt, and no cash, when somebody else pays', async () => {
    const expense = await post(`/v1/split/groups/${groupId}/expenses`, {
      description: 'হোটেল',
      date: '2026-08-11',
      totalMinor: 200_000,
      payerMemberId: karimId,
      splitMethod: 'EQUAL',
      shares: [{ memberId: meId }, { memberId: karimId }],
    }).expect(201);

    expect(expense.body.myShareMinor).toBe(100_000);

    const entries = await ctx.prisma.ledgerEntry.findMany({
      where: { transactionId: expense.body.transactionId },
      include: { account: true },
    });
    /* Expense debited, payable credited, and the cash account untouched: no
       money left this household, which is exactly what happened. */
    expect(entries).toHaveLength(2);
    expect(entries.some((e) => e.accountId === accountId)).toBe(false);
    expect(entries.find((e) => e.direction === 'CREDIT')?.account.type).toBe('PAYABLE');
  });

  it('writes nothing at all for a bill the owner was not on', async () => {
    const expense = await post(`/v1/split/groups/${groupId}/expenses`, {
      description: 'করিম আর রহিমের নাশতা',
      date: '2026-08-12',
      totalMinor: 100_000,
      payerMemberId: karimId,
      splitMethod: 'EQUAL',
      shares: [{ memberId: karimId }, { memberId: rahimId }],
    }).expect(201);

    /* Not the owner's money and not the owner's debt. It is a fact about the
       group, and it stays there. */
    expect(expense.body.transactionId).toBeNull();
    expect(expense.body.myShareMinor).toBe(0);
  });

  it('never loses a poisha, and the database would refuse it if it did', async () => {
    const expense = await post(`/v1/split/groups/${groupId}/expenses`, {
      description: 'তিন ভাগে ৳১০০০',
      date: '2026-08-13',
      totalMinor: 100_000,
      payerMemberId: meId,
      splitMethod: 'EQUAL',
      shares: [{ memberId: meId }, { memberId: karimId }, { memberId: rahimId }],
      accountId,
    }).expect(201);

    const shares = expense.body.shares.map((s: { amountMinor: number }) => s.amountMinor);
    expect(shares.reduce((a: number, b: number) => a + b, 0)).toBe(100_000);
    expect(shares).toContain(33_334);
  });

  it('divides by shares when one person eats double', async () => {
    const expense = await post(`/v1/split/groups/${groupId}/expenses`, {
      description: 'দুপুরের খাবার',
      date: '2026-08-14',
      totalMinor: 300_000,
      payerMemberId: meId,
      splitMethod: 'SHARES',
      shares: [
        { memberId: meId, shareWeight: 2 },
        { memberId: karimId, shareWeight: 1 },
      ],
      accountId,
    }).expect(201);
    expect(expense.body.myShareMinor).toBe(200_000);
  });

  it('refuses exact amounts that do not add up', async () => {
    const res = await post(`/v1/split/groups/${groupId}/expenses`, {
      description: 'ভুল ভাগ',
      date: '2026-08-14',
      totalMinor: 300_000,
      payerMemberId: meId,
      splitMethod: 'EXACT',
      shares: [
        { memberId: meId, amountMinor: 100_000 },
        { memberId: karimId, amountMinor: 100_000 },
      ],
      accountId,
    }).expect(400);
    expect(res.body.message).toMatch(/যোগ করলে/);
  });

  it('refuses to record the owner paying without saying from where', async () => {
    await post(`/v1/split/groups/${groupId}/expenses`, {
      description: 'অ্যাকাউন্ট ছাড়া',
      date: '2026-08-14',
      totalMinor: 100_000,
      payerMemberId: meId,
      splitMethod: 'EQUAL',
      shares: [{ memberId: meId }, { memberId: karimId }],
    }).expect(400);
  });

  it('clears a balance when somebody actually pays up', async () => {
    const before = await get(`/v1/split/groups/${groupId}`).expect(200);
    const owed = before.body.members.find((m: { id: string }) => m.id === karimId).netMinor;
    expect(owed).toBeLessThan(0);

    const after = await post(`/v1/split/groups/${groupId}/settlements`, {
      fromMemberId: karimId,
      toMemberId: meId,
      amountMinor: -owed,
      date: '2026-08-15',
      accountId,
    }).expect(201);

    const karim = after.body.members.find((m: { id: string }) => m.id === karimId);
    expect(karim.netMinor).toBe(0);
  });

  it('a settlement is money moving, not spending', async () => {
    /* If settling counted as an expense, paying somebody back would look like
       consumption and the month's spending would double-count the dinner. */
    const summary = await get('/v1/transactions/summary?month=2026-08').expect(200);
    expect(summary.body.expenseMinor).toBe(100_000 + 100_000 + 33_334 + 200_000);
  });

  it('deleting a shared expense gives the money back', async () => {
    const fresh = await post('/v1/split/groups', { name: 'মুছে ফেলার গ্রুপ' }).expect(201);
    const selfId = fresh.body.members[0].id;
    const other = await post(`/v1/split/groups/${fresh.body.id}/members`, {
      name: 'সালাম',
    }).expect(201);
    const salamId = other.body.members.find(
      (m: { displayName: string }) => m.displayName === 'সালাম',
    ).id;

    const accountsBefore = await get('/v1/accounts').expect(200);
    const balanceBefore = accountsBefore.body.find(
      (a: { id: string }) => a.id === accountId,
    ).balanceMinor;

    const expense = await post(`/v1/split/groups/${fresh.body.id}/expenses`, {
      description: 'ভুল করে লেখা',
      date: '2026-08-16',
      totalMinor: 50_000,
      payerMemberId: selfId,
      splitMethod: 'EQUAL',
      shares: [{ memberId: selfId }, { memberId: salamId }],
      accountId,
    }).expect(201);

    await ctx
      .http()
      .delete(`/v1/split/groups/${fresh.body.id}/expenses/${expense.body.id}`)
      .set(auth(user))
      .expect(200);

    const accountsAfter = await get('/v1/accounts').expect(200);
    expect(accountsAfter.body.find((a: { id: string }) => a.id === accountId).balanceMinor).toBe(
      balanceBefore,
    );
  });

  it('refuses to delete a group that has spending in it', async () => {
    await ctx.http().delete(`/v1/split/groups/${groupId}`).set(auth(user)).expect(400);
  });

  it('keeps a removed member’s history, and their balance', async () => {
    const group = await get(`/v1/split/groups/${groupId}`).expect(200);
    const before = group.body.members.find((m: { id: string }) => m.id === rahimId).netMinor;
    expect(before).not.toBe(0);

    await ctx
      .http()
      .delete(`/v1/split/groups/${groupId}/members/${rahimId}`)
      .set(auth(user))
      .expect(200);

    const after = await get(`/v1/split/groups/${groupId}`).expect(200);
    const rahim = after.body.members.find((m: { id: string }) => m.id === rahimId);
    /* Still there, marked removed, still owing exactly what they owed. A balance
       that disappears because somebody left the group was never settled. */
    expect(rahim.removedAt).toBeTruthy();
    expect(rahim.netMinor).toBe(before);
  });

  it('refuses to remove the owner from their own group', async () => {
    await ctx
      .http()
      .delete(`/v1/split/groups/${groupId}/members/${meId}`)
      .set(auth(user))
      .expect(400);
  });

  it('puts shared debt on the same party ledger as a loan', async () => {
    /* One person, one balance. Somebody who owes ৳2,000 from a trip and ৳5,000
       from a loan owes ৳7,000, and two screens each telling half of that is how
       a person ends up asking for the wrong amount back. Both post to the same
       control accounts, so both belong on the same subsidiary ledger. */
    const people = await get('/v1/people').expect(200);
    const karim = people.body.find((p: { name: string }) => p.name === 'করিম');

    const beforeLoan = await get(`/v1/loans/people/${karim.id}/ledger`).expect(200);
    const sharedOnly = beforeLoan.body.netPositionMinor;
    expect(sharedOnly).not.toBe(0);
    expect(beforeLoan.body.rows.some((r: { groupId: string | null }) => r.groupId)).toBe(true);

    await post('/v1/loans', {
      direction: 'LENT',
      personId: karim.id,
      principalMinor: 500_000,
      loanDate: '2026-08-09',
      accountId,
    }).expect(201);

    const after = await get(`/v1/loans/people/${karim.id}/ledger`).expect(200);
    expect(after.body.netPositionMinor).toBe(sharedOnly + 500_000);

    /* And both kinds of row are on the one statement, in date order. */
    const kinds = after.body.rows.map((r: { loanId: string | null }) =>
      r.loanId ? 'loan' : 'split',
    );
    expect(kinds).toContain('loan');
    expect(kinds).toContain('split');
  });

  it('records who added what', async () => {
    const log = await get('/v1/audit?limit=50').expect(200);
    const actions = log.body.items.map((row: { action: string }) => row.action);
    expect(actions).toContain('split.group_created');
    expect(actions).toContain('split.expense_added');
    expect(actions).toContain('split.settled');
  });
});

describe('shared spending belongs to one workspace', () => {
  let ctx: TestContext;
  let owner: Awaited<ReturnType<typeof signup>>;
  let stranger: Awaited<ReturnType<typeof signup>>;
  let groupId: string;
  let memberId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    owner = await signup(ctx);
    stranger = await signup(ctx);

    const group = await ctx
      .http()
      .post('/v1/split/groups')
      .set(auth(owner))
      .send({ name: 'অফিসের লাঞ্চ', members: [{ name: 'সহকর্মী' }] })
      .expect(201);
    groupId = group.body.id;
    memberId = group.body.members[1].id;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('is invisible to somebody else', async () => {
    const mine = await ctx.http().get('/v1/split/groups').set(auth(stranger)).expect(200);
    expect(mine.body).toHaveLength(0);
  });

  it('answers 404 rather than 403, so nothing is confirmed to exist', async () => {
    await ctx.http().get(`/v1/split/groups/${groupId}`).set(auth(stranger)).expect(404);
  });

  it('refuses a bill posted into somebody else’s group', async () => {
    await ctx
      .http()
      .post(`/v1/split/groups/${groupId}/expenses`)
      .set(auth(stranger))
      .send({
        description: 'অনুপ্রবেশ',
        date: '2026-08-14',
        totalMinor: 10_000,
        payerMemberId: memberId,
        splitMethod: 'EQUAL',
        shares: [{ memberId }],
      })
      .expect(404);
  });

  it('refuses to delete somebody else’s group', async () => {
    await ctx.http().delete(`/v1/split/groups/${groupId}`).set(auth(stranger)).expect(404);
  });

  it('keeps two people’s groups apart when both have one', async () => {
    await ctx
      .http()
      .post('/v1/split/groups')
      .set(auth(stranger))
      .send({ name: 'নিজের গ্রুপ' })
      .expect(201);

    const ownerGroups = await ctx.http().get('/v1/split/groups').set(auth(owner)).expect(200);
    const strangerGroups = await ctx.http().get('/v1/split/groups').set(auth(stranger)).expect(200);

    expect(ownerGroups.body.map((g: { name: string }) => g.name)).toEqual(['অফিসের লাঞ্চ']);
    expect(strangerGroups.body.map((g: { name: string }) => g.name)).toEqual(['নিজের গ্রুপ']);
  });
});
