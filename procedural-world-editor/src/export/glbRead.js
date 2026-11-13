// Minimal GLB reader (no DOM, no three.js): container parsing, accessor extraction (with
// byteStride / byteOffset / normalised integers) and embedded image access. Used by the exporter
// to re-embed library models and by the tests to inspect exported scenes.

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const CTORS = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const GETTERS = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' };

/**
 * @param {Uint8Array|ArrayBuffer} data
 * @returns {{json:object, bin:Uint8Array, jsonChunkLength:number, binChunkLength:number, totalLength:number}}
 */
export function parseGLB(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < 20) throw new Error('GLB: file too short');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('GLB: bad magic (not a binary glTF file)');
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error('GLB: unsupported container version ' + version);
  const totalLength = dv.getUint32(8, true);
  if (totalLength > bytes.byteLength) throw new Error(`GLB: declared length ${totalLength} exceeds file size ${bytes.byteLength}`);
  const jsonChunkLength = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== 0x4e4f534a) throw new Error('GLB: first chunk is not JSON');
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonChunkLength)));
  let bin = new Uint8Array(0);
  let binChunkLength = 0;
  const p = 20 + jsonChunkLength;
  if (p + 8 <= totalLength) {
    binChunkLength = dv.getUint32(p, true);
    if (dv.getUint32(p + 4, true) !== 0x004e4942) throw new Error('GLB: second chunk is not BIN');
    if (p + 8 + binChunkLength > totalLength) throw new Error('GLB: BIN chunk exceeds the file length');
    bin = bytes.subarray(p + 8, p + 8 + binChunkLength);
  }
  return { json, bin, jsonChunkLength, binChunkLength, totalLength };
}

/** Bytes of a bufferView. */
export function viewBytes(glb, viewIndex) {
  const bv = glb.json.bufferViews[viewIndex];
  if (!bv) throw new Error('GLB: missing bufferView ' + viewIndex);
  const off = bv.byteOffset || 0;
  if (off + bv.byteLength > glb.bin.byteLength) throw new Error(`GLB: bufferView ${viewIndex} exceeds the binary chunk`);
  return glb.bin.subarray(off, off + bv.byteLength);
}

/**
 * Read an accessor into a tightly packed typed array of its component type (always a copy, so
 * the result is aligned and independent of the source file).
 * @returns {{array:TypedArray, comps:number, count:number, componentType:number, normalized:boolean, type:string}}
 */
export function readAccessor(glb, index) {
  const acc = glb.json.accessors[index];
  if (!acc) throw new Error('GLB: missing accessor ' + index);
  const comps = COMPONENTS[acc.type];
  const Ctor = CTORS[acc.componentType];
  if (!comps || !Ctor) throw new Error(`GLB: unsupported accessor ${acc.type}/${acc.componentType}`);
  const n = acc.count * comps;
  const out = new Ctor(n);
  if (acc.bufferView === undefined) return { array: out, comps, count: acc.count, componentType: acc.componentType, normalized: !!acc.normalized, type: acc.type };
  const bv = glb.json.bufferViews[acc.bufferView];
  const csize = Ctor.BYTES_PER_ELEMENT;
  const stride = bv.byteStride || comps * csize;
  const start = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const end = start + (acc.count - 1) * stride + comps * csize;
  if (end > glb.bin.byteLength || (acc.byteOffset || 0) + (acc.count - 1) * stride + comps * csize > bv.byteLength) throw new Error(`GLB: accessor ${index} exceeds its bufferView`);
  if (stride === comps * csize) {
    new Uint8Array(out.buffer).set(glb.bin.subarray(start, start + n * csize));
  } else {
    const dv = new DataView(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength);
    const get = GETTERS[acc.componentType];
    for (let i = 0; i < acc.count; i++) for (let c = 0; c < comps; c++) out[i * comps + c] = dv[get](start + i * stride + c * csize, true);
  }
  return { array: out, comps, count: acc.count, componentType: acc.componentType, normalized: !!acc.normalized, type: acc.type };
}

/** Accessor as Float32Array, resolving normalised integer encodings. */
export function readAccessorFloat(glb, index) {
  const a = readAccessor(glb, index);
  if (a.array instanceof Float32Array) return a.array;
  const out = new Float32Array(a.array.length);
  const div = a.normalized ? { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 }[a.componentType] || 1 : 1;
  for (let i = 0; i < out.length; i++) out[i] = a.normalized ? Math.max(-1, a.array[i] / div) : a.array[i];
  return out;
}

/** Embedded image bytes + mime type for an image index. */
export function imageBytes(glb, imageIndex) {
  const img = glb.json.images?.[imageIndex];
  if (!img) throw new Error('GLB: missing image ' + imageIndex);
  if (img.bufferView === undefined) throw new Error(`GLB: image ${imageIndex} is not embedded (uri images are not supported)`);
  return { bytes: viewBytes(glb, img.bufferView), mimeType: img.mimeType, name: img.name };
}

/** Image index used by a texture (honours EXT_texture_webp). */
export function textureImageIndex(glb, textureIndex) {
  const t = glb.json.textures?.[textureIndex];
  if (!t) throw new Error('GLB: missing texture ' + textureIndex);
  return t.extensions?.EXT_texture_webp?.source ?? t.source;
}

/** 4x4 column-major local matrix of a node (identity when no transform is given). */
export function nodeMatrix(node) {
  if (node.matrix) return Float64Array.from(node.matrix);
  const t = node.translation || [0, 0, 0];
  const q = node.rotation || [0, 0, 0, 1];
  const s = node.scale || [1, 1, 1];
  const [x, y, z, w] = q;
  const x2 = x + x,
    y2 = y + y,
    z2 = z + z;
  const xx = x * x2,
    xy = x * y2,
    xz = x * z2,
    yy = y * y2,
    yz = y * z2,
    zz = z * z2,
    wx = w * x2,
    wy = w * y2,
    wz = w * z2;
  return Float64Array.from([(1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0, (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0, (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0, t[0], t[1], t[2], 1]);
}

export function mat4Mul(a, b) {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}

export function mat4Apply(m, v) {
  return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];
}

/** Visit every node of the default scene with its world matrix: fn(node, index, worldMatrix, parentIndex, path[]). */
export function traverseScene(glb, fn) {
  const json = glb.json;
  const scene = json.scenes[json.scene || 0];
  const identity = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const visit = (idx, parentM, parentIdx, path) => {
    const node = json.nodes[idx];
    const m = mat4Mul(parentM, nodeMatrix(node));
    const p = [...path, node.name || String(idx)];
    fn(node, idx, m, parentIdx, p);
    for (const c of node.children || []) visit(c, m, idx, p);
  };
  for (const r of scene.nodes) visit(r, identity, -1, []);
}
