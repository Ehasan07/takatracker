import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';

/**
 * Refuse passwords that are already in somebody's breach dump.
 *
 * ## Why length was not enough
 *
 * The rule was eight characters and nothing else, which is the *right* shape —
 * NIST 800-63B tells verifiers to drop composition rules, forced rotation and
 * hints, all of which push people toward `Password1!` and a sticky note. But
 * the same document is equally clear about the other half (§5.1.1.2): a
 * verifier SHALL check a new secret against a list of values known to be
 * compromised. Only half of that was implemented, and the consequence was
 * literal: `password` opened a real account on the live site, with eight
 * characters, and it is the single most-breached string there is.
 *
 * ## Why the password does not leave this process
 *
 * Have I Been Pwned's range API takes the *first five characters* of the
 * SHA-1 hash and answers with every suffix it holds under that prefix —
 * hundreds of them. The match is done here, locally. The service is told five
 * hex characters, which about eight hundred passwords in a billion share, and
 * learns nothing about which one was asked for. Sending a password, or even a
 * whole hash, to a third party to check whether it is safe would be a strange
 * way to protect it.
 *
 * SHA-1 here is not a security choice and is not protecting anything — it is
 * the index HIBP is keyed on. The password's real hash is argon2id, elsewhere.
 *
 * ## Why it fails open
 *
 * If HIBP is slow, down, or blocked by the host's egress rules, this returns
 * "not known to be breached" and the signup proceeds. A third party being
 * unreachable must never be the reason somebody cannot open an account, and the
 * local list below still catches the passwords that actually get typed.
 */

/**
 * What the three call sites say when they refuse.
 *
 * It names the reason rather than inventing a rule. "Must contain a symbol"
 * teaches somebody to add `!` to the end of the password they already use;
 * "this one is in a breach list" is the only sentence that leads to a
 * different password.
 */
export const BREACHED_PASSWORD_MESSAGE =
  'এই পাসওয়ার্ডটি আগে ফাঁস হওয়া তালিকায় আছে — অন্য একটি দিন';

/** Enough to be worth waiting for, short enough not to hold up a signup. */
const TIMEOUT_MS = 2_000;

/**
 * The floor, for when the network is not there.
 *
 * Not a serious list — HIBP holds hundreds of millions — but these are the ones
 * that turn up first in a credential-stuffing run, and this is what stands
 * between an offline deploy and `123456`. Bangladeshi keyboard-walk favourites
 * are in here beside the global ones.
 */
const ALWAYS_REFUSED = new Set(
  [
    'password',
    'password1',
    'password123',
    'passw0rd',
    '12345678',
    '123456789',
    '1234567890',
    'qwertyuiop',
    'qwerty123',
    'iloveyou',
    'welcome1',
    'admin123',
    'abc12345',
    'letmein1',
    'bangladesh',
    'dhaka1234',
    'bismillah',
    'takatracker',
    'hishab123',
  ].map((value) => value.toLowerCase()),
);

@Injectable()
export class BreachedPasswordService {
  private readonly logger = new Logger(BreachedPasswordService.name);

  /**
   * True when the password is known to be compromised.
   *
   * Never throws. A caller deciding whether to accept a signup should not have
   * to think about what happens when an external service misbehaves.
   */
  async isBreached(password: string): Promise<boolean> {
    if (ALWAYS_REFUSED.has(password.toLowerCase())) return true;
    if (process.env.HIBP_DISABLED === '1') return false;

    const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    try {
      const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: {
          /* Asks HIBP to pad the response with random rows, so the *size* of
             the answer does not hint at how many matches the prefix has. */
          'Add-Padding': 'true',
          'User-Agent': 'taka-tracker',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) return false;

      const body = await response.text();
      for (const line of body.split('\n')) {
        const [candidate, count] = line.trim().split(':');
        /* The padded rows come back with a count of zero. A real hit has a
           count, and any count at all means the password is in a dump. */
        if (candidate === suffix && count !== '0') return true;
      }
      return false;
    } catch (err) {
      /* Fail open, loudly in the log. The alternative is refusing to let
         somebody open an account because a service in another country is
         having a bad afternoon. */
      this.logger.warn(`Breach check unavailable: ${(err as Error).message}`);
      return false;
    }
  }
}
