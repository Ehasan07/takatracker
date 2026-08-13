import { sumMinor } from '@hishab/shared';

/**
 * Dividing one bill between several people.
 *
 * ## Why this is arithmetic worth its own file and its own tests
 *
 * ৳1,000 split three ways is 33,333 poisha each and one poisha left over.
 * Software that ignores it produces three shares that add up to ৳999.99, and in
 * this product that is not a cosmetic problem: the owner's ledger entry is
 * built from these numbers, the database trigger checks debits against credits
 * at COMMIT, and a missing poisha means the whole transaction is refused. The
 * right failure, and a terrible thing to discover while somebody is standing at
 * a restaurant counter.
 *
 * So the remainder is *distributed*, never dropped, by the largest-remainder
 * method — the standard approach, and the one an accountant would recognise:
 * give everybody the floor of their exact share, then hand the leftover poisha
 * one at a time to whoever was cut by the most. Ties break on the member order
 * given, which the caller keeps stable, so the same bill always divides the
 * same way and an edit does not silently reshuffle who owes what.
 *
 * Every function here is pure and works in integer poisha. Nothing rounds with
 * `Math.round` — the repository bans it, for the reason this file exists.
 */

export type SplitMethod = 'EQUAL' | 'EXACT' | 'PERCENT' | 'SHARES';

export interface SplitInput {
  /** Stable identifier — a group member id. Order decides tie-breaks. */
  memberId: string;
  /** EXACT: this member's amount in poisha. */
  amountMinor?: number;
  /** PERCENT: basis points. 33.33% is 3333. */
  percentBps?: number;
  /** SHARES: a weight. Two shares against one is "eats double". */
  shareWeight?: number;
}

export interface SplitLine {
  memberId: string;
  amountMinor: number;
  percentBps?: number;
  shareWeight?: number;
}

export class SplitError extends Error {}

/** Basis points in a whole. */
const FULL_BPS = 10_000;

/**
 * Hand out `totalMinor` in proportion to `weights`, losing nothing.
 *
 * The core of every method below. Each party gets the floor of its exact share;
 * the poisha left over go one each to the largest fractional remainders, ties
 * broken by position. The result always sums to exactly `totalMinor`.
 */
function distribute(totalMinor: number, weights: readonly number[]): number[] {
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight <= 0) throw new SplitError('ভাগ করার মতো কিছু নেই');

  const floors: number[] = [];
  const remainders: { index: number; remainder: number }[] = [];

  for (let i = 0; i < weights.length; i += 1) {
    /* Integer arithmetic throughout: `exact` is the numerator of
       amount × weight / totalWeight, so the floor and the remainder are both
       exact and no float ever touches the money. */
    const numerator = totalMinor * (weights[i] as number);
    const floor = Math.floor(numerator / totalWeight);
    floors.push(floor);
    remainders.push({ index: i, remainder: numerator - floor * totalWeight });
  }

  let left = totalMinor - floors.reduce((sum, n) => sum + n, 0);
  /* Largest remainder first; a tie goes to whoever came first in the list the
     caller gave, which is stable across edits. */
  remainders.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const entry of remainders) {
    if (left <= 0) break;
    floors[entry.index] = (floors[entry.index] as number) + 1;
    left -= 1;
  }

  return floors;
}

/**
 * Divide a bill, whichever way the group chose.
 *
 * Throws rather than silently correcting: an EXACT split whose parts do not add
 * up is a mistake somebody made on the form, and quietly adjusting the last
 * person's share to make it fit is how a person ends up owing a number nobody
 * agreed to.
 */
