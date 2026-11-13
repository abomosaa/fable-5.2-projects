// Developer render harness (not part of the product UI): generates a world in-page and renders it.
import * as THREE from 'three';
import { Engine } from './render/Engine.js';
import { World } from './core/world.js';
import { generateTerrain, defaultTerrainParams } from './core/terrainGen.js';
import { createProjectDoc } from './core/project.js';

const log = (s) => { document.getElementById('log').textContent = s; console.log(s); };
const q = new URLSearchParams(location.search);
window.__dbg = { ready: false, errors: [] };
window.addEventListener('error', (e) => window.__dbg.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__dbg.errors.push(String(e.reason && e.reason.stack || e.reason)));

async function main() {
  const manifest = await (await fetch('/assets/manifest.json')).json();
  const canvas = document.getElementById('c');
  const engine = new Engine(canvas, { quality: q.get('quality') || 'high', onError: (m) => window.__dbg.errors.push(m), preserveDrawingBuffer: true });
  await engine.initAssets(manifest, '/assets/');
  const preset = q.get('preset') || 'alpine';
  const seed = +(q.get('seed') || 7);
  const res = +(q.get('res') || 1025);
  log('generating...');
  const gen = generateTerrain({ ...defaultTerrainParams(preset, seed), res, coarseRes: +(q.get('coarse') || 513) });
  const { doc, missing } = createProjectDoc({ name: 'dev', preset, seed, manifest, terrain: { res } });
  if (missing.length) console.warn('missing assets', missing);
  if (gen.suggested.rivers[0] && preset !== 'coast') doc.water.rivers.push({ id: 'r1', name: 'River', nodes: gen.suggested.rivers[0].map((p) => ({ x: p.x, z: p.z })), width: 11, depth: 0.8, flow: 9 });
  for (const l of gen.suggested.lakes) doc.water.lakes.push({ id: 'l1', name: 'Lake', ...l });
  if (gen.suggested.seaLevel !== null) doc.water.sea = { enabled: true, level: gen.suggested.seaLevel };
  const world = new World(doc, gen, manifest);
  world.deriveAll((l) => log(l));
  await engine.setWorld(world, (l) => log(l));
  const resize = () => engine.resize(canvas.clientWidth, canvas.clientHeight);
  resize();
  window.addEventListener('resize', resize);
  // simple camera placement helper
  const cam = engine.camera;
  const look = (x, y, z, tx, ty, tz) => { cam.position.set(x, y, z); cam.lookAt(tx, ty, tz); };
  const mid = doc.water.rivers[0] ? doc.water.rivers[0].nodes[doc.water.rivers[0].nodes.length >> 1] : doc.water.lakes[0] || { x: 0, z: 0 };
  const gy = world.heightAt(mid.x, mid.z);
  look(mid.x + 60, gy + 30, mid.z + 80, mid.x, gy, mid.z);
  Object.assign(window.__dbg, { engine, world, THREE, look, mid, ground: (x, z) => world.heightAt(x, z) });
  let last = performance.now();
  let frames = 0;
  const loop = (t) => {
    const dt = Math.min(0.1, (t - last) / 1000);
    last = t;
    try { engine.render(dt); } catch (e) { window.__dbg.errors.push(String(e.stack || e)); log('ERR ' + e.message); return; }
    frames++;
    if (frames === 3) window.__dbg.ready = true;
    if (frames % 30 === 0) { const s = engine.frameStats(); log(`${s.fps.toFixed(0)} fps  ${engine.stats.calls} calls  ${(engine.stats.triangles / 1e6).toFixed(2)}M tris  veg ${engine.vegetation.stats.instances} inst ${engine.vegetation.stats.impostors} imp`); }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
main().catch((e) => { window.__dbg.errors.push(String(e.stack || e)); log('FATAL ' + (e.stack || e)); });
