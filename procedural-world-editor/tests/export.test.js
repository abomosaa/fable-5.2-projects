// Export pipeline: runs exportWorld in Node on a small world with a river, a lake, the sea, roads,
// structures, objects and scatter, and checks every produced file against the world it came from.
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { exportWorld } from '../src/export/exporter.js';
import { GLBBuilder, quatRotate, quatFromEulerXYZ, contentHash } from '../src/export/glb.js';
import { parseGLB, readAccessor, readAccessorFloat, traverseScene, mat4Apply, imageBytes } from '../src/export/glbRead.js';
import { sunDirection, directionAngles } from '../src/export/sun.js';
import { instanceQuaternion, collectScatter, terrainMeshResolution, buildTerrainMesh, labelWaterBodies, buildWaterMeshes } from '../src/export/sceneBuild.js';
import { decodePNG } from '../src/core/png.js';
import { MAT_NAMES, INSTANCE_STRIDE } from '../src/core/biomes.js';
import { NO_WATER } from '../src/core/waterField.js';
import { buildStructureGeometry } from '../src/core/structures.js';
import { buildTestWorld, loadManifest, loadAsset, scatterTotals, SIZE, RES, BASIN, EXCLUDED } from './helpers/world.js';

const require = createRequire(import.meta.url);
const validator = require('gltf-validator');

let manifest, world, out, files, glb, json, placements, report;
const file = (name) => {
  const f = files.get(name);
  if (!f) throw new Error(`export did not produce ${name}`);
  return f.data;
};
const jsonFile = (name) => JSON.parse(new TextDecoder().decode(file(name)));
const progress = [];

beforeAll(async () => {
  manifest = loadManifest();
  world = buildTestWorld(manifest);
  out = await exportWorld(world, manifest, { loadAsset, terrainMeshRes: 129, terrainTextureRes: 256, onProgress: (label, f) => void progress.push([label, f]) });
  files = new Map(out.files.map((f) => [f.name, f]));
  glb = parseGLB(file('scene.glb'));
  json = glb.json;
  placements = jsonFile('placements.json');
  report = out.report;
});

const nodesByKind = (kind) => {
  const res = [];
  traverseScene(glb, (node, idx, m, parent, path) => {
    if (node.extras?.kind === kind) res.push({ node, idx, m, path });
  });
  return res;
};

