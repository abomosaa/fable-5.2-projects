// Serialisation of a world into the on-disk project layout (shared by the editor's store,
// the showcase builder and the tests). DOM-free.
import { quantizeHeights, dequantizeHeights, packHeights, unpackHeights, packU16, unpackU16, packU8, unpackU8, packPaint, unpackPaint, sedimentToU8, sedimentFromU8, referencedAssets, PROJECT_VERSION } from './project.js';

/** @returns {Promise<{[name:string]: Uint8Array}>} files; project.json is included (and must be written last). */
export async function serializeWorld(world, manifest, opts = {}) {
  const doc = world.project;
  const files = {};
  // heights: lossless fixed point (1/1024 m), see project.js
  doc.terrain.heightFormat = 'q1024-delta-i32';
  delete doc.terrain.hMin;
  delete doc.terrain.hMax;
  doc.version = PROJECT_VERSION;
  doc.modified = opts.timestamp || new Date().toISOString();
  doc.scatter = doc.scatter || {};
  doc.scatter.suppressed = [...world.suppressed];
  files['heights.q.gz'] = await packHeights(world.hUser.data);
  files['sediment.u8.gz'] = await packU8(sedimentToU8(world.sediment));
  files['paint.bin.gz'] = await packPaint(world.paint, world.res);
  if (world.ring && opts.ring !== false) {
    const rq = quantizeHeights(world.ring.data);
    doc.terrain.ring = { res: world.ring.res, size: world.ring.size, hMin: rq.hMin, hMax: rq.hMax };
    files['ring.u16.gz'] = await packU16(rq.u16);
  }
  const refs = referencedAssets(doc);
  const lock = {
    models: refs.models.map((m) => ({ id: m, files: manifest.models[m]?.lods?.map((l) => l.file).filter(Boolean) || [], source: manifest.models[m]?.source?.url || null })),
    textures: refs.textures.map((t) => ({ id: t, files: Object.values(manifest.textures[t]?.files || {}), source: manifest.textures[t]?.source?.url || null })),
  };
  const enc = new TextEncoder();
  files['assets.lock.json'] = enc.encode(JSON.stringify(lock));
  files['project.json'] = enc.encode(JSON.stringify(doc));
  return files;
}

/** Inverse of serializeWorld. `read(name, optional)` returns Uint8Array or null. */
export async function deserializeProject(read) {
  const pj = await read('project.json');
  const doc = JSON.parse(new TextDecoder().decode(pj));
  if ((doc.version || 0) > PROJECT_VERSION) throw new Error(`Project "${doc.name}" was saved by a newer version (${doc.version}) of the editor.`);
  const res = doc.terrain.res;
  const lossless = doc.terrain.heightFormat === 'q1024-delta-i32';
  const [hb, sb, rb, pb] = await Promise.all([read(lossless ? 'heights.q.gz' : 'heights.u16.gz'), read('sediment.u8.gz', true), read('ring.u16.gz', true), read('paint.bin.gz', true)]);
  let heights;
  if (lossless) heights = await unpackHeights(hb);
  else {
    // projects saved before format 4: 16-bit heights scaled to their min / max
    const u16 = await unpackU16(hb);
    heights = dequantizeHeights(u16, doc.terrain.hMin, doc.terrain.hMax);
  }
  if (heights.length !== res * res) throw new Error(`Project "${doc.name}": height layer has ${heights.length} samples, expected ${res * res}.`);
  const sediment = sb ? sedimentFromU8(await unpackU8(sb)) : new Float32Array(res * res);
  let ring = null;
  if (rb && doc.terrain.ring) {
    const r16 = await unpackU16(rb);
    ring = { res: doc.terrain.ring.res, size: doc.terrain.ring.size, data: dequantizeHeights(r16, doc.terrain.ring.hMin, doc.terrain.ring.hMax) };
  }
  const paint = await unpackPaint(pb, res);
  return { doc, data: { heights, sediment, ring, paint } };
}
