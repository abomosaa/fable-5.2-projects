#!/usr/bin/env node
// Independent verification of a Terraforge export folder. Uses none of the editor's renderer or
// exporter code: its own PNG / GLB readers, the Khronos glTF validator and the stock three.js
// GLTFLoader (in headless Chromium through tools/viewer/, and/or directly in Node).
//
//   node tools/verify-export.mjs <exportDir> [--project projects/<id>] [--shots <outDir>]
//                                [--no-browser] [--budget <M triangles>] [--serve] [--port N]
//
//   --no-browser  skip Chromium: validator + numeric checks only (scene graph measured with the
//                 stock GLTFLoader running in Node and with the built-in GLB reader); no screenshots
//   --serve       start the viewer server and keep it running for manual inspection
//
// Writes <shots>/verify_report.json (+ screenshots). Exit code 0 only if every check passes.

import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { inflateSync, deflateSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    if (['no-browser', 'serve', 'help'].includes(key)) flags[key] = true;
    else flags[key] = argv[++i];
  } else positional.push(a);
}
if (flags.help || positional.length < 1) {
  console.error('usage: node tools/verify-export.mjs <exportDir> [--project <projectDir>] [--shots <outDir>] [--no-browser] [--budget <million triangles>] [--serve] [--port N]');
  process.exit(2);
}
const exportDir = resolve(positional[0]);
const shotsDir = resolve(flags.shots || join(exportDir, 'verify'));
const projectDir = flags.project ? resolve(flags.project) : null;
const drawBudget = flags.budget !== undefined ? +flags.budget : 250;

// ---------------------------------------------------------------------------------------------
// independent readers
// ---------------------------------------------------------------------------------------------

/** Non-interlaced 8/16-bit PNG decoder (gray, RGB, gray+alpha, RGBA). */
function decodePng(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('not a PNG file');
  let p = 8;
  let width = 0,
    height = 0,
    bitDepth = 0,
    colorType = 0,
    interlace = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (type === 'IHDR') {
      width = buf.readUInt32BE(p + 8);
      height = buf.readUInt32BE(p + 12);
      bitDepth = buf[p + 16];
      colorType = buf[p + 17];
      interlace = buf[p + 20];
    } else if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (interlace) throw new Error('interlaced PNG not supported');
  if (bitDepth !== 8 && bitDepth !== 16) throw new Error('unsupported PNG bit depth ' + bitDepth);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('unsupported PNG colour type ' + colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = channels * (bitDepth / 8);
  const stride = width * bpp;
  if (raw.length !== (stride + 1) * height) throw new Error(`PNG data size mismatch (${raw.length} vs ${(stride + 1) * height})`);
  const data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? data[dst + i - bpp] : 0;
      const b = y > 0 ? data[dst - stride + i] : 0;
      const c = i >= bpp && y > 0 ? data[dst - stride + i - bpp] : 0;
      let v = raw[src + i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c),
          pb = Math.abs(a - c),
          pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      data[dst + i] = v & 255;
    }
  }
  let pixels = data;
  if (bitDepth === 16) {
    pixels = new Uint16Array(width * height * channels);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (data[i * 2] << 8) | data[i * 2 + 1];
  }
  return { width, height, channels, bitDepth, pixels };
}

const COMPS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const CTYPE = { 5120: [Int8Array, 'getInt8'], 5121: [Uint8Array, 'getUint8'], 5122: [Int16Array, 'getInt16'], 5123: [Uint16Array, 'getUint16'], 5125: [Uint32Array, 'getUint32'], 5126: [Float32Array, 'getFloat32'] };

/** Minimal GLB container + accessor reader (structural checks are collected in `problems`). */
function readGlb(buf) {
  const problems = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('scene.glb: bad magic');
  if (dv.getUint32(4, true) !== 2) throw new Error('scene.glb: container version is not 2');
  const total = dv.getUint32(8, true);
  if (total !== buf.byteLength) problems.push(`declared length ${total} != file size ${buf.byteLength}`);
  const jsonLen = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== 0x4e4f534a) throw new Error('scene.glb: first chunk is not JSON');
  if (jsonLen % 4) problems.push('JSON chunk length is not a multiple of 4');
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
  const binHeader = 20 + jsonLen;
  const binLen = dv.getUint32(binHeader, true);
  if (dv.getUint32(binHeader + 4, true) !== 0x004e4942) throw new Error('scene.glb: second chunk is not BIN');
  if (binLen % 4) problems.push('BIN chunk length is not a multiple of 4');
  if (binHeader + 8 + binLen !== total) problems.push('chunk lengths do not add up to the file length');
  const bin = buf.subarray(binHeader + 8, binHeader + 8 + binLen);
  if (json.buffers?.[0]?.byteLength > binLen) problems.push('buffer byteLength exceeds the BIN chunk');
  const bdv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const accessor = (index) => {
    const acc = json.accessors[index];
    const comps = COMPS[acc.type];
    const [Ctor, getter] = CTYPE[acc.componentType];
    const bv = json.bufferViews[acc.bufferView];
    const size = Ctor.BYTES_PER_ELEMENT;
    const stride = bv.byteStride || comps * size;
    const start = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const out = new Ctor(acc.count * comps);
    for (let i = 0; i < acc.count; i++) for (let c = 0; c < comps; c++) out[i * comps + c] = bdv[getter](start + i * stride + c * size, true);
    return out;
  };
  return { json, bin, accessor, problems, jsonLen, binLen };
}