describe('export file set', () => {
  it('produces every documented file with sane metadata', () => {
    const names = out.files.map((f) => f.name);
    const expected = ['heightmap_16bit.png', 'heightmap_float32.raw', 'heightmap.json', 'masks.json', 'scene.glb', 'placements.json', 'environment.json', 'export_report.json', 'README_EXPORT.md', 'mask_water_depth.png', 'mask_water_type.png', 'mask_flow.png', 'mask_biome_index.png', 'mask_moisture.png', 'mask_road.png', 'mask_sediment.png', 'mask_exclusion.png', ...MAT_NAMES.map((n) => `mask_material_${n}.png`)];
    for (const n of expected) expect(names).toContain(n);
    expect(new Set(names).size).toBe(names.length);
    for (const f of out.files) {
      expect(f.data).toBeInstanceOf(Uint8Array);
      expect(f.data.length).toBeGreaterThan(0);
      expect(typeof f.mime).toBe('string');
    }
    // the report on disk is the report returned, and lists every file
    const onDisk = jsonFile('export_report.json');
    expect(onDisk.counts).toEqual(report.counts);
    for (const n of names) expect(onDisk.files.map((f) => f.name)).toContain(n);
    expect(report.bounds.min[0]).toBe(-SIZE / 2);
    expect(report.bounds.max[2]).toBe(SIZE / 2);
    expect(report.warnings).toEqual([]);
    expect(report.missingAssets).toEqual([]);
  });

  it('reports progress monotonically and can be cancelled', async () => {
    expect(progress.length).toBeGreaterThan(8);
    for (let i = 1; i < progress.length; i++) expect(progress[i][1]).toBeGreaterThanOrEqual(progress[i - 1][1]);
    expect(progress[progress.length - 1]).toEqual(['Done', 1]);
    let calls = 0;
    const cancelled = await exportWorld(world, manifest, { loadAsset, onProgress: () => ++calls < 3 });
    expect(cancelled).toBeNull();
    expect(calls).toBe(3);
  });

  it('README documents what does not survive export', () => {
    const readme = new TextDecoder().decode(file('README_EXPORT.md'));
    expect(readme).toMatch(/## What does not survive export/);
    for (const word of ['triplanar', 'FFT', 'foam', 'austics', 'reflections', 'Wind animation', 'mpostor', 'clouds', 'detail scatter', 'Wet banks', 'Shadows', 'TEXCOORD_1', 'EXT_mesh_gpu_instancing']) expect(readme).toContain(word);
    expect(report.notExported.length).toBeGreaterThanOrEqual(10);
  });
});

describe('heightmap', () => {
  it('16-bit PNG, float32 raw and metadata agree with hFinal', async () => {
    const hm = jsonFile('heightmap.json');
    expect(hm).toMatchObject({ width: RES, height: RES, sizeMeters: SIZE, origin: 'centre', axis: 'x east, z south, y up', sampleConvention: 'vertex-centred' });
    expect(hm.cellMeters).toBeCloseTo(SIZE / (RES - 1), 12);
    const [mn, mx] = world.hFinal.minMax();
    expect(hm.minHeight).toBe(mn);
    expect(hm.maxHeight).toBe(mx);
    expect(hm.heightAt0).toBe(mn);
    expect(hm.heightAt65535).toBe(mx);
    const raw = file('heightmap_float32.raw');
    expect(raw.length).toBe(RES * RES * 4);
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const png = await decodePNG(file('heightmap_16bit.png'));
    expect(png).toMatchObject({ width: RES, height: RES, channels: 1, bitDepth: 16 });
    const step = (mx - mn) / 65535;
    let maxErr = 0;
    for (let i = 0; i < RES * RES; i++) {
      const v = dv.getFloat32(i * 4, true);
      if (v !== world.hFinal.data[i]) throw new Error(`raw height differs at ${i}`);
      maxErr = Math.max(maxErr, Math.abs(hm.heightAt0 + (png.pixels[i] / 65535) * (hm.heightAt65535 - hm.heightAt0) - v));
    }
    expect(maxErr).toBeLessThanOrEqual(step * 0.5 + 1e-5);
    // row 0 = north: the valley falls towards the south, so the last row is lower on the centreline
    expect(png.pixels[(RES >> 1)]).toBeGreaterThan(png.pixels[(RES - 1) * RES + (RES >> 1)]);
  });
});

describe('masks', () => {
  let doc;
  const mask = async (name) => {
    const m = await decodePNG(file(name));
    expect(m.width).toBe(RES);
    expect(m.height).toBe(RES);
    expect(m.bitDepth).toBe(8);
    expect(m.channels).toBe(doc.masks[name].channels);
    return m.pixels;
  };
  beforeAll(() => {
    doc = jsonFile('masks.json');
  });

  it('documents every mask image', () => {
    const pngs = out.files.map((f) => f.name).filter((n) => n.startsWith('mask_'));
    expect(Object.keys(doc.masks).sort()).toEqual(pngs.sort());
    expect(pngs.length).toBe(17);
    for (const m of Object.values(doc.masks)) expect(typeof m.encoding).toBe('string');
    expect(doc.width).toBe(RES);
  });

  it('water type / depth / flow masks encode the water field', async () => {
    const type = await mask('mask_water_type.png');
    const depth = await mask('mask_water_depth.png');
    const flow = await mask('mask_flow.png');
    const wf = world.water;
    const scale = doc.masks['mask_water_depth.png'].depthScale;
    const fs = doc.masks['mask_flow.png'].flowScale;
    const seen = new Set();
    let maxDepthErr = 0,
      maxFlowErr = 0,
      moving = 0;
    for (let i = 0; i < RES * RES; i++) {
      if (type[i] !== wf.type[i] * 85) throw new Error(`water type mask differs at ${i}`);
      seen.add(type[i]);
      const d = wf.type[i] ? wf.surf[i] - world.hFinal.data[i] : 0;
      if (wf.type[i] !== 0 !== depth[i] > 0) throw new Error(`depth mask sign differs at ${i}`);
      if (wf.type[i]) maxDepthErr = Math.max(maxDepthErr, Math.abs((depth[i] / 255) * scale - d));
      const vx = ((flow[i * 3] - 128) / 127) * fs,
        vz = ((flow[i * 3 + 1] - 128) / 127) * fs;
      maxFlowErr = Math.max(maxFlowErr, Math.abs(vx - wf.vx[i]), Math.abs(vz - wf.vz[i]), Math.abs((flow[i * 3 + 2] / 255) * fs - Math.hypot(wf.vx[i], wf.vz[i])));
      if (flow[i * 3 + 2] > 10) moving++;
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 85, 170, 255]); // dry, river, lake, ocean all present
    // quantisation: half a step, except that wet cells never encode as 0
    expect(maxDepthErr).toBeLessThanOrEqual(scale / 255 + 1e-6);
    expect(maxFlowErr).toBeLessThanOrEqual(fs / 127 / 2 + 1e-6);
    expect(moving).toBeGreaterThan(100);
    expect(scale).toBeGreaterThanOrEqual(1);
  });

  it('material masks hold the nine ground weights and sum to 255', async () => {
    const m = [];
    for (const n of MAT_NAMES) m.push(await mask(`mask_material_${n}.png`));
    let maxDev = 0;
    const used = new Array(9).fill(0);
    for (let i = 0; i < RES * RES; i++) {
      let s = 0;
      for (let k = 0; k < 9; k++) {
        s += m[k][i];
        if (m[k][i] > 127) used[k]++;
        if (k < 8 && m[k][i] !== world.weights[i * 8 + k]) throw new Error(`material mask ${MAT_NAMES[k]} differs at ${i}`);
      }
      maxDev = Math.max(maxDev, Math.abs(s - 255));
    }
    expect(maxDev).toBeLessThanOrEqual(4);
    expect(used[MAT_NAMES.indexOf('grass')]).toBeGreaterThan(500);
    expect(used[MAT_NAMES.indexOf('forest')]).toBeGreaterThan(500);
    expect(used[MAT_NAMES.indexOf('path')]).toBeGreaterThan(50); // the road
    expect(used[MAT_NAMES.indexOf('pebbles')]).toBeGreaterThan(50); // the river bed
  });

  it('biome, moisture, road, sediment and exclusion masks mirror the world arrays', async () => {
    const biome = await mask('mask_biome_index.png');
    const moisture = await mask('mask_moisture.png');
    const road = await mask('mask_road.png');
    const excl = await mask('mask_exclusion.png');
    const sed = await mask('mask_sediment.png');
    for (let i = 0; i < RES * RES; i++) {
      if (biome[i] !== world.biomeMap[i] || moisture[i] !== world.moisture[i] || road[i] !== world.masks.road[i]) throw new Error(`mask differs at ${i}`);
      if (sed[i] !== Math.round(Math.min(1, Math.max(0, world.sediment[i])) * 255)) throw new Error(`sediment mask differs at ${i}`);
    }
    // painted exclusion: exported as painted, and no scatter instance was placed inside it
    let excluded = 0;
    for (let i = 0; i < RES * RES; i++) {
      if (excl[i] !== world.paint.exclude[i]) throw new Error(`exclusion mask differs at ${i}`);
      if (excl[i] === 255) excluded++;
    }
    expect(excluded).toBe((EXCLUDED.x1 - EXCLUDED.x0 + 1) * (EXCLUDED.z1 - EXCLUDED.z0 + 1));
    const x0 = world.hFinal.toWorldX(EXCLUDED.x0),
      x1 = world.hFinal.toWorldX(EXCLUDED.x1),
      z0 = world.hFinal.toWorldZ(EXCLUDED.z0),
      z1 = world.hFinal.toWorldZ(EXCLUDED.z1);
    let inside = 0,
      around = 0;
    for (const L of placements.scatter.layers) {
      for (const [x, , z] of L.instances) {
        if (x > x0 + 1 && x < x1 - 1 && z > z0 + 1 && z < z1 - 1) inside++;
        else if (x > x0 - 40 && x < x1 + 40 && z > z0 - 40 && z < z1 + 40) around++;
      }
    }
    expect(inside).toBe(0);
    expect(around).toBeGreaterThan(20);
    const legend = doc.masks['mask_biome_index.png'].legend;
    expect(legend.map((l) => l.id)).toEqual([null, ...world.project.biomes.map((b) => b.id)]);
    expect(legend.map((l) => l.index)).toEqual(legend.map((_, i) => i));
    let roadCells = 0;
    for (let i = 0; i < road.length; i++) if (road[i] > 200) roadCells++;
    expect(roadCells).toBeGreaterThan(100);
  });
});

