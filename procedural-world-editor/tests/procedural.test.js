// Procedural determinism: terrain generation, erosion, scatter placement and the noise / hash
// primitives must be pure functions of their parameters.
import { describe, it, expect, beforeAll } from 'vitest';
import { generateTerrain, defaultTerrainParams, TERRAIN_PRESETS } from '../src/core/terrainGen.js';
import { hydraulicErosion, thermalErosion } from '../src/core/erosion.js';
import { Noise2D, hash32, hashFloat, mulberry32, stringSeed } from '../src/core/noise.js';
import { sampleGrid } from '../src/core/heightfield.js';
import { WaterField, computeWaterField } from '../src/core/waterField.js';
import { Heightfield } from '../src/core/heightfield.js';
import { createProjectDoc } from '../src/core/project.js';
import { World } from '../src/core/world.js';
import { scatterLayer, INSTANCE_STRIDE, SCATTER_CELL } from '../src/core/biomes.js';

const RES = 257;
const SEED = 7;
const PRESETS = ['alpine', 'lake', 'coast', 'hills'];

/** FNV-1a over the raw bytes of a typed array (bit-exact fingerprint). */
function hashBytes(arr) {
  const b = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 16777619) >>> 0;
  return h.toString(16).padStart(8, '0') + ':' + b.length;
}

const params = (preset, seed = SEED) => ({ ...defaultTerrainParams(preset, seed), res: RES, coarseRes: 129 });
const gens = {};

beforeAll(() => {
  for (const p of PRESETS) gens[p] = generateTerrain(params(p));
});

function minMax(a) {
  let mn = Infinity,
    mx = -Infinity;
  for (let i = 0; i < a.length; i++) {
    if (a[i] < mn) mn = a[i];
    if (a[i] > mx) mx = a[i];
  }
  return [mn, mx];
}

