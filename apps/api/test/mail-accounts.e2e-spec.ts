import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sealMailSecret } from '../src/mail-accounts/mail-credentials';
import { MailSyncScheduler } from '../src/mail-accounts/mail-sync.scheduler';
import {
  auth,
  createTestApp,
  resetDatabase,
  signup,
  type SignedUpUser,
  type TestContext,
} from './harness';

/**
 * The mailbox connector, tested from the outside with no mail server anywhere.
 *
 * There is no IMAP host in this suite and there must not be: `verify()` is a TLS
 * handshake against somebody else's machine, and a test that needed one would be
 * a test that fails when the network does. So everything here is arranged around
 * the provider rather than through it — every case below is refused, or answered
 * from the database, before a socket could exist.
 *
 * That is not a gap in the coverage. The two things this module can get
 * catastrophically wrong are leaking a stored credential and showing one tenant
 * another tenant's mail, and neither of those needs a mail server to prove.
 *
 * ## How a mailbox exists here at all
 *
 * Fixtures are written straight to `MailAccount` with a credential sealed by the
 * real `sealMailSecret`, because connecting one through the API would require a
 * server to authenticate against. The cipher, the IV and the plaintext password
 * are therefore all known to the test, which is exactly what makes
 * "credentials never come back" assertable rather than assumed.
 */

/**
 * Where a connect attempt would go if one ever reached the network.
 *
 * 127.0.0.1 refuses instantly, so if `verify()` ran, these tests would see a 503
 * from `verifyOrThrow` rather than the 422 or 402 they assert. The status code
 * is therefore itself the proof that the refusal happened first; the socket
 * recorder below is the second, independent witness.
 */
const DEAD_HOST = '127.0.0.1';
const DEAD_PORT = 1;

/** Every outbound TCP destination this process attempted, as `host:port`. */
const outbound: string[] = [];
const realConnect = net.Socket.prototype.connect as (...args: unknown[]) => net.Socket;

/**
 * Record every socket, including the TLS ones.
 *
 * `tls.connect` builds a `TLSSocket`, which extends `net.Socket` and does not
 * override `connect`, so both plain and TLS attempts pass through here. Postgres
 * and supertest also do — that is why the assertion below is about the mail
 * host's port and not about the count.
 */
function installSocketRecorder(): void {
  net.Socket.prototype.connect = function patched(
    this: net.Socket,
    ...args: unknown[]
  ): net.Socket {
    const first = args[0];
    if (typeof first === 'object' && first !== null) {
      const options = first as { host?: string; port?: number; path?: string };
      outbound.push(`${options.host ?? options.path ?? '?'}:${options.port ?? '?'}`);
    } else {
      outbound.push(`${String(args[1] ?? '?')}:${String(first)}`);
    }
    return realConnect.apply(this, args);
  } as typeof net.Socket.prototype.connect;
}

interface Mailbox {
  id: string;
  email: string;
  password: string;
  cipher: string;
  iv: string;
}

