// World export: heightmap + masks (PNG), scene.glb (glTF 2.0), placements / environment (JSON)
// and a generated report + README. Runs in the browser and in Node >= 20: no DOM, no three.js in
// the static import graph (the optional procedural reed meshes are loaded with a guarded dynamic
// import, see proceduralModel()).
//
//   const out = await exportWorld(world, manifest, { loadAsset: async (rel) => Uint8Array });
//   out.files -> [{ name, data: Uint8Array, mime }], out.report -> export_report.json content

import { MAT_NAMES, MAT_LABELS } from '../core/biomes.js';
import { NO_WATER } from '../core/waterField.js';
import { buildStructureGeometry, MODEL_DECK_Y } from '../core/structures.js';
import { encodePNG } from '../core/png.js';
import { GLBBuilder, GL, quatFromEulerXYZ } from './glb.js';
import { parseGLB, readAccessor, readAccessorFloat, imageBytes, textureImageIndex } from './glbRead.js';
import { sunDirection, directionAngles } from './sun.js';
import { buildTerrainMesh, bakeTerrainColor, labelWaterBodies, buildWaterMeshes, collectScatter, buildRoadRibbon, sanitizeNormals, safeName, linearToSrgb8, WATER_UV_METERS } from './sceneBuild.js';
import { buildReadme, WHAT_DOES_NOT_SURVIVE } from './readme.js';

export const EXPORT_FORMAT_VERSION = 1;
const STRUCT_ROLES = { wall: 'wood_planks', roof: 'roof', stone: 'stone_wall', door: 'wood_door', trim: 'wood_planks' };
const STRUCT_TINT = { trim: [0.62, 0.58, 0.54], door: [0.8, 0.8, 0.8] };
const FLOW_SCALE = 6.5; // m/s mapped to full range in mask_flow.png (the solver caps speed at 6.5 m/s)
const CANCEL = Symbol('export cancelled');
const LIM = NO_WATER * 0.5;

const r3 = (v) => Math.round(v * 1000) / 1000;
const r4 = (v) => Math.round(v * 10000) / 10000;
const enc = (obj) => new TextEncoder().encode(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1));
const clone = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k.startsWith('_') ? undefined : v)));

function mimeOf(path) {
  const p = path.toLowerCase();
  return p.endsWith('.png') ? 'image/png' : p.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
}

function float32LE(data) {
  const le = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  const copy = new Float32Array(data);
  if (le) return new Uint8Array(copy.buffer);
  const out = new Uint8Array(copy.byteLength);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < copy.length; i++) dv.setFloat32(i * 4, copy[i], true);
  return out;
}

/**
 * @param {import('../core/world.js').World} world  derived world (deriveAll() must have run)
 * @param {object} manifest asset manifest (public/assets/manifest.json)
 * @param {object} opts
 * @param {(relPath:string)=>Promise<Uint8Array>} opts.loadAsset reads a file of the asset library
 * @param {(label:string, fraction:number)=>boolean|void} [opts.onProgress] return false to cancel
 * @param {number} [opts.terrainMeshRes=513] vertices per side of the terrain mesh (point sampled)
 * @param {number} [opts.terrainTextureRes=2048] baked terrain base-colour resolution
 * @param {object} [opts.include] {terrain, water, vegetation, structures, objects, roads} (default all true)
 * @param {number} [opts.vegetationLod=1] LOD index for scatter meshes (clamped)
 * @param {number} [opts.maxInstances=400000] cap on exported scatter instances
 * @param {false|(()=>Promise<{buildReedModel:Function}>)} [opts.proceduralPlants] loader for the
 *        procedural reed generator (default: dynamic import of src/render/ProceduralPlants.js);
 *        false exports proc_* placements without meshes.
 * @returns {Promise<{files:Array<{name:string,data:Uint8Array,mime:string}>, report:object}|null>} null when cancelled
 */
export async function exportWorld(world, manifest, opts = {}) {
  try {
    return await run(world, manifest || { models: {}, textures: {} }, opts);
  } catch (e) {
    if (e === CANCEL) return null;
    throw e;
  }
}

