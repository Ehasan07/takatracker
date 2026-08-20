import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, createTestApp, resetDatabase, signup, type TestContext } from './harness';

/**
 * Inbound ingestion.
 *
 * The rule the whole feature rests on: **nothing a parser produces reaches the
 * ledger until a human accepts it.** Most of what follows exists to prove that,
 * and to prove the two things a forwarder app will do by accident — retry, and
 * present a wrong secret.
 */

const SMS = 'Your A/C **4521 is debited BDT 1,250.50 on 09-08-26. Avl Bal BDT 12,430.00';

describe('ingestion', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.INGESTION_WEBHOOK_SECRET ??= 'test-ingestion-secret-for-the-suite';
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  async function workspace() {
    const user = await signup(ctx);
    const cash = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'নগদ', type: 'CASH', openingBalance: 5_000_000 })
      .expect(201);
    const categories = await ctx.http().get('/v1/categories').set(auth(user)).expect(200);
    const expense = categories.body.find((c: { kind: string }) => c.kind === 'EXPENSE');
    const config = await ctx.http().get('/v1/ingestion/webhook-config').set(auth(user)).expect(200);
    return {
      user,
      cashId: cash.body.id as string,
      categoryId: expense.id as string,
      secret: config.body.secret as string,
      secretHeader: config.body.secretHeader as string,
      workspaceHeader: config.body.workspaceHeader as string,
    };
  }

  type Ws = Awaited<ReturnType<typeof workspace>>;
  /* The envelope is JSON — the forwarder names its channel and itself — but
   * `body` is the message exactly as it arrived. Nothing is cleaned on the way
   * in: a parser that gets something wrong can only be fixed against the text
   * that broke it. */
  const post = (ws: Ws, body = SMS, secret = ws.secret) =>
    ctx
      .http()
      .post('/v1/ingestion/webhook')
      .set(ws.workspaceHeader, ws.user.workspaceId)
      .set(ws.secretHeader, secret)
      .send({ channel: 'SMS', sender: 'BRAC-BANK', body });

  it('takes the whole thing in the body, for a forwarder that cannot set headers', async () => {
    /* The shape an iOS Shortcut builds without ever opening the header sheet:
       one URL, no headers, five JSON fields. The header editor there is a list
       of unlabelled rows and the first attempt at this had the workspace id
       typed in as a header *name* — which is a 401 with nothing on screen to
       explain it. */
    const ws = await workspace();
    const res = await ctx
      .http()
      .post('/v1/ingestion/webhook')
      .send({
        workspace: ws.user.workspaceId,
        secret: ws.secret,
        source: 'sms',
        from: 'BRAC-BANK',
        message: SMS,
      })
      .expect(200);

    expect(res.body.draftId).toBeTruthy();

    /* The credentials are not part of the message. `ingest` reads four fields
       and these are not among them, but a regression there would write
       somebody's secret into a row the review screen prints. */
    const drafts = await ctx.http().get('/v1/ingestion/drafts').set(auth(ws.user)).expect(200);
    const stored = JSON.stringify(drafts.body);
    expect(stored).not.toContain(ws.secret);
    expect(stored).toContain('BRAC-BANK');
  });

  it('reads the message under whichever name the forwarder uses', async () => {
    const ws = await workspace();
    /* `text` rather than `message` or `body`, and no channel at all. */
    await ctx
      .http()
      .post('/v1/ingestion/webhook')
      .send({ workspace: ws.user.workspaceId, secret: ws.secret, text: SMS })
      .expect(200);

    const drafts = await ctx.http().get('/v1/ingestion/drafts').set(auth(ws.user)).expect(200);
    expect(drafts.body.items).toHaveLength(1);
  });

  it('still refuses a body that carries the wrong secret', async () => {
    const ws = await workspace();
    await ctx
      .http()
      .post('/v1/ingestion/webhook')
      .send({ workspace: ws.user.workspaceId, secret: 'not-the-secret', message: SMS })
      .expect(401);

    /* And one with no credentials at all, which is what the open internet
       sends. */
    await ctx.http().post('/v1/ingestion/webhook').send({ message: SMS }).expect(401);
  });

  it('lets a header beat a body field, so a wrong field cannot downgrade a right header', async () => {
    const ws = await workspace();
    await ctx
      .http()
      .post('/v1/ingestion/webhook')
      .set(ws.workspaceHeader, ws.user.workspaceId)
      .set(ws.secretHeader, ws.secret)
      .send({ workspace: 'someone-else', secret: 'rubbish', message: SMS })
      .expect(200);
  });

  it('says what to fix when the message arrives empty', async () => {
    /* The commonest failure by a distance: a Message automation run by hand has
       no incoming message, so the variable is handed over empty and the whole
       request is otherwise perfect. The refusal has to name the field to fill,
       because the person reading it is standing in Shortcuts, not in the
       schema. */
    const ws = await workspace();
    const res = await ctx
      .http()
      .post('/v1/ingestion/webhook')
      .set(ws.workspaceHeader, ws.user.workspaceId)
      .set(ws.secretHeader, ws.secret)
      .send({ channel: 'SMS', sender: 'BRAC-BANK', body: '' })
      .expect(400);

    expect(JSON.stringify(res.body)).toContain('body ঘরে বার্তার ভেরিয়েবলটি বসান');
  });

  it('hands a trusted forwarder its dropdown options, and no balances', async () => {
    /* The owner runs an SMS console outside this app. It needs two lists to
       fill in "which account, which category" — and nothing else. An endpoint
       that returned balances would be handing over the ledger to fill in a
       dropdown, and it would do so the day its credential leaked. */
    const ws = await workspace();
    const res = await ctx
      .http()
      .get('/v1/ingestion/options')
      .set(ws.workspaceHeader, ws.user.workspaceId)
      .set(ws.secretHeader, ws.secret)
      .expect(200);

    expect(res.body.accounts.length).toBeGreaterThan(0);
    expect(res.body.categories.length).toBeGreaterThan(0);
    expect(res.body.accounts[0]).toHaveProperty('name');
    expect(JSON.stringify(res.body)).not.toContain('balance');
    expect(JSON.stringify(res.body)).not.toContain('openingBalance');

    /* The five nominal accounts stay out, the way they stay off the wallet:
       nobody files a grocery bill against SYSTEM_EXPENSE. */
    expect(JSON.stringify(res.body.accounts)).not.toContain('SYSTEM');
  });

  it('refuses the options to a caller with the wrong secret', async () => {
    const ws = await workspace();
    await ctx
      .http()
      .get('/v1/ingestion/options')
      .set(ws.workspaceHeader, ws.user.workspaceId)
      .set(ws.secretHeader, 'not-the-secret')
      .expect(401);
    await ctx.http().get('/v1/ingestion/options').expect(401);
  });

  it('takes a completed entry and writes it the way the app writes one', async () => {
    /* The console asks the person for the category and the account, so the
       review has already happened by the time this arrives — which is the
       difference between this and the webhook. It still goes through
       `TransactionsService.create`, so the ownership checks, the meter, the
       double entry and the audit row are the same ones the entry sheet uses. */
    const ws = await workspace();
    const options = await ctx
      .http()
      .get('/v1/ingestion/options')
      .set(ws.workspaceHeader, ws.user.workspaceId)
      .set(ws.secretHeader, ws.secret)
      .expect(200);

    const expense = options.body.categories.find((c: { kind: string }) => c.kind === 'EXPENSE');

    const created = await ctx
      .http()
      .post('/v1/ingestion/entries')
      .set(ws.workspaceHeader, ws.user.workspaceId)
      .set(ws.secretHeader, ws.secret)
      .send({
        date: '2026-08-15',
        amountMinor: 50_000,
        direction: 'OUT',
        accountId: ws.cashId,
        categoryId: expense.id,
        description: 'কনসোল থেকে',
      })
      .expect(201);

    expect(created.body.transactionId).toBeTruthy();

    /* In the ledger, balanced, and visible to the owner's own screens. */
    const entries = await ctx.prisma.ledgerEntry.findMany({
      where: { transactionId: created.body.transactionId },
      select: { direction: true, amountMinor: true },
    });
    expect(entries).toHaveLength(2);
    const debits = entries.filter((e) => e.direction === 'DEBIT');
    const credits = entries.filter((e) => e.direction === 'CREDIT');
    expect(Number(debits[0]?.amountMinor)).toBe(Number(credits[0]?.amountMinor));
  });

  it('writes a transfer as a transfer, with no category and no effect on the totals', async () => {
    /* The forwarder's own console has a "নিজের অ্যাকাউন্টে" case: money moved
       from the bank to bKash is neither income nor expense, and filing it as
       either inflates both totals — the exact mistake the tutorial page spends
       a paragraph on. */
    const ws = await workspace();
    const bank = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(ws.user))
      .send({ name: 'ব্যাংক', type: 'BANK', openingBalance: 10_000_000 })
      .expect(201);

    const created = await ctx
      .http()
      .post('/v1/ingestion/entries')
      .set(ws.workspaceHeader, ws.user.workspaceId)
      .set(ws.secretHeader, ws.secret)
      .send({
        date: '2026-08-15',
        amountMinor: 200_000,
        direction: 'TRANSFER',
        accountId: bank.body.id,
        toAccountId: ws.cashId,
        description: 'ব্যাংক থেকে নগদে',
      })
      .expect(201);

    const transaction = await ctx.prisma.transaction.findFirstOrThrow({
      where: { id: created.body.transactionId },
      include: { entries: { select: { accountId: true, direction: true, categoryId: true } } },
    });
    expect(transaction.type).toBe('TRANSFER');
    /* Both legs are real accounts — neither is the nominal income or expense
       account, which is what would make it show up in a report. */
    expect(transaction.entries.map((e) => e.accountId).sort()).toEqual(
      [bank.body.id, ws.cashId].sort(),
    );
    expect(transaction.entries.every((e) => e.categoryId === null)).toBe(true);

    const accounts = await ctx.http().get('/v1/accounts').set(auth(ws.user)).expect(200);
    const balances = accounts.body as { id: string; balanceMinor: number }[];
    expect(balances.find((a) => a.id === bank.body.id)?.balanceMinor).toBe(10_000_000 - 200_000);
    expect(balances.find((a) => a.id === ws.cashId)?.balanceMinor).toBe(5_000_000 + 200_000);
  });

  it('refuses a transfer with nowhere to go, and a spend with no category', async () => {
    /* Both are the same class of error — a half-filled console form — and both
       have to be refused rather than guessed at, because a transfer written
       against one account is not a transfer at all. */
    const ws = await workspace();
    const send = (body: Record<string, unknown>) =>
      ctx
        .http()
        .post('/v1/ingestion/entries')
        .set(ws.workspaceHeader, ws.user.workspaceId)
        .set(ws.secretHeader, ws.secret)
        .send({ date: '2026-08-15', amountMinor: 50_000, accountId: ws.cashId, ...body });

    await send({ direction: 'TRANSFER' }).expect(400);
    await send({ direction: 'OUT' }).expect(400);
  });

  it('will not write an entry into a workspace whose secret it does not hold', async () => {
    const mine = await workspace();
    const stranger = await workspace();

    await ctx
      .http()
      .post('/v1/ingestion/entries')
      .set(mine.workspaceHeader, stranger.user.workspaceId)
      .set(mine.secretHeader, mine.secret)
      .send({
        date: '2026-08-15',
        amountMinor: 50_000,
        direction: 'OUT',
        accountId: stranger.cashId,
        categoryId: stranger.categoryId,
      })
      .expect(401);
  });

  it('turns a bank SMS into a draft, and only a draft', async () => {
    const ws = await workspace();
    const res = await post(ws).expect(200);
    expect(res.body.duplicate).toBe(false);
    expect(res.body.draftId).toBeTruthy();

    const drafts = await ctx.http().get('/v1/ingestion/drafts').set(auth(ws.user)).expect(200);
    expect(drafts.body.items).toHaveLength(1);
    const draft = drafts.body.items[0];
    expect(draft.status).toBe('PENDING');
    expect(draft.amountMinor).toBe(125_050);
    expect(draft.direction).toBe('OUT');

    // Nothing has touched the books.
    const accounts = await ctx.http().get('/v1/accounts').set(auth(ws.user)).expect(200);
    expect(accounts.body.find((a: { id: string }) => a.id === ws.cashId).balanceMinor).toBe(
      5_000_000,
    );
  });

  it('shows which words each figure was read from', async () => {
    // A draft nobody can check is a draft nobody should accept.
    const ws = await workspace();
    await post(ws).expect(200);
    const drafts = await ctx.http().get('/v1/ingestion/drafts').set(auth(ws.user)).expect(200);
    const draft = drafts.body.items[0];

    expect(Object.keys(draft.evidence).length).toBeGreaterThan(0);
    for (const span of Object.values(draft.evidence) as string[]) {
      expect(draft.message.body).toContain(span);
    }
  });

  it('treats a retried delivery as the same message', async () => {
    // A forwarder that retries must not double anybody's books.
    const ws = await workspace();
    const first = await post(ws).expect(200);
    const retry = await post(ws).expect(200);

    expect(retry.body.duplicate).toBe(true);
    expect(retry.body.id).toBe(first.body.id);

    const drafts = await ctx.http().get('/v1/ingestion/drafts').set(auth(ws.user)).expect(200);
    expect(drafts.body.items).toHaveLength(1);
  });

  it('still recognises the message when whitespace and case differ', async () => {
    const ws = await workspace();
    await post(ws).expect(200);
    const noisy = await post(ws, `  ${SMS.toUpperCase().replace(/ /g, '  ')}  `).expect(200);
    expect(noisy.body.duplicate).toBe(true);
  });

  it('refuses a wrong secret, and says nothing about the workspace', async () => {
    const ws = await workspace();
    const bad = await post(ws, SMS, 'not-the-secret');
    expect(bad.status).toBe(401);

    const invented = await ctx
      .http()
      .post('/v1/ingestion/webhook')
      .set(ws.workspaceHeader, 'clzzzzzzzzzzzzzzzzzzzzzzz')
      .set(ws.secretHeader, 'not-the-secret')
      .send({ channel: 'SMS', sender: 'BRAC-BANK', body: SMS });
    // Identical answer for a real workspace and an invented one: the endpoint
    // must not tell an attacker which ids exist.
    expect(invented.status).toBe(401);
    expect(invented.body.message).toEqual(bad.body.message);
  });

  it('will not accept one workspace s secret for another workspace', async () => {
    const mine = await workspace();
    const other = await workspace();
    const res = await ctx
      .http()
      .post('/v1/ingestion/webhook')
      .set(mine.workspaceHeader, other.user.workspaceId)
      .set(mine.secretHeader, mine.secret)
      .send({ channel: 'SMS', sender: 'BRAC-BANK', body: SMS });
    expect(res.status).toBe(401);
  });

  it('books the transaction only when a person accepts it', async () => {
    const ws = await workspace();
    const received = await post(ws).expect(200);

    const accepted = await ctx
      .http()
      .post(`/v1/ingestion/drafts/${received.body.draftId as string}/accept`)
      .set(auth(ws.user))
      .send({ accountId: ws.cashId, categoryId: ws.categoryId })
      .expect(200);
    expect(accepted.body.status).toBe('ACCEPTED');
    expect(accepted.body.transactionId).toBeTruthy();

    const accounts = await ctx.http().get('/v1/accounts').set(auth(ws.user)).expect(200);
    expect(accounts.body.find((a: { id: string }) => a.id === ws.cashId).balanceMinor).toBe(
      5_000_000 - 125_050,
    );
  });

  /**
   * The half a bank message can never see.
   *
   * "১০,০০০ জমা হয়েছে" in a DPS is true and useless on its own: it says the
   * money arrived and cannot say it left a bKash wallet ten seconds earlier.
   * Accepted as income it invents ৳10,000 of earnings a month — the exact
   * defect this ledger carried ৳66,98,616 of before it was found — so the
   * reviewer has to be able to name the other side, and naming it must move
   * money between the two accounts rather than conjure it.
   */
  it('books a transfer when the reviewer names the other account', async () => {
    const ws = await workspace();
    const dps = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(ws.user))
      .send({ name: 'ডিপিএস', type: 'SAVINGS' })
      .expect(201);
    const received = await post(ws).expect(200);

    const accepted = await ctx
      .http()
      .post(`/v1/ingestion/drafts/${received.body.draftId as string}/accept`)
      .set(auth(ws.user))
      // No categoryId at all: a transfer has no খাত to be filed under.
      .send({ accountId: ws.cashId, counterAccountId: dps.body.id as string })
      .expect(200);
    expect(accepted.body.status).toBe('ACCEPTED');

    const transaction = await ctx
      .http()
      .get(`/v1/transactions/${accepted.body.transactionId as string}`)
      .set(auth(ws.user))
      .expect(200);
    expect(transaction.body.type).toBe('TRANSFER');

    /* The message read OUT, so the account it was about pays and the one the
       reviewer named receives. Both balances move by the same ৳1,250.50 and
       nothing reaches an income or expense nominal. */
    const accounts = await ctx.http().get('/v1/accounts').set(auth(ws.user)).expect(200);
    const byId = (id: string) => accounts.body.find((a: { id: string }) => a.id === id);
    expect(byId(ws.cashId).balanceMinor).toBe(5_000_000 - 125_050);
    expect(byId(dps.body.id as string).balanceMinor).toBe(125_050);

    const statement = await ctx
      .http()
      .get('/v1/reports/income-statement?from=2020-01-01&to=2030-12-31')
      .set(auth(ws.user))
      .expect(200);
    expect(statement.body.incomeMinor).toBe(0);
    expect(statement.body.expenseMinor).toBe(0);
  });

  /**
   * The schedule and the ledger are two records of one fact.
   *
   * Accepting the instalment's own SMS moved ৳10,000 into the DPS. If the
   * schedule does not hear about it the saver sees the transfer in the khata
   * *and* an instalment still asking to be paid — and the button that answers
   * it moves the money a second time.
   */
  it('ticks the instalment a transfer into a linked plan pays', async () => {
    const ws = await workspace();
    const dps = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(ws.user))
      .send({ name: 'ডিপিএস', type: 'SAVINGS' })
      .expect(201);
    const plan = await ctx
      .http()
      .post('/v1/savings')
      .set(auth(ws.user))
      .send({
        planName: 'ইসলামী ডিপিএস',
        installmentMinor: 125_050,
        termMonths: 12,
        startDate: '2026-08-09',
        linkedAccountId: dps.body.id as string,
      })
      .expect(201);

    const received = await post(ws).expect(200);
    await ctx
      .http()
      .post(`/v1/ingestion/drafts/${received.body.draftId as string}/accept`)
      .set(auth(ws.user))
      .send({ accountId: ws.cashId, counterAccountId: dps.body.id as string })
      .expect(200);

    const detail = await ctx
      .http()
      .get(`/v1/savings/${plan.body.id as string}`)
      .set(auth(ws.user))
      .expect(200);
    const paid = detail.body.installments.filter((i: { status: string }) => i.status === 'PAID');
    expect(paid).toHaveLength(1);
    expect(paid[0].transactionId).toBeTruthy();
  });

  /* A top-up is not an instalment. Claiming one on any amount that happened to
     arrive would mark a schedule paid that is not. */
  it('leaves the schedule alone when the amount is not the instalment', async () => {
    const ws = await workspace();
    const dps = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(ws.user))
      .send({ name: 'ডিপিএস', type: 'SAVINGS' })
      .expect(201);
    const plan = await ctx
      .http()
      .post('/v1/savings')
      .set(auth(ws.user))
      .send({
        planName: 'ইসলামী ডিপিএস',
        installmentMinor: 200_000,
        termMonths: 12,
        startDate: '2026-08-09',
        linkedAccountId: dps.body.id as string,
      })
      .expect(201);

    const received = await post(ws).expect(200);
    await ctx
      .http()
      .post(`/v1/ingestion/drafts/${received.body.draftId as string}/accept`)
      .set(auth(ws.user))
      .send({ accountId: ws.cashId, counterAccountId: dps.body.id as string })
      .expect(200);

    const detail = await ctx
      .http()
      .get(`/v1/savings/${plan.body.id as string}`)
      .set(auth(ws.user))
      .expect(200);
    expect(detail.body.installments.every((i: { status: string }) => i.status !== 'PAID')).toBe(
      true,
    );
  });

  it('refuses to send money to the account it came from', async () => {
    const ws = await workspace();
    const received = await post(ws).expect(200);
    await ctx
      .http()
      .post(`/v1/ingestion/drafts/${received.body.draftId as string}/accept`)
      .set(auth(ws.user))
      .send({ accountId: ws.cashId, counterAccountId: ws.cashId })
      .expect(400);
  });

  it('refuses to apply the same draft twice', async () => {
    const ws = await workspace();
    const received = await post(ws).expect(200);
    const accept = () =>
      ctx
        .http()
        .post(`/v1/ingestion/drafts/${received.body.draftId as string}/accept`)
        .set(auth(ws.user))
        .send({ accountId: ws.cashId, categoryId: ws.categoryId });

    await accept().expect(200);
    const twice = await accept();
    expect(twice.status).toBe(400);

    /* The account's own opening balance is a transaction now, and it is not
       what this test is counting. Excluded by type rather than by subtracting
       one, so the assertion still fails if the second accept writes anything at
       all. */
    const txns = await ctx.prisma.transaction.count({
      where: {
        workspaceId: ws.user.workspaceId,
        deletedAt: null,
        type: { not: 'OPENING_BALANCE' },
      },
    });
    expect(txns).toBe(1);
  });

  it('honours a correction made while reviewing', async () => {
    // The parser is a suggestion. What the human types wins.
    const ws = await workspace();
    const received = await post(ws).expect(200);

    const accepted = await ctx
      .http()
      .post(`/v1/ingestion/drafts/${received.body.draftId as string}/accept`)
      .set(auth(ws.user))
      .send({
        accountId: ws.cashId,
        categoryId: ws.categoryId,
        amountMinor: 130_000,
        payee: 'সঠিক দোকান',
      })
      .expect(200);
    expect(accepted.body.amountMinor).toBe(130_000);

    const accounts = await ctx.http().get('/v1/accounts').set(auth(ws.user)).expect(200);
    expect(accounts.body.find((a: { id: string }) => a.id === ws.cashId).balanceMinor).toBe(
      5_000_000 - 130_000,
    );
  });

  it('writes nothing when a draft is rejected', async () => {
    const ws = await workspace();
    const received = await post(ws).expect(200);

    const rejected = await ctx
      .http()
      .post(`/v1/ingestion/drafts/${received.body.draftId as string}/reject`)
      .set(auth(ws.user))
      .send({})
      .expect(200);
    expect(rejected.body.status).toBe('REJECTED');

    // Everything except the opening balance the fixture's নগদ account was
    // created with, which is a ledger transaction of its own now.
    expect(
      await ctx.prisma.transaction.count({
        where: { workspaceId: ws.user.workspaceId, type: { not: 'OPENING_BALANCE' } },
      }),
    ).toBe(0);
  });

  it('keeps a money message it cannot read, rather than inventing an amount', async () => {
    const ws = await workspace();
    /* About money — it says BDT — and unreadable: no figure anywhere. The draft
       has to exist, because a message that vanished could never be looked at,
       and it has to claim nothing. */
    const received = await post(
      ws,
      'Dear customer, your BDT statement is ready. Thank you.',
    ).expect(200);

    const drafts = await ctx.http().get('/v1/ingestion/drafts').set(auth(ws.user)).expect(200);
    const draft = drafts.body.items.find(
      (d: { id: string }) => d.id === (received.body.draftId as string),
    );
    expect(draft.amountMinor).toBeNull();
    expect(draft.confidence).toBe(0);
    expect(draft.needsReview).toBe(true);
  });

  it('raises no decision for a message with no figure and no currency in it', async () => {
    /* The rule is deliberately wide — a currency marker or any digit — so what
       is left out is prose and only prose. It was narrower once and the first
       real test broke it: `500 taka twst` raised nothing, because the rule knew
       how banks write about money and not how people do. */
    const ws = await workspace();
    const received = await post(ws, 'আমি বাসায় পৌঁছে গেছি, চিন্তা করো না').expect(200);

    expect(received.body.draftId).toBeNull();

    const drafts = await ctx.http().get('/v1/ingestion/drafts').set(auth(ws.user)).expect(200);
    expect(drafts.body.items).toHaveLength(0);

    /* Stored, and the customer can see it — under everything their phone sent,
       which is a different screen from the queue of decisions. */
    const messages = await ctx.http().get('/v1/ingestion/messages').set(auth(ws.user)).expect(200);
    expect(messages.body.items).toHaveLength(1);
    expect(messages.body.items[0].body).toContain('বাসায়');
    expect(messages.body.items[0].draftId).toBeNull();
  });

  it('raises no decision for a bank advertising at you', async () => {
    /* A real CityTouch promotion. Four amounts in it — ২, ১৫০০, ৫০, ১০০ — and
       not one of them a transaction, so whichever a parser picked was wrong and
       the person was left dismissing a draft for money that never moved. Kept,
       like everything else, and simply not asked about. */
    const ws = await workspace();
    const advert =
      'সিটিটাচ থেকে যেকোন বিকাশ নম্বরে ২টাকা বার ১৫০০ টাকা অ্যাড মানি করলেই পাবেন ৫০ টাকা বোনাস ও স্বপ্ন-এর ১০০ টাকার কুপন।শুধুমাত্র আজকের জন্য।';

    const received = await post(ws, advert).expect(200);
    expect(received.body.draftId).toBeNull();

    const messages = await ctx.http().get('/v1/ingestion/messages').set(auth(ws.user)).expect(200);
    expect(messages.body.items).toHaveLength(1);
    expect(messages.body.items[0].draftId).toBeNull();
  });

  it('still raises one for a cashback that actually landed', async () => {
    /* The same vocabulary, reporting rather than offering — and it carries the
       thing an advert never has: a balance. Rejecting this would be the rule
       eating real money. */
    const ws = await workspace();
    const real = await post(
      ws,
      'BDT 100.00 cashback credited. Avl Bal: BDT 5,300.00. For query: 16419',
    ).expect(200);
    expect(real.body.draftId).toBeTruthy();
  });

  it('does raise one for a code, because a digit is enough — by design', async () => {
    /* Not an oversight. A one-time code dismissed in a tap is a smaller loss
       than a bank format nobody anticipated that never reaches the books, and
       the owner chose that trade knowing the queue would fill. Pinned here so
       the behaviour reads as a decision rather than a bug. */
    const ws = await workspace();
    const received = await post(ws, 'Your one-time code is 847213. Do not share it.').expect(200);
    expect(received.body.draftId).toBeTruthy();
  });

  it('does not charge the monthly ceiling for a message that raised no decision', async () => {
    /* The customer pays for what this product does with their messages. A
       message it did nothing with is not that. With the rule as wide as it now
       is, "did nothing with" means prose — and a workspace at its ceiling can
       still receive it. */
    const ws = await workspace();
    await ctx.prisma.workspaceFeatureOverride.upsert({
      where: {
        workspaceId_featureKey: {
          workspaceId: ws.user.workspaceId,
          featureKey: 'ingest.messages.monthly.max',
        },
      },
      create: {
        workspaceId: ws.user.workspaceId,
        featureKey: 'ingest.messages.monthly.max',
        limitValue: 1,
      },
      update: { limitValue: 1 },
    });

    // The one that counts, against a ceiling of one.
    const real = await post(ws, 'Your A/C is debited BDT 500.00 today').expect(200);
    expect(real.body.draftId).toBeTruthy();

    // And three that do not, arriving after the ceiling is already spent.
    await post(ws, 'কাজ শেষ, বাসায় ফিরছি').expect(200);
    await post(ws, 'Call me when you are free').expect(200);
    await post(ws, 'Thank you for shopping with us').expect(200);

    const messages = await ctx.http().get('/v1/ingestion/messages').set(auth(ws.user)).expect(200);
    expect(messages.body.items).toHaveLength(4);
  });

  /**
   * The dollar charge that was about to be filed as ৳4.60.
   *
   * Measured on the owner's own inbox, and reproduced here byte for byte. Every
   * assertion below is about one number: 460 is *cents*, and the taka figure is
   * the one thing this pipeline is not allowed to invent.
   */
  describe('a message that was not in taka', () => {
    const OPENAI =
      'USD 4.6 transacted at OPENAI *CHATGPT SUBSCR on 16/08/26 [10:33:37 PM BST] ' +
      'using Card#***0492. Available balance: USD 538.24. Helpline 16221.';

    const draftFrom = async (ws: Ws, body: string) => {
      const received = await post(ws, body).expect(200);
      const drafts = await ctx.http().get('/v1/ingestion/drafts').set(auth(ws.user)).expect(200);
      return drafts.body.items.find(
        (d: { id: string }) => d.id === (received.body.draftId as string),
      );
    };

    it('records the dollars and refuses to guess the taka', async () => {
      const ws = await workspace();
      const draft = await draftFrom(ws, OPENAI);

      expect(draft.fxCurrency).toBe('USD');
      // Cents, because a dollar has a hundred of them — not poisha.
      expect(draft.fxAmountMinor).toBe(460);
      /* The whole bug in one assertion. 460 here would be ৳4.60 for a charge of
         about ৳560, and it is what the screen used to offer. */
      expect(draft.amountMinor).toBeNull();
      // Never a one-tap accept: the figure the ledger needs is not in the text.
      expect(draft.needsReview).toBe(true);
    });

    it('quotes the code with the figure, so the screen can show its working', async () => {
      const ws = await workspace();
      const draft = await draftFrom(ws, OPENAI);

      expect(draft.evidence.fxAmountMinor).toBe('USD 4.6');
      /* And not under the taka name. A quotation there would have the review
         screen print "4.6" beside an empty box under a quotation mark. */
      expect(draft.evidence.amountMinor).toBeUndefined();
      expect(draft.message.body).toContain(draft.evidence.fxAmountMinor);
    });

    it('will not be accepted until somebody says what it cost in taka', async () => {
      const ws = await workspace();
      const draft = await draftFrom(ws, OPENAI);

      const refused = await ctx
        .http()
        .post(`/v1/ingestion/drafts/${draft.id as string}/accept`)
        .set(auth(ws.user))
        .send({ accountId: ws.cashId, categoryId: ws.categoryId, direction: 'OUT' })
        .expect(400);
      expect(refused.body.message).toContain('USD');

      // Nothing reached the books on the way past.
      const accounts = await ctx.http().get('/v1/accounts').set(auth(ws.user)).expect(200);
      expect(accounts.body.find((a: { id: string }) => a.id === ws.cashId).balanceMinor).toBe(
        5_000_000,
      );
    });

    it('writes the taka the reviewer declared, with the dollars beside it', async () => {
      const ws = await workspace();
      const draft = await draftFrom(ws, OPENAI);

      /* ৳561.20 at a rate of 122 — the reviewer's own figure, read off their
         card app. Nothing here computed it and nothing here checked it against
         a feed: the rate that applied is the issuer's, not the mid-market. */
      const accepted = await ctx
        .http()
        .post(`/v1/ingestion/drafts/${draft.id as string}/accept`)
        .set(auth(ws.user))
        .send({
          accountId: ws.cashId,
          categoryId: ws.categoryId,
          direction: 'OUT',
          amountMinor: 56_120,
        })
        .expect(200);

      const txn = await ctx.prisma.transaction.findFirstOrThrow({
        where: { id: accepted.body.transactionId as string },
      });
      expect(txn.fxCurrency).toBe('USD');
      expect(Number(txn.fxAmountMinor)).toBe(460);

      const entries = await ctx.prisma.ledgerEntry.findMany({
        where: { transactionId: txn.id },
        select: { amountMinor: true },
      });
      // Both legs in taka, at the declared figure — never at 460 poisha.
      expect(entries.map((e) => Number(e.amountMinor))).toEqual([56_120, 56_120]);

      /* The rate is the ratio of the two stored integers, exactly, and is the
         reason no fractional number was ever written anywhere. */
      expect(56_120 / Number(txn.fxAmountMinor)).toBe(122);

      const accounts = await ctx.http().get('/v1/accounts').set(auth(ws.user)).expect(200);
      expect(accounts.body.find((a: { id: string }) => a.id === ws.cashId).balanceMinor).toBe(
        5_000_000 - 56_120,
      );
    });

    it('leaves an ordinary taka alert exactly as it was', async () => {
      const ws = await workspace();
      const draft = await draftFrom(ws, SMS);

      expect(draft.fxCurrency).toBeNull();
      expect(draft.fxAmountMinor).toBeNull();
      expect(draft.amountMinor).toBe(125_050);
    });

    it('does not take a three-letter reference for a currency', async () => {
      /* SAR is a real ISO code and this is a reference number. Reading it would
         relabel five thousand taka as five thousand Saudi riyals. */
      const ws = await workspace();
      const draft = await draftFrom(
        ws,
        'Your A/C **4521 has been credited BDT 5,000.00 on 09-08-26. Ref SAR 12345',
      );

      expect(draft.fxCurrency).toBeNull();
      expect(draft.amountMinor).toBe(500_000);
    });

    it('re-reads a draft written before the columns existed', async () => {
      /* The 47 drafts already in the owner's queue when this shipped were parsed
         by code that could not see a currency: their `fxCurrency` is null and
         their `amountMinor` holds the dollar figure under a taka name. The raw
         message is kept for exactly this kind of correction, so it is read
         again rather than left to be accepted wrongly. Simulated by putting the
         row back the way the old parser left it. */
      const ws = await workspace();
      const draft = await draftFrom(ws, OPENAI);

      await ctx.prisma.transactionDraft.update({
        where: { id: draft.id as string },
        data: {
          fxCurrency: null,
          fxAmountMinor: null,
          amountMinor: 460n,
          confidence: 85,
          evidence: { amountMinor: '4.6', date: '16/08/26' },
        },
      });

      const drafts = await ctx.http().get('/v1/ingestion/drafts').set(auth(ws.user)).expect(200);
      const legacy = drafts.body.items.find((d: { id: string }) => d.id === (draft.id as string));

      expect(legacy.fxCurrency).toBe('USD');
      expect(legacy.fxAmountMinor).toBe(460);
      // The stored 460 is a dollar figure wearing a taka name. Not repeated.
      expect(legacy.amountMinor).toBeNull();
      expect(legacy.needsReview).toBe(true);

      /* And the accept path reads it the same way, so the screen and the ledger
         cannot disagree about the same row. */
      const accepted = await ctx
        .http()
        .post(`/v1/ingestion/drafts/${draft.id as string}/accept`)
        .set(auth(ws.user))
        .send({
          accountId: ws.cashId,
          categoryId: ws.categoryId,
          direction: 'OUT',
          amountMinor: 56_120,
        })
        .expect(200);

      const txn = await ctx.prisma.transaction.findFirstOrThrow({
        where: { id: accepted.body.transactionId as string },
      });
      expect(txn.fxCurrency).toBe('USD');
      expect(Number(txn.fxAmountMinor)).toBe(460);
    });

    it('lets a reviewer say it was not another currency after all', async () => {
      const ws = await workspace();
      const draft = await draftFrom(ws, OPENAI);

      const accepted = await ctx
        .http()
        .post(`/v1/ingestion/drafts/${draft.id as string}/accept`)
        .set(auth(ws.user))
        .send({
          accountId: ws.cashId,
          categoryId: ws.categoryId,
          direction: 'OUT',
          amountMinor: 46_000,
          fxCurrency: null,
          fxAmountMinor: null,
        })
        .expect(200);

      const txn = await ctx.prisma.transaction.findFirstOrThrow({
        where: { id: accepted.body.transactionId as string },
      });
      expect(txn.fxCurrency).toBeNull();
      expect(txn.fxAmountMinor).toBeNull();
    });

    it('refuses half a pair, whichever half is missing', async () => {
      const ws = await workspace();
      const draft = await draftFrom(ws, OPENAI);

      await ctx
        .http()
        .post(`/v1/ingestion/drafts/${draft.id as string}/accept`)
        .set(auth(ws.user))
        .send({
          accountId: ws.cashId,
          categoryId: ws.categoryId,
          direction: 'OUT',
          amountMinor: 56_120,
          fxCurrency: null,
        })
        .expect(400);

      // And a currency this build has never heard of is refused at the door.
      await ctx
        .http()
        .post(`/v1/ingestion/drafts/${draft.id as string}/accept`)
        .set(auth(ws.user))
        .send({
          accountId: ws.cashId,
          categoryId: ws.categoryId,
          direction: 'OUT',
          amountMinor: 56_120,
          fxCurrency: 'ZZZ',
          fxAmountMinor: 460,
        })
        .expect(400);
    });
  });

  it('never shows one workspace another s drafts', async () => {
    const mine = await workspace();
    const received = await post(mine).expect(200);
    const stranger = await signup(ctx);

    await ctx
      .http()
      .get(`/v1/ingestion/messages/${received.body.id as string}`)
      .set(auth(stranger))
      .expect(404);
    await ctx
      .http()
      .post(`/v1/ingestion/drafts/${received.body.draftId as string}/reject`)
      .set(auth(stranger))
      .send({})
      .expect(404);

    const theirs = await ctx.http().get('/v1/ingestion/drafts').set(auth(stranger)).expect(200);
    expect(theirs.body.items).toHaveLength(0);
  });

  /**
   * Which account the message was about.
   *
   * The parsers have always read `A/C (***6948)` out of the text and the
   * accounts screen has always had a box to type it into. Nothing compared the
   * two, so the review sheet opened with an empty picker on every single
   * message — including for an owner who had filled that box in.
   */
  describe('the account the message names', () => {
    const UCB =
      'Your A/C (***6948) has been debited BDT 4,000.00 for I Banking EFTN Transfer Debit Retail. Avl Bal: BDT 8,85,340.17 @ 08:24 AM. For query: 16419';

    const account = (ws: Ws, body: Record<string, unknown>) =>
      ctx.http().post('/v1/accounts').set(auth(ws.user)).send(body).expect(201);

    const drafts = async (ws: Ws) =>
      (await ctx.http().get('/v1/ingestion/drafts').set(auth(ws.user)).expect(200)).body.items as {
        id: string;
        accountId: string | null;
      }[];

    it('picks the account whose number the message quotes', async () => {
      const ws = await workspace();
      const ucb = await account(ws, {
        name: 'UCB Current',
        type: 'BANK',
        accountNumberMasked: '****6948',
      });

      const received = await post(ws, UCB).expect(200);
      const draft = (await drafts(ws)).find((d) => d.id === received.body.draftId);
      expect(draft?.accountId).toBe(ucb.body.id);
    });

    it('matches a hint the owner typed with the punctuation still in it', async () => {
      /* What a person actually types into "মেলানোর সংকেত" is the fragment they
         can see in the message, brackets and stars and all. Anything that only
         matched bare digits would leave them looking at a box they had already
         filled in correctly. */
      const ws = await workspace();
      const ucb = await account(ws, {
        name: 'UCB Current',
        type: 'BANK',
        matchHints: ['A/C (***6948)'],
      });

      const received = await post(ws, UCB).expect(200);
      const draft = (await drafts(ws)).find((d) => d.id === received.body.draftId);
      expect(draft?.accountId).toBe(ucb.body.id);
    });

    it('fills in drafts that arrived before the hint was ever typed', async () => {
      /* The queue is fifty messages deep by the time somebody works out where
         the setting is. A hint added now has to light up what is already
         waiting, not only the next message to arrive. */
      const ws = await workspace();
      const received = await post(ws, UCB).expect(200);
      expect((await drafts(ws)).find((d) => d.id === received.body.draftId)?.accountId).toBeNull();

      const ucb = await account(ws, { name: 'UCB Current', type: 'BANK' });
      await ctx
        .http()
        .patch(`/v1/accounts/${ucb.body.id as string}`)
        .set(auth(ws.user))
        .send({ matchHints: ['6948'] })
        .expect(200);

      const draft = (await drafts(ws)).find((d) => d.id === received.body.draftId);
      expect(draft?.accountId).toBe(ucb.body.id);
    });

    it('leaves the picker empty when two accounts fit equally well', async () => {
      /* A wrong account costs a ledger entry against the wrong balance, and
         nobody re-checks a field the app filled in for them. Two candidates is
         a question for the owner, not a coin toss. */
      const ws = await workspace();
      await ctx
        .http()
        .patch(`/v1/accounts/${ws.cashId}`)
        .set(auth(ws.user))
        .send({ matchHints: ['UCB'] })
        .expect(200);
      await account(ws, { name: 'UCB Two', type: 'BANK', matchHints: ['UCB'] });

      const received = await post(ws, 'UCBL debit BDT 500.00 for groceries').expect(200);
      const draft = (await drafts(ws)).find((d) => d.id === received.body.draftId);
      expect(draft?.accountId).toBeNull();
    });

    it('accepts into the account it matched without being told again', async () => {
      const ws = await workspace();
      const ucb = await account(ws, {
        name: 'UCB Current',
        type: 'BANK',
        accountNumberMasked: '****6948',
      });
      const received = await post(ws, UCB).expect(200);

      const applied = await ctx
        .http()
        .post(`/v1/ingestion/drafts/${received.body.draftId as string}/accept`)
        .set(auth(ws.user))
        .send({ categoryId: ws.categoryId })
        .expect(200);

      expect(applied.body.transactionId).toBeTruthy();
      const ledger = await ctx
        .http()
        .get(`/v1/transactions/${applied.body.transactionId as string}`)
        .set(auth(ws.user))
        .expect(200);
      expect(ledger.body.accountId).toBe(ucb.body.id);
    });

    it('remembers the number once somebody has answered for it', async () => {
      /* The queue is fifty deep and the bank sends the same shape of alert
         every day. Picking the right account once has already answered the
         question for every message that bank will ever send. */
      const ws = await workspace();
      const ucb = await account(ws, { name: 'UCB Current', type: 'BANK' });
      const first = await post(ws, UCB).expect(200);

      const applied = await ctx
        .http()
        .post(`/v1/ingestion/drafts/${first.body.draftId as string}/accept`)
        .set(auth(ws.user))
        .send({ accountId: ucb.body.id, categoryId: ws.categoryId })
        .expect(200);
      expect(applied.body.learnedHint).toBe('6948');

      const again = await post(
        ws,
        'Your A/C (***6948) has been debited BDT 750.00 for GROCERY. Avl Bal: BDT 8,84,590.17 @ 09:10 AM. For query: 16419',
      ).expect(200);
      const draft = (await drafts(ws)).find((d) => d.id === again.body.draftId);
      expect(draft?.accountId).toBe(ucb.body.id);
    });

    it('says nothing when there was nothing to learn', async () => {
      const ws = await workspace();
      const ucb = await account(ws, {
        name: 'UCB Current',
        type: 'BANK',
        accountNumberMasked: '****6948',
      });
      const received = await post(ws, UCB).expect(200);

      const applied = await ctx
        .http()
        .post(`/v1/ingestion/drafts/${received.body.draftId as string}/accept`)
        .set(auth(ws.user))
        .send({ accountId: ucb.body.id, categoryId: ws.categoryId })
        .expect(200);
      expect(applied.body.learnedHint).toBeNull();
    });

    it('refuses to learn a number another account already answers to', async () => {
      /* Teaching it here would make both ambiguous, and the matcher would then
         correctly refuse to answer for either. A rule that silently disables a
         rule that already worked is worse than no rule. */
      const ws = await workspace();
      await ctx
        .http()
        .patch(`/v1/accounts/${ws.cashId}`)
        .set(auth(ws.user))
        .send({ matchHints: ['6948'] })
        .expect(200);
      const other = await account(ws, { name: 'Other Bank', type: 'BANK' });
      const received = await post(ws, UCB).expect(200);

      const applied = await ctx
        .http()
        .post(`/v1/ingestion/drafts/${received.body.draftId as string}/accept`)
        .set(auth(ws.user))
        .send({ accountId: other.body.id, categoryId: ws.categoryId })
        .expect(200);
      expect(applied.body.learnedHint).toBeNull();

      const account_ = await ctx
        .http()
        .get(`/v1/accounts/${other.body.id as string}`)
        .set(auth(ws.user))
        .expect(200);
      expect(account_.body.matchHints).toEqual([]);
    });

    it('learns nothing from a transfer, where the message named one of two accounts', async () => {
      /* Which of the two the message was about depends on which way the
         reviewer said the money went, and a lesson taken from the wrong side is
         a wrong answer repeated daily. */
      const ws = await workspace();
      const ucb = await account(ws, { name: 'UCB Current', type: 'BANK' });
      const received = await post(ws, UCB).expect(200);

      const applied = await ctx
        .http()
        .post(`/v1/ingestion/drafts/${received.body.draftId as string}/accept`)
        .set(auth(ws.user))
        .send({ accountId: ucb.body.id, counterAccountId: ws.cashId })
        .expect(200);
      expect(applied.body.learnedHint).toBeNull();
    });
  });

  /**
   * ধার, from the inbox.
   *
   * ৳3,000 arrives in bKash and it is a borrower repaying. Booked as income it
   * invents ৳3,000 of earnings and leaves the debt standing at its full size —
   * the ledger wrong twice, and the entry that mattered never made. The review
   * screen had three tabs and a repayment is none of them.
   */
  describe('a message that is ধার', () => {
    const CASH_IN =
      'Cash In Tk 3,000.00 from 01322277399 successful. Fee Tk 0.00. Balance Tk 5,005.04. TrxID DHK6N1NC3O at 20/08/2026 20:16';

    const lend = async (ws: Ws, principalMinor: number) => {
      const res = await ctx
        .http()
        .post('/v1/loans')
        .set(auth(ws.user))
        .send({
          personName: 'Rasel',
          direction: 'LENT',
          principalMinor,
          loanDate: '2026-08-01',
          accountId: ws.cashId,
        })
        .expect(201);
      return res.body as { loan: { id: string }; progress: { outstandingMinor: number } };
    };

    it('brings the outstanding balance down instead of inventing income', async () => {
      const ws = await workspace();
      const loan = await lend(ws, 1_000_000);
      const received = await post(ws, CASH_IN).expect(200);

      const applied = await ctx
        .http()
        .post(`/v1/ingestion/drafts/${received.body.draftId as string}/accept`)
        .set(auth(ws.user))
        .send({ accountId: ws.cashId, loanId: loan.loan.id, amountMinor: 300_000 })
        .expect(200);

      expect(applied.body.status).toBe('ACCEPTED');
      expect(applied.body.transactionId).toBeTruthy();

      const after = await ctx
        .http()
        .get(`/v1/loans/${loan.loan.id}`)
        .set(auth(ws.user))
        .expect(200);
      expect(after.body.progress.outstandingMinor).toBe(700_000);
      expect(after.body.payments).toHaveLength(1);
    });

    it('records a loan being made, from the message that paid it out', async () => {
      const ws = await workspace();
      const received = await post(ws, CASH_IN).expect(200);

      await ctx
        .http()
        .post(`/v1/ingestion/drafts/${received.body.draftId as string}/accept`)
        .set(auth(ws.user))
        .send({
          accountId: ws.cashId,
          loanDirection: 'LENT',
          personName: 'Shuvo',
          amountMinor: 300_000,
        })
        .expect(200);

      const loans = await ctx.http().get('/v1/loans').set(auth(ws.user)).expect(200);
      const made = loans.body.find((l: { personName: string }) => l.personName === 'Shuvo');
      expect(made.principalMinor).toBe(300_000);
      expect(made.direction).toBe('LENT');
    });

    it('never posts the same repayment twice', async () => {
      /* Two taps a second apart must not halve somebody's outstanding balance.
         The draft is claimed before the loan is written for exactly this. */
      const ws = await workspace();
      const loan = await lend(ws, 1_000_000);
      const received = await post(ws, CASH_IN).expect(200);
      const body = { accountId: ws.cashId, loanId: loan.loan.id, amountMinor: 300_000 };

      await ctx
        .http()
        .post(`/v1/ingestion/drafts/${received.body.draftId as string}/accept`)
        .set(auth(ws.user))
        .send(body)
        .expect(200);
      await ctx
        .http()
        .post(`/v1/ingestion/drafts/${received.body.draftId as string}/accept`)
        .set(auth(ws.user))
        .send(body)
        .expect(400);

      const after = await ctx
        .http()
        .get(`/v1/loans/${loan.loan.id}`)
        .set(auth(ws.user))
        .expect(200);
      expect(after.body.payments).toHaveLength(1);
    });

    it('leaves the draft answerable when the loan write is refused', async () => {
      /* A loan that cannot take the payment must not leave a draft claiming it
         was dealt with — the person still has a decision to make. */
      const ws = await workspace();
      const received = await post(ws, CASH_IN).expect(200);

      await ctx
        .http()
        .post(`/v1/ingestion/drafts/${received.body.draftId as string}/accept`)
        .set(auth(ws.user))
        .send({ accountId: ws.cashId, loanId: 'cly0000000000000000000000', amountMinor: 300_000 })
        .expect(404);

      const drafts = await ctx.http().get('/v1/ingestion/drafts').set(auth(ws.user)).expect(200);
      const still = drafts.body.items.find((d: { id: string }) => d.id === received.body.draftId);
      expect(still.status).toBe('PENDING');
    });

    it('refuses to be a loan and a transfer at once', async () => {
      const ws = await workspace();
      const loan = await lend(ws, 1_000_000);
      const received = await post(ws, CASH_IN).expect(200);

      const res = await ctx
        .http()
        .post(`/v1/ingestion/drafts/${received.body.draftId as string}/accept`)
        .set(auth(ws.user))
        .send({
          accountId: ws.cashId,
          counterAccountId: ws.cashId,
          loanId: loan.loan.id,
          amountMinor: 300_000,
        })
        .expect(400);
      expect(res.body.message).toContain('ট্রান্সফার');
    });
  });

  /**
   * Marking a message as the shop's.
   *
   * A proprietorship run out of the household's own bKash is separated from it
   * by the tag and by nothing else. A business message that could not be tagged
   * at review either went into the books unmarked — and never reached the
   * venture's own profit — or had to be found again in the khata afterwards and
   * edited. Fifty drafts deep that is the segment report not working.
   */
  describe('tagging a message at review', () => {
    const tagged = async (ws: Ws, name: string) => {
      const res = await ctx
        .http()
        .post('/v1/tags')
        .set(auth(ws.user))
        .send({ name, nameBn: name })
        .expect(201);
      return res.body.id as string;
    };

    it('carries the tag onto the entry it becomes', async () => {
      const ws = await workspace();
      const shop = await tagged(ws, 'দোকান');
      const received = await post(ws).expect(200);

      const applied = await ctx
        .http()
        .post(`/v1/ingestion/drafts/${received.body.draftId as string}/accept`)
        .set(auth(ws.user))
        .send({ accountId: ws.cashId, categoryId: ws.categoryId, tagIds: [shop] })
        .expect(200);

      const entry = await ctx
        .http()
        .get(`/v1/transactions/${applied.body.transactionId as string}`)
        .set(auth(ws.user))
        .expect(200);
      expect(entry.body.tags.map((t: { id: string }) => t.id)).toEqual([shop]);
    });

    it('reaches the business statement, which is the whole point', async () => {
      const ws = await workspace();
      const shop = await tagged(ws, 'দোকান');
      await ctx
        .http()
        .patch('/v1/workspace/settings')
        .set(auth(ws.user))
        .send({ businessEnabled: true })
        .expect(200);

      const received = await post(ws).expect(200);
      await ctx
        .http()
        .post(`/v1/ingestion/drafts/${received.body.draftId as string}/accept`)
        .set(auth(ws.user))
        .send({ accountId: ws.cashId, categoryId: ws.categoryId, tagIds: [shop] })
        .expect(200);

      const statement = await ctx
        .http()
        .get(`/v1/reports/income-statement?tagId=${shop}`)
        .set(auth(ws.user))
        .expect(200);
      expect(statement.body.expenseMinor).toBe(125_050);
    });

    it('refuses a tag from another workspace', async () => {
      /* `Tag` and `TransactionTag` both carry a workspace, so a foreign join
         row would be internally consistent and still wrong. */
      const ws = await workspace();
      const stranger = await workspace();
      const theirs = await tagged(stranger, 'অন্যের');
      const received = await post(ws).expect(200);

      await ctx
        .http()
        .post(`/v1/ingestion/drafts/${received.body.draftId as string}/accept`)
        .set(auth(ws.user))
        .send({ accountId: ws.cashId, categoryId: ws.categoryId, tagIds: [theirs] })
        .expect(400);
    });
  });
});