describe('mail accounts', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    installSocketRecorder();
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
  });

  afterAll(async () => {
    net.Socket.prototype.connect = realConnect as typeof net.Socket.prototype.connect;
    await ctx.app.close();
  });

  /**
   * A connected mailbox, written directly, with a genuinely sealed credential.
   *
   * The password is a sentinel so an assertion that it never appears in a
   * response is checking for something recognisable rather than for the absence
   * of a field somebody might rename.
   */
  async function mailbox(user: SignedUpUser, email: string, password: string): Promise<Mailbox> {
    const sealed = sealMailSecret(user.workspaceId, email, {
      kind: 'IMAP',
      username: email,
      password,
    });
    const row = await ctx.prisma.mailAccount.create({
      data: {
        workspaceId: user.workspaceId,
        provider: 'IMAP',
        email,
        imapHost: 'mail.example.test',
        imapPort: 993,
        status: 'ACTIVE',
        syncSince: new Date(Date.now() - 7 * 86_400_000),
        ...sealed,
      },
      select: { id: true },
    });
    return {
      id: row.id,
      email,
      password,
      cipher: sealed.secretCipher,
      iv: sealed.secretIv,
    };
  }

  async function message(
    user: SignedUpUser,
    box: Mailbox,
    externalId: string,
    subject: string,
  ): Promise<string> {
    const row = await ctx.prisma.mailMessage.create({
      data: {
        workspaceId: user.workspaceId,
        mailAccountId: box.id,
        folder: 'INBOX',
        externalId,
        fromAddress: 'alerts@bkash.test',
        toAddress: box.email,
        subject,
        snippet: 'আপনার অ্যাকাউন্ট থেকে ৳৫০০ কাটা হয়েছে',
        body: 'আপনার অ্যাকাউন্ট থেকে ৳৫০০ কাটা হয়েছে। ব্যালেন্স ৳৯,৫০০।',
        receivedAt: new Date(),
      },
      select: { id: true },
    });
    return row.id;
  }

  /** Let this workspace hold `n` mailboxes. FREE grants none at all. */
  async function allowMailboxes(user: SignedUpUser, n: number): Promise<void> {
    await ctx.prisma.workspaceFeatureOverride.upsert({
      where: {
        workspaceId_featureKey: {
          workspaceId: user.workspaceId,
          featureKey: 'email.connections.max',
        },
      },
      create: {
        workspaceId: user.workspaceId,
        featureKey: 'email.connections.max',
        limitValue: n,
      },
      update: { limitValue: n },
    });
  }

  const connectBody = (email: string, password = 'hunter2') => ({
    provider: 'IMAP',
    email,
    imapHost: DEAD_HOST,
    imapPort: DEAD_PORT,
    password,
  });

  /**
   * The single most important assertion in this file.
   *
   * `accountSelect` in the service is the only place a `MailAccount` is read on
   * a request path, and it does not name `secretCipher` or `secretIv`. This is
   * the test that keeps it that way: every response any route can produce is
   * searched for the ciphertext, the IV and the plaintext password.
   */
  it('never returns the cipher, the IV or the password on any route', async () => {
    const user = await signup(ctx);
    const box = await mailbox(user, 'shop@example.test', 'PLAINTEXT-PASSWORD-SENTINEL');
    const messageId = await message(user, box, '1:101', 'বিকাশ স্টেটমেন্ট');

    const bodies: string[] = [];
    const collect = async (path: string, expected = 200): Promise<void> => {
      const res = await ctx.http().get(path).set(auth(user)).expect(expected);
      bodies.push(JSON.stringify(res.body));
    };

    await collect('/v1/mail-accounts');
    await collect(`/v1/mail-accounts/${box.id}`);
    await collect('/v1/mail-messages');
    await collect(`/v1/mail-messages/${messageId}`);

    const patched = await ctx
      .http()
      .patch(`/v1/mail-accounts/${box.id}`)
      .set(auth(user))
      .send({ status: 'DISABLED' })
      .expect(200);
    bodies.push(JSON.stringify(patched.body));

    const reenabled = await ctx
      .http()
      .patch(`/v1/mail-accounts/${box.id}`)
      .set(auth(user))
      .send({ status: 'ACTIVE' })
      .expect(200);
    bodies.push(JSON.stringify(reenabled.body));

    const queued = await ctx
      .http()
      .post(`/v1/mail-accounts/${box.id}/sync`)
      .set(auth(user))
      .expect(202);
    bodies.push(JSON.stringify(queued.body));

    const removed = await ctx
      .http()
      .delete(`/v1/mail-accounts/${box.id}`)
      .set(auth(user))
      .expect(200);
    bodies.push(JSON.stringify(removed.body));

    const whole = bodies.join('\n');
    expect(whole).not.toContain(box.cipher);
    expect(whole).not.toContain(box.iv);
    expect(whole).not.toContain(box.password);
    /* Not just the values — the column names too, so a future `include` that
     * renamed them on the way out would still be caught. */
    expect(whole).not.toContain('secretCipher');
    expect(whole).not.toContain('secretIv');

    /* The audit log outlives the row and every admin in the workspace can read
     * it, so it is held to the same rule. */
    await new Promise((resolve) => setTimeout(resolve, 200));
    const events = await ctx.prisma.auditEvent.findMany({
      where: { workspaceId: user.workspaceId, action: { startsWith: 'mail.' } },
    });
    const trail = JSON.stringify(events);
    expect(trail).not.toContain(box.cipher);
    expect(trail).not.toContain(box.iv);
    expect(trail).not.toContain(box.password);
    expect(events.map((e) => e.action)).toContain('mail.account_disconnected');
  });

  it('shows one tenant nothing at all of another tenant’s mail', async () => {
    const owner = await signup(ctx);
    const box = await mailbox(owner, 'private@example.test', 'not-yours');
    const messageId = await message(owner, box, '1:201', 'ব্যক্তিগত');

    const stranger = await signup(ctx);

    // Absent, not forbidden. A 403 would confirm the id exists.
    await ctx.http().get(`/v1/mail-accounts/${box.id}`).set(auth(stranger)).expect(404);
    await ctx
      .http()
      .patch(`/v1/mail-accounts/${box.id}`)
      .set(auth(stranger))
      .send({ status: 'DISABLED' })
      .expect(404);
    await ctx.http().post(`/v1/mail-accounts/${box.id}/sync`).set(auth(stranger)).expect(404);
    await ctx.http().delete(`/v1/mail-accounts/${box.id}`).set(auth(stranger)).expect(404);
    await ctx.http().get(`/v1/mail-messages/${messageId}`).set(auth(stranger)).expect(404);

    const list = await ctx.http().get('/v1/mail-accounts').set(auth(stranger)).expect(200);
    expect(list.body.items).toHaveLength(0);

    const inbox = await ctx.http().get('/v1/mail-messages').set(auth(stranger)).expect(200);
    expect(inbox.body.items).toHaveLength(0);

    /* `?accountId=` is an extra AND on top of the JWT's workspace, never a
     * replacement for it, so a foreign id narrows to nothing rather than
     * widening to somebody else's inbox. */
    const narrowed = await ctx
      .http()
      .get('/v1/mail-messages')
      .query({ accountId: box.id })
      .set(auth(stranger))
      .expect(200);
    expect(narrowed.body.items).toHaveLength(0);

    // The owner still has all of it.
    const mine = await ctx.http().get('/v1/mail-messages').set(auth(owner)).expect(200);
    expect((mine.body.items as { id: string }[]).map((m) => m.id)).toEqual([messageId]);
  });

  /**
   * Microsoft finished disabling IMAP basic auth in 2022–24. There is no
   * setting and no app password, so a connect can only ever end in
   * "authentication failed" after a full round trip — which would send somebody
   * off resetting a password that was never the problem.
   */
  it('refuses a Microsoft mailbox with 422, before any network call', async () => {
    const user = await signup(ctx);
    // Generous enough that a 402 could not be what refuses these.
    await allowMailboxes(user, 5);

    for (const email of [
      'someone@outlook.com',
      'someone@hotmail.com',
      'someone@live.com',
      'someone@msn.com',
    ]) {
      const res = await ctx
        .http()
        .post('/v1/mail-accounts')
        .set(auth(user))
        .send(connectBody(email))
        .expect(422);
      expect(String(res.body.message), email).toContain('Microsoft');
    }

    /* A Microsoft 365 tenant on its own domain is invisible in the address —
     * the host is the tell, and it is the case the domain list alone misses. */
    const byHost = await ctx
      .http()
      .post('/v1/mail-accounts')
      .set(auth(user))
      .send({
        provider: 'IMAP',
        email: 'hello@somecompany.com.bd',
        imapHost: 'outlook.office365.com',
        imapPort: DEAD_PORT,
        password: 'hunter2',
      })
      .expect(422);
    expect(String(byHost.body.message)).toContain('Microsoft');

    // Nothing was written for any of them.
    const list = await ctx.http().get('/v1/mail-accounts').set(auth(user)).expect(200);
    expect(list.body.items).toHaveLength(0);
  });

  it('does not mistake a look-alike domain for a Microsoft one', async () => {
    const user = await signup(ctx);

    /* Suffix matching on a dot boundary, not `includes`. `notlive.com` ends in
     * `live.com` as a substring and is somebody's real mailbox. It gets the
     * plan's refusal — a FREE workspace may connect none — which is a different
     * refusal from the Microsoft one and proves the guard did not fire.
     *
     * 402 rather than 503 also proves the request stopped before the network:
     * `${DEAD_HOST}:${DEAD_PORT}` refuses instantly, and `verifyOrThrow` turns
     * that into a 503. */
    const res = await ctx
      .http()
      .post('/v1/mail-accounts')
      .set(auth(user))
      .send(connectBody('office@mail.notlive.com'))
      .expect(402);
    expect(res.body.featureKey).toBe('email.connections.max');
    expect(String(res.body.message)).not.toContain('Microsoft');
  });

  it('enforces the plan’s mailbox limit, and frees the slot on disconnect', async () => {
    const user = await signup(ctx);

    // FREE grants none, and says so as "not on your plan" rather than "0/0".
    const off = await ctx
      .http()
      .post('/v1/mail-accounts')
      .set(auth(user))
      .send(connectBody('first@example.test'))
      .expect(402);
    expect(off.body.error).toBe('FeatureUnavailable');
    expect(off.body.featureKey).toBe('email.connections.max');

    await allowMailboxes(user, 1);
    const box = await mailbox(user, 'first@example.test', 'one');

    const usage = await ctx.http().get('/v1/entitlements').set(auth(user)).expect(200);
    expect(usage.body.usage['email.connections.max']).toBe(1);
    expect(usage.body.remaining['email.connections.max']).toBe(0);

    const full = await ctx
      .http()
      .post('/v1/mail-accounts')
      .set(auth(user))
      .send(connectBody('second@example.test'))
      .expect(402);
    expect(full.body.error).toBe('FeatureLimitReached');
    expect(full.body.limit).toBe(1);
    expect(full.body.used).toBe(1);

    // Disconnecting gives the slot back — only a deleted mailbox stops counting.
    await ctx.http().delete(`/v1/mail-accounts/${box.id}`).set(auth(user)).expect(200);
    const after = await ctx.http().get('/v1/entitlements').set(auth(user)).expect(200);
    expect(after.body.usage['email.connections.max']).toBe(0);
    expect(after.body.remaining['email.connections.max']).toBe(1);
  });

  it('reports how much mail a disconnect removed, and removes it', async () => {
    const user = await signup(ctx);
    const box = await mailbox(user, 'statements@example.test', 'three-messages');
    await message(user, box, '1:301', 'বিকাশ');
    await message(user, box, '1:302', 'নগদ');
    await message(user, box, '1:303', 'ব্যাংক');

    const before = await ctx.http().get('/v1/mail-messages').set(auth(user)).expect(200);
    expect(before.body.items).toHaveLength(3);

    const removed = await ctx
      .http()
      .delete(`/v1/mail-accounts/${box.id}`)
      .set(auth(user))
      .expect(200);
    /* Said out loud, because "disconnect" is the button somebody presses
     * expecting something smaller than deleting three months of their mail. */
    expect(removed.body).toMatchObject({ id: box.id, deleted: true, messagesRemoved: 3 });

    const after = await ctx.http().get('/v1/mail-messages').set(auth(user)).expect(200);
    expect(after.body.items).toHaveLength(0);
    expect(await ctx.prisma.mailMessage.count({ where: { mailAccountId: box.id } })).toBe(0);

    // The account is gone from every read, and its credential is destroyed
    // rather than merely hidden — there is no restore endpoint, so keeping a
    // decryptable password would be the opposite of what was asked.
    const list = await ctx.http().get('/v1/mail-accounts').set(auth(user)).expect(200);
    expect(list.body.items).toHaveLength(0);
    await ctx.http().get(`/v1/mail-accounts/${box.id}`).set(auth(user)).expect(404);

    const row = await ctx.prisma.mailAccount.findUniqueOrThrow({ where: { id: box.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.status).toBe('DISABLED');
    expect(row.secretCipher).toBe('');
    expect(row.secretIv).toBe('');
  });

  it('will not switch a rejected mailbox back on without a new password', async () => {
    const user = await signup(ctx);
    const box = await mailbox(user, 'stale@example.test', 'was-right-once');
    await ctx.prisma.mailAccount.update({
      where: { id: box.id },
      data: { status: 'AUTH_FAILED', lastError: 'ইমেইল ঠিকানা বা পাসওয়ার্ড মেলেনি।' },
    });

    /* Letting `status: ACTIVE` alone clear the failure would put the same
     * rejected password back into the sweep, which then presents it every
     * fifteen minutes until the provider locks the user's whole account. */
    const refused = await ctx
      .http()
      .patch(`/v1/mail-accounts/${box.id}`)
      .set(auth(user))
      .send({ status: 'ACTIVE' })
      .expect(400);
    expect(String(refused.body.message)).toContain('পাসওয়ার্ড');

    // And a sync cannot be asked for either, rather than being silently dropped.
    const noSync = await ctx
      .http()
      .post(`/v1/mail-accounts/${box.id}/sync`)
      .set(auth(user))
      .expect(400);
    expect(String(noSync.body.message)).toContain('পাসওয়ার্ড');

    // Turning it off is allowed, and takes the stale reason with it.
    const disabled = await ctx
      .http()
      .patch(`/v1/mail-accounts/${box.id}`)
      .set(auth(user))
      .send({ status: 'DISABLED' })
      .expect(200);
    expect(disabled.body.status).toBe('DISABLED');
    expect(disabled.body.lastError).toBeNull();
  });

  it('answers an OAuth mailbox with 503 and an explanation, not a credential error', async () => {
    const user = await signup(ctx);
    await allowMailboxes(user, 5);

    for (const provider of ['GMAIL_OAUTH', 'OUTLOOK_OAUTH']) {
      const res = await ctx
        .http()
        .post('/v1/mail-accounts')
        .set(auth(user))
        .send({ provider, email: `someone@example.test` })
        .expect(503);
      // A missing dependency must not be dressed up as the user's mistake.
      expect(String(res.body.message), provider).not.toContain('পাসওয়ার্ড ভুল');
      expect(String(res.body.message).length, provider).toBeGreaterThan(10);
    }
  });

  it('queues a sync instead of blocking on one, and the sweep is off under test', async () => {
    const user = await signup(ctx);
    const box = await mailbox(user, 'queued@example.test', 'sync-me');

    const res = await ctx
      .http()
      .post(`/v1/mail-accounts/${box.id}/sync`)
      .set(auth(user))
      .expect(202);
    expect(res.body).toMatchObject({ accountId: box.id, queued: true });

    /* `nextSweepInSeconds()` returns 0 only when the scheduler decided not to
     * schedule anything, which under `NODE_ENV=test` is what `onModuleInit`
     * does: no interval, no timeout, no socket. The queue accepts and simply
     * never drains, which is what an endpoint that must not block should look
     * like from the outside. */
    expect(process.env.NODE_ENV).toBe('test');
    expect(ctx.app.get(MailSyncScheduler).nextSweepInSeconds()).toBe(0);
    expect(res.body.estimatedSeconds).toBe(0);

    // The mailbox was not read: nothing was stored and no error was recorded.
    const row = await ctx.prisma.mailAccount.findUniqueOrThrow({ where: { id: box.id } });
    expect(row.lastSyncAt).toBeNull();
    expect(row.lastError).toBeNull();
  });

  /**
   * Last, so it sees every socket the rest of the file caused.
   *
   * The recorder wraps `net.Socket.prototype.connect`, which both plain and TLS
   * connections go through — a `TLSSocket` extends `net.Socket` and does not
   * override it. Postgres and supertest appear in `outbound` too, which is why
   * this asserts about the mail destination rather than about the count: what
   * must be true is that nothing in this suite dialled a mail host.
   */
  it('opened no socket to a mail server anywhere in this file', () => {
    expect(outbound.length).toBeGreaterThan(0); // the recorder is actually installed
    const mailAttempts = outbound.filter(
      (target) =>
        target.endsWith(`:${DEAD_PORT}`) || target.endsWith(':993') || target.includes('outlook'),
    );
    expect(mailAttempts).toEqual([]);
  });
});
