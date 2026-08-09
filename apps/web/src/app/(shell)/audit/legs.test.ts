/**
 * The pairing that makes a transaction edit readable.
 *
 * An edit deletes every ledger leg and writes them again, so the raw payloads
 * always look like "everything removed, everything added". If these cases stop
 * passing, the audit screen stops answering the one question it exists for —
 * "what did this say before somebody changed it?" — and starts reporting a
 * category rename as two unrelated lines.
 */

import { describe, expect, it } from 'vitest';
import { diffLegs, type Leg } from './types';

const leg = (
  accountId: string,
  categoryId: string | null,
  direction: string,
  amountMinor: number,
): Leg => ({ accountId, categoryId, direction, amountMinor });

describe('diffLegs', () => {
  it('reports nothing when both sides are identical', () => {
    const legs = [leg('acc-a', 'cat-x', 'DEBIT', 50_000), leg('acc-b', null, 'CREDIT', 50_000)];
    const diff = diffLegs(legs, [...legs]);

    expect(diff.changed).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.added).toHaveLength(0);
    expect(diff.unchanged).toBe(2);
  });

  it('reads a category move as one changed leg, not a delete plus an insert', () => {
    const diff = diffLegs(
      [leg('acc-a', 'cat-groceries', 'DEBIT', 50_000), leg('acc-b', null, 'CREDIT', 50_000)],
      [leg('acc-a', 'cat-fuel', 'DEBIT', 50_000), leg('acc-b', null, 'CREDIT', 50_000)],
    );

    expect(diff.unchanged).toBe(1);
    expect(diff.removed).toHaveLength(0);
    expect(diff.added).toHaveLength(0);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.from.categoryId).toBe('cat-groceries');
    expect(diff.changed[0]?.to.categoryId).toBe('cat-fuel');
  });

  it('pairs both sides of an amount change by account', () => {
    const diff = diffLegs(
      [leg('acc-a', 'cat-x', 'DEBIT', 50_000), leg('acc-b', null, 'CREDIT', 50_000)],
      [leg('acc-a', 'cat-x', 'DEBIT', 60_000), leg('acc-b', null, 'CREDIT', 60_000)],
    );

    expect(diff.changed).toHaveLength(2);
    expect(diff.removed).toHaveLength(0);
    expect(diff.added).toHaveLength(0);
    expect(diff.changed.map((pair) => pair.from.amountMinor)).toEqual([50_000, 50_000]);
    expect(diff.changed.map((pair) => pair.to.amountMinor)).toEqual([60_000, 60_000]);
  });

  it('keeps a genuinely new leg as an addition', () => {
    const diff = diffLegs(
      [leg('acc-a', 'cat-x', 'DEBIT', 50_000), leg('acc-b', null, 'CREDIT', 50_000)],
      [
        leg('acc-a', 'cat-x', 'DEBIT', 50_000),
        leg('acc-b', null, 'CREDIT', 50_000),
        leg('acc-c', 'cat-y', 'DEBIT', 10_000),
      ],
    );

    expect(diff.unchanged).toBe(2);
    expect(diff.changed).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]?.accountId).toBe('acc-c');
  });

  it('keeps the written order of the legs it pairs up', () => {
    const diff = diffLegs(
      [
        leg('acc-a', 'cat-1', 'DEBIT', 10_000),
        leg('acc-b', 'cat-2', 'DEBIT', 20_000),
        leg('acc-c', 'cat-3', 'DEBIT', 30_000),
      ],
      [
        leg('acc-a', 'cat-1b', 'DEBIT', 10_000),
        leg('acc-b', 'cat-2b', 'DEBIT', 20_000),
        leg('acc-c', 'cat-3b', 'DEBIT', 30_000),
      ],
    );

    expect(diff.changed.map((pair) => pair.from.accountId)).toEqual(['acc-a', 'acc-b', 'acc-c']);
  });

  it('survives a payload with no legs at all', () => {
    const diff = diffLegs([], []);
    expect(diff).toEqual({ changed: [], removed: [], added: [], unchanged: 0 });
  });
});