export function splitExpense(
  totalMinor: number,
  method: SplitMethod,
  inputs: readonly SplitInput[],
): SplitLine[] {
  if (!Number.isInteger(totalMinor) || totalMinor <= 0) {
    throw new SplitError('টাকার অঙ্ক শূন্যের চেয়ে বেশি হতে হবে');
  }
  if (inputs.length === 0) throw new SplitError('অন্তত একজনকে বেছে নিন');

  const seen = new Set<string>();
  for (const input of inputs) {
    if (seen.has(input.memberId)) throw new SplitError('একই ব্যক্তি দুইবার আছে');
    seen.add(input.memberId);
  }

  switch (method) {
    case 'EQUAL': {
      const amounts = distribute(
        totalMinor,
        inputs.map(() => 1),
      );
      return inputs.map((input, i) => ({
        memberId: input.memberId,
        amountMinor: amounts[i] as number,
      }));
    }

    case 'EXACT': {
      const amounts = inputs.map((input) => input.amountMinor ?? 0);
      for (const amount of amounts) {
        if (!Number.isInteger(amount) || amount < 0) {
          throw new SplitError('প্রত্যেকের ভাগ শূন্য বা তার বেশি পূর্ণসংখ্যা হতে হবে');
        }
      }
      const given = sumMinor(amounts);
      if (given !== totalMinor) {
        throw new SplitError(
          `ভাগগুলো যোগ করলে মোট টাকার সমান হচ্ছে না — পার্থক্য ${Math.abs(totalMinor - given)} পয়সা`,
        );
      }
      return inputs.map((input, i) => ({
        memberId: input.memberId,
        amountMinor: amounts[i] as number,
      }));
    }

    case 'PERCENT': {
      const bps = inputs.map((input) => input.percentBps ?? 0);
      for (const value of bps) {
        if (!Number.isInteger(value) || value < 0) {
          throw new SplitError('শতাংশ শূন্য বা তার বেশি হতে হবে');
        }
      }
      const total = bps.reduce((sum, n) => sum + n, 0);
      if (total !== FULL_BPS) {
        throw new SplitError('শতাংশগুলো যোগ করলে ১০০% হতে হবে');
      }
      /* Distributed on the basis points rather than multiplied out one by one:
         33.33% three times is 99.99% of the money and one poisha adrift, and
         the caller has already been told the percentages must total 100. */
      const amounts = distribute(totalMinor, bps);
      return inputs.map((input, i) => ({
        memberId: input.memberId,
        amountMinor: amounts[i] as number,
        percentBps: bps[i] as number,
      }));
    }

    case 'SHARES': {
      const weights = inputs.map((input) => input.shareWeight ?? 1);
      for (const weight of weights) {
        if (!Number.isInteger(weight) || weight < 0) {
          throw new SplitError('ভাগের সংখ্যা শূন্য বা তার বেশি পূর্ণসংখ্যা হতে হবে');
        }
      }
      const amounts = distribute(totalMinor, weights);
      return inputs.map((input, i) => ({
        memberId: input.memberId,
        amountMinor: amounts[i] as number,
        shareWeight: weights[i] as number,
      }));
    }

    default: {
      const exhaustive: never = method;
      throw new SplitError(`অজানা ভাগের নিয়ম: ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Who owes whom
// ---------------------------------------------------------------------------

export interface MemberPosition {
  memberId: string;
  /** Positive: this member is owed money. Negative: they owe it. */
  netMinor: number;
}

export interface SharedExpenseFact {
  payerMemberId: string;
  shares: readonly { memberId: string; amountMinor: number }[];
}

export interface SettlementFact {
  fromMemberId: string;
  toMemberId: string;
  amountMinor: number;
}

/**
 * Every member's standing in a group.
 *
 * Paying puts a member up by what they laid out; being on a bill puts them down
 * by their share; a settlement moves the two closer. The positions always sum
 * to zero — a group cannot collectively be owed money — and that is asserted in
 * the tests, because it is the invariant that catches a mistake anywhere else
 * in this file.
 */
export function groupPositions(
  expenses: readonly SharedExpenseFact[],
  settlements: readonly SettlementFact[] = [],
): MemberPosition[] {
  const net = new Map<string, number>();
  const bump = (memberId: string, delta: number): void => {
    net.set(memberId, (net.get(memberId) ?? 0) + delta);
  };

  for (const expense of expenses) {
    const paid = sumMinor(expense.shares.map((s) => s.amountMinor));
    bump(expense.payerMemberId, paid);
    for (const share of expense.shares) bump(share.memberId, -share.amountMinor);
  }

  for (const settlement of settlements) {
    /* Paying somebody reduces what you owe and reduces what they are owed. */
    bump(settlement.fromMemberId, settlement.amountMinor);
    bump(settlement.toMemberId, -settlement.amountMinor);
  }

  return [...net.entries()].map(([memberId, netMinor]) => ({ memberId, netMinor }));
}

export interface SuggestedPayment {
  fromMemberId: string;
  toMemberId: string;
  amountMinor: number;
}

/**
 * The fewest payments that clear a group.
 *
 * Greedy: the biggest debtor pays the biggest creditor as much as the smaller
 * of the two, and repeat. That is not provably minimal — the general problem is
 * NP-hard — but it never needs more than one payment per member less one, which
 * is the bound anybody actually cares about, and it is what every app doing
 * this uses.
 *
 * **Suggestions only.** Nothing here is posted. Simplifying debts changes who
 * owes whom — if Karim owes Rahim and Rahim owes you, the tidy answer is Karim
 * paying you directly, and that is a rearrangement of three people's
 * obligations that software must not make on their behalf. The screen offers
 * it; a person confirms it; only then does anything reach a ledger.
 */
export function suggestSettlements(positions: readonly MemberPosition[]): SuggestedPayment[] {
  const debtors = positions
    .filter((p) => p.netMinor < 0)
    .map((p) => ({ memberId: p.memberId, amount: -p.netMinor }))
    .sort((a, b) => b.amount - a.amount || a.memberId.localeCompare(b.memberId));
  const creditors = positions
    .filter((p) => p.netMinor > 0)
    .map((p) => ({ memberId: p.memberId, amount: p.netMinor }))
    .sort((a, b) => b.amount - a.amount || a.memberId.localeCompare(b.memberId));

  const payments: SuggestedPayment[] = [];
  let i = 0;
  let j = 0;

  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i] as { memberId: string; amount: number };
    const creditor = creditors[j] as { memberId: string; amount: number };
    const amount = Math.min(debtor.amount, creditor.amount);

    if (amount > 0) {
      payments.push({
        fromMemberId: debtor.memberId,
        toMemberId: creditor.memberId,
        amountMinor: amount,
      });
    }

    debtor.amount -= amount;
    creditor.amount -= amount;
    if (debtor.amount === 0) i += 1;
    if (creditor.amount === 0) j += 1;
  }

  return payments;
}
