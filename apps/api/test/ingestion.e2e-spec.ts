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

    const txns = await ctx.prisma.transaction.count({
      where: { workspaceId: ws.user.workspaceId, deletedAt: null },
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

    expect(
      await ctx.prisma.transaction.count({ where: { workspaceId: ws.user.workspaceId } }),
    ).toBe(0);
  });

  it('keeps a message with no amount out of the way rather than inventing one', async () => {
    const ws = await workspace();
    const received = await post(ws, 'Dear customer, your statement is ready. Thank you.').expect(
      200,
    );

    const drafts = await ctx.http().get('/v1/ingestion/drafts').set(auth(ws.user)).expect(200);
    const draft = drafts.body.items.find(
      (d: { id: string }) => d.id === (received.body.draftId as string),
    );
    // The draft exists — a message that vanished could never be looked at — but
    // it claims nothing.
    expect(draft.amountMinor).toBeNull();
    expect(draft.confidence).toBe(0);
    expect(draft.needsReview).toBe(true);
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
});