describe('scene.glb', () => {
  it('is a structurally sound GLB container', () => {
    const bytes = file('scene.glb');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(dv.getUint32(0, true)).toBe(0x46546c67);
    expect(dv.getUint32(4, true)).toBe(2);
    expect(dv.getUint32(8, true)).toBe(bytes.length);
    expect(bytes.length % 4).toBe(0);
    expect(glb.jsonChunkLength % 4).toBe(0);
    expect(glb.binChunkLength % 4).toBe(0);
    expect(20 + glb.jsonChunkLength + 8 + glb.binChunkLength).toBe(bytes.length);
    expect(json.asset.version).toBe('2.0');
    expect(json.buffers.length).toBe(1);
    expect(json.buffers[0].byteLength).toBe(glb.binChunkLength);
    const sizes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
    let prevEnd = 0;
    json.bufferViews.forEach((bv, i) => {
      if (bv.byteOffset % 4 !== 0) throw new Error(`bufferView ${i} is not 4-byte aligned`);
      if (bv.byteOffset < prevEnd) throw new Error(`bufferView ${i} overlaps the previous view`);
      if (bv.byteOffset + bv.byteLength > glb.binChunkLength) throw new Error(`bufferView ${i} exceeds the buffer`);
      prevEnd = bv.byteOffset + bv.byteLength;
    });
    json.accessors.forEach((a, i) => {
      const bv = json.bufferViews[a.bufferView];
      const elem = sizes[a.componentType] * comps[a.type];
      if ((a.byteOffset || 0) + a.count * elem > bv.byteLength) throw new Error(`accessor ${i} exceeds its bufferView`);
      if (a.count < 1) throw new Error(`accessor ${i} is empty`);
    });
  });

  it('declares correct POSITION bounds, unit normals and in-range indices for every primitive', () => {
    let prims = 0;
    for (const mesh of json.meshes) {
      for (const p of mesh.primitives) {
        prims++;
        const acc = json.accessors[p.attributes.POSITION];
        const pos = readAccessorFloat(glb, p.attributes.POSITION);
        const mn = [Infinity, Infinity, Infinity],
          mx = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < pos.length; i += 3) {
          for (let c = 0; c < 3; c++) {
            const v = pos[i + c];
            if (!Number.isFinite(v)) throw new Error(`${mesh.name}: non-finite position`);
            if (v < mn[c]) mn[c] = v;
            if (v > mx[c]) mx[c] = v;
          }
        }
        expect(acc.min).toEqual(mn);
        expect(acc.max).toEqual(mx);
        expect(json.bufferViews[acc.bufferView].target).toBe(34962);
        if (p.attributes.NORMAL !== undefined) {
          const n = readAccessorFloat(glb, p.attributes.NORMAL);
          expect(n.length).toBe(pos.length);
          for (let i = 0; i < n.length; i += 3) {
            const l = Math.hypot(n[i], n[i + 1], n[i + 2]);
            if (Math.abs(l - 1) > 2e-3) throw new Error(`${mesh.name}: normal length ${l}`);
          }
        }
        if (p.attributes.TEXCOORD_0 !== undefined) expect(json.accessors[p.attributes.TEXCOORD_0].count).toBe(acc.count);
        expect(p.indices).toBeDefined();
        const ia = json.accessors[p.indices];
        expect(json.bufferViews[ia.bufferView].target).toBe(34963);
        expect(ia.count % 3).toBe(0);
        const idx = readAccessor(glb, p.indices).array;
        let maxIdx = 0;
        for (let i = 0; i < idx.length; i++) if (idx[i] > maxIdx) maxIdx = idx[i];
        expect(maxIdx).toBeLessThan(acc.count);
        expect(p.material).toBeLessThan(json.materials.length);
      }
    }
    expect(prims).toBeGreaterThan(20);
  });

  it('passes the Khronos glTF validator with zero errors', async () => {
    const bytes = file('scene.glb');
    const result = await validator.validateBytes(bytes, { uri: 'scene.glb', format: 'glb', maxIssues: 0, writeTimestamp: false });
    const errors = result.issues.messages.filter((m) => m.severity === 0);
    expect(errors.map((e) => `${e.code} ${e.pointer}: ${e.message}`)).toEqual([]);
    expect(result.issues.numErrors).toBe(0);
    // warnings are limited to the (portable, but noted) runtime tangent generation
    const warningCodes = new Set(result.issues.messages.filter((m) => m.severity === 1).map((m) => m.code));
    expect([...warningCodes].filter((c) => c !== 'MESH_PRIMITIVE_GENERATED_TANGENT_SPACE')).toEqual([]);
    expect(result.info.extensionsUsed).toContain('EXT_mesh_gpu_instancing');
    expect(result.info.totalTriangleCount).toBeGreaterThan(30000);
  });

  it('handles extensions correctly (used / required)', () => {
    expect(json.extensionsUsed).toEqual([...json.extensionsUsed].sort());
    for (const e of json.extensionsRequired) expect(json.extensionsUsed).toContain(e);
    expect(json.extensionsRequired).toContain('EXT_mesh_gpu_instancing');
    for (const e of ['KHR_materials_transmission', 'KHR_materials_volume', 'KHR_materials_ior']) {
      expect(json.extensionsUsed).toContain(e);
      expect(json.extensionsRequired).not.toContain(e);
    }
    const webp = (json.images || []).some((im) => im.mimeType === 'image/webp');
    expect(json.extensionsUsed.includes('EXT_texture_webp')).toBe(webp);
    expect(json.extensionsRequired.includes('EXT_texture_webp')).toBe(webp);
    if (webp) expect(report.notes.join(' ')).toMatch(/EXT_texture_webp/);
    expect(report.scene.extensionsUsed).toEqual(json.extensionsUsed);
    // every texture resolves to an embedded image with a mime type
    for (const t of json.textures) {
      const src = t.extensions?.EXT_texture_webp?.source ?? t.source;
      expect(json.images[src].bufferView).toBeDefined();
      expect(['image/png', 'image/jpeg', 'image/webp']).toContain(json.images[src].mimeType);
    }
  });

  it('de-duplicates embedded images by content', () => {
    const seen = new Set();
    for (let i = 0; i < json.images.length; i++) {
      const h = json.images[i].mimeType + contentHash(imageBytes(glb, i).bytes);
      expect(seen.has(h)).toBe(false);
      seen.add(h);
    }
    expect(report.scene.imagesDeduplicated).toBeGreaterThan(0); // model variants share textures
    expect(report.scene.images).toBe(json.images.length);
  });

  it('has the documented node hierarchy and scene extras', () => {
    const scene = json.scenes[json.scene];
    expect(scene.nodes.length).toBe(1);
    const root = json.nodes[scene.nodes[0]];
    expect(root.name).toBe('world');
    expect(root.children.map((c) => json.nodes[c].name).sort()).toEqual(['objects', 'roads', 'scatter', 'structures', 'terrain', 'water']);
    expect(scene.extras).toMatchObject({ generator: 'Terraforge', units: 'm', seed: world.project.seed, terrainSize: SIZE });
    expect(scene.extras.waterLevels.sea).toBe(105.2);
    expect(scene.extras.waterLevels.lakes).toEqual([{ id: 'l1', level: world.project.water.lakes[0].level }]);
    // scatter/<biome>/<layer>/<model>
    const paths = nodesByKind('scatter').map((n) => n.path);
    expect(paths.length).toBeGreaterThan(10);
    for (const p of paths) {
      expect(p.length).toBe(5);
      expect(p[0]).toBe('world');
      expect(p[1]).toBe('scatter');
      expect(world.project.biomes.map((b) => b.id)).toContain(p[2]);
    }
    // no empty leaf nodes
    for (const n of json.nodes) expect(n.mesh !== undefined || (n.children && n.children.length > 0)).toBe(true);
  });

  it('terrain mesh spans the world, samples hFinal and is textured', async () => {
    const [t] = nodesByKind('terrain');
    expect(t.node.name).toBe('terrain');
    const mesh = json.meshes[t.node.mesh];
    expect(mesh.primitives.length).toBe(1);
    const p = mesh.primitives[0];
    const acc = json.accessors[p.attributes.POSITION];
    const [mn, mx] = world.hFinal.minMax();
    expect(acc.min[0]).toBe(-SIZE / 2);
    expect(acc.max[0]).toBe(SIZE / 2);
    expect(acc.min[2]).toBe(-SIZE / 2);
    expect(acc.max[2]).toBe(SIZE / 2);
    expect(acc.min[1]).toBeGreaterThanOrEqual(mn);
    expect(acc.max[1]).toBeLessThanOrEqual(mx);
    expect(acc.count).toBe(129 * 129);
    expect(t.node.extras).toMatchObject({ vertsPerSide: 129, heightfieldStride: 2 });
    const pos = readAccessorFloat(glb, p.attributes.POSITION);
    const uv = readAccessorFloat(glb, p.attributes.TEXCOORD_0);
    const nrm = readAccessorFloat(glb, p.attributes.NORMAL);
    for (let j = 0; j < 129; j++) {
      for (let i = 0; i < 129; i++) {
        const v = j * 129 + i;
        if (pos[v * 3] !== world.hFinal.toWorldX(i * 2) || pos[v * 3 + 2] !== world.hFinal.toWorldZ(j * 2)) throw new Error(`terrain vertex ${v} is off the grid`);
        if (pos[v * 3 + 1] !== world.hFinal.data[j * 2 * RES + i * 2]) throw new Error(`terrain vertex ${v} height differs from hFinal`);
        if (Math.abs(uv[v * 2] - i / 128) > 1e-6 || Math.abs(uv[v * 2 + 1] - j / 128) > 1e-6) throw new Error(`terrain uv ${v}`);
        if (!(nrm[v * 3 + 1] > 0.1)) throw new Error(`terrain normal ${v} does not point up`);
      }
    }
    // counter-clockwise seen from above (+Y)
    const idx = readAccessor(glb, p.indices).array;
    expect(idx.length).toBe(128 * 128 * 6);
    for (const t0 of [0, 3, idx.length - 3]) {
      const [a, b, c] = [idx[t0] * 3, idx[t0 + 1] * 3, idx[t0 + 2] * 3];
      const ny = (pos[b + 2] - pos[a + 2]) * (pos[c] - pos[a]) - (pos[b] - pos[a]) * (pos[c + 2] - pos[a + 2]);
      expect(ny).toBeGreaterThan(0);
    }
    const mat = json.materials[p.material];
    expect(mat.name).toBe('terrain_baked');
    expect(mat.pbrMetallicRoughness.roughnessFactor).toBeGreaterThan(0.5);
    const img = imageBytes(glb, json.textures[mat.pbrMetallicRoughness.baseColorTexture.index].source);
    expect(img.mimeType).toBe('image/png');
    const tex = await decodePNG(img.bytes);
    expect(tex).toMatchObject({ width: 256, height: 256, channels: 3, bitDepth: 8 });
    // not a flat colour, and wetter / vegetated ground differs from the gravel road
    let mnc = 255,
      mxc = 0;
    for (let i = 1; i < tex.pixels.length; i += 3) {
      mnc = Math.min(mnc, tex.pixels[i]);
      mxc = Math.max(mxc, tex.pixels[i]);
    }
    expect(mxc - mnc).toBeGreaterThan(30);
    expect(terrainMeshResolution(2049, 513)).toEqual({ n: 513, step: 4 });
    expect(terrainMeshResolution(257, 513)).toEqual({ n: 257, step: 1 });
    expect(terrainMeshResolution(257, 100)).toEqual({ n: 65, step: 4 });
  });

  it('exports one water mesh per body that agrees with the water field', () => {
    const waters = nodesByKind('water');
    expect(waters.map((w) => w.node.name).sort()).toEqual(['water_lake_l1', 'water_ocean', 'water_river_r1']);
    const res = RES;
    const hf = world.hFinal;
    for (const w of waters) {
      const mesh = json.meshes[w.node.mesh];
      const p = mesh.primitives[0];
      expect(Object.keys(p.attributes).sort()).toEqual(['NORMAL', 'POSITION', 'TEXCOORD_0', 'TEXCOORD_1']);
      const pos = readAccessorFloat(glb, p.attributes.POSITION);
      const flow = readAccessorFloat(glb, p.attributes.TEXCOORD_1);
      // single-sided material: every triangle must be counter-clockwise seen from above, normals up
      const widx = readAccessor(glb, p.indices).array;
      const wn = readAccessorFloat(glb, p.attributes.NORMAL);
      for (let t = 0; t < widx.length; t += 3) {
        const [i0, i1, i2] = [widx[t] * 3, widx[t + 1] * 3, widx[t + 2] * 3];
        const ny = (pos[i1 + 2] - pos[i0 + 2]) * (pos[i2] - pos[i0]) - (pos[i1] - pos[i0]) * (pos[i2 + 2] - pos[i0 + 2]);
        if (!(ny > 0)) throw new Error(`${mesh.name}: triangle ${t / 3} faces down`);
      }
      for (let v = 1; v < wn.length; v += 3) if (!(wn[v] > 0.7)) throw new Error(`${mesh.name}: normal does not point up`);
      expect(!!json.materials[p.material].doubleSided).toBe(false);
      let wet = 0,
        maxFlow = 0;
      for (let v = 0; v < pos.length / 3; v++) {
        const gx = hf.toGridX(pos[v * 3]),
          gz = hf.toGridZ(pos[v * 3 + 2]);
        const ix = Math.round(gx),
          iz = Math.round(gz);
        if (Math.abs(gx - ix) > 1e-4 || Math.abs(gz - iz) > 1e-4) throw new Error(`${mesh.name}: vertex off the grid`);
        const gi = iz * res + ix;
        if (pos[v * 3 + 1] !== world.water.surf[gi]) throw new Error(`${mesh.name}: vertex is not at the water surface`);
        if (flow[v * 2] !== world.water.vx[gi] || flow[v * 2 + 1] !== world.water.vz[gi]) throw new Error(`${mesh.name}: TEXCOORD_1 is not the flow velocity`);
        maxFlow = Math.max(maxFlow, Math.hypot(flow[v * 2], flow[v * 2 + 1]));
        if (world.water.type[gi] !== 0) {
          wet++;
          if (pos[v * 3 + 1] < hf.data[gi]) throw new Error(`${mesh.name}: wet vertex below the bed`);
        } else if (pos[v * 3 + 1] > hf.data[gi] + 0.03) throw new Error(`${mesh.name}: dry skirt vertex above the ground`);
      }
      expect(wet).toBeGreaterThan(3);
      const mat = json.materials[p.material];
      expect(mat.alphaMode).toBe('BLEND');
      expect(mat.pbrMetallicRoughness.baseColorFactor[3]).toBeLessThan(1);
      expect(mat.extensions.KHR_materials_transmission.transmissionFactor).toBeGreaterThan(0);
      expect(mat.extensions.KHR_materials_ior.ior).toBe(1.333);
      const vol = mat.extensions.KHR_materials_volume;
      // attenuation reproduces Beer-Lambert absorption: red is absorbed most
      const absorb = world.project.water.optics.absorb;
      for (let c = 0; c < 3; c++) expect(vol.attenuationColor[c]).toBeCloseTo(Math.exp(-absorb[c] * vol.attenuationDistance), 3);
      if (w.node.extras.body === 'river') {
        expect(maxFlow).toBeGreaterThan(0.3);
        // sloping surface: follows the river long profile from north (high) to south (low)
        const acc = json.accessors[p.attributes.POSITION];
        expect(acc.max[1] - acc.min[1]).toBeGreaterThan(8);
        // every wet river cell is covered by the full-resolution mesh
        expect(pos.length / 3).toBeGreaterThanOrEqual(world.water.stats.riverCells);
      } else {
        const level = w.node.extras.level;
        expect(level).toBe(w.node.extras.body === 'ocean' ? 105.2 : world.project.water.lakes[0].level);
        // flat bodies are decimated: far fewer vertices than wet cells
        if (w.node.extras.body === 'lake') expect(pos.length / 3).toBeLessThan(w.node.extras.wetCells);
      }
    }
    // decimation keeps exactly the same covered area as the per-cell triangulation
    const labelled = labelWaterBodies(world);
    const area = (maxRect) =>
      buildWaterMeshes(world, labelled, maxRect).map((m) => {
        let a = 0;
        for (let t = 0; t < m.indices.length; t += 3) {
          const [i, j, k] = [m.indices[t] * 3, m.indices[t + 1] * 3, m.indices[t + 2] * 3];
          a += Math.abs((m.positions[j] - m.positions[i]) * (m.positions[k + 2] - m.positions[i + 2]) - (m.positions[k] - m.positions[i]) * (m.positions[j + 2] - m.positions[i + 2])) / 2;
        }
        return Math.round(a * 1000) / 1000;
      });
    expect(area(64)).toEqual(area(1));
    expect(labelled.bodies.map((b) => b.kind).sort()).toEqual(['lake', 'ocean', 'river']);
    let wet = 0;
    for (let i = 0; i < world.water.type.length; i++) if (world.water.type[i]) wet++;
    expect(labelled.bodies.reduce((s, b) => s + b.cells, 0)).toBe(wet);
    for (let i = 0; i < world.water.type.length; i++) if ((world.water.type[i] !== 0) !== labelled.label[i] >= 0) throw new Error('wet cell without a body');
  });

  it('instances scatter with EXT_mesh_gpu_instancing; counts equal placements and the world', () => {
    const nodes = nodesByKind('scatter');
    const { totals, total } = scatterTotals(world);
    expect(total).toBeGreaterThan(3000);
    let glbTotal = 0;
    const perLayer = {};
    for (const { node } of nodes) {
      const ext = node.extensions.EXT_mesh_gpu_instancing.attributes;
      expect(Object.keys(ext).sort()).toEqual(['ROTATION', 'SCALE', 'TRANSLATION']);
      const n = json.accessors[ext.TRANSLATION].count;
      expect(json.accessors[ext.ROTATION].count).toBe(n);
      expect(json.accessors[ext.SCALE].count).toBe(n);
      expect(json.accessors[ext.ROTATION].type).toBe('VEC4');
      expect(json.bufferViews[json.accessors[ext.TRANSLATION].bufferView].target).toBeUndefined();
      expect(node.extras.count).toBe(n);
      expect(node.mesh).toBeDefined();
      expect(node.translation).toBeUndefined();
      glbTotal += n;
      const key = node.extras.biome + '/' + node.extras.layer;
      perLayer[key] = (perLayer[key] || 0) + n;
      const L = placements.scatter.layers.find((l) => l.biome === node.extras.biome && l.layer === node.extras.layer);
      const mi = L.models.indexOf(node.extras.model);
      expect(mi).toBe(node.extras.modelIndex);
      expect(L.glbInstanced[mi]).toBe(true);
      expect(L.counts[mi]).toBe(n);
      expect(L.instances.filter((r) => r[5] === mi).length).toBe(n);
    }
    expect(perLayer).toEqual(totals);
    expect(glbTotal).toBe(total);
    expect(placements.scatter.exportedInstances).toBe(total);
    expect(placements.scatter.truncated).toBe(false);
    expect(report.counts.scatterInstancesInGlb).toBe(total);
    expect(Object.keys(report.skippedModels)).toEqual([]);
    // detail layers are rules only
    expect(placements.detailLayers.layers.length).toBe(world.layerList().filter((L) => L.detail).length);
    expect(placements.detailLayers.layers.every((l) => l.runtimeOnly && l.rules.range <= 130)).toBe(true);
    for (const L of placements.scatter.layers) expect(L.rules.range === undefined || L.rules.range > 130).toBe(true);
    // the procedural reeds were generated and embedded (lakeshore/reeds)
    const reed = nodes.find((n) => n.node.extras.model === 'proc_reed');
    expect(reed).toBeDefined();
    expect(json.meshes[reed.node.mesh].extras.procedural).toBe(true);
  });

  it('instance transforms reproduce the renderer (position, uniform scale, yaw about +Y, tilt)', () => {
    // gather the world instances of one tree layer variant in export order
    const node = nodesByKind('scatter').find((n) => n.node.extras.layer === 'trees' && n.node.extras.biome === 'mixed_forest' && n.node.extras.count > 50).node;
    const ext = node.extensions.EXT_mesh_gpu_instancing.attributes;
    const T = readAccessorFloat(glb, ext.TRANSLATION),
      R = readAccessorFloat(glb, ext.ROTATION),
      S = readAccessorFloat(glb, ext.SCALE);
    const src = [];
    const cells = [...world.scatterCells.values()].sort((a, b) => a.cz - b.cz || a.cx - b.cx);
    for (const cell of cells) {
      const l = cell.layers.get('mixed_forest/trees');
      if (!l) continue;
      for (let i = 0; i < l.count; i++) if (Math.floor(l.data[i * INSTANCE_STRIDE + 7]) === node.extras.modelIndex) src.push(l.data.subarray(i * INSTANCE_STRIDE, (i + 1) * INSTANCE_STRIDE));
    }
    expect(src.length).toBe(node.extras.count);
    const shader = (p, d) => {
      // src/render/Models.js instanceTransform (without wind)
      const sc = d[3],
        cy = Math.cos(d[4]),
        sy = Math.sin(d[4]);
      const q = [p[0] * sc, p[1] * sc, p[2] * sc];
      const t = [q[0] + d[5] * q[1], q[1] - d[5] * q[0] - d[6] * q[2], q[2] + d[6] * q[1]];
      return [t[0] * cy + t[2] * sy + d[0], t[1] + d[1], -t[0] * sy + t[2] * cy + d[2]];
    };
    let maxErr = 0;
    for (let i = 0; i < src.length; i++) {
      const d = src[i];
      expect(T[i * 3]).toBe(d[0]);
      expect(T[i * 3 + 1]).toBe(d[1]);
      expect(T[i * 3 + 2]).toBe(d[2]);
      expect(S[i * 3]).toBe(d[3]);
      expect(S[i * 3 + 1]).toBe(d[3]);
      expect(S[i * 3 + 2]).toBe(d[3]);
      const q = [R[i * 4], R[i * 4 + 1], R[i * 4 + 2], R[i * 4 + 3]];
      expect(Math.hypot(...q)).toBeCloseTo(1, 5);
      for (const p of [
        [1, 0, 0],
        [0, 5, 0],
        [0.5, 3, -2],
      ]) {
        const r = quatRotate(q, [p[0] * d[3], p[1] * d[3], p[2] * d[3]]);
        const want = shader(p, d);
        maxErr = Math.max(maxErr, Math.hypot(r[0] + d[0] - want[0], r[1] + d[1] - want[1], r[2] + d[2] - want[2]));
      }
    }
    // tree tilt is a few hundredths of a radian: the rigid rotation matches the shader's shear to second order
    expect(maxErr).toBeLessThan(0.02);
    // exact yaw convention with no tilt: x' = x cos + z sin, z' = -x sin + z cos
    const q = instanceQuaternion(0.7, 0, 0);
    const r = quatRotate(q, [1, 0, 0]);
    expect(r[0]).toBeCloseTo(Math.cos(0.7), 12);
    expect(r[2]).toBeCloseTo(-Math.sin(0.7), 12);
    const r2 = quatRotate(q, [0, 0, 1]);
    expect(r2[0]).toBeCloseTo(Math.sin(0.7), 12);
    expect(r2[2]).toBeCloseTo(Math.cos(0.7), 12);
    // large ground-alignment tilt: the up axis leans exactly like the shader's (a, 1, b) direction
    const a = 0.4,
      b = -0.25,
      yaw = 1.1;
    const up = quatRotate(instanceQuaternion(yaw, a, b), [0, 1, 0]);
    const l = Math.hypot(a, 1, b);
    expect(up[0]).toBeCloseTo((a * Math.cos(yaw) + b * Math.sin(yaw)) / l, 10);
    expect(up[1]).toBeCloseTo(1 / l, 10);
    expect(up[2]).toBeCloseTo((-a * Math.sin(yaw) + b * Math.cos(yaw)) / l, 10);
  });

  it('thins scatter deterministically when maxInstances is exceeded', () => {
    const { total } = scatterTotals(world);
    const a = collectScatter(world, 1000);
    const b = collectScatter(world, 1000);
    expect(a.total).toBe(total);
    expect(a.truncated).toBe(true);
    expect(a.exported).toBeLessThanOrEqual(1000);
    expect(a.exported).toBeGreaterThan(990);
    let sum = 0;
    a.layers.forEach((e, i) => {
      expect(e.rows.length).toBe(e.kept.reduce((s, n) => s + n, 0));
      e.variants.forEach((v, k) => expect(v ? v.n : 0).toBe(e.kept[k]));
      expect(e.rows).toEqual(b.layers[i].rows);
      sum += e.rows.length;
    });
    expect(sum).toBe(a.exported);
    const full = collectScatter(world, 1e9);
    expect(full.truncated).toBe(false);
    expect(full.exported).toBe(total);
  });

  it('places structures and objects with the transforms of the document', () => {
    const structs = nodesByKind('structure');
    expect(structs.length).toBe(2);
    for (const s of world.project.structures) {
      const { node, m } = structs.find((n) => n.node.extras.id === s.id);
      const level = world.structureLevel(s);
      expect(node.translation).toEqual([s.x, level, s.z]);
      expect(node.rotation[0]).toBe(0);
      expect(node.rotation[2]).toBe(0);
      expect(node.rotation[1]).toBeCloseTo(Math.sin(s.rot / 2), 12);
      expect(node.rotation[3]).toBeCloseTo(Math.cos(s.rot / 2), 12);
      expect(node.scale).toBeUndefined();
      // local +Z (the door wall) maps to (sin rot, cos rot) in the world, the building stands upright
      const front = mat4Apply(m, [0, 0, 1]);
      expect(front[0] - s.x).toBeCloseTo(Math.sin(s.rot), 10);
      expect(front[2] - s.z).toBeCloseTo(Math.cos(s.rot), 10);
      expect(mat4Apply(m, [0, 1, 0])[1] - level).toBeCloseTo(1, 10);
      // the pad was flattened to the floor level
      expect(Math.abs(world.hFinal.sample(s.x, s.z) - level)).toBeLessThan(0.05);
      const mesh = json.meshes[node.mesh];
      const built = buildStructureGeometry(s);
      expect(mesh.primitives.length).toBe(built.parts.length);
      const names = mesh.primitives.map((p) => json.materials[p.material].name);
      expect(names).toEqual(built.parts.map((p) => 'structure_' + p.material));
      let top = -Infinity,
        bottom = Infinity,
        tris = 0;
      mesh.primitives.forEach((p, i) => {
        const acc = json.accessors[p.attributes.POSITION];
        top = Math.max(top, acc.max[1]);
        bottom = Math.min(bottom, acc.min[1]);
        tris += json.accessors[p.indices].count / 3;
        expect(acc.count).toBe(built.parts[i].positions.length / 3);
        const mat = json.materials[p.material];
        if (mat.name === 'structure_glass') {
          expect(mat.pbrMetallicRoughness.baseColorTexture).toBeUndefined();
          expect(p.attributes.TEXCOORD_0).toBeUndefined();
          expect(mat.pbrMetallicRoughness.roughnessFactor).toBeLessThan(0.2);
        } else {
          expect(mat.pbrMetallicRoughness.baseColorTexture).toBeDefined();
          expect(mat.normalTexture).toBeDefined();
          expect(mat.occlusionTexture.index).toBe(mat.pbrMetallicRoughness.metallicRoughnessTexture.index);
          expect(p.attributes.TEXCOORD_0).toBeDefined();
        }
      });
      expect(top).toBeCloseTo(built.height, 1);
      expect(bottom).toBe(-3);
      expect(tris).toBe(built.parts.reduce((a, p) => a + p.indices.length / 3, 0));
      const e = placements.structures.find((q) => q.id === s.id);
      expect(e).toMatchObject({ type: s.type, inGlb: true });
      expect(e.x).toBeCloseTo(s.x, 3);
      expect(e.y).toBeCloseTo(level, 3);
      expect(e.rotDeg).toBeCloseTo((s.rot * 180) / Math.PI, 3);
      expect(e.params.w).toBe(built.params.w);
    }
    // trim is the wall texture tinted darker
    const trim = json.materials.find((m) => m.name === 'structure_trim');
    const wall = json.materials.find((m) => m.name === 'structure_wall');
    expect(trim.pbrMetallicRoughness.baseColorTexture.index).toBe(wall.pbrMetallicRoughness.baseColorTexture.index);
    expect(trim.pbrMetallicRoughness.baseColorFactor[0]).toBeLessThan(wall.pbrMetallicRoughness.baseColorFactor[0]);

    const objs = nodesByKind('object');
    expect(objs.length).toBe(world.project.objects.length);
    expect(objs.length).toBe(2);
    const barrelDoc = world.project.objects.find((o) => o.id === 'obj-1');
    const barrel = objs.find((o) => o.node.extras.id === 'obj-1').node;
    expect(barrel.translation).toEqual([barrelDoc.x, world.hFinal.sample(barrelDoc.x, barrelDoc.z), barrelDoc.z]);
    expect(barrel.scale).toEqual([1.2, 1.2, 1.2]);
    const q = quatFromEulerXYZ(0, barrelDoc.rot, 0);
    barrel.rotation.forEach((v, i) => expect(v).toBeCloseTo(q[i], 12));
    expect(json.meshes[barrel.mesh].name).toBe('wine_barrel_01_lod0');
    expect(json.meshes[barrel.mesh].extras).toMatchObject({ model: 'wine_barrel_01', lod: 0 });
    // floating object rests in the lake surface (partly submerged), not on the lake bed
    const duck = objs.find((o) => o.node.extras.id === 'duck-1').node;
    const level = world.project.water.lakes[0].level;
    expect(duck.translation[1]).toBeLessThan(level);
    expect(duck.translation[1]).toBeGreaterThan(level - manifest.models.rubber_duck_toy.height * 3);
    expect(duck.translation[1]).toBeGreaterThan(world.hFinal.sample(BASIN.x, BASIN.z));
    expect(placements.objects.find((o) => o.id === 'duck-1').floating).toBe(true);
  });

  it('drapes road ribbons on the terrain', () => {
    const roads = nodesByKind('road');
    expect(roads.map((r) => r.node.name).sort()).toEqual(['road_road-1', 'road_trail-1']);
    const terrain = buildTerrainMesh(world, 129);
    for (const r of roads) {
      const p = json.meshes[r.node.mesh].primitives[0];
      const pos = readAccessorFloat(glb, p.attributes.POSITION);
      const nrm = readAccessorFloat(glb, p.attributes.NORMAL);
      const ridx = readAccessor(glb, p.indices).array;
      for (let t = 0; t < ridx.length; t += 3) {
        const [i0, i1, i2] = [ridx[t] * 3, ridx[t + 1] * 3, ridx[t + 2] * 3];
        if (!((pos[i1 + 2] - pos[i0 + 2]) * (pos[i2] - pos[i0]) - (pos[i1] - pos[i0]) * (pos[i2 + 2] - pos[i0 + 2]) > 0)) throw new Error('road triangle faces down');
      }
      const c = world.compiled.roads[world.project.roads.findIndex((d) => d.id === r.node.extras.id)];
      let maxOff = 0;
      for (let v = 0; v < pos.length / 3; v++) {
        const [x, y, z] = [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
        const ground = Math.max(world.hFinal.sample(x, z), terrain.sample(x, z));
        expect(y - ground).toBeCloseTo(0.03, 3);
        expect(nrm[v * 3 + 1]).toBeGreaterThan(0.5);
        // inside the road corridor
        let best = Infinity;
        for (let k = 0; k < c.sp.n; k += 2) best = Math.min(best, Math.hypot(x - c.sp.x[k], z - c.sp.z[k]) - c.hw[k]);
        maxOff = Math.max(maxOff, best);
      }
      expect(maxOff).toBeLessThan(0.6);
      // the ribbon is as long as the road
      const acc = json.accessors[p.attributes.POSITION];
      expect(Math.hypot(acc.max[0] - acc.min[0], acc.max[2] - acc.min[2])).toBeGreaterThan(c.sp.length * 0.7);
      expect(json.materials[p.material].name).toBe('path_surface');
      expect(json.materials[p.material].pbrMetallicRoughness.baseColorTexture).toBeDefined();
    }
    // the decimated-terrain sampler interpolates the exported triangles exactly at their vertices
    expect(terrain.sample(world.hFinal.toWorldX(10), world.hFinal.toWorldZ(20))).toBe(world.hFinal.data[20 * RES + 10]);
  });

  it('honours include flags and survives missing assets with a reported fallback', async () => {
    const failing = async (p) => {
      throw new Error('ENOENT ' + p);
    };
    const res = await exportWorld(world, manifest, { loadAsset: failing, terrainTextureRes: 64, terrainMeshRes: 65, include: { vegetation: false, water: false, objects: false } });
    const g = parseGLB(res.files.find((f) => f.name === 'scene.glb').data);
    const root = g.json.nodes[g.json.scenes[0].nodes[0]];
    expect(root.children.map((c) => g.json.nodes[c].name).sort()).toEqual(['roads', 'structures', 'terrain']);
    expect(g.json.extensionsUsed).toBeUndefined();
    expect(g.json.extensionsRequired).toBeUndefined();
    expect(res.report.missingAssets.length).toBeGreaterThan(3);
    expect(res.report.warnings.length).toBeGreaterThan(3);
    expect(res.report.counts).toMatchObject({ scatterInstancesInGlb: 0, objectsInGlb: 0, waterMeshes: 0, structuresInGlb: 2, roadsInGlb: 2 });
    // placements still list everything
    const pl = JSON.parse(new TextDecoder().decode(res.files.find((f) => f.name === 'placements.json').data));
    expect(pl.scatter.exportedInstances).toBe(scatterTotals(world).total);
    expect(pl.scatter.layers.every((l) => l.glbInstanced.every((b) => b === false))).toBe(true);
    expect(pl.objects.every((o) => o.inGlb === false)).toBe(true);
    // flat-colour fallback materials keep the file valid
    expect(g.json.materials.find((m) => m.name === 'structure_wall').pbrMetallicRoughness.baseColorTexture).toBeUndefined();
    const result = await validator.validateBytes(res.files.find((f) => f.name === 'scene.glb').data, { format: 'glb', maxIssues: 0 });
    expect(result.issues.numErrors).toBe(0);
    expect(g.json.nodes.find((n) => n.name === 'terrain').extras.vertsPerSide).toBe(65);
  });
});

