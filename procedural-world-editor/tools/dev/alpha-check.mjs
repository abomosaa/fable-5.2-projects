// For each foliage (MASK) material of every model LOD: report the alpha statistics of its base colour image.
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { parseGLB, imageBytes, textureImageIndex } from '../../src/export/glbRead.js';
const man = JSON.parse(readFileSync('public/assets/manifest.json'));
const filter = process.argv[2] ? new RegExp(process.argv[2]) : /./;
for (const [id, info] of Object.entries(man.models)) {
  if (!filter.test(id)) continue;
  for (const lod of info.lods || []) {
    const g = parseGLB(new Uint8Array(readFileSync('public/assets/' + lod.file)));
    for (const m of g.json.materials) {
      if (m.alphaMode !== 'MASK') continue;
      const ti = m.pbrMetallicRoughness?.baseColorTexture?.index;
      if (ti === undefined) { console.log(id, lod.file, m.name, 'NO TEXTURE'); continue; }
      const img = imageBytes(g, textureImageIndex(g, ti));
      const im = sharp(Buffer.from(img.bytes));
      const meta = await im.metadata();
      const st = await im.stats();
      const a = st.channels[3];
      const bad = !meta.hasAlpha || a.mean > 250;
      if (bad || process.argv[3]) console.log(bad ? 'BAD' : 'ok ', id, lod.file.split('/').pop(), m.name, img.mimeType, meta.width + 'x' + meta.height, 'alpha', meta.hasAlpha ? `mean ${a.mean.toFixed(0)} min ${a.min}` : 'none', 'cutoff', m.alphaCutoff);
    }
  }
}
console.log('done');