function trsMatrix(node) {
  if (node.matrix) return Float64Array.from(node.matrix);
  const t = node.translation || [0, 0, 0],
    [x, y, z, w] = node.rotation || [0, 0, 0, 1],
    s = node.scale || [1, 1, 1];
  const xx = x * x * 2,
    yy = y * y * 2,
    zz = z * z * 2,
    xy = x * y * 2,
    xz = x * z * 2,
    yz = y * z * 2,
    wx = w * x * 2,
    wy = w * y * 2,
    wz = w * z * 2;
  return Float64Array.from([(1 - yy - zz) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0, (xy - wz) * s[1], (1 - xx - zz) * s[1], (yz + wx) * s[1], 0, (xz + wy) * s[2], (yz - wx) * s[2], (1 - xx - yy) * s[2], 0, t[0], t[1], t[2], 1]);
}
function mul4(a, b) {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
const apply4 = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
const rnd = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
function sampleIdx(count, max) {
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  const out = [];
  for (let k = 0; k < max; k++) out.push(Math.round((k * (count - 1)) / (max - 1)));
  return out;
}

/** Scene measurements straight from the file (same shape as tools/viewer/stats.js collectStats). */
function measureWithReader(glb) {
  const j = glb.json;
  const out = { source: 'built-in GLB reader', sceneBounds: null, sceneExtras: j.scenes[j.scene || 0].extras || {}, groups: {}, materials: [], terrain: null, water: [], structures: [], objects: [], scatter: [], roads: [], totals: { meshes: 0, instancedMeshes: 0, instances: 0, triangles: 0, instancedTriangles: 0 } };
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  const grow = (p) => {
    for (let k = 0; k < 3; k++) {
      if (p[k] < min[k]) min[k] = p[k];
      if (p[k] > max[k]) max[k] = p[k];
    }
  };
  const primTris = (p) => Math.floor((p.indices !== undefined ? j.accessors[p.indices].count : j.accessors[p.attributes.POSITION].count) / 3);
  const meshBox = (mesh, m, each) => {
    const bmin = [Infinity, Infinity, Infinity],
      bmax = [-Infinity, -Infinity, -Infinity];
    for (const p of mesh.primitives) {
      const a = j.accessors[p.attributes.POSITION];
      for (let c = 0; c < 8; c++) {
        const w = apply4(m, c & 1 ? a.max[0] : a.min[0], c & 2 ? a.max[1] : a.min[1], c & 4 ? a.max[2] : a.min[2]);
        for (let k = 0; k < 3; k++) {
          if (w[k] < bmin[k]) bmin[k] = w[k];
          if (w[k] > bmax[k]) bmax[k] = w[k];
        }
        if (each) each(w);
      }
    }
    return { min: bmin.map((v) => rnd(v, 3)), max: bmax.map((v) => rnd(v, 3)) };
  };
  const upFacing = (prim, m) => {
    const pos = glb.accessor(prim.attributes.POSITION);
    const ind = prim.indices !== undefined ? glb.accessor(prim.indices) : null;
    const n = ind ? ind.length : pos.length / 3;
    let up = 0,
      total = 0;
    for (let t = 0; t + 2 < n; t += 3) {
      const A = apply4(m, ...pos.subarray((ind ? ind[t] : t) * 3, (ind ? ind[t] : t) * 3 + 3)),
        B = apply4(m, ...pos.subarray((ind ? ind[t + 1] : t + 1) * 3, (ind ? ind[t + 1] : t + 1) * 3 + 3)),
        C = apply4(m, ...pos.subarray((ind ? ind[t + 2] : t + 2) * 3, (ind ? ind[t + 2] : t + 2) * 3 + 3));
      if ((B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2]) > 0) up++;
      total++;
    }
    return total ? rnd(up / total) : 0;
  };
  const vsamples = (accIndex, m, maxN) => {
    const pos = glb.accessor(accIndex);
    return sampleIdx(pos.length / 3, maxN).map((i) => apply4(m, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).map((v) => rnd(v)));
  };
  const scene = j.scenes[j.scene || 0];
  const I = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const visit = (idx, pm, groupName, depth) => {
    const node = j.nodes[idx];
    const m = mul4(pm, trsMatrix(node));
    const ex = node.extras || {};
    let g = groupName;
    if (depth === 1) g = ex.kind === 'group' ? ex.group : ex.kind === 'terrain' ? 'terrain' : node.name;
    const G = g ? (out.groups[g] ||= { meshes: 0, instancedMeshes: 0, instances: 0, triangles: 0, instancedTriangles: 0 }) : null;
    const inst = node.extensions?.EXT_mesh_gpu_instancing;
    if (node.mesh !== undefined) {
      const mesh = j.meshes[node.mesh];
      const tris = mesh.primitives.reduce((a, p) => a + primTris(p), 0);
      if (G) {
        G.meshes += mesh.primitives.length;
        G.triangles += tris;
      }
      if (inst) {
        const tr = glb.accessor(inst.attributes.TRANSLATION);
        const ro = inst.attributes.ROTATION !== undefined ? glb.accessor(inst.attributes.ROTATION) : null;
        const sc = inst.attributes.SCALE !== undefined ? glb.accessor(inst.attributes.SCALE) : null;
        const count = tr.length / 3;
        if (G) {
          G.instancedMeshes += mesh.primitives.length;
          G.instances += count;
          G.instancedTriangles += tris * count;
        }
        let minY = Infinity,
          maxY = -Infinity,
          rad = 0;
        for (const p of mesh.primitives) {
          const a = j.accessors[p.attributes.POSITION];
          minY = Math.min(minY, a.min[1]);
          maxY = Math.max(maxY, a.max[1]);
          rad = Math.max(rad, Math.hypot(Math.max(-a.min[0], a.max[0]), Math.max(-a.min[1], a.max[1]), Math.max(-a.min[2], a.max[2])));
        }
        let minUpY = 1;
        let badQuat = 0;
        for (let i = 0; i < count; i++) {
          const s = sc ? sc[i * 3] : 1;
          const w = apply4(m, tr[i * 3], tr[i * 3 + 1], tr[i * 3 + 2]);
          grow([w[0] - rad * s, w[1] - rad * s, w[2] - rad * s]);
          grow([w[0] + rad * s, w[1] + rad * s, w[2] + rad * s]);
          if (ro) {
            const l = Math.hypot(ro[i * 4], ro[i * 4 + 1], ro[i * 4 + 2], ro[i * 4 + 3]);
            if (Math.abs(l - 1) > 1e-3) badQuat++;
          }
        }
        const samples = sampleIdx(count, 160).map((i) => {
          const w = apply4(m, tr[i * 3], tr[i * 3 + 1], tr[i * 3 + 2]);
          let upY = 1;
          if (ro) {
            const x = ro[i * 4],
              z = ro[i * 4 + 2];
            upY = 1 - 2 * (x * x + z * z);
          }
          if (upY < minUpY) minUpY = upY;
          return [rnd(w[0]), rnd(w[1]), rnd(w[2]), rnd(sc ? sc[i * 3] : 1), rnd(upY)];
        });
        if (ex.kind === 'scatter') out.scatter.push({ biome: ex.biome, layer: ex.layer, model: ex.model, modelIndex: ex.modelIndex ?? null, count, declaredCount: ex.count ?? null, primitives: mesh.primitives.length, triangles: tris, meshMinY: rnd(minY, 3), meshMaxY: rnd(maxY, 3), minUpY: rnd(minUpY), nonUnitQuaternions: badQuat, samples });
      } else {
        const box = meshBox(mesh, m, grow);
        const p0 = mesh.primitives[0];
        if (ex.kind === 'terrain') {
          const mat = j.materials[p0.material] || {};
          out.terrain = { bounds: box, vertexCount: j.accessors[p0.attributes.POSITION].count, triangles: tris, hasNormals: p0.attributes.NORMAL !== undefined, hasUv: p0.attributes.TEXCOORD_0 !== undefined, upFacing: upFacing(p0, m), material: mat.name || '', materialHasMap: !!mat.pbrMetallicRoughness?.baseColorTexture, extras: ex, samples: vsamples(p0.attributes.POSITION, m, 20000) };
        } else if (ex.kind === 'water') {
          const mat = j.materials[p0.material] || {};
          const pos = glb.accessor(p0.attributes.POSITION);
          const ind = p0.indices !== undefined ? glb.accessor(p0.indices) : null;
          let area = 0;
          const n = ind ? ind.length : pos.length / 3;
          for (let t = 0; t + 2 < n; t += 3) {
            const a = (ind ? ind[t] : t) * 3,
              b = (ind ? ind[t + 1] : t + 1) * 3,
              c = (ind ? ind[t + 2] : t + 2) * 3;
            area += Math.abs((pos[b] - pos[a]) * (pos[c + 2] - pos[a + 2]) - (pos[c] - pos[a]) * (pos[b + 2] - pos[a + 2])) * 0.5;
          }
          let maxFlow = 0;
          if (p0.attributes.TEXCOORD_1 !== undefined) {
            const f = glb.accessor(p0.attributes.TEXCOORD_1);
            for (let i = 0; i < f.length; i += 2) maxFlow = Math.max(maxFlow, Math.hypot(f[i], f[i + 1]));
          }
          out.water.push({ name: node.name, body: ex.body, id: ex.id, level: ex.level ?? null, vertexCount: pos.length / 3, triangles: tris, bounds: box, areaXZ: rnd(area, 2), upFacing: upFacing(p0, m), hasFlowAttribute: p0.attributes.TEXCOORD_1 !== undefined, maxFlow: rnd(maxFlow), material: mat.name || '', transmission: mat.extensions?.KHR_materials_transmission?.transmissionFactor ?? 0, transparent: mat.alphaMode === 'BLEND', samples: vsamples(p0.attributes.POSITION, m, 6000) });
        } else if (ex.kind === 'structure' || ex.kind === 'object') {
          const q = node.rotation || [0, 0, 0, 1];
          (ex.kind === 'structure' ? out.structures : out.objects).push({ id: ex.id, type: ex.type ?? null, model: ex.model ?? null, position: [rnd(m[12]), rnd(m[13]), rnd(m[14])], yawDeg: rnd((2 * Math.atan2(q[1], q[3]) * 180) / Math.PI, 3), quaternion: q.map((v) => rnd(v, 5)), scale: rnd(Math.hypot(m[0], m[1], m[2])), meshes: mesh.primitives.length, triangles: tris, bounds: box });
        } else if (ex.kind === 'road') {
          out.roads.push({ id: ex.id ?? null, name: node.name, vertexCount: j.accessors[p0.attributes.POSITION].count, triangles: tris, upFacing: upFacing(p0, m), bounds: box, samples: vsamples(p0.attributes.POSITION, m, 1500) });
        }
      }
    }
    for (const c of node.children || []) visit(c, m, g, depth + 1);
  };
  for (const r of scene.nodes) visit(r, I, null, 0);
  for (const g of Object.values(out.groups)) for (const k of Object.keys(out.totals)) out.totals[k] += g[k];
  out.materials = (j.materials || []).map((m) => ({ name: m.name || '', type: 'glTF material', hasMap: !!m.pbrMetallicRoughness?.baseColorTexture, hasNormalMap: !!m.normalTexture, transparent: m.alphaMode === 'BLEND', alphaTest: m.alphaMode === 'MASK' ? m.alphaCutoff ?? 0.5 : 0, opacity: m.pbrMetallicRoughness?.baseColorFactor?.[3] ?? 1, transmission: m.extensions?.KHR_materials_transmission?.transmissionFactor ?? 0, ior: m.extensions?.KHR_materials_ior?.ior ?? null, doubleSided: !!m.doubleSided }));
  out.sceneBounds = { min: min.map((v) => rnd(v, 3)), max: max.map((v) => rnd(v, 3)) };
  return out;
}

