import { normaliseBdPhone } from './phone.js';

/**
 * What makes two records the same person.
 *
 * ## Why not the name
 *
 * Two people called করিম are two people. The split screen used to create a
 * member from a typed name and nothing else, so adding করিম to a trip made a
 * second করিম beside the one who had borrowed money last year — two rows, two
 * balances, and no screen that showed the ৳7,000 he actually owed. A name is
 * not an identity; a number is.
 *
 * ## Two keys, and why both are stored rather than derived
 *
 * `Person.phone` keeps whatever was typed, because that is the best record of
 * how to reach somebody — a landline, an extension, a number with a note beside
 * it. `phoneKey` is the same number reduced to one spelling, and it is what the
 * unique index is on. Deriving the key at query time instead would mean either
 * scanning every row or an expression index that has to be repeated at every
 * call site; storing it makes "is this the same person" a lookup.
 *
 * Email is the second key because a colleague may have no Bangladeshi mobile
 * and an office group still has to reach them.
 */

export interface PersonIdentityInput {
  phone?: string | null;
  email?: string | null;
}

export interface PersonIdentityKeys {
  /** `01XXXXXXXXX`, or null when what was typed is not a recognisable mobile. */
  phoneKey: string | null;
  /** Lower-cased and trimmed, or null. */
  email: string | null;
}

/**
 * The keys for one person.
 *
 * Anything that is not a recognisable Bangladeshi mobile yields a null key
 * rather than a guess. A half-typed number must not claim to be an identity: a
 * wrong match silently merges two people's money, which is far worse than no
 * match at all.
 */
export function personIdentityKeys(input: PersonIdentityInput): PersonIdentityKeys {
  return {
    phoneKey: normaliseBdPhone(input.phone ?? null),
    email: normaliseEmail(input.email),
  };
}

export function normaliseEmail(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim().toLowerCase();
  /* Shape-checked rather than merely non-empty: an index that treats "karim"
     as an identity would match the next person who typed the same word into
     the wrong box. */
  if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

/** True when the two carry a key in common, and so are the same person. */
export function sameIdentity(a: PersonIdentityKeys, b: PersonIdentityKeys): boolean {
  if (a.phoneKey && a.phoneKey === b.phoneKey) return true;
  if (a.email && a.email === b.email) return true;
  return false;
}
