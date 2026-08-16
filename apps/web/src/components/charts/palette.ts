/**
 * The colours a chart on this screen is allowed to use, in the order it must
 * use them.
 *
 * ## Why these seven and not the seven that were here before
 *
 * The old slice palette was picked by eye and it did not survive being
 * measured. Run through the colour-vision simulation the rest of this file is
 * checked against, its worst neighbouring pair — the brass `#8E6C18` beside the
 * red `#A8342A` — came out 5.3 apart in OKLab ΔE for a deuteranope, where 8 is
 * the target and 6 the floor. Two of its pairs were under 10 for a reader with
 * *ordinary* colour vision. On a donut those two colours are touching arcs, so
 * the chart was asking about one man in twelve to tell apart two slices that,
 * to them, were the same colour.
 *
 * These seven were searched for rather than chosen: candidates were generated
 * across the OKLCH hue circle at the lightnesses that clear 3:1 against **both**
 * this app's surfaces (`#ffffff` and the dark `#16201c`), then ordered to
 * maximise the *smallest* separation between neighbours. The result clears
 * every gate in both themes with no relief needed:
 *
 *   lightness band   all 7 inside the light band, all 7 inside the dark one
 *   chroma floor     all 7 ≥ 0.10 — none of them reads as grey
 *   CVD separation   worst neighbouring pair ΔE 15.3 (deutan), target 8
 *   normal vision    worst neighbouring pair ΔE 23.4, floor 15
 *   contrast         all 7 ≥ 3:1 against both surfaces
 *
 * ## Two rules that are not style preferences
 *
 * **The order is the safety mechanism.** The guarantee above is about
 * *neighbours*: slot 1 beside slot 2, slot 2 beside slot 3. Sorting a legend by
 * amount and then colouring it top-down keeps that property. Re-ordering this
 * array, or assigning a colour from anything other than a slice's position in
 * the sorted list, throws the guarantee away silently.
 *
 * **Never cycle.** There is no eighth colour: `%` on a longer list would put two
 * identical arcs on one ring. A chart with more than seven categories folds the
 * tail into one অন্যান্য slice, which is `REST_COLOUR` — a deliberate grey,
 * because "everything else" is not a category and should not compete with one.
 *
 * The colours are hexadecimal rather than CSS variables on purpose: a theme
 * token would swing between light and dark, and these were validated as one set
 * against both grounds so that they do not have to.
 */
export const SERIES_COLOURS = [
  '#4E9D0E',
  '#C64A9A',
  '#776A15',
  '#1187EE',
  '#C83C25',
  '#7B50C9',
  '#129390',
] as const;

/** The tail of a long list, and never a category in its own right. */
export const REST_COLOUR = 'var(--hishab-ink-muted)';

/** How many real categories a chart may show before the rest is folded up. */
export const MAX_SERIES = SERIES_COLOURS.length;

/**
 * The colour for the nth largest slice. Out of range is the grey rather than a
 * wrapped-around repeat — see "never cycle" above.
 */
export function seriesColour(index: number): string {
  return SERIES_COLOURS[index] ?? REST_COLOUR;
}
