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
  let categoryId: string;
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

    /* An expense category, because only the owner's own share of a shared bill
       is spending of theirs — and spending has to say what it was for. */
    categoryId = (await get('/v1/categories').expect(200)).body.find(
      (c: { kind: string }) => c.kind === 'EXPENSE',
    ).id;
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
      categoryId,
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
      categoryId,
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
      categoryId,
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
      categoryId,
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
      categoryId,
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
      categoryId,
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
      categoryId,
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

/**
 * Two people, two workspaces, one dinner.
 *
 * The rule this whole milestone is built around: **nothing is written into
 * another person's ledger without them asking for it.** Accepting an invitation
 * gives the inviter no write access — it says "send me the bills I am on, as
 * drafts". Everything below is a test of that sentence.
 */
describe('inviting somebody who keeps their own books', () => {
  let ctx: TestContext;
  let host: Awaited<ReturnType<typeof signup>>;
  let guest: Awaited<ReturnType<typeof signup>>;
  let hostAccount: string;
  let guestAccount: string;
  let groupId: string;
  let hostMemberId: string;
  let guestMemberId: string;
  let inviteUrl: string;
  let hostCategoryId: string;
  let guestCategoryId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    host = await signup(ctx);
    guest = await signup(ctx);

    const make = async (as: typeof host, name: string) =>
      (
        await ctx
          .http()
          .post('/v1/accounts')
          .set(auth(as))
          .send({ name, type: 'CASH', openingBalance: 5_000_000 })
          .expect(201)
      ).body.id;
    hostAccount = await make(host, 'নগদ');
    guestAccount = await make(guest, 'নগদ');
    /* Accepting a shared bill writes an expense in the guest's books, and an
       expense says what it was for. */
    guestCategoryId = (
      await ctx.http().get('/v1/categories').set(auth(guest)).expect(200)
    ).body.find((c: { kind: string }) => c.kind === 'EXPENSE').id;
    hostCategoryId = (await ctx.http().get('/v1/categories').set(auth(host)).expect(200)).body.find(
      (c: { kind: string }) => c.kind === 'EXPENSE',
    ).id;

    const group = await ctx
      .http()
      .post('/v1/split/groups')
      .set(auth(host))
      .send({ name: 'বন্ধুদের ডিনার', members: [{ name: 'অতিথি' }] })
      .expect(201);
    groupId = group.body.id;
    hostMemberId = group.body.members.find((m: { isSelf: boolean }) => m.isSelf).id;
    guestMemberId = group.body.members.find((m: { isSelf: boolean }) => !m.isSelf).id;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('hands out a link, and only its hash is kept', async () => {
    const res = await ctx
      .http()
      .post(`/v1/split/groups/${groupId}/members/${guestMemberId}/invite`)
      .set(auth(host))
      .expect(201);

    expect(res.body.url).toMatch(/^\/split\/join\/[A-Za-z0-9_-]{20,}$/);
    inviteUrl = res.body.url;

    const token = inviteUrl.replace('/split/join/', '');
    const rows = await ctx.prisma.splitInvite.findMany({ where: { memberId: guestMemberId } });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('refuses an invitation nobody handed out', async () => {
    await ctx.http().post('/v1/split/join/no-such-token').set(auth(guest)).expect(404);
  });

  it('links the two workspaces when the guest accepts', async () => {
    const res = await ctx.http().post(`/v1${inviteUrl}`).set(auth(guest)).expect(201);
    expect(res.body.groupName).toBe('বন্ধুদের ডিনার');
    /* No bills yet, so nothing to mirror. */
    expect(res.body.drafts).toBe(0);
  });

  it('cannot be accepted twice', async () => {
    await ctx.http().post(`/v1${inviteUrl}`).set(auth(guest)).expect(404);
  });

  it('sends a new bill to the guest as a draft, not as an entry', async () => {
    await ctx
      .http()
      .post(`/v1/split/groups/${groupId}/expenses`)
      .set(auth(host))
      .send({
        description: 'রাতের খাবার',
        date: '2026-08-14',
        totalMinor: 200_000,
        payerMemberId: hostMemberId,
        splitMethod: 'EQUAL',
        categoryId: hostCategoryId,
        shares: [{ memberId: hostMemberId }, { memberId: guestMemberId }],
        accountId: hostAccount,
      })
      .expect(201);

    const inbox = await ctx.http().get('/v1/split/inbox').set(auth(guest)).expect(200);
    expect(inbox.body).toHaveLength(1);
    expect(inbox.body[0].amountMinor).toBe(100_000);
    expect(inbox.body[0].payerName).toBe('আমি');

    /* Nothing has reached the guest's books. This is the whole point: an
       invitation lets somebody put a draft in front of you, never an entry. */
    const summary = await ctx
      .http()
      .get('/v1/transactions/summary?month=2026-08')
      .set(auth(guest))
      .expect(200);
    expect(summary.body.expenseMinor).toBe(0);
  });

  it('shows the guest their share and nothing else about the group', async () => {
    /* A shared dinner must not disclose what a third person earns or owes. */
    const inbox = await ctx.http().get('/v1/split/inbox').set(auth(guest)).expect(200);
    const body = JSON.stringify(inbox.body);
    expect(body).not.toContain('200000');
    expect(body).not.toContain(hostMemberId);
    expect(body).not.toContain(groupId);
  });

  it('posts the guest’s own entries only once they accept', async () => {
    const inbox = await ctx.http().get('/v1/split/inbox').set(auth(guest)).expect(200);
    await ctx
      .http()
      .post(`/v1/split/inbox/${inbox.body[0].id}/accept`)
      .set(auth(guest))
      .send({ categoryId: guestCategoryId })
      .expect(201);

    const summary = await ctx
      .http()
      .get('/v1/transactions/summary?month=2026-08')
      .set(auth(guest))
      .expect(200);
    expect(summary.body.expenseMinor).toBe(100_000);

    /* Their share is an expense and a debt. No cash left their account, because
       none did. */
    const accounts = await ctx.http().get('/v1/accounts').set(auth(guest)).expect(200);
    expect(accounts.body.find((a: { id: string }) => a.id === guestAccount).balanceMinor).toBe(
      5_000_000,
    );
    expect(summary.body.netWorthMinor).toBe(5_000_000 - 100_000);
  });

  it('does not offer the same draft twice', async () => {
    const inbox = await ctx.http().get('/v1/split/inbox').set(auth(guest)).expect(200);
    expect(inbox.body).toHaveLength(0);
  });

  it('leaves the host’s receivable exactly as it was', async () => {
    /* What the guest does in their own books is their business. The host lent
       ৳1,000 either way. */
    const group = await ctx.http().get(`/v1/split/groups/${groupId}`).set(auth(host)).expect(200);
    const guestPosition = group.body.members.find(
      (m: { id: string }) => m.id === guestMemberId,
    ).netMinor;
    expect(guestPosition).toBe(-100_000);
  });

  it('a declined draft posts nothing and cannot be revived', async () => {
    await ctx
      .http()
      .post(`/v1/split/groups/${groupId}/expenses`)
      .set(auth(host))
      .send({
        description: 'চা',
        date: '2026-08-15',
        totalMinor: 10_000,
        payerMemberId: hostMemberId,
        splitMethod: 'EQUAL',
        categoryId: hostCategoryId,
        shares: [{ memberId: hostMemberId }, { memberId: guestMemberId }],
        accountId: hostAccount,
      })
      .expect(201);

    const inbox = await ctx.http().get('/v1/split/inbox').set(auth(guest)).expect(200);
    const draftId = inbox.body[0].id;
    await ctx.http().post(`/v1/split/inbox/${draftId}/decline`).set(auth(guest)).expect(201);

    await ctx
      .http()
      .post(`/v1/split/inbox/${draftId}/accept`)
      .set(auth(guest))
      .send({ categoryId: guestCategoryId })
      .expect(404);

    const summary = await ctx
      .http()
      .get('/v1/transactions/summary?month=2026-08')
      .set(auth(guest))
      .expect(200);
    expect(summary.body.expenseMinor).toBe(100_000);
  });

  it('never shows one workspace another workspace’s inbox', async () => {
    const hostInbox = await ctx.http().get('/v1/split/inbox').set(auth(host)).expect(200);
    expect(hostInbox.body).toHaveLength(0);
  });

  it('records the link on both sides', async () => {
    const hostLog = await ctx.http().get('/v1/audit?limit=50').set(auth(host)).expect(200);
    expect(hostLog.body.items.map((r: { action: string }) => r.action)).toContain('split.invited');

    const guestLog = await ctx.http().get('/v1/audit?limit=50').set(auth(guest)).expect(200);
    expect(guestLog.body.items.map((r: { action: string }) => r.action)).toContain(
      'split.mirror_accepted',
    );
  });
});

/**
 * A common pot: a family fund, an office samity, a trip kitty.
 *
 * Different from splitting and asked for separately. The subtle part is
 * spending: the pot was made of everybody's money, so spending it consumes the
 * owner's own share *and* discharges what they owed the other contributors.
 * Miss the second half and somebody who ran a samity for a year ends it looking
 * bankrupt — still owing every taka anybody put in, with the pot that would
 * have repaid them empty.
 */
describe('a common pot', () => {
  let ctx: TestContext;
  let user: Awaited<ReturnType<typeof signup>>;
  let accountId: string;
  let groupId: string;
  let meId: string;
  let categoryId: string;
  let karimId: string;

  const post = (path: string, body: Record<string, unknown>) =>
    ctx.http().post(path).set(auth(user)).send(body);
  const get = (path: string) => ctx.http().get(path).set(auth(user));

  beforeAll(async () => {
    ctx = await createTestApp();
    user = await signup(ctx);

    accountId = (
      await post('/v1/accounts', { name: 'নগদ', type: 'CASH', openingBalance: 10_000_000 }).expect(
        201,
      )
    ).body.id;

    const group = await post('/v1/split/groups', {
      name: 'অফিস সমিতি',
      purpose: 'OFFICE',
      members: [{ name: 'করিম' }],
    }).expect(201);
    groupId = group.body.id;
    meId = group.body.members.find((m: { isSelf: boolean }) => m.isSelf).id;
    karimId = group.body.members.find((m: { isSelf: boolean }) => !m.isSelf).id;

    await post(`/v1/split/groups/${groupId}/pot`, {}).expect(201);

    /* An expense category, because only the owner's own share of a shared bill
       is spending of theirs — and spending has to say what it was for. */
    categoryId = (await get('/v1/categories').expect(200)).body.find(
      (c: { kind: string }) => c.kind === 'EXPENSE',
    ).id;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('opens a real account for the pot, so it is on the balance sheet', async () => {
    const group = await get(`/v1/split/groups/${groupId}`).expect(200);
    expect(group.body.potAccountId).toBeTruthy();
    expect(group.body.potBalanceMinor).toBe(0);

    const accounts = await get('/v1/accounts').expect(200);
    const pot = accounts.body.find((a: { id: string }) => a.id === group.body.potAccountId);
    expect(pot.type).toBe('ASSET');
  });

  it('takes the owner’s own contribution out of their pocket, not their worth', async () => {
    const before = await get('/v1/transactions/summary').expect(200);

    await post(`/v1/split/groups/${groupId}/contributions`, {
      memberId: meId,
      amountMinor: 500_000,
      date: '2026-08-01',
      accountId,
    }).expect(201);

    const after = await get('/v1/transactions/summary').expect(200);
    /* Cash down ৳5,000, pot up ৳5,000. Still the owner's money until it is
       spent, so net worth must not move — and it is certainly not spending. */
    expect(after.body.liquidMinor).toBe(before.body.liquidMinor - 500_000);
    expect(after.body.netWorthMinor).toBe(before.body.netWorthMinor);
    expect(after.body.expenseMinor).toBe(before.body.expenseMinor);
  });

  it('somebody else’s contribution grows the pot and what is owed them', async () => {
    const before = await get('/v1/transactions/summary').expect(200);

    await post(`/v1/split/groups/${groupId}/contributions`, {
      memberId: karimId,
      amountMinor: 500_000,
      date: '2026-08-02',
    }).expect(201);

    const after = await get('/v1/transactions/summary').expect(200);
    /* The pot is an asset and the debt to Karim is a liability of the same
       size. The holder is no richer, which is the honest answer: it is his
       money in your hands. */
    expect(after.body.assetsMinor).toBe(before.body.assetsMinor + 500_000);
    expect(after.body.liabilitiesMinor).toBe(before.body.liabilitiesMinor + 500_000);
    expect(after.body.netWorthMinor).toBe(before.body.netWorthMinor);

    const group = await get(`/v1/split/groups/${groupId}`).expect(200);
    expect(group.body.potBalanceMinor).toBe(1_000_000);
  });

  it('spending the pot is the owner’s share only, and clears the rest of the debt', async () => {
    const before = await get('/v1/transactions/summary?month=2026-08').expect(200);

    await post(`/v1/split/groups/${groupId}/expenses`, {
      description: 'অফিসের চা-নাশতা',
      date: '2026-08-05',
      totalMinor: 400_000,
      payerMemberId: meId,
      splitMethod: 'EQUAL',
      categoryId,
      shares: [{ memberId: meId }, { memberId: karimId }],
      fromPot: true,
    }).expect(201);

    const after = await get('/v1/transactions/summary?month=2026-08').expect(200);

    /* ৳2,000 of it was the owner's own money and is spending. */
    expect(after.body.expenseMinor).toBe(before.body.expenseMinor + 200_000);
    /* The other ৳2,000 was Karim's, so what is owed him falls by that much. */
    expect(after.body.liabilitiesMinor).toBe(before.body.liabilitiesMinor - 200_000);
    /* No cash left any wallet — the pot paid. */
    expect(after.body.liquidMinor).toBe(before.body.liquidMinor);

    const group = await get(`/v1/split/groups/${groupId}`).expect(200);
    expect(group.body.potBalanceMinor).toBe(600_000);
  });

  it('the holder ends up neither richer nor poorer than they spent', async () => {
    /* The whole test of a pot done right: put in ৳5,000, consumed ৳2,000 of it,
       so net worth is down exactly ৳2,000 from where it started and not a taka
       more. Karim's money never touched it. */
    const summary = await get('/v1/transactions/summary').expect(200);
    expect(summary.body.netWorthMinor).toBe(10_000_000 - 200_000);
  });

  it('lists who put in what', async () => {
    const rows = await get(`/v1/split/groups/${groupId}/contributions`).expect(200);
    expect(rows.body).toHaveLength(2);
    expect(rows.body.map((r: { amountMinor: number }) => r.amountMinor)).toEqual([
      500_000, 500_000,
    ]);
  });

  it('refuses to spend a pot that does not exist', async () => {
    const plain = await post('/v1/split/groups', { name: 'সাধারণ গ্রুপ' }).expect(201);
    const selfId = plain.body.members[0].id;
    await post(`/v1/split/groups/${plain.body.id}/expenses`, {
      description: 'তহবিল ছাড়া',
      date: '2026-08-06',
      totalMinor: 10_000,
      payerMemberId: selfId,
      splitMethod: 'EQUAL',
      categoryId,
      shares: [{ memberId: selfId }],
      fromPot: true,
    }).expect(400);
  });

  it('refuses a second pot on the same group', async () => {
    await post(`/v1/split/groups/${groupId}/pot`, {}).expect(400);
  });
});

/**
 * One human, one row.
 *
 * A name is not an identity: two people called করিম are two people. Adding করিম
 * to a trip used to create a second করিম beside the one who had borrowed money
 * last year — two rows, two balances, and no screen that showed the ৳7,000 he
 * actually owed. A number is an identity, so a number is what this matches on.
 */
describe('a person is their number, not their name', () => {
  let ctx: TestContext;
  let user: Awaited<ReturnType<typeof signup>>;
  let accountId: string;

  const post = (path: string, body: Record<string, unknown>) =>
    ctx.http().post(path).set(auth(user)).send(body);
  const get = (path: string) => ctx.http().get(path).set(auth(user));

  beforeAll(async () => {
    ctx = await createTestApp();
    user = await signup(ctx);
    accountId = (
      await post('/v1/accounts', { name: 'নগদ', type: 'CASH', openingBalance: 5_000_000 }).expect(
        201,
      )
    ).body.id;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('puts a trip share on the same ledger as an older loan', async () => {
    /* করিম borrows ৳5,000 on his number… */
    await post('/v1/loans', {
      direction: 'LENT',
      personName: 'করিম',
      personPhone: '01712345678',
      principalMinor: 500_000,
      loanDate: '2026-08-01',
      accountId,
    }).expect(201);

    /* …then joins a trip, entered by whatever spelling came to hand. */
    const group = await post('/v1/split/groups', {
      name: 'ট্রিপ',
      members: [{ name: 'করিম ভাই', phone: '+8801712345678' }],
    }).expect(201);

    const people = await get('/v1/people').expect(200);
    const karims = people.body.filter((p: { name: string }) => p.name.includes('করিম'));
    expect(karims).toHaveLength(1);

    const member = group.body.members.find((m: { isSelf: boolean }) => !m.isSelf);
    expect(member.personId).toBe(karims[0].id);
  });

  it('so what he owes is one number, from both', async () => {
    const people = await get('/v1/people').expect(200);
    const karim = people.body.find((p: { name: string }) => p.name.includes('করিম'));
    const group = (await get('/v1/split/groups').expect(200)).body[0];
    const detail = await get(`/v1/split/groups/${group.id}`).expect(200);
    const me = detail.body.members.find((m: { isSelf: boolean }) => m.isSelf);
    const him = detail.body.members.find((m: { isSelf: boolean }) => !m.isSelf);

    await post(`/v1/split/groups/${group.id}/expenses`, {
      description: 'হোটেল',
      date: '2026-08-05',
      totalMinor: 400_000,
      payerMemberId: me.id,
      splitMethod: 'EQUAL',
      categoryId: (await get('/v1/categories').expect(200)).body.find(
        (c: { kind: string }) => c.kind === 'EXPENSE',
      ).id,
      shares: [{ memberId: me.id }, { memberId: him.id }],
      accountId,
    }).expect(201);

    /* ৳5,000 lent + ৳2,000 of hotel = ৳7,000, on one party ledger. */
    const ledger = await get(`/v1/loans/people/${karim.id}/ledger`).expect(200);
    expect(ledger.body.netPositionMinor).toBe(700_000);
  });

  it('two people with no number are still two people', async () => {
    const group = await post('/v1/split/groups', {
      name: 'নাম মেলানোর পরীক্ষা',
      members: [{ name: 'রহিম' }, { name: 'রহিম' }],
    }).expect(201);
    /* Same name, nothing to tell them apart, so they are not merged on a
       guess: silently joining two people's money is far worse than two rows. */
    expect(group.body.members.filter((m: { isSelf: boolean }) => !m.isSelf)).toHaveLength(2);
  });

  it('refuses a second person on a number somebody already has', async () => {
    await post('/v1/people', { name: 'অন্য কেউ', phone: '01712345678' }).expect(400);
  });
});

/**
 * One public link per trip.
 *
 * Everybody who was on it already knows what it cost and roughly who paid, so
 * the page shows the whole group — every bill, each member's total paid and
 * total share, and the fewest payments that clear it. What it must never carry
 * is anything from outside the group.
 */
describe('a trip anybody can open', () => {
  let ctx: TestContext;
  let user: Awaited<ReturnType<typeof signup>>;
  let token: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    user = await signup(ctx);
    const accountId = (
      await ctx
        .http()
        .post('/v1/accounts')
        .set(auth(user))
        .send({ name: 'নগদ', type: 'CASH', openingBalance: 5_000_000 })
        .expect(201)
    ).body.id;

    const group = await ctx
      .http()
      .post('/v1/split/groups')
      .set(auth(user))
      .send({ name: 'কক্সবাজার', members: [{ name: 'করিম' }, { name: 'রহিম' }] })
      .expect(201);
    const me = group.body.members.find((m: { isSelf: boolean }) => m.isSelf).id;
    const others = group.body.members.filter((m: { isSelf: boolean }) => !m.isSelf);

    await ctx
      .http()
      .post(`/v1/split/groups/${group.body.id}/expenses`)
      .set(auth(user))
      .send({
        description: 'হোটেল',
        date: '2026-08-05',
        totalMinor: 900_000,
        payerMemberId: me,
        splitMethod: 'EQUAL',
        categoryId: (await ctx.http().get('/v1/categories').set(auth(user)).expect(200)).body.find(
          (c: { kind: string }) => c.kind === 'EXPENSE',
        ).id,
        shares: [{ memberId: me }, ...others.map((o: { id: string }) => ({ memberId: o.id }))],
        accountId,
      })
      .expect(201);

    const share = await ctx
      .http()
      .post('/v1/statement-shares')
      .set(auth(user))
      .send({ kind: 'GROUP', subjectId: group.body.id })
      .expect(201);
    token = share.body.url.replace('/s/', '');
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('opens with no session at all', async () => {
    const res = await ctx.http().get(`/v1/public/statement/${token}`).expect(200);
    expect(res.body.kind).toBe('GROUP');
    expect(res.body.title).toBe('কক্সবাজার');
    expect(res.body.data.totalMinor).toBe(900_000);
  });

  it('says who paid and what each person’s share was', async () => {
    const res = await ctx.http().get(`/v1/public/statement/${token}`).expect(200);
    const members = res.body.data.members as {
      name: string;
      paidMinor: number;
      shareMinor: number;
      netMinor: number;
    }[];
    expect(members).toHaveLength(3);
    const owner = members.find((m) => m.paidMinor === 900_000);
    expect(owner?.shareMinor).toBe(300_000);
    expect(owner?.netMinor).toBe(600_000);
    /* A group's positions always sum to zero. */
    expect(members.reduce((sum, m) => sum + m.netMinor, 0)).toBe(0);
  });

  it('works out who should pay whom, so nobody has to', async () => {
    const res = await ctx.http().get(`/v1/public/statement/${token}`).expect(200);
    const settle = res.body.data.settleUp as { amountMinor: number }[];
    expect(settle).toHaveLength(2);
    expect(settle.every((s) => s.amountMinor === 300_000)).toBe(true);
  });

  it('carries nothing from outside the trip', async () => {
    /* No account balances, no other spending, no ids that reach anywhere. The
       owner's ledger stays theirs. */
    const res = await ctx.http().get(`/v1/public/statement/${token}`).expect(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(user.email);
    expect(body).not.toContain(user.workspaceId);
    expect(res.body.data).not.toHaveProperty('accounts');
  });

  it('stops opening once it is taken back', async () => {
    const list = await ctx
      .http()
      .get('/v1/statement-shares?kind=GROUP&subjectId=' + (await currentGroupId()))
      .set(auth(user))
      .expect(200);
    await ctx.http().delete(`/v1/statement-shares/${list.body[0].id}`).set(auth(user)).expect(200);
    await ctx.http().get(`/v1/public/statement/${token}`).expect(404);
  });

  async function currentGroupId(): Promise<string> {
    const groups = await ctx.http().get('/v1/split/groups').set(auth(user)).expect(200);
    return groups.body[0].id;
  }
});

/**
 * A share of your own is spending of your own, and spending says what it was for.
 *
 * Its own group and its own workspace, because every test here moves money and
 * the suites above assert on running totals — a bill added to their group is a
 * bill their arithmetic did not expect.
 */
describe('what a shared bill is filed under', () => {
  let ctx: TestContext;
  let user: Awaited<ReturnType<typeof signup>>;
  let accountId: string;
  let groupId: string;
  let meId: string;
  let karimId: string;
  let rahimId: string;
  let categoryId: string;

  const post = (path: string, body: Record<string, unknown>) =>
    ctx.http().post(path).set(auth(user)).send(body);
  const get = (path: string) => ctx.http().get(path).set(auth(user));

  beforeAll(async () => {
    ctx = await createTestApp();
    user = await signup(ctx);

    accountId = (
      await post('/v1/accounts', { name: 'নগদ', type: 'CASH', openingBalance: 10_000_000 }).expect(
        201,
      )
    ).body.id;

    const group = await post('/v1/split/groups', {
      name: 'খাতের পরীক্ষা',
      purpose: 'TRIP',
      members: [{ name: 'করিম' }, { name: 'রহিম' }],
    }).expect(201);
    groupId = group.body.id;
    meId = group.body.members.find((m: { isSelf: boolean }) => m.isSelf).id;
    karimId = group.body.members.find((m: { displayName: string }) => m.displayName === 'করিম').id;
    rahimId = group.body.members.find((m: { displayName: string }) => m.displayName === 'রহিম').id;

    categoryId = (await get('/v1/categories').expect(200)).body.find(
      (c: { kind: string }) => c.kind === 'EXPENSE',
    ).id;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('refuses a share of your own with no category to file it under', async () => {
    /* The reason the rule exists: without it the owner's leg posted to the
       expense nominal with a null category, and every shared bill in the
       product piled up in the reports' unclassified bucket — the analysis by
       nature IAS 1.99 asks for, defeated by an omission on one form. */
    const res = await post(`/v1/split/groups/${groupId}/expenses`, {
      description: 'খাত ছাড়া',
      date: '2026-08-10',
      totalMinor: 300_000,
      payerMemberId: meId,
      splitMethod: 'EQUAL',
      shares: [{ memberId: meId }, { memberId: karimId }],
      accountId,
    }).expect(400);
    expect(res.body.message).toContain('খাত');
  });

  it('asks for no category on a bill that is not yours', async () => {
    /* Two other members splitting a tea posts nothing to these books, so there
       is no expense to classify and demanding a category would be asking about
       a transaction that does not exist. */
    const expense = await post(`/v1/split/groups/${groupId}/expenses`, {
      description: 'ওদের দুজনের চা',
      date: '2026-08-10',
      totalMinor: 20_000,
      payerMemberId: karimId,
      splitMethod: 'EQUAL',
      shares: [{ memberId: karimId }, { memberId: rahimId }],
    }).expect(201);
    expect(expense.body.transactionId).toBeNull();
  });

  it('files the owner’s share under the category it was given, and nothing else', async () => {
    const expense = await post(`/v1/split/groups/${groupId}/expenses`, {
      description: 'নাশতা',
      date: '2026-08-10',
      totalMinor: 200_000,
      payerMemberId: meId,
      splitMethod: 'EQUAL',
      categoryId,
      shares: [{ memberId: meId }, { memberId: karimId }],
      accountId,
    }).expect(201);

    const entries = await ctx.prisma.ledgerEntry.findMany({
      where: { transactionId: expense.body.transactionId },
      select: { categoryId: true, amountMinor: true },
    });

    /* Exactly one leg carries it — the owner's ৳1,000 share. What করিম owes is
       a receivable, not spending, and a receivable has no category. */
    const filed = entries.filter((e) => e.categoryId !== null);
    expect(filed).toHaveLength(1);
    expect(filed[0]?.categoryId).toBe(categoryId);
    expect(Number(filed[0]?.amountMinor)).toBe(100_000);
  });

  it('refuses a category from another workspace', async () => {
    const stranger = await signup(ctx);
    const theirs = (
      await ctx.http().get('/v1/categories').set(auth(stranger)).expect(200)
    ).body.find((c: { kind: string }) => c.kind === 'EXPENSE');

    await post(`/v1/split/groups/${groupId}/expenses`, {
      description: 'অন্যের খাত',
      date: '2026-08-11',
      totalMinor: 100_000,
      payerMemberId: meId,
      splitMethod: 'EQUAL',
      categoryId: theirs.id,
      shares: [{ memberId: meId }, { memberId: karimId }],
      accountId,
    }).expect(404);
  });
});
