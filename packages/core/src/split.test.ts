import { describe, expect, it } from 'vitest';
import {
  SplitError,
  groupPositions,
  splitExpense,
  suggestSettlements,
  type SplitInput,
} from './split.js';

const members = (...ids: string[]): SplitInput[] => ids.map((memberId) => ({ memberId }));
const total = (lines: readonly { amountMinor: number }[]): number =>
  lines.reduce((sum, line) => sum + line.amountMinor, 0);

describe('splitting a bill equally', () => {
  it('divides what divides', () => {
    const lines = splitExpense(300_000, 'EQUAL', members('a', 'b', 'c'));
    expect(lines.map((l) => l.amountMinor)).toEqual([100_000, 100_000, 100_000]);
  });

  it('loses nothing when it does not divide', () => {
    /* ৳1,000 three ways. The naive answer is three lots of 33,333 and one
       poisha on the floor — and the ledger's balance trigger refuses the whole
       transaction when that poisha goes missing. */
    const lines = splitExpense(100_000, 'EQUAL', members('a', 'b', 'c'));
    expect(total(lines)).toBe(100_000);
    expect(lines.map((l) => l.amountMinor)).toEqual([33_334, 33_333, 33_333]);
  });

  it('gives the same answer every time, so an edit does not reshuffle', () => {
    const once = splitExpense(100_001, 'EQUAL', members('a', 'b', 'c'));
    const twice = splitExpense(100_001, 'EQUAL', members('a', 'b', 'c'));
    expect(once).toEqual(twice);
  });

  it('never loses a poisha, for any amount and any number of people', () => {
    /* The assertion that matters most in this file. Exhaustive over a wide
       range rather than a few hand-picked cases: the failure mode is a single
       poisha at an awkward remainder, which is exactly what spot checks miss. */
    for (let people = 1; people <= 9; people += 1) {
      const input = members(...Array.from({ length: people }, (_, i) => `m${i}`));
      for (let amount = 1; amount <= 1000; amount += 1) {
        const lines = splitExpense(amount, 'EQUAL', input);
        expect(total(lines)).toBe(amount);
      }
      for (const amount of [99_999, 100_000, 100_001, 7_777_777, 123_456_789]) {
        expect(total(splitExpense(amount, 'EQUAL', input))).toBe(amount);
      }
    }
  });

  it('never differs between two people by more than one poisha', () => {
    const lines = splitExpense(100_000, 'EQUAL', members('a', 'b', 'c', 'd', 'e', 'f', 'g'));
    const amounts = lines.map((l) => l.amountMinor);
    expect(Math.max(...amounts) - Math.min(...amounts)).toBeLessThanOrEqual(1);
  });
});

describe('splitting by exact amounts', () => {
  it('takes the amounts as given', () => {
    const lines = splitExpense(300_000, 'EXACT', [
      { memberId: 'a', amountMinor: 200_000 },
      { memberId: 'b', amountMinor: 100_000 },
    ]);
    expect(lines.map((l) => l.amountMinor)).toEqual([200_000, 100_000]);
  });

  it('refuses parts that do not add up, rather than fixing them quietly', () => {
    /* Adjusting the last person's share to make the sum work is how somebody
       ends up owing a number nobody agreed to. */
    expect(() =>
      splitExpense(300_000, 'EXACT', [
        { memberId: 'a', amountMinor: 200_000 },
        { memberId: 'b', amountMinor: 99_999 },
      ]),
    ).toThrow(SplitError);
  });

  it('says how far out it is', () => {
    expect(() => splitExpense(300_000, 'EXACT', [{ memberId: 'a', amountMinor: 299_000 }])).toThrow(
      /1000 পয়সা/,
    );
  });
});

describe('splitting by percentage', () => {
  it('divides on basis points and keeps every poisha', () => {
    const lines = splitExpense(100_000, 'PERCENT', [
      { memberId: 'a', percentBps: 3333 },
      { memberId: 'b', percentBps: 3333 },
      { memberId: 'c', percentBps: 3334 },
    ]);
    expect(total(lines)).toBe(100_000);
    expect(lines[2]?.percentBps).toBe(3334);
  });

  it('refuses percentages that do not make a whole', () => {
    expect(() =>
      splitExpense(100_000, 'PERCENT', [
        { memberId: 'a', percentBps: 3333 },
        { memberId: 'b', percentBps: 3333 },
        { memberId: 'c', percentBps: 3333 },
      ]),
    ).toThrow(SplitError);
  });
});

