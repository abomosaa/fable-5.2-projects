"""Contact sheet of thumbnails: contact.py <dir> <out.jpg> [cols] [cell]"""
import sys, os
from PIL import Image, ImageDraw
d, out = sys.argv[1], sys.argv[2]
cols = int(sys.argv[3]) if len(sys.argv) > 3 else 6
cell = int(sys.argv[4]) if len(sys.argv) > 4 else 300
files = sorted(f for f in os.listdir(d) if f.lower().endswith(('.jpg', '.png', '.jpeg')))
Image.MAX_IMAGE_PIXELS = 120_000_000
rows = (len(files) + cols - 1) // cols
sheet = Image.new('RGB', (cols * cell, rows * (cell + 16)), 'white')
dr = ImageDraw.Draw(sheet)
for i, f in enumerate(files):
    try:
        im = Image.open(os.path.join(d, f)); im.draft('RGB', (cell * 2, cell * 2)); im = im.convert('RGB')
    except Exception as e:
        print('bad', f, e); continue
    im.thumbnail((cell - 4, cell - 4))
    x, y = (i % cols) * cell, (i // cols) * (cell + 16)
    sheet.paste(im, (x + 2, y + 16))
    dr.text((x + 4, y + 2), os.path.splitext(f)[0], fill='red')
sheet.save(out, quality=85)
print(out, sheet.size)