describe('terrain generation', () => {
  it('is bit-identical for the same seed and parameters', () => {
    const again = generateTerrain(params('alpine'));
    expect(hashBytes(again.heights)).toBe(hashBytes(gens.alpine.heights));
    expect(hashBytes(again.sediment)).toBe(hashBytes(gens.alpine.sediment));
    expect(hashBytes(again.ring.data)).toBe(hashBytes(gens.alpine.ring.data));
    expect(JSON.stringify(again.suggested)).toBe(JSON.stringify(gens.alpine.suggested));
  });

  it('changes when the seed changes', () => {
    const other = generateTerrain(params('alpine', SEED + 1));
    expect(hashBytes(other.heights)).not.toBe(hashBytes(gens.alpine.heights));
    expect(hashBytes(other.sediment)).not.toBe(hashBytes(gens.alpine.sediment));
    let differing = 0;
    for (let i = 0; i < other.heights.length; i++) if (other.heights[i] !== gens.alpine.heights[i]) differing++;
    expect(differing / other.heights.length).toBeGreaterThan(0.95);
  });

  it('can be cancelled from the progress callback', () => {
    let calls = 0;
    const out = generateTerrain(params('hills'), () => {
      calls++;
      return false;
    });
    expect(out).toBeNull();
    expect(calls).toBe(1);
  });

  it.each(PRESETS)('%s: finite heights in a plausible range', (preset) => {
    const g = gens[preset];
    expect(g.heights.length).toBe(RES * RES);
    expect(g.sediment.length).toBe(RES * RES);
    for (let i = 0; i < g.heights.length; i++) {
      if (!Number.isFinite(g.heights[i])) throw new Error(`non-finite height at ${i}`);
      if (!(g.sediment[i] >= 0 && g.sediment[i] <= 1)) throw new Error(`sediment out of [0,1] at ${i}: ${g.sediment[i]}`);
    }
    const [mn, mx] = minMax(g.heights);
    const base = TERRAIN_PRESETS[preset].baseAltitude;
    const relief = mx - mn;
    // the landscape sits on its datum and has real, but not absurd, relief
    expect(mn).toBeGreaterThan(base - 80);
    expect(mn).toBeLessThan(base + 150);
    if (preset === 'alpine') {
      expect(relief).toBeGreaterThan(250);
      expect(relief).toBeLessThan(2500);
    } else {
      expect(relief).toBeGreaterThan(60);
      expect(relief).toBeLessThan(900);
    }
    // not a flat or pure-noise surface: mean slope in a sane band
    const cell = g.params.size / (RES - 1);
    let s = 0,
      n = 0;
    for (let z = 1; z < RES - 1; z += 2) {
      for (let x = 1; x < RES - 1; x += 2) {
        const i = z * RES + x;
        s += Math.hypot(g.heights[i + 1] - g.heights[i - 1], g.heights[i + RES] - g.heights[i - RES]) / (2 * cell);
        n++;
      }
    }
    const meanSlope = s / n;
    expect(meanSlope).toBeGreaterThan(0.01);
    expect(meanSlope).toBeLessThan(1.5);
    // the surrounding ring is the same landscape at twice the extent
    expect(g.ring.size).toBe(g.params.size * 2);
    expect(g.ring.data.length).toBe(g.ring.res * g.ring.res);
  });

  it.each(PRESETS)('%s: suggested river follows real drainage structure', (preset) => {
    const g = gens[preset];
    const size = g.params.size;
    const cell = size / (RES - 1);
    expect(g.suggested.rivers.length).toBe(1);
    const pts = g.suggested.rivers[0];
    expect(pts.length).toBeGreaterThanOrEqual(5);
    for (const p of pts) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(size / 2 + 1e-6);
      expect(Math.abs(p.z)).toBeLessThanOrEqual(size / 2 + 1e-6);
    }
    // drainage area accumulates downstream and is channel-sized (>= 1e5 m^2 trunk threshold)
    for (let i = 1; i < pts.length; i++) expect(pts[i].area).toBeGreaterThanOrEqual(pts[i - 1].area);
    expect(pts[0].area).toBeGreaterThan(1e5);
    // the drainage raster has dendritic concentration: a few cells carry most of the area
    const d = g.drainage.data;
    let big = 0;
    const [, dmax] = minMax(d);
    for (let i = 0; i < d.length; i++) if (d[i] > dmax - 1.5) big++;
    expect(dmax).toBeGreaterThan(5.5); // log10(m^2)
    expect(big / d.length).toBeLessThan(0.08); // measured 4-5 % across presets / seeds
    expect(big).toBeGreaterThan(10);
    // smoothed long profile (7-sample moving average) descends
    const hs = pts.map((p) => sampleGrid(g.heights, RES, (p.x + size / 2) / cell, (p.z + size / 2) / cell));
    const W = 3;
    const sm = hs.map((_, i) => {
      let s = 0,
        n = 0;
      for (let k = Math.max(0, i - W); k <= Math.min(hs.length - 1, i + W); k++) {
        s += hs[k];
        n++;
      }
      return s / n;
    });
    const drop = sm[0] - sm[sm.length - 1];
    expect(drop).toBeGreaterThan(3);
    let runMin = Infinity,
      maxClimb = 0;
    for (const v of sm) {
      maxClimb = Math.max(maxClimb, v - runMin);
      runMin = Math.min(runMin, v);
    }
    if (preset === 'lake') {
      // the trunk stream crosses the moraine dam that impounds the lake (crest ~3 m above lake
      // level, <= ~20 m above the valley floor): allow that single rise, nothing more.
      expect(maxClimb).toBeLessThan(8);
    } else {
      expect(maxClimb).toBeLessThan(Math.max(1.0, 0.03 * drop));
    }
  });

  it('lake preset suggests a dammed lake that fills a bounded basin', () => {
    const g = gens.lake;
    expect(g.suggested.lakes.length).toBe(1);
    expect(g.suggested.dam).toBeTruthy();
    const lake = g.suggested.lakes[0];
    const hf = new Heightfield(RES, g.params.size, g.heights);
    expect(hf.inBounds(lake.x, lake.z)).toBe(true);
    expect(hf.sample(lake.x, lake.z)).toBeLessThan(lake.level);
    const wf = new WaterField(RES, g.params.size);
    const stats = computeWaterField(wf, hf, { sea: { enabled: false, level: 0 }, lakes: [lake], wind: { dir: 0, speed: 4 } }, []);
    const frac = stats.lakeCells[0] / (RES * RES);
    expect(frac).toBeGreaterThan(0.01);
    expect(frac).toBeLessThan(0.5);
    // the dam holds: the downstream end of the trunk stream is dry
    const pts = g.suggested.rivers[0];
    const end = pts[pts.length - 1];
    const gi = Math.round(hf.toGridZ(end.z)) * RES + Math.round(hf.toGridX(end.x));
    expect(wf.type[gi]).toBe(0);
  });

  it('coast preset has both land and sea', () => {
    const g = gens.coast;
    expect(g.suggested.seaLevel).toBe(TERRAIN_PRESETS.coast.baseAltitude);
    let sea = 0;
    for (let i = 0; i < g.heights.length; i++) if (g.heights[i] < g.suggested.seaLevel) sea++;
    const frac = sea / g.heights.length;
    expect(frac).toBeGreaterThan(0.15);
    expect(frac).toBeLessThan(0.85);
    const [mn, mx] = minMax(g.heights);
    expect(mn).toBeLessThan(-5);
    expect(mx).toBeGreaterThan(20);
    // the sea is one border-connected body covering nearly all sub-sea-level cells
    const hf = new Heightfield(RES, g.params.size, g.heights);
    const wf = new WaterField(RES, g.params.size);
    const stats = computeWaterField(wf, hf, { sea: { enabled: true, level: g.suggested.seaLevel }, lakes: [], wind: { dir: 0, speed: 4 }, swell: { height: 1, period: 9, dir: 0 } }, []);
    expect(stats.oceanCells / sea).toBeGreaterThan(0.97);
  });
});