/** Stock three.js GLTFLoader running in Node (no rendering; images are not decoded). */
async function measureWithThreeInNode(glbBytes) {
  const THREE = await import('three');
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const { collectStats } = await import('./viewer/stats.js');
  const saved = { self: globalThis.self, createImageBitmap: globalThis.createImageBitmap };
  // GLTFLoader only needs these two browser globals to build textures; pixels are irrelevant here
  if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
  let images = 0;
  globalThis.createImageBitmap = async () => {
    images++;
    return { width: 4, height: 4, close() {} };
  };
  try {
    const ab = glbBytes.buffer.slice(glbBytes.byteOffset, glbBytes.byteOffset + glbBytes.byteLength);
    const gltf = await new Promise((res, rej) => new GLTFLoader().parse(ab, '', res, (e) => rej(e instanceof Error ? e : new Error(String(e?.message || e)))));
    const stats = collectStats(THREE, gltf.scene);
    stats.source += ' (Node, no rendering)';
    stats.imagesRequested = images;
    return stats;
  } finally {
    if (saved.self === undefined) delete globalThis.self;
    if (saved.createImageBitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = saved.createImageBitmap;
  }
}

function encodePngRgb(pixels, width, height) {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, 'latin1');
    data.copy(b, 8);
    b.writeUInt32BE(crc(b.subarray(4, 8 + data.length)), 8 + data.length);
    return b;
  };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(pixels.buffer, pixels.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Software-rasterised top-down map of scene.glb (no GPU, no browser): baked terrain texture with
 * relief shading, water / road triangles, every scatter instance as a dot, structure footprints.
 * A quick visual plausibility check that works in --no-browser mode.
 */
function renderMapPreview(glb, { heights, W, H, half, size }, outFile, S = 1400) {
  const j = glb.json;
  const img = new Uint8Array(S * S * 3);
  const toPx = (x) => ((x + half) / size) * (S - 1);
  // base: terrain texture (or grey) x hillshade
  let tex = null;
  const tmat = (j.materials || []).find((m) => m.name === 'terrain_baked');
  const ti = tmat?.pbrMetallicRoughness?.baseColorTexture?.index;
  if (ti !== undefined) {
    const im = j.images[j.textures[ti].source];
    const bv = j.bufferViews[im.bufferView];
    if (im.mimeType === 'image/png') tex = decodePng(Buffer.from(glb.bin.buffer, glb.bin.byteOffset + (bv.byteOffset || 0), bv.byteLength));
  }
  const cell = size / (W - 1);
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const gx = Math.min(W - 2, Math.max(1, Math.round((px / (S - 1)) * (W - 1)))),
        gz = Math.min(H - 2, Math.max(1, Math.round((py / (S - 1)) * (H - 1))));
      const i = gz * W + gx;
      const dx = (heights[i + 1] - heights[i - 1]) / (2 * cell),
        dz = (heights[i + W] - heights[i - W]) / (2 * cell);
      const l = 1 / Math.hypot(dx, 1, dz);
      const shade = Math.max(0.25, Math.min(1.5, 0.35 + 0.95 * ((dx * 0.55 + 0.65 + dz * 0.5) * l)));
      let r = 120,
        g = 120,
        b = 120;
      if (tex) {
        const t = (Math.min(tex.height - 1, Math.round((py / (S - 1)) * (tex.height - 1))) * tex.width + Math.min(tex.width - 1, Math.round((px / (S - 1)) * (tex.width - 1)))) * tex.channels;
        r = tex.pixels[t];
        g = tex.pixels[t + 1];
        b = tex.pixels[t + 2];
      }
      const o = (py * S + px) * 3;
      img[o] = Math.min(255, r * shade);
      img[o + 1] = Math.min(255, g * shade);
      img[o + 2] = Math.min(255, b * shade);
    }
  }
  const blend = (px, py, c, a) => {
    if (px < 0 || py < 0 || px >= S || py >= S) return;
    const o = (py * S + px) * 3;
    img[o] += (c[0] - img[o]) * a;
    img[o + 1] += (c[1] - img[o + 1]) * a;
    img[o + 2] += (c[2] - img[o + 2]) * a;
  };
  const tri = (ax, ay, bx, by, cx, cy, c, a) => {
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))),
      x1 = Math.min(S - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))),
      y1 = Math.min(S - 1, Math.ceil(Math.max(ay, by, cy)));
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-12) return;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den,
          v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den;
        if (u >= -1e-3 && v >= -1e-3 && u + v <= 1.001) blend(x, y, c, a);
      }
    }
  };
  const fillMesh = (meshIndex, m, colorOf, alpha, once) => {
    const seen = once ? new Uint8Array(S * S) : null;
    for (const p of j.meshes[meshIndex].primitives) {
      const pos = glb.accessor(p.attributes.POSITION);
      const ind = p.indices !== undefined ? glb.accessor(p.indices) : null;
      const c = colorOf(j.materials[p.material] || {});
      const n = ind ? ind.length : pos.length / 3;
      const P = (k) => {
        const q = (ind ? ind[k] : k) * 3;
        const w = apply4(m, pos[q], pos[q + 1], pos[q + 2]);
        return [toPx(w[0]), toPx(w[2])];
      };
      const put = seen
        ? (x, y, col, a) => {
            if (x < 0 || y < 0 || x >= S || y >= S || seen[y * S + x]) return;
            seen[y * S + x] = 1;
            blend(x, y, col, a);
          }
        : null;
      for (let t = 0; t + 2 < n; t += 3) {
        const A = P(t),
          B = P(t + 1),
          C = P(t + 2);
        if (!put) tri(A[0], A[1], B[0], B[1], C[0], C[1], c, alpha);
        else {
          // overlapping transparent triangles (skirts) must not darken twice
          const x0 = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]))),
            x1 = Math.min(S - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
          const y0 = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]))),
            y1 = Math.min(S - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
          const den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
          if (Math.abs(den) < 1e-12) continue;
          for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
              const u = ((B[1] - C[1]) * (x - C[0]) + (C[0] - B[0]) * (y - C[1])) / den,
                v = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (y - C[1])) / den;
              if (u >= -1e-3 && v >= -1e-3 && u + v <= 1.001) put(x, y, c, alpha);
            }
          }
        }
      }
    }
  };
  const I = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const later = [];
  const counts = { water: 0, roads: 0, scatter: 0, structures: 0, objects: 0 };
  const visit = (idx, pm) => {
    const node = j.nodes[idx];
    const m = mul4(pm, trsMatrix(node));
    const ex = node.extras || {};
    if (node.mesh !== undefined) {
      if (ex.kind === 'water') {
        // only the wet part: skip skirt pixels by testing the surface against the ground
        const prim = j.meshes[node.mesh].primitives[0];
        const pos = glb.accessor(prim.attributes.POSITION);
        const ind = glb.accessor(prim.indices);
        const col = ex.body === 'river' ? [70, 150, 215] : ex.body === 'lake' ? [40, 105, 180] : [25, 80, 150];
        const seen = new Uint8Array(S * S);
        for (let t = 0; t + 2 < ind.length; t += 3) {
          const a = ind[t] * 3,
            b = ind[t + 1] * 3,
            c = ind[t + 2] * 3;
          const ax = toPx(pos[a]),
            ay = toPx(pos[a + 2]),
            bx = toPx(pos[b]),
            by = toPx(pos[b + 2]),
            cx = toPx(pos[c]),
            cy = toPx(pos[c + 2]);
          const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))),
            x1 = Math.min(S - 1, Math.ceil(Math.max(ax, bx, cx)));
          const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))),
            y1 = Math.min(S - 1, Math.ceil(Math.max(ay, by, cy)));
          const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
          if (Math.abs(den) < 1e-12) continue;
          for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
              if (seen[y * S + x]) continue;
              const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den,
                v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den;
              if (u < -1e-3 || v < -1e-3 || u + v > 1.001) continue;
              const wy = u * pos[a + 1] + v * pos[b + 1] + (1 - u - v) * pos[c + 1];
              const gx = Math.min(W - 1, Math.max(0, Math.round((x / (S - 1)) * (W - 1)))),
                gz = Math.min(H - 1, Math.max(0, Math.round((y / (S - 1)) * (H - 1))));
              const depth = wy - heights[gz * W + gx];
              if (depth <= 0) continue;
              seen[y * S + x] = 1;
              blend(x, y, col, Math.min(0.92, 0.55 + depth * 0.12));
            }
          }
        }
        counts.water++;
      } else if (ex.kind === 'road') {
        fillMesh(node.mesh, m, () => (ex.roadKind === 'trail' ? [205, 170, 120] : [225, 215, 190]), 0.95);
        counts.roads++;
      } else if (ex.kind === 'structure' || ex.kind === 'object') later.push([node, m, ex]);
      else if (ex.kind === 'scatter') {
        const inst = node.extensions?.EXT_mesh_gpu_instancing;
        if (inst) {
          const tr = glb.accessor(inst.attributes.TRANSLATION);
          const sc = inst.attributes.SCALE !== undefined ? glb.accessor(inst.attributes.SCALE) : null;
          let radius = 0,
            height = 0;
          for (const p of j.meshes[node.mesh].primitives) {
            const a = j.accessors[p.attributes.POSITION];
            radius = Math.max(radius, a.max[0], -a.min[0], a.max[2], -a.min[2]);
            height = Math.max(height, a.max[1]);
          }
          const tall = height > 2.5;
          const foliage = j.meshes[node.mesh].primitives.some((p) => j.materials[p.material]?.alphaMode === 'MASK');
          const col = /reed|cattail/.test(ex.model) ? [150, 190, 70] : foliage ? (tall ? [22, 62, 30] : [70, 110, 45]) : /trunk|stump|branch/.test(ex.model) ? [95, 65, 40] : [150, 150, 150];
          for (let i = 0; i < tr.length; i += 3) {
            const px = Math.round(toPx(tr[i])),
              py = Math.round(toPx(tr[i + 2]));
            const rpx = Math.min(4, Math.max(0, Math.round((radius * (sc ? sc[i] : 1) * 0.6 * (S - 1)) / size)));
            for (let dy = -rpx; dy <= rpx; dy++) for (let dx = -rpx; dx <= rpx; dx++) if (dx * dx + dy * dy <= rpx * rpx + 0.5) blend(px + dx, py + dy, col, tall ? 0.85 : 0.7);
          }
          counts.scatter += tr.length / 3;
        }
      }
    }
    for (const c of node.children || []) visit(c, m);
  };
  for (const r of j.scenes[j.scene || 0].nodes) visit(r, I);
  for (const [node, m, ex] of later) {
    if (ex.kind === 'structure') {
      fillMesh(node.mesh, m, (mat) => (/roof/.test(mat.name || '') ? [150, 40, 30] : /stone/.test(mat.name || '') ? [235, 235, 235] : [120, 30, 25]), 1);
      // front marker: local +Z
      const o = apply4(m, 0, 0, 0),
        f = apply4(m, 0, 0, 9);
      for (let t = 0; t <= 1; t += 0.02) {
        const px = Math.round(toPx(o[0] + (f[0] - o[0]) * t)),
          py = Math.round(toPx(o[2] + (f[2] - o[2]) * t));
        blend(px, py, [255, 235, 0], 1);
      }
      // locator ring so small buildings are findable on large maps
      const cx = toPx(o[0]),
        cy = toPx(o[2]);
      for (let a = 0; a < 360; a += 1) for (const rr of [16, 17]) blend(Math.round(cx + Math.cos((a * Math.PI) / 180) * rr), Math.round(cy + Math.sin((a * Math.PI) / 180) * rr), [255, 60, 40], 1);
      counts.structures++;
    } else {
      const o = apply4(m, 0, 0, 0);
      const cx = Math.round(toPx(o[0])),
        cy = Math.round(toPx(o[2]));
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) blend(cx + dx, cy + dy, [255, 215, 0], 1);
      counts.objects++;
    }
  }
  writeFileSync(outFile, encodePngRgb(img, S, S));
  return counts;
}

