import { describe, expect, it } from 'vitest';
import { SERIES_COLOURS } from '@/components/charts/palette';
import {
  childSeeds,
  flatSeeds,
  focusedNode,
  parentSeeds,
  resolveSlicing,
  toSlices,
  viewParams,
  type Slicing,
} from './slicer';
import type { ByCategoryDto, CategoryNode } from './types';

const range = { preset: 'thisMonth', from: '2026-08-01', to: '2026-08-31' } as const;
const slicing = (patch: Partial<Slicing> = {}): Slicing => ({
  kind: 'EXPENSE',
  by: 'parent',
  focus: null,
  ...patch,
});

const seed = (name: string, minor: number) => ({ key: name, name, minor });

describe('reading the URL', () => {
  it('answers the default view for a URL that says nothing', () => {
    expect(resolveSlicing(new URLSearchParams())).toEqual({
      kind: 'EXPENSE',
      by: 'parent',
      focus: null,
    });
  });

  it('reads a view somebody arranged back out of the query string', () => {
    const read = resolveSlicing(new URLSearchParams('kind=INCOME&by=detail'));
    expect(read).toEqual({ kind: 'INCOME', by: 'detail', focus: null });
  });

  it('falls back to the default cut rather than refusing a mangled link', () => {
    expect(resolveSlicing(new URLSearchParams('by=sideways')).by).toBe('parent');
  });

  it('drops a focus that the chosen cut cannot show', () => {
    /* উপ-খাত has no parents in it to be opened, so a `focus` carried over from
       the other cut would be a piece of state nothing on screen reflects. */
    expect(resolveSlicing(new URLSearchParams('by=detail&focus=abc')).focus).toBeNull();
    expect(resolveSlicing(new URLSearchParams('by=parent&focus=abc')).focus).toBe('abc');
  });
});

describe('writing the URL', () => {
  it('writes nothing extra for the view somebody has not changed', () => {
    /* A link made today with nothing touched has to be the link this screen was
       making before any of this existed. */
    expect(viewParams(range, slicing()).toString()).toBe('preset=thisMonth');
  });

  it('carries every choice that is not the default', () => {
    const params = viewParams(range, slicing({ kind: 'INCOME', by: 'detail' }));
    expect(params.get('kind')).toBe('INCOME');
    expect(params.get('by')).toBe('detail');
    expect(params.get('focus')).toBeNull();
  });

  it('round-trips a focused ring', () => {
    const written = viewParams(range, slicing({ focus: 'cat-1' }));
    expect(resolveSlicing(written)).toEqual(slicing({ focus: 'cat-1' }));
  });
});

describe('the rows a ring is built from', () => {
  it('sorts largest first and hands out the palette in that order', () => {
    const rows = toSlices([seed('a', 100), seed('b', 900), seed('c', 500)], 'অন্যান্য');
    expect(rows.map((row) => row.name)).toEqual(['b', 'c', 'a']);
    expect(rows.map((row) => row.colour)).toEqual([
      SERIES_COLOURS[0],
      SERIES_COLOURS[1],
      SERIES_COLOURS[2],
    ]);
  });

  it('folds everything past the seventh into one row that keeps its money', () => {
    const rows = toSlices(
      Array.from({ length: 12 }, (_, i) => seed(`c${i}`, (12 - i) * 100)),
      'অন্যান্য',
    );
    expect(rows).toHaveLength(8);

    const rest = rows[7]!;
    expect(rest.rest).toBe(true);
    expect(rest.name).toBe('অন্যান্য');
    /* The five it replaced: 500 + 400 + 300 + 200 + 100. Nothing is dropped,
       which is the only reason folding is allowed at all. */
    expect(rest.minor).toBe(1500);
    expect(rows.reduce((sum, row) => sum + row.minor, 0)).toBe(7800);
  });

  it('never repeats a colour, because there is no eighth series colour', () => {
    const rows = toSlices(
      Array.from({ length: 12 }, (_, i) => seed(`c${i}`, (12 - i) * 100)),
      'অন্যান্য',
    );
    expect(new Set(rows.map((row) => row.colour)).size).toBe(rows.length);
  });

  it('adds up to a hundred per cent, folded tail included', () => {
    const rows = toSlices(
      Array.from({ length: 10 }, (_, i) => seed(`c${i}`, (i + 1) * 137)),
      'অন্যান্য',
    );
    const total = rows.reduce((sum, row) => sum + row.percent, 0);
    expect(total).toBeGreaterThan(99.5);
    expect(total).toBeLessThan(100.5);
  });

  it('leaves out a category with nothing in it', () => {
    const rows = toSlices([seed('a', 0), seed('b', 700)], 'অন্যান্য');
    expect(rows.map((row) => row.name)).toEqual(['b']);
  });
});

describe('opening a parent up', () => {
  const node: CategoryNode = {
    categoryId: 'travel',
    name: 'যাতায়াত',
    totalMinor: 1000,
    rolledUpMinor: 4000,
    children: [
      { categoryId: 'bus', name: 'বাস', totalMinor: 2000 },
      { categoryId: 'rickshaw', name: 'রিকশা', totalMinor: 1000 },
    ],
  };

  it('keeps the money spent on the parent itself as its own slice', () => {
    /* Without it the ring would total ৳3,000 while the row that was tapped said
       ৳4,000 — the exact mismatch the donut is built to make impossible. */
    const seeds = childSeeds(node, 'সরাসরি {name}');
    expect(seeds.map((s) => s.minor).reduce((a, b) => a + b, 0)).toBe(node.rolledUpMinor);
    expect(seeds.at(-1)!.name).toBe('সরাসরি যাতায়াত');
  });

  it('gives that slice nowhere to drill, because it is not the category', () => {
    const direct = childSeeds(node, 'সরাসরি {name}').at(-1)!;
    expect(direct.categoryId).toBeNull();
  });

  it('leaves it out when the parent has no spending of its own', () => {
    const seeds = childSeeds({ ...node, totalMinor: 0, rolledUpMinor: 3000 }, 'সরাসরি {name}');
    expect(seeds).toHaveLength(2);
  });
});

describe('the other two shapes', () => {
  const data: ByCategoryDto = {
    total: 4000,
    nodes: [
      {
        categoryId: 'travel',
        name: 'যাতায়াত',
        totalMinor: 1000,
        rolledUpMinor: 4000,
        children: [{ categoryId: 'bus', name: 'বাস', totalMinor: 3000 }],
      },
      { categoryId: 'rent', name: 'বাসা ভাড়া', totalMinor: 900, rolledUpMinor: 900, children: [] },
    ],
  };

  it('marks only the parents that have something inside them', () => {
    expect(parentSeeds(data).map((s) => s.drillable ?? false)).toEqual([true, false]);
  });

  it('names the parent under a sub-category so two "বাস" rows can be told apart', () => {
    const seeds = flatSeeds([
      { categoryId: 'bus', name: 'বাস', totalMinor: 3000, parentName: 'যাতায়াত' },
      { categoryId: 'rent', name: 'বাসা ভাড়া', totalMinor: 900 },
    ]);
    expect(seeds[0]!.hint).toBe('যাতায়াত');
    expect(seeds[1]!.hint).toBeUndefined();
  });

  it('finds the focused parent, and shrugs when the period has not got it', () => {
    expect(focusedNode(data, 'travel')?.name).toBe('যাতায়াত');
    expect(focusedNode(data, 'gone')).toBeNull();
    expect(focusedNode(undefined, 'travel')).toBeNull();
  });
});
