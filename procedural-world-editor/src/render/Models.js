// Model library: loads the processed GLB assets (own minimal GLB reader so LODs can share
// textures and images can be down-scaled on decode), builds PBR materials that shade through the
// shared lighting model, and bakes multi-view impostors for distant trees.

import * as THREE from 'three';
import { NOISE_GLSL, GLOBALS_GLSL, SHADOW_GLSL, ATMOS_GLSL, LIGHTING_GLSL } from './shaders/common.glsl.js';
import { buildReedModel } from './ProceduralPlants.js';

const INSTANCE_GLSL = /* glsl */ `
#ifdef INSTANCED
in vec4 aI0;   // x, y, z, scale
in vec4 aI1;   // rotY, tiltX, tiltZ, seed + 256 * fade
#endif
uniform vec4 uModelInfo;   // x = height, y = radius, z = flex, w = foliage flutter
uniform vec4 uWind;        // xy = direction, z = strength (0..1.5), w = time
uniform mat4 uObjMatrix;   // non-instanced objects
// returns world position; outputs world normal, per-instance seed and fade
vec3 instanceTransform(vec3 pos, vec3 nrm, out vec3 wn, out float seed, out float fade, out vec3 origin){
#ifdef INSTANCED
  float sc = aI0.w;
  float cy = cos(aI1.x), sy = sin(aI1.x);
  seed = fract(aI1.w); fade = floor(aI1.w) / 255.0;
  vec3 p = pos * sc;
#ifndef FOLIAGE
  // opaque objects (rocks, deadwood) fade in and out by scaling: both LODs are full size in the
  // middle of a cross-fade, the last LOD shrinks into the ground at its range limit
  p *= smoothstep(0.0, 0.5, fade);
#endif
  // small tilt (ground alignment), then yaw
  vec3 t = vec3(p.x + aI1.y * p.y, p.y - aI1.y * p.x - aI1.z * p.z, p.z + aI1.z * p.y);
  vec3 n = normalize(vec3(nrm.x + aI1.y * nrm.y, nrm.y - aI1.y * nrm.x - aI1.z * nrm.z, nrm.z + aI1.z * nrm.y));
  vec3 w = vec3(t.x * cy + t.z * sy, t.y, -t.x * sy + t.z * cy);
  wn = vec3(n.x * cy + n.z * sy, n.y, -n.x * sy + n.z * cy);
  origin = aI0.xyz;
  float hgt = uModelInfo.x * sc;
  w += origin;
#else
  seed = 0.37; fade = 1.0;
  vec3 w = (uObjMatrix * vec4(pos, 1.0)).xyz;
  wn = normalize(mat3(uObjMatrix) * nrm);
  origin = uObjMatrix[3].xyz;
  float sc = length(uObjMatrix[0].xyz);
  float hgt = uModelInfo.x * sc;
#endif
#ifdef WIND
  // trunk sway grows with the square of height; gusts travel downwind across the landscape
  float hN = clamp((w.y - origin.y) / max(hgt, 0.05), 0.0, 1.0);
  float tt = uWind.w;
  vec2 gp = origin.xz * 0.02 - uWind.xy * tt * 0.25;
  float gust = 0.55 + 0.45 * sin(gp.x * 1.7 + gp.y * 2.3 + sin(gp.y * 0.9 + tt * 0.3) * 2.0);
  float ph = seed * 6.2831 + tt * (0.9 + seed * 0.5);
  float bend = uModelInfo.z * hN * hN * hgt * uWind.z * (0.014 + 0.03 * gust + 0.008 * sin(ph));
  w.xz += uWind.xy * bend;
  w.y -= bend * bend / max(hgt, 0.5) * 0.5;
  #ifdef FOLIAGE
  // leaf / twig flutter: high-frequency, proportional to distance from the trunk axis
  vec3 lp = pos;
  float radial = length(lp.xz) / max(uModelInfo.y, 0.05);
  // (slow enough to read as branches swaying; neighbouring vertices stay coherent)
  float fl = sin(tt * 2.1 + dot(lp, vec3(1.1, 0.8, 1.6)) + seed * 20.0) + 0.5 * sin(tt * 3.7 + dot(lp, vec3(-1.9, 0.6, 1.1)));
  w += vec3(uWind.x, 0.35, uWind.y) * (fl * uModelInfo.w * radial * uWind.z * (0.5 + 0.5 * gust) * 0.012 * min(hgt, 3.0));
  #endif
#endif
  return w;
}
`;

