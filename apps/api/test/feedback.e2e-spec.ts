import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auth,
  createTestApp,
  resetDatabase,
  signup,
  type SignedUpUser,
  type TestContext,
} from './harness';
import { MAX_MESSAGE_LENGTH, MAX_PER_DAY } from '../src/feedback/feedback.service';

/**
 * Feedback: the one table an ordinary user writes to that they can never read.
 *
 * Three properties hold this together and the tests are written around them
 * rather than around the JSON:
 *
 *  1. **The list is invisible to everyone but an operator.** It is a
 *     cross-tenant read, so it sits behind `SuperAdminGuard` and answers 404 —
 *     not 403 — to everybody else, for the same reason every other `/admin`
 *     route does.
 *  2. **One person cannot fill the table.** The burst throttle stands down in
 *     tests, deliberately, so the ceiling asserted here is the one that counts
 *     rows and therefore survives a restart and several API processes.
 *  3. **A blank message is not feedback.** An empty row is a mystery an
 *     operator cannot act on and cannot delete with any confidence.
 */

interface FeedbackRow {
  id: string;
  kind: 'PROBLEM' | 'IDEA' | 'OTHER';
  message: string;
  screen: string | null;
  userAgent: string | null;
  workspaceId: string;
  userId: string;
  userEmail: string;
  userName: string;
}

