// Deterministic, dependency-free GLB 2.0 writer: one scene, one identity node, one mesh, N primitives.
// Plain float32 attributes, uint16/uint32 indices, embedded JPEG/PNG/WebP images. No Draco/meshopt/KTX2.

const pad4 = (n) => (n + 3) & ~3;

/**
 * @param {{name:string, prims:{pos:Float32Array,nrm:Float32Array,uv:Float32Array,idx:Uint32Array,material:number}[],
 *   materials:{name:string, baseColor?:{data:Buffer,mime:string}, normal?:{data:Buffer,mime:string}, orm?:{data:Buffer,mime:string},
 *     hasOcclusion?:boolean, alphaMode?:'OPAQUE'|'MASK'|'BLEND', alphaCutoff?:number, doubleSided?:boolean,
 *     baseColorFactor?:number[], metallicFactor?:number, roughnessFactor?:number, normalScale?:number}[],
 *   extras?:object}} model
 * @returns {Buffer}
 */
export function writeGlb(model) {
  const chunks = []; let byteLength = 0;
  const bufferViews = [], accessors = [], images = [], textures = [], materials = [];
  const addView = (buf, target) => {
    const offset = pad4(byteLength);
    if (offset > byteLength) chunks.push(Buffer.alloc(offset - byteLength));
    chunks.push(buf); byteLength = offset + buf.length;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, ...(target ? { target } : {}) });
    return bufferViews.length - 1;
  };
  const asBuf = (ta) => Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength);
  let usesWebp = false;

  // images are de-duplicated by identity of the data buffer
  const imageIndex = new Map();
  const addTexture = (img) => {
    if (!img) return undefined;
    let ti = imageIndex.get(img.data);
    if (ti !== undefined) return ti;
    images.push({ bufferView: addView(img.data), mimeType: img.mime });
    const source = images.length - 1;
    if (img.mime === 'image/webp') { usesWebp = true; textures.push({ sampler: 0, extensions: { EXT_texture_webp: { source } } }); }
    else textures.push({ sampler: 0, source });
    ti = textures.length - 1;
    imageIndex.set(img.data, ti);
    return ti;
  };

  const primitives = [];
  for (const p of model.prims) {
    const nv = p.pos.length / 3;
    if (!nv || !p.idx.length) continue;
    if (p.nrm.length !== nv * 3 || p.uv.length !== nv * 2) throw new Error('attribute length mismatch');
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.pos.length; i += 3) for (let k = 0; k < 3; k++) { const v = p.pos[i + k]; if (!Number.isFinite(v)) throw new Error('non-finite position'); if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
    const idxArr = nv <= 65535 ? Uint16Array.from(p.idx) : p.idx;
    const iv = addView(asBuf(idxArr), 34963);
    accessors.push({ bufferView: iv, componentType: nv <= 65535 ? 5123 : 5125, count: p.idx.length, type: 'SCALAR' });
    const ia = accessors.length - 1;
    accessors.push({ bufferView: addView(asBuf(p.pos), 34962), componentType: 5126, count: nv, type: 'VEC3', min: min.map(Math.fround), max: max.map(Math.fround) });
    const pa = accessors.length - 1;
    accessors.push({ bufferView: addView(asBuf(p.nrm), 34962), componentType: 5126, count: nv, type: 'VEC3' });
    const na = accessors.length - 1;
    accessors.push({ bufferView: addView(asBuf(p.uv), 34962), componentType: 5126, count: nv, type: 'VEC2' });
    const ua = accessors.length - 1;
    primitives.push({ attributes: { POSITION: pa, NORMAL: na, TEXCOORD_0: ua }, indices: ia, material: p.material, mode: 4 });
  }

  for (const m of model.materials) {
    const mat = { name: m.name, pbrMetallicRoughness: {} };
    const pbr = mat.pbrMetallicRoughness;
    const bc = addTexture(m.baseColor), nt = addTexture(m.normal), ot = addTexture(m.orm);
    if (bc !== undefined) pbr.baseColorTexture = { index: bc };
    if (m.baseColorFactor) pbr.baseColorFactor = m.baseColorFactor;
    pbr.metallicFactor = m.metallicFactor ?? (ot !== undefined ? 1 : 0);
    pbr.roughnessFactor = m.roughnessFactor ?? 1;
    if (ot !== undefined) { pbr.metallicRoughnessTexture = { index: ot }; if (m.hasOcclusion !== false) mat.occlusionTexture = { index: ot }; }
    if (nt !== undefined) mat.normalTexture = { index: nt, ...(m.normalScale != null && m.normalScale !== 1 ? { scale: m.normalScale } : {}) };
    if (m.alphaMode && m.alphaMode !== 'OPAQUE') { mat.alphaMode = m.alphaMode; if (m.alphaMode === 'MASK') mat.alphaCutoff = m.alphaCutoff ?? 0.5; }
    mat.doubleSided = !!m.doubleSided;
    materials.push(mat);
  }

  const json = {
    asset: { version: '2.0', generator: 'pwe-asset-pipeline' },
    ...(usesWebp ? { extensionsUsed: ['EXT_texture_webp'], extensionsRequired: ['EXT_texture_webp'] } : {}),
    scene: 0,
    scenes: [{ name: model.name, nodes: [0] }],
    nodes: [{ name: model.name, mesh: 0 }],
    meshes: [{ name: model.name, primitives }],
    materials,
    ...(textures.length ? { textures, images, samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }] } : {}),
    accessors, bufferViews,
    buffers: [{ byteLength: pad4(byteLength) }],
    ...(model.extras ? { extras: model.extras } : {}),
  };
  if (pad4(byteLength) > byteLength) chunks.push(Buffer.alloc(pad4(byteLength) - byteLength));
  const bin = Buffer.concat(chunks);
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  if (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(4 - (jsonBuf.length % 4), 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, jsonBuf, bh, bin]);
}
