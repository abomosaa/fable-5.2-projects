// Terrain mesh builder (module web worker). Receives a chunk request, evaluates the height
// field on a regular grid and returns vertex buffers (positions relative to the chunk centre,
// normals, biome colours, detail-texture coordinates) plus tree instances for the finest level.

import { terrainHeight, biomeAt, hash2, airfieldFactor, settlementFactor } from './heightfield.js';
import { noised } from './noise.js';

const ANCHOR = 4096;
const B = { forest: 0, farm: 0, conifer: 0, snow: 0, rock: 0, sand: 0 };
const sstep = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

const airportPad = airfieldFactor;

// land / mountain masks come from rawHeight's side channel; recompute cheaply via finite probes
function colourAt(x, z, h, slope, out, o) {
  const pad = airportPad(x, z);
  // large-scale masks
  const mountain = sstep(250, 900, h) ;
  biomeAt(x, z, h, slope, 1, mountain, B);
  const n1 = noised(x * 0.0031 + 5.5, z * 0.0031 - 2.5) * 0.5 + 0.5;
  const n2 = noised(x * 0.00037 - 11.5, z * 0.00037 + 4.5) * 0.5 + 0.5;
  // base grass: lush to dry
  let r = mix(0.115, 0.26, n2 * 0.7 + n1 * 0.3), g = mix(0.23, 0.265, n2), b = mix(0.055, 0.1, n2);
  // alpine meadow above the tree line
  const alp = sstep(1100, 1700, h);
  r = mix(r, 0.27, alp); g = mix(g, 0.27, alp); b = mix(b, 0.13, alp);
  const town = settlementFactor(x, z);
  const clear = (1 - pad) * (1 - Math.min(1, town * 2.5));
  let forest = B.forest * clear, farm = B.farm * clear;
  // forest floor / canopy colour
  const fr = mix(0.034, 0.026, B.conifer), fg = mix(0.08, 0.06, B.conifer), fb = mix(0.022, 0.026, B.conifer);
  r = mix(r, fr * (0.8 + 0.4 * n1), forest); g = mix(g, fg * (0.8 + 0.4 * n1), forest); b = mix(b, fb, forest);
  // farmland base (the fragment shader paints individual fields)
  r = mix(r, 0.27, farm); g = mix(g, 0.3, farm); b = mix(b, 0.11, farm);
  // mown airfield grass
  r = mix(r, 0.16, pad); g = mix(g, 0.27, pad); b = mix(b, 0.075, pad);
  // built-up ground: gardens, yards and streets blur into a grey-green
  if (town > 0) { const t = Math.min(1, town * 1.6) * 0.75; r = mix(r, 0.21, t); g = mix(g, 0.215, t); b = mix(b, 0.19, t); }
  // rock
  const rk = B.rock, rv = 0.75 + 0.5 * n1;
  r = mix(r, 0.2 * rv, rk); g = mix(g, 0.18 * rv, rk); b = mix(b, 0.155 * rv, rk);
  // snow
  r = mix(r, 0.9, B.snow); g = mix(g, 0.92, B.snow); b = mix(b, 0.96, B.snow);
  // beaches and sea bed
  const sand = B.sand * (1 - pad);
  r = mix(r, 0.68, sand); g = mix(g, 0.62, sand); b = mix(b, 0.44, sand);
  if (h < 0) {
    const dp = sstep(0, -40, h);
    r = mix(0.6, 0.06, dp); g = mix(0.58, 0.15, dp); b = mix(0.42, 0.17, dp);
    forest = 0; farm = 0;
  }
  out[o] = Math.min(255, Math.sqrt(r) * 255);        // gamma-encoded for 8-bit precision
  out[o + 1] = Math.min(255, Math.sqrt(g) * 255);
  out[o + 2] = Math.min(255, Math.sqrt(b) * 255);
  B.forest = forest; B.farm = farm;
}