describe('erosion', () => {
  const res = 97;
  const cell = 2;
  const make = () => {
    const n = new Noise2D(5);
    const h = new Float32Array(res * res);
    for (let z = 0; z < res; z++) for (let x = 0; x < res; x++) h[z * res + x] = n.fbm(x / 20, z / 20, 4) * 60 + n.noise(x / 3, z / 3) * 6;
    return h;
  };

  it('hydraulic erosion is invariant to batch splitting (start/count)', () => {
    const src = make();
    const a = make();
    const sa = new Float32Array(res * res);
    hydraulicErosion(a, res, cell, { seed: 3, count: 6000, sediment: sa });
    const b = make();
    const sb = new Float32Array(res * res);
    hydraulicErosion(b, res, cell, { seed: 3, start: 0, count: 1500, sediment: sb });
    hydraulicErosion(b, res, cell, { seed: 3, start: 1500, count: 2500, sediment: sb });
    hydraulicErosion(b, res, cell, { seed: 3, start: 4000, count: 2000, sediment: sb });
    expect(hashBytes(b)).toBe(hashBytes(a));
    expect(hashBytes(sb)).toBe(hashBytes(sa));
    // and it actually did something, deterministically dependent on the seed
    let changed = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== src[i]) changed++;
    expect(changed / a.length).toBeGreaterThan(0.5);
    const c = make();
    hydraulicErosion(c, res, cell, { seed: 4, count: 6000 });
    expect(hashBytes(c)).not.toBe(hashBytes(a));
  });

  it('hydraulic erosion carves: droplets move material downhill, never off the grid', () => {
    const a = make();
    const before = make();
    hydraulicErosion(a, res, cell, { seed: 9, count: 8000 });
    let sumA = 0,
      sumB = 0;
    for (let i = 0; i < a.length; i++) {
      expect(Number.isFinite(a[i])).toBe(true);
      sumA += a[i];
      sumB += before[i];
    }
    // sediment in transit when a droplet dies is lost, deposits never exceed what was eroded
    expect(sumA).toBeLessThanOrEqual(sumB + 1e-3 * a.length);
    // centre of mass moves down: high ground loses, low ground gains
    let hi = 0,
      lo = 0;
    const mean = sumB / a.length;
    for (let i = 0; i < a.length; i++) {
      if (before[i] > mean + 15) hi += a[i] - before[i];
      else if (before[i] < mean - 15) lo += a[i] - before[i];
    }
    expect(hi).toBeLessThan(0);
    expect(lo).toBeGreaterThan(hi);
  });

  const offs = [-1, 1, -res, res, -res - 1, -res + 1, res - 1, res + 1];
  const dist = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2].map((d) => d * cell);
  /** Steepest downhill gradient from any interior cell to one of its 8 neighbours. */
  const maxSlope = (h) => {
    let m = 0;
    for (let z = 1; z < res - 1; z++) {
      for (let x = 1; x < res - 1; x++) {
        const i = z * res + x;
        for (let k = 0; k < 8; k++) {
          const s = (h[i] - h[i + offs[k]]) / dist[k];
          if (s > m) m = s;
        }
      }
    }
    return m;
  };

  it('thermal erosion relaxes every slope to the talus angle and conserves mass', () => {
    const talus = 0.7;
    const h = make();
    const s0 = maxSlope(h);
    expect(s0).toBeGreaterThan(2 * talus);
    let sum0 = 0;
    for (const v of h) sum0 += v;
    let prev = s0;
    const history = [];
    for (let round = 0; round < 8; round++) {
      thermalErosion(h, res, cell, { iterCount: 200, talus, rate: 0.4 });
      const s = maxSlope(h);
      history.push(s);
      // never steepens beyond what it was (above the talus) while relaxing
      expect(s).toBeLessThanOrEqual(Math.max(prev, talus) + 1e-3);
      prev = s;
    }
    expect(history[history.length - 1]).toBeLessThanOrEqual(talus + 0.03);
    let sum1 = 0;
    for (const v of h) sum1 += v;
    expect(Math.abs(sum1 - sum0)).toBeLessThan(1e-4 * res * res);
    // once at rest, further iterations leave the max slope at/below the talus + epsilon
    thermalErosion(h, res, cell, { iterCount: 100, talus, rate: 0.4 });
    expect(maxSlope(h)).toBeLessThanOrEqual(talus + 0.03);
  });

  it('thermal erosion is deterministic, batchable and leaves sub-talus terrain untouched', () => {
    const a = make();
    const b = make();
    thermalErosion(a, res, cell, { iterCount: 30, talus: 0.7 });
    thermalErosion(b, res, cell, { iterCount: 10, talus: 0.7 });
    thermalErosion(b, res, cell, { iterCount: 20, talus: 0.7 });
    expect(hashBytes(b)).toBe(hashBytes(a));
    // a gentle plane is below the repose angle everywhere: nothing moves
    const plane = new Float32Array(res * res);
    for (let z = 0; z < res; z++) for (let x = 0; x < res; x++) plane[z * res + x] = 0.3 * x * cell + 0.2 * z * cell;
    const ref = new Float32Array(plane);
    thermalErosion(plane, res, cell, { iterCount: 20, talus: 0.7 });
    expect(hashBytes(plane)).toBe(hashBytes(ref));
  });
});