// ---------------------------------------------------------------------------------------------
// static server for the viewer page
// ---------------------------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.raw': 'application/octet-stream', '.md': 'text/markdown' };
function startServer(port = 0) {
  const mounts = [
    ['/three/', join(ROOT, 'node_modules', 'three')],
    ['/export/', exportDir],
    ['/', join(ROOT, 'tools', 'viewer')],
  ];
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let path = decodeURIComponent(url.pathname);
      if (path === '/') path = '/index.html';
      for (const [prefix, dir] of mounts) {
        if (!path.startsWith(prefix)) continue;
        const fp = normalize(join(dir, path.slice(prefix.length)));
        if (fp !== dir && !fp.startsWith(dir + sep)) break;
        if (!existsSync(fp) || !statSync(fp).isFile()) break;
        res.writeHead(200, { 'Content-Type': MIME[extname(fp).toLowerCase()] || 'application/octet-stream', 'Content-Length': statSync(fp).size, 'Cache-Control': 'no-store' });
        createReadStream(fp).pipe(res);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found: ' + path);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String(e.message));
    }
  });
  return new Promise((ok, bad) => {
    server.once('error', bad);
    server.listen(port, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

// ---------------------------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------------------------
const checks = [];
function check(name, pass, detail = {}) {
  checks.push({ name, pass: !!pass, ...detail });
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail.summary ? ' - ' + detail.summary : ''}`);
  return !!pass;
}
const readJson = (name) => JSON.parse(readFileSync(join(exportDir, name), 'utf8'));

async function main() {
  const report = { exportDir, started: new Date().toISOString(), mode: flags['no-browser'] ? 'no-browser' : 'browser', checks, measurements: {} };
  console.log(`Verifying ${exportDir}`);

  // ---- files ---------------------------------------------------------------------------------
  const required = ['scene.glb', 'heightmap_16bit.png', 'heightmap_float32.raw', 'heightmap.json', 'masks.json', 'placements.json', 'environment.json', 'export_report.json', 'README_EXPORT.md'];
  const missing = required.filter((f) => !existsSync(join(exportDir, f)));
  if (!check('export folder contains all required files', missing.length === 0, { summary: missing.length ? 'missing: ' + missing.join(', ') : `${required.length} files`, missing })) return finish(report);
  const hm = readJson('heightmap.json');
  const masksDoc = readJson('masks.json');
  const placements = readJson('placements.json');
  const environment = readJson('environment.json');
  const exportReport = readJson('export_report.json');
  const readme = readFileSync(join(exportDir, 'README_EXPORT.md'), 'utf8');
  const glbBytes = readFileSync(join(exportDir, 'scene.glb'));

  // ---- 1. Khronos validator -----------------------------------------------------------------
  {
    const validator = require('gltf-validator');
    const result = await validator.validateBytes(new Uint8Array(glbBytes.buffer, glbBytes.byteOffset, glbBytes.byteLength), { uri: 'scene.glb', format: 'glb', maxIssues: 0, writeTimestamp: false });
    const byCode = {};
    for (const m of result.issues.messages) {
      const e = (byCode[m.code] ||= { severity: ['error', 'warning', 'info', 'hint'][m.severity], count: 0, example: m.message, pointer: m.pointer });
      e.count++;
    }
    report.validator = { version: validator.version(), numErrors: result.issues.numErrors, numWarnings: result.issues.numWarnings, numInfos: result.issues.numInfos, numHints: result.issues.numHints, issues: byCode, info: { ...result.info, resources: undefined, resourceCount: result.info.resources?.length } };
    check('Khronos glTF validator reports no errors', result.issues.numErrors === 0, {
      summary: `${result.issues.numErrors} errors, ${result.issues.numWarnings} warnings, ${result.issues.numInfos} infos, ${result.issues.numHints} hints (validator ${validator.version()})`,
      errors: Object.entries(byCode)
        .filter(([, e]) => e.severity === 'error')
        .map(([code, e]) => ({ code, ...e })),
    });
    for (const [code, e] of Object.entries(byCode)) if (e.severity !== 'error') console.log(`        ${e.severity} ${code} x${e.count}: ${e.example}`);
  }

  // ---- heightmap ------------------------------------------------------------------------------
  const W = hm.width,
    H = hm.height;
  const rawBuf = readFileSync(join(exportDir, 'heightmap_float32.raw'));
  check('heightmap_float32.raw has width*height float32 samples', rawBuf.length === W * H * 4, { summary: `${rawBuf.length} bytes for ${W}x${H}` });
  const heights = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) heights[i] = rawBuf.readFloatLE(i * 4);
  let rmin = Infinity,
    rmax = -Infinity,
    finite = true;
  for (let i = 0; i < heights.length; i++) {
    const v = heights[i];
    if (!Number.isFinite(v)) finite = false;
    if (v < rmin) rmin = v;
    if (v > rmax) rmax = v;
  }
  const range = hm.maxHeight - hm.minHeight;
  check('raw heights are finite and span [minHeight, maxHeight] of heightmap.json', finite && Math.abs(rmin - hm.minHeight) < 1e-3 + 1e-6 * Math.abs(rmin) && Math.abs(rmax - hm.maxHeight) < 1e-3 + 1e-6 * Math.abs(rmax), { summary: `raw ${rmin.toFixed(3)} .. ${rmax.toFixed(3)} m, json ${hm.minHeight.toFixed(3)} .. ${hm.maxHeight.toFixed(3)} m` });
  check('heightmap.json is self-consistent (cell size, origin, axis)', Math.abs(hm.cellMeters - hm.sizeMeters / (W - 1)) < 1e-9 && W === H && hm.origin === 'centre' && hm.sampleConvention === 'vertex-centred' && hm.heightAt0 === hm.minHeight && hm.heightAt65535 === hm.maxHeight, { summary: `${W}x${H}, ${hm.sizeMeters} m, cell ${hm.cellMeters} m` });
  const png = decodePng(readFileSync(join(exportDir, 'heightmap_16bit.png')));
  const step = range / 65535;
  let pngErr = 0;
  if (png.width === W && png.height === H && png.bitDepth === 16 && png.channels === 1) {
    for (let i = 0; i < W * H; i++) {
      const e = Math.abs(hm.heightAt0 + (png.pixels[i] / 65535) * (hm.heightAt65535 - hm.heightAt0) - heights[i]);
      if (e > pngErr) pngErr = e;
    }
  } else pngErr = Infinity;
  check('heightmap_16bit.png reproduces the raw heights within one quantisation step', pngErr <= step * 1.0001 + 1e-4, { summary: `max error ${pngErr.toExponential(3)} m, step ${step.toExponential(3)} m (${png.width}x${png.height}, ${png.bitDepth}-bit, ${png.channels} channel)`, maxError: pngErr, step });
  report.measurements.heightmap = { width: W, height: H, min: rmin, max: rmax, pngMaxError: pngErr, quantisationStep: step };
  const half = hm.sizeMeters / 2;
  const cell = hm.cellMeters;
  const terrainAt = (x, z) => {
    let gx = (x + half) / cell,
      gz = (z + half) / cell;
    gx = Math.max(0, Math.min(W - 1, gx));
    gz = Math.max(0, Math.min(H - 1, gz));
    const ix = Math.min(W - 2, Math.floor(gx)),
      iz = Math.min(H - 2, Math.floor(gz));
    const fx = gx - ix,
      fz = gz - iz;
    const i = iz * W + ix;
    return heights[i] * (1 - fx) * (1 - fz) + heights[i + 1] * fx * (1 - fz) + heights[i + W] * (1 - fx) * fz + heights[i + W + 1] * fx * fz;
  };

  // ---- masks ----------------------------------------------------------------------------------
  const masks = {};
  {
    const listed = Object.keys(masksDoc.masks || {});
    const onDisk = readdirSync(exportDir).filter((f) => /^mask_.*\.png$/.test(f));
    const bad = [];
    for (const name of listed) {
      if (!existsSync(join(exportDir, name))) {
        bad.push(`${name}: file missing`);
        continue;
      }
      try {
        const m = decodePng(readFileSync(join(exportDir, name)));
        if (m.width !== W || m.height !== H) bad.push(`${name}: ${m.width}x${m.height}`);
        else if (m.bitDepth !== 8) bad.push(`${name}: ${m.bitDepth}-bit`);
        else if (m.channels !== masksDoc.masks[name].channels) bad.push(`${name}: ${m.channels} channels, masks.json says ${masksDoc.masks[name].channels}`);
        masks[name] = m;
      } catch (e) {
        bad.push(`${name}: ${e.message}`);
      }
    }
    const undocumented = onDisk.filter((f) => !listed.includes(f));
    check('every mask decodes at heightmap resolution and is documented in masks.json', bad.length === 0 && undocumented.length === 0 && listed.length > 0, { summary: `${listed.length} masks${bad.length ? '; ' + bad.join('; ') : ''}${undocumented.length ? '; undocumented: ' + undocumented.join(', ') : ''}`, bad, undocumented });
    const expected = ['mask_water_depth.png', 'mask_water_type.png', 'mask_flow.png', 'mask_biome_index.png', 'mask_moisture.png', 'mask_road.png', 'mask_sediment.png', 'mask_exclusion.png', ...['grass', 'forest', 'scree', 'sand', 'pebbles', 'mud', 'snow', 'path', 'rock'].map((n) => `mask_material_${n}.png`)];
    const absent = expected.filter((n) => !masks[n]);
    check('all expected masks are present (water, flow, 9 materials, biome, moisture, road, sediment, exclusion)', absent.length === 0, { summary: absent.length ? 'missing ' + absent.join(', ') : `${expected.length} masks`, absent });
    if (absent.length) return finish(report);
  }
  const wtype = masks['mask_water_type.png'].pixels;
  const wdepth = masks['mask_water_depth.png'].pixels;
  {
    let badValues = 0,
      signMismatch = 0,
      wet = 0;
    const hist = { 0: 0, 85: 0, 170: 0, 255: 0 };
    for (let i = 0; i < W * H; i++) {
      const t = wtype[i];
      if (hist[t] === undefined) badValues++;
      else hist[t]++;
      if (t !== 0) wet++;
      if ((t !== 0) !== (wdepth[i] > 0)) signMismatch++;
    }
    check('water type mask uses only 0/85/170/255 and agrees with the depth mask (wet <=> depth > 0)', badValues === 0 && signMismatch === 0, { summary: `dry ${hist[0]}, river ${hist[85]}, lake ${hist[170]}, ocean ${hist[255]}; ${badValues} invalid values, ${signMismatch} sign mismatches`, histogram: hist });
    report.measurements.water = { wetCells: wet, histogram: hist, depthScale: masksDoc.masks['mask_water_depth.png'].depthScale };
    check('wet cell count matches export_report.json', wet === exportReport.counts.wetCells, { summary: `${wet} vs ${exportReport.counts.wetCells}` });
    let maxDev = 0;
    const mm = ['grass', 'forest', 'scree', 'sand', 'pebbles', 'mud', 'snow', 'path', 'rock'].map((n) => masks[`mask_material_${n}.png`].pixels);
    for (let i = 0; i < W * H; i++) {
      let s = 0;
      for (let k = 0; k < 9; k++) s += mm[k][i];
      const d = Math.abs(s - 255);
      if (d > maxDev) maxDev = d;
    }
    check('material masks sum to 255 per pixel (within rounding)', maxDev <= 4, { summary: `max deviation ${maxDev}`, maxDeviation: maxDev });
    const legend = masksDoc.masks['mask_biome_index.png'].legend || [];
    let maxBiome = 0;
    const bp = masks['mask_biome_index.png'].pixels;
    for (let i = 0; i < W * H; i++) if (bp[i] > maxBiome) maxBiome = bp[i];
    check('biome index mask only uses indices from its legend', legend.length > 0 && maxBiome < legend.length, { summary: `max index ${maxBiome}, legend has ${legend.length} entries` });
  }

  // ---- 2. scene measurements ------------------------------------------------------------------
  const glb = readGlb(glbBytes);
  {
    const j = glb.json;
    const problems = [...glb.problems];
    (j.bufferViews || []).forEach((bv, i) => {
      if ((bv.byteOffset || 0) % 4) problems.push(`bufferView ${i} is not 4-byte aligned`);
      if ((bv.byteOffset || 0) + bv.byteLength > glb.binLen) problems.push(`bufferView ${i} exceeds the BIN chunk`);
    });
    (j.accessors || []).forEach((a, i) => {
      const bv = j.bufferViews[a.bufferView];
      const size = CTYPE[a.componentType][0].BYTES_PER_ELEMENT * COMPS[a.type];
      const stride = bv.byteStride || size;
      if ((a.byteOffset || 0) + (a.count - 1) * stride + size > bv.byteLength) problems.push(`accessor ${i} exceeds its bufferView`);
    });
    check('GLB container is structurally sound (chunk lengths, 4-byte alignment, accessors inside bufferViews)', problems.length === 0, { summary: `${j.accessors?.length || 0} accessors, ${j.bufferViews?.length || 0} bufferViews, ${(glbBytes.length / 1048576).toFixed(1)} MB${problems.length ? '; ' + problems.slice(0, 4).join('; ') : ''}`, problems: problems.slice(0, 50) });
    const used = j.extensionsUsed || [],
      req = j.extensionsRequired || [];
    const hasInst = (j.nodes || []).some((n) => n.extensions?.EXT_mesh_gpu_instancing);
    check('extensions are declared consistently (required is a subset of used; instancing required when present)', req.every((e) => used.includes(e)) && (!hasInst || req.includes('EXT_mesh_gpu_instancing')), { summary: `used [${used.join(', ')}], required [${req.join(', ')}]` });
    const ex = j.scenes[j.scene || 0].extras || {};
    check('scene.extras carries generator / units / seed / terrainSize / waterLevels', ex.generator === 'Terraforge' && ex.units === 'm' && ex.terrainSize === hm.sizeMeters && 'seed' in ex && ex.waterLevels !== undefined, { summary: JSON.stringify(ex).slice(0, 160) });
  }
  const readerStats = measureWithReader(glb);
  let threeNode = null;
  try {
    threeNode = await measureWithThreeInNode(glbBytes);
    check('stock three.js GLTFLoader parses scene.glb (Node, no rendering)', true, { summary: `${threeNode.totals.meshes} meshes, ${threeNode.totals.instances} instances, ${threeNode.imagesRequested} images requested` });
  } catch (e) {
    check('stock three.js GLTFLoader parses scene.glb (Node, no rendering)', false, { summary: e.message });
  }

  // ---- browser: stock GLTFLoader + WebGL in headless Chromium -----------------------------------
  let browserStats = null;
  let browser = null,
    page = null,
    srv = null;
  if (!flags['no-browser']) {
    try {
      srv = await startServer(flags.port ? +flags.port : 0);
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--enable-gpu', '--ignore-gpu-blocklist'] });
      page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
      const consoleErrors = [];
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });
      page.on('pageerror', (e) => consoleErrors.push(String(e.message)));
      page.setDefaultTimeout(600000);
      await page.goto(`${srv.url}/index.html?glb=/export/scene.glb&env=/export/environment.json&hud=0&budget=${drawBudget}`);
      // the module script defines window.viewer as soon as it runs; a broken import never does
      try {
        await page.waitForFunction(() => !!window.viewer, null, { timeout: 60000 });
      } catch {
        throw new Error('viewer script did not start' + (consoleErrors.length ? ': ' + consoleErrors.slice(0, 3).join(' | ') : ''));
      }
      const err = await page.evaluate(() => window.viewer.ready.then(() => null, (e) => String((e && (e.stack || e.message)) || e)));
      if (err) throw new Error('viewer failed: ' + err);
      browserStats = await page.evaluate(() => window.viewer.stats);
      report.viewer = { gpu: browserStats.gpu, displayThinning: browserStats.displayThinning, gltf: await page.evaluate(() => window.viewer.gltfInfo), consoleErrors };
      check('scene.glb loads in the standalone three.js viewer (headless Chromium, stock GLTFLoader)', true, { summary: `GPU ${browserStats.gpu}; ${browserStats.totals.meshes} meshes, ${browserStats.totals.instances} instances${browserStats.displayThinning > 1 ? `; display thinned 1/${browserStats.displayThinning}` : ''}` });
      check('viewer page logged no errors', consoleErrors.length === 0, { summary: consoleErrors.slice(0, 3).join(' | ') || 'clean console', consoleErrors });
    } catch (e) {
      check('scene.glb loads in the standalone three.js viewer (headless Chromium, stock GLTFLoader)', false, { summary: e.message });
    }
  } else console.log('        (browser stage skipped: --no-browser)');

  const M = browserStats || threeNode || readerStats;
  report.measurementSource = M.source;
  const slim = (s) => s && { ...s, terrain: s.terrain && { ...s.terrain, samples: undefined, sampleCount: s.terrain.samples.length }, water: s.water.map((w) => ({ ...w, samples: undefined })), scatter: s.scatter.map((w) => ({ ...w, samples: undefined })), roads: s.roads.map((w) => ({ ...w, samples: undefined })) };
  report.measurements.scene = slim(M);
  report.measurements.reader = { groups: readerStats.groups, totals: readerStats.totals, sceneBounds: readerStats.sceneBounds };
  if (threeNode) report.measurements.threeNode = { groups: threeNode.groups, totals: threeNode.totals, sceneBounds: threeNode.sceneBounds };
  console.log(`        measurements from: ${M.source}`);

  // loaders agree with the file
  for (const [label, s] of [
    ['three.js (Node)', threeNode],
    ['three.js (Chromium)', browserStats],
  ]) {
    if (!s) continue;
    const diffs = [];
    for (const g of new Set([...Object.keys(readerStats.groups), ...Object.keys(s.groups)])) {
      const a = readerStats.groups[g],
        b = s.groups[g];
      if (!a || !b) diffs.push(`${g}: only in ${a ? 'file' : 'loader'}`);
      else for (const k of ['meshes', 'instances', 'triangles', 'instancedTriangles']) if (a[k] !== b[k]) diffs.push(`${g}.${k}: file ${a[k]} vs loader ${b[k]}`);
    }
    check(`${label} sees the same groups, meshes, triangles and instances as the raw file`, diffs.length === 0, { summary: diffs.length ? diffs.slice(0, 4).join('; ') : Object.entries(s.groups).map(([g, v]) => `${g}: ${v.meshes} meshes / ${v.triangles} tris${v.instances ? ` / ${v.instances} inst` : ''}`).join(', '), diffs });
  }

  // ---- 3. terrain -----------------------------------------------------------------------------
  const inc = exportReport.options?.include || {};
  if (inc.terrain !== false) {
    const T = M.terrain;
    if (!check('terrain mesh exists', !!T, { summary: T ? `${T.vertexCount} vertices, ${T.triangles} triangles` : 'no node with extras.kind = terrain' })) return finish(report, browser, srv);
    const meshCell = T.extras?.cellMeters || cell;
    const ex = [T.bounds.max[0] - T.bounds.min[0], T.bounds.max[2] - T.bounds.min[2]];
    check('terrain XZ extent equals sizeMeters (within one cell) and is centred on the origin', Math.abs(ex[0] - hm.sizeMeters) <= meshCell && Math.abs(ex[1] - hm.sizeMeters) <= meshCell && Math.abs(T.bounds.min[0] + half) <= meshCell && Math.abs(T.bounds.min[2] + half) <= meshCell, { summary: `${ex[0].toFixed(2)} x ${ex[1].toFixed(2)} m vs ${hm.sizeMeters} m`, extent: ex });
    const tol = 0.01 + range * 1e-4;
    check('terrain Y range lies within [minHeight, maxHeight]', T.bounds.min[1] >= hm.minHeight - tol && T.bounds.max[1] <= hm.maxHeight + tol, { summary: `${T.bounds.min[1].toFixed(2)} .. ${T.bounds.max[1].toFixed(2)} m vs ${hm.minHeight.toFixed(2)} .. ${hm.maxHeight.toFixed(2)} m` });
    let maxErr = 0,
      maxErrPng = 0;
    const pngAt = (x, z) => {
      const ix = Math.round((x + half) / cell),
        iz = Math.round((z + half) / cell);
      return hm.heightAt0 + (png.pixels[Math.max(0, Math.min(H - 1, iz)) * W + Math.max(0, Math.min(W - 1, ix))] / 65535) * (hm.heightAt65535 - hm.heightAt0);
    };
    let offGrid = 0;
    for (const [x, y, z] of T.samples) {
      maxErr = Math.max(maxErr, Math.abs(y - terrainAt(x, z)));
      const gx = (x + half) / cell,
        gz = (z + half) / cell;
      if (Math.abs(gx - Math.round(gx)) < 1e-3 && Math.abs(gz - Math.round(gz)) < 1e-3) maxErrPng = Math.max(maxErrPng, Math.abs(y - pngAt(x, z)));
      else offGrid++;
    }
    check('terrain mesh vertices match the heightmap (bilinear raw within 2 cm; 16-bit PNG within one step)', maxErr <= 0.02 && maxErrPng <= step * 1.0001 + 2e-3, { summary: `${T.samples.length} sampled vertices: max |dy| raw ${maxErr.toExponential(2)} m, png ${maxErrPng.toExponential(2)} m (${offGrid} off-grid)`, maxErrorRaw: maxErr, maxErrorPng: maxErrPng });
    check('terrain has normals, uvs and a baked base-colour texture (material terrain_baked)', T.hasNormals && T.hasUv && T.material === 'terrain_baked' && T.materialHasMap, { summary: `material "${T.material}", map ${T.materialHasMap}, normals ${T.hasNormals}, uv ${T.hasUv}` });
    const side = Math.round(Math.sqrt(T.vertexCount));
    check('terrain is a regular grid of counter-clockwise (up-facing) triangles', side * side === T.vertexCount && T.triangles === 2 * (side - 1) * (side - 1) && T.upFacing === 1, { summary: `${side} x ${side} vertices, ${T.triangles} triangles, ${(T.upFacing * 100).toFixed(1)} % face up` });
  }

  // ---- structures -----------------------------------------------------------------------------
  {
    const want = (placements.structures || []).filter((s) => s.inGlb);
    const bad = [];
    let maxD = 0,
      maxYaw = 0,
      maxGround = 0;
    for (const s of want) {
      const n = M.structures.find((q) => q.id === s.id);
      if (!n) {
        bad.push(`${s.id}: no node`);
        continue;
      }
      const d = Math.hypot(n.position[0] - s.x, n.position[1] - s.y, n.position[2] - s.z);
      let dyaw = Math.abs(n.yawDeg - s.rotDeg) % 360;
      if (dyaw > 180) dyaw = 360 - dyaw;
      maxD = Math.max(maxD, d);
      maxYaw = Math.max(maxYaw, dyaw);
      const g = Math.abs(n.position[1] - terrainAt(s.x, s.z));
      maxGround = Math.max(maxGround, g);
      if (d > 0.01) bad.push(`${s.id}: ${d.toFixed(3)} m from its placement`);
      if (dyaw > 0.05) bad.push(`${s.id}: yaw differs by ${dyaw.toFixed(3)} deg`);
      if (s.type !== 'model' && g > 0.75) bad.push(`${s.id}: floor ${g.toFixed(2)} m from the terrain surface`);
    }
    check('every structure in placements.json has a node at the same position (+-1 cm) and yaw, standing on the terrain', bad.length === 0 && M.structures.length === want.length, { summary: `${want.length} structures; max offset ${maxD.toExponential(2)} m, max yaw error ${maxYaw.toExponential(2)} deg, max |y - ground| ${maxGround.toFixed(3)} m${bad.length ? '; ' + bad.slice(0, 3).join('; ') : ''}`, bad });
    // upright + right size: a parametric building rises `height` above its floor and its stone
    // plinth reaches 3 m below it (so it stays grounded on slopes)
    const badUp = [];
    for (const s of want.filter((q) => q.type !== 'model' && q.height)) {
      const n = M.structures.find((q) => q.id === s.id);
      if (!n) continue;
      const top = n.bounds.max[1] - n.position[1],
        bottom = n.position[1] - n.bounds.min[1];
      const tilt = Math.hypot(n.quaternion[0], n.quaternion[2]);
      if (Math.abs(top - s.height * (s.scale || 1)) > 0.6 || Math.abs(bottom - 3 * (s.scale || 1)) > 0.3 || tilt > 1e-4) badUp.push(`${s.id}: top +${top.toFixed(2)} m (expected ${s.height}), bottom -${bottom.toFixed(2)} m, tilt ${tilt.toExponential(1)}`);
    }
    check('parametric structures are upright with the documented height (roof up, plinth 3 m into the ground)', badUp.length === 0, { summary: badUp.join('; ') || `${want.filter((q) => q.type !== 'model').length} buildings` });
    const wantO = (placements.objects || []).filter((s) => s.inGlb);
    const badO = [];
    for (const o of wantO) {
      const n = M.objects.find((q) => q.id === o.id);
      if (!n) badO.push(`${o.id}: no node`);
      else if (Math.hypot(n.position[0] - o.x, n.position[1] - o.y, n.position[2] - o.z) > 0.01) badO.push(`${o.id}: displaced`);
    }
    check('every object in placements.json has a node at the same position (+-1 cm)', badO.length === 0 && M.objects.length === wantO.length, { summary: `${wantO.length} objects${badO.length ? '; ' + badO.join('; ') : ''}`, bad: badO });
  }

  // ---- scatter --------------------------------------------------------------------------------
  {
    const bad = [];
    let nodesChecked = 0,
      total = 0,
      rowsTotal = 0,
      skipped = 0;
    const layerRules = new Map();
    for (const L of placements.scatter.layers) {
      layerRules.set(L.biome + '/' + L.layer, L.rules || {});
      const perModel = new Array(L.models.length).fill(0);
      for (const r of L.instances) perModel[r[5]]++;
      rowsTotal += L.instances.length;
      L.models.forEach((model, v) => {
        if (perModel[v] !== L.counts[v]) bad.push(`${L.biome}/${L.layer}/${model}: counts[] says ${L.counts[v]}, instances list has ${perModel[v]}`);
        const node = M.scatter.find((n) => n.biome === L.biome && n.layer === L.layer && n.model === model);
        if (!L.glbInstanced[v]) {
          skipped += perModel[v];
          if (node) bad.push(`${L.biome}/${L.layer}/${model}: instanced in the GLB but flagged as not instanced`);
          return;
        }
        if (!node) {
          if (perModel[v] > 0) bad.push(`${L.biome}/${L.layer}/${model}: ${perModel[v]} placements but no instanced node`);
          return;
        }
        nodesChecked++;
        total += node.count;
        if (node.count !== perModel[v]) bad.push(`${L.biome}/${L.layer}/${model}: GLB ${node.count} vs placements ${perModel[v]}`);
        if (node.declaredCount !== null && node.declaredCount !== node.count) bad.push(`${L.biome}/${L.layer}/${model}: extras.count ${node.declaredCount} vs ${node.count}`);
      });
    }
    for (const n of M.scatter) if (!placements.scatter.layers.some((L) => L.biome === n.biome && L.layer === n.layer && L.models.includes(n.model))) bad.push(`${n.biome}/${n.layer}/${n.model}: node without placements`);
    check('instance counts in scene.glb equal the counts in placements.json (per biome / layer / model)', bad.length === 0 && total === exportReport.counts.scatterInstancesInGlb && rowsTotal === placements.scatter.exportedInstances, { summary: `${total} instances in ${nodesChecked} instanced nodes; placements list ${rowsTotal}${skipped ? `; ${skipped} placements of models without a mesh (see export_report.skippedModels)` : ''}${bad.length ? '; ' + bad.slice(0, 3).join('; ') : ''}`, bad: bad.slice(0, 50) });
    // on the ground + upright
    let worst = 0,
      worstAt = null,
      n = 0,
      off = 0,
      minUp = 1,
      badQ = 0;
    for (const node of M.scatter) {
      const rules = layerRules.get(node.biome + '/' + node.layer) || {};
      minUp = Math.min(minUp, node.minUpY ?? 1);
      for (const [x, y, z, sc] of node.samples) {
        const g = terrainAt(x, z);
        const allow = 0.6 + (rules.sink ?? 0) * sc + (rules.sinkSlope ?? 0) * sc * 2;
        const d = Math.abs(y - g);
        n++;
        if (d > allow) off++;
        if (d > worst) {
          worst = d;
          worstAt = { node: `${node.biome}/${node.layer}/${node.model}`, x, y, z, ground: rnd(g, 3), allowed: rnd(allow, 3) };
        }
      }
    }
    // quaternion lengths are checked on every instance straight from the file
    for (const node of readerStats.scatter) badQ += node.nonUnitQuaternions || 0;
    check('sampled instances sit on the terrain (|y - ground| < 0.6 m + layer sink)', off === 0, { summary: `${n} samples, ${off} off the ground, max |dy| ${worst.toFixed(3)} m`, worst: worstAt });
    check('instances are upright (instance +Y within 60 deg of world up) with unit quaternions', minUp > 0.5 && badQ === 0, { summary: `min up.y ${minUp.toFixed(3)}${badQ ? `, ${badQ} non-unit quaternions` : ''}` });
    const floating = M.scatter.filter((s) => s.meshMinY > 0.75);
    check('instanced model meshes have their base at the origin (no model floats above its placement point)', floating.length === 0, { summary: floating.length ? floating.slice(0, 4).map((s) => `${s.model}: min y ${s.meshMinY}`).join(', ') : `${M.scatter.length} instanced nodes` });
    report.measurements.scatter = { nodes: M.scatter.length, instances: total, placements: rowsTotal, samplesChecked: n, maxGroundError: worst, minUpY: minUp };
  }

  // ---- water ----------------------------------------------------------------------------------
  if (inc.water !== false) {
    const wetCells = report.measurements.water.wetCells;
    check('water meshes exist exactly when the masks contain water', M.water.length > 0 === wetCells > 0 && M.water.length === exportReport.counts.waterMeshes, { summary: `${M.water.length} meshes, ${wetCells} wet cells` });
    const typeOf = { river: 85, lake: 170, ocean: 255 };
    let areaSum = 0;
    for (const w of M.water) {
      areaSum += w.areaXZ;
      let wetV = 0,
        skirt = 0,
        below = 0,
        skirtAbove = 0,
        offGrid = 0,
        typeMatch = 0,
        notLevel = 0,
        maxDepth = 0;
      for (const [x, y, z] of w.samples) {
        const gx = (x + half) / cell,
          gz = (z + half) / cell;
        const ix = Math.round(gx),
          iz = Math.round(gz);
        if (Math.abs(gx - ix) > 2e-3 || Math.abs(gz - iz) > 2e-3 || ix < 0 || iz < 0 || ix >= W || iz >= H) {
          offGrid++;
          continue;
        }
        const i = iz * W + ix;
        const g = heights[i];
        if (wtype[i] !== 0) {
          wetV++;
          if (y < g - 2e-3) below++;
          if (wtype[i] === typeOf[w.body]) typeMatch++;
          maxDepth = Math.max(maxDepth, y - g);
        } else {
          skirt++;
          if (y > g + 0.05) skirtAbove++;
        }
        // still-water bodies are level; only vertices shared with an inflowing river may differ
        if (w.level !== null && w.body !== 'river' && wtype[i] === typeOf[w.body] && Math.abs(y - w.level) > 2e-3) notLevel++;
      }
      const ok = w.upFacing === 1 && wetV > 0 && below === 0 && skirtAbove === 0 && offGrid === 0 && typeMatch >= wetV * 0.9 && notLevel === 0 && w.hasFlowAttribute && (w.transmission > 0 || w.transparent);
      check(`water mesh ${w.name}: wet vertices at/above the bed, shore skirt at/below the ground, agrees with the masks`, ok, {
        summary: `${w.samples.length} sampled vertices: ${wetV} wet (${below} below the bed, ${typeMatch} on ${w.body} cells, max depth ${maxDepth.toFixed(2)} m), ${skirt} skirt (${skirtAbove} above ground), ${offGrid} off-grid${w.body !== 'river' ? `, ${notLevel} ${w.body} vertices off level ${rnd(w.level, 3)}` : ''}; ${(w.upFacing * 100).toFixed(1)} % of triangles face up; flow attr ${w.hasFlowAttribute} (max ${w.maxFlow} m/s), transmission ${w.transmission}`,
      });
    }
    if (wetCells > 0) {
      const wetArea = wetCells * cell * cell;
      const ratio = areaSum / wetArea;
      check('water meshes cover the wet area of the masks', ratio > 0.8 && ratio < 2.2, { summary: `mesh area ${areaSum.toFixed(0)} m2 vs wet cells ${wetArea.toFixed(0)} m2 (ratio ${ratio.toFixed(3)}; skirts extend one cell past the waterline)`, ratio });
      report.measurements.water.meshAreaM2 = areaSum;
      report.measurements.water.wetAreaM2 = wetArea;
    }
    const lakes = placements.lakes || [];
    const lakeBad = lakes.filter((l) => l.wetCells > 0 && !M.water.some((w) => w.body === 'lake' && w.id === l.id && Math.abs(w.level - l.level) < 1e-3));
    check('every flooded lake in placements.json has a water mesh at its level', lakeBad.length === 0, { summary: `${lakes.length} lakes${lakeBad.length ? '; missing: ' + lakeBad.map((l) => l.id).join(', ') : ''}` });
    const sea = placements.sea;
    if (sea?.enabled && sea.wetCells > 0) check('the sea has a water mesh at sea level', M.water.some((w) => w.body === 'ocean' && Math.abs(w.level - sea.level) < 1e-3), { summary: `sea level ${sea.level} m` });
  }

  // ---- roads ----------------------------------------------------------------------------------
  {
    const want = (placements.roads || []).filter((r) => r.inGlb);
    // the ribbon is draped 3 cm above the higher of the bilinear heightmap and the exported terrain
    // triangles (regular grid of every `stride`-th sample, quads split along (i+1,j)-(i,j+1))
    const stride = M.terrain?.extras?.heightfieldStride || exportReport.scene?.terrain?.heightfieldStride || 1;
    const n = (W - 1) / stride + 1;
    const cm = cell * stride;
    const hAt = (i, j) => heights[j * stride * W + i * stride];
    const meshAt = (x, z) => {
      const gx = Math.max(0, Math.min(n - 1, (x + half) / cm)),
        gz = Math.max(0, Math.min(n - 1, (z + half) / cm));
      const i = Math.min(n - 2, Math.floor(gx)),
        j = Math.min(n - 2, Math.floor(gz));
      const fx = gx - i,
        fz = gz - j;
      const h00 = hAt(i, j),
        h10 = hAt(i + 1, j),
        h01 = hAt(i, j + 1),
        h11 = hAt(i + 1, j + 1);
      return fx + fz <= 1 ? h00 + (h10 - h00) * fx + (h01 - h00) * fz : h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
    };
    let minAbove = Infinity,
      maxAbove = -Infinity,
      maxDev = 0;
    for (const r of M.roads) {
      for (const [x, y, z] of r.samples) {
        const bil = terrainAt(x, z);
        const d = y - bil;
        if (d < minAbove) minAbove = d;
        if (d > maxAbove) maxAbove = d;
        maxDev = Math.max(maxDev, Math.abs(y - (Math.max(bil, meshAt(x, z)) + 0.03)));
      }
    }
    check('road ribbons exist for every road and are draped 3 cm above the terrain surface', M.roads.length === want.length && M.roads.every((r) => r.upFacing > 0.99) && (M.roads.length === 0 || (minAbove >= 0.03 - 5e-3 && maxDev <= 5e-3)), { summary: M.roads.length ? `${M.roads.length} ribbons, ${minAbove.toFixed(3)} .. ${maxAbove.toFixed(3)} m above the bilinear heightmap, max deviation from (terrain surface + 3 cm) ${maxDev.toExponential(2)} m (terrain mesh stride ${stride})` : `${want.length} roads` });
  }

  // ---- materials ------------------------------------------------------------------------------
  {
    const mats = M.materials;
    const untexturedOk = (m) => m.name.startsWith('water_') || m.name === 'structure_glass';
    const flat = mats.filter((m) => !m.hasMap && !untexturedOk(m));
    const missingAssets = exportReport.missingAssets?.length || 0;
    check('materials carry base-colour textures where expected', flat.length === 0 || missingAssets > 0, { summary: `${mats.length} materials, ${mats.filter((m) => m.hasMap).length} textured${flat.length ? `; untextured: ${flat.slice(0, 5).map((m) => m.name).join(', ')}${missingAssets ? ' (export reported missing assets)' : ''}` : ''}`, untextured: flat.map((m) => m.name) });
    const water = mats.filter((m) => m.name.startsWith('water_'));
    check('water materials are transmissive / transparent with ior 1.333', water.every((m) => (m.transmission > 0 || m.transparent) && (m.ior === null || Math.abs(m.ior - 1.333) < 1e-3)) && (water.length > 0 || M.water.length === 0), { summary: water.map((m) => `${m.name}: transmission ${m.transmission}, transparent ${m.transparent}, ior ${m.ior}`).join('; ') || 'no water materials' });
    const cutout = mats.filter((m) => m.alphaTest > 0);
    check('alpha-tested foliage materials keep their textures', cutout.every((m) => m.hasMap), { summary: `${cutout.length} alpha-tested materials` });
    if ((placements.structures || []).some((s) => s.inGlb && s.type !== 'model')) {
      const names = mats.map((m) => m.name);
      const need = ['structure_wall', 'structure_roof', 'structure_stone'];
      check('parametric structures use wall / roof / stone materials', need.every((n) => names.includes(n)), { summary: names.filter((n) => n.startsWith('structure_')).join(', ') });
    }
  }

  // ---- bounds, counts, environment ------------------------------------------------------------
  {
    const b = M.sceneBounds;
    const pad = 40;
    check('scene bounding box matches the terrain extent', b.min[0] >= -half - pad && b.max[0] <= half + pad && b.min[2] >= -half - pad && b.max[2] <= half + pad && b.min[1] >= hm.minHeight - 12 && b.max[1] <= hm.maxHeight + 120 && b.max[0] - b.min[0] >= hm.sizeMeters - cell * 8, { summary: `x ${b.min[0].toFixed(1)} .. ${b.max[0].toFixed(1)}, y ${b.min[1].toFixed(1)} .. ${b.max[1].toFixed(1)}, z ${b.min[2].toFixed(1)} .. ${b.max[2].toFixed(1)} m`, bounds: b });
    const c = exportReport.counts;
    const g = M.groups;
    const mism = [];
    if ((g.scatter?.instances || 0) !== c.scatterInstancesInGlb) mism.push(`scatter instances ${g.scatter?.instances || 0} vs report ${c.scatterInstancesInGlb}`);
    if (M.structures.length !== c.structuresInGlb) mism.push(`structures ${M.structures.length} vs ${c.structuresInGlb}`);
    if (M.objects.length !== c.objectsInGlb) mism.push(`objects ${M.objects.length} vs ${c.objectsInGlb}`);
    if (M.roads.length !== c.roadsInGlb) mism.push(`roads ${M.roads.length} vs ${c.roadsInGlb}`);
    if (M.scatter.length !== c.scatterNodes) mism.push(`instanced nodes ${M.scatter.length} vs ${c.scatterNodes}`);
    check('per-group counts agree with export_report.json', mism.length === 0, { summary: mism.join('; ') || Object.entries(g).map(([k, v]) => `${k} ${v.meshes}`).join(', ') + ' meshes' });
    const d = environment.sun?.direction || [];
    const len = Math.hypot(d[0], d[1], d[2]);
    check('environment.json has a unit sun direction and wind / water settings', Math.abs(len - 1) < 1e-3 && environment.wind && environment.water?.optics && environment.env, { summary: `sun [${d.join(', ')}] (|v| = ${len.toFixed(4)}), elevation ${environment.sun?.elevationDeg} deg` });
    check('README_EXPORT.md documents what does not survive export', /What does not survive export/i.test(readme) && /triplanar/i.test(readme) && /impostor/i.test(readme) && /caustic/i.test(readme), { summary: `${readme.length} characters` });
  }

  // ---- optional: compare with the project on disk ------------------------------------------------
  if (projectDir) {
    const pj = join(projectDir, 'project.json');
    if (!existsSync(pj)) check('project.json found for --project', false, { summary: pj });
    else {
      const doc = JSON.parse(readFileSync(pj, 'utf8'));
      const bad = [];
      if (doc.terrain.size !== hm.sizeMeters) bad.push(`terrain size ${doc.terrain.size} vs ${hm.sizeMeters}`);
      if (doc.terrain.res !== W) bad.push(`terrain res ${doc.terrain.res} vs ${W}`);
      if (doc.seed !== glb.json.scenes[0].extras?.seed) bad.push(`seed ${doc.seed} vs ${glb.json.scenes[0].extras?.seed}`);
      for (const s of doc.structures || []) {
        const e = (placements.structures || []).find((q) => q.id === s.id);
        if (!e) bad.push(`structure ${s.id} missing from placements`);
        else if (Math.hypot(e.x - s.x, e.z - s.z) > 2e-3) bad.push(`structure ${s.id} moved`);
      }
      if ((doc.structures || []).length !== (placements.structures || []).length) bad.push('structure count differs');
      if ((doc.objects || []).length !== (placements.objects || []).length) bad.push('object count differs');
      if ((doc.water?.rivers || []).length !== (placements.rivers || []).length) bad.push('river count differs');
      if ((doc.water?.lakes || []).length !== (placements.lakes || []).length) bad.push('lake count differs');
      if ((doc.roads || []).length !== (placements.roads || []).length) bad.push('road count differs');
      if (!!doc.water?.sea?.enabled !== !!placements.sea?.enabled) bad.push('sea enabled flag differs');
      check('export agrees with the project document (size, resolution, seed, structures, objects, water, roads)', bad.length === 0, { summary: bad.join('; ') || `${doc.name}` });
    }
  }

  // ---- software map preview (always; independent of the browser) --------------------------------
  try {
    mkdirSync(shotsDir, { recursive: true });
    const file = join(shotsDir, 'map_preview.png');
    const drawn = renderMapPreview(glb, { heights, W, H, half, size: hm.sizeMeters }, file);
    report.mapPreview = { file, drawn, note: 'CPU-rasterised top-down map of scene.glb: baked terrain texture + relief shading, wet water triangles (blue), roads (pale), scatter instances (dots: dark green = tall foliage, green = low foliage, grey = rocks, brown = dead wood), structures (red, yellow line = front, red ring = locator), objects (yellow squares). North is up.' };
    console.log(`        map preview: ${file}`);
  } catch (e) {
    console.log(`        map preview failed: ${e.message}`);
  }

  // ---- 4. screenshots -------------------------------------------------------------------------
  if (page && browserStats) {
    try {
      mkdirSync(shotsDir, { recursive: true });
      const shots = planShots({ hm, heights, terrainAt, wtype, placements, W, H, half, cell });
      report.screenshots = [];
      for (const s of shots) {
        const info = await page.evaluate((v) => window.viewer.setCamera(v), { eye: s.eye, target: s.target, fov: s.fov });
        const file = join(shotsDir, s.file);
        await page.screenshot({ path: file, type: 'png' });
        report.screenshots.push({ file, view: s.name, eye: s.eye.map((v) => rnd(v, 2)), target: s.target.map((v) => rnd(v, 2)), ...info });
        console.log(`        screenshot ${s.name}: ${file} (${info.drawCalls} draw calls, ${(info.triangles / 1e6).toFixed(1)} M triangles)`);
      }
      const sizes = report.screenshots.map((s) => statSync(s.file).size);
      check('viewer screenshots were rendered', sizes.length >= 2 && sizes.every((b) => b > 20000), { summary: report.screenshots.map((s, i) => `${s.view} ${(sizes[i] / 1024).toFixed(0)} kB`).join(', ') });
    } catch (e) {
      check('viewer screenshots were rendered', false, { summary: e.message });
    }
  }
  if (flags.serve) {
    if (!srv) srv = await startServer(flags.port ? +flags.port : 0);
    if (browser) await browser.close();
    browser = null;
    finish(report, null, null, true);
    console.log(`\nviewer running at ${srv.url}/index.html?glb=/export/scene.glb  (Ctrl+C to stop)`);
    return;
  }
  return finish(report, browser, srv);
}

/** Camera positions: aerial overview, top-down map view, eye-level views near a structure and the nearest shore. */
function planShots({ hm, terrainAt, wtype, placements, W, H, half, cell }) {
  const size = hm.sizeMeters;
  const mid = (hm.minHeight + hm.maxHeight) / 2;
  const shots = [
    { name: 'aerial', file: 'aerial.png', eye: [size * 0.1, hm.maxHeight + size * 0.55, size * 0.82], target: [0, mid - (hm.maxHeight - hm.minHeight) * 0.25, -size * 0.05], fov: 42 },
    { name: 'top-down', file: 'topdown.png', eye: [0, hm.maxHeight + size * 1.25, size * 0.002], target: [0, mid, 0], fov: 42 },
  ];
  const eyeAt = (x, z, h = 1.7) => [x, terrainAt(x, z) + h, z];
  const structure = (placements.structures || []).find((s) => s.inGlb && s.type !== 'model') || (placements.structures || []).find((s) => s.inGlb);
  let focus = [0, 0];
  if (structure) {
    const rot = (structure.rotDeg * Math.PI) / 180;
    // 40 degrees off the front (+Z local) so the door wall and a gable are both visible
    const a = rot + (40 * Math.PI) / 180;
    const d = 19;
    const ex = structure.x + Math.sin(a) * d,
      ez = structure.z + Math.cos(a) * d;
    shots.push({ name: 'structure', file: 'eye_structure.png', eye: [ex, Math.max(terrainAt(ex, ez) + 1.7, structure.y + 1.2), ez], target: [structure.x, structure.y + 2.2, structure.z], fov: 55 });
    focus = [structure.x, structure.z];
  }
  // nearest shoreline cell (dry with a wet 4-neighbour) to the focus point
  let best = null;
  const fx = (focus[0] + half) / cell,
    fz = (focus[1] + half) / cell;
  for (let iz = 2; iz < H - 2; iz++) {
    for (let ix = 2; ix < W - 2; ix++) {
      const i = iz * W + ix;
      if (wtype[i] !== 0) continue;
      if (!(wtype[i - 1] || wtype[i + 1] || wtype[i - W] || wtype[i + W])) continue;
      const d = (ix - fx) ** 2 + (iz - fz) ** 2;
      if (!best || d < best.d) best = { d, ix, iz };
    }
  }
  if (best) {
    // direction towards the water: centroid of the wet cells around the shoreline cell
    let cx = 0,
      cz = 0,
      n = 0;
    const R = 6;
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const x = best.ix + dx,
          z = best.iz + dz;
        if (x < 0 || z < 0 || x >= W || z >= H) continue;
        if (wtype[z * W + x] !== 0) {
          cx += dx;
          cz += dz;
          n++;
        }
      }
    }
    const l = Math.hypot(cx, cz) || 1;
    const tx = cx / l,
      tz = cz / l;
    const sx = best.ix * cell - half,
      sz = best.iz * cell - half;
    const back = Math.max(7, cell * 2.5);
    const e = eyeAt(sx - tx * back, sz - tz * back, 1.9);
    const waterY = terrainAt(sx + tx * cell, sz + tz * cell);
    shots.push({ name: 'shore', file: 'eye_water.png', eye: e, target: [sx + tx * 30, Math.min(e[1] - 1.2, waterY + 1.0), sz + tz * 30], fov: 60 });
  } else if (!structure) {
    const e = eyeAt(0, size * 0.1, 2);
    shots.push({ name: 'ground', file: 'eye_ground.png', eye: e, target: [0, e[1] + 4, -size * 0.2], fov: 60 });
  }
  return shots;
}

async function finish(report, browser, srv, keepServer = false) {
  if (browser) await browser.close().catch(() => {});
  if (srv && !keepServer) srv.server.close();
  report.finished = new Date().toISOString();
  report.passed = checks.filter((c) => c.pass).length;
  report.failed = checks.filter((c) => !c.pass).length;
  report.ok = report.failed === 0;
  mkdirSync(shotsDir, { recursive: true });
  const out = join(shotsDir, 'verify_report.json');
  writeFileSync(out, JSON.stringify(report, null, 1));
  console.log(`\n${report.ok ? 'PASS' : 'FAIL'}: ${report.passed} checks passed, ${report.failed} failed (${report.mode} mode, measurements from ${report.measurementSource || 'n/a'})`);
  console.log(`report: ${out}`);
  if (!keepServer) process.exitCode = report.ok ? 0 : 1;
  return report;
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
