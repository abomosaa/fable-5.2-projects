// Scratch: per-component UV-region / size statistics of one primitive. usage: node uvstats.mjs <rawDir> <gltfName> <meshIndex> <primIndex>
import path from 'node:path';
import { loadGltf, readAccessor } from '../lib/gltf-read.mjs';
import { meshReady, analyseComponents } from '../lib/mesh.mjs';
await meshReady;
const [dir, name, mi, pi] = process.argv.slice(2);
const gltf = loadGltf(path.join(dir, name));
const pr = gltf.json.meshes[+mi].primitives[+pi];
const pos = readAccessor(gltf, pr.attributes.POSITION).array;
const uv = readAccessor(gltf, pr.attributes.TEXCOORD_0).array;
const idx = Uint32Array.from(readAccessor(gltf, pr.indices, { asIndices: true }).array);
const c = analyseComponents({ pos, nrm: pos, uv, idx });
const G = 8; const cells = new Map();
for (let k = 0; k < c.count; k++) {
  let u = 0, v = 0, n = 0, u0 = 9, u1 = -9, v0 = 9, v1 = -9;
  for (let t = c.start[k]; t < c.start[k + 1]; t++) for (let j = 0; j < 3; j++) { const vi = idx[c.triList[t] * 3 + j]; const a = uv[vi * 2], b = uv[vi * 2 + 1]; u += a; v += b; n++; u0 = Math.min(u0, a); u1 = Math.max(u1, a); v0 = Math.min(v0, b); v1 = Math.max(v1, b); }
  const key = `${Math.floor(u / n * G)},${Math.floor(v / n * G)}`;
  const e = cells.get(key) ?? { n: 0, tris: 0, area: 0, diag: 0, du: 0, dv: 0 };
  e.n++; e.tris += c.tris[k]; e.area += c.area[k]; e.diag += Math.hypot(c.bmax[k * 3] - c.bmin[k * 3], c.bmax[k * 3 + 1] - c.bmin[k * 3 + 1], c.bmax[k * 3 + 2] - c.bmin[k * 3 + 2]); e.du += u1 - u0; e.dv += v1 - v0;
  cells.set(key, e);
}
for (const [k, e] of [...cells].sort((a, b) => b[1].area - a[1].area).slice(0, 24)) console.log(`uvcell ${k.padEnd(5)} comps=${String(e.n).padStart(7)} tris/comp=${(e.tris / e.n).toFixed(1).padStart(6)} area=${e.area.toFixed(2).padStart(7)} (${(100 * e.area / c.totalArea).toFixed(1)}%) meanDiag=${(e.diag / e.n).toFixed(3)} uvExt=${(e.du / e.n).toFixed(3)}x${(e.dv / e.n).toFixed(3)}`);