describe('scatter placement', () => {
  let world, world2;
  const mkWorld = () => {
    const g = gens.hills;
    const { doc } = createProjectDoc({ name: 'scatter', preset: 'hills', seed: SEED, manifest: { models: {}, textures: {} }, terrain: { res: RES } });
    doc.id = 'scatter-test';
    // asset-independent biome set (model ids are only labels for scatterLayer)
    doc.biomes = [
      {
        id: 'bank',
        name: 'Bank',
        auto: { priority: 5, shoreMax: 30 },
        ground: { primary: 'grass' },
        layers: [{ id: 'stones', name: 'Stones', group: 'rocks', models: [{ id: 'r1', weight: 1, scale: 1 }], spacing: 5, density: 0.6, maxDepth: 1, waterDist: [-1e9, 30, 5], scale: [0.5, 1.5], sink: 0.2, cluster: 0.5, clusterScale: 20, vigorScale: false }],
      },
      {
        id: 'woods',
        name: 'Woods',
        auto: { priority: 1 },
        ground: { primary: 'forest', secondary: 'grass', secondaryAmount: 0.4 },
        layers: [
          { id: 'trees', name: 'Trees', group: 'trees', models: [{ id: 't1', weight: 3, scale: 1 }, { id: 't2', weight: 1, scale: 1.4 }, { id: 't3', weight: 1, scale: 0.8 }], spacing: 7, density: 0.7, slope: [0, 0.9, 0.2], scale: [0.7, 1.3], cluster: 0.4, clusterScale: 55, tilt: 0.03, waterDist: [2, 1e9, 3] },
          { id: 'rocks', name: 'Rocks', group: 'rocks', models: [{ id: 'r1', weight: 1, scale: 1 }, { id: 'r2', weight: 1, scale: 2 }], spacing: 11, density: 0.35, slope: [0, 1.2, 0.3], scale: [0.6, 1.5], align: 0.5, sink: 0.14, cluster: 0.7, clusterScale: 28, tilt: 0.25, vigorScale: false },
          { id: 'grass', name: 'Grass (detail)', group: 'ground', models: [{ id: 'g1', weight: 1, scale: 1 }], spacing: 1.2, density: 0.8, range: 55, slope: [0, 0.9, 0.2], scale: [0.75, 1.35] },
        ],
      },
    ];
    doc.water.rivers.push({ id: 'r1', name: 'River', nodes: g.suggested.rivers[0].map((p) => ({ x: p.x, z: p.z })), width: 12, depth: 0.9, flow: 8 });
    return new World(doc, { heights: new Float32Array(g.heights), sediment: new Float32Array(g.sediment) }, { models: {}, textures: {} });
  };

  beforeAll(() => {
    world = mkWorld();
    world.deriveAll();
    world2 = mkWorld();
    world2.deriveAll();
  });

  it('produces instances for every non-detail layer, with sane transforms', () => {
    const totals = {};
    for (const cell of world.scatterCells.values()) for (const [key, l] of cell.layers) totals[key] = (totals[key] || 0) + l.count;
    expect(totals['woods/trees']).toBeGreaterThan(2000);
    expect(totals['woods/rocks']).toBeGreaterThan(200);
    expect(totals['bank/stones']).toBeGreaterThan(5);
    expect(totals['woods/grass']).toBeUndefined(); // detail layers are runtime-only
    const layers = new Map(world.layerList().map((L) => [L.key, L.layer]));
    for (const cell of world.scatterCells.values()) {
      const [x0, z0, x1, z1] = world.cellBounds(cell.cx, cell.cz);
      for (const [key, l] of cell.layers) {
        const layer = layers.get(key);
        expect(l.data.length).toBe(l.count * INSTANCE_STRIDE);
        for (let i = 0; i < l.count; i++) {
          const o = i * INSTANCE_STRIDE;
          const x = l.data[o],
            y = l.data[o + 1],
            z = l.data[o + 2],
            scale = l.data[o + 3];
          if (!(x >= x0 && x < x1 && z >= z0 && z < z1)) throw new Error(`${key}: instance outside its cell`);
          if (!(scale > 0.2 && scale < 4)) throw new Error(`${key}: scale ${scale}`);
          const ground = world.hFinal.sample(x, z);
          const sink = (layer.sink ?? 0) * scale + (layer.sinkSlope ?? 0) * scale * 2;
          if (!(y <= ground + 1e-3 && y >= ground - sink - 1e-3)) throw new Error(`${key}: instance not on the ground (y ${y}, ground ${ground})`);
          const variant = Math.floor(l.data[o + 7]);
          if (!(variant >= 0 && variant < layer.models.length)) throw new Error(`${key}: variant ${variant}`);
          if (!(l.data[o + 4] >= 0 && l.data[o + 4] <= Math.PI * 2 + 1e-6)) throw new Error(`${key}: rotation ${l.data[o + 4]}`);
        }
      }
    }
  });

  it('a cell queried alone equals the same cell cut out of a larger query', () => {
    const ctx = world.groundCtx();
    const out = new Float32Array(INSTANCE_STRIDE * 60000);
    const keys = new Int32Array(2 * 60000);
    const nc = Math.ceil(world.size / SCATTER_CELL);
    let compared = 0;
    for (const [cx, cz] of [
      [3, 4],
      [nc >> 1, nc >> 1],
      [nc - 6, 9],
      [10, nc - 5],
      [(nc >> 1) + 3, (nc >> 1) - 2],
      [0, 0],
      [nc - 1, nc - 1],
    ]) {
      const [x0, z0, x1, z1] = world.cellBounds(cx, cz);
      for (const L of world.layerList()) {
        const n = scatterLayer(ctx, L.biomeIndex, L.layer, x0, z0, x1, z1, out, keys);
        const alone = out.slice(0, n * INSTANCE_STRIDE);
        const aloneKeys = keys.slice(0, n * 2);
        // an off-centre, non-cell-aligned superset rectangle
        const m = scatterLayer(ctx, L.biomeIndex, L.layer, x0 - 37.3, z0 - 64, x1 + 64, z1 + 11.9, out, keys);
        expect(m).toBeGreaterThanOrEqual(n);
        const cut = [];
        const cutKeys = [];
        for (let i = 0; i < m; i++) {
          const o = i * INSTANCE_STRIDE;
          if (out[o] >= x0 && out[o] < x1 && out[o + 2] >= z0 && out[o + 2] < z1) {
            for (let k = 0; k < INSTANCE_STRIDE; k++) cut.push(out[o + k]);
            cutKeys.push(keys[i * 2], keys[i * 2 + 1]);
          }
        }
        expect(cut.length).toBe(alone.length);
        expect(hashBytes(new Float32Array(cut))).toBe(hashBytes(alone));
        expect(hashBytes(new Int32Array(cutKeys))).toBe(hashBytes(aloneKeys));
        // the world's cached cell holds exactly this result for non-detail layers
        if (!L.detail) {
          const stored = world.scatterCells.get(cx + ',' + cz).layers.get(L.key);
          expect(stored ? stored.count : 0).toBe(n);
          if (stored) expect(hashBytes(stored.data)).toBe(hashBytes(alone));
        }
        compared += n;
      }
    }
    expect(compared).toBeGreaterThan(100);
  });

  it('is identical across runs (two worlds built from the same project)', () => {
    expect(world2.scatterCells.size).toBe(world.scatterCells.size);
    let total = 0;
    for (const [k, cell] of world.scatterCells) {
      const other = world2.scatterCells.get(k);
      expect([...other.layers.keys()]).toEqual([...cell.layers.keys()]);
      for (const [key, l] of cell.layers) {
        const o = other.layers.get(key);
        expect(o.count).toBe(l.count);
        if (hashBytes(o.data) !== hashBytes(l.data)) throw new Error(`scatter cell ${k} layer ${key} differs between runs`);
        total += l.count;
      }
    }
    expect(total).toBeGreaterThan(2000);
    // regenerating one cell in place reproduces it
    const key = [...world.scatterCells.keys()].find((k) => world.scatterCells.get(k).layers.size > 0);
    const before = world.scatterCells.get(key);
    const again = world.generateScatterCell(before.cx, before.cz);
    for (const [lk, l] of before.layers) expect(hashBytes(again.layers.get(lk).data)).toBe(hashBytes(l.data));
  });

  it('respects exclusion paint and suppressed instances', () => {
    const key = [...world.scatterCells.keys()].find((k) => (world.scatterCells.get(k).layers.get('woods/trees')?.count || 0) >= 8);
    const cell = world.scatterCells.get(key);
    const trees = cell.layers.get('woods/trees');
    const n0 = trees.count;
    // suppress the first instance by its lattice key
    const sk = `trees:${trees.keys[0]}:${trees.keys[1]}`;
    const sx = trees.data[0],
      sz = trees.data[2];
    world.suppressed.add(sk);
    let again = world.generateScatterCell(cell.cx, cell.cz).layers.get('woods/trees');
    expect(again.count).toBe(n0 - 1);
    for (let i = 0; i < again.count; i++) expect(again.data[i * INSTANCE_STRIDE] === sx && again.data[i * INSTANCE_STRIDE + 2] === sz).toBe(false);
    world.suppressed.delete(sk);
    // paint exclusion over the whole cell
    const [x0, z0, x1, z1] = world.cellBounds(cell.cx, cell.cz);
    const r = world.hFinal.rectFromWorld(x0, z0, x1, z1, 1);
    for (let iz = r.z0; iz <= r.z1; iz++) for (let ix = r.x0; ix <= r.x1; ix++) world.paint.exclude[iz * RES + ix] = 255;
    const excluded = world.generateScatterCell(cell.cx, cell.cz);
    expect(excluded.layers.size).toBe(0);
    for (let iz = r.z0; iz <= r.z1; iz++) for (let ix = r.x0; ix <= r.x1; ix++) world.paint.exclude[iz * RES + ix] = 0;
    again = world.generateScatterCell(cell.cx, cell.cz).layers.get('woods/trees');
    expect(again.count).toBe(n0);
    expect(hashBytes(again.data)).toBe(hashBytes(trees.data));
  });
});

