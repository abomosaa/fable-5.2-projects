#!/usr/bin/env node
// Headless export: generate a world for a preset / seed, add the suggested water features plus a
// road, a trail, a cabin and an object, and write a full export folder with the same exporter
// the editor uses.
//
//   node tools/export-cli.mjs <preset> <seed> <outDir> [--res 513] [--size <m>] [--mesh 513]
//                             [--tex 2048] [--lod 1] [--max-instances 400000]
//
// Verify the result with:  node tools/verify-export.mjs <outDir>

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateTerrain, defaultTerrainParams, TERRAIN_PRESETS } from '../src/core/terrainGen.js';
import { createProjectDoc } from '../src/core/project.js';
import { World } from '../src/core/world.js';
import { exportWorld } from '../src/export/exporter.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ASSETS_DIR = join(ROOT, 'public', 'assets');

export function loadManifest() {
  const p = join(ASSETS_DIR, 'manifest.json');
  if (!existsSync(p)) throw new Error(`Asset manifest not found at ${p}. Run "npm run assets" to install the asset library.`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** loadAsset implementation for Node: reads from public/assets. */
export const loadAssetFromDisk = async (rel) => new Uint8Array(await readFile(join(ASSETS_DIR, rel)));

/**
 * Add a cabin, a road + trail leading to it and a barrel next to it. The site is searched
 * deterministically (dry, gentle, away from water); returns what was placed.
 */
export function decorateWorld(world, manifest) {
  const doc = world.project;
  const hf = world.hFinal;
  const half = world.size / 2;
  const placed = { cabin: null, road: null, trail: null, object: null };
  // candidate anchors: beside the river mid-point, the lake, then the map centre
  const anchors = [];
  const rv = doc.water.rivers[0];
  if (rv) {
    const n = rv.nodes[Math.floor(rv.nodes.length * 0.45)];
    anchors.push([n.x, n.z]);
  }
  for (const l of doc.water.lakes) anchors.push([l.x, l.z]);
  anchors.push([0, 0]);
  const dry = (x, z) => hf.inBounds(x, z) && Math.abs(x) < half * 0.9 && Math.abs(z) < half * 0.9 && world.waterDepthAt(x, z) <= 0;
  let site = null;
  search: for (const [ax, az] of anchors) {
    for (let ring = 2; ring < 40; ring++) {
      const r = ring * Math.max(8, hf.cell * 2);
      const steps = Math.max(8, Math.round((2 * Math.PI * r) / 20));
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2 + ring * 0.37;
        const x = ax + Math.cos(a) * r,
          z = az + Math.sin(a) * r;
        if (!dry(x, z)) continue;
        const s = { id: 'cabin-1', type: 'cabin', x, z, rot: Math.atan2(ax - x, az - z), variant: 3 };
        if (world.checkStructureSite(s, { maxSlope: 0.3, minWaterDist: 6 })) continue;
        site = s;
        break search;
      }
    }
  }
  if (!site) return placed;
  doc.structures.push(site);
  placed.cabin = site;
  // road + trail: leave from a side (or the front) of the cabin along the gentlest dry direction
  const fx = Math.sin(site.rot),
    fz = Math.cos(site.rot); // local +Z (front) in world space
  const rx = Math.cos(site.rot),
    rz = -Math.sin(site.rot); // local +X in world space
  const shoreAt = (x, z) => world.water.shore[Math.round(hf.toGridZ(z)) * world.res + Math.round(hf.toGridX(x))];
  const pick = (len, n, avoid) => {
    let best = null;
    for (const [ox, oz] of [
      [rx, rz],
      [-rx, -rz],
      [fx, fz],
    ]) {
      const start = { x: site.x + ox * 10, z: site.z + oz * 10 };
      if (!dry(start.x, start.z)) continue;
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        if (avoid !== undefined && Math.abs(Math.atan2(Math.sin(a - avoid), Math.cos(a - avoid))) < 0.9) continue;
        const dx = Math.sin(a),
          dz = Math.cos(a);
        // head away from the building, never back through it
        if (dx * ox + dz * oz < 0.1) continue;
        const nodes = [start];
        let cost = 0,
          ok = true,
          prev = hf.sample(start.x, start.z);
        for (let i = 1; i <= n; i++) {
          const bend = Math.sin(i * 1.7 + k) * 0.18;
          const x = start.x + ((dx * Math.cos(bend) - dz * Math.sin(bend)) * (len * i)) / n,
            z = start.z + ((dz * Math.cos(bend) + dx * Math.sin(bend)) * (len * i)) / n;
          if (!dry(x, z) || shoreAt(x, z) > -Math.max(5, hf.cell)) {
            ok = false;
            break;
          }
          const h = hf.sample(x, z);
          cost += Math.abs(h - prev);
          prev = h;
          nodes.push({ x, z });
        }
        if (ok && (!best || cost < best.cost)) best = { cost, nodes, angle: a };
      }
    }
    return best;
  };
  const road = pick(Math.min(260, world.size * 0.2), 4);
  if (road) {
    doc.roads.push({ id: 'road-1', name: 'Access road', kind: 'road', nodes: road.nodes });
    placed.road = doc.roads[doc.roads.length - 1];
    const trail = pick(Math.min(160, world.size * 0.12), 3, road.angle);
    if (trail) {
      doc.roads.push({ id: 'trail-1', name: 'Footpath', kind: 'trail', nodes: trail.nodes });
      placed.trail = doc.roads[doc.roads.length - 1];
    }
  }
  // a barrel beside the door (local +X side of the front wall)
  const model = ['wine_barrel_01', 'wooden_crate_01', 'wooden_bucket_01', 'boulder_01'].find((m) => manifest.models?.[m]);
  if (model) {
    doc.objects.push({ id: 'obj-1', model, x: site.x + fx * 4.6 + rx * 2.4, z: site.z + fz * 4.6 + rz * 2.4, rot: 0.6, scale: 1 });
    placed.object = doc.objects[doc.objects.length - 1];
  }
  return placed;
}

