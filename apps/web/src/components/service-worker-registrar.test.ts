import { describe, expect, it } from 'vitest';
import { RELOAD_GIVE_UP_MS, shouldReloadNow } from './service-worker-registrar';

/**
 * When it is safe to reload the page for a new release.
 *
 * This exists because of a real sign-out in production. A new service worker
 * takes over, the page reloads to adopt it — and if a refresh-token rotation
 * happens to be on the wire, the request dies after the server has already
 * spent the token while the browser still holds the old one in its cookie. The
 * next load presents it, the server correctly reads a replayed token, and
 * `Refresh token reuse detected … family revoked` signs somebody out of their
 * own books because an update landed at the wrong moment.
 */
describe('shouldReloadNow', () => {
  it('reloads straight away when nothing is in flight', () => {
    expect(shouldReloadNow(false, 0)).toBe(true);
  });

  it('waits while a token rotation is on the wire', () => {
    /* The whole point. Reloading here is what signed people out. */
    expect(shouldReloadNow(true, 0)).toBe(false);
    expect(shouldReloadNow(true, RELOAD_GIVE_UP_MS - 1)).toBe(false);
  });

  it('gives up waiting rather than pinning the page to an old build', () => {
    /* A refresh that never settles must not mean an app that never updates.
       Ten seconds of waiting is cheap; forever is not. */
    expect(shouldReloadNow(true, RELOAD_GIVE_UP_MS + 1)).toBe(true);
  });
});
