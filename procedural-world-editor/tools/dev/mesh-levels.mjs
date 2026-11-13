// Histogram of upward-facing surface area by height for a library model (finds decks / flat tops).
import { readFileSync } from 'node:fs';
import { parseGLB, readAccessorFloat, readAccessor, nodeMatrix, mat4Mul } from '../../src/export/glbRead.js';
const name = process.argv[2];
const buf = readFileSync(`public/assets/models/${name}/lod0.glb`);
const glb = parseGLB(new Uint8Array(buf));
const j = glb.json;
const hist = new Map();
let min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
const I = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function visit(ni, pm) {
  const n = j.nodes[ni];
  const m = mat4Mul(pm, nodeMatrix(n));
  if (n.mesh !== undefined) for (const pr of j.meshes[n.mesh].primitives) {
    const pos = readAccessorFloat(glb, pr.attributes.POSITION);
    const idx = pr.indices !== undefined ? readAccessor(glb, pr.indices).array : null;
    const P = (i) => { const x = pos[i*3], y = pos[i*3+1], z = pos[i*3+2]; return [m[0]*x+m[4]*y+m[8]*z+m[12], m[1]*x+m[5]*y+m[9]*z+m[13], m[2]*x+m[6]*y+m[10]*z+m[14]]; };
    const nt = (idx ? idx.length : pos.length / 3) / 3;
    for (let t = 0; t < nt; t++) {
      const a = P(idx ? idx[t*3] : t*3), b = P(idx ? idx[t*3+1] : t*3+1), c = P(idx ? idx[t*3+2] : t*3+2);
      for (const p of [a,b,c]) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
      const ux = b[0]-a[0], uy = b[1]-a[1], uz = b[2]-a[2], vx = c[0]-a[0], vy = c[1]-a[1], vz = c[2]-a[2];
      const ny = uz*vx - ux*vz; const nx = uy*vz-uz*vy, nz = ux*vy-uy*vx;
      const area = 0.5 * Math.hypot(nx, ny, nz);
      if (Math.abs(ny) / (2*area + 1e-12) > 0.9) { const key = Math.round(((a[1]+b[1]+c[1])/3) * 10) / 10; hist.set(key, (hist.get(key) || 0) + area); }
    }
  }
  for (const c of n.children || []) visit(c, m);
}
for (const r of j.scenes[j.scene || 0].nodes) visit(r, I);
console.log(name, 'bounds', min.map(v=>+v.toFixed(2)), max.map(v=>+v.toFixed(2)));
console.log([...hist.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,v])=>`y=${k}: ${v.toFixed(2)} m2`).join('\n'));
