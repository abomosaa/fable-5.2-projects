// Diagnostic: several close-up renders in one browser session, composed into one image.
// usage: node dev/closeups.mjs out.jpg "<url> r0 r1 zoom" ...
import sharp from 'sharp';
import { startRenderer } from '../lib/render.mjs';
const [,, out, ...specs] = process.argv;
const R = await startRenderer();
try {
  const tiles = [];
  for (const s of specs) {
    const [url, r0 = '0.35', r1 = '0.75', zoom = '0.35', el = '0.1'] = s.split(' ');
    const d = await R.renderCloseup({ url: '/' + url, region: [+r0, +r1], zoom: +zoom, el: +el, w: 800, h: 620 });
    tiles.push(R.decode(d));
  }
  const cols = Math.min(2, tiles.length), rows = Math.ceil(tiles.length / cols);
  await sharp({ create: { width: cols * 800, height: rows * 620, channels: 3, background: '#000' } })
    .composite(tiles.map((t, i) => ({ input: t, left: (i % cols) * 800, top: Math.floor(i / cols) * 620 }))).jpeg({ quality: 88 }).toFile(out);
  if (R.errors.length) console.log([...new Set(R.errors)].slice(0, 5).join('\n'));
} finally { await R.close(); }