describe('placements.json and environment.json', () => {
  it('describes rivers, lakes, the sea and roads with sampled profiles', () => {
    expect(placements.units).toBe('m');
    const rv = placements.rivers[0];
    const c = world.compiled.rivers[0];
    expect(rv).toMatchObject({ id: 'r1', width: 8, depth: 0.7, flow: 5 });
    expect(rv.nodes.length).toBe(world.project.water.rivers[0].nodes.length);
    expect(rv.centreline.length).toBeGreaterThan(50);
    expect(rv.lengthMeters).toBeCloseTo(c.sp.length, 2);
    for (let i = 0; i < rv.centreline.length; i++) {
      const [x, z, bed, surf, hw] = rv.centreline[i];
      expect(surf).toBeGreaterThan(bed);
      expect(hw).toBeGreaterThan(1);
      if (i > 0) expect(surf).toBeLessThanOrEqual(rv.centreline[i - 1][3]); // water surface falls downstream
      expect(Math.abs(x)).toBeLessThanOrEqual(SIZE / 2);
      expect(Math.abs(z)).toBeLessThanOrEqual(SIZE / 2);
    }
    expect(rv.centreline[0][3]).toBeCloseTo(c.surf[0], 3);
    expect(rv.centreline[rv.centreline.length - 1][3]).toBeCloseTo(c.surf[c.sp.n - 1], 3);
    const cell2 = (SIZE / (RES - 1)) ** 2;
    expect(placements.lakes).toEqual([{ id: 'l1', name: 'Pond', x: BASIN.x, z: BASIN.z, level: world.project.water.lakes[0].level, wetCells: world.water.stats.lakeCells[0], areaM2: world.water.stats.lakeCells[0] * cell2 }]);
    expect(placements.lakes[0].areaM2).toBeGreaterThan(500);
    expect(placements.sea).toMatchObject({ enabled: true, level: 105.2 });
    expect(placements.sea.wetCells).toBeGreaterThan(20);
    expect(placements.roads.map((r) => [r.id, r.kind, r.inGlb])).toEqual([
      ['road-1', 'road', true],
      ['trail-1', 'trail', true],
    ]);
    for (const r of placements.roads) {
      expect(r.profile.length).toBeGreaterThan(10);
      expect(r.width).toBeGreaterThan(1);
      for (const [x, z, y] of r.profile) expect(Math.abs(y - world.hFinal.sample(x, z))).toBeLessThan(0.05);
    }
    expect(placements.roads[0].width).toBeGreaterThan(placements.roads[1].width);
    // instances are rounded to millimetres
    const rows = placements.scatter.layers.find((l) => l.instances.length > 10).instances;
    for (const r of rows.slice(0, 50)) {
      expect(r.length).toBe(6);
      for (const v of r) expect(Math.abs(v * 1000 - Math.round(v * 1000))).toBeLessThan(1e-6);
      expect(r[4]).toBeGreaterThanOrEqual(0);
      expect(r[4]).toBeLessThanOrEqual(360);
      expect(Math.abs(r[1] - world.hFinal.sample(r[0], r[2]))).toBeLessThan(1.5);
    }
  });

  it('exports the environment with a unit sun vector above the horizon at noon', () => {
    const env = jsonFile('environment.json');
    expect(env.env).toEqual(world.project.env);
    expect(env.env.timeOfDay).toBe(12);
    const d = env.sun.direction;
    expect(Math.hypot(...d)).toBeCloseTo(1, 3);
    expect(d[1]).toBeGreaterThan(0.5);
    expect(env.sun.elevationDeg).toBeCloseTo((Math.asin(d[1]) * 180) / Math.PI, 1);
    expect(env.water.optics).toEqual(world.project.water.optics);
    expect(env.water.swell).toEqual(world.project.water.swell);
    expect(env.water.seaLevel).toBe(105.2);
    expect(env.wind.speed).toBe(world.project.env.windSpeed);
    expect(Math.hypot(env.wind.vector[0], env.wind.vector[2])).toBeCloseTo(world.project.env.windSpeed, 3);
  });

  it('sunDirection follows the solar geometry of the renderer formula', () => {
    const base = { latitude: 46, dayOfYear: 172, sunAzimuth: 180 };
    const noon = sunDirection({ ...base, timeOfDay: 12 });
    expect(Math.hypot(...noon)).toBeCloseTo(1, 12);
    // summer solstice noon at 46 N: elevation = 90 - 46 + 23.44, due south (+z), no east-west component
    expect(directionAngles(noon).elevationDeg).toBeCloseTo(90 - 46 + 23.44, 1);
    expect(noon[0]).toBeCloseTo(0, 10);
    expect(noon[2]).toBeGreaterThan(0);
    expect(directionAngles(noon).bearingDeg).toBeCloseTo(180, 6);
    const morning = sunDirection({ ...base, timeOfDay: 8 });
    const evening = sunDirection({ ...base, timeOfDay: 16 });
    expect(morning[0]).toBeGreaterThan(0.3); // east
    expect(evening[0]).toBeLessThan(-0.3); // west
    expect(morning[1]).toBeCloseTo(evening[1], 10);
    expect(morning[1]).toBeLessThan(noon[1]);
    expect(sunDirection({ ...base, timeOfDay: 0 })[1]).toBeLessThan(0); // midnight: below the horizon
    expect(sunDirection({ ...base, dayOfYear: 355, timeOfDay: 12 })[1]).toBeLessThan(noon[1]); // winter sun is lower
    // sunAzimuth rotates the sun path about the vertical
    const rot = sunDirection({ ...base, timeOfDay: 12, sunAzimuth: 270 });
    expect(rot[1]).toBeCloseTo(noon[1], 12);
    expect(rot[0]).toBeCloseTo(-Math.hypot(noon[0], noon[2]), 10);
    for (let t = 0; t < 24; t += 1.7) expect(Math.hypot(...sunDirection({ ...base, timeOfDay: t, sunAzimuth: 135 }))).toBeCloseTo(1, 12);
  });
});

