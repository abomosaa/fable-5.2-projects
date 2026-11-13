import { readFileSync } from 'node:fs';
import { generateTerrain, defaultTerrainParams } from '../../src/core/terrainGen.js';
import { createProjectDoc } from '../../src/core/project.js';
import { World } from '../../src/core/world.js';
import { NO_WATER } from '../../src/core/waterField.js';
const manifest = JSON.parse(readFileSync('public/assets/manifest.json', 'utf8'));
const res = 2049;
const gen = generateTerrain({ ...defaultTerrainParams('alpine', 7), res, coarseRes: 1025 });
const { doc } = createProjectDoc({ name: 'x', preset: 'alpine', seed: 7, manifest, terrain: { res } });
doc.water.rivers.push({ id: 'r1', name: 'River', nodes: gen.suggested.rivers[0].map((p) => ({ x: p.x, z: p.z })), width: 11, depth: 0.8, flow: 9 });
const world = new World(doc, gen, manifest);
world.deriveAll();
const wf = world.water, h = world.hFinal.data, N = res * res;
let wetDeep = 0, extBelow = 0, wet = 0, ext = 0, maxD = 0;
const hist = {};
for (let i = 0; i < N; i++) {
  const s = wf.surf[i]; if (s <= NO_WATER * 0.5) continue;
  if (wf.type[i]) { wet++; const d = s - h[i]; maxD = Math.max(maxD, d); } else { ext++; if (h[i] < s - 0.03) { extBelow++; const k = Math.round((s - h[i]) * 10) / 10; hist[k] = (hist[k] || 0) + 1; } }
}
console.log({ wet, ext, extBelow, maxD }, hist);
const m = doc.water.rivers[0].nodes[doc.water.rivers[0].nodes.length >> 1];
console.log('mid', m, 'bank mask near cam', world.masks.bank[Math.round(world.hFinal.toGridZ(m.z + 4)) * res + Math.round(world.hFinal.toGridX(m.x + 9))]);
// sample a line across the river at mid: ground, surf, type, weights
const c = world.compiled.rivers[0]; const k = c.sp.n >> 1;
const nx = -c.sp.tz[k], nz = c.sp.tx[k];
for (let r = -30; r <= 30; r += 3) { const x = c.sp.x[k] + nx * r, z = c.sp.z[k] + nz * r; const gi = Math.round(world.hFinal.toGridZ(z)) * res + Math.round(world.hFinal.toGridX(x)); console.log(r, 'h', h[gi].toFixed(2), 'hUser', world.hUser.data[gi].toFixed(2), 'surf', wf.surf[gi] > -5e4 ? wf.surf[gi].toFixed(2) : '-', 'type', wf.type[gi], 'shore', wf.shore[gi].toFixed(1), 'w', Array.from(world.weights.subarray(gi * 8, gi * 8 + 8)).join(','), 'biome', world.biomeMap[gi]); }
