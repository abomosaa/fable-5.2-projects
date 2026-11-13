// Minimal, dependency-free glTF 2.0 reader for the (trusted-format, untrusted-content) Poly Haven downloads.
// Reads .gltf JSON + external .bin buffers and exposes accessors as typed arrays. It never executes anything
// from the download directory and refuses URIs that escape it.
import fs from 'node:fs';
import path from 'node:path';

const COMPONENT = {
  5120: { T: Int8Array, size: 1, norm: (v) => Math.max(v / 127, -1) },
  5121: { T: Uint8Array, size: 1, norm: (v) => v / 255 },
  5122: { T: Int16Array, size: 2, norm: (v) => Math.max(v / 32767, -1) },
  5123: { T: Uint16Array, size: 2, norm: (v) => v / 65535 },
  5125: { T: Uint32Array, size: 4, norm: (v) => v },
  5126: { T: Float32Array, size: 4, norm: (v) => v },
};
const TYPE_SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

export function resolveInside(dir, uri) {
  if (/^[a-z]+:/i.test(uri)) throw new Error(`unsupported non-relative uri: ${uri.slice(0, 40)}`);
  const p = path.resolve(dir, decodeURIComponent(uri));
  if (!p.startsWith(path.resolve(dir) + path.sep)) throw new Error(`uri escapes asset directory: ${uri}`);
  return p;
}

export function loadGltf(gltfPath) {
  const dir = path.dirname(gltfPath);
  const json = JSON.parse(fs.readFileSync(gltfPath, 'utf8'));
  const buffers = (json.buffers ?? []).map((b) => {
    const buf = fs.readFileSync(resolveInside(dir, b.uri));
    if (buf.length < b.byteLength) throw new Error(`buffer ${b.uri} shorter than declared`);
    return buf;
  });
  return { json, buffers, dir };
}

/** Returns { array, itemSize, count }. Float data comes back as Float32Array (normalized ints are converted), indices as Uint32Array. */
export function readAccessor(gltf, index, { asIndices = false } = {}) {
  const { json, buffers } = gltf;
  const acc = json.accessors[index];
  if (acc.sparse) throw new Error('sparse accessors are not supported');
  const comp = COMPONENT[acc.componentType];
  const itemSize = TYPE_SIZE[acc.type];
  const bv = json.bufferViews[acc.bufferView];
  const buf = buffers[bv.buffer];
  const start = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = bv.byteStride && bv.byteStride !== comp.size * itemSize ? bv.byteStride : 0;
  const n = acc.count * itemSize;
  const end = start + (stride ? stride * (acc.count - 1) + comp.size * itemSize : n * comp.size);
  if (end > buf.length) throw new Error(`accessor ${index} out of buffer bounds`);
  let src;
  if (!stride && (buf.byteOffset + start) % comp.size === 0) {
    src = new comp.T(buf.buffer, buf.byteOffset + start, n); // zero-copy view
  } else {
    src = new comp.T(n);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
    const get = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }[acc.componentType];
    const step = stride || comp.size * itemSize;
    for (let i = 0; i < acc.count; i++) for (let k = 0; k < itemSize; k++) src[i * itemSize + k] = dv[get](start + i * step + k * comp.size, true);
  }
  if (asIndices) return { array: src instanceof Uint32Array ? src : Uint32Array.from(src), itemSize, count: acc.count };
  if (acc.componentType === 5126) return { array: src, itemSize, count: acc.count };
  const out = new Float32Array(n);
  if (acc.normalized) for (let i = 0; i < n; i++) out[i] = comp.norm(src[i]);
  else for (let i = 0; i < n; i++) out[i] = src[i];
  return { array: out, itemSize, count: acc.count };
}

// ---- node transforms (column-major 4x4, as in glTF)
export function mat4Identity() { return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); }
export function mat4Mul(a, b) {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
export function nodeLocalMatrix(node) {
  if (node.matrix) return Float64Array.from(node.matrix);
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2, yy = qy * y2, yz = qy * z2, zz = qz * z2, wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return new Float64Array([
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ]);
}

/** Visit every mesh-bearing node below `rootIndex` with its world matrix. */
export function traverse(json, rootIndex, visit, parent = mat4Identity(), depth = 0) {
  if (depth > 64) throw new Error('node hierarchy too deep / cyclic');
  const node = json.nodes[rootIndex];
  const world = mat4Mul(parent, nodeLocalMatrix(node));
  visit(node, world, rootIndex);
  for (const c of node.children ?? []) traverse(json, c, visit, world, depth + 1);
}
