"""crop.py <image> <out.jpg> <cx_frac> <cy_frac> <size_px> [resize_to]  -- save a centred full-resolution crop (QA viewing aid)"""
import sys
from PIL import Image, ImageOps
Image.MAX_IMAGE_PIXELS = 120_000_000
im = ImageOps.exif_transpose(Image.open(sys.argv[1])).convert("RGB")
cx, cy, n = float(sys.argv[3]) * im.width, float(sys.argv[4]) * im.height, int(sys.argv[5])
box = (int(cx - n / 2), int(cy - n / 2), int(cx + n / 2), int(cy + n / 2))
c = im.crop(box)
if len(sys.argv) > 6:
    c = c.resize((int(sys.argv[6]), int(sys.argv[6])), Image.LANCZOS)
c.save(sys.argv[2], quality=90)
print(im.size, box)
