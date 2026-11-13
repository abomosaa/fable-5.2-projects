// Builds the three showcase projects with the same core code the editor uses (terrain generator,
// modifiers, water solve, biome rules) and writes them to ./showcases/<id>/ in the normal project
// format. They are ordinary projects: everything in them can be edited, saved and re-derived.
//   node tools/build-showcases.mjs [valley|lake|coast ...] [--res 2049]

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateTerrain, defaultTerrainParams } from '../src/core/terrainGen.js';
import { createProjectDoc } from '../src/core/project.js';
import { World } from '../src/core/world.js';
import { serializeWorld } from '../src/core/projectIO.js';
import { samplePath } from '../src/core/paths.js';
import { NO_WATER } from '../src/core/waterField.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'public/assets/manifest.json'), 'utf8'));
const args = process.argv.slice(2);
const resArg = args.includes('--res') ? +args[args.indexOf('--res') + 1] : 2049;
const which = args.filter((a) => ['valley', 'lake', 'coast'].includes(a));
const STAMP = '2026-11-11T00:00:00.000Z';

function log(...a) {
  console.log(...a);
}

function build(preset, seed, name, id, showcase, terrainExtra = {}) {
  const t0 = performance.now();
  const params = { ...defaultTerrainParams(preset, seed), res: resArg, coarseRes: 1025, ...terrainExtra };
  const gen = generateTerrain(params);
  const { doc, missing } = createProjectDoc({ name, preset, seed, manifest, terrain: params });
  if (missing.length) throw new Error('asset library incomplete: ' + missing.join(', '));
  doc.id = id;
  doc.showcase = showcase;
  doc.created = STAMP;
  doc.terrain = { ...doc.terrain, ...gen.params, hMin: 0, hMax: 1, operations: [] };
  log(`[${id}] terrain generated in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  return { doc, gen };
}

/** Offset polyline to one side of a path, simplified to nodes every `step` metres. */
function offsetPath(nodes, offset, step, from = 0, to = 1) {
  const sp = samplePath(nodes, 4);
  const out = [];
  const k0 = Math.floor(sp.n * from),
    k1 = Math.floor((sp.n - 1) * to);
  const every = Math.max(1, Math.round(step / sp.ds));
  for (let k = k0; k <= k1; k += every) out.push({ x: sp.x[k] - sp.tz[k] * offset, z: sp.z[k] + sp.tx[k] * offset });
  return out;
}

function findSite(world, x, z, rules, type = 'cabin', radius = 60, seedRot = 0) {
  // spiral search for a valid structure site near (x, z)
  for (let r = 0; r <= radius; r += 4) {
    const n = r === 0 ? 1 : Math.ceil((2 * Math.PI * r) / 5);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + r * 0.37;
      const s = { id: 'probe', type, x: x + Math.cos(a) * r, z: z + Math.sin(a) * r, rot: seedRot, variant: 3 };
      if (!world.hFinal.inBounds(s.x, s.z)) continue;
      if (!world.checkStructureSite(s, rules)) return s;
    }
  }
  return null;
}

/** Nearest spot to (x, z) with no tree or sizeable rock within `clear` metres (so views do not start inside a boulder). */
function clearSpot(world, x, z, clear = 3, accept = () => true) {
  const blocked = (px, pz) => {
    const cs = 64, half = world.size / 2;
    const cx = Math.floor((px + half) / cs), cz = Math.floor((pz + half) / cs);
    const layers = new Map(world.layerList().map((L) => [L.key, L]));
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const cell = world.scatterCells.get(cx + dx + ',' + (cz + dz));
      if (!cell) continue;
      for (const [key, inst] of cell.layers) {
        const L = layers.get(key);
        for (let i = 0; i < inst.count; i++) {
          const o = i * 8;
          const m = manifest.models[L.layer.models[inst.data[o + 7] | 0].id];
          const r = (m ? m.radius : 0.5) * inst.data[o + 3];
          const big = m && (m.category.startsWith('tree') || (m.category === 'rock' && m.height * inst.data[o + 3] > 0.35) || m.category === 'deadwood' || m.category === 'shrub');
          if (big && Math.hypot(inst.data[o] - px, inst.data[o + 2] - pz) < clear + r * 0.7) return true;
        }
      }
    }
    return false;
  };
  for (let r = 0; r <= 14; r += 0.75) {
    const n = r === 0 ? 1 : Math.ceil((2 * Math.PI * r) / 0.9);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      if (accept(px, pz) && !blocked(px, pz)) return { x: px, z: pz };
    }
  }
  return { x, z };
}

function facing(from, to) {
  // rotation so the building front (+Z) faces `to`
  return Math.atan2(to.x - from.x, to.z - from.z);
}

// ---------------------------------------------------------------------------------------------
function valley() {
  const { doc, gen } = build('alpine', 7, 'Mountain Valley', 'showcase-valley', '1-valley');
  const river = gen.suggested.rivers[0];
  doc.water.rivers.push({ id: 'river-main', name: 'Valley river', nodes: river.map((p) => ({ x: p.x, z: p.z })), width: 11, depth: 0.8, flow: 9, bedRoughness: 0.4, poolRiffle: 0.55 });
  doc.env = { ...doc.env, timeOfDay: 10.4, sunAzimuth: 150, cloudCover: 0.42, cloudHeight: 2100, fogDensity: 0.22, fogHeight: 260, windDir: 0.5, windSpeed: 3.5, turbidity: 2.0 };
  doc.water.riverWaveScale = 1.0;
  // trail along the east bank, from the upper third to the lower third of the valley
  const nodes = doc.water.rivers[0].nodes;
  doc.roads.push({ id: 'trail-river', kind: 'trail', name: 'River trail', nodes: offsetPath(nodes, -22, 55, 0.12, 0.9), width: 1.7 });
  let world = new World(doc, gen, manifest);
  world.deriveAll();
  // a small cluster of cabins on the valley floor by the trail
  const tr = doc.roads[0].nodes;
  const anchor = tr[Math.floor(tr.length * 0.52)];
  const st = { id: 'settle-valley', name: 'Trail huts', x: anchor.x, z: anchor.z, radius: 85, count: 3, seed: 4, types: ['cabin', 'cabin', 'shed'], rules: { maxSlope: 0.22, minWaterDist: 9, minSpacing: 20, maxRoadDist: 30, minRoadDist: 7 } };
  doc.settlements.push(st);
  doc.structures.push(...world.generateSettlement(st));
  doc.structureRules = { maxSlope: 0.4, minWaterDist: 3 };
  world = new World(doc, gen, manifest);
  world.deriveAll();
  // opening view: on the gravel bank, eye level, looking upstream
  const c = world.compiled.rivers[0];
  const k = Math.floor(c.sp.n * 0.5);
  const nx = -c.sp.tz[k],
    nz = c.sp.tx[k];
  const dry = (x, z) => world.waterDepthAt(x, z) <= 0 && world.masks.bank[Math.round(world.hFinal.toGridZ(z)) * world.res + Math.round(world.hFinal.toGridX(x))] > 0;
  const spot = clearSpot(world, c.sp.x[k] + nx * (c.hw[k] + 2.5), c.sp.z[k] + nz * (c.hw[k] + 2.5), 2.6, dry);
  const px = spot.x,
    pz = spot.z;
  const up = Math.max(0, k - Math.round(45 / c.sp.ds));
  doc.view = { mode: 'walk', position: [px, world.heightAt(px, pz) + 1.7, pz], lookAt: [c.sp.x[up], c.surf[up] + 0.6, c.sp.z[up]], fov: 55 };
  doc.cameras = [
    { name: 'River bank', ...doc.view },
    { name: 'Aerial', mode: 'fly', position: [c.sp.x[k] + 320, c.surf[k] + 430, c.sp.z[k] + 520], lookAt: [c.sp.x[k], c.surf[k], c.sp.z[k] - 150], fov: 55 },
  ];
  doc.notes = 'Mountain valley: clear river with pools, riffles and boulders, conifer forest, a foot trail and trail huts.';
  return { doc, world, gen };
}

function lake() {
  const { doc, gen } = build('lake', 3, 'Sheltered Lake', 'showcase-lake', '2-lake');
  const L = gen.suggested.lakes[0];
  if (!L) throw new Error('lake preset produced no lake basin');
  doc.water.lakes.push({ id: 'lake-main', name: 'Lake', x: L.x, z: L.z, level: L.level });
  doc.env = { ...doc.env, timeOfDay: 9.2, sunAzimuth: 115, cloudCover: 0.38, cloudHeight: 1500, fogDensity: 0.3, fogHeight: 160, windDir: 2.4, windSpeed: 2.6, turbidity: 2.4 };
  doc.water.lakeWaveScale = 1.0;
  // inflow stream: the upstream part of the trunk river, stopping where it meets the lake
  const pre = new World(doc, gen, manifest);
  const riv = gen.suggested.rivers[0] || [];
  const inflow = [];
  for (const p of riv) {
    const g = pre.hUser.sample(p.x, p.z);
    inflow.push({ x: p.x, z: p.z });
    if (g < L.level - 1.2) break;
  }
  if (inflow.length >= 3) doc.water.rivers.push({ id: 'river-inflow', name: 'Inflow stream', nodes: inflow, width: 6, depth: 0.5, flow: 2.2, bankWidth: 5 });
  let world = new World(doc, gen, manifest);
  world.deriveAll();
  // find a sheltered shore site: gentle bank, open water in front (towards -z where the massif is)
  const wf = world.water,
    hf = world.hFinal,
    res = world.res;
  let best = null;
  for (let iz = 40; iz < res - 40; iz += 3) {
    for (let ix = 40; ix < res - 40; ix += 3) {
      const i = iz * res + ix;
      if (wf.type[i] !== 0 || wf.shore[i] < -5 || wf.shore[i] > -2.5) continue;
      const x = hf.toWorldX(ix),
        z = hf.toWorldZ(iz);
      if (Math.hypot(x - L.x, z - L.z) > 420) continue;
      if (hf.slope(x, z) > 0.14) continue;
      // the ground behind the shore must be gentle too (no steep bank next to the viewpoint)
      let steep = false;
      for (let q = 0; q < 8 && !steep; q++) {
        const qa = (q / 8) * Math.PI * 2;
        const qx = x + Math.cos(qa) * 14,
          qz = z + Math.sin(qa) * 14;
        if (Math.abs(hf.sample(qx, qz) - hf.data[i]) > 3.2) steep = true;
      }
      if (steep) continue;
      // open water length looking north-west..north-east
      let bestDir = null;
      for (const a of [-2.2, -1.9, -1.57, -1.25, -0.95]) {
        let open = 0;
        for (let d = 6; d < 420; d += 6) {
          const gx = Math.round(hf.toGridX(x + Math.cos(a) * d)),
            gz = Math.round(hf.toGridZ(z + Math.sin(a) * d));
          if (gx < 0 || gz < 0 || gx >= res || gz >= res || wf.type[gz * res + gx] !== 2) break;
          open = d;
        }
        if (!bestDir || open > bestDir.open) bestDir = { a, open };
      }
      if (bestDir.open > 110 && (!best || bestDir.open > best.open)) best = { x, z, a: bestDir.a, open: bestDir.open };
    }
  }
  if (!best) throw new Error('no suitable lake shore site found');
  const dir = { x: Math.cos(best.a), z: Math.sin(best.a) };
  const side = { x: -dir.z, z: dir.x };
  // jetty reaching out over the water
  const pierLen = 9.36;
  // the jetty starts where the water begins and reaches out towards deeper water
  const depthAt = (t, sd) => world.waterDepthAt(best.x + dir.x * t + side.x * sd, best.z + dir.z * t + side.z * sd);
  let t0 = 2.5;
  for (let t = 0; t < 30; t += 0.5) {
    if (depthAt(t, 9) > 0.12) {
      t0 = t - 1.2;
      break;
    }
  }
  const px = best.x + dir.x * (t0 + pierLen / 2) + side.x * 9,
    pz = best.z + dir.z * (t0 + pierLen / 2) + side.z * 9;
  // floating objects need water deep enough to float in: offset them outwards if the shelf is shallow
  let fOff = 0;
  for (let t = 0; t < 40; t += 0.5) {
    if (depthAt(t0 + pierLen / 2 - 0.5 + t, 6) > 0.95 && depthAt(t0 + pierLen / 2 - 0.5 + t, 12) > 0.95) {
      fOff = t;
      break;
    }
  }
  console.log(`[lake] jetty starts ${t0.toFixed(1)} m from the view point, depth at its end ${depthAt(t0 + pierLen, 9).toFixed(2)} m; floating objects offset ${fOff.toFixed(1)} m`);
  doc.structures.push({ id: 'pier', type: 'model', model: 'modular_wooden_pier', name: 'Jetty', x: px, z: pz, rot: facing({ x: 0, z: 0 }, dir), overWater: true, deckHeight: 0.6 });
  // cabin behind the shore and a gravel road to it
  const cabinAt = findSite(world, best.x - dir.x * 26 + side.x * 14, best.z - dir.z * 26 + side.z * 14, { maxSlope: 0.25, minWaterDist: 8 }, 'cabin', 70);
  if (cabinAt) {
    doc.structures.push({ id: 'cabin-lake', type: 'cabin', name: 'Lake cabin', x: cabinAt.x, z: cabinAt.z, rot: facing(cabinAt, best), variant: 12, porch: true, chimney: true });
    const far = { x: cabinAt.x - dir.x * 240 + side.x * 60, z: cabinAt.z - dir.z * 240 + side.z * 60 };
    doc.roads.push({ id: 'road-lake', kind: 'road', name: 'Lake road', nodes: [far, { x: cabinAt.x - dir.x * 120 + side.x * 55, z: cabinAt.z - dir.z * 120 + side.z * 55 }, { x: cabinAt.x - dir.x * 40 + side.x * 30, z: cabinAt.z - dir.z * 40 + side.z * 30 }, { x: cabinAt.x - dir.x * 14 + side.x * 12, z: cabinAt.z - dir.z * 14 + side.z * 12 }], width: 4.2 });
    doc.roads.push({ id: 'trail-jetty', kind: 'trail', name: 'Path to the jetty', nodes: [{ x: cabinAt.x + dir.x * 7, z: cabinAt.z + dir.z * 7 }, { x: (cabinAt.x + px) / 2 + side.x * 2, z: (cabinAt.z + pz) / 2 + side.z * 2 }, { x: px - dir.x * (pierLen / 2 + 4.5), z: pz - dir.z * (pierLen / 2 + 4.5) }], width: 1.4 });
  }
  // floating objects by the jetty, shore furniture
  const fl = (id, model, a, b, extra = {}) => doc.objects.push({ id, model, x: px + dir.x * (a + fOff) + side.x * b, z: pz + dir.z * (a + fOff) + side.z * b, rot: (a * 1.7 + b) % 6.28, scale: 1, floating: true, ...extra });
  fl('float-barrel', 'wine_barrel_01', 2.5, 3.2, { density: 0.5 });
  fl('float-crate', 'wooden_crate_01', -0.5, -3.0, { density: 0.4 });
  fl('float-bucket', 'wooden_bucket_01', 5.5, -2.4, { density: 0.35 });
  fl('float-duck', 'rubber_duck_toy', 3.4, -4.2, { density: 0.18, scale: 1.6 });
  fl('float-crate2', 'wooden_crate_02', 7.5, 2.6, { density: 0.45 });
  doc.objects.push({ id: 'bench', model: 'painted_wooden_bench', x: best.x - dir.x * 3 - side.x * 4, z: best.z - dir.z * 3 - side.z * 4, rot: facing({ x: 0, z: 0 }, dir), scale: 1 });
  doc.objects.push({ id: 'firepit', model: 'stone_fire_pit', x: best.x - dir.x * 6 - side.x * 9, z: best.z - dir.z * 6 - side.z * 9, rot: 0.4, scale: 1 });
  doc.structureRules = { maxSlope: 0.4, minWaterDist: 3 };
  world = new World(doc, gen, manifest);
  // authored edit: thin the reed bed in front of the landing so the lake is open to view
  {
    const N = world.res * world.res;
    const dens = (world.paint.density.reeds = new Uint8Array(N).fill(128));
    const hf2 = world.hUser;
    const R = 46;
    const rc = hf2.rectFromWorld(best.x - R - 12, best.z - R - 12, best.x + R + 12, best.z + R + 12);
    for (let iz = rc.z0; iz <= rc.z1; iz++) {
      for (let ix = rc.x0; ix <= rc.x1; ix++) {
        const wx = hf2.toWorldX(ix) - best.x,
          wz = hf2.toWorldZ(iz) - best.z;
        const al = wx * dir.x + wz * dir.z,
          ac = wx * side.x + wz * side.z;
        // ellipse stretched along the shore, offset towards the jetty
        // (it reaches out over the shallow shelf in front of the landing, where reeds would otherwise close the view)
        const d = Math.hypot((al - 12) / 30, (ac - 5) / 17);
        if (d < 1) dens[iz * world.res + ix] = Math.round(128 * Math.min(1, Math.max(0, (d - 0.55) / 0.45)));
      }
    }
  }
  world.deriveAll();
  const sp1 = clearSpot(world, best.x - dir.x * 4.5 - side.x * 1.5, best.z - dir.z * 4.5 - side.z * 1.5, 2.2, (x, z) => world.waterDepthAt(x, z) <= 0);
  const ex = sp1.x,
    ez = sp1.z;
  doc.view = { mode: 'walk', position: [ex, world.heightAt(ex, ez) + 1.7, ez], lookAt: [best.x + dir.x * 70 + side.x * 12, L.level + 1.0, best.z + dir.z * 70 + side.z * 12], fov: 55 };
  doc.cameras = [
    { name: 'Shore', ...doc.view },
    { name: 'Aerial', mode: 'fly', position: [best.x - dir.x * 260 + side.x * 120, L.level + 260, best.z - dir.z * 260 + side.z * 120], lookAt: [best.x + dir.x * 120, L.level, best.z + dir.z * 120], fov: 55 },
  ];
  doc.notes = 'Sheltered lake behind a moraine: reed beds, mixed forest, a jetty with floating objects, a cabin and its access road.';
  doc.showcaseInfo = { shore: best, pier: { x: px, z: pz } };
  return { doc, world, gen };
}

function coast() {
  const { doc, gen } = build('coast', 5, 'Rugged Coast', 'showcase-coast', '3-coast');
  doc.water.sea = { enabled: true, level: gen.suggested.seaLevel ?? 0 };
  doc.water.swell = { height: 1.05, period: 9.5, dir: 0.12 };
  doc.env = { ...doc.env, timeOfDay: 15.2, sunAzimuth: 205, cloudCover: 0.42, cloudHeight: 1300, fogDensity: 0.18, fogHeight: 120, windDir: 0.25, windSpeed: 6.5, turbidity: 2.6 };
  let world = new World(doc, gen, manifest);
  world.deriveAll();
  // beach site: sandy cell near the waterline with the longest sandy shore around it
  const wf = world.water,
    hf = world.hFinal,
    res = world.res;
  const sea = doc.water.sea.level;
  let best = null;
  for (let iz = 60; iz < res - 60; iz += 4) {
    for (let ix = 60; ix < res - 60; ix += 4) {
      const i = iz * res + ix;
      if (wf.type[i] !== 0 || wf.shore[i] < -9 || wf.shore[i] > -5) continue;
      const hgt = hf.data[i] - sea;
      if (hgt < 0.4 || hgt > 2.2) continue;
      // count sand around
      let sand = 0;
      for (let dz = -24; dz <= 24; dz += 4) for (let dx = -8; dx <= 8; dx += 4) sand += world.weights[((iz + dz) * res + ix + dx) * 8 + 3] > 150 ? 1 : 0;
      const x = hf.toWorldX(ix),
        z = hf.toWorldZ(iz);
      const score = sand - Math.abs(z) * 0.01;
      if (!best || score > best.score) best = { x, z, score };
    }
  }
  if (!best) throw new Error('no beach found');
  // seaward direction = towards decreasing terrain height
  // seaward direction = gradient of the signed shore distance (positive inside water), smoothed
  const shoreAt = (x, z) => wf.shore[Math.round(hf.toGridZ(z)) * res + Math.round(hf.toGridX(x))];
  let gx = 0,
    gz = 0;
  for (const r of [8, 14, 22]) {
    gx += shoreAt(best.x + r, best.z) - shoreAt(best.x - r, best.z);
    gz += shoreAt(best.x, best.z + r) - shoreAt(best.x, best.z - r);
  }
  const gl = Math.hypot(gx, gz) || 1;
  const seaDir = { x: gx / gl, z: gz / gl };
  const along = { x: -seaDir.z, z: seaDir.x };
  // cabin on the grass behind the beach + trail down to the sand
  const cabinAt = findSite(world, best.x - seaDir.x * 75, best.z - seaDir.z * 75, { maxSlope: 0.25, minWaterDist: 30 }, 'cabin', 90);
  if (cabinAt) {
    doc.structures.push({ id: 'cabin-coast', type: 'cabin', name: 'Beach cabin', x: cabinAt.x, z: cabinAt.z, rot: facing(cabinAt, best), variant: 41, porch: true });
    doc.roads.push({ id: 'trail-beach', kind: 'trail', name: 'Beach path', nodes: [{ x: cabinAt.x - seaDir.x * 150 + along.x * 40, z: cabinAt.z - seaDir.z * 150 + along.z * 40 }, { x: cabinAt.x - seaDir.x * 60 + along.x * 25, z: cabinAt.z - seaDir.z * 60 + along.z * 25 }, { x: cabinAt.x + seaDir.x * 9 + along.x * 8, z: cabinAt.z + seaDir.z * 9 + along.z * 8 }, { x: best.x - seaDir.x * 22, z: best.z - seaDir.z * 22 }], width: 1.6 });
  }
  // a buoy and a channel marker beyond the surf, driftwood crate in the shallows
  doc.objects.push({ id: 'buoy', model: 'ocean_buoy', x: best.x + seaDir.x * 150 + along.x * 30, z: best.z + seaDir.z * 150 + along.z * 30, rot: 0.3, scale: 1, floating: true, density: 0.42 });
  doc.objects.push({ id: 'barrel-sea', model: 'wine_barrel_01', x: best.x + seaDir.x * 95 - along.x * 25, z: best.z + seaDir.z * 95 - along.z * 25, rot: 1.3, scale: 1, floating: true, density: 0.5 });
  doc.structureRules = { maxSlope: 0.4, minWaterDist: 3 };
  world = new World(doc, gen, manifest);
  world.deriveAll();
  const sp1 = clearSpot(world, best.x - seaDir.x * 2 - along.x * 4, best.z - seaDir.z * 2 - along.z * 4, 2.5, (x, z) => world.waterDepthAt(x, z) <= 0);
  const ex = sp1.x,
    ez = sp1.z;
  doc.view = { mode: 'walk', position: [ex, world.heightAt(ex, ez) + 1.7, ez], lookAt: [best.x + seaDir.x * 45 + along.x * 95, sea + 1.5, best.z + seaDir.z * 45 + along.z * 95], fov: 58 };
  log(`[coast] beach site ${best.x.toFixed(0)},${best.z.toFixed(0)} ground ${(world.heightAt(best.x, best.z) - sea).toFixed(2)} m above sea; eye ${(world.heightAt(ex, ez) + 1.7 - sea).toFixed(2)} m; seaDir ${seaDir.x.toFixed(2)},${seaDir.z.toFixed(2)}`);
  doc.cameras = [
    { name: 'Beach', ...doc.view },
    { name: 'Aerial', mode: 'fly', position: [best.x + seaDir.x * 260 - along.x * 200, sea + 190, best.z + seaDir.z * 260 - along.z * 200], lookAt: [best.x, sea, best.z + along.z * 60], fov: 55 },
  ];
  doc.notes = 'Rugged coast: refracted swell breaking on a sandy bay between rocky headlands with sea stacks; a cabin and beach path.';
  doc.showcaseInfo = { beach: best, seaDir, along };
  return { doc, world, gen };
}

const builders = { valley, lake, coast };
for (const k of which.length ? which : ['valley', 'lake', 'coast']) {
  const t0 = performance.now();
  const { doc, world } = builders[k]();
  const dir = join(ROOT, 'showcases', doc.id);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  const files = await serializeWorld(world, manifest, { timestamp: STAMP });
  let bytes = 0;
  for (const [name, data] of Object.entries(files)) {
    writeFileSync(join(dir, name), data);
    bytes += data.length;
  }
  let inst = 0;
  for (const c of world.scatterCells.values()) for (const l of c.layers.values()) inst += l.count;
  const wet = world.water.type.reduce((s, v) => s + (v ? 1 : 0), 0);
  let surfMin = Infinity;
  for (const s of world.water.surf) if (s > NO_WATER * 0.5 && s < surfMin) surfMin = s;
  log(`[${doc.id}] written to showcases/${doc.id} (${(bytes / 1e6).toFixed(1)} MB) in ${((performance.now() - t0) / 1000).toFixed(1)} s — ${inst} scatter instances, ${wet} wet cells, ${doc.structures.length} structures, ${doc.objects.length} objects, ${doc.roads.length} paths`);
}
