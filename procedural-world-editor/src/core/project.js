// Project document: schema defaults, biome library, (de)serialisation of binary layers.
// A project on disk is a folder:
//   project.json        the document below (all authoring state, asset references by manifest id)
//   heights.u16.gz      user heightfield, 16-bit quantised between terrain.hMin / terrain.hMax
//   sediment.u8.gz      sediment map
//   ring.u16.gz         surrounding (non-editable) terrain ring
//   paint.bin.gz        painted masks (biome, exclusion, materials, density) - only layers in use
//   assets.lock.json    every asset id the project references with its file hashes

import { gzip, gunzip } from './png.js';
import { defaultTerrainParams } from './terrainGen.js';
import { BIOME_LIBRARY, PRESET_BIOMES, PRESET_MATERIALS } from './biomeLibrary.js';

export { BIOME_LIBRARY, PRESET_BIOMES, PRESET_MATERIALS };

export const PROJECT_VERSION = 4;

export function defaultEnvironment() {
  return {
    timeOfDay: 10.5, // hours
    sunAzimuth: 135, // degrees, compass bearing the sun shines FROM at noon-ish (rotates with time)
    latitude: 46,
    dayOfYear: 172,
    turbidity: 2.2, // aerosol amount (1 = very clear)
    cloudCover: 0.35,
    cloudHeight: 1900, // m above datum
    cloudSpeed: 6,
    fogDensity: 0.25, // valley haze 0..1
    fogHeight: 220,
    windDir: 0.6, // radians, direction the wind blows towards
    windSpeed: 4.5, // m/s
    exposure: 0, // EV offset
    autoExposure: true,
  };
}

export function defaultWater() {
  return {
    sea: { enabled: false, level: 0 },
    swell: { height: 0.9, period: 9, dir: 0 },
    lakes: [],
    rivers: [],
    // optical properties: absorption (1/m, RGB) + scattering albedo; presets below
    optics: { ...WATER_PRESETS.alpine },
    waveScale: 1.0,
    foamAmount: 1.0,
    causticStrength: 1.0,
  };
}

export const WATER_PRESETS = {
  alpine: { label: 'Clear mountain water', absorb: [0.42, 0.075, 0.045], scatter: [0.012, 0.03, 0.028], turbidity: 0.08 },
  lake: { label: 'Lake (slightly humic)', absorb: [0.4, 0.13, 0.2], scatter: [0.022, 0.034, 0.03], turbidity: 0.14 },
  ocean: { label: 'Coastal sea', absorb: [0.5, 0.11, 0.075], scatter: [0.008, 0.03, 0.034], turbidity: 0.32 },
  glacial: { label: 'Glacial melt (silty turquoise)', absorb: [0.5, 0.09, 0.12], scatter: [0.08, 0.2, 0.19], turbidity: 0.7 },
  peat: { label: 'Peat-stained', absorb: [0.7, 0.55, 1.1], scatter: [0.02, 0.018, 0.008], turbidity: 0.35 },
};

/** Expand `match` model references against the manifest; returns {biomes, missing[]} */
export function resolveBiomes(ids, manifest) {
  const missing = [];
  const modelIds = Object.keys(manifest.models || {});
  const biomes = ids.map((id) => {
    const b = JSON.parse(JSON.stringify(BIOME_LIBRARY[id]));
    for (const l of b.layers) {
      const out = [];
      for (const m of l.models) {
        if (m.id) {
          out.push(m);
          continue;
        }
        const found = modelIds.filter((k) => k === m.match || k.startsWith(m.match + '__'));
        if (!found.length) {
          missing.push(m.match);
          continue;
        }
        for (const f of found) out.push({ id: f, weight: (m.weight ?? 1) / found.length, scale: m.scale ?? 1 });
      }
      l.models = out;
    }
    b.layers = b.layers.filter((l) => l.models.length > 0);
    return b;
  });
  return { biomes, missing: [...new Set(missing)] };
}

export function resolveMaterials(preset, manifest) {
  const defs = PRESET_MATERIALS[preset] || PRESET_MATERIALS.alpine;
  const byRole = {};
  for (const [id, t] of Object.entries(manifest.textures || {})) if (!(t.role in byRole)) byRole[t.role] = id;
  const layers = {};
  const missing = [];
  for (const [layer, def] of Object.entries(defs)) {
    const id = manifest.textures?.[def.texture] ? def.texture : byRole[def.role];
    if (id) layers[layer] = { texture: id, tint: def.tint };
    else missing.push(def.texture);
  }
  return { layers, missing };
}