describe('splitting by shares', () => {
  it('gives double to the double share', () => {
    const lines = splitExpense(300_000, 'SHARES', [
      { memberId: 'a', shareWeight: 2 },
      { memberId: 'b', shareWeight: 1 },
    ]);
    expect(lines.map((l) => l.amountMinor)).toEqual([200_000, 100_000]);
  });

  it('lets somebody be on the bill for nothing', () => {
    /* A child at the table, or somebody who was there but not eating. Zero is a
       real answer and must not be an error. */
    const lines = splitExpense(100_000, 'SHARES', [
      { memberId: 'a', shareWeight: 1 },
      { memberId: 'b', shareWeight: 0 },
    ]);
    expect(lines.map((l) => l.amountMinor)).toEqual([100_000, 0]);
  });

  it('refuses a split where nobody has a share', () => {
    expect(() =>
      splitExpense(100_000, 'SHARES', [
        { memberId: 'a', shareWeight: 0 },
        { memberId: 'b', shareWeight: 0 },
      ]),
    ).toThrow(SplitError);
  });
});

describe('refusals that protect the ledger', () => {
  it('refuses a zero or negative bill', () => {
    expect(() => splitExpense(0, 'EQUAL', members('a'))).toThrow(SplitError);
    expect(() => splitExpense(-100, 'EQUAL', members('a'))).toThrow(SplitError);
  });

  it('refuses a bill with nobody on it', () => {
    expect(() => splitExpense(100, 'EQUAL', [])).toThrow(SplitError);
  });

  it('refuses the same person twice', () => {
    expect(() => splitExpense(100, 'EQUAL', members('a', 'a'))).toThrow(SplitError);
  });
});

describe('who owes whom', () => {
  it('credits the payer and debits everybody on the bill', () => {
    const positions = groupPositions([
      {
        payerMemberId: 'me',
        shares: [
          { memberId: 'me', amountMinor: 75_000 },
          { memberId: 'karim', amountMinor: 75_000 },
        ],
      },
    ]);
    const net = new Map(positions.map((p) => [p.memberId, p.netMinor]));
    expect(net.get('me')).toBe(75_000);
    expect(net.get('karim')).toBe(-75_000);
  });

  it('always sums to zero — a group cannot be owed money by nobody', () => {
    const positions = groupPositions(
      [
        {
          payerMemberId: 'me',
          shares: [
            { memberId: 'me', amountMinor: 33_334 },
            { memberId: 'a', amountMinor: 33_333 },
            { memberId: 'b', amountMinor: 33_333 },
          ],
        },
        {
          payerMemberId: 'a',
          shares: [
            { memberId: 'me', amountMinor: 20_000 },
            { memberId: 'a', amountMinor: 20_000 },
          ],
        },
      ],
      [{ fromMemberId: 'b', toMemberId: 'me', amountMinor: 10_000 }],
    );
    expect(positions.reduce((sum, p) => sum + p.netMinor, 0)).toBe(0);
  });

  it('settles down to nothing once everybody has paid', () => {
    const positions = groupPositions(
      [
        {
          payerMemberId: 'me',
          shares: [
            { memberId: 'me', amountMinor: 50_000 },
            { memberId: 'karim', amountMinor: 50_000 },
          ],
        },
      ],
      [{ fromMemberId: 'karim', toMemberId: 'me', amountMinor: 50_000 }],
    );
    expect(positions.every((p) => p.netMinor === 0)).toBe(true);
  });
});

describe('settlement suggestions', () => {
  it('clears the group', () => {
    const positions = [
      { memberId: 'me', netMinor: 100_000 },
      { memberId: 'a', netMinor: -60_000 },
      { memberId: 'b', netMinor: -40_000 },
    ];
    const payments = suggestSettlements(positions);
    expect(payments).toEqual([
      { fromMemberId: 'a', toMemberId: 'me', amountMinor: 60_000 },
      { fromMemberId: 'b', toMemberId: 'me', amountMinor: 40_000 },
    ]);
  });

  it('needs fewer payments than there are pairs', () => {
    /* Four people who each owe two others is twelve transfers done naively.
       The bound that matters: never more than one payment per member less one. */
    const positions = [
      { memberId: 'a', netMinor: 30_000 },
      { memberId: 'b', netMinor: 20_000 },
      { memberId: 'c', netMinor: -25_000 },
      { memberId: 'd', netMinor: -25_000 },
    ];
    const payments = suggestSettlements(positions);
    expect(payments.length).toBeLessThanOrEqual(positions.length - 1);
    const moved = payments.reduce((sum, p) => sum + p.amountMinor, 0);
    expect(moved).toBe(50_000);
  });

  it('suggests nothing when everybody is square', () => {
    expect(suggestSettlements([{ memberId: 'a', netMinor: 0 }])).toEqual([]);
  });

  it('leaves nobody owing anything afterwards', () => {
    const positions = [
      { memberId: 'a', netMinor: 33_334 },
      { memberId: 'b', netMinor: -16_667 },
      { memberId: 'c', netMinor: -16_667 },
    ];
    const payments = suggestSettlements(positions);
    const after = new Map(positions.map((p) => [p.memberId, p.netMinor]));
    for (const payment of payments) {
      after.set(payment.fromMemberId, (after.get(payment.fromMemberId) ?? 0) + payment.amountMinor);
      after.set(payment.toMemberId, (after.get(payment.toMemberId) ?? 0) - payment.amountMinor);
    }
    expect([...after.values()].every((n) => n === 0)).toBe(true);
  });
});
