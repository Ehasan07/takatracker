import { describe, expect, it } from 'vitest';
import { RING_RADIUS, ringArcs, sharePercent } from './arc';

/**
 * The geometry a donut is drawn from. Worth testing without a browser because
 * every one of these is a way a ring can quietly stop meaning what it shows:
 * arcs that do not go all the way round, a total that is not the sum of the
 * parts, a slice too small to draw shaved to nothing, or a `NaN` from an empty
 * month reaching the DOM as `stroke-dasharray="NaN"`.
 */
describe('the ring', () => {
  it('is exactly a hundred units round, which is what makes a dash a percent', () => {
    expect(2 * Math.PI * RING_RADIUS).toBeCloseTo(100, 10);
  });

  it('starts each arc where the last one ended, all the way round', () => {
    const arcs = ringArcs([1000, 3000, 6000]);
    expect(arcs.map((arc) => arc.offset)).toEqual([0, 10, 40]);
    /* The last arc's start plus its full share is the whole ring: the gaps come
       out of the dashes, never out of the spacing, so nothing drifts. */
    expect(arcs[2]!.offset + 60).toBe(100);
  });

  it('leaves a gap between neighbours without ever drawing one longer than it is', () => {
    const arcs = ringArcs([1, 1, 1, 1]);
    for (const arc of arcs) {
      expect(arc.dash).toBeLessThan(25);
      expect(arc.dash).toBeGreaterThan(23);
    }
  });

  it('draws a lone slice as a whole ring', () => {
    /* A notch in a single-category month reads as missing data, and there is no
       neighbour for it to be separated from. */
    expect(ringArcs([4200])[0]!.dash).toBe(100);
  });

  it('keeps a sliver at its true length rather than shaving it away', () => {
    const [sliver] = ringArcs([10, 999_990]);
    expect(sliver!.dash).toBeCloseTo(0.001, 6);
  });

  it('answers an empty period with zeroes and not with NaN', () => {
    const arcs = ringArcs([0, 0]);
    expect(arcs).toEqual([
      { dash: 0, offset: 0, percent: 0 },
      { dash: 0, offset: 0, percent: 0 },
    ]);
  });

  it('treats a negative as absent rather than as a reversed arc', () => {
    const arcs = ringArcs([-500, 500]);
    expect(arcs[0]!.dash).toBe(0);
    expect(arcs[1]!.dash).toBe(100);
  });
});

describe('a share', () => {
  it('rounds half up to one decimal place', () => {
    expect(sharePercent(1, 3)).toBe(33.3);
    expect(sharePercent(2, 3)).toBe(66.7);
    expect(sharePercent(1, 8)).toBe(12.5);
  });

  it('is zero, not a division by zero, on a month with nothing in it', () => {
    expect(sharePercent(0, 0)).toBe(0);
    expect(sharePercent(500, 0)).toBe(0);
  });

  it('adds up to a hundred across a whole ring', () => {
    const parts = [12_345, 67_890, 1_000, 45_000];
    const total = parts.reduce((sum, part) => sum + part, 0);
    const sum = parts.reduce((running, part) => running + sharePercent(part, total), 0);
    expect(sum).toBeGreaterThan(99.8);
    expect(sum).toBeLessThan(100.2);
  });
});
