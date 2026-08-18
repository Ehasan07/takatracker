import { describe, expect, it } from 'vitest';
import { movers } from './movers-panel';
import type { CategoryNodeDto } from './queries';

const node = (id: string | null, name: string, rolledUpMinor: number): CategoryNodeDto => ({
  categoryId: id,
  name,
  totalMinor: rolledUpMinor,
  rolledUpMinor,
});

describe('movers', () => {
  it('sorts by the size of the movement, either direction', () => {
    const rows = movers(
      [node('a', 'যাতায়াত', 5_000_00), node('b', 'খাবার', 10_000_00)],
      [node('a', 'যাতায়াত', 1_000_00), node('b', 'খাবার', 9_500_00)],
    );
    /* খাবার is the bigger *total* and যাতায়াত is the bigger *change*, which is
       the whole point of this panel. */
    expect(rows.map((row) => row.name)).toEqual(['যাতায়াত', 'খাবার']);
    expect(rows[0]!.deltaMinor).toBe(400_000);
  });

  it('keeps a category that only one of the two months has', () => {
    const rows = movers([node('a', 'চিকিৎসা', 12_000_00)], [node('b', 'উৎসব', 8_000_00)]);
    expect(rows).toEqual([
      { key: 'a', name: 'চিকিৎসা', nowMinor: 1_200_000, beforeMinor: 0, deltaMinor: 1_200_000 },
      { key: 'b', name: 'উৎসব', nowMinor: 0, beforeMinor: 800_000, deltaMinor: -800_000 },
    ]);
  });

  it('drops the categories that did not move', () => {
    expect(
      movers([node('a', 'বাড়িভাড়া', 15_000_00)], [node('a', 'বাড়িভাড়া', 15_000_00)]),
    ).toEqual([]);
  });

  it('treats the unfiled bucket as one row, not one per month', () => {
    const rows = movers([node(null, 'খাত ছাড়া', 900_00)], [node(null, 'খাত ছাড়া', 300_00)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deltaMinor).toBe(60_000);
  });

  it('subtracts in poisha and stays an integer', () => {
    const rows = movers([node('a', 'খাবার', 1_234_57)], [node('a', 'খাবার', 1_000_01)]);
    expect(rows[0]!.deltaMinor).toBe(23_456);
    expect(Number.isInteger(rows[0]!.deltaMinor)).toBe(true);
  });
});