/** Generate + derive a demo world (what the CLI exports). */
export function buildDemoWorld({ preset = 'alpine', seed = 7, res = 513, size, manifest, log = () => {} }) {
  const coarseRes = res >= 1025 ? 513 : res >= 513 ? 257 : 129;
  const params = { ...defaultTerrainParams(preset, seed), res, coarseRes };
  if (size) params.size = size;
  let t0 = performance.now();
  const gen = generateTerrain(params);
  log(`generated ${preset} seed ${seed} at ${res}x${res} (${params.size} m) in ${Math.round(performance.now() - t0)} ms`);
  const { doc, missing } = createProjectDoc({ name: `${TERRAIN_PRESETS[preset]?.label || preset} (seed ${seed})`, preset, seed, manifest, terrain: { res, size: params.size, coarseRes } });
  doc.id = `cli-${preset}-${seed}`;
  if (missing.length) log(`assets missing from the manifest: ${missing.join(', ')}`);
  const cell = params.size / (res - 1);
  if (gen.suggested.rivers[0]) doc.water.rivers.push({ id: 'r1', name: 'River', nodes: gen.suggested.rivers[0].map((p) => ({ x: p.x, z: p.z })), width: Math.max(10, cell * 2.5), depth: 0.8, flow: 9 });
  gen.suggested.lakes.forEach((l, i) => doc.water.lakes.push({ id: 'l' + (i + 1), name: 'Lake', ...l }));
  if (gen.suggested.seaLevel !== null) doc.water.sea = { enabled: true, level: gen.suggested.seaLevel };
  const world = new World(doc, gen, manifest);
  t0 = performance.now();
  world.deriveAll();
  const placed = decorateWorld(world, manifest);
  world.deriveAll();
  log(`derived in ${Math.round(performance.now() - t0)} ms; cabin ${placed.cabin ? `at (${placed.cabin.x.toFixed(1)}, ${placed.cabin.z.toFixed(1)})` : 'NOT placed'}, road ${placed.road ? 'yes' : 'no'}, trail ${placed.trail ? 'yes' : 'no'}, object ${placed.object ? placed.object.model : 'none'}`);
  return { world, gen, placed };
}

async function main() {
  const args = process.argv.slice(2);
  const pos = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
    else pos.push(args[i]);
  }
  const [preset = 'alpine', seedArg = '7', outArg] = pos;
  if (!outArg || flags.help) {
    console.error('usage: node tools/export-cli.mjs <alpine|lake|coast|hills> <seed> <outDir> [--res N] [--size metres] [--mesh N] [--tex N] [--lod N] [--max-instances N]');
    process.exit(2);
  }
  if (!TERRAIN_PRESETS[preset]) {
    console.error(`unknown preset "${preset}" (expected one of ${Object.keys(TERRAIN_PRESETS).join(', ')})`);
    process.exit(2);
  }
  const res = +(flags.res || 513);
  if (!Number.isInteger(res) || res < 65 || ((res - 1) & (res - 2)) !== 0) {
    console.error('--res must be 2^n + 1 (e.g. 257, 513, 1025, 2049)');
    process.exit(2);
  }
  const outDir = resolve(outArg);
  const manifest = loadManifest();
  const log = (m) => console.log(m);
  const { world } = buildDemoWorld({ preset, seed: +seedArg, res, size: flags.size ? +flags.size : undefined, manifest, log });
  let last = '';
  const t0 = performance.now();
  const out = await exportWorld(world, manifest, {
    loadAsset: loadAssetFromDisk,
    terrainMeshRes: flags.mesh ? +flags.mesh : undefined,
    terrainTextureRes: flags.tex ? +flags.tex : undefined,
    vegetationLod: flags.lod !== undefined ? +flags.lod : undefined,
    maxInstances: flags['max-instances'] ? +flags['max-instances'] : undefined,
    onProgress: (label) => {
      if (label !== last) console.log('  ' + label);
      last = label;
    },
  });
  mkdirSync(outDir, { recursive: true });
  let total = 0;
  for (const f of out.files) {
    writeFileSync(join(outDir, f.name), f.data);
    total += f.data.length;
  }
  const c = out.report.counts;
  console.log(`exported ${out.files.length} files (${(total / 1048576).toFixed(1)} MB) to ${outDir} in ${Math.round(performance.now() - t0)} ms`);
  console.log(`scene.glb: ${(out.report.scene.bytes / 1048576).toFixed(1)} MB, ${out.report.scene.nodes} nodes, ${c.scatterInstancesInGlb} instances in ${c.scatterNodes} instanced nodes, ${c.structuresInGlb} structures, ${c.objectsInGlb} objects, ${c.roadsInGlb} roads, ${c.waterMeshes} water meshes`);
  for (const w of out.report.warnings) console.log('warning: ' + w);
  console.log(`peak memory (rss): ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MB`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}
