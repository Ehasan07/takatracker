import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BreachedPasswordService } from './breached-password.service';

/**
 * The half of NIST 800-63B that was missing.
 *
 * The length rule was already the right shape — eight characters, no
 * composition rules, no forced rotation. What it could not do was notice that
 * `password` is eight characters, and it opened a real account on the live
 * site until this existed.
 *
 * `fetch` is stubbed throughout. A unit test that reaches
 * api.pwnedpasswords.com is a unit test that fails on a plane, and the whole
 * suite is run with `HIBP_DISABLED=1` for the same reason.
 */
describe('BreachedPasswordService', () => {
  let service: BreachedPasswordService;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    service = new BreachedPasswordService();
    delete process.env.HIBP_DISABLED;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    process.env.HIBP_DISABLED = '1';
    vi.restoreAllMocks();
  });

  it('refuses the passwords that actually get typed, with no network at all', async () => {
    globalThis.fetch = vi.fn(() => {
      throw new Error('the local list must answer before anything is fetched');
    }) as unknown as typeof fetch;

    for (const password of ['password', 'PASSWORD', '12345678', 'bismillah']) {
      expect(await service.isBreached(password), password).toBe(true);
    }
  });

  it('sends five hex characters and never the password', async () => {
    /* The property the whole design rests on. HIBP is told a prefix that about
       eight hundred passwords in a billion share; the comparison happens
       here. */
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response('0000000000000000000000000000000000000:3\n', { status: 200 });
    }) as unknown as typeof fetch;

    await service.isBreached('a-passphrase-nobody-else-has');

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^https:\/\/api\.pwnedpasswords\.com\/range\/[0-9A-F]{5}$/);
    expect(seen[0]).not.toContain('a-passphrase');
  });

  it('matches the suffix the range answer holds', async () => {
    const { createHash } = await import('node:crypto');
    const sha1 = createHash('sha1')
      .update('correct horse battery', 'utf8')
      .digest('hex')
      .toUpperCase();

    globalThis.fetch = vi.fn(
      async () => new Response(`${sha1.slice(5)}:42\r\n`, { status: 200 }),
    ) as unknown as typeof fetch;

    expect(await service.isBreached('correct horse battery')).toBe(true);
  });

  it('ignores the padding rows, which come back with a count of zero', async () => {
    /* `Add-Padding` makes HIBP return random extra suffixes so the response
       size says nothing. Treating one as a hit would refuse a good password. */
    const { createHash } = await import('node:crypto');
    const sha1 = createHash('sha1').update('a-good-passphrase', 'utf8').digest('hex').toUpperCase();

    globalThis.fetch = vi.fn(
      async () =>
        new Response(`${sha1.slice(5)}:0\r\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:0\r\n`, {
          status: 200,
        }),
    ) as unknown as typeof fetch;

    expect(await service.isBreached('a-good-passphrase')).toBe(false);
  });

  it('lets a signup through when the service is unreachable', async () => {
    /* Fails open, deliberately. Somebody in Dhaka must not be unable to open an
       account because a service in another country is having a bad afternoon. */
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;

    expect(await service.isBreached('an-unusual-passphrase')).toBe(false);
  });

  it('lets a signup through on a bad response rather than guessing', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('nope', { status: 503 }),
    ) as unknown as typeof fetch;

    expect(await service.isBreached('another-unusual-passphrase')).toBe(false);
  });

  it('skips the network entirely when switched off', async () => {
    process.env.HIBP_DISABLED = '1';
    globalThis.fetch = vi.fn(() => {
      throw new Error('should not be called');
    }) as unknown as typeof fetch;

    expect(await service.isBreached('an-unusual-passphrase')).toBe(false);
    /* But the local list still applies — switching off the network check must
       not switch off the floor. */
    expect(await service.isBreached('password')).toBe(true);
  });
});