const OBJ_VERT = /* glsl */ `
precision highp float;
${GLOBALS_GLSL}
${INSTANCE_GLSL}
out vec3 vWorld; out vec3 vNormalW; out vec2 vUv; out float vViewDepth; out float vSeed; out float vFade; out vec3 vLocal; out float vAO;
void main(){
  vec3 wn, origin; float seed, fade;
  vec3 wp = instanceTransform(position, normal, wn, seed, fade, origin);
  vWorld = wp; vNormalW = wn; vUv = uv; vSeed = seed; vFade = fade; vLocal = position;
  vAO = 1.0;
#ifdef FOLIAGE
  // crown self-occlusion: interior and lower foliage receives less sky light
  float radial = clamp(length(position.xz) / max(uModelInfo.y, 0.05), 0.0, 1.0);
  float hN = clamp(position.y / max(uModelInfo.x, 0.05), 0.0, 1.0);
  vAO = mix(0.38, 1.0, smoothstep(0.1, 0.85, radial * 0.75 + hN * 0.45));
  // soften card normals with a rounded crown normal
  vec3 puff = normalize(wp - (origin + vec3(0.0, uModelInfo.x * 0.45, 0.0)) + vec3(0.0, 0.2, 0.0));
  vNormalW = normalize(mix(wn, puff, uModelInfo.w > 0.5 ? 0.55 : 0.3));
#endif
  vec4 vp = viewMatrix * vec4(wp, 1.0);
  vViewDepth = -vp.z;
  gl_Position = projectionMatrix * vp;
}
`;

const OBJ_FRAG = /* glsl */ `
precision highp float;
${GLOBALS_GLSL}
${NOISE_GLSL}
${SHADOW_GLSL}
${ATMOS_GLSL}
${LIGHTING_GLSL}
in vec3 vWorld; in vec3 vNormalW; in vec2 vUv; in float vViewDepth; in float vSeed; in float vFade; in vec3 vLocal; in float vAO;
uniform sampler2D uMap; uniform sampler2D uNormalMap; uniform sampler2D uORM;
uniform vec4 uMatParams;   // x = alpha cutoff, y = translucency, z = normal strength, w = uv scale
uniform vec3 uTint;
uniform vec4 uHighlight;   // rgb colour, a = amount (selection)
out vec4 outColor;
void main(){
  if (vWorld.y < uClipY) discard;
  vec2 uv = vUv * uMatParams.w;
  vec4 base = texture(uMap, uv);
  float alpha = 1.0;
#ifdef FOLIAGE
  // alpha test with screen-space sharpening; resolved by alpha-to-coverage under MSAA
  alpha = clamp((base.a - uMatParams.x) / max(fwidth(base.a), 1e-4) + 0.5, 0.0, 1.0);
  #ifdef DITHER_FADE
  alpha *= vFade;
  #endif
  // snap to the MSAA sample count: exact quarter coverages are not dithered by the driver, so
  // crowns do not show an ordered stipple
  alpha = floor(alpha * 4.0 + 0.5) * 0.25;
  if (alpha < 0.125) discard;
#else
  // (opaque objects fade by shrinking in the vertex stage - no screen-door pattern)
#endif
  vec3 Ng = normalize(vNormalW);
#ifdef TWO_SIDED
  if (!gl_FrontFacing) Ng = -Ng;
#endif
  // derivative-based tangent frame (assets carry no tangents)
  vec3 dp1 = dFdx(vWorld), dp2 = dFdy(vWorld);
  vec2 du1 = dFdx(uv), du2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, Ng), dp1perp = cross(Ng, dp1);
  vec3 T = dp2perp * du1.x + dp1perp * du2.x;
  vec3 B = dp2perp * du1.y + dp1perp * du2.y;
  float invmax = inversesqrt(max(dot(T, T), dot(B, B)) + 1e-12);
  vec3 nt = texture(uNormalMap, uv).xyz * 2.0 - 1.0;
  nt.xy *= uMatParams.z;
  vec3 N = normalize(T * invmax * nt.x + B * invmax * nt.y + Ng * nt.z);
  vec3 orm = texture(uORM, uv).rgb;
  Surface s;
  s.albedo = base.rgb * uTint;
#ifdef FOLIAGE
  // per-plant hue / brightness variation so neighbouring instances do not match exactly
  s.albedo *= mix(vec3(0.82, 0.9, 0.78), vec3(1.12, 1.06, 0.92), vSeed);
#else
  s.albedo *= 0.9 + 0.2 * vSeed;
#endif
  s.N = N; s.Ng = Ng;
  s.roughness = clamp(orm.g, 0.1, 1.0);
  s.ao = orm.r * vAO;
  s.f0 = 0.04;
  s.translucency = uMatParams.y;
  s.porosity = 0.55;
  s.wet = 0.0;
  vec4 col = shadeSurface(s, vWorld, vViewDepth, 1.0);
  col.rgb = mix(col.rgb, uHighlight.rgb * (0.3 + dot(col.rgb, vec3(0.6))), uHighlight.a);
#ifdef FOLIAGE
  outColor = vec4(col.rgb, clamp(alpha, 0.0, 1.0));
#else
  outColor = col;
#endif
}
`;

