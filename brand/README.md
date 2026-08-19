# Taka Tracker — brand artwork

Three pieces of artwork, each in three vector formats and a set of PNGs.

Every letterform here — the ৳ and the wordmark alike — has been **converted to
outlines**. Nothing in this folder references a typeface, so a printer, a sign
shop or an agency can open any file without Anek Bangla or Bai Jamjuree
installed and get the real thing rather than a substitution.

## Which file to send

| You need                                               | Send                                      |
| ------------------------------------------------------ | ----------------------------------------- |
| Billboard, banner, vehicle wrap, anything large        | `.pdf` or `.eps` — resolution-independent |
| A designer's own layout (Illustrator, Affinity, Figma) | `.svg` or `.pdf`                          |
| A print shop that asks for "AI or EPS"                 | `.eps` — Illustrator opens and edits it   |
| Web, slides, a document                                | the `.png` at the nearest size up         |

There is no `.ai` file. Adobe's format is proprietary and cannot be written
honestly without Illustrator; `.eps` and `.pdf` are what Illustrator itself
exports for this purpose, and it opens both natively. Any shop that asks for AI
will accept either.

## The artwork

**`takatracker-icon`** — the square mark, exactly as it appears on a phone home
screen. Use where the name is already present or where a square is required.
100 × 100 units.

**`takatracker-lockup`** — mark and name on one line. This is the one for a
banner wider than it is tall. 423 × 100 units.

**`takatracker-wordmark`** — the name alone, for a layout that already carries
the mark elsewhere.

## PNG sizes

Icon: 512, 1024, 2048, 4096 square.
Lockup: 2000, 4000, 8000, 16000 wide.
Wordmark: 2000, 6000 wide.

All PNGs have a transparent background. For anything printed larger than a
poster, use the vector — a 16000px PNG on a billboard is still a fixed grid of
pixels, and the vector is not.

## Colours

|             | Hex       | Use                     |
| ----------- | --------- | ----------------------- |
| Brand green | `#1F6F4A` | the square              |
| Ink         | `#16241D` | the ৳ and the wordmark  |
| Gold        | `#C8892C` | the rule under the sign |
| Tile        | `#FFFFFF` | the inner square        |

For print, ask the shop to match `#1F6F4A` and `#C8892C` to their own coated
stock rather than converting the RGB values mechanically — a straight RGB→CMYK
conversion turns this green muddy.

## Clear space and minimum size

Keep clear space around the artwork of at least the height of the gold rule
(3.4 units on the icon's own grid — about 3.5% of the mark's height).

Minimum sizes: the icon reads down to 28px on screen and about 8mm in print.
Below that, the rule under the ৳ stops resolving and the mark loses the one
element that distinguishes it.

## Rebuilding

The artwork is generated, not drawn by hand, so a change to the geometry or the
colours is one edit and one command rather than nine files opened in turn.

```sh
python3 -m venv /tmp/fontenv && /tmp/fontenv/bin/pip install fonttools brotli
/tmp/fontenv/bin/python outline-glyphs.py   # ৳ and the wordmark -> glyphs.json
/tmp/fontenv/bin/python build.py            # -> svg, pdf, eps
```

`outline-glyphs.py` reads the app's own font files from
`apps/web/src/app/fonts/` and pins Anek Bangla's weight axis to 600 before
taking the outlines — a variable font drawn at its default master is the wrong
weight, and it is wrong in a way that is invisible until it is printed large.

The PNGs come from the SVGs with ImageMagick:

```sh
magick -background none takatracker-lockup.svg -resize 16000x png32:out.png
```
