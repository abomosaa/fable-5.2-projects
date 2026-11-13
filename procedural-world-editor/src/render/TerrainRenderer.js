// Terrain rendering: geometry-clipmap mesh displaced by a height LOD pyramid, shaded from
// CPU-computed normal/AO and ground-weight textures with height-blended PBR material layers
// (texture arrays), triplanar bedrock, anti-tiling and macro variation. The surrounding
// (non-editable) ring terrain reuses the same fragment shader with per-vertex weights.

import * as THREE from 'three';
import { Clipmap, CLIPMAP_VERT_GLSL } from './Clipmap.js';
import { NOISE_GLSL, GLOBALS_GLSL, SHADOW_GLSL, ATMOS_GLSL, LIGHTING_GLSL } from './shaders/common.glsl.js';
import { MAT_NAMES } from '../core/biomes.js';
import { Noise2D, smoothstep, hash32 } from '../core/noise.js';
import { sampleGrid } from '../core/heightfield.js';

const TERRAIN_VERT = /* glsl */ `
precision highp float;
${GLOBALS_GLSL}
${CLIPMAP_VERT_GLSL}
uniform highp sampler2D uHeightA;
uniform highp sampler2D uHeightB;
uniform vec4 uHeightInfo; // x = cell A, y = cell B, z = resA, w = resB
out vec3 vWorld;
out float vViewDepth;
out float vSkirt;
float fetchH(highp sampler2D t, vec2 xz, float cell, float res){
  ivec2 i = ivec2(clamp(floor((xz + uWorldRect.x) / cell + 0.5), vec2(0.0), vec2(res - 1.0)));
  return texelFetch(t, i, 0).r;
}
void main(){
  float morph; vec2 coarse;
  vec2 grid = position.xy;
  vec2 fine = uRing.yz + grid * uRing.x;
  vec2 xz = clipmapPos(grid, morph, coarse);
  float half_ = uWorldRect.x;
  vec2 cl = clamp(xz, vec2(-half_), vec2(half_));
  vSkirt = (abs(xz.x) > half_ + 0.01 || abs(xz.y) > half_ + 0.01) ? 1.0 : 0.0;
  float hA = fetchH(uHeightA, clamp(fine, vec2(-half_), vec2(half_)), uHeightInfo.x, uHeightInfo.z);
  float hB = fetchH(uHeightB, clamp(coarse, vec2(-half_), vec2(half_)), uHeightInfo.y, uHeightInfo.w);
  float h = mix(hA, hB, morph);
  vec3 wp = vec3(cl.x, h - vSkirt * 40.0, cl.y);
  vWorld = wp;
  vec4 vp = viewMatrix * vec4(wp, 1.0);
  vViewDepth = -vp.z;
  gl_Position = projectionMatrix * vp;
}
`;

const TERRAIN_DEPTH_FRAG = /* glsl */ `
precision highp float;
in vec3 vWorld; in float vSkirt; in float vViewDepth;
out vec4 outColor;
void main(){ outColor = vec4(1.0); }
`;

const RING_VERT = /* glsl */ `
precision highp float;
${GLOBALS_GLSL}
in vec4 aW0; in vec4 aW1;
out vec3 vWorld; out float vViewDepth; out float vSkirt;
out vec4 vW0; out vec4 vW1; out vec3 vNormalW;
void main(){
  vWorld = position; vSkirt = 0.0; vW0 = aW0; vW1 = aW1; vNormalW = normal;
  vec4 vp = viewMatrix * vec4(position, 1.0);
  vViewDepth = -vp.z;
  gl_Position = projectionMatrix * vp;
}
`;

