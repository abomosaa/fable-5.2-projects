// Scratch: how do the stored vertex normals of a primitive relate to its geometric normals / the crown direction?
import path from 'node:path';
import { loadGltf, readAccessor } from '../lib/gltf-read.mjs';
const [dir, name, mi, pi] = process.argv.slice(2);
const gltf = loadGltf(path.join(dir, name));
const pr = gltf.json.meshes[+mi].primitives[+pi];
const pos = readAccessor(gltf, pr.attributes.POSITION).array, nrm = readAccessor(gltf, pr.attributes.NORMAL).array;
const idx = readAccessor(gltf, pr.indices, { asIndices: true }).array;
let cx = 0, cz = 0; for (let i = 0; i < pos.length; i += 3) { cx += pos[i]; cz += pos[i + 2]; } cx /= pos.length / 3; cz /= pos.length / 3;
let agree = 0, anti = 0, n = 0, up = 0, outw = 0, absg = 0;
for (let t = 0; t < idx.length; t += 3 * 7) {
  const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
  const e1 = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]], e2 = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
  let g = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]; const gl = Math.hypot(...g); if (gl < 1e-12) continue; g = g.map((v) => v / gl);
  const d = g[0] * nrm[a] + g[1] * nrm[a + 1] + g[2] * nrm[a + 2];
  if (d > 0.7) agree++; else if (d < -0.7) anti++;
  absg += Math.abs(g[1]);
  up += nrm[a + 1];
  const r = Math.hypot(pos[a] - cx, pos[a + 2] - cz) || 1; outw += (nrm[a] * (pos[a] - cx) + nrm[a + 2] * (pos[a + 2] - cz)) / r;
  n++;
}
console.log(`tris sampled ${n}: stored normal ~ +geometric ${(100 * agree / n).toFixed(0)}%, ~ -geometric ${(100 * anti / n).toFixed(0)}%, mean stored up=${(up / n).toFixed(2)} outward=${(outw / n).toFixed(2)}, mean |geometric up|=${(absg / n).toFixed(2)}`);
