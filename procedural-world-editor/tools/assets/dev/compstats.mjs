// Scratch: connected-component statistics per primitive. usage: node compstats.mjs <rawDir> <gltfName> [meshIndex]
import path from 'node:path';
import { loadGltf, readAccessor } from '../lib/gltf-read.mjs';
import { meshReady, analyseComponents } from '../lib/mesh.mjs';
await meshReady;
const [dir, name, mi] = process.argv.slice(2);
const gltf = loadGltf(path.join(dir, name));
const g = gltf.json;
g.meshes.forEach((m, i) => {
  if (mi != null && +mi !== i) return;
  for (const pr of m.primitives) {
    const pos = readAccessor(gltf, pr.attributes.POSITION).array;
    const idx = Uint32Array.from(readAccessor(gltf, pr.indices, { asIndices: true }).array);
    const c = analyseComponents({ pos, nrm: pos, uv: new Float32Array(pos.length / 3 * 2), idx });
    const tris = Array.from(c.tris).sort((a, b) => a - b);
    const diag = Array.from({ length: c.count }, (_, k) => Math.hypot(c.bmax[k * 3] - c.bmin[k * 3], c.bmax[k * 3 + 1] - c.bmin[k * 3 + 1], c.bmax[k * 3 + 2] - c.bmin[k * 3 + 2])).sort((a, b) => a - b);
    const q = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
    console.log(`mesh ${i} mat ${g.materials[pr.material].name}: tris=${idx.length / 3} comps=${c.count} tris/comp p10=${q(tris, 0.1)} p50=${q(tris, 0.5)} p90=${q(tris, 0.9)} max=${tris.at(-1)} | diag p10=${q(diag, 0.1).toFixed(3)} p50=${q(diag, 0.5).toFixed(3)} p90=${q(diag, 0.9).toFixed(3)} max=${diag.at(-1).toFixed(3)} area=${c.totalArea.toFixed(1)}`);
  }
});
