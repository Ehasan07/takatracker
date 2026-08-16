import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODES, THEMES, type Mode, type Theme } from '@/lib/theme';

/**
 * The four palettes, read off the stylesheet rather than a copy of it.
 *
 * A palette is data, and data with eight faces and thirteen colours each is
 * exactly the kind of thing that is right on the day it is written and wrong
 * two months later, when somebody nudges one hex and quietly drops a caption
 * below 4.5:1. Nothing in a browser complains about that, and nobody notices
 * until a reader with ordinary middle-aged eyes gives up on a screen.
 *
 * So this parses `tokens.css` itself. It is deliberately not a fixture: if the
 * stylesheet and the test can disagree, the test is checking the wrong thing.
 */

const TOKENS = readFileSync(
  join(process.cwd(), '..', '..', 'packages', 'ui', 'src', 'tokens.css'),
  'utf8',
);

/** Every colour a face has to name. Missing one means inheriting another
 *  palette's — a stray blue in the black-and-white theme, and no error. */
const COLOUR_TOKENS = [
  'ink',
  'ink-muted',
  'paper',
  'surface',
  'greenbar',
  'rule',
  'brand',
  'brand-strong',
  'brand-soft',
  'brand-tint',
  'brand-contrast',
  'income',
  'expense',
  'brass',
] as const;

type Palette = Record<string, string>;

/**
 * The declarations of one selector block.
 *
 * A regular expression rather than a CSS parser because the shape here is
 * known and flat: no nesting inside these blocks, no `}` inside a value.
 */