describe('noise and hashing', () => {
  it('hash32 / hashFloat / mulberry32 / stringSeed return pinned values', () => {
    expect(hash32(1, 2, 3)).toBe(3357328893);
    expect(hash32(0)).toBe(3114163574);
    expect(hashFloat(5, 6, 7)).toBe(0.6436000491958112);
    expect(mulberry32(42)()).toBe(0.6011037519201636);
    expect(stringSeed('terraforge')).toBe(stringSeed('terraforge'));
    expect(stringSeed('a')).not.toBe(stringSeed('b'));
    for (let i = 0; i < 200; i++) {
      const f = hashFloat(i, i * 3, 11);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      expect(Number.isInteger(hash32(i, -i, 5))).toBe(true);
    }
  });

  it('mulberry32 streams are reproducible and seed dependent', () => {
    const a = mulberry32(123),
      b = mulberry32(123),
      c = mulberry32(124);
    let same = true,
      diff = false,
      mean = 0;
    for (let i = 0; i < 2000; i++) {
      const va = a();
      if (va !== b()) same = false;
      if (va !== c()) diff = true;
      mean += va;
    }
    expect(same).toBe(true);
    expect(diff).toBe(true);
    expect(mean / 2000).toBeGreaterThan(0.45);
    expect(mean / 2000).toBeLessThan(0.55);
  });

  it('Noise2D returns pinned values and is a pure function of (seed, x, y)', () => {
    expect(new Noise2D(1).noise(0.3, 0.7)).toBeCloseTo(0.29187255929999395, 12);
    expect(new Noise2D(1).fbm(1.5, 2.5, 4)).toBeCloseTo(0.11860230768086844, 12);
    expect(new Noise2D(9).ridged(0.4, 0.9, 3)).toBeCloseTo(0.7467871237872638, 12);
    expect(new Noise2D(9).erodedFbm(0.4, 0.9, 4)).toBeCloseTo(-0.12401458653157006, 12);
    const a = new Noise2D(77),
      b = new Noise2D(77),
      c = new Noise2D(78);
    let differs = false;
    for (let i = 0; i < 300; i++) {
      const x = i * 0.37 - 20,
        y = i * 0.11 + 3;
      expect(a.fbm(x, y, 5)).toBe(b.fbm(x, y, 5));
      // evaluation order / history must not matter
      expect(a.noise(x, y)).toBe(c.noise(x, y) === a.noise(x, y) ? a.noise(x, y) : b.noise(x, y));
      if (a.noise(x, y) !== c.noise(x, y)) differs = true;
      const v = a.noise(x, y);
      expect(Math.abs(v)).toBeLessThanOrEqual(1.5);
    }
    expect(differs).toBe(true);
    // gradient noise vanishes on the integer lattice and is continuous
    expect(Math.abs(a.noise(3, -7))).toBeLessThan(1e-12);
    expect(Math.abs(a.noise(2.5, 2.5) - a.noise(2.5 + 1e-6, 2.5))).toBeLessThan(1e-4);
  });

  it('analytic noise derivative matches finite differences', () => {
    const n = new Noise2D(31);
    const e = 1e-5;
    for (const [x, y] of [
      [0.31, 0.72],
      [5.5, -2.25],
      [-13.8, 44.1],
    ]) {
      n.noise(x, y);
      const dx = n.dx,
        dy = n.dy;
      const fx = (n.noise(x + e, y) - n.noise(x - e, y)) / (2 * e);
      const fy = (n.noise(x, y + e) - n.noise(x, y - e)) / (2 * e);
      expect(dx).toBeCloseTo(fx, 4);
      expect(dy).toBeCloseTo(fy, 4);
    }
  });
});
