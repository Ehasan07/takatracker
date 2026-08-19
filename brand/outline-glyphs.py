"""Build the Taka Tracker mark as pure vector, from the brand's own fonts.

## Why the glyphs are outlined

Artwork sent to a printer, a sign shop or an agency is opened on a machine that
does not have Anek Bangla or Bai Jamjuree and will not install them. Live text
in that file renders as a box, or silently substitutes — and nobody notices
until the vinyl is cut. So every letterform here is converted to a path once,
and no delivered file references a typeface at all.

## Why a variable font needs instancing first

Anek Bangla is variable: the outline for weight 600 does not exist in the file
until the weight axis is pinned. Drawing the default master would ship the
wrong weight — visibly lighter than the app, and wrong in a way that is hard to
see side by side and obvious on a billboard.
"""
import json
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.transformPen import TransformPen
from fontTools.misc.transform import Transform

import os
FONTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'apps', 'web', 'src', 'app', 'fonts')

def outlines(path, text, weight=None):
    """Each character as an SVG path in a y-down coordinate system, with pen advance."""
    font = TTFont(f'{FONTS}/{path}')
    if weight is not None and 'fvar' in font:
        font = instantiateVariableFont(font, {'wght': weight}, inplace=False, updateFontNames=False)
    upem = font['head'].unitsPerEm
    cmap = font.getBestCmap()
    glyphset = font.getGlyphSet()
    out, x = [], 0.0
    for ch in text:
        name = cmap.get(ord(ch))
        if name is None:
            raise SystemExit(f'{path}: no glyph for {ch!r}')
        g = glyphset[name]
        # y-down for SVG, and shifted along by everything drawn so far.
        pen = SVGPathPen(glyphset)
        g.draw(TransformPen(pen, Transform(1, 0, 0, -1, x, 0)))
        bounds = BoundsPen(glyphset)
        g.draw(bounds)
        out.append({'char': ch, 'd': pen.getCommands(), 'bounds': bounds.bounds, 'x': x})
        x += g.width
    return {'upem': upem, 'advance': x, 'glyphs': out}

taka = outlines('anek-bangla-bengali.woff2', '৳', weight=600)
word = outlines('bai-jamjuree-latin-600.woff2', 'Taka Tracker')
json.dump({'taka': taka, 'word': word}, open('glyphs.json', 'w'))

g = taka['glyphs'][0]
print(f"৳  upem {taka['upem']}  advance {taka['advance']:.0f}  bounds {tuple(round(v) for v in g['bounds'])}")
wb = [gl['bounds'] for gl in word['glyphs'] if gl['bounds']]
print(f"wordmark  upem {word['upem']}  advance {word['advance']:.0f}  "
      f"top {min(b[3] for b in wb):.0f}  bottom {min(b[1] for b in wb):.0f}")