const OBJ_DEPTH_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv; in float vSeed; in float vFade;
uniform sampler2D uMap; uniform vec4 uMatParams;
out vec4 outColor;
void main(){
#ifdef FOLIAGE
  if (texture(uMap, vUv * uMatParams.w).a < uMatParams.x * 0.9) discard;
#endif
  outColor = vec4(1.0);
}
`;

// --- impostor capture (albedo + model-space normal) and rendering ---
const IMP_CAPTURE_VERT = /* glsl */ `
out vec2 vUv; out vec3 vN;
void main(){ vUv = uv; vN = normal; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const IMP_CAPTURE_FRAG = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1;
in vec2 vUv; in vec3 vN;
uniform sampler2D uMap; uniform sampler2D uORM; uniform float uCutoff; uniform float uFoliage; uniform vec3 uCenter; uniform float uRadius;
void main(){
  vec4 b = texture(uMap, vUv);
  if (uFoliage > 0.5 && b.a < uCutoff) discard;
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  o0 = vec4(b.rgb, 1.0);
  o1 = vec4(n * 0.5 + 0.5, uFoliage);
}
`;
const IMP_VERT = /* glsl */ `
precision highp float;
${GLOBALS_GLSL}
in vec4 aI0; in vec4 aI1;
uniform vec4 uModelInfo;   // x = height, y = radius, z = flex
uniform vec4 uWind;
uniform vec4 uAtlas;       // x = columns (azimuths), y = rows (elevations), z = frame half width (m), w = frame height (m)
uniform float uCenterY;    // capture centre height
out vec2 vUvA; out vec2 vUvB; out float vBlend; out vec3 vWorld; out float vViewDepth; out float vSeed; out float vFade; out float vRot; out vec2 vQuad;
void main(){
  float sc = aI0.w;
  vec3 origin = aI0.xyz;
  vSeed = fract(aI1.w); vFade = floor(aI1.w) / 255.0; vRot = aI1.x;
  vec3 centre = origin + vec3(0.0, uCenterY * sc, 0.0);
  vec3 toCam = uCamPos - centre;
  float d = length(toCam);
  vec3 vd = toCam / d;
  // view direction in model space (undo yaw)
  float cy = cos(aI1.x), sy = sin(aI1.x);
  vec3 ml = vec3(vd.x * cy - vd.z * sy, vd.y, vd.x * sy + vd.z * cy);
  float az = atan(ml.z, ml.x);                       // -pi..pi
  float el = asin(clamp(ml.y, -1.0, 1.0));
  float fa = (az / 6.2831853 + 0.5) * uAtlas.x;       // frame coordinate
  float f0 = floor(fa), f1 = mod(f0 + 1.0, uAtlas.x);
  vBlend = fa - f0;
  // elevation rows: 6, 32, 62 degrees
  float row = el < 0.33 ? 0.0 : el < 0.82 ? 1.0 : 2.0;
  row = min(row, uAtlas.y - 1.0);
  // billboard basis: faces the camera, tilts back for raised view points
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), vd));
  vec3 up = normalize(cross(vd, right));
  vec2 q = position.xy;                               // -1..1
  vQuad = q;
  float hw = uAtlas.z * sc, hh = uAtlas.w * 0.5 * sc;
  vec3 wp = centre + right * q.x * hw + up * q.y * hh;
  // wind sway of the upper part
  float hN = clamp(q.y * 0.5 + 0.5, 0.0, 1.0);
  float tt = uWind.w;
  vec2 gp = origin.xz * 0.02 - uWind.xy * tt * 0.25;
  float gust = 0.55 + 0.45 * sin(gp.x * 1.7 + gp.y * 2.3 + sin(gp.y * 0.9 + tt * 0.3) * 2.0);
  wp.xz += uWind.xy * (uModelInfo.z * hN * hN * uModelInfo.x * sc * uWind.z * (0.014 + 0.03 * gust));
  vec2 cellSz = 1.0 / uAtlas.xy;
  vec2 uvq = q * 0.5 + 0.5;
  vUvA = (vec2(f0, row) + uvq) * cellSz;
  vUvB = (vec2(f1, row) + uvq) * cellSz;
  vWorld = wp;
  vec4 vp = viewMatrix * vec4(wp, 1.0);
  vViewDepth = -vp.z;
  gl_Position = projectionMatrix * vp;
}
`;
const IMP_FRAG = /* glsl */ `
precision highp float;
${GLOBALS_GLSL}
${NOISE_GLSL}
${SHADOW_GLSL}
${ATMOS_GLSL}
${LIGHTING_GLSL}
in vec2 vUvA; in vec2 vUvB; in float vBlend; in vec3 vWorld; in float vViewDepth; in float vSeed; in float vFade; in float vRot; in vec2 vQuad;
uniform sampler2D uImpColor; uniform sampler2D uImpNormal;
uniform vec4 uModelInfo;
out vec4 outColor;
void main(){
  if (vWorld.y < uClipY) discard;
  // blend the two nearest azimuth frames (premultiplied atlases, so the mix is coverage-correct)
  // clamp the mip level: beyond ~3 the atlas frames bleed into each other
  vec2 tsz = vec2(textureSize(uImpColor, 0));
  vec2 dxu = dFdx(vUvA * tsz), dyu = dFdy(vUvA * tsz);
  float lodI = clamp(0.5 * log2(max(dot(dxu, dxu), dot(dyu, dyu)) + 1e-8), 0.0, 3.0);
  vec4 c = mix(textureLod(uImpColor, vUvA, lodI), textureLod(uImpColor, vUvB, lodI), vBlend);
#ifdef DEPTH_ONLY
  if (c.a < 0.3) discard;
  outColor = vec4(1.0);
#else
  // coverage straight from the (mip-filtered) atlas alpha: resolved by alpha-to-coverage, so a
  // distant crown thins out smoothly instead of turning into a solid card or vanishing
  float alpha = clamp((c.a * (1.5 + lodI * 0.9) - 0.2) / 0.3, 0.0, 1.0) * vFade;
  alpha = floor(alpha * 4.0 + 0.5) * 0.25;   // exact sample counts: no driver dither (see OBJ_FRAG)
  if (alpha < 0.125) discard;
  vec4 nt = mix(textureLod(uImpNormal, vUvA, lodI), textureLod(uImpNormal, vUvB, lodI), vBlend) / max(c.a, 0.05);   // un-premultiply (cleared texels are zero)
  vec3 nm = normalize(nt.xyz * 2.0 - 1.0);
  float cy = cos(vRot), sy = sin(vRot);
  vec3 N = normalize(vec3(nm.x * cy + nm.z * sy, nm.y, -nm.x * sy + nm.z * cy));
  Surface s;
  s.albedo = c.rgb / max(c.a, 0.05) * mix(vec3(0.82, 0.9, 0.78), vec3(1.12, 1.06, 0.92), vSeed);
  s.N = N; s.Ng = normalize(N + vec3(0.0, 0.6, 0.0));
  s.roughness = 0.75;
  // crown occlusion approximated from the position within the billboard
  s.ao = mix(0.5, 1.0, smoothstep(-0.6, 0.7, vQuad.y)) * mix(0.75, 1.0, abs(vQuad.x));
  s.f0 = 0.04; s.translucency = clamp(nt.a, 0.0, 1.0) * 0.5; s.porosity = 0.4; s.wet = 0.0;
  vec4 col = shadeSurface(s, vWorld, vViewDepth, 1.0);
  outColor = vec4(col.rgb, clamp(alpha, 0.0, 1.0));
#endif
}
`;

function parseGLB(buffer) {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB file');
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLen)));
  const binOff = 20 + jsonLen + 8;
  const bin = new Uint8Array(buffer, binOff);
  return { json, bin, binOffset: binOff, buffer };
}

function accessorArray(glb, index) {
  const { json, buffer, binOffset } = glb;
  const acc = json.accessors[index];
  const bv = json.bufferViews[acc.bufferView];
  const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type];
  const Ctor = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }[acc.componentType];
  const off = binOffset + (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = bv.byteStride || 0;
  const n = acc.count * comps;
  if (stride && stride !== comps * Ctor.BYTES_PER_ELEMENT) {
    const out = new Ctor(n);
    const dv = new DataView(buffer);
    const get = { 5126: 'getFloat32', 5123: 'getUint16', 5125: 'getUint32', 5121: 'getUint8', 5122: 'getInt16', 5120: 'getInt8' }[acc.componentType];
    for (let i = 0; i < acc.count; i++) for (let c = 0; c < comps; c++) out[i * comps + c] = dv[get](off + i * stride + c * Ctor.BYTES_PER_ELEMENT, true);
    return { array: out, comps, normalized: !!acc.normalized };
  }
  // copy so the GLB buffer can be released
  if (off % Ctor.BYTES_PER_ELEMENT === 0) return { array: new Ctor(buffer.slice(off, off + n * Ctor.BYTES_PER_ELEMENT)), comps, normalized: !!acc.normalized };
  return { array: new Ctor(buffer.slice(off, off + n * Ctor.BYTES_PER_ELEMENT)), comps, normalized: !!acc.normalized };
}

export class ModelLibrary {
  constructor(engine, manifest, baseUrl) {
    this.engine = engine;
    this.G = engine.G;
    this.manifest = manifest;
    this.baseUrl = baseUrl;
    this.models = new Map(); // id -> record
    this.texCache = new Map();
    this.windU = { value: new THREE.Vector4(1, 0, 0.5, 0) };
    this.maxTex = engine.quality.modelTexSize || 1024;
    this.white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this.white.needsUpdate = true;
    this.flatNormal = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
    this.flatNormal.needsUpdate = true;
    this.loading = new Map();
  }

  info(id) {
    return this.manifest.models[id];
  }

  async _texture(glb, texIndex, srgb) {
    if (texIndex === undefined || texIndex === null) return null;
    const t = glb.json.textures[texIndex];
    const src = t.extensions?.EXT_texture_webp?.source ?? t.source;
    const img = glb.json.images[src];
    const bv = glb.json.bufferViews[img.bufferView];
    const bytes = new Uint8Array(glb.buffer, glb.binOffset + (bv.byteOffset || 0), bv.byteLength);
    // content key: length + sparse byte sample (variants of one asset embed identical images)
    let h = 2166136261 >>> 0;
    const step = Math.max(1, Math.floor(bytes.length / 512));
    for (let i = 0; i < bytes.length; i += step) h = Math.imul(h ^ bytes[i], 16777619) >>> 0;
    const key = `${bytes.length}:${h}:${srgb ? 's' : 'l'}`;
    if (this.texCache.has(key)) return this.texCache.get(key);
    const p = (async () => {
      const blob = new Blob([bytes], { type: img.mimeType });
      let bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      if (Math.max(bmp.width, bmp.height) > this.maxTex) {
        const sc = this.maxTex / Math.max(bmp.width, bmp.height);
        const b2 = await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * sc), resizeHeight: Math.round(bmp.height * sc), resizeQuality: 'high', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        bmp.close();
        bmp = b2;
      }
      const tex = new THREE.Texture(bmp);
      tex.flipY = false;
      tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = 8;
      tex.generateMipmaps = true;
      tex.needsUpdate = true;
      return tex;
    })();
    this.texCache.set(key, p);
    return p;
  }

  /** Load a model (all LODs). Returns the record; cached. */
  load(id) {
    if (this.models.has(id)) return Promise.resolve(this.models.get(id));
    if (this.loading.has(id)) return this.loading.get(id);
    const p = this._load(id).then((rec) => {
      this.models.set(id, rec);
      this.loading.delete(id);
      return rec;
    });
    this.loading.set(id, p);
    return p;
  }

  async _load(id) {
    if (id.startsWith('proc_')) return this._buildProcedural(id);
    const info = this.manifest.models[id];
    if (!info) throw new Error(`Model "${id}" is not in the asset manifest. Run "npm run assets" to install the asset library.`);
    const rec = { id, info, lods: [], height: info.height, radius: info.radius, isTree: info.category.startsWith('tree'), impostor: null };
    const foliageFlex = info.category.startsWith('tree') ? 1 : info.category === 'shrub' ? 0.8 : info.category === 'grass' || info.category === 'groundcover' ? 1.6 : 0;
    let sharedMats = null;
    for (let l = 0; l < info.lods.length; l++) {
      const url = this.baseUrl + info.lods[l].file;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Missing model file ${url} (HTTP ${res.status}). Run "npm run assets" to install the asset library.`);
      let glb;
      try {
        glb = parseGLB(await res.arrayBuffer());
      } catch (e) {
        throw new Error(`Model file ${url} is missing or corrupt (${e.message}). Run "npm run assets" to install the asset library.`);
      }
      const prims = [];
      const mesh = glb.json.meshes[0];
      // Materials are shared between LODs by name (identical images are also de-duplicated by
      // content); a LOD that introduces a new material - e.g. baked foliage cards replacing leaf
      // geometry - gets its own.
      if (!sharedMats) sharedMats = new Map();
      for (const prim of mesh.primitives) {
        const m = glb.json.materials[prim.material];
        if (sharedMats.has(m.name)) continue;
        const pbr = m.pbrMetallicRoughness || {};
        const foliage = m.alphaMode === 'MASK' || /^foliage/.test(m.name || '');
        const [map, nor, orm] = await Promise.all([this._texture(glb, pbr.baseColorTexture?.index, true), this._texture(glb, m.normalTexture?.index, false), this._texture(glb, pbr.metallicRoughnessTexture?.index ?? m.occlusionTexture?.index, false)]);
        sharedMats.set(m.name, this._makeMaterials({ name: m.name, map, nor, orm, foliage, cutoff: m.alphaCutoff ?? 0.4, doubleSided: !!m.doubleSided || foliage, rec, flex: foliageFlex }));
      }
      for (const prim of mesh.primitives) {
        const m = glb.json.materials[prim.material];
        const g = new THREE.BufferGeometry();
        const pos = accessorArray(glb, prim.attributes.POSITION);
        const nor = accessorArray(glb, prim.attributes.NORMAL);
        const uv = accessorArray(glb, prim.attributes.TEXCOORD_0);
        g.setAttribute('position', new THREE.BufferAttribute(pos.array, 3, pos.normalized));
        g.setAttribute('normal', new THREE.BufferAttribute(nor.array, 3, nor.normalized));
        g.setAttribute('uv', new THREE.BufferAttribute(uv.array, 2, uv.normalized));
        const idx = accessorArray(glb, prim.indices);
        g.setIndex(new THREE.BufferAttribute(idx.array, 1));
        g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, info.height / 2, 0), Math.hypot(info.radius, info.height / 2) + 0.01);
        let mats = sharedMats.get(m.name);
        if (!mats) mats = sharedMats.values().next().value;
        prims.push({ geometry: g, mats, triangles: idx.array.length / 3 });
      }
      rec.lods.push({ prims, triangles: info.lods[l].triangles });
    }
    return rec;
  }

  _buildProcedural(id) {
    const built = buildReedModel(id);
    const rec = { id, info: built.info, lods: [], height: built.info.height, radius: built.info.radius, isTree: false, impostor: null, procedural: true };
    if (!this.manifest.models[id]) this.manifest.models[id] = built.info;
    for (const lod of built.lods) {
      const mats = this._makeMaterials({ name: id, map: built.texture, nor: null, orm: null, foliage: true, cutoff: 0.0, doubleSided: true, rec, flex: 2.2, opaqueFoliage: true });
      rec.lods.push({ prims: [{ geometry: lod.geometry, mats, triangles: lod.triangles }], triangles: lod.triangles });
    }
    return rec;
  }

  _makeMaterials(o) {
    const info = new THREE.Vector4(o.rec.height, o.rec.radius, o.flex, o.foliage ? 1 : 0);
    const uniforms = () => ({
      ...this.G,
      uMap: { value: o.map || this.white },
      uNormalMap: { value: o.nor || this.flatNormal },
      uORM: { value: o.orm || this.white },
      uMatParams: { value: new THREE.Vector4(o.opaqueFoliage ? -1 : o.cutoff, o.foliage ? 0.5 : 0, 1, 1) },
      uTint: { value: new THREE.Vector3(1, 1, 1) },
      uHighlight: { value: new THREE.Vector4(1, 0.7, 0.2, 0) },
      uModelInfo: { value: info },
      uWind: this.windU,
      uObjMatrix: { value: new THREE.Matrix4() },
    });
    const make = (instanced, depth) => {
      const defines = {};
      if (instanced) defines.INSTANCED = 1;
      if (o.foliage) defines.FOLIAGE = 1;
      if (o.foliage && !o.opaqueFoliage) defines.NO_WATER_FX = 1;
      if (o.flex > 0) defines.WIND = 1;
      if (o.doubleSided) defines.TWO_SIDED = 1;
      if (instanced) defines.DITHER_FADE = 1;
      const m = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: OBJ_VERT,
        fragmentShader: depth ? OBJ_DEPTH_FRAG : OBJ_FRAG,
        uniforms: uniforms(),
        defines,
        side: o.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      });
      if (depth) m.colorWrite = false;
      else if (o.foliage && !o.opaqueFoliage) m.alphaToCoverage = true;
      return m;
    };
    return { foliage: o.foliage, make, instanced: make(true, false), instancedDepth: make(true, true), params: o, name: o.name };
  }

  /** Material pair for a single (non-instanced) object using this model's textures. */
  singleMaterials(mats) {
    return { color: mats.make(false, false), depth: mats.make(false, true) };
  }

  /**
   * Bake an impostor atlas for a tree: 8 azimuths x 3 elevations, albedo + normal.
   */
  bakeImpostor(rec) {
    if (rec.impostor) return rec.impostor;
    const r = this.engine.renderer;
    const COLS = 8,
      ROWS = 3;
    const cellW = 192,
      cellH = 256;
    const rt = new THREE.WebGLRenderTarget(COLS * cellW, ROWS * cellH, { count: 2, type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: true, samples: 4 });
    rt.textures[0].colorSpace = THREE.SRGBColorSpace;
    for (const t of rt.textures) {
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = 4;
    }
    // captured from the most detailed LOD with a relaxed alpha cut-off so distant crowns stay full
    const lod = rec.lods[0];
    const scene = new THREE.Scene();
    const mats = [];
    for (const p of lod.prims) {
      const m = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: IMP_CAPTURE_VERT,
        fragmentShader: IMP_CAPTURE_FRAG,
        uniforms: { uMap: { value: p.mats.params.map || this.white }, uORM: { value: this.white }, uCutoff: { value: p.mats.params.cutoff * 0.3 }, uFoliage: { value: p.mats.foliage ? 1 : 0 }, uCenter: { value: new THREE.Vector3() }, uRadius: { value: 1 } },
        side: THREE.DoubleSide,
      });
      mats.push(m);
      const mesh = new THREE.Mesh(p.geometry, m);
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
    const H = rec.height,
      R = rec.radius;
    const halfW = R * 1.05;
    const frameH = Math.max(H * 1.04, halfW * 2 * (cellH / cellW) * 0.5);
    const centerY = H * 0.5;
    const cam = new THREE.OrthographicCamera(-halfW, halfW, frameH / 2, -frameH / 2, 0.1, 400);
    const prevRT = r.getRenderTarget();
    const prevAuto = r.autoClear;
    const prevColor = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    r.setRenderTarget(rt);
    r.setClearColor(0x000000, 0);
    rt.scissorTest = false;
    rt.viewport.set(0, 0, rt.width, rt.height);
    r.setRenderTarget(rt);
    r.clear(true, true, false);
    r.autoClear = false;
    const els = [0.105, 0.56, 1.08];
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        // frame coordinate fa = (az / 2pi + 0.5) * COLS -> az for the frame centre
        const az = ((col + 0.0) / COLS - 0.5) * Math.PI * 2;
        const el = els[row];
        const dir = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
        cam.position.set(0, centerY, 0).addScaledVector(dir, 150);
        cam.up.set(0, 1, 0);
        cam.lookAt(0, centerY, 0);
        cam.updateMatrixWorld(true);
        rt.viewport.set(col * cellW, row * cellH, cellW, cellH);
        rt.scissor.set(col * cellW, row * cellH, cellW, cellH);
        rt.scissorTest = true;
        r.setRenderTarget(rt);
        r.clear(false, true, false);
        r.render(scene, cam);
      }
    }
    rt.scissorTest = false;
    r.setRenderTarget(prevRT);
    r.setClearColor(prevColor, prevAlpha);
    r.autoClear = prevAuto;
    for (const m of mats) m.dispose();
    const info = new THREE.Vector4(rec.height, rec.radius, 1, 1);
    const make = (depth) => {
      const m = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: IMP_VERT,
        fragmentShader: IMP_FRAG,
        uniforms: {
          ...this.G,
          uImpColor: { value: rt.textures[0] },
          uImpNormal: { value: rt.textures[1] },
          uModelInfo: { value: info },
          uWind: this.windU,
          uAtlas: { value: new THREE.Vector4(COLS, ROWS, halfW, frameH) },
          uCenterY: { value: centerY },
        },
        defines: depth ? { DEPTH_ONLY: 1 } : { NO_WATER_FX: 1 },
        side: THREE.DoubleSide,
      });
      if (depth) m.colorWrite = false;
      else m.alphaToCoverage = true;
      return m;
    };
    rec.impostor = { rt, material: make(false), depthMaterial: make(true) };
    return rec.impostor;
  }

  setWind(dirX, dirZ, strength, time) {
    this.windU.value.set(dirX, dirZ, strength, time);
  }
}

export { OBJ_VERT, OBJ_FRAG, INSTANCE_GLSL };