function build(req) {
  const { x0, z0, size, res, level, maxLevel } = req;
  const n = res + 1;
  const cell = size / res;
  const cx = x0 + size / 2, cz = z0 + size / 2;
  const ax = Math.floor(x0 / ANCHOR) * ANCHOR, az = Math.floor(z0 / ANCHOR) * ANCHOR;
  // heights with a one-cell border for normals
  const m = n + 2;
  const H = new Float32Array(m * m);
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < m; i++) {
    const x = x0 + (i - 1) * cell;
    for (let j = 0; j < m; j++) {
      const h = terrainHeight(x, z0 + (j - 1) * cell);
      H[i * m + j] = h;
    }
  }
  const nv = n * n + 4 * n;
  const pos = new Float32Array(nv * 3);
  const nor = new Int8Array(nv * 4);
  const col = new Uint8Array(nv * 4);
  const grid = new Float32Array(nv * 2);
  const bio = new Uint8Array(nv * 4);
  const sl = Math.max(cell, 16);            // baseline for the biome slope (LOD independent-ish)
  let k = 0;
  for (let i = 0; i < n; i++) {
    const x = x0 + i * cell;
    for (let j = 0; j < n; j++, k++) {
      const z = z0 + j * cell;
      const h = H[(i + 1) * m + (j + 1)];
      if (h < minY) minY = h; if (h > maxY) maxY = h;
      pos[k * 3] = x - cx; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z - cz;
      const dhx = (H[(i + 2) * m + (j + 1)] - H[i * m + (j + 1)]) / (2 * cell);
      const dhz = (H[(i + 1) * m + (j + 2)] - H[(i + 1) * m + j]) / (2 * cell);
      const inv = 1 / Math.sqrt(dhx * dhx + 1 + dhz * dhz);
      nor[k * 4] = -dhx * inv * 127; nor[k * 4 + 1] = inv * 127; nor[k * 4 + 2] = -dhz * inv * 127;
      let slope;
      if (cell <= 16) slope = Math.sqrt(dhx * dhx + dhz * dhz);
      else {
        const sx = (terrainHeight(x + sl, z) - h) / sl, sz = (terrainHeight(x, z + sl) - h) / sl;
        slope = Math.sqrt(sx * sx + sz * sz);
      }
      colourAt(x, z, h, slope, col, k * 4);
      col[k * 4 + 3] = 255;
      bio[k * 4] = B.farm * 255; bio[k * 4 + 1] = B.forest * 255; bio[k * 4 + 2] = B.snow * 255; bio[k * 4 + 3] = B.rock * 255;
      grid[k * 2] = x - ax; grid[k * 2 + 1] = z - az;
    }
  }
  // skirts: duplicate the border vertices pushed down, to hide cracks between LOD levels
  const drop = size * 0.035 + 3;
  const edge = (src) => {
    pos[k * 3] = pos[src * 3]; pos[k * 3 + 1] = pos[src * 3 + 1] - drop; pos[k * 3 + 2] = pos[src * 3 + 2];
    nor[k * 4] = nor[src * 4]; nor[k * 4 + 1] = nor[src * 4 + 1]; nor[k * 4 + 2] = nor[src * 4 + 2];
    col[k * 4] = col[src * 4]; col[k * 4 + 1] = col[src * 4 + 1]; col[k * 4 + 2] = col[src * 4 + 2]; col[k * 4 + 3] = 255;
    bio[k * 4] = bio[src * 4]; bio[k * 4 + 1] = bio[src * 4 + 1]; bio[k * 4 + 2] = bio[src * 4 + 2]; bio[k * 4 + 3] = bio[src * 4 + 3];
    grid[k * 2] = grid[src * 2]; grid[k * 2 + 1] = grid[src * 2 + 1];
    k++;
  };
  for (let j = 0; j < n; j++) edge(j);                       // i = 0
  for (let j = 0; j < n; j++) edge((n - 1) * n + j);         // i = n-1
  for (let i = 0; i < n; i++) edge(i * n);                   // j = 0
  for (let i = 0; i < n; i++) edge(i * n + n - 1);           // j = n-1

  // trees (finest level only): jittered grid, density from the forest mask
  let trees = null;
  if (level === maxLevel && req.trees && maxY > 3) {
    const sp = req.treeSpacing || 15;
    const cnt = Math.floor(size / sp);
    const buf = new Float32Array(cnt * cnt * 6);
    let t = 0;
    const i0 = Math.round(x0 / sp), j0 = Math.round(z0 / sp);
    for (let i = 0; i < cnt; i++) for (let j = 0; j < cnt; j++) {
      const gi = i0 + i, gj = j0 + j;
      const r1 = hash2(gi, gj), r2 = hash2(gi + 7919, gj - 104729), r3 = hash2(gi - 31337, gj + 1299709);
      const x = (gi + r1) * sp, z = (gj + r2) * sp;
      if (x < x0 || x >= x0 + size || z < z0 || z >= z0 + size) continue;
      const h = terrainHeight(x, z);
      if (h < 3.5) continue;
      const sx = (terrainHeight(x + 6, z) - h) / 6, sz = (terrainHeight(x, z + 6) - h) / 6;
      const slope = Math.sqrt(sx * sx + sz * sz);
      biomeAt(x, z, h, slope, 1, sstep(250, 900, h), B);
      let dens = B.forest * 1.1 + 0.035 * (1 - B.farm) * (1 - sstep(900, 1500, h)) * (1 - B.rock);
      // hedgerow trees between fields
      dens = Math.max(dens, B.farm * 0.03);
      if (airportPad(x, z) > 0.02) continue;
      const town = settlementFactor(x, z);
      if (town > 0.03) dens = 0.05;          // only garden trees between the houses
      if (r3 > dens) continue;
      const s = 0.7 + 0.75 * hash2(gi + 13, gj + 17);
      buf[t++] = x - cx; buf[t++] = h - 0.3; buf[t++] = z - cz;
      buf[t++] = s; buf[t++] = B.conifer > hash2(gi - 5, gj + 3) ? 1 : 0; buf[t++] = hash2(gi + 101, gj - 57);
    }
    trees = buf.slice(0, t);
  }
  return { id: req.id, pos, nor, col, grid, bio, minY, maxY, trees };
}

/** Low-resolution overview map (heights) for the minimap and the water shader. */
function overview(req) {
  const { size, half } = req;
  const data = new Float32Array(size * size);
  for (let i = 0; i < size; i++) {
    const x = -half + (i + 0.5) * 2 * half / size;
    for (let j = 0; j < size; j++) data[i * size + j] = terrainHeight(x, -half + (j + 0.5) * 2 * half / size);
  }
  return { id: req.id, overview: data, size, half };
}

self.onmessage = (e) => {
  const req = e.data;
  if (req.type === 'overview') {
    const r = overview(req);
    self.postMessage(r, [r.overview.buffer]);
    return;
  }
  const r = build(req);
  const tr = [r.pos.buffer, r.nor.buffer, r.col.buffer, r.grid.buffer, r.bio.buffer];
  if (r.trees) tr.push(r.trees.buffer);
  self.postMessage(r, tr);
};
