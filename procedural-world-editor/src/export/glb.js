// Dependency-free glTF 2.0 binary (GLB) writer. Runs in browsers and Node (no DOM, no three.js).
// One buffer; every accessor gets its own 4-byte aligned bufferView; images are embedded as
// bufferViews and de-duplicated by content hash; extension bookkeeping (used / required) is
// explicit so the output validates with the Khronos validator.

export const GL = {
  BYTE: 5120,
  UNSIGNED_BYTE: 5121,
  SHORT: 5122,
  UNSIGNED_SHORT: 5123,
  UNSIGNED_INT: 5125,
  FLOAT: 5126,
  ARRAY_BUFFER: 34962,
  ELEMENT_ARRAY_BUFFER: 34963,
  LINEAR: 9729,
  LINEAR_MIPMAP_LINEAR: 9987,
  REPEAT: 10497,
  CLAMP_TO_EDGE: 33071,
};

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function componentTypeOf(arr) {
  if (arr instanceof Float32Array) return GL.FLOAT;
  if (arr instanceof Uint32Array) return GL.UNSIGNED_INT;
  if (arr instanceof Uint16Array) return GL.UNSIGNED_SHORT;
  if (arr instanceof Uint8Array) return GL.UNSIGNED_BYTE;
  if (arr instanceof Int16Array) return GL.SHORT;
  if (arr instanceof Int8Array) return GL.BYTE;
  throw new Error('GLB: unsupported accessor array type');
}

/** 64-bit content key from two independent 32-bit hashes + length. */
export function contentHash(bytes) {
  let a = 2166136261 >>> 0;
  let b = 0x9747b28c;
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i];
    a = Math.imul(a ^ v, 16777619) >>> 0;
    b = (Math.imul(b ^ v, 0x5bd1e995) + 0x1b873593) | 0;
    b ^= b >>> 15;
  }
  return bytes.length.toString(36) + '-' + a.toString(36) + '-' + (b >>> 0).toString(36);
}

export class GLBBuilder {
  constructor(generator = 'Terraforge exporter') {
    this.json = {
      asset: { version: '2.0', generator },
      scene: 0,
      scenes: [{ name: 'scene', nodes: [] }],
      nodes: [],
      meshes: [],
      materials: [],
      accessors: [],
      bufferViews: [],
      buffers: [{ byteLength: 0 }],
    };
    this.chunks = [];
    this.length = 0;
    this.used = new Set();
    this.required = new Set();
    this.imageByHash = new Map();
    this.textureByKey = new Map();
    this.samplerByKey = new Map();
    this.materialByKey = new Map();
    this.stats = { imagesDeduplicated: 0, imageBytes: 0, geometryBytes: 0 };
  }

  useExtension(name, required = false) {
    this.used.add(name);
    if (required) this.required.add(name);
  }

