import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { generateTerrain, defaultTerrainParams } from '../../src/core/terrainGen.js';
import { createProjectDoc } from '../../src/core/project.js';
import { World } from '../../src/core/world.js';
import { encodePNG } from '../../src/core/png.js';
import { NO_WATER } from '../../src/core/waterField.js';
const preset = process.argv[2] || 'alpine';
const res = +(process.argv[3] || 1025);
const manifest = existsSync('public/assets/manifest.json') ? JSON.parse(readFileSync('public/assets/manifest.json', 'utf8')) : { models: {}, textures: {} };
let t0 = performance.now();
const gen = generateTerrain({ ...defaultTerrainParams(preset, 7), res, coarseRes: 513 });
console.log('gen', (performance.now() - t0 | 0), 'ms');
const { doc, missing } = createProjectDoc({ name: 'smoke', preset, seed: 7, manifest, terrain: { res } });
console.log('missing', missing.join(','));
if (gen.suggested.rivers[0]) doc.water.rivers.push({ id: 'r1', name: 'River', nodes: gen.suggested.rivers[0].map(p => ({ x: p.x, z: p.z })), width: 10, depth: 0.8, flow: 9 });
for (const l of gen.suggested.lakes) doc.water.lakes.push({ id: 'l1', name: 'Lake', ...l });
if (gen.suggested.seaLevel !== null) doc.water.sea = { enabled: true, level: gen.suggested.seaLevel };
const world = new World(doc, gen, manifest);
t0 = performance.now();
world.deriveAll((l, f) => console.log(' ', (performance.now() - t0 | 0), l));
console.log('derive', (performance.now() - t0 | 0), 'ms', JSON.stringify(world.water.stats));
let inst = 0; for (const c of world.scatterCells.values()) for (const l of c.layers.values()) inst += l.count;
console.log('instances', inst);
// debug image: water type + speed + foam
const N = res * res; const img = new Uint8Array(N * 3); const wf = world.water;
let vmax = 0, fmax = 0;
for (let i = 0; i < N; i++) {
  const g = world.hFinal.data[i]; const t = wf.type[i];
  const sp = Math.hypot(wf.vx[i], wf.vz[i]); vmax = Math.max(vmax, sp); fmax = Math.max(fmax, wf.foam[i]);
  const sh = 80 + 100 * ((world.hFinal.data[i] - world.hFinal.data[Math.max(0, i - 1)]) / world.hFinal.cell * 0.5 + 0.5);
  if (t === 0) { img[i * 3] = sh * (world.weights[i * 8 + 0] > 100 ? 0.7 : 1); img[i * 3 + 1] = sh; img[i * 3 + 2] = sh * (world.weights[i * 8 + 1] > 100 ? 0.6 : 0.9); }
  else { img[i * 3] = Math.min(255, wf.foam[i] * 255); img[i * 3 + 1] = Math.min(255, sp * 80); img[i * 3 + 2] = 120 + 40 * t; }
}
console.log('vmax', vmax.toFixed(2), 'foam max', fmax.toFixed(2));
mkdirSync('.cache/dev', { recursive: true });
writeFileSync(`.cache/dev/world-${preset}.png`, await encodePNG(img, res, res, 3, 8));
// crop zoom around river mid
if (doc.water.rivers[0]) {
  const nd = doc.water.rivers[0].nodes; const m = nd[nd.length >> 1];
  const cx = Math.round(world.hFinal.toGridX(m.x)), cz = Math.round(world.hFinal.toGridZ(m.z)); const S = 128; const Z = 6;
  const crop = new Uint8Array(S * Z * S * Z * 3);
  for (let j = 0; j < S * Z; j++) for (let i = 0; i < S * Z; i++) { const sx = Math.min(res - 1, Math.max(0, cx - S / 2 + (i / Z | 0))), sz = Math.min(res - 1, Math.max(0, cz - S / 2 + (j / Z | 0))); const s = (sz * res + sx) * 3; const d = (j * S * Z + i) * 3; crop[d] = img[s]; crop[d + 1] = img[s + 1]; crop[d + 2] = img[s + 2]; }
  writeFileSync(`.cache/dev/world-${preset}-crop.png`, await encodePNG(crop, S * Z, S * Z, 3, 8));
  // long profile
  const c = world.compiled.rivers[0]; const k = c.sp.n;
  console.log('river length', c.sp.length | 0, 'bed', c.bed[0].toFixed(1), '->', c.bed[k - 1].toFixed(1), 'depth range', Math.min(...c.depth).toFixed(2), Math.max(...c.depth).toFixed(2));
}