describe('feedback', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  /**
   * `isSuperAdmin` is a column and is deliberately absent from the JWT — the
   * guard re-reads it on every request — so flipping it needs no new token.
   */
  async function operator(): Promise<SignedUpUser> {
    const user = await signup(ctx);
    await ctx.prisma.user.update({ where: { id: user.id }, data: { isSuperAdmin: true } });
    return user;
  }

  /**
   * A phrase no other test in this file — or any rerun against a database
   * somebody else is using — can collide with.
   *
   * The table is not in `TEST_TABLES`, deliberately: it has no foreign key to a
   * workspace, so nothing cascades into it and the run-wide TRUNCATE leaves it
   * alone. Every assertion below therefore looks for its own marker rather than
   * counting rows, which is the right shape anyway for a table that only grows.
   */
  let markerSeq = 0;
  const marker = (): string => {
    markerSeq += 1;
    return `marker-${Date.now()}-${markerSeq}-${Math.trunc(Math.random() * 1e6)}`;
  };

  const send = (user: SignedUpUser, body: Record<string, unknown>) =>
    ctx.http().post('/v1/feedback').set(auth(user)).send(body);

  it('records what somebody wrote, who wrote it and where they were', async () => {
    const user = await signup(ctx);
    const text = `${marker()} — রিপোর্টের হিসাব মিলছে না`;

    const res = await ctx
      .http()
      .post('/v1/feedback')
      .set(auth(user))
      /* Set explicitly: supertest sends no user-agent of its own, so asserting
         on whatever it happened to send would assert nothing. */
      .set('user-agent', 'Mozilla/5.0 (Linux; Android 9) AppleWebKit/537.36')
      .send({ kind: 'PROBLEM', message: text, screen: '/reports' })
      .expect(201);
    expect(res.body.id).toBeTruthy();

    const row = await ctx.prisma.feedback.findUnique({ where: { id: res.body.id as string } });
    expect(row).toMatchObject({
      kind: 'PROBLEM',
      message: text,
      screen: '/reports',
      userId: user.id,
      workspaceId: user.workspaceId,
      userEmail: user.email,
    });
    /* Copied at write time rather than joined, because the row has to still be
       answerable after the account it came from is gone. */
    expect(row?.userName).toBe('পরীক্ষা ব্যবহারকারী');
    /* Verbatim, because "the keypad does not work" is unanswerable without
       knowing it was an old Android WebView. */
    expect(row?.userAgent).toBe('Mozilla/5.0 (Linux; Android 9) AppleWebKit/537.36');
  });

  it('defaults to OTHER rather than losing a message over the picker', async () => {
    const user = await signup(ctx);
    const text = `${marker()} — শুধু বলতে চাই ভালো লেগেছে`;

    const res = await send(user, { message: text }).expect(201);
    const row = await ctx.prisma.feedback.findUnique({ where: { id: res.body.id as string } });
    expect(row?.kind).toBe('OTHER');
  });

  it('refuses an empty message, and a message of nothing but spaces', async () => {
    const user = await signup(ctx);
    await send(user, { message: '' }).expect(400);
    await send(user, { message: '   \n\t  ' }).expect(400);
  });

  it('refuses a message longer than the cap, and stores one exactly at it', async () => {
    const user = await signup(ctx);
    await send(user, { message: 'ক'.repeat(MAX_MESSAGE_LENGTH + 1) }).expect(400);

    const res = await send(user, { message: 'ক'.repeat(MAX_MESSAGE_LENGTH) }).expect(201);
    const row = await ctx.prisma.feedback.findUnique({ where: { id: res.body.id as string } });
    expect(row?.message).toHaveLength(MAX_MESSAGE_LENGTH);
  });

  /**
   * The screen is a courtesy, so it is narrowed rather than refused — a report
   * must never be lost because the client sent a shape nobody anticipated.
   */
  it('keeps the path and throws away everything after it', async () => {
    const user = await signup(ctx);

    const cases: [unknown, string | null][] = [
      /* The one that matters: a query string carries account ids and date
         ranges into a table an operator reads. */
      ['/reports?from=2026-01-01&account=clx123', '/reports'],
      ['https://app.example/loans/abc?x=1', null],
      ['/settings#theme', '/settings'],
      ['not-a-path', null],
      ['', null],
      [42, null],
      [undefined, null],
    ];

    for (const [screen, expected] of cases) {
      const res = await send(user, { message: `${marker()} — পথ পরীক্ষা`, screen }).expect(201);
      const row = await ctx.prisma.feedback.findUnique({ where: { id: res.body.id as string } });
      expect(row?.screen, `screen ${JSON.stringify(screen)}`).toBe(expected);
    }
  });

  it('stops one person filling the table', async () => {
    const user = await signup(ctx);
    /* The burst throttle stands down under test on purpose, so what is being
       asserted here is the row-counting ceiling — the one that survives a
       restart, several API processes, and a client pacing itself to sit just
       under the throttler. */
    for (let i = 0; i < MAX_PER_DAY; i += 1) {
      await send(user, { message: `${marker()} — ${i}` }).expect(201);
    }

    /* 429 and not 403: "not now" rather than "not you", which is the difference
       between trying again tomorrow and concluding the feature is broken. */
    await send(user, { message: `${marker()} — একটা বেশি` }).expect(429);

    /* And it is per person, not per table: somebody else's day is untouched. */
    const other = await signup(ctx);
    await send(other, { message: `${marker()} — অন্য কেউ` }).expect(201);
  });

  it('needs a signed-in user', async () => {
    await ctx.http().post('/v1/feedback').send({ message: 'কে আমি' }).expect(401);
  });

  describe('the operator list', () => {
    it('is a 404 for an ordinary user, exactly like every other admin route', async () => {
      const user = await signup(ctx);
      /* Never 403. A 403 confirms the route exists, and probing which paths
         answer 403 rather than 404 hands over the whole admin route map. */
      await ctx.http().get('/v1/admin/feedback').set(auth(user)).expect(404);
      await ctx.http().get('/v1/admin/feedback').expect(404);
    });

    it('shows an operator what came in, across workspaces, newest first', async () => {
      const boss = await operator();
      const one = await signup(ctx);
      const two = await signup(ctx);

      const first = marker();
      const second = marker();
      await send(one, { kind: 'PROBLEM', message: `${first} — ভাঙা` }).expect(201);
      await send(two, { kind: 'IDEA', message: `${second} — চাই` }).expect(201);

      const res = await ctx.http().get('/v1/admin/feedback?limit=100').set(auth(boss)).expect(200);

      const items = res.body.items as FeedbackRow[];
      const mine = items.filter((r) => r.message.includes(first) || r.message.includes(second));
      expect(mine).toHaveLength(2);
      /* Newest first, and the second one was written second. */
      expect(mine[0]!.message).toContain(second);

      const problem = mine.find((r) => r.message.includes(first))!;
      expect(problem.kind).toBe('PROBLEM');
      expect(problem.workspaceId).toBe(one.workspaceId);
      expect(problem.userEmail).toBe(one.email);
      /* Whole, not truncated: the sentence that explains a bug is almost never
         the first one. */
      expect(problem.message).toBe(`${first} — ভাঙা`);
    });

    it('narrows by kind and by workspace', async () => {
      const boss = await operator();
      const user = await signup(ctx);

      const idea = marker();
      const problem = marker();
      await send(user, { kind: 'IDEA', message: `${idea} — একটা ভাবনা` }).expect(201);
      await send(user, { kind: 'PROBLEM', message: `${problem} — একটা সমস্যা` }).expect(201);

      const ideas = await ctx
        .http()
        .get(`/v1/admin/feedback?kind=IDEA&workspaceId=${user.workspaceId}&limit=100`)
        .set(auth(boss))
        .expect(200);

      const messages = (ideas.body.items as FeedbackRow[]).map((r) => r.message);
      expect(messages.some((m) => m.includes(idea))).toBe(true);
      expect(messages.some((m) => m.includes(problem))).toBe(false);
    });

    it('pages with a cursor rather than an offset', async () => {
      const boss = await operator();
      const user = await signup(ctx);
      const batch = marker();
      for (let i = 0; i < 3; i += 1) {
        await send(user, { message: `${batch} — ${i}` }).expect(201);
      }

      const page = await ctx
        .http()
        .get(`/v1/admin/feedback?workspaceId=${user.workspaceId}&limit=2`)
        .set(auth(boss))
        .expect(200);
      expect(page.body.items).toHaveLength(2);
      expect(page.body.nextCursor).toBeTruthy();

      const rest = await ctx
        .http()
        .get(
          `/v1/admin/feedback?workspaceId=${user.workspaceId}&limit=2&cursor=${page.body.nextCursor as string}`,
        )
        .set(auth(boss))
        .expect(200);
      expect(rest.body.items).toHaveLength(1);
      expect(rest.body.nextCursor).toBeNull();

      /* No row appears on both pages — the property an offset loses the moment
         anything is appended between the two requests. */
      const ids = [...page.body.items, ...rest.body.items].map((r: FeedbackRow) => r.id);
      expect(new Set(ids).size).toBe(3);
    });
  });
});