const TERRAIN_FRAG = /* glsl */ `
precision highp float;
precision highp sampler2DArray;
${GLOBALS_GLSL}
${NOISE_GLSL}
${SHADOW_GLSL}
${ATMOS_GLSL}
${LIGHTING_GLSL}
in vec3 vWorld; in float vViewDepth; in float vSkirt;
#ifdef RING
in vec4 vW0; in vec4 vW1; in vec3 vNormalW;
#else
uniform sampler2D uNormalAO;
uniform sampler2D uW0;
uniform sampler2D uW1;
#endif
uniform sampler2DArray uAlbedoArr;  // rgb albedo (sRGB), a = height
uniform sampler2DArray uNormalArr;  // rg normal, b = roughness, a = ao
uniform float uTile[9];             // metres per texture tile
uniform vec3 uTint[9];              // per-layer albedo tint
uniform vec4 uBrush;                // xz, radius, strength (0 = hidden)
uniform vec4 uBrushColor;
uniform sampler2D uOverlay;         // optional editor overlay (rgba)
uniform float uOverlayAmt;
uniform vec3 uCanopyColor;
out vec4 outColor;

struct Layer { vec3 albedo; float h; vec3 n; float rough; float ao; };

Layer sampleLayerUV(int i, vec2 uv, vec2 dx, vec2 dy){
  vec4 a = textureGrad(uAlbedoArr, vec3(uv, float(i)), dx, dy);
  vec4 n = textureGrad(uNormalArr, vec3(uv, float(i)), dx, dy);
  Layer L; L.albedo = a.rgb; L.h = a.a;
  vec2 nn = n.rg * 2.0 - 1.0;
  L.n = vec3(nn, sqrt(max(0.0, 1.0 - dot(nn, nn))));
  L.rough = n.b; L.ao = n.a;
  return L;
}
Layer mixLayer(Layer a, Layer b, float t){
  Layer L; L.albedo = mix(a.albedo, b.albedo, t); L.h = mix(a.h, b.h, t); L.n = mix(a.n, b.n, t); L.rough = mix(a.rough, b.rough, t); L.ao = mix(a.ao, b.ao, t); return L;
}
// two scales (near detail + far macro tile, rotated) to hide repetition
Layer sampleLayer(int i, vec2 xz, float nearK, vec2 dxz, vec2 dyz){
  float t = uTile[i];
  Layer L;
  if (nearK > 0.001) {
    L = sampleLayerUV(i, xz / t, dxz / t, dyz / t);
  }
  if (nearK < 0.999) {
    const mat2 R = mat2(0.8, -0.6, 0.6, 0.8);
    float tf = t * 5.3;
    vec2 uvf = R * xz / tf;
    Layer F = sampleLayerUV(i, uvf, R * dxz / tf, R * dyz / tf);
    // the far tile is seen at lower frequency: flatten its normal a little
    F.n = normalize(vec3(F.n.xy * 0.7, F.n.z));
    if (nearK > 0.001) L = mixLayer(F, L, nearK); else L = F;
  }
  return L;
}

void main(){
  if (vWorld.y < uClipY) discard;
  vec3 wp = vWorld;
  float dist = length(wp - uCamPos);
  vec2 uv = (wp.xz + uWorldRect.x) * uWorldRect.y;
#ifdef RING
  vec3 Nm = normalize(vNormalW);
  float bakedAO = 1.0;
  vec4 w0 = vW0, w1 = vW1;
#else
  vec4 na = texture(uNormalAO, uv);
  vec2 nxz = na.rg;
  vec3 Nm = normalize(vec3(nxz.x, sqrt(max(0.02, 1.0 - dot(nxz, nxz))), nxz.y));
  float bakedAO = na.b;
  // warp the weight lookup by a couple of texels so material boundaries do not follow the grid
  vec2 wj = (vec2(fbm2(wp.xz * 0.45), fbm2(wp.xz * 0.45 + 31.7)) - 0.5) * 3.2 + (vec2(vnoise(wp.xz * 2.3), vnoise(wp.xz * 2.3 + 11.1)) - 0.5) * 0.9;
  vec2 uvw = uv + wj * uWorldRect.z;
  // 4-tap tent around the lookup: a hard biome edge becomes a smooth diagonal instead of cell stairs
  vec2 wo = uWorldRect.zz * 0.85;
  vec4 w0 = 0.25 * (texture(uW0, uvw + vec2(wo.x, wo.y)) + texture(uW0, uvw + vec2(-wo.x, wo.y)) + texture(uW0, uvw + vec2(wo.x, -wo.y)) + texture(uW0, uvw - wo));
  vec4 w1 = 0.25 * (texture(uW1, uvw + vec2(wo.x, wo.y)) + texture(uW1, uvw + vec2(-wo.x, wo.y)) + texture(uW1, uvw + vec2(wo.x, -wo.y)) + texture(uW1, uvw - wo));
#endif
  float wsum = dot(w0, vec4(1.0)) + dot(w1, vec4(1.0));
  float w[9];
  w[0] = w0.r; w[1] = w0.g; w[2] = w0.b; w[3] = w0.a; w[4] = w1.r; w[5] = w1.g; w[6] = w1.b; w[7] = w1.a;
  w[8] = max(0.0, 1.0 - wsum);

  vec2 dxz = dFdx(wp.xz), dyz = dFdy(wp.xz);
  float nearK = 1.0 - smoothstep(18.0, 90.0, dist);
  // break up blend boundaries with noise so transitions are ragged at sub-texel scale
  float edgeN = fbm2(wp.xz * 0.9) - 0.5;

  // ---- sample active layers, height-blend ----
  Layer acc; acc.albedo = vec3(0.0); acc.h = 0.0; acc.n = vec3(0.0); acc.rough = 0.0; acc.ao = 0.0;
  float hmax = 0.0;
  Layer Ls[9]; float hs[9];
  for (int i = 0; i < 9; i++) {
    hs[i] = 0.0;
    if (w[i] > 0.004) {
      Layer L;
      if (i == 8) {
        // bedrock: triplanar projection so cliffs are not stretched
        vec3 bw = pow(abs(Nm), vec3(6.0)); bw /= (bw.x + bw.y + bw.z);
        L.albedo = vec3(0.0); L.h = 0.0; L.n = vec3(0.0); L.rough = 0.0; L.ao = 0.0;
        vec3 nw = vec3(0.0);
        if (bw.y > 0.01) { Layer T = sampleLayer(8, wp.xz, nearK, dxz, dyz); L.albedo += T.albedo * bw.y; L.h += T.h * bw.y; L.rough += T.rough * bw.y; L.ao += T.ao * bw.y; nw += vec3(T.n.x, T.n.z, T.n.y) * bw.y; }
        if (bw.x > 0.01) { vec2 p = wp.zy; vec2 dx_ = dFdx(wp.zy), dy_ = dFdy(wp.zy); Layer T = sampleLayer(8, p, nearK, dx_, dy_); L.albedo += T.albedo * bw.x; L.h += T.h * bw.x; L.rough += T.rough * bw.x; L.ao += T.ao * bw.x; nw += vec3(T.n.z * sign(Nm.x), T.n.y, T.n.x) * bw.x; }
        if (bw.z > 0.01) { vec2 p = wp.xy; vec2 dx_ = dFdx(wp.xy), dy_ = dFdy(wp.xy); Layer T = sampleLayer(8, p, nearK, dx_, dy_); L.albedo += T.albedo * bw.z; L.h += T.h * bw.z; L.rough += T.rough * bw.z; L.ao += T.ao * bw.z; nw += vec3(T.n.x, T.n.y, T.n.z * sign(Nm.z)) * bw.z; }
        L.n = nw; // world-space perturbation for rock (handled below)
      } else {
        L = sampleLayer(i, wp.xz, nearK, dxz, dyz);
      }
      L.albedo *= uTint[i];
      Ls[i] = L;
      hs[i] = w[i] + L.h * 0.55 + edgeN * 0.25 * (1.0 - abs(w[i] * 2.0 - 1.0));
      hmax = max(hmax, hs[i]);
    }
  }
  float tot = 0.0;
  vec3 rockN = vec3(0.0); float rockK = 0.0;
  float porosity = 0.0;
  const float POR[9] = float[9](0.35, 0.75, 0.5, 0.95, 0.55, 1.0, 0.0, 0.85, 0.45);
  for (int i = 0; i < 9; i++) {
    if (w[i] > 0.004) {
      float b = max(hs[i] - (hmax - 0.16), 0.0) * w[i];
      b *= b;
      tot += b;
      acc.albedo += Ls[i].albedo * b; acc.rough += Ls[i].rough * b; acc.ao += Ls[i].ao * b; acc.h += Ls[i].h * b;
      porosity += POR[i] * b;
      if (i == 8) { rockN = Ls[i].n; rockK = b; } else acc.n += Ls[i].n * b;
    }
  }
  tot = max(tot, 1e-5);
  acc.albedo /= tot; acc.rough /= tot; acc.ao /= tot; acc.h /= tot; porosity /= tot; rockK /= tot;
  // tangent-space detail normal for the planar layers -> world
  vec3 T = normalize(cross(vec3(0.0, 0.0, 1.0), Nm));
  vec3 B = cross(Nm, T);
  vec3 tn = acc.n / tot;
  vec3 N = Nm;
  float detailFade = 1.0 - smoothstep(250.0, 900.0, dist) * 0.6;
  if (rockK < 0.999) N = normalize(Nm + (T * tn.x - B * tn.y) * 1.15 * detailFade);
  if (rockK > 0.001) {
    vec3 rn = normalize(Nm + (rockN - Nm * dot(rockN, Nm)) * 1.2 * detailFade);
    N = normalize(mix(N, rn, rockK));
  }

  // ---- sand ripple marks: wave-formed ripples on a sandy bed in shallow water (crests roughly
  // along the depth contours, wavelength ~8 cm..25 cm), fading out on the dry beach ----
  if (w[3] > 0.2 && uSea.x > 0.5) {
    float below = uSea.y + 0.25 - wp.y;
    // (faded out before the ripples get close to pixel size, where they would alias into moire)
    float rpx = length(fwidth(wp.xz));
    float rk = w[3] * smoothstep(0.05, 0.6, below) * (1.0 - smoothstep(2.5, 7.0, below)) * (1.0 - smoothstep(0.02, 0.06, rpx));
    if (rk > 0.01) {
      // Three fixed crest orientations, weighted by how well each lines up with the local depth
      // contours. (A continuously varying direction applied to absolute coordinates would shear
      // the phase into large moire fringes.)
      vec2 dn = normalize(Nm.xz + vec2(1e-4, 2e-4));            // downslope direction = across the ripples
      float warp = fbm2(wp.xz * 0.35) * 2.2;
      float amp = 0.5 + 0.5 * vnoise(wp.xz * 0.6 + 2.0);
      float dsl = 0.0, tr = 0.0, wsumR = 0.0;
      vec2 dslDir = vec2(0.0);
      for (int i = 0; i < 3; i++) {
        float ang = 0.35 + float(i) * 1.0471976;
        vec2 di = vec2(cos(ang), sin(ang));
        float wi = pow(abs(dot(dn, di)), 5.0);
        float ph = dot(wp.xz, di) * 26.0 + warp * 6.0 + float(i) * 2.1;
        dslDir += di * cos(ph) * wi;
        tr += (0.5 - 0.5 * sin(ph)) * wi;
        wsumR += wi;
      }
      dslDir *= 0.62 * amp * rk / max(wsumR, 1e-3);
      N = normalize(N - vec3(dslDir.x, 0.0, dslDir.y));
      acc.albedo *= 1.0 - 0.24 * rk * amp * tr / max(wsumR, 1e-3);   // troughs collect darker, coarser grains
    }
  }
  // ---- macro variation: large-scale tone and hue drift so no hillside is one flat colour ----
  float m1 = fbm2(wp.xz * 0.011), m2 = fbm2(wp.xz * 0.0031 + 7.3), m3 = vnoise(wp.xz * 0.11);
  vec3 alb = acc.albedo;
  float veg = (w[0] + w[1]);
  alb *= 0.82 + 0.36 * mix(m1, m3, 0.3);
  alb = mix(alb, alb * vec3(1.12, 1.04, 0.78), veg * smoothstep(0.35, 0.75, m2) * 0.55);  // drier, yellower patches
  alb = mix(alb, alb * vec3(0.86, 0.98, 0.88), veg * smoothstep(0.6, 0.3, m2) * 0.5);    // lusher patches
  // rock strata: subtle horizontal banding in exposed bedrock
  float strata = vnoise(vec2(wp.y * 0.55 + fbm2(wp.xz * 0.02) * 9.0, 3.7));
  alb = mix(alb, alb * (0.78 + 0.5 * strata), w[8] * 0.6);
  // beach: a strand line of dark debris (weed, twigs, shell grit) left at the limit of the last
  // high swash, broken into patches, and a paler dry zone above it
  if (uSea.x > 0.5 && w[3] > 0.05) {
    float above = wp.y - (uSea.y + uSea.z * 1.15 + 0.22);
    float wob = (fbm2(wp.xz * 0.09) - 0.5) * 0.22 + (vnoise(wp.xz * 0.9) - 0.5) * 0.05;
    float band = exp(-pow((above - wob) / 0.045, 2.0));
    float patchy = smoothstep(0.35, 0.7, fbm2(wp.xz * 0.6 + 3.1)) * (0.5 + 0.5 * vnoise(wp.xz * 5.0));
    alb = mix(alb, alb * vec3(0.34, 0.31, 0.25), band * patchy * w[3] * 0.85 * (1.0 - smoothstep(60.0, 220.0, dist)));
    alb *= 1.0 + 0.10 * w[3] * smoothstep(0.1, 0.8, above);
  }
  // distant forest reads as dark textured canopy rather than leaf litter
#ifdef RING
  float canopy = w[1] * (0.75 + 0.25 * m3);
#else
  float canopy = w[1] * (0.75 + 0.25 * m3) * smoothstep(300.0, 1100.0, dist) * 0.9;
#endif
  alb = mix(alb, uCanopyColor * (0.7 + 0.6 * m1), canopy);
  acc.rough = mix(acc.rough, 0.9, canopy);

  Surface s;
  s.albedo = alb;
  s.N = N; s.Ng = Nm;
  s.roughness = clamp(acc.rough, 0.08, 1.0);
  // cavity: texture height darkens the gaps between stones a little more
  s.ao = clamp(bakedAO * mix(1.0, acc.ao, 0.85), 0.0, 1.0);
  s.f0 = 0.04;
  s.translucency = 0.0;
  s.porosity = porosity;
  s.wet = 0.0;
  vec4 col = shadeSurface(s, wp, vViewDepth, 1.0);

#ifndef RING
  // ---- editor overlays ----
  if (uOverlayAmt > 0.0) {
    vec4 ov = texture(uOverlay, uv);
    col.rgb = mix(col.rgb, ov.rgb * (0.4 + dot(col.rgb, vec3(0.5))), ov.a * uOverlayAmt);
  }
  if (uBrush.w > 0.0) {
    float d = length(wp.xz - uBrush.xy);
    float ring = smoothstep(0.0, 1.0, 1.0 - abs(d - uBrush.z) / max(0.04 * uBrush.z + fwidth(d) * 1.5, 0.05));
    float inner = (1.0 - smoothstep(0.0, uBrush.z, d)) * 0.16 * uBrush.w;
    float fall = smoothstep(0.0, 1.0, 1.0 - abs(d - uBrush.z * 0.5) / max(fwidth(d) * 1.5, 0.03)) * 0.35;
    col.rgb = mix(col.rgb, uBrushColor.rgb * 2.0, clamp(ring * 0.85 + inner + fall * 0.4, 0.0, 1.0) * uBrushColor.a);
  }
#endif
  outColor = col;
}
`;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Missing texture file: ${url} — run "npm run assets" to download the asset library.`));
    img.src = url;
  });
}

function imagePixels(img, size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  ctx.drawImage(img, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size).data;
}

export class TerrainRenderer {
  constructor(engine) {
    this.engine = engine;
    this.G = engine.G;
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    this.heightTex = [];
    this.ready = false;
    this.texSize = engine.quality.terrainTexSize || 1024;
    this.matUniforms = {
      uAlbedoArr: { value: null },
      uNormalArr: { value: null },
      uTile: { value: new Array(9).fill(2) },
      uTint: { value: Array.from({ length: 9 }, () => new THREE.Vector3(1, 1, 1)) },
      uNormalAO: { value: null },
      uW0: { value: null },
      uW1: { value: null },
      uBrush: { value: new THREE.Vector4(0, 0, 10, 0) },
      uBrushColor: { value: new THREE.Vector4(1, 0.8, 0.3, 1) },
      uOverlay: { value: null },
      uOverlayAmt: { value: 0 },
      uCanopyColor: { value: new THREE.Vector3(0.032, 0.05, 0.022) },
    };
    this.layerTextureIds = new Array(9).fill(null);
  }

  /** Load / reload the nine ground material layers into texture arrays. */
  async setMaterials(layers, manifest, baseUrl, onProgress) {
    const S = this.texSize;
    const ids = MAT_NAMES.map((n) => layers[n]?.texture);
    const missing = ids.map((id, i) => (!id || !manifest.textures[id] ? MAT_NAMES[i] : null)).filter(Boolean);
    if (missing.length) throw new Error(`Ground material layers without a valid texture set: ${missing.join(', ')}. Assign textures in the Materials panel or run "npm run assets".`);
    const same = ids.every((id, i) => id === this.layerTextureIds[i]);
    if (same && this.albedoArr) {
      this._applyLayerParams(layers, manifest);
      return;
    }
    if (!this.albedoData) {
      this.albedoData = new Uint8Array(S * S * 4 * 9);
      this.normalData = new Uint8Array(S * S * 4 * 9);
    }
    const avg = [];
    for (let i = 0; i < 9; i++) {
      if (ids[i] === this.layerTextureIds[i] && this.albedoArr) {
        avg.push(this.layerAvg[i]);
        continue;
      }
      const t = manifest.textures[ids[i]];
      onProgress && onProgress(`Loading ground material ${t.name || ids[i]}`, i / 9);
      const [diff, nor, arm, disp] = await Promise.all([loadImage(baseUrl + t.files.diff), loadImage(baseUrl + t.files.nor), loadImage(baseUrl + t.files.arm), loadImage(baseUrl + t.files.disp)]);
      const pd = imagePixels(diff, S),
        pn = imagePixels(nor, S),
        pa = imagePixels(arm, S),
        ph = imagePixels(disp, S);
      const o = i * S * S * 4;
      const A = this.albedoData,
        Nn = this.normalData;
      // normalise displacement contrast per layer so height blending behaves consistently
      let hmin = 255,
        hmax = 0;
      for (let p = 0; p < S * S; p += 7) {
        const v = ph[p * 4];
        if (v < hmin) hmin = v;
        if (v > hmax) hmax = v;
      }
      const hs = 255 / Math.max(1, hmax - hmin);
      let ar = 0,
        ag = 0,
        ab = 0;
      for (let p = 0; p < S * S; p++) {
        const q = p * 4;
        A[o + q] = pd[q];
        A[o + q + 1] = pd[q + 1];
        A[o + q + 2] = pd[q + 2];
        A[o + q + 3] = Math.max(0, Math.min(255, (ph[q] - hmin) * hs));
        Nn[o + q] = pn[q];
        Nn[o + q + 1] = pn[q + 1];
        Nn[o + q + 2] = pa[q + 1]; // roughness
        Nn[o + q + 3] = pa[q]; // ao
        if ((p & 15) === 0) {
          ar += Math.pow(pd[q] / 255, 2.2);
          ag += Math.pow(pd[q + 1] / 255, 2.2);
          ab += Math.pow(pd[q + 2] / 255, 2.2);
        }
      }
      const cnt = S * S / 16;
      avg.push([ar / cnt, ag / cnt, ab / cnt]);
    }
    this.layerAvg = avg;
    const mk = (data, srgb) => {
      const t = new THREE.DataArrayTexture(data, S, S, 9);
      t.format = THREE.RGBAFormat;
      t.type = THREE.UnsignedByteType;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = this.engine.quality.anisotropy || 8;
      t.needsUpdate = true;
      return t;
    };
    if (this.albedoArr) {
      this.albedoArr.dispose();
      this.normalArr.dispose();
    }
    this.albedoArr = mk(this.albedoData, true);
    this.normalArr = mk(this.normalData, false);
    this.matUniforms.uAlbedoArr.value = this.albedoArr;
    this.matUniforms.uNormalArr.value = this.normalArr;
    this.layerTextureIds = ids;
    this._applyLayerParams(layers, manifest);
  }

  _applyLayerParams(layers, manifest) {
    MAT_NAMES.forEach((n, i) => {
      const l = layers[n];
      const t = manifest.textures[l.texture];
      this.matUniforms.uTile.value[i] = l.tile || Math.min(6, Math.max(1.2, t.tileSizeM || 2));
      const tint = l.tint || [1, 1, 1];
      this.matUniforms.uTint.value[i].set(tint[0], tint[1], tint[2]);
    });
    // mean ground albedo feeds the sky's ground-bounce term
    if (this.layerAvg && this.engine.atmosphere) {
      const a = this.layerAvg;
      this.engine.atmosphere.groundAlbedo.set((a[0][0] + a[1][0] + a[8][0]) / 3, (a[0][1] + a[1][1] + a[8][1]) / 3, (a[0][2] + a[1][2] + a[8][2]) / 3);
    }
  }

  /** Bind to a world: allocate GPU textures and build meshes. */
  setWorld(world) {
    this.disposeWorld();
    this.world = world;
    const res = world.res;
    const gl = this.engine.renderer;
    void gl;
    // ---- height LOD pyramid ----
    this.levels = 5;
    this.heightData = [];
    this.heightTex = [];
    for (let l = 0; l < this.levels; l++) {
      const r = ((res - 1) >> l) + 1;
      const data = l === 0 ? world.hFinal.data : new Float32Array(r * r);
      const t = new THREE.DataTexture(data, r, r, THREE.RedFormat, THREE.FloatType);
      t.minFilter = t.magFilter = l === 0 ? THREE.LinearFilter : THREE.NearestFilter;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      this.heightData.push(data);
      this.heightTex.push(t);
    }
    // half-float: 8-bit normals quantise the slope enough to band smooth ground under grazing sun
    this.normalData8 = new Uint16Array(res * res * 4);
    this.normalTex = new THREE.DataTexture(this.normalData8, res, res, THREE.RGBAFormat, THREE.HalfFloatType);
    this.normalTex.minFilter = THREE.LinearMipmapLinearFilter;
    this.normalTex.magFilter = THREE.LinearFilter;
    this.normalTex.generateMipmaps = true;
    this.normalTex.anisotropy = 4;
    this.w0Data = new Uint8Array(res * res * 4);
    this.w1Data = new Uint8Array(res * res * 4);
    const mkW = (d) => {
      const t = new THREE.DataTexture(d, res, res, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = 4;
      return t;
    };
    this.w0Tex = mkW(this.w0Data);
    this.w1Tex = mkW(this.w1Data);
    this.matUniforms.uNormalAO.value = this.normalTex;
    this.matUniforms.uW0.value = this.w0Tex;
    this.matUniforms.uW1.value = this.w1Tex;
    this.G.uWorldRect.value.set(world.size / 2, 1 / world.size, 1 / res, world.hFinal.cell);

    // ---- clipmap ----
    const M = this.engine.quality.terrainGrid || 256;
    const makeMaterial = (l) => {
      const lb = Math.min(this.levels - 1, l + 1);
      const u = {
        ...this.G,
        ...this.matUniforms,
        uHeightA: { value: this.heightTex[l] },
        uHeightB: { value: this.heightTex[lb] },
        uHeightInfo: { value: new THREE.Vector4(world.hFinal.cell * (1 << l), world.hFinal.cell * (1 << lb), ((res - 1) >> l) + 1, ((res - 1) >> lb) + 1) },
      };
      const m = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: TERRAIN_VERT, fragmentShader: TERRAIN_FRAG, uniforms: u });
      m.extensions = { clipCullDistance: false };
      return m;
    };
    this.clipmap = new Clipmap({ M, levels: this.levels, baseCell: world.hFinal.cell, makeMaterial });
    for (const mesh of this.clipmap.meshes) {
      const mu = mesh.material.uniforms;
      const dm = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: TERRAIN_VERT,
        fragmentShader: TERRAIN_DEPTH_FRAG,
        uniforms: { ...this.G, uHeightA: mu.uHeightA, uHeightB: mu.uHeightB, uHeightInfo: mu.uHeightInfo, uRing: { value: new THREE.Vector4() }, uClipCam: { value: new THREE.Vector3() } },
        side: THREE.DoubleSide,
        colorWrite: false,
      });
      mesh.userData.depthMaterial = dm;
      mesh.userData.castShadow = true;
      mesh.layers.enable(2);
    }
    this.group.add(this.clipmap.group);
    this.updateHeights(world.fullRect());
    this.updateGround(world.fullRect());
    this.buildRing();
    this.ready = true;
  }

  /** Rebuild height LODs + normal/AO for a grid rect. */
  updateHeights(rect) {
    const world = this.world;
    const res = world.res;
    const h = world.hFinal.data;
    const wet = world.water.type;
    // LOD pyramid: point-sampled, but min-filtered where water is present so coarse terrain
    // never pokes through (or buries) a narrow river
    let x0 = rect.x0,
      z0 = rect.z0,
      x1 = rect.x1,
      z1 = rect.z1;
    for (let l = 1; l < this.levels; l++) {
      const r = ((res - 1) >> l) + 1;
      const pr = ((res - 1) >> (l - 1)) + 1;
      const prev = this.heightData[l - 1];
      const out = this.heightData[l];
      const step = 1 << l;
      x0 = Math.max(0, (x0 >> 1) - 1);
      z0 = Math.max(0, (z0 >> 1) - 1);
      x1 = Math.min(r - 1, (x1 >> 1) + 1);
      z1 = Math.min(r - 1, (z1 >> 1) + 1);
      for (let j = z0; j <= z1; j++) {
        for (let i = x0; i <= x1; i++) {
          const pi = Math.min(pr - 1, i * 2),
            pj = Math.min(pr - 1, j * 2);
          let v = prev[pj * pr + pi];
          const fi = Math.min(res - 1, i * step),
            fj = Math.min(res - 1, j * step);
          // any water within the footprint?
          let hasW = false;
          const hs = step >> 1;
          for (let dz = -hs; dz <= hs && !hasW; dz += Math.max(1, hs >> 1)) {
            for (let dx = -hs; dx <= hs; dx += Math.max(1, hs >> 1)) {
              const xx = fi + dx,
                zz = fj + dz;
              if (xx >= 0 && zz >= 0 && xx < res && zz < res && wet[zz * res + xx]) {
                hasW = true;
                break;
              }
            }
          }
          if (hasW) {
            for (let dz = -1; dz <= 1; dz++) {
              for (let dx = -1; dx <= 1; dx++) {
                const xx = pi + dx,
                  zz = pj + dz;
                if (xx >= 0 && zz >= 0 && xx < pr && zz < pr) v = Math.min(v, prev[zz * pr + xx]);
              }
            }
          }
          out[j * r + i] = v;
        }
      }
    }
    for (const t of this.heightTex) t.needsUpdate = true;
    this._bakeNormalAO(rect);
    this.normalTex.needsUpdate = true;
  }

  _bakeNormalAO(rect) {
    const toHalf = THREE.DataUtils.toHalfFloat;
    const world = this.world;
    const res = world.res;
    const h = world.hFinal.data;
    const cell = world.hFinal.cell;
    const out = this.normalData8;
    const pad = 24;
    const x0 = Math.max(0, rect.x0 - pad),
      x1 = Math.min(res - 1, rect.x1 + pad),
      z0 = Math.max(0, rect.z0 - pad),
      z1 = Math.min(res - 1, rect.z1 + pad);
    // horizon-based ambient occlusion: 8 directions, 4 exponentially spaced steps
    const dirs = [];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + 0.3;
      dirs.push([Math.cos(a), Math.sin(a)]);
    }
    const steps = [1.5, 4, 10, 24];
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const i = z * res + x;
        const xm = x > 0 ? i - 1 : i,
          xp = x < res - 1 ? i + 1 : i,
          zm = z > 0 ? i - res : i,
          zp = z < res - 1 ? i + res : i;
        const gx = (h[xp] - h[xm]) / ((xp - xm) * cell || cell);
        const gz = (h[zp] - h[zm]) / (((zp - zm) / res) * cell || cell);
        const l = 1 / Math.hypot(gx, 1, gz);
        const nx = -gx * l,
          nz = -gz * l;
        const hc = h[i];
        let occ = 0;
        for (let k = 0; k < 8; k++) {
          let maxTan = -1e9;
          const dxk = dirs[k][0],
            dzk = dirs[k][1];
          for (let s = 0; s < 4; s++) {
            const sx = Math.round(x + dxk * steps[s]),
              sz = Math.round(z + dzk * steps[s]);
            if (sx < 0 || sz < 0 || sx >= res || sz >= res) continue;
            const t = (h[sz * res + sx] - hc) / (steps[s] * cell);
            if (t > maxTan) maxTan = t;
          }
          // horizon angle relative to the tangent plane in this direction
          const tanPlane = gx * dxk + gz * dzk;
          const el = Math.atan(maxTan) - Math.atan(tanPlane);
          if (el > 0) occ += Math.sin(Math.min(el, 1.4));
        }
        const ao = Math.max(0.25, 1 - (occ / 8) * 1.15);
        const o = i * 4;
        out[o] = toHalf(nx);
        out[o + 1] = toHalf(nz);
        out[o + 2] = toHalf(ao);
        out[o + 3] = 15360; // 1.0
      }
    }
  }

  /** Upload ground weights for a rect (the whole texture is re-uploaded; mipmaps regenerate). */
  updateGround(rect) {
    const world = this.world;
    const res = world.res;
    const src = world.weights;
    const a = this.w0Data,
      b = this.w1Data;
    for (let z = rect.z0; z <= rect.z1; z++) {
      let s = (z * res + rect.x0) * 8;
      let d = (z * res + rect.x0) * 4;
      for (let x = rect.x0; x <= rect.x1; x++) {
        a[d] = src[s];
        a[d + 1] = src[s + 1];
        a[d + 2] = src[s + 2];
        a[d + 3] = src[s + 3];
        b[d] = src[s + 4];
        b[d + 1] = src[s + 5];
        b[d + 2] = src[s + 6];
        b[d + 3] = src[s + 7];
        s += 8;
        d += 4;
      }
    }
    this.w0Tex.needsUpdate = true;
    this.w1Tex.needsUpdate = true;
  }

  /** Static surrounding terrain: the generated ring (same landscape evolution run) + a far horizon ring. */
  buildRing() {
    if (this.ringMesh) {
      this.group.remove(this.ringMesh);
      this.ringMesh.geometry.dispose();
      this.ringMesh = null;
    }
    const world = this.world;
    const ring = world.ring;
    const size = world.size;
    const half = size / 2;
    const P = world.project;
    const rules = { snowLine: 2350, treeLine: 2050, ...(P.materials?.rules || {}) };
    const noise = new Noise2D(hash32(P.seed, 811));
    const sea = world.seaLevel;
    const positions = [];
    const normals = [];
    const w0 = [];
    const w1 = [];
    const indices = [];
    const datum = P.terrain.baseAltitude || 0;
    // height function for the outside world
    const ringSample = (x, z) => {
      if (!ring) return null;
      const rh = ring.size / 2;
      if (Math.abs(x) > rh || Math.abs(z) > rh) return null;
      const g = (ring.res - 1) / ring.size;
      return sampleGrid(ring.data, ring.res, (x + rh) * g, (z + rh) * g);
    };
    const farH = (x, z) => {
      // analytic far mountains / plains; coast preset keeps open sea towards -x
      const r = Math.hypot(x, z);
      const n = noise.ridged(x / 5200, z / 5200, 5, 2.05, 0.5) * 0.85 + noise.fbm(x / 1900, z / 1900, 3) * 0.15;
      const amp = P.terrain.preset === 'alpine' ? 1500 : P.terrain.preset === 'coast' ? 340 : 520;
      let h = datum + n * amp * smoothstep(size * 0.8, size * 3.5, r) + (P.terrain.preset === 'alpine' ? 240 : 30);
      if (P.terrain.preset === 'coast') {
        const land = smoothstep(-900, 1500, x + noise.fbm(z / 3000, 1.7, 2) * 1400);
        h = datum - 40 + (h - datum + 40) * land;
      }
      return h;
    };
    const outerH = (x, z) => {
      const rs = ringSample(x, z);
      const fh = farH(x, z);
      if (rs === null) return fh;
      const rh = ring.size / 2;
      const e = Math.max(Math.abs(x), Math.abs(z));
      const t = smoothstep(rh * 0.72, rh * 0.99, e);
      return rs + (fh - rs) * t;
    };
    const innerH = (x, z) => world.hFinal.sample(Math.max(-half, Math.min(half, x)), Math.max(-half, Math.min(half, z)));
    const heightAt = (x, z) => {
      // match the editable terrain exactly at its border, then relax to the ring
      const e = Math.max(Math.abs(x), Math.abs(z)) - half;
      const o = outerH(x, z);
      if (e > 60) return o;
      const o2 = outerH(Math.max(-half, Math.min(half, x)), Math.max(-half, Math.min(half, z)));
      const corr = innerH(x, z) - o2;
      return o + corr * (1 - smoothstep(0, 60, Math.max(0, e)));
    };
    const addVertex = (x, z, drop = 0) => {
      const y = heightAt(x, z) - drop;
      const e = 14;
      const gx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
      const gz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
      const l = 1 / Math.hypot(gx, 1, gz);
      positions.push(x, y, z);
      normals.push(-gx * l, l, -gz * l);
      // simplified ground rules for distant terrain
      const slope = Math.hypot(gx, gz);
      const n1 = noise.fbm(x / 160, z / 160, 3);
      const rock = smoothstep(0.75, 1.15, slope + n1 * 0.15);
      const snow = smoothstep(rules.snowLine - 150, rules.snowLine + 150, y + n1 * 120) * (1 - smoothstep(0.9, 1.3, slope));
      const alpine = smoothstep(rules.treeLine - 120, rules.treeLine + 160, y + n1 * 90);
      const scree = Math.max(smoothstep(0.5, 0.8, slope) * (1 - rock) * 0.7, alpine * 0.5);
      const under = sea !== null && y < sea + 1.5 ? 1 : 0;
      let forest = (1 - alpine) * smoothstep(0.9, 0.6, slope) * smoothstep(-0.35, 0.1, n1 + 0.25) * (1 - under);
      let grass = (1 - forest) * (1 - under);
      const sand = under;
      const k = (1 - rock) * (1 - snow);
      forest *= k * (1 - scree);
      grass *= k * (1 - scree);
      w0.push(grass, forest, scree * k, sand * k);
      w1.push(0, 0, snow * (1 - rock), 0);
      return positions.length / 3 - 1;
    };
    // --- mid ring: regular grid, skipping quads inside the editable area ---
    const step = Math.max(12, size / 128);
    const ext = ring ? ring.size / 2 : size;
    const n = Math.round((2 * ext) / step);
    const vid = new Int32Array((n + 1) * (n + 1)).fill(-1);
    const inner = half - step * 0.5;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const x = -ext + i * step,
          z = -ext + j * step;
        if (Math.abs(x) < inner - step && Math.abs(z) < inner - step) continue;
        // vertices just inside the border sit slightly below the editable terrain
        const inside = Math.abs(x) < half && Math.abs(z) < half;
        vid[j * (n + 1) + i] = addVertex(x, z, inside ? 1.2 : 0);
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = vid[j * (n + 1) + i],
          b = vid[j * (n + 1) + i + 1],
          c = vid[(j + 1) * (n + 1) + i],
          d = vid[(j + 1) * (n + 1) + i + 1];
        if (a < 0 || b < 0 || c < 0 || d < 0) continue;
        indices.push(a, c, b, b, c, d);
      }
    }
    // --- far ring: polar grid out to the horizon ---
    const R0 = ext * 0.985,
      R1 = 46000;
    const NR = 56,
      NA = 320;
    const base = positions.length / 3;
    for (let r = 0; r <= NR; r++) {
      const t = r / NR;
      const rad = R0 * Math.pow(R1 / R0, t);
      for (let a = 0; a <= NA; a++) {
        const ang = (a / NA) * Math.PI * 2;
        // square-ish inner boundary to meet the mid ring
        const cx = Math.cos(ang),
          cz = Math.sin(ang);
        const sq = 1 / Math.max(Math.abs(cx), Math.abs(cz));
        const rr = rad * (1 + (sq - 1) * (1 - smoothstep(0, 0.35, t)));
        addVertex(cx * rr, cz * rr, r === 0 ? 2 : 0);
      }
    }
    for (let r = 0; r < NR; r++) {
      for (let a = 0; a < NA; a++) {
        const p = base + r * (NA + 1) + a;
        indices.push(p, p + 1, p + NA + 1, p + 1, p + NA + 2, p + NA + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
    g.setAttribute('aW0', new THREE.BufferAttribute(new Float32Array(w0), 4));
    g.setAttribute('aW1', new THREE.BufferAttribute(new Float32Array(w1), 4));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
    g.computeBoundingSphere();
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: RING_VERT,
      fragmentShader: TERRAIN_FRAG,
      uniforms: { ...this.G, ...this.matUniforms },
      defines: { RING: 1 },
      side: THREE.DoubleSide,
    });
    this.ringMesh = new THREE.Mesh(g, mat);
    this.ringMesh.frustumCulled = false;
    this.ringMesh.name = 'terrain-ring';
    this.group.add(this.ringMesh);
    this.ringHeightAt = heightAt;
  }

  update(camera) {
    if (!this.clipmap) return;
    const half = this.world.size / 2;
    this.clipmap.update(camera.position.x, camera.position.z, -half, -half);
  }

  setBrush(x, z, radius, strength, color) {
    this.matUniforms.uBrush.value.set(x, z, radius, strength);
    if (color) this.matUniforms.uBrushColor.value.set(color[0], color[1], color[2], color[3] ?? 1);
  }

  disposeWorld() {
    if (this.clipmap) {
      this.group.remove(this.clipmap.group);
      for (const m of this.clipmap.meshes) m.userData.depthMaterial?.dispose();
      this.clipmap.dispose();
      this.clipmap = null;
    }
    for (const t of this.heightTex) t.dispose();
    this.heightTex = [];
    for (const t of [this.normalTex, this.w0Tex, this.w1Tex]) if (t) t.dispose();
    if (this.ringMesh) {
      this.group.remove(this.ringMesh);
      this.ringMesh.geometry.dispose();
      this.ringMesh.material.dispose();
      this.ringMesh = null;
    }
    this.ready = false;
  }
}
