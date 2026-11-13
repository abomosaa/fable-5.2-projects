// Scratch: fetch Poly Haven catalogue thumbnails for candidate ids and compose labelled contact sheets.
// usage: node dev/thumbs.mjs <candidates.txt (lines "group: id id id")> <outDir> [models|textures]
import fs from 'node:fs'; import path from 'node:path';
import { SRC, USER_AGENT } from '../lib/paths.mjs';
import { contactSheet } from '../lib/sheet.mjs';
const [file, outDir, kind = 'textures'] = process.argv.slice(2);
const cat = JSON.parse(fs.readFileSync(path.join(SRC, '_api', `${kind}.json`), 'utf8'));
const dir = path.join(SRC, '_thumbs'); fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(outDir, { recursive: true });
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  const m = line.match(/^(\w+):\s*(.*)$/); if (!m) continue;
  const cells = [];
  for (const id of m[2].trim().split(/\s+/)) {
    const a = cat[id]; if (!a) { console.log('unknown id', id); continue; }
    const f = path.join(dir, `${id}.png`);
    if (!fs.existsSync(f)) {
      const r = await fetch(`https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=384&height=384`, { headers: { 'User-Agent': USER_AGENT } });
      if (!r.ok) { console.log('thumb failed', id, r.status); continue; }
      fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
    }
    cells.push({ label: id, sub: `${a.dimensions ? (a.dimensions[0] / 1000).toFixed(1) + 'm' : ''} ${a.polycount ?? ''}`, image: f });
  }
  await contactSheet(cells, { cellW: 300, cellH: 300, cols: 6, out: path.join(outDir, `${m[1]}.jpg`), bg: '#888' });
  console.log(m[1], cells.length);
}
