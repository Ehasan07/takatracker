import { describe, expect, it } from 'vitest';
import { MAX_SERIES, REST_COLOUR, SERIES_COLOURS } from '@/components/charts/palette';
import { toSlices, type SpendRow } from './spend-split';

const row = (name: string, totalMinor: number, categoryId = name): SpendRow => ({
  categoryId,
  name,
  totalMinor,
});

describe('toSlices', () => {
  it('orders by amount, so the palette is assigned to neighbours as it promises', () => {
    const slices = toSlices([row('ক', 100), row('খ', 900), row('গ', 500)], 'অন্যান্য');
    expect(slices.map((s) => s.label)).toEqual(['খ', 'গ', 'ক']);
    expect(slices.map((s) => s.colour)).toEqual(SERIES_COLOURS.slice(0, 3));
  });

  it('never asks the palette for an eighth colour', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(`খাত ${i}`, (12 - i) * 100));
    const slices = toSlices(rows, 'অন্যান্য');

    expect(slices).toHaveLength(MAX_SERIES + 1);
    expect(slices.at(-1)!.label).toBe('অন্যান্য');
    expect(slices.at(-1)!.colour).toBe(REST_COLOUR);
    expect(new Set(slices.map((s) => s.colour)).size).toBe(slices.length);
  });

  it('loses no poisha to the fold', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(`খাত ${i}`, i * 137 + 11));
    const before = rows.reduce((sum, r) => sum + r.totalMinor, 0);
    const after = toSlices(rows, 'অন্যান্য').reduce((sum, s) => sum + s.minor, 0);
    /* The centre of the donut is the sum of the ring, so a taka dropped here is
       a headline that disagrees with the rest of the screen. */
    expect(after).toBe(before);
  });

  it('drops rows a ring cannot draw', () => {
    expect(toSlices([row('ক', 0), row('খ', -500), row('গ', 100)], 'অন্যান্য')).toHaveLength(1);
  });

  it('gives the unfiled bucket a key of its own', () => {
    const slices = toSlices([{ categoryId: null, name: 'খাত ছাড়া', totalMinor: 400 }], 'অন্যান্য');
    expect(slices[0]!.key).toBe(' unfiled');
  });
});
