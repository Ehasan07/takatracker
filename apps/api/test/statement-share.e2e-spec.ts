import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, createTestApp, resetDatabase, signup, type TestContext } from './harness';

/**
 * A statement link somebody outside the app can open.
 *
 * The link *is* the credential — there is no login on the far side, and there
 * should not be: a relative you lent money to should not need an account in a
 * product they are not a customer of. Every test here is about what follows
 * from that: it cannot be widened, it expires, it can be taken back, and it
 * reaches exactly one subject in one workspace.
 */
describe('sharing a statement', () => {
  let ctx: TestContext;
  let user: Awaited<ReturnType<typeof signup>>;
  let personId: string;
  let accountId: string;

  const tokenOf = (url: string): string => url.replace('/s/', '');

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    user = await signup(ctx);

    const account = await ctx
      .http()
      .post('/v1/accounts')
      .set(auth(user))
      .send({ name: 'নগদ', type: 'CASH', openingBalance: 10_000_000 })
      .expect(201);
    accountId = account.body.id;

    const loan = await ctx
      .http()
      .post('/v1/loans')
      .set(auth(user))
      .send({
        direction: 'LENT',
        personName: 'করিম',
        principalMinor: 5_000_000,
        loanDate: '2026-03-10',
        accountId,
      })
      .expect(201);
    personId = loan.body.person.id;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  const share = (body: Record<string, unknown>) =>
    ctx.http().post('/v1/statement-shares').set(auth(user)).send(body);

  it('hands back a link that opens the statement', async () => {
    const made = await share({ kind: 'PERSON', subjectId: personId }).expect(201);
    expect(made.body.url).toMatch(/^\/s\/[A-Za-z0-9_-]{20,}$/);

    /* No Authorization header anywhere in this request. That is the point. */
    const read = await ctx
      .http()
      .get(`/v1/public/statement/${tokenOf(made.body.url)}`)
      .expect(200);

    expect(read.body.kind).toBe('PERSON');
    expect(read.body.title).toBe('করিম');
    expect(read.body.data.rows.length).toBeGreaterThan(0);
  });

  it('cannot be widened by the person holding it', async () => {
    /* The whole reason the window is a column rather than a query parameter.
       A link to March must not be editable into a link to everything. */
    const narrow = await share({
      kind: 'PERSON',
      subjectId: personId,
      from: '2026-04-01',
      to: '2026-04-30',
    }).expect(201);
    const token = tokenOf(narrow.body.url);

    const asIs = await ctx.http().get(`/v1/public/statement/${token}`).expect(200);
    const tampered = await ctx
      .http()
      .get(`/v1/public/statement/${token}?from=2000-01-01&to=2100-01-01`)
      .expect(200);

    expect(asIs.body.from).toBe('2026-04-01');
    expect(tampered.body.from).toBe('2026-04-01');
    expect(tampered.body.to).toBe('2026-04-30');
    expect(tampered.body.data.rows).toEqual(asIs.body.data.rows);
  });

  it('stops working when it is taken back', async () => {
    const made = await share({ kind: 'PERSON', subjectId: personId }).expect(201);
    const token = tokenOf(made.body.url);
    await ctx.http().get(`/v1/public/statement/${token}`).expect(200);

    await ctx.http().delete(`/v1/statement-shares/${made.body.id}`).set(auth(user)).expect(200);
    await ctx.http().get(`/v1/public/statement/${token}`).expect(404);
  });

  it('stops working when it expires', async () => {
    const made = await share({ kind: 'PERSON', subjectId: personId, expiresInDays: 1 }).expect(201);
    const token = tokenOf(made.body.url);
    await ctx.http().get(`/v1/public/statement/${token}`).expect(200);

    await ctx.prisma.statementShare.update({
      where: { id: made.body.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await ctx.http().get(`/v1/public/statement/${token}`).expect(404);
  });

  it('says the same thing for unknown, revoked and expired', async () => {
    /* "This link has expired" tells a stranger that a statement was shared
       with somebody, which is not theirs to learn. */
    const unknown = await ctx.http().get('/v1/public/statement/no-such-token').expect(404);

    const made = await share({ kind: 'PERSON', subjectId: personId }).expect(201);
    await ctx.http().delete(`/v1/statement-shares/${made.body.id}`).set(auth(user)).expect(200);
    const revoked = await ctx
      .http()
      .get(`/v1/public/statement/${tokenOf(made.body.url)}`)
      .expect(404);

    expect(revoked.body.message).toBe(unknown.body.message);
  });

  it('refuses to link to another workspace’s subject', async () => {
    /* The tenancy check has to happen where the link is made: the public route
       has no user to check against, so a link minted for somebody else's person
       would be a permanent hole. */
    const stranger = await signup(ctx);
    await ctx
      .http()
      .post('/v1/statement-shares')
      .set(auth(stranger))
      .send({ kind: 'PERSON', subjectId: personId })
      .expect(404);
  });

  it('never returns the token again, not even to the owner', async () => {
    const made = await share({ kind: 'PERSON', subjectId: personId, label: 'করিমের জন্য' }).expect(
      201,
    );
    const token = tokenOf(made.body.url);

    const list = await ctx
      .http()
      .get(`/v1/statement-shares?kind=PERSON&subjectId=${personId}`)
      .set(auth(user))
      .expect(200);

    const row = list.body.find((item: { id: string }) => item.id === made.body.id);
    expect(row.label).toBe('করিমের জন্য');
    /* Only the hash is stored, so this is not a policy — there is nothing to
       return. The assertion pins that no future convenience re-adds it. */
    expect(JSON.stringify(list.body)).not.toContain(token);
  });

  it('shows the owner how often it has been opened', async () => {
    /* There is no login on the far side, so this is the only way somebody
       notices a link they sent once being read forty times. */
    const made = await share({ kind: 'PERSON', subjectId: personId }).expect(201);
    const token = tokenOf(made.body.url);

    await ctx.http().get(`/v1/public/statement/${token}`).expect(200);
    await ctx.http().get(`/v1/public/statement/${token}`).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const row = await ctx.prisma.statementShare.findUniqueOrThrow({
      where: { id: made.body.id },
    });
    expect(row.viewCount).toBeGreaterThanOrEqual(2);
    expect(row.lastViewedAt).not.toBeNull();
  });

  it('records who shared it, and who took it back', async () => {
    const made = await share({ kind: 'PERSON', subjectId: personId }).expect(201);
    await ctx.http().delete(`/v1/statement-shares/${made.body.id}`).set(auth(user)).expect(200);

    const log = await ctx.http().get('/v1/audit?limit=50').set(auth(user)).expect(200);
    const actions = log.body.items.map((row: { action: string }) => row.action);
    expect(actions).toContain('statement.shared');
    expect(actions).toContain('statement.share_revoked');
  });

  it('refuses a backwards window', async () => {
    await share({
      kind: 'PERSON',
      subjectId: personId,
      from: '2026-05-01',
      to: '2026-04-01',
    }).expect(400);
  });

  it('tells nobody about the workspace beyond whose books these are', async () => {
    /* The reader needs to know who sent it and nothing else. No email, no
       plan, no other people, no other loans. */
    const made = await share({ kind: 'PERSON', subjectId: personId }).expect(201);
    const read = await ctx
      .http()
      .get(`/v1/public/statement/${tokenOf(made.body.url)}`)
      .expect(200);

    const body = JSON.stringify(read.body);
    expect(read.body.workspaceName).toBeTruthy();
    expect(body).not.toContain(user.email);
    expect(body).not.toContain(user.id);
    expect(read.body).not.toHaveProperty('workspaceId');
  });

  it('carries what a document needs on its face', async () => {
    /* A reference to quote on the phone, when it was drawn, and when the link
       dies. The last one is not a leak — the reader is holding the link — and
       it is the difference between printing it now and finding it dead the
       week an insurer asks. */
    const made = await share({ kind: 'PERSON', subjectId: personId, expiresInDays: 30 }).expect(
      201,
    );
    const read = await ctx
      .http()
      .get(`/v1/public/statement/${tokenOf(made.body.url)}`)
      .expect(200);

    expect(read.body.reference).toMatch(/^[A-Z0-9]{8}$/);
    expect(Date.parse(read.body.issuedAt)).not.toBeNaN();
    const daysLeft = (Date.parse(read.body.expiresAt) - Date.now()) / 86_400_000;
    expect(daysLeft).toBeGreaterThan(29);
    expect(daysLeft).toBeLessThanOrEqual(30);

    /* The reference is a fragment of the row id, which is not the secret. The
       token is, and it must not have followed it onto the page. */
    expect(JSON.stringify(read.body)).not.toContain(tokenOf(made.body.url));
  });

  it('is not indexable', async () => {
    const made = await share({ kind: 'PERSON', subjectId: personId }).expect(201);
    const read = await ctx
      .http()
      .get(`/v1/public/statement/${tokenOf(made.body.url)}`)
      .expect(200);

    expect(read.headers['x-robots-tag']).toContain('noindex');
    /* One person's financial record, keyed only by a URL: it must not sit in
       any shared cache along the way. */
    expect(read.headers['cache-control']).toContain('no-store');
  });
});