let idCounter = 0;
export function newId(prefix = 'id') {
  idCounter++;
  return `${prefix}-${Date.now().toString(36)}${(idCounter % 1296).toString(36).padStart(2, '0')}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
}

export function createProjectDoc({ name, preset = 'alpine', seed = 1, manifest, terrain = {} }) {
  const tp = { ...defaultTerrainParams(preset, seed), ...terrain };
  const { biomes, missing } = resolveBiomes(PRESET_BIOMES[preset] || PRESET_BIOMES.alpine, manifest);
  const mats = resolveMaterials(preset, manifest);
  const doc = {
    version: PROJECT_VERSION,
    id: newId('proj'),
    name: name || 'Untitled world',
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    seed,
    terrain: { ...tp, hMin: 0, hMax: 1, operations: [] },
    env: defaultEnvironment(),
    water: defaultWater(),
    materials: { layers: mats.layers, rules: {} },
    biomes,
    roads: [],
    structures: [],
    settlements: [],
    objects: [], // manually placed models {id, model, x, y?, z, rot, scale, floating?}
    scatter: { suppressed: [] },
    cameras: [],
    view: null,
    notes: '',
  };
  if (preset === 'coast') {
    doc.water.sea = { enabled: true, level: 0 };
    doc.water.optics = { ...WATER_PRESETS.ocean };
    doc.materials.rules = { snowLine: 9000, treeLine: 8000 };
  } else if (preset === 'lake' || preset === 'hills') {
    doc.water.optics = { ...WATER_PRESETS.lake };
    doc.materials.rules = { snowLine: 9000, treeLine: 8000 };
  }
  return { doc, missing: [...missing, ...mats.missing] };
}

/** List every asset id referenced by a project document. */
export function referencedAssets(doc) {
  const models = new Set();
  const textures = new Set();
  for (const b of doc.biomes || []) for (const l of b.layers || []) for (const m of l.models || []) models.add(m.id);
  for (const o of doc.objects || []) models.add(o.model);
  for (const s of doc.structures || []) if (s.type === 'model') models.add(s.model);
  for (const l of Object.values(doc.materials?.layers || {})) textures.add(l.texture);
  for (const t of Object.values(doc.materials?.structure || {})) textures.add(t);
  return { models: [...models].filter(Boolean), textures: [...textures].filter(Boolean) };
}

// ---------------------------------------------------------------------------------------------
// Binary layers
// ---------------------------------------------------------------------------------------------

export function quantizeHeights(data) {
  let mn = Infinity,
    mx = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (!(mx > mn)) mx = mn + 1;
  const out = new Uint16Array(data.length);
  const sc = 65535 / (mx - mn);
  for (let i = 0; i < data.length; i++) out[i] = Math.round((data[i] - mn) * sc);
  return { u16: out, hMin: mn, hMax: mx };
}

export function dequantizeHeights(u16, hMin, hMax) {
  const out = new Float32Array(u16.length);
  const sc = (hMax - hMin) / 65535;
  for (let i = 0; i < u16.length; i++) out[i] = hMin + u16[i] * sc;
  return out;
}

// Heights are kept on a fixed 1/1024 m grid (in memory and on disk), so saving and reopening a
// project reproduces the terrain - and everything derived from it - exactly.
export const HEIGHT_Q = 1024;
/** Snap heights in place to the storage grid (optionally only inside a rect of a res x res grid). */
export function snapHeights(data, res, rect) {
  if (!rect) {
    for (let i = 0; i < data.length; i++) data[i] = Math.round(data[i] * HEIGHT_Q) / HEIGHT_Q;
    return data;
  }
  for (let z = rect.z0; z <= rect.z1; z++) {
    const row = z * res;
    for (let x = rect.x0; x <= rect.x1; x++) data[row + x] = Math.round(data[row + x] * HEIGHT_Q) / HEIGHT_Q;
  }
  return data;
}
export function snapSediment(data, res, rect) {
  const q = (v) => Math.max(0, Math.min(255, Math.round(v * 255))) / 255;
  if (!rect) {
    for (let i = 0; i < data.length; i++) data[i] = q(data[i]);
    return data;
  }
  for (let z = rect.z0; z <= rect.z1; z++) for (let x = rect.x0; x <= rect.x1; x++) data[z * res + x] = q(data[z * res + x]);
  return data;
}
/** Lossless height layer: int32 fixed point, delta coded along the array, gzip. */
export async function packHeights(data) {
  const out = new Int32Array(data.length);
  let prev = 0;
  for (let i = 0; i < data.length; i++) {
    const v = Math.round(data[i] * HEIGHT_Q);
    out[i] = v - prev;
    prev = v;
  }
  // byte planes compress far better than interleaved little-endian words
  const n = out.length;
  const src = new Uint8Array(out.buffer);
  const planes = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    planes[i] = src[i * 4];
    planes[n + i] = src[i * 4 + 1];
    planes[2 * n + i] = src[i * 4 + 2];
    planes[3 * n + i] = src[i * 4 + 3];
  }
  return gzip(planes);
}
export async function unpackHeights(bytes) {
  const planes = await gunzip(bytes);
  const n = planes.length / 4;
  const words = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    words[i * 4] = planes[i];
    words[i * 4 + 1] = planes[n + i];
    words[i * 4 + 2] = planes[2 * n + i];
    words[i * 4 + 3] = planes[3 * n + i];
  }
  const d = new Int32Array(words.buffer);
  const out = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += d[i];
    out[i] = acc / HEIGHT_Q;
  }
  return out;
}

/** Pack paint layers: header JSON + raw layers; only non-empty layers are stored. */
export async function packPaint(paint, res) {
  const N = res * res;
  const entries = [];
  const add = (name, arr) => {
    if (!arr) return;
    let any = false;
    const neutral = name.startsWith('density:') ? 128 : 0;
    for (let i = 0; i < N; i++) {
      if (arr[i] !== neutral) {
        any = true;
        break;
      }
    }
    if (any) entries.push({ name, arr });
  };
  add('biome', paint.biome);
  add('exclude', paint.exclude);
  (paint.mat || []).forEach((m, i) => add('mat:' + i, m));
  for (const [k, v] of Object.entries(paint.density || {})) add('density:' + k, v);
  const header = new TextEncoder().encode(JSON.stringify({ res, layers: entries.map((e) => e.name) }));
  const buf = new Uint8Array(4 + header.length + entries.length * N);
  new DataView(buf.buffer).setUint32(0, header.length, true);
  buf.set(header, 4);
  entries.forEach((e, i) => buf.set(e.arr, 4 + header.length + i * N));
  return gzip(buf);
}

export async function unpackPaint(bytes, res) {
  const N = res * res;
  const paint = { biome: new Uint8Array(N), exclude: new Uint8Array(N), mat: new Array(9).fill(null), density: {} };
  if (!bytes || !bytes.length) return paint;
  const buf = await gunzip(bytes);
  const hl = new DataView(buf.buffer, buf.byteOffset).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + hl)));
  if (header.res !== res) throw new Error(`paint layer resolution ${header.res} does not match terrain ${res}`);
  header.layers.forEach((name, i) => {
    const arr = buf.slice(4 + hl + i * N, 4 + hl + (i + 1) * N);
    if (name === 'biome') paint.biome = arr;
    else if (name === 'exclude') paint.exclude = arr;
    else if (name.startsWith('mat:')) paint.mat[+name.slice(4)] = arr;
    else if (name.startsWith('density:')) paint.density[name.slice(8)] = arr;
  });
  return paint;
}

export async function packU16(u16) {
  return gzip(new Uint8Array(u16.buffer, u16.byteOffset, u16.byteLength));
}
export async function unpackU16(bytes) {
  const raw = await gunzip(bytes);
  return new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
}
export async function packU8(u8) {
  return gzip(u8);
}
export async function unpackU8(bytes) {
  return gunzip(bytes);
}
export function sedimentToU8(sed) {
  const out = new Uint8Array(sed.length);
  for (let i = 0; i < sed.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(sed[i] * 255)));
  return out;
}
export function sedimentFromU8(u8) {
  const out = new Float32Array(u8.length);
  for (let i = 0; i < u8.length; i++) out[i] = u8[i] / 255;
  return out;
}
