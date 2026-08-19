"""Every deliverable, from one set of outlines.

Three artworks, because a billboard and an app icon are not the same drawing:

  mark        the square icon, exactly as it ships on a phone
  lockup      mark + wordmark on one line, for a banner wider than it is tall
  wordmark    the name alone, for places that already carry the mark

Each in SVG, PDF and EPS — all true vector, all with the type already converted
to outlines — plus PNG at sizes a print shop will ask for. The PNGs exist for
convenience; anything going on a billboard should use the vector.
"""
import json, re, subprocess, shutil, os

GREEN=(0x1F,0x6F,0x4A); INK=(0x16,0x24,0x1D); GOLD=(0xC8,0x89,0x2C); WHITE=(0xFF,0xFF,0xFF)
OUT='.'
G=json.load(open('glyphs.json'))

def tokens(d):
    x=y=sx=sy=0.0
    for m in re.finditer(r'([MLCQZHVmlcqzhv])([^MLCQZHVmlcqzhv]*)', d):
        cmd=m.group(1); n=[float(v) for v in re.findall(r'-?\d*\.?\d+(?:[eE]-?\d+)?', m.group(2))]
        if cmd in 'Zz': x,y=sx,sy; yield 'Z',[]
        elif cmd=='H':
            for v in n: x=v; yield 'L',[x,y]
        elif cmd=='V':
            for v in n: y=v; yield 'L',[x,y]
        else:
            if cmd=='M': sx,sy=n[0],n[1]
            x,y=n[-2],n[-1]; yield cmd,n

def place(d,s,tx,ty):
    out=[]
    for cmd,n in tokens(d):
        if cmd=='Z': out.append('Z'); continue
        out.append(cmd+' '.join(f'{n[i]*s+tx:.4f} {n[i+1]*s+ty:.4f}' for i in range(0,len(n),2)))
    return ' '.join(out)

def rounded(x,y,w,h,r):
    k=r*0.5523
    return (f'M{x+r:.4f} {y:.4f} L{x+w-r:.4f} {y:.4f} '
            f'C{x+w-r+k:.4f} {y:.4f} {x+w:.4f} {y+r-k:.4f} {x+w:.4f} {y+r:.4f} '
            f'L{x+w:.4f} {y+h-r:.4f} '
            f'C{x+w:.4f} {y+h-r+k:.4f} {x+w-r+k:.4f} {y+h:.4f} {x+w-r:.4f} {y+h:.4f} '
            f'L{x+r:.4f} {y+h:.4f} '
            f'C{x+r-k:.4f} {y+h:.4f} {x:.4f} {y+h-r+k:.4f} {x:.4f} {y+h-r:.4f} '
            f'L{x:.4f} {y+r:.4f} C{x:.4f} {y+r-k:.4f} {x+r-k:.4f} {y:.4f} {x+r:.4f} {y:.4f} Z')

# ---- the mark, on its own 100×100 grid ----
tk=G['taka']['glyphs'][0]; x0,y0,x1,y1=tk['bounds']
s=30.0/(y1-y0); tx=50-(x1-x0)*s/2-x0*s; ty=27.0+y1*s
SIGN=place(tk['d'],s,tx,ty)
RULE=rounded(50-27/2,63.0,27.0,3.4,1.7)
MARK=[(GREEN,rounded(0,0,100,100,24)),(WHITE,rounded(18,18,64,64,14)),(INK,SIGN),(GOLD,RULE)]

# ---- the wordmark, laid out beside the mark ----
w=G['word']; wupem=w['upem']
wb=[g['bounds'] for g in w['glyphs'] if g['bounds']]
cap=max(b[3] for b in wb)                        # cap height in font units
wx0=min(g['bounds'][0]+g['x'] for g in w['glyphs'] if g['bounds'])
wx1=max(g['bounds'][2]+g['x'] for g in w['glyphs'] if g['bounds'])

def wordmark(height, baseline_y, left, colour=INK):
    ws=height/cap
    return [(colour, place(g['d'], ws, left-wx0*ws, baseline_y)) for g in w['glyphs'] if g['bounds']], (wx1-wx0)*ws

# lockup: mark at 100, gap, name set to 34 units of cap height, optically centred
GAP=26.0
name_shapes, name_w = wordmark(34.0, 50+34/2, 100+GAP)
LOCKUP_W = 100+GAP+name_w
LOCKUP=[*MARK, *name_shapes]

