// Scratch: byte breakdown of GLB files (geometry vs images). usage: node dev/glbstat.mjs <file.glb>...
import fs from 'node:fs';
for (const file of process.argv.slice(2)) {
  const b = fs.readFileSync(file);
  const jl = b.readUInt32LE(12); const json = JSON.parse(b.toString('utf8', 20, 20 + jl));
  const imgViews = new Set((json.images ?? []).map((i) => i.bufferView));
  let img = 0, geo = 0;
  json.bufferViews.forEach((v, i) => { if (imgViews.has(i)) img += v.byteLength; else geo += v.byteLength; });
  const imgs = (json.images ?? []).map((im) => `${im.mimeType.split('/')[1]}:${(json.bufferViews[im.bufferView].byteLength / 1024).toFixed(0)}k`).join(' ');
  console.log(`${file.split('/').slice(-2).join('/')}: total ${(b.length / 1e6).toFixed(2)} MB, geometry ${(geo / 1e6).toFixed(2)}, images ${(img / 1e6).toFixed(2)} [${imgs}] prims ${json.meshes[0].primitives.length}`);
}
