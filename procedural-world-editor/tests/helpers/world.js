// Shared fixtures: a small analytic terrain with a river valley, a closed basin (lake) and a low
// southern valley mouth (sea), so tests do not pay for terrain generation and control exactly
// where the water features are.
import { readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { Noise2D, smoothstep } from '../../src/core/noise.js';
import { createProjectDoc } from '../../src/core/project.js';
import { World } from '../../src/core/world.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ASSETS_DIR = join(ROOT, 'public', 'assets');

export function loadManifest() {
  const p = join(ASSETS_DIR, 'manifest.json');
  if (!existsSync(p)) throw new Error(`asset manifest missing (${p}); run "npm run assets" before the export / persistence tests`);
  return JSON.parse(readFileSync(p, 'utf8'));
}
export const loadAsset = async (rel) => new Uint8Array(await readFile(join(ASSETS_DIR, rel)));

/** FNV-1a over the raw bytes of a typed array (bit-exact fingerprint). */
export function hashBytes(arr) {
  const b = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 16777619) >>> 0;
  return h.toString(16).padStart(8, '0') + ':' + b.length;
}

export const SIZE = 512;
export const RES = 257;
export const VALLEY_X = (z) => 30 * Math.sin(z / 90);
export const EXCLUDED = { x0: 40, z0: 40, x1: 60, z1: 60 };
export const BASIN = { x: 182, z: 110, sigma: 28 };

/** Valley running north -> south (falling 3 %), hills on both sides, a 9 m deep closed basin on the eastern plateau. */
export function syntheticHeights(res = RES, size = SIZE, seed = 11) {
  const n = new Noise2D(seed);
  const h = new Float32Array(res * res);
  const cell = size / (res - 1);
  for (let iz = 0; iz < res; iz++) {
    const z = -size / 2 + iz * cell;
    for (let ix = 0; ix < res; ix++) {
      const x = -size / 2 + ix * cell;
      let v = 120 - 0.03 * (z + size / 2);
      v += 18 * smoothstep(20, 140, Math.abs(x - VALLEY_X(z)));
      v += n.fbm(x / 60, z / 60, 3) * 1.5;
      const d2 = (x - BASIN.x) ** 2 + (z - BASIN.z) ** 2;
      v -= 9 * Math.exp(-d2 / (2 * BASIN.sigma * BASIN.sigma));
      h[iz * res + ix] = v;
    }
  }
  return h;
}

/**
 * World on the synthetic terrain with a river down the valley, a lake in the basin, the sea in
 * the valley mouth, a road, a trail, a cabin, a shed, an object on land and a floating object.
 * opts.features = false builds the bare terrain + biomes only.
 */
export function buildTestWorld(manifest, opts = {}) {
  const res = opts.res || RES;
  const size = opts.size || SIZE;
  const heights = opts.heights || syntheticHeights(res, size);
  const { doc } = createProjectDoc({ name: 'Test world', preset: 'lake', seed: opts.seed ?? 5, manifest, terrain: { res, size } });
  doc.id = opts.id || 'test-world';
  if (opts.features !== false) {
    const nodes = [];
    for (let z = -240; z <= 240; z += 60) nodes.push({ x: VALLEY_X(z), z });
    doc.water.rivers.push({ id: 'r1', name: 'River', nodes, width: 8, depth: 0.7, flow: 5 });
    const hb = heights[Math.round((BASIN.z + size / 2) / (size / (res - 1))) * res + Math.round((BASIN.x + size / 2) / (size / (res - 1)))];
    doc.water.lakes.push({ id: 'l1', name: 'Pond', x: BASIN.x, z: BASIN.z, level: hb + 3 });
    doc.water.sea = { enabled: true, level: 105.2 };
    doc.roads.push({ id: 'road-1', name: 'Road', kind: 'road', nodes: [{ x: -205, z: -150 }, { x: -175, z: -60 }, { x: -150, z: 30 }, { x: -120, z: 100 }] });
    doc.roads.push({ id: 'trail-1', name: 'Trail', kind: 'trail', nodes: [{ x: -150, z: 30 }, { x: -190, z: 90 }, { x: -222, z: 150 }] });
    doc.structures.push({ id: 'cabin-1', type: 'cabin', x: -140, z: -25, rot: 0.8, variant: 3 });
    doc.structures.push({ id: 'shed-1', type: 'shed', x: -196, z: 40, rot: -1.9, variant: 7 });
    if (manifest.models?.wine_barrel_01) doc.objects.push({ id: 'obj-1', model: 'wine_barrel_01', x: -133, z: -17, rot: 0.5, scale: 1.2 });
    if (manifest.models?.rubber_duck_toy) doc.objects.push({ id: 'duck-1', model: 'rubber_duck_toy', x: BASIN.x, z: BASIN.z, rot: 2.1, scale: 3, floating: true });
    doc.env.timeOfDay = 12;
  }
  const world = new World(doc, { heights, sediment: opts.sediment || new Float32Array(res * res) }, manifest);
  if (opts.features !== false && res === RES) {
    // painted scatter exclusion over a block of forest (grid cells EXCLUDED.x0..x1, z0..z1)
    for (let iz = EXCLUDED.z0; iz <= EXCLUDED.z1; iz++) world.paint.exclude.fill(255, iz * res + EXCLUDED.x0, iz * res + EXCLUDED.x1 + 1);
  }
  if (opts.derive !== false) world.deriveAll();
  return world;
}

export function scatterTotals(world) {
  const totals = {};
  let total = 0;
  const detail = new Set(world.layerList().filter((L) => L.detail).map((L) => L.key));
  for (const cell of world.scatterCells.values()) {
    for (const [key, l] of cell.layers) {
      if (detail.has(key)) continue;
      totals[key] = (totals[key] || 0) + l.count;
      total += l.count;
    }
  }
  return { totals, total };
}