# name alone
alone_shapes, alone_w = wordmark(100.0, 100, 0)
WORD=[*alone_shapes]

hexof=lambda c:'#%02X%02X%02X'%c
rgb=lambda c:' '.join(f'{v/255:.4f}' for v in c)

def ops(d, flip_h):
    out=[]; cur=None
    for cmd,n in tokens(d):
        pt=lambda i:(n[i], flip_h-n[i+1])
        if cmd=='M':
            for i in range(0,len(n),2):
                x,y=pt(i); out.append(f'{x:.4f} {y:.4f} '+('m' if i==0 else 'l')); cur=(x,y)
        elif cmd=='L':
            for i in range(0,len(n),2):
                x,y=pt(i); out.append(f'{x:.4f} {y:.4f} l'); cur=(x,y)
        elif cmd=='C':
            for i in range(0,len(n),6):
                a,b,c=pt(i),pt(i+2),pt(i+4)
                out.append(f'{a[0]:.4f} {a[1]:.4f} {b[0]:.4f} {b[1]:.4f} {c[0]:.4f} {c[1]:.4f} c'); cur=c
        elif cmd=='Q':
            for i in range(0,len(n),4):
                q,e=pt(i),pt(i+2)
                c1=(cur[0]+2/3*(q[0]-cur[0]), cur[1]+2/3*(q[1]-cur[1]))
                c2=(e[0]+2/3*(q[0]-e[0]), e[1]+2/3*(q[1]-e[1]))
                out.append(f'{c1[0]:.4f} {c1[1]:.4f} {c2[0]:.4f} {c2[1]:.4f} {e[0]:.4f} {e[1]:.4f} c'); cur=e
        else: out.append('h')
    return ' '.join(out)

def write(name, shapes, W, H, title):
    svg=['<?xml version="1.0" encoding="UTF-8"?>',
         f'<svg xmlns="http://www.w3.org/2000/svg" width="{W*10:.0f}" height="{H*10:.0f}" viewBox="0 0 {W:.4f} {H:.4f}">',
         f'<title>{title}</title>']
    for c,d in shapes: svg.append(f'<path fill="{hexof(c)}" d="{d}"/>')
    svg.append('</svg>')
    open(f'{OUT}/{name}.svg','w').write('\n'.join(svg)+'\n')

    body=[]
    for c,d in shapes: body += [f'{rgb(c)} rg', ops(d,H), 'f']
    stream='\n'.join(body).encode()
    objs=[b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
          b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.4f %.4f] /Contents 4 0 R /Resources << >> >>'%(W,H),
          b'<< /Length %d >>\nstream\n'%len(stream)+stream+b'\nendstream']
    pdf=bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'); offs=[]
    for i,o in enumerate(objs,1):
        offs.append(len(pdf)); pdf+=b'%d 0 obj\n'%i+o+b'\nendobj\n'
    xref=len(pdf); pdf+=b'xref\n0 %d\n0000000000 65535 f \n'%(len(objs)+1)
    for o in offs: pdf+=b'%010d 00000 n \n'%o
    pdf+=b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n'%(len(objs)+1,xref)
    open(f'{OUT}/{name}.pdf','wb').write(bytes(pdf))

    eps=['%!PS-Adobe-3.0 EPSF-3.0','%%Creator: Taka Tracker',f'%%Title: {title}',
         f'%%BoundingBox: 0 0 {W:.0f} {H:.0f}', f'%%HiResBoundingBox: 0 0 {W:.4f} {H:.4f}',
         '%%LanguageLevel: 2','%%EndComments']
    for c,d in shapes:
        eps += [f'{rgb(c)} setrgbcolor','newpath',
                ops(d,H).replace(' m',' moveto').replace(' l',' lineto')
                        .replace(' c',' curveto').replace(' h',' closepath'),'fill']
    eps += ['showpage','%%EOF']
    open(f'{OUT}/{name}.eps','w').write('\n'.join(eps)+'\n')

os.makedirs(OUT, exist_ok=True)
write('takatracker-icon', MARK, 100, 100, 'Taka Tracker icon')
write('takatracker-lockup', LOCKUP, LOCKUP_W, 100, 'Taka Tracker horizontal lockup')
write('takatracker-wordmark', WORD, alone_w, 130, 'Taka Tracker wordmark')
print(f'icon 100×100 | lockup {LOCKUP_W:.1f}×100 | wordmark {alone_w:.1f}×130')
