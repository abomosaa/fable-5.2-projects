// Dev tool: generate terrain for a preset and write a hillshade PNG for inspection.
import { writeFileSync, mkdirSync } from 'node:fs';
import { generateTerrain, defaultTerrainParams } from '../../src/core/terrainGen.js';
import { encodePNG } from '../../src/core/png.js';

export async function hillshadePNG(data, res, cell, path, opts = {}) {
  const out = new Uint8Array(res * res * 3);
  const lx = -0.6, ly = 0.65, lz = -0.45;
  const sea = opts.sea ?? -1e9;
  let mn = Infinity, mx = -Infinity;
  for (const v of data) { if (v < mn) mn = v; if (v > mx) mx = v; }
  for (let z = 0; z < res; z++) for (let x = 0; x < res; x++) {
    const i = z * res + x;
    const gx = (data[z * res + Math.min(res - 1, x + 1)] - data[z * res + Math.max(0, x - 1)]) / (2 * cell);
    const gz = (data[Math.min(res - 1, z + 1) * res + x] - data[Math.max(0, z - 1) * res + x]) / (2 * cell);
    const l = 1 / Math.hypot(gx, 1, gz);
    let s = Math.max(0, (-gx * lx + ly - gz * lz) * l);
    const t = (data[i] - mn) / (mx - mn + 1e-6);
    let r = 90 + 120 * t, g = 110 + 90 * t, b = 80 + 110 * t;
    if (data[i] < sea) { r = 40; g = 80 + 60 * Math.max(0, 1 + (data[i] - sea) / 30); b = 150; s = 0.6 + 0.4 * s; }
    out[i * 3] = Math.min(255, r * (0.25 + s)); out[i * 3 + 1] = Math.min(255, g * (0.25 + s)); out[i * 3 + 2] = Math.min(255, b * (0.25 + s));
  }
  writeFileSync(path, await encodePNG(out, res, res, 3, 8));
  return [mn, mx];
}

if (process.argv[1].endsWith('gen-preview.mjs')) {
  const preset = process.argv[2] || 'alpine';
  const seed = +(process.argv[3] || 7);
  const res = +(process.argv[4] || 1025);
  const coarseRes = +(process.argv[5] || 513);
  mkdirSync('.cache/dev', { recursive: true });
  const t0 = performance.now();
  let lastPhase = '';
  const P = { ...defaultTerrainParams(preset, seed), res, coarseRes };
  const r = generateTerrain(P, (ph, f) => { if (ph !== lastPhase) { console.log(((performance.now() - t0) / 1000).toFixed(1) + 's', ph); lastPhase = ph; } });
  console.log('total', ((performance.now() - t0) / 1000).toFixed(1), 's');
  const mm = await hillshadePNG(r.heights, res, P.size / (res - 1), `.cache/dev/${preset}-${seed}.png`, { sea: r.suggested.seaLevel ?? (r.suggested.lakes[0]?.level ?? -1e9) });
  const mm2 = await hillshadePNG(r.ring.data, r.ring.res, r.ring.size / (r.ring.res - 1), `.cache/dev/${preset}-${seed}-ring.png`, { sea: r.suggested.seaLevel ?? (r.suggested.lakes[0]?.level ?? -1e9) });
  console.log('inner min/max', mm, 'ring', mm2, 'suggested', JSON.stringify(r.suggested).slice(0, 400));
}
