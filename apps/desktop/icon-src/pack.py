"""Make every icon size REDBEAM ships from the two renders icon.cjs writes.

    python icon-src/pack.py        (run from apps/desktop)

48 px and down come from icon-small-1024.png (bigger crystal, thicker beams);
everything larger from icon-1024.png. Writes src-tauri/icons (PNGs, icon.ico,
icon.icns), the NSIS installer header and sidebar, and the in-app marks in
src/brand.
"""
import io
import os
import struct

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FULL = Image.open(os.path.join(HERE, 'icon-1024.png')).convert('RGBA')
SMALL = Image.open(os.path.join(HERE, 'icon-small-1024.png')).convert('RGBA')
SMALL_MAX = 48


def at(size: int) -> Image.Image:
    src = SMALL if size <= SMALL_MAX else FULL
    return src.resize((size, size), Image.LANCZOS)


def png_bytes(im: Image.Image) -> bytes:
    b = io.BytesIO()
    im.save(b, 'PNG', optimize=True)
    return b.getvalue()


# Every PNG already in src-tauri/icons, at its own size.
icons = os.path.join(ROOT, 'src-tauri', 'icons')
for d, _, files in os.walk(icons):
    for f in files:
        if f.endswith('.png'):
            p = os.path.join(d, f)
            w, h = Image.open(p).size
            at(w).save(p, optimize=True)

# icon.ico: PNG-compressed entries, small cut up to 48 px.
sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
blobs = [png_bytes(at(s)) for s in sizes]
head = struct.pack('<HHH', 0, 1, len(sizes))
off = 6 + 16 * len(sizes)
dirs = b''
for s, blob in zip(sizes, blobs):
    dirs += struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(blob), off)
    off += len(blob)
with open(os.path.join(icons, 'icon.ico'), 'wb') as fh:
    fh.write(head + dirs + b''.join(blobs))

FULL.save(os.path.join(icons, 'icon.icns'))

# NSIS: a 150x57 header (white strip, mark on the right) and a 164x314
# sidebar (graphite, mark centred high). Both 24-bit BMP.
header = Image.new('RGB', (150, 57), '#ffffff')
m = at(44)
header.paste(m, (150 - 44 - 8, 6), m)
header.save(os.path.join(icons, 'nsis-header.bmp'))

side = Image.new('RGB', (164, 314))
top, bottom = (0x45, 0x4b, 0x57), (0x14, 0x15, 0x19)
for y in range(314):
    t = y / 313
    side.paste(tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)), (0, y, 164, y + 1))
m = at(96)
side.paste(m, ((164 - 96) // 2, 72), m)
side.save(os.path.join(icons, 'nsis-sidebar.bmp'))

# In-app marks: the small cut for 16 to 24 px spots (title bar, palette,
# favicon), the full one for the start screen and About.
brand = os.path.join(ROOT, 'src', 'brand')
os.makedirs(brand, exist_ok=True)
at(48).save(os.path.join(brand, 'mark-small.png'), optimize=True)
at(256).save(os.path.join(brand, 'mark.png'), optimize=True)