describe('GLB writer / reader primitives', () => {
  it('round-trips accessors, alignment, images and extension lists', () => {
    const b = new GLBBuilder('test');
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, -3]);
    const idx = new Uint16Array([0, 1, 2]);
    const png = new Uint8Array([1, 2, 3, 4, 5]); // odd length: forces padding before the next view
    const img = b.addImage(png, 'image/png', 'a');
    expect(b.addImage(new Uint8Array([1, 2, 3, 4, 5]), 'image/png', 'dup')).toBe(img);
    expect(b.addImage(new Uint8Array([1, 2, 3, 4, 6]), 'image/png')).not.toBe(img);
    const webp = b.addTexture(b.addImage(new Uint8Array([9, 9, 9]), 'image/webp'));
    const tex = b.addTexture(img);
    expect(b.addTexture(img)).toBe(tex);
    const mat = b.addMaterial({ name: 'm', pbrMetallicRoughness: { baseColorTexture: { index: tex } }, extensions: { KHR_materials_ior: { ior: 1.5 } } });
    expect(b.addMaterial({ name: 'm', pbrMetallicRoughness: { baseColorTexture: { index: tex } }, extensions: { KHR_materials_ior: { ior: 1.5 } } })).toBe(mat);
    const root = b.addNode({ name: 'root' });
    b.addNode({ name: 'child', mesh: b.addMesh('tri', [b.addPrimitive({ positions, indices: idx, material: mat })]), translation: [1, 2, 3], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: [2, 2, 2] }, root);
    const bytes = b.build();
    expect(bytes.length % 4).toBe(0);
    const g = parseGLB(bytes);
    expect(g.totalLength).toBe(bytes.length);
    expect(g.json.extensionsUsed).toEqual(['EXT_texture_webp', 'KHR_materials_ior']);
    expect(g.json.extensionsRequired).toEqual(['EXT_texture_webp']);
    expect(g.json.textures[webp]).toEqual({ sampler: 0, extensions: { EXT_texture_webp: { source: 2 } } });
    for (const bv of g.json.bufferViews) expect(bv.byteOffset % 4).toBe(0);
    const prim = g.json.meshes[0].primitives[0];
    expect(g.json.accessors[prim.attributes.POSITION]).toMatchObject({ min: [0, 0, -3], max: [1, 2, 0], count: 3, componentType: 5126, type: 'VEC3' });
    expect(Array.from(readAccessorFloat(g, prim.attributes.POSITION))).toEqual(Array.from(positions));
    expect(Array.from(readAccessor(g, prim.indices).array)).toEqual([0, 1, 2]);
    expect(Array.from(imageBytes(g, img).bytes)).toEqual([1, 2, 3, 4, 5]);
    // world matrix: scale 2, yaw +90 deg (x -> -z), then translate
    let seen = 0;
    traverseScene(g, (node, i, m, parent, path) => {
      if (node.name !== 'child') return;
      seen++;
      expect(path).toEqual(['root', 'child']);
      const p = mat4Apply(m, [1, 0, 0]);
      expect(p[0]).toBeCloseTo(1, 12);
      expect(p[1]).toBeCloseTo(2, 12);
      expect(p[2]).toBeCloseTo(3 - 2, 12);
    });
    expect(seen).toBe(1);
    expect(() => parseGLB(new Uint8Array(24))).toThrow(/magic/);
    expect(() => b.addAccessor(new Float32Array(4), 'VEC3')).toThrow();
  });
});