function block(selector: string): Palette {
  const at = TOKENS.indexOf(`${selector} {`);
  expect(at, `no block for ${selector}`).toBeGreaterThan(-1);
  const body = TOKENS.slice(at, TOKENS.indexOf('}', at));
  const out: Palette = {};
  for (const match of body.matchAll(/--hishab-([a-z-]+):\s*(#[0-9a-f]{6})\s*;/g)) {
    out[match[1]!] = match[2]!;
  }
  return out;
}

function faceOf(theme: Theme, mode: Exclude<Mode, 'system'>): Palette {
  if (theme === 'default')
    return mode === 'light' ? block(':root') : block(":root[data-mode='dark']");
  const selector =
    mode === 'light'
      ? `:root[data-theme='${theme}']`
      : `:root[data-theme='${theme}'][data-mode='dark']`;
  return block(selector);
}

const FACES: Array<[string, Palette]> = THEMES.flatMap((theme) =>
  (['light', 'dark'] as const).map(
    (mode) => [`${theme}/${mode}`, faceOf(theme, mode)] as [string, Palette],
  ),
);

/* WCAG 2.1 relative luminance and contrast ratio, straight from the spec. */
function luminance(hex: string): number {
  const channel = (pair: string): number => {
    const c = parseInt(pair, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(hex.slice(1, 3));
  const g = channel(hex.slice(3, 5));
  const b = channel(hex.slice(5, 7));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Rounded down, so a reported 4.5 is never really 4.4996. */
function ratio(a: string, b: string): number {
  return Math.floor(contrast(a, b) * 100) / 100;
}

describe('the palettes', () => {
  it('name every colour in every face', () => {
    for (const [name, palette] of FACES) {
      const missing = COLOUR_TOKENS.filter((token) => !(token in palette));
      expect(missing, `${name} is missing ${missing.join(', ')}`).toEqual([]);
    }
  });

  it('cover both modes and no others', () => {
    /* `system` resolves to one of the other two before it ever reaches CSS, so
       a `[data-mode='system']` block would be dead code. */
    expect(MODES).toEqual(['system', 'light', 'dark']);
  });

  /**
   * 4.5:1 is the AA floor for text below 18.66px, and nearly every string in
   * this app is below it: captions, table cells, chip labels, amounts.
   */
  const GROUNDS = ['paper', 'surface', 'greenbar'] as const;
  const TEXT = ['ink', 'ink-muted', 'income', 'expense', 'brand', 'brass'] as const;

  it('carry body text at 4.5:1 or better on every ground', () => {
    const failures: string[] = [];
    for (const [name, palette] of FACES) {
      for (const ground of GROUNDS) {
        for (const text of TEXT) {
          const value = ratio(palette[text]!, palette[ground]!);
          if (value < 4.5) failures.push(`${name}: ${text} on ${ground} is ${value}:1`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('carry a label on a solid brand block', () => {
    const failures: string[] = [];
    for (const [name, palette] of FACES) {
      const value = ratio(palette['brand-contrast']!, palette.brand!);
      if (value < 4.5) failures.push(`${name}: brand-contrast on brand is ${value}:1`);
    }
    expect(failures).toEqual([]);
  });

  it('carry brand text on its own tint', () => {
    const failures: string[] = [];
    for (const [name, palette] of FACES) {
      for (const text of ['brand', 'ink'] as const) {
        const value = ratio(palette[text]!, palette['brand-tint']!);
        if (value < 4.5) failures.push(`${name}: ${text} on brand-tint is ${value}:1`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('draw a focus ring at 3:1', () => {
    /* 3:1 is the AA floor for a state indicator rather than a glyph, and the
       focus ring — brass, set in `globals.css` — is the only thing a keyboard
       reader has to go on. Hairline rules are held to a lower bar below,
       because a table divider is decoration under 1.4.11 and the ledger look
       depends on them staying soft. */
    const failures: string[] = [];
    for (const [name, palette] of FACES) {
      for (const ground of ['paper', 'surface'] as const) {
        const value = ratio(palette.brass!, palette[ground]!);
        if (value < 3) failures.push(`${name}: brass on ${ground} is ${value}:1`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('draw a rule you can see at all, and a strong one where that is the promise', () => {
    const failures: string[] = [];
    for (const [name, palette] of FACES) {
      /* `contrast` exists for a phone held in daylight, where the first thing
         to wash out is the structure — so its rules carry the same 3:1 as a
         control's border. Elsewhere a divider only has to be present. */
      const floor = name.startsWith('contrast/') ? 3 : 1.25;
      for (const ground of ['paper', 'surface'] as const) {
        const value = ratio(palette.rule!, palette[ground]!);
        if (value < floor) failures.push(`${name}: rule on ${ground} is ${value}:1`);
      }
    }
    expect(failures).toEqual([]);
  });

  /**
   * Green is still money in and red is still money out.
   *
   * Not a contrast check — a semantic one. A palette is free to mute the pair
   * or to darken it, and not free to swap it, tint income blue, or make the two
   * the same colour. Channel dominance is the crude test that catches all
   * three, and it is crude on purpose: it should pass for any green anyone
   * would call green.
   */
  it('keep green on money in and red on money out', () => {
    const channels = (hex: string): [number, number, number] => [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
    for (const [name, palette] of FACES) {
      if (name.startsWith('mono/')) continue;
      const [ir, ig] = channels(palette.income!);
      const [er, eg] = channels(palette.expense!);
      expect(ig, `${name}: income is not green`).toBeGreaterThan(ir);
      expect(er, `${name}: expense is not red`).toBeGreaterThan(eg);
    }
  });

  /**
   * And in `mono`, which has no hue to spend, the two are separated by
   * lightness instead. 1.6:1 is about the point at which two figures in the
   * same column still read as two different things at a glance.
   */
  it('separate money in from money out by lightness where there is no hue', () => {
    for (const mode of ['light', 'dark'] as const) {
      const palette = faceOf('mono', mode);
      expect(ratio(palette.income!, palette.expense!)).toBeGreaterThanOrEqual(1.6);
    }
  });

  /**
   * And the second, non-hue channel in `mono` is a rule under the amount.
   *
   * Asserted rather than trusted to a comment because it is one CSS block with
   * no other caller, exactly the kind of thing a tidy-up deletes — and losing
   * it would leave the one palette where a column of amounts cannot be scanned
   * without reading each minus sign in turn.
   */
  it('rule money out in the black-and-white theme', () => {
    const globals = readFileSync(join(process.cwd(), 'src', 'app', 'globals.css'), 'utf8');
    expect(globals).toMatch(/\[data-theme='mono'\][^{]*\.money\.text-expense/);
  });
});