  /** Append raw bytes as a bufferView (4-byte aligned). */
  addView(bytes, target) {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.chunks.push(new Uint8Array(pad));
      this.length += pad;
    }
    const view = { buffer: 0, byteOffset: this.length, byteLength: bytes.byteLength };
    if (target) view.target = target;
    this.chunks.push(bytes);
    this.length += bytes.byteLength;
    this.json.bufferViews.push(view);
    return this.json.bufferViews.length - 1;
  }

  /**
   * @param {TypedArray} array  tightly packed data (copied by reference, do not mutate afterwards)
   * @param {'SCALAR'|'VEC2'|'VEC3'|'VEC4'|'MAT4'} type
   * @param {{target?:number, minMax?:boolean, normalized?:boolean, name?:string}} [o]
   */
  addAccessor(array, type, o = {}) {
    const comps = COMPONENTS[type];
    if (!comps) throw new Error('GLB: unknown accessor type ' + type);
    if (array.length % comps !== 0) throw new Error(`GLB: accessor length ${array.length} is not a multiple of ${comps}`);
    const count = array.length / comps;
    if (count === 0) throw new Error('GLB: empty accessor');
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    const view = this.addView(bytes, o.target);
    this.stats.geometryBytes += bytes.byteLength;
    const acc = { bufferView: view, componentType: componentTypeOf(array), count, type };
    if (o.normalized) acc.normalized = true;
    if (o.name) acc.name = o.name;
    if (o.minMax) {
      const mn = new Array(comps).fill(Infinity);
      const mx = new Array(comps).fill(-Infinity);
      for (let i = 0; i < array.length; i += comps) {
        for (let c = 0; c < comps; c++) {
          const v = array[i + c];
          if (v < mn[c]) mn[c] = v;
          if (v > mx[c]) mx[c] = v;
        }
      }
      acc.min = mn;
      acc.max = mx;
    }
    this.json.accessors.push(acc);
    return this.json.accessors.length - 1;
  }

  /** Embed an image; identical byte content is stored once. */
  addImage(bytes, mimeType, name, copy = false) {
    const key = mimeType + ':' + contentHash(bytes);
    const hit = this.imageByHash.get(key);
    if (hit !== undefined) {
      this.stats.imagesDeduplicated++;
      return hit;
    }
    // copy = true detaches the image from a larger source buffer so that buffer can be released
    const view = this.addView(copy ? bytes.slice() : bytes);
    this.stats.imageBytes += bytes.byteLength;
    if (!this.json.images) this.json.images = [];
    const img = { bufferView: view, mimeType };
    if (name) img.name = name;
    this.json.images.push(img);
    const idx = this.json.images.length - 1;
    this.imageByHash.set(key, idx);
    return idx;
  }

  addSampler(def = {}) {
    const s = { magFilter: GL.LINEAR, minFilter: GL.LINEAR_MIPMAP_LINEAR, wrapS: GL.REPEAT, wrapT: GL.REPEAT, ...def };
    const key = JSON.stringify(s);
    const hit = this.samplerByKey.get(key);
    if (hit !== undefined) return hit;
    if (!this.json.samplers) this.json.samplers = [];
    this.json.samplers.push(s);
    const idx = this.json.samplers.length - 1;
    this.samplerByKey.set(key, idx);
    return idx;
  }

  /** Texture for an embedded image. WebP images use EXT_texture_webp (no fallback => required). */
  addTexture(image, sampler) {
    const smp = sampler ?? this.addSampler();
    const key = image + ':' + smp;
    const hit = this.textureByKey.get(key);
    if (hit !== undefined) return hit;
    const mime = this.json.images[image].mimeType;
    let t;
    if (mime === 'image/webp') {
      t = { sampler: smp, extensions: { EXT_texture_webp: { source: image } } };
      this.useExtension('EXT_texture_webp', true);
    } else t = { sampler: smp, source: image };
    if (!this.json.textures) this.json.textures = [];
    this.json.textures.push(t);
    const idx = this.json.textures.length - 1;
    this.textureByKey.set(key, idx);
    return idx;
  }

  /** Add a material; structurally identical definitions are shared. */
  addMaterial(def) {
    const key = JSON.stringify(def);
    const hit = this.materialByKey.get(key);
    if (hit !== undefined) return hit;
    for (const ext of Object.keys(def.extensions || {})) this.useExtension(ext, false);
    this.json.materials.push(def);
    const idx = this.json.materials.length - 1;
    this.materialByKey.set(key, idx);
    return idx;
  }

  /**
   * Primitive from plain arrays. positions/normals Float32Array (xyz), uvs Float32Array (uv),
   * indices Uint16Array|Uint32Array. Extra attributes via `attributes: {NAME: {array, type}}`.
   */
  addPrimitive({ positions, normals, uvs, indices, material, attributes }) {
    const attr = { POSITION: this.addAccessor(positions, 'VEC3', { target: GL.ARRAY_BUFFER, minMax: true }) };
    if (normals) attr.NORMAL = this.addAccessor(normals, 'VEC3', { target: GL.ARRAY_BUFFER });
    if (uvs) attr.TEXCOORD_0 = this.addAccessor(uvs, 'VEC2', { target: GL.ARRAY_BUFFER });
    for (const [name, a] of Object.entries(attributes || {})) attr[name] = this.addAccessor(a.array, a.type, { target: GL.ARRAY_BUFFER, normalized: a.normalized });
    const prim = { attributes: attr, mode: 4 };
    if (indices) prim.indices = this.addAccessor(indices, 'SCALAR', { target: GL.ELEMENT_ARRAY_BUFFER });
    if (material !== undefined && material !== null) prim.material = material;
    return prim;
  }

  addMesh(name, primitives, extras) {
    const m = { name, primitives };
    if (extras) m.extras = extras;
    this.json.meshes.push(m);
    return this.json.meshes.length - 1;
  }

  /** def: {name, mesh?, translation?, rotation?, scale?, extras?, extensions?}; parent = node index or null (scene root). */
  addNode(def, parent = null) {
    const n = { ...def };
    for (const ext of Object.keys(n.extensions || {})) this.used.add(ext);
    this.json.nodes.push(n);
    const idx = this.json.nodes.length - 1;
    if (parent === null) this.json.scenes[0].nodes.push(idx);
    else {
      const p = this.json.nodes[parent];
      (p.children || (p.children = [])).push(idx);
    }
    return idx;
  }

  /** Serialise to a GLB container. */
  build() {
    const json = this.json;
    const pad = (4 - (this.length % 4)) % 4;
    const binLength = this.length + pad;
    json.buffers[0].byteLength = binLength;
    if (this.used.size) json.extensionsUsed = [...this.used].sort();
    else delete json.extensionsUsed;
    if (this.required.size) json.extensionsRequired = [...this.required].sort();
    else delete json.extensionsRequired;
    for (const k of ['images', 'textures', 'samplers', 'materials', 'meshes', 'accessors', 'bufferViews']) if (json[k] && json[k].length === 0) delete json[k];
    if (!json.bufferViews) delete json.buffers;
    let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jpad = (4 - (jsonBytes.length % 4)) % 4;
    const hasBin = !!json.buffers;
    const total = 12 + 8 + jsonBytes.length + jpad + (hasBin ? 8 + binLength : 0);
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true); // 'glTF'
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsonBytes.length + jpad, true);
    dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
    out.set(jsonBytes, 20);
    out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jpad);
    jsonBytes = null;
    if (hasBin) {
      let p = 20 + dv.getUint32(12, true);
      dv.setUint32(p, binLength, true);
      dv.setUint32(p + 4, 0x004e4942, true); // 'BIN\0'
      p += 8;
      for (const c of this.chunks) {
        out.set(c, p);
        p += c.byteLength;
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// Small quaternion helpers (glTF order: x, y, z, w)
// ---------------------------------------------------------------------------------------------

export function quatFromAxisAngle(ax, ay, az, angle) {
  const l = Math.hypot(ax, ay, az);
  if (l < 1e-12 || angle === 0) return [0, 0, 0, 1];
  const s = Math.sin(angle / 2) / l;
  return [ax * s, ay * s, az * s, Math.cos(angle / 2)];
}

export function quatMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function quatNormalize(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** Euler angles in three.js default 'XYZ' order (matches Object3D.rotation.set(x, y, z)). */
export function quatFromEulerXYZ(x, y, z) {
  const c1 = Math.cos(x / 2),
    c2 = Math.cos(y / 2),
    c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2),
    s2 = Math.sin(y / 2),
    s3 = Math.sin(z / 2);
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
}

/** Rotate a vector by a unit quaternion. */
export function quatRotate(q, v) {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * v[2] - qz * v[1]),
    ty = 2 * (qz * v[0] - qx * v[2]),
    tz = 2 * (qx * v[1] - qy * v[0]);
  return [v[0] + qw * tx + qy * tz - qz * ty, v[1] + qw * ty + qz * tx - qx * tz, v[2] + qw * tz + qx * ty - qy * tx];
}