async function run(world, manifest, opts) {
  const t0 = Date.now();
  const include = { terrain: true, water: true, vegetation: true, structures: true, objects: true, roads: true, ...(opts.include || {}) };
  const loadAsset = opts.loadAsset || (async (p) => {
    throw new Error(`exportWorld: opts.loadAsset is required to embed "${p}"`);
  });
  const progress = async (label, f) => {
    if (opts.onProgress && opts.onProgress(label, f) === false) throw CANCEL;
    await new Promise((r) => setTimeout(r, 0)); // let the UI repaint between heavy stages
  };
  const project = world.project;
  const hf = world.hFinal;
  const wf = world.water;
  const res = world.res;
  const N = res * res;
  const files = [];
  const warnings = [];
  const notes = [];
  const add = (name, data, mime) => files.push({ name, data, mime });

  // ------------------------------------------------------------------ heightmap
  await progress('Heightmap', 0.02);
  const [hMin, hMaxRaw] = hf.minMax();
  const hMax = hMaxRaw > hMin ? hMaxRaw : hMin + 1;
  {
    const u16 = new Uint16Array(N);
    const sc = 65535 / (hMax - hMin);
    for (let i = 0; i < N; i++) u16[i] = Math.max(0, Math.min(65535, Math.round((hf.data[i] - hMin) * sc)));
    add('heightmap_16bit.png', await encodePNG(u16, res, res, 1, 16), 'image/png');
    add('heightmap_float32.raw', float32LE(hf.data), 'application/octet-stream');
  }
  const heightmapDoc = {
    width: res,
    height: res,
    sizeMeters: world.size,
    cellMeters: hf.cell,
    minHeight: hMin,
    maxHeight: hMax,
    heightAt0: hMin,
    heightAt65535: hMax,
    metersPerStep: (hMax - hMin) / 65535,
    origin: 'centre',
    axis: 'x east, z south, y up',
    sampleConvention: 'vertex-centred',
    rowOrder: 'row 0 = north (z = -sizeMeters/2), column 0 = west (x = -sizeMeters/2)',
    files: { png16: 'heightmap_16bit.png', float32: 'heightmap_float32.raw (little-endian, row-major, metres)' },
    decode: 'height_m = heightAt0 + value / 65535 * (heightAt65535 - heightAt0); world x = -sizeMeters/2 + column * cellMeters, z = -sizeMeters/2 + row * cellMeters',
  };
  add('heightmap.json', enc(heightmapDoc), 'application/json');

  // ------------------------------------------------------------------ masks
  await progress('Masks', 0.08);
  const masksDoc = { width: res, height: res, sizeMeters: world.size, cellMeters: hf.cell, rowOrder: heightmapDoc.rowOrder, bitDepth: 8, masks: {} };
  const maskFiles = [];
  const putMask = async (name, pixels, channels, doc) => {
    add(name, await encodePNG(pixels, res, res, channels, 8), 'image/png');
    masksDoc.masks[name] = { channels, ...doc };
    maskFiles.push(name);
  };
  let maxDepth = 0;
  let wetCells = 0;
  for (let i = 0; i < N; i++) {
    if (wf.type[i] !== 0) {
      wetCells++;
      const d = wf.surf[i] - hf.data[i];
      if (d > maxDepth) maxDepth = d;
    }
  }
  const depthScale = Math.max(1, Math.ceil(maxDepth));
  {
    const depth = new Uint8Array(N);
    const type = new Uint8Array(N);
    const flow = new Uint8Array(N * 3);
    for (let i = 0; i < N; i++) {
      const t = wf.type[i];
      type[i] = t * 85;
      if (t !== 0) depth[i] = Math.max(1, Math.min(255, Math.round(((wf.surf[i] - hf.data[i]) / depthScale) * 255)));
      const vx = wf.vx[i],
        vz = wf.vz[i];
      flow[i * 3] = Math.max(0, Math.min(255, Math.round(128 + (vx / FLOW_SCALE) * 127)));
      flow[i * 3 + 1] = Math.max(0, Math.min(255, Math.round(128 + (vz / FLOW_SCALE) * 127)));
      flow[i * 3 + 2] = Math.max(0, Math.min(255, Math.round((Math.hypot(vx, vz) / FLOW_SCALE) * 255)));
    }
    await putMask('mask_water_depth.png', depth, 1, { encoding: 'water depth in metres = value / 255 * depthScale; 0 = dry cell, wet cells are always >= 1', depthScale, unit: 'm' });
    await putMask('mask_water_type.png', type, 1, { encoding: 'water body type per cell', values: { 0: 'dry', 85: 'river', 170: 'lake', 255: 'ocean' } });
    await putMask('mask_flow.png', flow, 3, { encoding: 'depth-averaged flow velocity: R = 128 + vx / flowScale * 127 (east +), G = 128 + vz / flowScale * 127 (south +), B = speed / flowScale * 255', flowScale: FLOW_SCALE, unit: 'm/s' });
  }
  await progress('Masks', 0.14);
  for (let k = 0; k < 9; k++) {
    const m = new Uint8Array(N);
    const w = world.weights;
    if (k < 8) for (let i = 0; i < N; i++) m[i] = w[i * 8 + k];
    else {
      for (let i = 0; i < N; i++) {
        const o = i * 8;
        const s = w[o] + w[o + 1] + w[o + 2] + w[o + 3] + w[o + 4] + w[o + 5] + w[o + 6] + w[o + 7];
        m[i] = s >= 255 ? 0 : 255 - s;
      }
    }
    const layer = project.materials?.layers?.[MAT_NAMES[k]];
    await putMask(`mask_material_${MAT_NAMES[k]}.png`, m, 1, {
      encoding: k < 8 ? 'ground layer weight = value / 255' : 'ground layer weight = value / 255 (bedrock: remainder 255 - sum of the other eight layers)',
      layer: MAT_NAMES[k],
      label: MAT_LABELS[k],
      texture: layer?.texture || null,
      tint: layer?.tint || null,
    });
    if (k % 3 === 2) await progress('Masks', 0.14 + 0.015 * k);
  }
  {
    const legend = [{ index: 0, id: null, name: 'none' }, ...project.biomes.map((b, i) => ({ index: i + 1, id: b.id, name: b.name, color: b.color || null }))];
    await putMask('mask_biome_index.png', new Uint8Array(world.biomeMap), 1, { encoding: 'value = biome index (0 = none), see legend', legend });
    await putMask('mask_moisture.png', new Uint8Array(world.moisture), 1, { encoding: 'soil moisture = value / 255 (0 dry .. 1 saturated)' });
    await putMask('mask_road.png', new Uint8Array(world.masks.road), 1, { encoding: 'road / trail surface coverage = value / 255' });
    const sed = new Uint8Array(N);
    for (let i = 0; i < N; i++) sed[i] = Math.max(0, Math.min(255, Math.round(world.sediment[i] * 255)));
    await putMask('mask_sediment.png', sed, 1, { encoding: 'deposited sediment / alluvium amount = value / 255' });
    await putMask('mask_exclusion.png', new Uint8Array(world.paint.exclude), 1, { encoding: 'painted scatter exclusion = value / 255 (instances are removed where value > 127)' });
  }
  add('masks.json', enc(masksDoc), 'application/json');

  // ------------------------------------------------------------------ scene.glb
  await progress('Terrain mesh', 0.3);
  const glb = new GLBBuilder('Terraforge exporter');
  const sceneStats = { terrain: null, water: [], scatter: { layers: 0, nodes: 0, instances: 0, total: 0, truncated: false }, structures: 0, objects: 0, roads: 0, triangles: 0, scatterMeshTriangles: 0, instancedTriangles: 0 };
  const lakes = project.water.lakes || [];
  glb.json.scenes[0].name = safeName(project.name || 'world');
  glb.json.scenes[0].extras = {
    generator: 'Terraforge',
    formatVersion: EXPORT_FORMAT_VERSION,
    units: 'm',
    upAxis: '+Y',
    seed: project.seed,
    terrainSize: world.size,
    waterLevels: { sea: world.seaLevel, lakes: lakes.map((l) => ({ id: l.id, level: l.level })) },
  };
  const root = glb.addNode({ name: 'world' });
  const groups = new Map();
  const group = (name, parent = root, extras) => {
    const key = parent + '/' + name;
    if (!groups.has(key)) groups.set(key, glb.addNode({ name, extras: extras || { kind: 'group', group: name } }, parent));
    return groups.get(key);
  };

  // shared texture / material helpers ---------------------------------------------------------
  const assetCache = new Map();
  const asset = (path) => {
    if (!assetCache.has(path)) assetCache.set(path, Promise.resolve().then(() => loadAsset(path)));
    return assetCache.get(path);
  };
  const missingAssets = new Set();
  const embedTexture = async (path) => {
    if (!path) return null;
    try {
      const bytes = await asset(path);
      if (!bytes || !bytes.length) throw new Error('empty file');
      return glb.addTexture(glb.addImage(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), mimeOf(path), path.replace(/\.[a-z]+$/i, '')));
    } catch (e) {
      missingAssets.add(path);
      warnings.push(`texture "${path}" could not be embedded (${e.message}); a flat colour is used instead`);
      return null;
    }
  };
  /** PBR material from a manifest texture set (diff -> base colour, nor -> normal, arm -> occlusion/roughness/metallic). */
  const textureSetMaterial = async (name, texId, tint, extra = {}) => {
    const t = manifest.textures?.[texId];
    const tn = (tint || [1, 1, 1]).map((v) => Math.max(0, Math.min(1, v)));
    if (!t) {
      if (texId) warnings.push(`texture set "${texId}" is not in the asset manifest; material "${name}" uses a flat colour`);
      return glb.addMaterial({ name, pbrMetallicRoughness: { baseColorFactor: [0.35 * tn[0], 0.3 * tn[1], 0.25 * tn[2], 1], metallicFactor: 0, roughnessFactor: 0.9 }, ...extra });
    }
    const [diff, nor, arm] = [await embedTexture(t.files?.diff), await embedTexture(t.files?.nor), await embedTexture(t.files?.arm)];
    const pbr = { metallicFactor: arm !== null ? 1 : 0, roughnessFactor: arm !== null ? 1 : 0.9 };
    if (diff !== null) {
      pbr.baseColorTexture = { index: diff };
      pbr.baseColorFactor = [tn[0], tn[1], tn[2], 1];
    } else {
      const c = t.avgColor || [0.3, 0.3, 0.3];
      pbr.baseColorFactor = [Math.min(1, c[0] * tn[0]), Math.min(1, c[1] * tn[1]), Math.min(1, c[2] * tn[2]), 1];
    }
    const m = { name, pbrMetallicRoughness: pbr, ...extra };
    if (arm !== null) {
      pbr.metallicRoughnessTexture = { index: arm };
      m.occlusionTexture = { index: arm };
    }
    if (nor !== null) m.normalTexture = { index: nor };
    return glb.addMaterial(m);
  };

  // model library meshes -----------------------------------------------------------------------
  const modelMeshes = new Map(); // id@lod -> Promise<{mesh, triangles}|null>
  const countedScatterMeshes = new Set();
  const webpModels = new Set();
  const skippedModels = new Map(); // id -> reason
  const modelMesh = (id, lodIndex) => {
    const key = id + '@' + lodIndex;
    if (!modelMeshes.has(key)) {
      modelMeshes.set(
        key,
        (String(id).startsWith('proc_') ? proceduralModel(id, lodIndex) : libraryModel(id, lodIndex)).catch((e) => {
          skippedModels.set(id, e.message);
          warnings.push(`model "${id}" was not embedded: ${e.message}`);
          return null;
        }),
      );
    }
    return modelMeshes.get(key);
  };
  const libraryModel = async (id, lodIndex) => {
    const info = manifest.models?.[id];
    if (!info) throw new Error('not in the asset manifest');
    const lods = (info.lods || []).filter((l) => l.file);
    if (!lods.length) throw new Error('no model files listed in the manifest');
    const li = Math.max(0, Math.min(lods.length - 1, lodIndex));
    const bytes = await asset(lods[li].file);
    const src = parseGLB(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    assetCache.delete(lods[li].file); // geometry / images are copied below; let the file buffer go
    const j = src.json;
    const nodeIdx = (j.scenes?.[j.scene || 0]?.nodes || [0])[0];
    const node = j.nodes?.[nodeIdx] || {};
    if (node.matrix || node.translation || node.rotation || node.scale) notes.push(`model "${id}": root node transform in the source file is ignored`);
    const mesh = j.meshes[node.mesh ?? 0];
    const texCache = new Map();
    const tex = (ref) => {
      if (!ref || ref.index === undefined) return undefined;
      if (!texCache.has(ref.index)) {
        const st = j.textures[ref.index];
        const img = imageBytes(src, textureImageIndex(src, ref.index));
        if (img.mimeType === 'image/webp') webpModels.add(id);
        const sm = st.sampler !== undefined ? j.samplers[st.sampler] : {};
        const sampler = glb.addSampler({ ...(sm.magFilter ? { magFilter: sm.magFilter } : {}), ...(sm.minFilter ? { minFilter: sm.minFilter } : {}), wrapS: sm.wrapS ?? GL.REPEAT, wrapT: sm.wrapT ?? GL.REPEAT });
        texCache.set(ref.index, glb.addTexture(glb.addImage(img.bytes, img.mimeType, undefined, true), sampler));
      }
      const out = { index: texCache.get(ref.index) };
      if (ref.texCoord) out.texCoord = ref.texCoord;
      if (ref.scale !== undefined) out.scale = ref.scale;
      if (ref.strength !== undefined) out.strength = ref.strength;
      return out;
    };
    const prims = [];
    let triangles = 0;
    for (const p of mesh.primitives) {
      if ((p.mode ?? 4) !== 4) continue;
      const positions = readAccessorFloat(src, p.attributes.POSITION);
      const normals = p.attributes.NORMAL !== undefined ? sanitizeNormals(readAccessorFloat(src, p.attributes.NORMAL)) : null;
      const uvs = p.attributes.TEXCOORD_0 !== undefined ? readAccessorFloat(src, p.attributes.TEXCOORD_0) : null;
      let indices = null;
      if (p.indices !== undefined) {
        indices = readAccessor(src, p.indices).array;
        if (indices instanceof Uint8Array) indices = Uint16Array.from(indices);
      }
      triangles += (indices ? indices.length : positions.length / 3) / 3;
      let material;
      if (p.material !== undefined) {
        const sm = j.materials[p.material];
        const spbr = sm.pbrMetallicRoughness || {};
        const pbr = {};
        if (spbr.baseColorFactor) pbr.baseColorFactor = spbr.baseColorFactor;
        const bct = tex(spbr.baseColorTexture);
        if (bct) pbr.baseColorTexture = bct;
        pbr.metallicFactor = spbr.metallicFactor ?? 1;
        pbr.roughnessFactor = spbr.roughnessFactor ?? 1;
        const mrt = tex(spbr.metallicRoughnessTexture);
        if (mrt) pbr.metallicRoughnessTexture = mrt;
        const m = { name: sm.name || id, pbrMetallicRoughness: pbr };
        const nt = tex(sm.normalTexture);
        if (nt) m.normalTexture = nt;
        const ot = tex(sm.occlusionTexture);
        if (ot) m.occlusionTexture = ot;
        const et = tex(sm.emissiveTexture);
        if (et) m.emissiveTexture = et;
        if (sm.emissiveFactor) m.emissiveFactor = sm.emissiveFactor;
        if (sm.alphaMode && sm.alphaMode !== 'OPAQUE') m.alphaMode = sm.alphaMode;
        if (sm.alphaMode === 'MASK') m.alphaCutoff = sm.alphaCutoff ?? 0.5;
        if (sm.doubleSided) m.doubleSided = true;
        material = glb.addMaterial(m);
      }
      prims.push(glb.addPrimitive({ positions, normals, uvs, indices, material }));
    }
    if (!prims.length) throw new Error('no triangle primitives in the model file');
    return { mesh: glb.addMesh(`${id}_lod${li}`, prims, { model: id, lod: li, source: info.source?.url || null }), triangles, lod: li };
  };
  let procModule;
  const proceduralModel = async (id, lodIndex) => {
    if (opts.proceduralPlants === false) throw new Error('procedural plant meshes disabled (placements only)');
    if (procModule === undefined) {
      try {
        procModule = await (opts.proceduralPlants ? opts.proceduralPlants() : import('../render/ProceduralPlants.js'));
      } catch (e) {
        procModule = null;
        notes.push(`procedural plant generator unavailable in this environment (${e.message})`);
      }
    }
    if (!procModule || typeof procModule.buildReedModel !== 'function') throw new Error('procedural plant generator unavailable; placements are exported without a mesh');
    const built = procModule.buildReedModel(id);
    const li = Math.max(0, Math.min(built.lods.length - 1, lodIndex));
    const g = built.lods[li].geometry;
    const positions = Float32Array.from(g.getAttribute('position').array);
    const normals = sanitizeNormals(Float32Array.from(g.getAttribute('normal').array));
    const uvs = Float32Array.from(g.getAttribute('uv').array);
    const srcIdx = g.getIndex().array;
    const indices = positions.length / 3 > 65535 ? Uint32Array.from(srcIdx) : Uint16Array.from(srcIdx);
    const img = built.texture?.image;
    const pbr = { metallicFactor: 0, roughnessFactor: 0.75 };
    if (img && img.data && img.width && img.height) {
      const png = await encodePNG(new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength), img.width, img.height, 4, 8);
      pbr.baseColorTexture = { index: glb.addTexture(glb.addImage(png, 'image/png', 'procedural_plants'), glb.addSampler({ wrapS: GL.CLAMP_TO_EDGE, wrapT: GL.CLAMP_TO_EDGE })) };
    } else pbr.baseColorFactor = [0.25, 0.4, 0.15, 1];
    const material = glb.addMaterial({ name: id, pbrMetallicRoughness: pbr, doubleSided: true });
    return { mesh: glb.addMesh(`${id}_lod${li}`, [glb.addPrimitive({ positions, normals, uvs, indices, material })], { model: id, lod: li, procedural: true }), triangles: indices.length / 3, lod: li };
  };

  // terrain --------------------------------------------------------------------------------------
  let terrain = null;
  const texRes = Math.max(64, Math.min(4096, Math.round(opts.terrainTextureRes || 2048)));
  if (include.terrain || include.roads) terrain = buildTerrainMesh(world, opts.terrainMeshRes || 513);
  if (include.terrain) {
    await progress('Baking terrain texture', 0.36);
    const baked = bakeTerrainColor(world, manifest, texRes);
    if (baked.missingLayers.length) warnings.push(`ground layers without a texture set in the manifest use fallback colours: ${baked.missingLayers.join(', ')}`);
    const png = await encodePNG(baked.pixels, texRes, texRes, 3, 8);
    const tex = glb.addTexture(glb.addImage(png, 'image/png', 'terrain_basecolor'), glb.addSampler({ wrapS: GL.CLAMP_TO_EDGE, wrapT: GL.CLAMP_TO_EDGE }));
    const material = glb.addMaterial({ name: 'terrain_baked', pbrMetallicRoughness: { baseColorTexture: { index: tex }, metallicFactor: 0, roughnessFactor: 0.92 } });
    const mesh = glb.addMesh('terrain', [glb.addPrimitive({ positions: terrain.positions, normals: terrain.normals, uvs: terrain.uvs, indices: terrain.indices, material })]);
    glb.addNode({ name: 'terrain', mesh, extras: { kind: 'terrain', vertsPerSide: terrain.n, heightfieldStride: terrain.step, cellMeters: terrain.cellM, textureRes: texRes, quadDiagonal: '(i+1,j)-(i,j+1)' } }, root);
    sceneStats.terrain = { vertsPerSide: terrain.n, heightfieldStride: terrain.step, vertices: terrain.n * terrain.n, triangles: terrain.triangles, textureRes: texRes, textureBytes: png.length };
    sceneStats.triangles += terrain.triangles;
  }

  // water ----------------------------------------------------------------------------------------
  await progress('Water meshes', 0.48);
  const labelled = labelWaterBodies(world);
  const optics = project.water.optics || { absorb: [0.45, 0.07, 0.04], scatter: [0.01, 0.03, 0.03] };
  if (include.water && labelled.bodies.length) {
    const absorb = optics.absorb || [0.45, 0.07, 0.04];
    const scat = optics.scatter || [0.01, 0.03, 0.03];
    // Beer-Lambert: transmittance(d) = exp(-absorb * d) = attenuationColor ^ (d / attenuationDistance)
    const attDist = Math.max(1, Math.min(20, 0.3 / Math.max(1e-3, Math.min(...absorb))));
    const attColor = absorb.map((a) => r4(Math.max(0.002, Math.min(1, Math.exp(-a * attDist)))));
    // fallback colour for viewers without transmission: single-scattering albedo of the water body
    const base = absorb.map((a, i) => r4(Math.max(0.01, Math.min(1, (scat[i] / (a + scat[i])) * 1.15 + 0.01))));
    const mat = (kind, thickness, alpha) =>
      glb.addMaterial({
        name: 'water_' + kind,
        pbrMetallicRoughness: { baseColorFactor: [base[0], base[1], base[2], alpha], metallicFactor: 0, roughnessFactor: kind === 'river' ? 0.12 : 0.06 },
        alphaMode: 'BLEND',
        extensions: {
          KHR_materials_transmission: { transmissionFactor: 0.85 },
          KHR_materials_volume: { thicknessFactor: thickness, attenuationDistance: r4(attDist), attenuationColor: attColor },
          KHR_materials_ior: { ior: 1.333 },
        },
      });
    const meshes = buildWaterMeshes(world, labelled);
    const wg = meshes.length ? group('water', root) : null;
    for (const m of meshes) {
      const b = m.body;
      const material = mat(b.kind, b.kind === 'river' ? 0.6 : b.kind === 'lake' ? 2.5 : 4, b.kind === 'river' ? 0.72 : 0.82);
      const prim = glb.addPrimitive({ positions: m.positions, normals: m.normals, uvs: m.uvs, indices: m.indices, material, attributes: { TEXCOORD_1: { array: m.flow, type: 'VEC2' } } });
      const mesh = glb.addMesh(b.name, [prim], { texcoord0: `planar world-space uv: (x, z) / ${WATER_UV_METERS} m`, texcoord1: 'depth-averaged flow velocity (u = vx east, v = vz south) in m/s' });
      glb.addNode({ name: b.name, mesh, extras: { kind: 'water', body: b.kind, id: b.id, level: b.level, wetCells: b.cells } }, wg);
      sceneStats.water.push({ name: b.name, kind: b.kind, id: b.id, level: b.level, wetCells: b.cells, areaM2: r3(b.cells * hf.cell * hf.cell), vertices: m.positions.length / 3, triangles: m.triangles });
      sceneStats.triangles += m.triangles;
    }
  }

  // scatter --------------------------------------------------------------------------------------
  await progress('Vegetation and rocks', 0.56);
  const vegLod = Math.max(0, Math.round(opts.vegetationLod ?? 1));
  const scatter = collectScatter(world, opts.maxInstances ?? 400000);
  sceneStats.scatter.total = scatter.total;
  sceneStats.scatter.truncated = scatter.truncated;
  if (scatter.truncated) warnings.push(`scatter instances were thinned uniformly from ${scatter.total} to ${scatter.exported} (maxInstances)`);
  const placementLayers = [];
  {
    let done = 0;
    for (const e of scatter.layers) {
      const { L } = e;
      const models = L.layer.models.map((m) => m.id);
      const glbInstanced = models.map(() => false);
      const kept = Array.from(e.kept);
      if (include.vegetation) {
        for (let v = 0; v < models.length; v++) {
          const va = e.variants[v];
          if (!va) continue;
          const mm = await modelMesh(models[v], vegLod);
          if (!mm) continue;
          const sg = group('scatter', root);
          const bg = group(safeName(L.biome.id), sg, { kind: 'biome', biome: L.biome.id, name: L.biome.name });
          const lg = group(safeName(L.layer.id), bg, { kind: 'scatterLayer', biome: L.biome.id, layer: L.layer.id, name: L.layer.name, group: L.layer.group || null });
          glb.useExtension('EXT_mesh_gpu_instancing', true);
          glb.addNode(
            {
              name: safeName(models[v]),
              mesh: mm.mesh,
              extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: glb.addAccessor(va.translation, 'VEC3'), ROTATION: glb.addAccessor(va.rotation, 'VEC4'), SCALE: glb.addAccessor(va.scale, 'VEC3') } } },
              extras: { kind: 'scatter', biome: L.biome.id, layer: L.layer.id, model: models[v], modelIndex: v, count: va.n, lod: mm.lod },
            },
            lg,
          );
          glbInstanced[v] = true;
          if (!countedScatterMeshes.has(mm.mesh)) {
            countedScatterMeshes.add(mm.mesh);
            sceneStats.scatterMeshTriangles += mm.triangles;
          }
          sceneStats.scatter.nodes++;
          sceneStats.scatter.instances += va.n;
          sceneStats.instancedTriangles += va.n * mm.triangles;
        }
      }
      {
        placementLayers.push({
          biome: L.biome.id,
          biomeName: L.biome.name,
          layer: L.layer.id,
          layerName: L.layer.name,
          rules: clone(L.layer),
          models,
          counts: kept,
          sourceCounts: Array.from(e.counts),
          glbInstanced,
          instanceFormat: '[x, y, z, scale, rotYdeg, modelIndex]',
          instances: e.rows,
        });
      }
      if (e.rows.length) sceneStats.scatter.layers++;
      done++;
      if (done % 4 === 0) await progress('Vegetation and rocks', 0.56 + 0.2 * (done / scatter.layers.length));
    }
  }
  const detailLayers = world
    .layerList()
    .filter((L) => L.detail)
    .map((L) => ({ biome: L.biome.id, layer: L.layer.id, layerName: L.layer.name, runtimeOnly: true, models: L.layer.models.map((m) => m.id), rules: clone(L.layer) }));

  // structures -----------------------------------------------------------------------------------
  await progress('Structures and objects', 0.8);
  const structDocs = [];
  const structMats = new Map();
  const structMaterial = async (slot) => {
    if (structMats.has(slot)) return structMats.get(slot);
    let out;
    if (slot === 'glass') out = { material: glb.addMaterial({ name: 'structure_glass', pbrMetallicRoughness: { baseColorFactor: [0.02, 0.028, 0.035, 1], metallicFactor: 0, roughnessFactor: 0.09 }, doubleSided: true }), uvScale: 1, textured: false };
    else {
      const assign = project.materials?.structure || {};
      const role = STRUCT_ROLES[slot] || 'wood_planks';
      const texId = assign[slot] || Object.keys(manifest.textures || {}).find((k) => manifest.textures[k].role === role);
      const t = manifest.textures?.[texId];
      // structure uvs are metres * 0.5 (2 m tiles); rescale to the texture's real tile size
      out = { material: await textureSetMaterial('structure_' + slot, texId, STRUCT_TINT[slot], { doubleSided: true }), uvScale: 2 / (t?.tileSizeM || 2) };
    }
    structMats.set(slot, out);
    return out;
  };
  const groundOrWater = (s) => {
    const g = hf.sample(s.x, s.z);
    if (s.overWater) {
      const ws = world.waterSurfaceAt(s.x, s.z);
      if (ws > LIM) return Math.max(g, ws + (s.deckHeight ?? 0.45) - (s.modelDeckY ?? MODEL_DECK_Y[s.model] ?? 0));
    }
    return g;
  };
  for (const s of project.structures || []) {
    const isModel = s.type === 'model';
    const y = isModel && s.pad !== true ? (s.y ?? groundOrWater(s)) : world.structureLevel(s);
    const rot = s.rot || 0;
    const scale = s.scale || 1;
    const entry = { id: s.id, type: s.type, x: r3(s.x), y: r3(y), z: r3(s.z), rotDeg: r3((rot * 180) / Math.PI), scale, settlement: s.settlement ?? null, inGlb: false };
    const nodeDef = { name: 'structure_' + safeName(s.id), translation: [s.x, y, s.z], rotation: [0, Math.sin(rot / 2), 0, Math.cos(rot / 2)], extras: { kind: 'structure', id: s.id, type: s.type } };
    if (scale !== 1) nodeDef.scale = [scale, scale, scale];
    if (isModel) {
      entry.model = s.model;
      if (include.structures) {
        const mm = await modelMesh(s.model, 0);
        if (mm) {
          glb.addNode({ ...nodeDef, mesh: mm.mesh }, group('structures', root));
          entry.inGlb = true;
          sceneStats.triangles += mm.triangles;
        }
      }
    } else {
      const built = buildStructureGeometry(s);
      entry.params = built.params;
      entry.height = r3(built.height);
      entry.frontAxis = '+Z (local), rotated by rotDeg about +Y';
      if (include.structures) {
        const prims = [];
        let tris = 0;
        for (const part of built.parts) {
          if (!part.indices.length) continue;
          const sm = await structMaterial(part.material);
          // untextured slots (glass) carry no uv set; source uvs use the v-up (three.js TextureLoader)
          // convention while glTF's origin is top-left
          const uvs = sm.textured === false ? null : new Float32Array(part.uvs.length);
          if (uvs) {
            for (let i = 0; i < uvs.length; i += 2) {
              uvs[i] = part.uvs[i] * sm.uvScale;
              uvs[i + 1] = 1 - part.uvs[i + 1] * sm.uvScale;
            }
          }
          const nv = part.positions.length / 3;
          prims.push(glb.addPrimitive({ positions: Float32Array.from(part.positions), normals: sanitizeNormals(Float32Array.from(part.normals)), uvs, indices: nv > 65535 ? Uint32Array.from(part.indices) : Uint16Array.from(part.indices), material: sm.material }));
          tris += part.indices.length / 3;
        }
        if (prims.length) {
          glb.addNode({ ...nodeDef, mesh: glb.addMesh('structure_' + safeName(s.id), prims, { type: s.type }) }, group('structures', root));
          entry.inGlb = true;
          sceneStats.triangles += tris;
        }
      }
    }
    if (entry.inGlb) sceneStats.structures++;
    structDocs.push(entry);
  }

  // objects --------------------------------------------------------------------------------------
  const objectDocs = [];
  for (const o of project.objects || []) {
    const sc = o.scale || 1;
    const info = manifest.models?.[o.model];
    let y = o.y;
    let placement = 'explicit y';
    if (y === undefined || y === null) {
      y = hf.sample(o.x, o.z) - (o.sink ?? 0) * sc;
      placement = 'on ground';
    }
    if (o.floating) {
      const ws = world.waterSurfaceAt(o.x, o.z);
      if (ws > LIM) {
        // rest pose of the buoyancy simulation: the fraction `density` of the height is submerged
        y = ws - (o.density ?? 0.45) * (info?.height ?? 1) * sc;
        placement = 'floating (static rest pose; the buoyancy simulation is not exported)';
      }
    }
    const entry = { id: o.id, model: o.model, x: r3(o.x), y: r3(y), z: r3(o.z), rotDeg: r3(((o.rot || 0) * 180) / Math.PI), pitchDeg: r3(((o.pitch || 0) * 180) / Math.PI), rollDeg: r3(((o.roll || 0) * 180) / Math.PI), scale: sc, floating: !!o.floating, placement, inGlb: false };
    if (include.objects) {
      const mm = await modelMesh(o.model, 0);
      if (mm) {
        const nodeDef = { name: 'object_' + safeName(o.id), mesh: mm.mesh, translation: [o.x, y, o.z], rotation: quatFromEulerXYZ(o.pitch || 0, o.rot || 0, o.roll || 0), extras: { kind: 'object', id: o.id, model: o.model, floating: !!o.floating } };
        if (sc !== 1) nodeDef.scale = [sc, sc, sc];
        glb.addNode(nodeDef, group('objects', root));
        entry.inGlb = true;
        sceneStats.objects++;
        sceneStats.triangles += mm.triangles;
      }
    }
    objectDocs.push(entry);
  }

  // roads ----------------------------------------------------------------------------------------
  await progress('Roads', 0.86);
  const roadDocs = [];
  {
    const pathLayer = project.materials?.layers?.path;
    const pathTex = pathLayer ? manifest.textures?.[pathLayer.texture] : null;
    let roadMat = null;
    const roads = project.roads || [];
    for (let i = 0; i < roads.length; i++) {
      const rd = roads[i];
      const c = world.compiled.roads[i];
      const doc = { id: rd.id, name: rd.name ?? null, kind: rd.kind === 'trail' ? 'trail' : 'road', width: c ? c.R.width : rd.width ?? null, nodes: (rd.nodes || []).map((n) => ({ ...n, x: r3(n.x), z: r3(n.z) })), inGlb: false };
      if (c) {
        const sp = c.sp;
        const step = Math.max(1, Math.round(4 / sp.ds));
        doc.lengthMeters = r3(sp.length);
        doc.profileFormat = '[x, z, surfaceY, halfWidth]';
        doc.profile = [];
        for (let k = 0; k < sp.n; k += step) doc.profile.push([r3(sp.x[k]), r3(sp.z[k]), r3(hf.sample(sp.x[k], sp.z[k])), r3(c.hw[k])]);
        if (include.roads) {
          if (roadMat === null) roadMat = await textureSetMaterial('path_surface', pathLayer?.texture, pathLayer?.tint);
          const rb = buildRoadRibbon(world, c, terrain ? terrain.sample : null, pathTex?.tileSizeM || 2, 0.03);
          if (rb.indices.length) {
            const name = 'road_' + safeName(rd.id || i + 1);
            glb.addNode({ name, mesh: glb.addMesh(name, [glb.addPrimitive({ positions: rb.positions, normals: rb.normals, uvs: rb.uvs, indices: rb.indices, material: roadMat })]), extras: { kind: 'road', id: rd.id ?? null, roadKind: doc.kind } }, group('roads', root));
            doc.inGlb = true;
            sceneStats.roads++;
            sceneStats.triangles += rb.triangles;
          }
        }
      }
      roadDocs.push(doc);
    }
  }

  await progress('Writing scene.glb', 0.9);
  if (glb.required.has('EXT_texture_webp')) notes.push(`EXT_texture_webp is required: ${webpModels.size} source model(s) embed WebP textures that are passed through unchanged (${[...webpModels].slice(0, 6).join(', ')}${webpModels.size > 6 ? ', ...' : ''})`);
  const glbBytes = glb.build();
  add('scene.glb', glbBytes, 'model/gltf-binary');
  const extensionsUsed = [...glb.used].sort();
  const extensionsRequired = [...glb.required].sort();

  // ------------------------------------------------------------------ placements.json
  await progress('Placements', 0.94);
  const riverDocs = (project.water.rivers || []).map((rv, i) => {
    const c = world.compiled.rivers[i];
    const doc = { id: rv.id, name: rv.name ?? null, hidden: !!rv.hidden, width: c ? c.R.width : rv.width ?? null, depth: c ? c.R.depth : rv.depth ?? null, flow: c ? c.R.flow : rv.flow ?? null, nodes: (rv.nodes || []).map((n) => ({ ...n, x: r3(n.x), z: r3(n.z) })) };
    if (c) {
      const sp = c.sp;
      const step = Math.max(1, Math.round(5 / sp.ds));
      doc.lengthMeters = r3(sp.length);
      doc.centrelineFormat = '[x, z, bedY, surfaceY, halfWidth]';
      doc.centreline = [];
      for (let k = 0; k < sp.n; k += step) doc.centreline.push([r3(sp.x[k]), r3(sp.z[k]), r3(c.bed[k]), r3(c.surf[k]), r3(c.hw[k])]);
      const k = sp.n - 1;
      if (doc.centreline.length && (k % step !== 0)) doc.centreline.push([r3(sp.x[k]), r3(sp.z[k]), r3(c.bed[k]), r3(c.surf[k]), r3(c.hw[k])]);
    }
    return doc;
  });
  const lakeDocs = lakes.map((l, i) => {
    const b = labelled.bodies.find((q) => q.kind === 'lake' && q.lakeIndex === i);
    return { id: l.id ?? null, name: l.name ?? null, x: r3(l.x), z: r3(l.z), level: l.level, wetCells: b ? b.cells : 0, areaM2: r3((b ? b.cells : 0) * hf.cell * hf.cell) };
  });
  const ocean = labelled.bodies.find((b) => b.kind === 'ocean');
  const placements = {
    formatVersion: EXPORT_FORMAT_VERSION,
    units: 'm',
    axis: heightmapDoc.axis,
    rotationConvention: 'rotYdeg / rotDeg: right-handed rotation about +Y (x\' = x cos + z sin, z\' = -x sin + z cos); glTF quaternion (0, sin(a/2), 0, cos(a/2))',
    scatter: {
      totalInstances: scatter.total,
      exportedInstances: scatter.exported,
      truncated: scatter.truncated,
      vegetationLod: vegLod,
      note: 'instance y is the ground elevation of the full-resolution heightmap minus the layer sink; a small per-instance ground-alignment tilt is only present in scene.glb',
      layers: placementLayers,
    },
    detailLayers: { note: 'near-camera detail layers (layer.range <= 130 m: grass, ferns, flowers, cobbles) are generated at runtime around the camera and are exported as rules only', layers: detailLayers },
    structures: structDocs,
    objects: objectDocs,
    rivers: riverDocs,
    lakes: lakeDocs,
    sea: { enabled: world.seaLevel !== null, level: world.seaLevel, wetCells: ocean ? ocean.cells : 0, areaM2: r3((ocean ? ocean.cells : 0) * hf.cell * hf.cell) },
    roads: roadDocs,
    settlements: clone(project.settlements || []),
  };
  add('placements.json', enc(JSON.stringify(placements)), 'application/json');

  // ------------------------------------------------------------------ environment.json
  const env = clone(project.env || {});
  const sun = sunDirection(env);
  const sunAngles = directionAngles(sun);
  const windDir = env.windDir ?? 0;
  const environment = {
    formatVersion: EXPORT_FORMAT_VERSION,
    axis: heightmapDoc.axis,
    env,
    sun: { direction: sun.map(r4), note: 'unit vector from the scene towards the sun', elevationDeg: r3(sunAngles.elevationDeg), bearingDeg: r3(sunAngles.bearingDeg), bearingConvention: 'compass bearing of the sun, 0 = north (-z), 90 = east (+x)' },
    wind: { dirRadians: windDir, speed: env.windSpeed ?? 0, vector: [r4(Math.cos(windDir) * (env.windSpeed ?? 0)), 0, r4(Math.sin(windDir) * (env.windSpeed ?? 0))], note: 'direction the wind blows towards (0 rad = +x east, pi/2 = +z south), m/s' },
    water: {
      seaLevel: world.seaLevel,
      optics: clone(optics),
      opticsNote: 'absorb / scatter are RGB coefficients in 1/m; scene.glb water materials approximate them with KHR_materials_volume attenuation',
      waveScale: project.water.waveScale ?? 1,
      foamAmount: project.water.foamAmount ?? 1,
      causticStrength: project.water.causticStrength ?? 1,
      swell: clone(project.water.swell || {}),
      swellNote: 'height (m, offshore significant), period (s), dir (radians, direction of travel, 0 = +x)',
    },
    terrain: { preset: project.terrain?.preset ?? null, seed: project.seed, sizeMeters: world.size, minHeight: hMin, maxHeight: hMax },
  };
  add('environment.json', enc(environment), 'application/json');

  // ------------------------------------------------------------------ report + README
  await progress('Report', 0.97);
  const report = {
    generator: 'Terraforge',
    formatVersion: EXPORT_FORMAT_VERSION,
    exported: new Date().toISOString(),
    project: { id: project.id, name: project.name, seed: project.seed, preset: project.terrain?.preset ?? null },
    options: { terrainMeshRes: terrain ? terrain.n : null, terrainTextureRes: texRes, vegetationLod: vegLod, maxInstances: opts.maxInstances ?? 400000, include },
    units: 'm',
    axis: heightmapDoc.axis,
    bounds: { min: [-world.size / 2, hMin, -world.size / 2], max: [world.size / 2, hMax, world.size / 2] },
    heightmap: { width: res, height: res, sizeMeters: world.size, cellMeters: hf.cell, minHeight: hMin, maxHeight: hMax },
    counts: {
      wetCells,
      waterBodies: labelled.bodies.map((b) => ({ name: b.name, kind: b.kind, wetCells: b.cells })),
      waterMeshes: sceneStats.water.length,
      scatterLayers: sceneStats.scatter.layers,
      scatterNodes: sceneStats.scatter.nodes,
      scatterInstancesTotal: scatter.total,
      scatterInstancesInPlacements: scatter.exported,
      scatterInstancesInGlb: sceneStats.scatter.instances,
      scatterTruncated: scatter.truncated,
      detailLayersRuntimeOnly: detailLayers.length,
      structures: structDocs.length,
      structuresInGlb: sceneStats.structures,
      objects: objectDocs.length,
      objectsInGlb: sceneStats.objects,
      rivers: riverDocs.length,
      lakes: lakeDocs.length,
      roads: roadDocs.length,
      roadsInGlb: sceneStats.roads,
      masks: maskFiles.length,
    },
    scene: {
      file: 'scene.glb',
      bytes: glbBytes.length,
      nodes: glb.json.nodes.length,
      meshes: glb.json.meshes?.length || 0,
      materials: glb.json.materials?.length || 0,
      textures: glb.json.textures?.length || 0,
      images: glb.json.images?.length || 0,
      imagesDeduplicated: glb.stats.imagesDeduplicated,
      imageBytes: glb.stats.imageBytes,
      geometryBytes: glb.stats.geometryBytes,
      uniqueTriangles: Math.round(sceneStats.triangles + sceneStats.scatterMeshTriangles),
      instancedTriangles: Math.round(sceneStats.instancedTriangles),
      extensionsUsed,
      extensionsRequired,
      terrain: sceneStats.terrain,
      water: sceneStats.water,
      hierarchy: 'world -> terrain | water/<body> | scatter/<biome>/<layer>/<model> (EXT_mesh_gpu_instancing) | structures/<id> | objects/<id> | roads/<id>',
    },
    skippedModels: Object.fromEntries(skippedModels),
    missingAssets: [...missingAssets],
    warnings,
    notes,
    notExported: WHAT_DOES_NOT_SURVIVE,
    durationMs: 0,
    files: [],
  };
  report.files = files.map((f) => ({ name: f.name, bytes: f.data.length, mime: f.mime }));
  report.files.push({ name: 'export_report.json', bytes: null, mime: 'application/json' }, { name: 'README_EXPORT.md', bytes: null, mime: 'text/markdown' });
  report.durationMs = Date.now() - t0;
  add('README_EXPORT.md', enc(buildReadme(report, { masksDoc, heightmapDoc, depthScale, flowScale: FLOW_SCALE })), 'text/markdown');
  add('export_report.json', enc(report), 'application/json');
  await progress('Done', 1);
  return { files, report };
}

export { sunDirection, linearToSrgb8 };
