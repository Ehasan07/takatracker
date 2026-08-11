import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, createTestApp, resetDatabase, signup, type TestContext } from './harness';

/**
 * Contacts, end to end.
 *
 * A `Person` used to be a side effect of recording a loan and nothing could
 * edit one afterwards, so most of what these tests defend is not "the endpoint
 * answers" but "the money survived the edit". Merging two people moves whole
 * loans and their instalments between rows; the one thing that must never
 * happen is that a poisha moves with them. Every case that folds two people
 * together checks the balance sheet on both sides of the merge.
 */

const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return iso(d);
};

interface PersonRow {
  id: string;
  name: string;
  phone: string | null;
  relation: string | null;
  note: string | null;
  loanCount: number;
  receivableMinor: number;
  payableMinor: number;
  netMinor: number;
  transactionCount: number;
  duplicateOfIds: string[];
  bucket?: 'main' | 'suggestion';
}

describe('people', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  async function workspaceWithCash(): Promise<{
    user: Awaited<ReturnType<typeof signup>>;
    cashId: string;
  }> {
    const user = await signup(ctx);
    const cash = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'নগদ', type: 'CASH', openingBalance: 20_000_000 })
      .expect(201);
    return { user, cashId: cash.body.id as string };
  }

  async function lend(
    user: Awaited<ReturnType<typeof signup>>,
    cashId: string,
    personName: string,
    principalMinor: number,
  ): Promise<string> {
    const res = await ctx
      .http()
      .post('/v1/loans')
      .set(auth(user))
      .send({
        personName,
        direction: 'LENT',
        principalMinor,
        interestType: 'NONE',
        loanDate: daysAgo(5),
        accountId: cashId,
      })
      .expect(201);
    return res.body.loan.id as string;
  }

  const list = async (user: Awaited<ReturnType<typeof signup>>, q = ''): Promise<PersonRow[]> => {
    const res = await ctx
      .http()
      .get(`/v1/people${q ? `?q=${encodeURIComponent(q)}` : ''}`)
      .set(auth(user))
      .expect(200);
    return res.body as PersonRow[];
  };

  const expenseCategory = async (user: Awaited<ReturnType<typeof signup>>): Promise<string> => {
    const res = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    return (res.body as { kind: string; id: string }[]).find((c) => c.kind === 'EXPENSE')!.id;
  };

  const expense = (accountId: string, categoryId: string) => ({
    date: daysAgo(1),
    type: 'EXPENSE' as const,
    amountMinor: 25_000,
    accountId,
    categoryId,
    description: 'বাজার',
  });

  const netWorth = async (user: Awaited<ReturnType<typeof signup>>): Promise<number> => {
    const res = await ctx.http().get('/v1/reports/balance-sheet').set(auth(user)).expect(200);
    return res.body.netWorthMinor as number;
  };

  it('surfaces the person a loan created, with what stands between you', async () => {
    const { user, cashId } = await workspaceWithCash();
    await lend(user, cashId, 'করিম', 5_000_000);

    const [karim] = await list(user);
    expect(karim?.name).toBe('করিম');
    expect(karim?.loanCount).toBe(1);
    expect(karim?.receivableMinor).toBe(5_000_000);
    expect(karim?.payableMinor).toBe(0);
    // Positive means they owe you — the sign the party ledger prints.
    expect(karim?.netMinor).toBe(5_000_000);
  });

  it('edits a contact the loan form could only ever create', async () => {
    const { user, cashId } = await workspaceWithCash();
    await lend(user, cashId, 'রহিম', 1_000_000);
    const [rahim] = await list(user);

    const updated = await ctx
      .http()
      .patch(`/v1/people/${rahim!.id}`)
      .set(auth(user))
      .send({ phone: '+8801711223344', relation: 'মামা', note: 'গ্রামের বাড়ি' })
      .expect(200);

    // The phone is stored canonically whichever of its six spellings arrived.
    expect(updated.body.phone).toBe('01711223344');
    expect(updated.body.relation).toBe('মামা');
    expect(updated.body.note).toBe('গ্রামের বাড়ি');
  });

  it('finds করিম by its Banglish spellings and by the phone', async () => {
    const { user, cashId } = await workspaceWithCash();
    await lend(user, cashId, 'করিম', 1_000_000);
    const [karim] = await list(user);
    await ctx
      .http()
      .patch(`/v1/people/${karim!.id}`)
      .set(auth(user))
      .send({ phone: '01711223344' })
      .expect(200);

    for (const spelling of ['karim', 'korim', 'করিম', '+8801711223344']) {
      const hits = await list(user, spelling);
      expect(
        hits.some((row) => row.id === karim!.id),
        `"${spelling}" should find করিম`,
      ).toBe(true);
    }
  });

  it('refuses to remove somebody who still owes money, and says how much is in the way', async () => {
    const { user, cashId } = await workspaceWithCash();
    await lend(user, cashId, 'করিম', 5_000_000);
    const [karim] = await list(user);

    const refused = await ctx.http().delete(`/v1/people/${karim!.id}`).set(auth(user)).expect(400);

    // The count, not just "this person has loans" — one is actionable.
    expect(refused.body.message).toContain('১টি ঋণ');
    expect(await list(user)).toHaveLength(1);
  });

  it('removes a contact and leaves the books exactly where they were', async () => {
    const { user } = await workspaceWithCash();
    const person = await ctx
      .http()
      .post('/v1/people')
      .set(auth(user))
      .send({ name: 'দোকানদার', relation: 'দোকানদার' })
      .expect(201);

    const before = await netWorth(user);

    const removed = await ctx
      .http()
      .delete(`/v1/people/${person.body.id}`)
      .set(auth(user))
      .expect(200);

    expect(removed.body.transactionCount).toBe(0);
    expect(removed.body.message).toContain('তালিকা থেকে সরানো হয়েছে');
    expect(await list(user)).toHaveLength(0);
    // A contact is a label on the books, never a line in them.
    expect(await netWorth(user)).toBe(before);
  });

  it('counts an ordinary expense against the person it names', async () => {
    const { user, cashId } = await workspaceWithCash();
    const person = await ctx
      .http()
      .post('/v1/people')
      .set(auth(user))
      .send({ name: 'দোকানদার' })
      .expect(201);

    const created = await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({ ...expense(cashId, await expenseCategory(user)), personId: person.body.id })
      .expect(201);

    // Read back, not just accepted: the column was written for months and
    // never returned, so "the POST answered 201" proved nothing.
    expect(created.body.personId).toBe(person.body.id);
    expect(created.body.personName).toBe('দোকানদার');

    const [row] = await list(user);
    expect(row?.transactionCount).toBe(1);
    // The khata's person filter, which could not reach a manual entry before.
    const filtered = await ctx
      .http()
      .get(`/v1/transactions?personId=${person.body.id}`)
      .set(auth(user))
      .expect(200);
    expect(filtered.body.items).toHaveLength(1);
  });

  it('says what it will not destroy, and then does not destroy it', async () => {
    const { user, cashId } = await workspaceWithCash();
    const person = await ctx
      .http()
      .post('/v1/people')
      .set(auth(user))
      .send({ name: 'দোকানদার' })
      .expect(201);
    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(user))
      .send({ ...expense(cashId, await expenseCategory(user)), personId: person.body.id })
      .expect(201);

    const before = await netWorth(user);

    const removed = await ctx
      .http()
      .delete(`/v1/people/${person.body.id}`)
      .set(auth(user))
      .expect(200);

    expect(removed.body.transactionCount).toBe(1);
    expect(removed.body.message).toContain('কোনো লেনদেন মুছে ফেলা হয়নি');
    // The claim the message makes, measured rather than trusted.
    expect(await netWorth(user)).toBe(before);
    const remaining = await ctx.http().get('/v1/transactions').set(auth(user)).expect(200);
    expect(remaining.body.items).toHaveLength(1);
  });

  it('refuses another workspace’s person on a transaction', async () => {
    const mine = await workspaceWithCash();
    const theirs = await workspaceWithCash();
    const stranger = await ctx
      .http()
      .post('/v1/people')
      .set(auth(theirs.user))
      .send({ name: 'অন্য কেউ' })
      .expect(201);

    await ctx
      .http()
      .post('/v1/transactions')
      .set(auth(mine.user))
      .send({
        ...expense(mine.cashId, await expenseCategory(mine.user)),
        personId: stranger.body.id,
      })
      .expect(404);
  });

  it('folds two spellings of one person together without moving a poisha', async () => {
    const { user, cashId } = await workspaceWithCash();
    // The split this screen exists to repair: the same human, typed twice.
    await lend(user, cashId, 'করিম', 5_000_000);
    await lend(user, cashId, 'করিম উদ্দিন', 3_000_000);

    const rows = await list(user);
    const source = rows.find((r) => r.name === 'করিম উদ্দিন')!;
    const target = rows.find((r) => r.name === 'করিম')!;
    await ctx
      .http()
      .patch(`/v1/people/${source.id}`)
      .set(auth(user))
      .send({ phone: '01711223344' })
      .expect(200);

    const before = await netWorth(user);

    const merged = await ctx
      .http()
      .post(`/v1/people/${source.id}/merge`)
      .set(auth(user))
      .send({ intoPersonId: target.id })
      .expect(201);

    expect(merged.body.movedLoanCount).toBe(1);
    // The survivor's phone column was blank, so the disappearing one fills it.
    expect(merged.body.carriedOver).toContain('phone');

    const after = await list(user);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(target.id);
    expect(after[0]!.loanCount).toBe(2);
    expect(after[0]!.receivableMinor).toBe(8_000_000);
    expect(after[0]!.phone).toBe('01711223344');
    // A merge changes whose money it is, never how much.
    expect(await netWorth(user)).toBe(before);
  });

  it('carries the instalments with their loan and leaves the party ledger whole', async () => {
    const { user, cashId } = await workspaceWithCash();
    const loanId = await lend(user, cashId, 'করিম উদ্দিন', 5_000_000);
    await ctx
      .http()
      .post(`/v1/loans/${loanId}/payments`)
      .set(auth(user))
      .send({ date: daysAgo(1), amountMinor: 2_000_000, accountId: cashId })
      .expect(201);
    await lend(user, cashId, 'করিম', 1_000_000);

    const rows = await list(user);
    const source = rows.find((r) => r.name === 'করিম উদ্দিন')!;
    const target = rows.find((r) => r.name === 'করিম')!;

    const merged = await ctx
      .http()
      .post(`/v1/people/${source.id}/merge`)
      .set(auth(user))
      .send({ intoPersonId: target.id })
      .expect(201);

    // Nothing is rewritten for a payment — it belongs to its loan and travels
    // with it. The count is reported so the receipt is not silent about them.
    expect(merged.body.movedPaymentCount).toBe(1);

    const ledger = await ctx
      .http()
      .get(`/v1/loans/people/${target.id}/ledger`)
      .set(auth(user))
      .expect(200);
    // ৳50,000 lent less ৳20,000 repaid, plus ৳10,000 — one ledger, not two halves.
    expect(ledger.body.receivableMinor).toBe(4_000_000);
    expect(ledger.body.netPositionMinor).toBe(4_000_000);
    expect(ledger.body.loans).toHaveLength(2);
  });

  it('refuses to merge a person into themselves', async () => {
    const { user } = await workspaceWithCash();
    const person = await ctx
      .http()
      .post('/v1/people')
      .set(auth(user))
      .send({ name: 'করিম' })
      .expect(201);

    await ctx
      .http()
      .post(`/v1/people/${person.body.id}/merge`)
      .set(auth(user))
      .send({ intoPersonId: person.body.id })
      .expect(400);
  });

  it('keeps one workspace out of another workspace’s contacts', async () => {
    const mine = await workspaceWithCash();
    const theirs = await workspaceWithCash();
    await lend(mine.user, mine.cashId, 'করিম', 5_000_000);
    await lend(theirs.user, theirs.cashId, 'রহিম', 5_000_000);

    const [karim] = await list(mine.user);
    const [rahim] = await list(theirs.user);

    expect((await list(theirs.user)).map((r) => r.name)).toEqual(['রহিম']);
    await ctx.http().get(`/v1/people/${karim!.id}`).set(auth(theirs.user)).expect(404);
    await ctx
      .http()
      .patch(`/v1/people/${karim!.id}`)
      .set(auth(theirs.user))
      .send({ name: 'x' })
      .expect(404);
    await ctx.http().delete(`/v1/people/${karim!.id}`).set(auth(theirs.user)).expect(404);
    // The one that would actually move rows across the boundary.
    await ctx
      .http()
      .post(`/v1/people/${karim!.id}/merge`)
      .set(auth(theirs.user))
      .send({ intoPersonId: rahim!.id })
      .expect(404);

    expect((await list(mine.user))[0]!.receivableMinor).toBe(5_000_000);
  });

  it('records who did what to whom', async () => {
    const { user } = await workspaceWithCash();
    const person = await ctx
      .http()
      .post('/v1/people')
      .set(auth(user))
      .send({ name: 'করিম' })
      .expect(201);
    await ctx
      .http()
      .patch(`/v1/people/${person.body.id}`)
      .set(auth(user))
      .send({ relation: 'বন্ধু' })
      .expect(200);

    // Fire-and-forget by design, so the timeline is read after a beat.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const audit = await ctx.http().get('/v1/audit').set(auth(user)).expect(200);
    const actions = audit.body.items.map((row: { action: string }) => row.action);
    expect(actions).toContain('person.created');
    expect(actions).toContain('person.updated');
  });
});
