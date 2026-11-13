// Water surface rendering. One shader handles rivers, lakes and the sea; behaviour is driven by
// the CPU water field (surface elevation, depth-averaged velocity, foam, exposure, swell phase).
//  - geometry: camera-centred clipmap displaced by FFT wind waves, refracted swell and iWave ripples
//  - optics: Fresnel reflection (planar reflection of the scene + sky), screen-space refraction with
//    depth test, Beer-Lambert absorption and single-scattering body colour along the refracted path
//  - foam: river foam from the flow solve, whitecaps from the FFT Jacobian, breaking swell and swash
//  - underside: Snell's window / total internal reflection when the camera is submerged

import * as THREE from 'three';
import { Clipmap, CLIPMAP_VERT_GLSL } from './Clipmap.js';
import { NOISE_GLSL, GLOBALS_GLSL, SHADOW_GLSL, ATMOS_GLSL, DEPTH_GLSL } from './shaders/common.glsl.js';
import { CASCADE_LENGTHS } from './WaterSim.js';
import { NO_WATER } from '../core/waterField.js';

export const WATER_COMMON = /* glsl */ `
uniform highp sampler2D uWaterAf;   // same as uWaterA (declared in globals) - kept for clarity
uniform sampler2D uWaterB;          // r = river foam, g = wind exposure, b = type code, a = unused
uniform highp sampler2D uSurfLod;   // coarse max-filtered surface (for distant rings)
uniform highp sampler2D uSwell;     // r = phase, g = height factor, b = breaking
uniform highp sampler2D uTerrainH;
uniform sampler2D uDisp0; uniform sampler2D uDisp1; uniform sampler2D uDisp2; uniform sampler2D uDisp3;
uniform sampler2D uDeriv0; uniform sampler2D uDeriv1; uniform sampler2D uDeriv2; uniform sampler2D uDeriv3;
uniform sampler2D uRipple;
uniform vec4 uRippleWindow;         // xy centre, z size, w texel
uniform vec4 uCascadeL;
uniform vec4 uSwellParams;          // x = offshore height (m), y = omega, z = k0, w = swell enabled
uniform vec2 uSwellDir;
uniform vec4 uWaveScale;            // x = global wave scale, y = lake scale, z = river scale, w = foam amount
uniform vec2 uWindDir;
uniform vec2 uLakeWind;             // x = lake ripple amplitude from wind speed, y = amplitude in the calm lanes

// set by swellWave(): breaking intensity (0..1) and local wave height (m) of the wave at the last evaluated point
float gSwellBrk = 0.0; float gSwellH = 0.0;

struct WaterBase { float surf; vec2 vel; float shore; float foam; float expo; float ocean; float river; float lake; bool valid; };

WaterBase waterBaseAt(vec2 xz, float cellSize){
  WaterBase b; b.valid = false; b.surf = -1e5; b.vel = vec2(0.0); b.shore = 0.0; b.foam = 0.0; b.expo = 1.0; b.ocean = 0.0; b.river = 0.0; b.lake = 0.0;
  vec2 uv = (xz + uWorldRect.x) * uWorldRect.y;
  if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) {
    if (uSea.x > 0.5) { b.valid = true; b.surf = uSea.y; b.ocean = 1.0; b.shore = 64.0; b.expo = 1.0; }
    return b;
  }
  // The surface texture marks dry cells with a large negative sentinel, so filtering has to be
  // done by hand: bilinear only when all four texels are valid, otherwise the nearest valid one.
  vec2 ts = vec2(textureSize(uWaterA, 0));
  vec2 tc = uv * ts - 0.5;
  ivec2 i0 = ivec2(floor(tc));
  vec2 f = tc - vec2(i0);
  ivec2 mx = ivec2(ts) - 1;
  vec4 t00 = texelFetch(uWaterA, clamp(i0, ivec2(0), mx), 0);
  vec4 t10 = texelFetch(uWaterA, clamp(i0 + ivec2(1, 0), ivec2(0), mx), 0);
  vec4 t01 = texelFetch(uWaterA, clamp(i0 + ivec2(0, 1), ivec2(0), mx), 0);
  vec4 t11 = texelFetch(uWaterA, clamp(i0 + ivec2(1, 1), ivec2(0), mx), 0);
  vec4 a;
  bool v00 = t00.r > -5e4, v10 = t10.r > -5e4, v01 = t01.r > -5e4, v11 = t11.r > -5e4;
  bool fine = false;
  if (v00 && v10 && v01 && v11) { a = mix(mix(t00, t10, f.x), mix(t01, t11, f.x), f.y); fine = true; }
  else {
    vec4 n = f.x < 0.5 ? (f.y < 0.5 ? t00 : t01) : (f.y < 0.5 ? t10 : t11);
    if (n.r > -5e4) { a = n; fine = true; }
    else if (v00) { a = t00; fine = true; } else if (v10) { a = t10; fine = true; } else if (v01) { a = t01; fine = true; } else if (v11) { a = t11; fine = true; }
  }
  if (cellSize > 0.0 && (!fine || cellSize > uWorldRect.w * 3.5)) {
    // vertex stage of a coarse ring (or just outside the wet area): max-filtered surface keeps the mesh continuous
    vec4 l = textureLod(uSurfLod, uv, 0.0);
    if (l.r > -5e4) { if (fine) a.r = max(a.r, l.r); else a = vec4(l.r, 0.0, 0.0, l.a); fine = true; }
  }
  if (!fine) {
    // beyond the stored (extended) surface: on an open coast the run-up may still reach here
    if (uSea.x > 0.5) {
      float thh = textureLod(uTerrainH, uv, 0.0).r;
      if (thh < uSea.y + uSea.z + 2.5) { b.valid = true; b.surf = uSea.y; b.ocean = 1.0; b.shore = -1.0; b.expo = 0.3; }
    }
    return b;
  }
  vec4 w = textureLod(uWaterB, uv, 0.0);
  b.valid = true; b.surf = a.r; b.vel = a.gb; b.shore = a.a; b.foam = w.r; b.expo = w.g;
  b.ocean = smoothstep(0.78, 0.95, w.b);
  b.river = 1.0 - smoothstep(0.38, 0.6, w.b);
  b.lake = clamp(1.0 - b.ocean - b.river, 0.0, 1.0);
  return b;
}

float terrainHeightAt(vec2 xz){
  vec2 uv = (xz + uWorldRect.x) * uWorldRect.y;
  if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) return -1e4;
  return textureLod(uTerrainH, uv, 0.0).r;
}

// per-cascade amplitude weights for the local water body
vec4 cascadeWeights(WaterBase b, float depth, vec2 xz){
  // gusts: slowly travelling patches of stronger / weaker ripples (cat's paws)
  // (light wind: glassy lanes between ruffled patches; strong wind: uniformly rough)
  float gn = smoothstep(0.25, 0.75, fbm2(xz * 0.012 - uWindDir * uTime * 0.035));
  float gust = mix(uLakeWind.y, 1.25, gn);
  vec4 wo = vec4(1.0);
  // fetch-limited spectrum: on a lake the energy sits in the short cascades; amplitude follows the wind
  vec4 wl = vec4(0.0, 0.85, 1.0, 1.0) * uWaveScale.y * uLakeWind.x * gust;
  vec4 wr = vec4(0.0, 0.0, 0.08, 0.45) * uWaveScale.z;
  // the lake spectrum is already fetch-limited; local exposure only shelters the upwind margin
  vec4 w = (wo * b.ocean * b.expo + wl * b.lake * (0.35 + 0.65 * sqrt(b.expo)) + wr * b.river * b.expo) * uWaveScale.x;
  // depth limitation: a wave cannot be much higher than the water is deep
  vec4 dlim = vec4(6.5, 1.6, 0.5, 0.22);
  w *= clamp(vec4(max(depth, 0.0)) / dlim, 0.0, 1.0);
  return w;
}

// Standing waves of fast shallow water (the current runs through them; they stay in place):
// irregular stationary humps with length scale ~ v^2 / g, in patches, with a slight shimmer.
float riverStandingH(vec2 xz, float speed, float froude, float depth){
  // Fixed length scales, blended by speed. (Scaling the coordinates by a spatially varying
  // wavelength would shear the pattern into contour stripes wherever the speed changes.)
  vec2 wob = 0.05 * vec2(sin(uTime * 1.7 + xz.y * 0.9), cos(uTime * 1.3 + xz.x * 0.8));
  float fast = smoothstep(1.2, 2.6, speed);
  float hS = vnoise(xz / 0.55 + wob) + 0.45 * vnoise(xz / 0.24 + 5.1 + wob);
  float hL = vnoise(xz / 1.5 + wob + 9.0) + 0.45 * vnoise(xz / 0.65 + 3.3 + wob);
  float patchK = smoothstep(0.28, 0.62, vnoise(xz * 0.2 + 4.0)) * smoothstep(0.35, 0.85, froude) * smoothstep(0.5, 1.2, speed) * smoothstep(0.06, 0.25, depth);
  return ((hS - 0.72) * 0.11 * (1.0 - fast) + (hL - 0.72) * 0.3 * fast) * patchK;
}

// Refracted swell: phase from the eikonal solve, shape steepening with shoaling, depth-limited
// breaking per wave. Returns height; slope = (d/dx, d/dz);
// info = (roller: active breaking crest, run-up height, wake: decaying foam left behind the bore)
float swellWave(vec2 xz, float depth, float shore, float ocean, out vec2 slope, out vec3 info, out vec4 frame){
  slope = vec2(0.0); info = vec3(0.0); frame = vec4(0.0, 0.0, 1.0, 0.0);
  if (uSwellParams.w < 0.5 || ocean < 0.01) return 0.0;
  float size = uWorldRect.x * 2.0;
  vec2 uvr = (xz + uWorldRect.x) * uWorldRect.y;
  vec2 uv = clamp(uvr, vec2(0.002), vec2(0.998));
  vec2 ts = 1.0 / vec2(textureSize(uSwell, 0));
  vec4 s = textureLod(uSwell, uv, 0.0);
  float cellS = size * ts.x;
  float pe = textureLod(uSwell, uv + vec2(ts.x, 0.0), 0.0).r, pw = textureLod(uSwell, uv - vec2(ts.x, 0.0), 0.0).r;
  float ps = textureLod(uSwell, uv + vec2(0.0, ts.y), 0.0).r, pn = textureLod(uSwell, uv - vec2(0.0, ts.y), 0.0).r;
  vec2 kv = vec2(pe - pw, ps - pn) / (2.0 * cellS);
  float phase = s.r;
  float Hf = s.g;
  if (uvr != uv) {
    // open sea outside the solved domain: continue as a plane wave
    vec2 outside = xz - (uv / uWorldRect.y - uWorldRect.x);
    kv = uSwellDir * uSwellParams.z;
    phase += dot(outside, kv);
    Hf = mix(Hf, 1.0, clamp(length(outside) / 400.0, 0.0, 1.0));
  }
  float kl = clamp(length(kv), 1e-4, 1.2);
  float th = phase - uSwellParams.y * uTime;
  // Every wave of the train has its own height: sets of bigger waves (groups) and variation along
  // the crest. The noise is indexed by the wave number so it travels with that wave.
  float widx = floor((phase - uSwellParams.y * uTime) / 6.2831853 + 0.5);
  float along = vnoise(xz * 0.021 + widx * 7.31);
  float setN = vnoise(vec2(widx * 0.37, 1.7));
  float grp = (0.62 + 0.55 * setN) * (0.8 + 0.4 * along);
  float Hloc = uSwellParams.x * Hf * grp * ocean;
  float Hb = 0.78 * max(depth, 0.04);
  float brk = smoothstep(0.82, 1.0, Hloc / Hb);
  float H = min(Hloc, Hb);
  gSwellBrk = brk; gSwellH = H;
  // shallow-water shape: peaked crests, flat troughs; front face steepens towards breaking
  float shallow = clamp(1.0 - kl * max(depth, 0.0) * 1.1, 0.0, 1.0);
  float lean = (0.3 + 0.62 * brk) * shallow;
  float thl = th + lean * sin(th);
  float c = 0.5 + 0.5 * cos(thl);
  float p = mix(1.0, 3.0, shallow);
  float prof = pow(c, p);
  float mean = mix(0.5, 0.34, shallow);
  float y = H * (prof - mean);
  float dprof = p * pow(max(c, 1e-4), p - 1.0) * (-0.5 * sin(thl)) * (1.0 + lean * cos(th));
  slope = kv * (H * dprof);
  // second, shorter train for irregularity (deep water only)
  float th2 = phase * 1.31 - uSwellParams.y * 1.1446 * uTime + 1.7;
  float H2 = uSwellParams.x * Hf * ocean * 0.3 * (1.0 - shallow) * (1.0 - brk);
  y += H2 * 0.5 * cos(th2);
  slope += kv * 1.31 * (-H2 * 0.5 * sin(th2));
  // tb: fraction of a period since this wave's crest passed (0 at the crest, grows behind it)
  float tb = fract(-thl / 6.2831853);
  float ahead = 1.0 - tb;                                  // just in front of the crest: ~0
  float rw = 0.05 + 0.08 * along;                            // roller width varies along the crest
  float inner = smoothstep(0.25, 1.0, s.b);                  // saturated breaking: the wave has become a bore
  rw += 0.16 * inner;
  float roller = (smoothstep(rw, rw * 0.35, tb) + smoothstep(0.05, 0.0, ahead)) * brk;
  // foam generated by the breaker persists and thins over ~half a period behind it; in the inner
  // surf zone (saturated breaking) the next bore arrives before it has gone
  float period = 6.2831853 / max(uSwellParams.y, 0.1);
  float wake = brk * exp(-tb * 3.0) * 0.95 + inner * 0.55 * exp(-tb * 1.3);
  info.x = clamp(roller, 0.0, 1.0);
  info.z = clamp(wake, 0.0, 1.0);
  // wave-attached frame for foam patterns: (phase, distance along the crest), propagation direction
  vec2 kd = kv / kl;
  // (only smooth quantities: anything like dot(xz, direction) decorrelates far from the origin)
  frame = vec4(thl, uSwellParams.y / kl, kd);   // phase, phase speed (m/s), direction of travel
  // run-up: the surface near the waterline rises and falls so the swash sweeps the beach
  float ru = pow(0.5 + 0.5 * cos(th - 0.6), 2.0) * (0.55 + 0.6 * setN);
  float near = exp(-max(shore, 0.0) / 9.0);
  info.y = uSea.z * ru * near * ocean;
  y += info.y;
  return y;
}

// Surface elevation at a world position near the camera: the same sum the vertex stage builds at
// the finest mesh level (cell = mesh cell size), used to place the waterline on the lens exactly
// where the rendered surface meets it.
float waterSurfaceNear(vec2 p, float cell, out bool valid){
  vec2 xz = p; float y = -1e5; valid = false;
  for (int it = 0; it < 2; it++) {
    WaterBase b = waterBaseAt(xz, 0.0);
    if (!b.valid) return y;
    valid = true;
    float th = terrainHeightAt(xz);
    float depth = th < -9e3 ? 60.0 : b.surf - th;
    vec4 w = cascadeWeights(b, depth, xz);
    vec4 lod = max(log2(vec4(cell) / (uCascadeL / 256.0)), vec4(0.0));
    vec3 d = vec3(0.0);
    if (w.x > 0.0) d += textureLod(uDisp0, xz / uCascadeL.x, lod.x).xyz * w.x;
    if (w.y > 0.0) d += textureLod(uDisp1, xz / uCascadeL.y, lod.y).xyz * w.y;
    if (w.z > 0.0) d += textureLod(uDisp2, xz / uCascadeL.z, lod.z).xyz * w.z;
    if (w.w > 0.0) d += textureLod(uDisp3, xz / uCascadeL.w, lod.w).xyz * w.w;
    d.xz *= smoothstep(0.3, 3.0, depth);
    vec2 sl; vec3 info; vec4 fr;
    float sw = swellWave(xz, depth, b.shore, b.ocean, sl, info, fr);
    if (info.x > 0.0) sw += info.x * gSwellH * 0.3 * (0.35 + 0.9 * vnoise(xz * 0.9 + fr.zw * uTime * 2.0) + 0.5 * vnoise(xz * 2.7 - uTime));
    vec2 ruv = (xz - uRippleWindow.xy) / uRippleWindow.z + 0.5;
    float rip = 0.0;
    if (ruv.x > 0.0 && ruv.y > 0.0 && ruv.x < 1.0 && ruv.y < 1.0) {
      vec2 e = min(ruv, 1.0 - ruv);
      rip = textureLod(uRipple, ruv, 0.0).r * smoothstep(0.0, 0.05, min(e.x, e.y));
    }
    float stand = 0.0;
    if (b.river > 0.01) {
      float spd = length(b.vel);
      stand = riverStandingH(xz, spd, spd / sqrt(9.81 * max(depth, 0.05)), depth) * b.river * uWaveScale.z;
    }
    y = b.surf + d.y + sw + rip + stand;
    if (it == 0) xz = p - d.xz;   // undo the horizontal (choppy) displacement to first order
  }
  return y;
}

`;

const WATER_VERT = /* glsl */ `
precision highp float;
${GLOBALS_GLSL}
${NOISE_GLSL}
${CLIPMAP_VERT_GLSL}
${WATER_COMMON}
out vec3 vWorld;
out vec2 vBaseXZ;
out float vViewDepth;
out float vInvalid;
void main(){
  float morph; vec2 coarse;
  vec2 xz = clipmapPos(position.xy, morph, coarse);
  float cell = uRing.x * (1.0 + morph);
  WaterBase b = waterBaseAt(xz, cell);
  vInvalid = b.valid ? 0.0 : 1.0;
  float surf = b.valid ? b.surf : (uSea.x > 0.5 ? uSea.y : uCamPos.y - 500.0);
  float th = terrainHeightAt(xz);
  float depth = th < -9e3 ? 60.0 : surf - th;
  vec4 w = cascadeWeights(b, depth, xz);
  vec3 d = vec3(0.0);
  vec4 texel = uCascadeL / 256.0;
  vec4 lod = log2(vec4(cell) / texel);
  float distFade = 1.0;
  if (lod.x < 7.0 && w.x > 0.0) d += textureLod(uDisp0, xz / uCascadeL.x, max(lod.x, 0.0)).xyz * w.x;
  if (lod.y < 7.0 && w.y > 0.0) d += textureLod(uDisp1, xz / uCascadeL.y, max(lod.y, 0.0)).xyz * w.y;
  if (lod.z < 7.0 && w.z > 0.0) d += textureLod(uDisp2, xz / uCascadeL.z, max(lod.z, 0.0)).xyz * w.z;
  if (lod.w < 7.0 && w.w > 0.0) d += textureLod(uDisp3, xz / uCascadeL.w, max(lod.w, 0.0)).xyz * w.w;
  // keep horizontal (choppy) motion away from the shore so the mesh never slides into the bank
  d.xz *= smoothstep(0.3, 3.0, depth);
  vec2 sl; vec3 info; vec4 wframe;
  float sw = swellWave(xz, depth, b.shore, b.ocean, sl, info, wframe);
  // the breaking crest carries a tumbling mass of aerated water: lumpy extra height on the roller
  if (info.x > 0.0 && cell < 2.0) sw += info.x * gSwellH * 0.3 * (0.35 + 0.9 * vnoise(xz * 0.9 + wframe.zw * uTime * 2.0) + 0.5 * vnoise(xz * 2.7 - uTime));
  // interactive ripples
  vec2 ruv = (xz - uRippleWindow.xy) / uRippleWindow.z + 0.5;
  float rip = 0.0;
  if (ruv.x > 0.0 && ruv.y > 0.0 && ruv.x < 1.0 && ruv.y < 1.0 && cell < 1.0) {
    vec2 e = min(ruv, 1.0 - ruv);
    rip = textureLod(uRipple, ruv, 0.0).r * smoothstep(0.0, 0.05, min(e.x, e.y));
  }
  float stand = 0.0;
  if (b.river > 0.01 && cell < 1.2) {
    float spd = length(b.vel);
    stand = riverStandingH(xz, spd, spd / sqrt(9.81 * max(depth, 0.05)), depth) * b.river * uWaveScale.z;
  }
  vec3 wp = vec3(xz.x + d.x, surf + d.y + sw + rip + stand, xz.y + d.z);
  vWorld = wp; vBaseXZ = xz;
  vec4 vp = viewMatrix * vec4(wp, 1.0);
  vViewDepth = -vp.z;
  gl_Position = projectionMatrix * vp;
}
`;

const WATER_FRAG = /* glsl */ `
precision highp float;
${GLOBALS_GLSL}
${NOISE_GLSL}
${DEPTH_GLSL}
${SHADOW_GLSL}
${ATMOS_GLSL}
${WATER_COMMON}
in vec3 vWorld; in vec2 vBaseXZ; in float vViewDepth; in float vInvalid;
uniform sampler2D uScene;
uniform highp sampler2D uSceneDepth;
uniform sampler2D uRefl;
uniform mat4 uReflMatrix;
uniform float uReflLevel;
uniform float uReflValid;
uniform sampler2D uFoamTex;
uniform vec2 uResolution;
uniform mat4 uInvViewProj;
uniform mat4 uViewProj;
uniform vec4 uSlopeVar;      // slope variance of each cascade (for unresolved-detail roughness)
uniform float uCamUnder;     // 1 when the camera is below the surface
uniform float uFlowViz;      // 1: draw the flow-speed overlay
out vec4 outColor;

vec3 shIrr(vec3 n){
  return uSH[0] + uSH[1] * n.y + uSH[2] * n.z + uSH[3] * n.x + uSH[4] * (n.x*n.y) + uSH[5] * (n.y*n.z) + uSH[6] * (3.0*n.z*n.z - 1.0) + uSH[7] * (n.x*n.z) + uSH[8] * (n.x*n.x - n.y*n.y);
}
float depthFromLinear(float z){
#ifdef USE_REVERSED_DEPTH_BUFFER
  return uProjInfo.y / z - uProjInfo.x;
#else
  return (uProjInfo.y / z - uProjInfo.x) * 0.5 + 0.5;
#endif
}
vec3 worldFromDepth(vec2 uv, float d){
  vec4 p = uInvViewProj * vec4(uv * 2.0 - 1.0,
#ifdef USE_REVERSED_DEPTH_BUFFER
    d,
#else
    d * 2.0 - 1.0,
#endif
    1.0);
  return p.xyz / p.w;
}
// slope of one cascade, with the choppiness (Jacobian) correction
vec2 cascadeSlope(sampler2D t, vec2 uv, float w, float chop){
  vec4 d = texture(t, uv);
  return d.xy / (1.0 + chop * w * d.z * 0.0 + 0.0) * w;
}
// two-phase flow advection of a tiling texture lookup (hides the periodic reset with per-area phase offsets)
vec2 flowSlope(sampler2D t, vec2 xz, vec2 vel, float scale, float period, float seed){
  float n = vnoise(xz * 0.13 + seed) ;
  float ph = uTime / period + n;
  float p0 = fract(ph), p1 = fract(ph + 0.5);
  vec2 uv0 = (xz - vel * (p0 - 0.5) * period) / scale + seed;
  vec2 uv1 = (xz - vel * (p1 - 0.5) * period) / scale + seed + 0.37;
  float w0 = 1.0 - abs(2.0 * p0 - 1.0), w1 = 1.0 - w0;
  // normalise so blending two uncorrelated slope fields keeps the variance
  return (texture(t, uv0).xy * w0 + texture(t, uv1).xy * w1) / sqrt(w0 * w0 + w1 * w1);
}
float flowFoam(vec2 xz, vec2 vel, float scale, float period, float seed, out float lace){
  float n = vnoise(xz * 0.21 + seed * 3.1);
  float ph = uTime / period + n;
  float p0 = fract(ph), p1 = fract(ph + 0.5);
  vec2 uv0 = (xz - vel * (p0 - 0.5) * period) / scale + seed;
  vec2 uv1 = (xz - vel * (p1 - 0.5) * period) / scale + seed + 0.41;
  float w0 = 1.0 - abs(2.0 * p0 - 1.0);
  vec4 a = texture(uFoamTex, uv0), b = texture(uFoamTex, uv1);
  vec4 m = mix(b, a, w0);
  lace = m.a;
  return m.r * 0.6 + m.g * 0.4;
}

void main(){
  if (vInvalid > 0.001) discard;
  vec2 xz = vBaseXZ;
  WaterBase b = waterBaseAt(xz, 0.0);
  if (!b.valid) discard;
  vec3 wp = vWorld;
  vec3 toCam = uCamPos - wp;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec2 suv = gl_FragCoord.xy / uResolution;
  bool under = !gl_FrontFacing;

  // ---- scene behind the surface ----
  float sd = texture(uSceneDepth, suv).r;
  float sceneZ = isSkyDepth(sd) ? 1e6 : linearDepth(sd);
  vec3 sceneW = worldFromDepth(suv, sd);
  float th = terrainHeightAt(xz);
  float bedDepth = th < -9e3 ? 60.0 : b.surf - th;         // still-water depth of the column
  float vertDepth = under ? 0.5 : max(wp.y - sceneW.y, 0.0);
  float thick = max(sceneZ - vViewDepth, 0.0) * (dist / max(vViewDepth, 1e-3));
  // Thin water (swash sheet, lake margin): the waterline is decided analytically - interpolated
  // surface against the full-resolution terrain height - not by the intersection of two meshes
  // with different tessellation, which would break up into polygons on a flat beach. Inside the
  // analytic wet area the surface is pulled towards the camera a little so the coarser terrain
  // mesh cannot poke through the film.
  float thW = terrainHeightAt(wp.xz);
  float film = thW < -9e3 ? 60.0 : wp.y - thW;
  float thinK = 1.0 - smoothstep(0.2, 0.8, film);
  float lift = 0.0;
  gl_FragDepth = gl_FragCoord.z;
  if (!under) {
    if (film < 0.0) discard;
    lift = (0.1 + 0.012 * vViewDepth) * thinK;
    if (sceneZ < vViewDepth - 0.01 - lift) discard;
    gl_FragDepth = depthFromLinear(max(vViewDepth - lift, 0.02));
    // within the film the terrain under the water defines its thickness (objects standing in it still use the scene)
    if (sceneZ < vViewDepth + 0.3 + lift) vertDepth = mix(vertDepth, film, thinK);
  }

  // ---- wave field at this pixel ----
  vec4 cw = cascadeWeights(b, bedDepth, xz);
  vec2 slope = vec2(0.0);
  vec2 duv = fwidth(xz);
  float px = max(duv.x, duv.y);                  // world size of a pixel on the surface
  vec4 texel = uCascadeL / 256.0;
  // unresolved slope variance (waves smaller than a pixel) widens the specular lobe instead of aliasing
  vec4 unres = clamp(log2(max(vec4(px) / texel, vec4(1e-3))) / 6.0, 0.0, 1.0);
  float lostVar = dot(uSlopeVar * cw * cw, unres);
  if (cw.x > 0.0) slope += texture(uDeriv0, xz / uCascadeL.x).xy * cw.x;
  if (cw.y > 0.0) slope += texture(uDeriv1, xz / uCascadeL.y).xy * cw.y;
  if (cw.z > 0.0) slope += texture(uDeriv2, xz / uCascadeL.z).xy * cw.z;
  if (cw.w > 0.0) slope += texture(uDeriv3, xz / uCascadeL.w).xy * cw.w;
  // whitecap foam from the FFT Jacobian (only meaningful for the long cascades at sea)
  float capFoam = 0.0;
  if (b.ocean > 0.01) capFoam = (texture(uDisp0, xz / uCascadeL.x).a * 0.9 + texture(uDisp1, xz / uCascadeL.y).a * 0.6 + texture(uDisp2, xz / uCascadeL.z).a * 0.3) * b.ocean * b.expo * smoothstep(2.0, 6.0, bedDepth);

  vec2 swSlope; vec3 swInfo; vec4 swFrame;
  swellWave(xz, bedDepth, b.shore, b.ocean, swSlope, swInfo, swFrame);
  slope += swSlope;

  // ---- river surface: turbulence advected with the flow, standing waves in fast shallow water ----
  float speed = length(b.vel);
  float froude = speed / sqrt(9.81 * max(bedDepth, 0.05));
  float turb = 0.0;
  float standK = 0.0;   // crest of a standing wave (breaks into foam when steep)
  if (b.river > 0.01 && speed > 0.02) {
    turb = smoothstep(0.12, 0.95, froude) * smoothstep(0.1, 0.8, speed);
    float calm = 0.05 + 0.12 * smoothstep(0.05, 0.6, speed);
    float amp = (calm + 0.9 * turb) * b.river * uWaveScale.z;
    // broad undulations and boils dominate; fine capillary texture only where the flow is turbulent
    vec2 fs = flowSlope(uDeriv2, xz, b.vel, 14.0, 2.4, 0.0) * 0.9 + flowSlope(uDeriv2, xz, b.vel * 0.9, 4.7, 1.5, 0.5) * 0.55;
    fs += flowSlope(uDeriv3, xz, b.vel, 2.9, 1.0, 0.23) * (0.1 + 0.5 * turb);
    // soft limit: flow mapping stretches the slope field where the velocity changes quickly, which
    // would show as thin bright filaments in the reflection
    fs *= amp;
    fs /= 1.0 + length(fs) * 2.2;
    slope += fs;
    // standing waves: the same stationary humps the vertex stage displaces, shaded per pixel
    float e_ = 0.07;
    float h0_ = riverStandingH(xz, speed, froude, bedDepth);
    float hx_ = riverStandingH(xz + vec2(e_, 0.0), speed, froude, bedDepth);
    float hz_ = riverStandingH(xz + vec2(0.0, e_), speed, froude, bedDepth);
    slope += vec2(hx_ - h0_, hz_ - h0_) / e_ * b.river * uWaveScale.z;
    standK = clamp(h0_ * 9.0, 0.0, 1.0);
    lostVar += turb * turb * 0.01 * unres.w;
  }
  // ---- interactive ripples ----
  float splash = 0.0;
  vec2 ruv = (xz - uRippleWindow.xy) / uRippleWindow.z + 0.5;
  if (ruv.x > 0.002 && ruv.y > 0.002 && ruv.x < 0.998 && ruv.y < 0.998) {
    float rt = 1.0 / float(textureSize(uRipple, 0).x);
    float hx = texture(uRipple, ruv + vec2(rt, 0.0)).r - texture(uRipple, ruv - vec2(rt, 0.0)).r;
    float hz = texture(uRipple, ruv + vec2(0.0, rt)).r - texture(uRipple, ruv - vec2(0.0, rt)).r;
    vec2 e = min(ruv, 1.0 - ruv);
    float rfade = smoothstep(0.0, 0.05, min(e.x, e.y));
    vec2 rs = vec2(hx, hz) / (2.0 * uRippleWindow.w) * rfade;
    slope += rs;
    // violent disturbance (an object plunging in, a bow pushing water): the surface breaks into
    // a short-lived splash of aerated water where the ripple field is steep
    splash = smoothstep(0.35, 0.9, length(rs)) * rfade;
  }
  // slopes fade with distance (mip filtering does most of it; this kills residual shimmer at the horizon)
  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
  if (under) N = -N;
  float NoV = clamp(dot(N, V), 0.0, 1.0);

  // ---- shoreline blend factors ----
  float edge = under ? 1.0 : smoothstep(0.0, 0.035, vertDepth);
  float shallowK = 1.0 - smoothstep(0.0, 0.5, vertDepth);

  // ---- lighting at the surface ----
  float shadow = sunShadow(wp, vec3(0.0, 1.0, 0.0), vViewDepth) * cloudShadowAt(wp);
  vec3 sunL = uSunColor * shadow;
  vec3 skyIrr = max(shIrr(vec3(0.0, 1.0, 0.0)), vec3(0.0));

  // ---- foam coverage ----
  float lace;
  float pat;
  float foamCov = 0.0;
  float riverThick = 0.0;
  if (b.river > 0.01) {
    // foam from the flow solve, carried by the current: rafts where it is dense, lace and streaks
    // where it thins out downstream
    float l2;
    pat = flowFoam(xz, b.vel, 2.3, 1.2, 0.0, lace);
    float p2 = flowFoam(xz, b.vel * 0.9, 6.5, 1.9, 0.31, l2);
    float f = clamp(b.foam + standK * turb * 0.9, 0.0, 1.0) * b.river;
    float dens = f * (0.55 + 0.9 * p2);
    // aerated white water: soft billows (two noise scales carried by the flow), fine bubbles on top
    float billow = fbm2((xz - b.vel * (fract(uTime * 0.5) - 0.5) * 2.0) * 1.9) * (1.0 - abs(2.0 * fract(uTime * 0.5) - 1.0)) + fbm2((xz - b.vel * (fract(uTime * 0.5 + 0.5) - 0.5) * 2.0) * 1.9 + 7.7) * abs(2.0 * fract(uTime * 0.5) - 1.0);
    float shape = pat * 0.5 + p2 * 0.2 + billow * 0.55;
    foamCov = smoothstep(1.02 - dens, 1.2 - dens * 0.8, shape + dens * 0.25) * smoothstep(0.03, 0.14, f);
    riverThick = smoothstep(0.5, 0.95, dens) * smoothstep(0.4, 0.8, pat);
  } else {
    vec4 ft = texture(uFoamTex, xz / 4.3 + uWindDir * uTime * 0.01), ft2 = texture(uFoamTex, xz / 13.0 - uWindDir * uTime * 0.004 + 0.3);
    pat = ft.r * 0.5 + ft.g * 0.3 + ft2.r * 0.2; lace = max(ft.a, ft2.a * 0.7);
  }
  float foamThick = 0.0;   // 0 = thin lace, 1 = thick aerated foam
  float rollRelief = 0.0;  // tumbling relief of a breaking roller (-1..1)
  if (b.river > 0.01) foamThick = riverThick;
  if (b.ocean > 0.01) {
    // three foam scales, anchored to the water: large streaky patches, cells, fine bubbles
    vec4 fa = texture(uFoamTex, xz / 11.0 + uWindDir * uTime * 0.006);
    vec4 fb = texture(uFoamTex, xz / 3.7 - uWindDir * uTime * 0.01 + 0.37);
    vec4 fc = texture(uFoamTex, xz / 1.15 + 0.71);
    float lacePat = clamp(fa.a * 0.5 + fb.a * 0.45 + fc.r * 0.25 + (fa.b - 0.5) * 0.5, 0.0, 1.0);
    float cellPat = clamp(fb.r * 0.5 + fc.g * 0.35 + fa.b * 0.35, 0.0, 1.0);
    // whitecaps from the FFT Jacobian
    float cap = clamp(capFoam, 0.0, 1.0);
    float capCov = smoothstep(1.0 - cap, 1.3 - cap * 0.7, cellPat + cap * 0.35) * smoothstep(0.03, 0.2, cap);
    // breaking swell: a churning roller. Its texture is carried along with the crest (flow mapping
    // with the wave's phase velocity) so the foam tumbles forward with the wave ...
    float roller = swInfo.x;
    float l3;
    vec2 cvel = swFrame.zw * min(swFrame.y, 9.0);
    float churn = flowFoam(xz, cvel, 3.1, 1.1, 0.7, l3) * 0.75 + flowFoam(xz, cvel * 0.8, 0.9, 0.7, 0.17, l3) * 0.35;
    float rollCov = smoothstep(0.2, 0.52, roller * (0.45 + 1.1 * churn));
    // ... and behind it foam left on the water (anchored to the water, not to the wave), in rafts
    // that open into lace and holes as it dissolves
    float wake = swInfo.z;
    vec4 fs_ = texture(uFoamTex, xz / 7.3 + 0.13);
    float blob = clamp(fa.b * 0.8 + fs_.b * 0.6 + (fb.b - 0.5) * 0.4 - 0.18, 0.0, 1.0);
    float streakLace = clamp(lacePat * 0.55 + fs_.r * 0.45 + fs_.g * 0.2, 0.0, 1.0);
    float dloc = wake * (0.25 + 1.3 * blob);
    float wakeCov = smoothstep(0.38, 0.9, dloc + 0.5 * streakLace * smoothstep(0.1, 0.5, dloc)) * smoothstep(0.02, 0.12, wake);
    // swash: thin sheet running up the sand carries a narrow line of foam at its leading edge and lace behind
    float swashOn = step(0.05, uSea.z) * smoothstep(-2.0, 8.0, b.shore + 6.0) * smoothstep(40.0, 10.0, b.shore);
    float film = smoothstep(0.3, 0.0, vertDepth) * swashOn;
    float lead = smoothstep(0.035, 0.005, vertDepth) * swashOn * (0.55 + 0.45 * cellPat);
    float swashCov = max(film * smoothstep(0.62, 0.9, lacePat + 0.25 * (swInfo.y / max(uSea.z, 0.05))) * 0.8, lead);
    // rocks and cliffs in the surf: surge foam where swell meets a steep shore (not on gentle sand)
    float swellHere = uSwellParams.x * textureLod(uSwell, clamp((xz + uWorldRect.x) * uWorldRect.y, 0.0, 1.0), 0.0).g;
    // foam collar: within a couple of metres of a steep shore (deep water close to the rock), surging with the swell
    float steepShore = smoothstep(0.25, 1.2, bedDepth) * smoothstep(0.2, 0.6, bedDepth / max(b.shore, 0.3));
    float surge = 0.5 + 0.5 * sin(uTime * uSwellParams.y + 6.0 * vnoise(xz * 0.05));
    float collar = smoothstep(1.2 + 2.6 * surge, 0.2, b.shore) * steepShore * smoothstep(0.25, 0.8, swellHere);
    float rockCov = smoothstep(1.15 - collar * 0.75, 1.38 - collar * 0.55, lacePat * 0.55 + cellPat * 0.65) * (1.0 - film);
    foamCov = max(max(foamCov, capCov), max(max(rollCov, wakeCov), max(swashCov, rockCov)));
    foamThick = max(max(rollCov, capCov * 0.7), max(lead, wake * wakeCov * 0.6));
    pat = cellPat;
    rollRelief = mix(0.0, (churn - 0.5) * 2.0, rollCov);
  }
  if (splash > 0.0) {
    float sp_ = smoothstep(1.0 - splash, 1.25 - splash * 0.6, pat * 0.6 + lace * 0.3 + 0.35);
    foamCov = max(foamCov, sp_);
    foamThick = max(foamThick, sp_ * splash);
  }
  foamCov = clamp(foamCov * uWaveScale.w, 0.0, 1.0);
  // submerged bubbles under and behind the foam brighten the water body
  float aeration = clamp(max(b.foam * b.river, swInfo.x * 0.6 + swInfo.z * 0.9 + capFoam * 0.5) * 0.75, 0.0, 1.0);

  // ---- refraction ----
  vec3 sigma = uWaterAbsorb + uWaterScatter * 0.5;
  vec2 refrOff = N.xz * (under ? 0.06 : 0.045 * clamp(thick, 0.0, 2.5) / max(1.0, vViewDepth * 0.12 + 0.5));
  vec2 ruvS = suv - refrOff;
  float rd = texture(uSceneDepth, ruvS).r;
  float rZ = isSkyDepth(rd) ? 1e6 : linearDepth(rd);
  if (!under) {
    // the offset sample must be something below the surface behind this pixel; otherwise (a bank,
    // a floating object's dry side) keep the straight-through sample
    vec3 rw = worldFromDepth(ruvS, rd);
    if (rZ < vViewDepth || (!isSkyDepth(rd) && rw.y > wp.y + 0.03)) { ruvS = suv; rZ = sceneZ; rd = sd; }
  }
  vec3 sceneCol = texture(uScene, ruvS).rgb;
  vec3 col;
  vec3 deepCol;
  {
    // Body colour of optically deep water from irradiance reflectance R ~ 0.33 bb / (a + bb)
    // (Gordon et al.), with backscatter bb a small fraction of total scattering. Clear water is dark.
    vec3 bb = uWaterScatter * 0.14;
    vec3 Rw = 0.33 * bb / (uWaterAbsorb + bb);
    float sunIn = max(uSunDir.y, 0.0) * 0.95;
    vec3 Ein = sunL * sunIn + skyIrr;
    deepCol = Rw * Ein / 3.14159265 + vec3(0.9, 0.95, 1.0) * Ein * aeration * 0.03;
  }
  if (!under) {
    // Path through the water: the ray refracts towards the normal on entry (Snell, n = 1.333), so
    // even at grazing view angles it descends at <= 48.6 degrees from vertical. Using the straight
    // view ray would overestimate the path (and the colour cast) many times over.
    vec3 bedW = worldFromDepth(ruvS, rd);
    float depthV = isSkyDepth(rd) ? 40.0 : max(wp.y - bedW.y, 0.0);
    float cosT = sqrt(1.0 - (1.0 - NoV * NoV) / 1.777);
    float pathLen = depthV / max(cosT, 0.6);
    vec3 T = exp(-sigma * pathLen);
    vec3 refr = sceneCol * T + deepCol * (1.0 - T);
    // ---- reflection ----
    vec3 R = reflect(-V, N);
    R.y = abs(R.y);
    float rough = sqrt(clamp(0.0012 + lostVar * 0.6, 0.0, 0.25));
    vec3 env = textureLod(uEnvMap, R, rough * 6.0).rgb;
    vec3 refl = env;
    if (uReflValid > 0.5) {
      vec4 rc = uReflMatrix * vec4(wp.x, uReflLevel, wp.z, 1.0);
      vec2 ruv2 = rc.xy / rc.w;
      // perturbation shrinks with distance in screen space; vertical stretch gives the streaked look of real reflections
      vec2 pert = N.xz * vec2(0.55, 1.5) / (1.0 + dist * 0.06) * 0.11;
      ruv2 += pert;
      vec4 pr = textureLod(uRefl, clamp(ruv2, vec2(0.001), vec2(0.999)), rough * 14.0 + min(dist * 0.004, 1.5));
      // the planar image is only valid near its plane: fade to the sky probe for strongly tilted facets
      // A wind-roughened sea does not form images: the mirror image of clouds or a headland only
      // survives on smooth water. Blend to the prefiltered sky by the resolved + unresolved slope variance.
      float mss = dot(uSlopeVar * cw * cw, vec4(1.0));
      float roughSea = b.ocean * smoothstep(0.004, 0.03, mss);
      refl = mix(pr.rgb, textureLod(uEnvMap, R, clamp(sqrt(mss) * 9.0, 1.0, 5.0)).rgb, roughSea * 0.88);
    }
    // Fresnel averaged over unresolved wave slopes (rough water reflects less at grazing angles)
    float f0 = 0.02;
    float fres = f0 + (1.0 - f0) * pow(1.0 - NoV, 5.0) / (1.0 + 22.0 * rough * rough + lostVar * 4.0);
    // sun glitter: GGX lobe whose width follows the slope variance below pixel size
    vec3 H = normalize(V + uSunDir);
    float NoH = clamp(dot(N, H), 0.0, 1.0);
    float a = max(rough * rough * 1.6 + 0.0009, 0.0009);
    float a2 = a * a; float dd = NoH * NoH * (a2 - 1.0) + 1.0;
    float D = a2 / (3.14159265 * dd * dd);
    float VoH = clamp(dot(V, H), 0.0, 1.0);
    float Fs = f0 + (1.0 - f0) * pow(1.0 - VoH, 5.0);
    float NoL = clamp(dot(N, uSunDir), 0.0, 1.0);
    vec3 spec = sunL * min(D * Fs * 0.25 / max(NoV, 0.08), 60.0) * NoL;
    col = refr * (1.0 - fres) + refl * fres + spec;
  } else {
    // ---- seen from below: Snell's window with the sky and sun inside, total internal reflection
    // (a rippling mirror image of the bed and the water body) outside ----
    vec3 I = -V;
    float cosI = clamp(dot(V, N), 0.0, 1.0);
    float sinT2 = 1.777 * (1.0 - cosI * cosI);
    vec3 underCol = deepCol * 1.6;
    // mirror image: where the reflected ray meets the bed, found in screen space
    vec3 Rr = reflect(I, N);
    Rr.y = -abs(Rr.y);
    float tR = clamp(max(bedDepth, 0.3) / max(-Rr.y, 0.12), 0.3, 40.0);
    vec4 qc = uViewProj * vec4(wp + Rr * tR, 1.0);
    vec2 quv = qc.xy / max(qc.w, 1e-3) * 0.5 + 0.5;
    vec3 mirror = underCol;
    if (qc.w > 0.0) {
      // off-screen parts of the mirror image reuse on-screen bed (far less visible than a missing reflection)
      quv = 1.0 - abs(1.0 - mod(quv, 2.0));   // mirrored repeat: no smeared edge columns
      quv = clamp(quv, vec2(0.002), vec2(0.998));
      float qd = texture(uSceneDepth, quv).r;
      vec3 qw = worldFromDepth(quv, qd);
      // only geometry below the surface belongs in the mirror image
      float okq = (isSkyDepth(qd) || qw.y > wp.y) ? 0.0 : 1.0;
      float tq = isSkyDepth(qd) ? tR : distance(qw, wp);
      vec3 Tq = exp(-sigma * tq);
      mirror = mix(underCol, texture(uScene, quv).rgb * Tq + underCol * (1.0 - Tq), okq);
    } else {
      vec3 Tq = exp(-sigma * tR);
      mirror = underCol * (1.0 + 0.0 * Tq);
    }
    if (sinT2 >= 1.0) {
      col = mirror;
    } else {
      float cosT = sqrt(1.0 - sinT2);
      // Fresnel for the water -> air interface rises steeply to 1 at the critical angle
      float r0 = 0.02;
      float fres = r0 + (1.0 - r0) * pow(1.0 - cosT, 5.0);
      vec3 Tdir = refract(I, N, 1.333);
      vec3 above = textureLod(uEnvMap, Tdir, 0.0).rgb;
      float sd_ = clamp(dot(Tdir, uSunDir), 0.0, 1.0);
      float sunT = pow(sd_, 1400.0) * 40.0 + pow(sd_, 90.0) * 0.8;
      above += uSunColor * sunT * shadow;
      col = mix(above * 0.96, mirror, fres);
    }
  }

  // ---- foam shading: diffuse, lit by sun + sky; thin foam is translucent, thick foam has relief ----
  if (foamCov > 0.001 || (under && aeration > 0.01)) {
    // relief from the bubble pattern (finite difference of the pattern along the sun's azimuth)
    vec2 sd = normalize(uSunDir.xz + 1e-4) * 0.06;
    float pS = texture(uFoamTex, (xz + sd) / 1.15 + 0.71).g;
    float pH = texture(uFoamTex, xz / 1.15 + 0.71).g;
    float relief = clamp(0.5 + (pH - pS) * 2.2 + rollRelief * 0.3, 0.0, 1.0);
    float fl = mix(0.75, 0.45 + 0.75 * relief, foamThick);
    vec3 foamAlb = mix(vec3(0.62, 0.66, 0.68), vec3(0.9, 0.91, 0.92), foamThick);
    vec3 foamCol = foamAlb * (sunL * max(uSunDir.y, 0.04) * fl + skyIrr * (0.75 + 0.25 * relief)) / 3.14159265;
    float opacity = foamCov * mix(0.5, 1.0, foamThick);
    if (under) {
      // from below foam is a soft back-lit cloud of bubbles: it dims the window and glows faintly
      vec3 glow = (sunL * max(uSunDir.y, 0.04) * 0.10 + skyIrr * 0.16) * vec3(0.75, 0.95, 1.0) / 3.14159265;
      col = mix(col, col * 0.5 + glow, clamp(foamCov * 0.5 + aeration * 0.15, 0.0, 0.6));
    } else col = mix(col, foamCol, opacity);
  }
  // ---- authoring overlay: flow speed (colour) and direction (moving streaks) ----
  if (uFlowViz > 0.5 && !under) {
    float sp = length(b.vel);
    // 0 m/s blue - 1 green - 2 yellow - 3+ red
    vec3 ramp = sp < 1.0 ? mix(vec3(0.1, 0.25, 0.9), vec3(0.1, 0.8, 0.3), sp) : sp < 2.0 ? mix(vec3(0.1, 0.8, 0.3), vec3(0.95, 0.9, 0.1), sp - 1.0) : mix(vec3(0.95, 0.9, 0.1), vec3(0.95, 0.15, 0.1), clamp(sp - 2.0, 0.0, 1.0));
    float lz;
    float streak = smoothstep(0.55, 0.75, flowFoam(xz, b.vel, 1.6, 1.0, 0.9, lz));
    float have = step(0.02, sp);
    col = mix(col, ramp * (0.5 + 0.9 * streak) * dot(skyIrr, vec3(0.33)) * 0.6, 0.85 * have);
  }
  // ---- soft waterline: blend into the unrefracted scene over the last centimetres of depth ----
  if (!under) col = mix(texture(uScene, suv).rgb, col, edge);
  // aerial perspective to the surface point
  if (uCamUnder < 0.5) col = applyFog(col, wp);
  outColor = vec4(col, 0.0);
}
`;

export class WaterRenderer {
  constructor(engine) {
    this.engine = engine;
    this.G = engine.G;
    this.sim = engine.waterSim;
    this.group = new THREE.Group();
    this.group.name = 'water';
    this.reflCam = new THREE.PerspectiveCamera();
    if (engine.renderer.capabilities.reversedDepthBuffer) this.reflCam._reversedDepth = true;
    this.reflCam.layers.set(0);
    this.reflRT = null;
    this.U = {
      uWaterB: { value: null },
      uSurfLod: { value: null },
      uSwell: { value: null },
      uTerrainH: { value: null },
      uDisp0: { value: null },
      uDisp1: { value: null },
      uDisp2: { value: null },
      uDisp3: { value: null },
      uDeriv0: { value: null },
      uDeriv1: { value: null },
      uDeriv2: { value: null },
      uDeriv3: { value: null },
      uRipple: { value: null },
      uRippleWindow: { value: this.sim.rippleWindow },
      uCascadeL: { value: new THREE.Vector4(...CASCADE_LENGTHS) },
      uSwellParams: { value: new THREE.Vector4(1, 0.7, 0.05, 0) },
      uSwellDir: { value: new THREE.Vector2(1, 0) },
      uWaveScale: { value: new THREE.Vector4(1, 0.55, 1, 1) },
      uWindDir: { value: new THREE.Vector2(1, 0) },
      uScene: { value: null },
      uSceneDepth: { value: null },
      uRefl: { value: null },
      uReflMatrix: { value: new THREE.Matrix4() },
      uReflLevel: { value: 0 },
      uReflValid: { value: 0 },
      uFoamTex: { value: this.sim.foamTex },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uInvViewProj: { value: new THREE.Matrix4() },
      uViewProj: { value: new THREE.Matrix4() },
      uLakeWind: { value: new THREE.Vector2(0.5, 0.2) },
      uSlopeVar: { value: new THREE.Vector4() },
      uCamUnder: { value: 0 },
      uFlowViz: { value: 0 },
      uProjInfo: engine.G.uProjInfo,
      uWaterAf: engine.G.uWaterA,
    };
    const makeMaterial = () =>
      new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: WATER_VERT,
        fragmentShader: WATER_FRAG,
        uniforms: { ...this.G, ...this.U },
        side: THREE.DoubleSide,
        transparent: false,
      });
    this.clipmap = new Clipmap({ M: engine.quality.waterGrid || 224, levels: 11, baseCell: 0.22, makeMaterial });
    for (const m of this.clipmap.meshes) {
      m.layers.set(4);
      m.renderOrder = 10;
    }
    this.group.add(this.clipmap.group);
    this.reflLevel = 0;
    this.hasWater = false;
  }

  setWorld(world) {
    this.world = world;
    const res = world.res;
    this.aData = new Float32Array(res * res * 4);
    this.aTex = new THREE.DataTexture(this.aData, res, res, THREE.RGBAFormat, THREE.FloatType);
    this.aTex.minFilter = this.aTex.magFilter = THREE.LinearFilter;
    this.aTex.generateMipmaps = false;
    this.bData = new Uint8Array(res * res * 4);
    this.bTex = new THREE.DataTexture(this.bData, res, res, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.bTex.minFilter = this.bTex.magFilter = THREE.LinearFilter;
    const lr = ((res - 1) >> 3) + 1;
    this.lodRes = lr;
    this.lodData = new Float32Array(lr * lr * 4);
    this.lodTex = new THREE.DataTexture(this.lodData, lr, lr, THREE.RGBAFormat, THREE.FloatType);
    this.lodTex.minFilter = this.lodTex.magFilter = THREE.NearestFilter;
    const sres = world.water.sres;
    this.sData = new Float32Array(sres * sres * 4);
    this.sTex = new THREE.DataTexture(this.sData, sres, sres, THREE.RGBAFormat, THREE.FloatType);
    this.sTex.minFilter = this.sTex.magFilter = THREE.LinearFilter;
    this.G.uWaterA.value = this.aTex;
    this.U.uWaterB.value = this.bTex;
    this.U.uSurfLod.value = this.lodTex;
    this.U.uSwell.value = this.sTex;
    this.upload();
  }

  /** Copy the CPU water field into GPU textures. */
  upload() {
    const world = this.world;
    const wf = world.water;
    const res = world.res;
    const N = res * res;
    const a = this.aData,
      b = this.bData;
    let any = false;
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      a[o] = wf.surf[i] + wf.relief[i];
      a[o + 1] = wf.vx[i];
      a[o + 2] = wf.vz[i];
      a[o + 3] = wf.shore[i];
      b[o] = Math.min(255, wf.foam[i] * 255);
      b[o + 1] = wf.exposure[i];
      const t = wf.typeExt[i] || wf.type[i];
      b[o + 2] = t === 1 ? 85 : t === 2 ? 170 : t === 3 ? 255 : wf.surf[i] > NO_WATER * 0.5 ? 85 : 0;
      b[o + 3] = 255;
      if (wf.type[i]) any = true;
    }
    this.hasWater = any || !!(world.project.water.sea && world.project.water.sea.enabled);
    // coarse max-filtered surface with one block of dilation
    const lr = this.lodRes;
    const l = this.lodData;
    const tmp = new Float32Array(lr * lr).fill(NO_WATER);
    for (let j = 0; j < lr; j++) {
      for (let i = 0; i < lr; i++) {
        let mx = NO_WATER;
        const x0 = Math.max(0, i * 8 - 4),
          x1 = Math.min(res - 1, i * 8 + 4),
          z0 = Math.max(0, j * 8 - 4),
          z1 = Math.min(res - 1, j * 8 + 4);
        for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (wf.surf[z * res + x] > mx) mx = wf.surf[z * res + x];
        tmp[j * lr + i] = mx;
      }
    }
    for (let j = 0; j < lr; j++) {
      for (let i = 0; i < lr; i++) {
        let mx = tmp[j * lr + i];
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const x = i + dx,
              z = j + dz;
            if (x >= 0 && z >= 0 && x < lr && z < lr && tmp[z * lr + x] > mx) mx = tmp[z * lr + x];
          }
        }
        const o = (j * lr + i) * 4;
        l[o] = mx;
        l[o + 3] = 8;
      }
    }
    const sres = wf.sres;
    const s = this.sData;
    for (let i = 0; i < sres * sres; i++) {
      s[i * 4] = wf.swellPhase[i];
      s[i * 4 + 1] = wf.swellH[i];
      s[i * 4 + 2] = wf.swellBreak[i];
    }
    this.aTex.needsUpdate = true;
    this.bTex.needsUpdate = true;
    this.lodTex.needsUpdate = true;
    this.sTex.needsUpdate = true;
  }

  /** Per-frame parameter update from the project document. */
  setParams(project) {
    const w = project.water;
    const env = project.env;
    const G = this.G;
    const o = w.optics || {};
    const turb = o.turbidity ?? 0.1;
    const ab = o.absorb || [0.4, 0.07, 0.04],
      sc = o.scatter || [0.01, 0.03, 0.03];
    G.uWaterAbsorb.value.set(ab[0], ab[1], ab[2]);
    G.uWaterScatter.value.set(sc[0] * (1 + turb * 4), sc[1] * (1 + turb * 4), sc[2] * (1 + turb * 4));
    const sea = w.sea && w.sea.enabled;
    const sw = w.swell || {};
    const period = sw.period || 9;
    const omega = (2 * Math.PI) / period;
    const H = sea ? (sw.height ?? 1) : 0;
    this.U.uSwellParams.value.set(H * (w.waveScale ?? 1), omega, (omega * omega) / 9.81, sea && H > 0.01 ? 1 : 0);
    this.U.uSwellDir.value.set(Math.cos(sw.dir || 0), Math.sin(sw.dir || 0));
    // swash amplitude: vertical run-up ~ 0.35 x offshore height (Hunt-type scaling for gentle beaches)
    G.uSea.value.set(sea ? 1 : 0, sea ? w.sea.level : -1e5, sea ? 0.35 * H * (w.waveScale ?? 1) : 0, omega);
    this.U.uWaveScale.value.set(w.waveScale ?? 1, w.lakeWaveScale ?? 1, w.riverWaveScale ?? 1, w.foamAmount ?? 1);
    // Lake roughness follows the wind (mean square slope grows about linearly with wind speed,
    // Cox & Munk): below ~1 m/s the surface is glassy, a light breeze ruffles it in patches
    // (cat's paws), a fresh breeze roughens all of it.
    const U10 = Math.max(0, env.windSpeed);
    const lakeAmp = Math.min(1.35, Math.max(0.02, Math.sqrt(Math.max(0, U10 - 0.6) / 7.5)));
    const calmLanes = Math.min(1, Math.max(0.04, (U10 - 1.5) / 5.5));
    this.U.uLakeWind.value.set(lakeAmp, calmLanes * 1.0);
    this.lakeAmp = lakeAmp;
    this.U.uWindDir.value.set(Math.cos(env.windDir), Math.sin(env.windDir));
    G.uCausticParams.value.set((w.causticStrength ?? 1) * 0.9, this.sim.causticTile, 0, turb);
    this.sim.setWind({ speed: env.windSpeed, dir: env.windDir, fetch: sea ? 80000 : 3000, amplitude: 1 });
    this.U.uSlopeVar.value.set(this.sim.cascades[0].slopeVar, this.sim.cascades[1].slopeVar, this.sim.cascades[2].slopeVar, this.sim.cascades[3].slopeVar);
  }

  /** Water level that the planar reflection should use: surface nearest to the camera. */
  _findReflectionLevel(camera) {
    const world = this.world;
    const wf = world.water;
    const hf = world.hFinal;
    const sea = world.seaLevel;
    const cx = camera.position.x,
      cz = camera.position.z;
    // sample rings of increasing radius around the point the camera looks at / stands on
    let best = null;
    let bestScore = Infinity;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    for (const r of [0, 6, 14, 30, 60, 120, 240, 480]) {
      const n = r === 0 ? 1 : 12;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const x = cx + Math.cos(a) * r,
          z = cz + Math.sin(a) * r;
        if (!hf.inBounds(x, z)) continue;
        const gi = Math.round(hf.toGridZ(z)) * world.res + Math.round(hf.toGridX(x));
        if (!wf.type[gi]) continue;
        // prefer water in front of the camera
        const dot = (Math.cos(a) * fwd.x + Math.sin(a) * fwd.z) * (r > 0 ? 1 : 0);
        const score = r * (1.4 - 0.6 * dot);
        if (score < bestScore) {
          bestScore = score;
          best = wf.surf[gi];
        }
      }
      if (best !== null && r >= 30) break;
    }
    if (best === null && sea !== null) best = sea;
    return best;
  }

  /** Render the mirrored scene. `renderOpaque(camera)` draws sky + opaque geometry. */
  renderReflection(camera, scene, w, h) {
    const eng = this.engine;
    if (!this.hasWater) {
      this.U.uReflValid.value = 0;
      return;
    }
    let level = this._findReflectionLevel(camera);
    if (level === null) {
      this.U.uReflValid.value = 0;
      return;
    }
    // smooth changes so the reflection does not jump when the nearest water body changes
    if (this._lvlInit && Math.abs(level - this.reflLevel) < 8) this.reflLevel += (level - this.reflLevel) * 0.2;
    else this.reflLevel = level;
    this._lvlInit = true;
    level = this.reflLevel;
    if (camera.position.y < level + 0.02) {
      this.U.uReflValid.value = 0;
      return;
    }
    const rw = Math.max(64, Math.round(w * (eng.quality.reflectionScale || 0.5))),
      rh = Math.max(64, Math.round(h * (eng.quality.reflectionScale || 0.5)));
    if (!this.reflRT || this.reflRT.width !== rw || this.reflRT.height !== rh) {
      if (this.reflRT) this.reflRT.dispose();
      this.reflRT = new THREE.WebGLRenderTarget(rw, rh, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true, samples: this.engine.quality.msaa ? 2 : 0 });
    }
    const rc = this.reflCam;
    rc.fov = camera.fov;
    rc.aspect = camera.aspect;
    rc.near = camera.near;
    rc.far = camera.far;
    rc.updateProjectionMatrix();
    // mirror the camera about the plane y = level (rigid transform: position, look target and up reflected)
    const pos = camera.position.clone();
    pos.y = 2 * level - pos.y;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    fwd.y = -fwd.y;
    up.y = -up.y;
    rc.position.copy(pos);
    rc.up.copy(up);
    rc.lookAt(pos.clone().add(fwd));
    rc.updateMatrixWorld(true);
    rc.matrixWorldInverse.copy(rc.matrixWorld).invert();
    // texture matrix: world -> reflection uv
    const m = this.U.uReflMatrix.value;
    m.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 1, 0, 0, 0, 0, 1);
    m.multiply(rc.projectionMatrix).multiply(rc.matrixWorldInverse);
    this.G.uClipY.value = level - 0.06;
    eng.renderScenePass(rc, this.reflRT, { reflection: true });
    this.G.uClipY.value = -1e9;
    this.U.uRefl.value = this.reflRT.texture;
    this.U.uReflLevel.value = level;
    this.U.uReflValid.value = 1;
  }

  update(camera, sceneRT) {
    const sim = this.sim;
    this.U.uDisp0.value = sim.dispTex(0);
    this.U.uDisp1.value = sim.dispTex(1);
    this.U.uDisp2.value = sim.dispTex(2);
    this.U.uDisp3.value = sim.dispTex(3);
    this.U.uDeriv0.value = sim.derivTex(0);
    this.U.uDeriv1.value = sim.derivTex(1);
    this.U.uDeriv2.value = sim.derivTex(2);
    this.U.uDeriv3.value = sim.derivTex(3);
    this.U.uRipple.value = sim.rippleTex;
    this.U.uScene.value = sceneRT.texture;
    this.U.uSceneDepth.value = sceneRT.depthTexture;
    this.U.uResolution.value.set(sceneRT.width, sceneRT.height);
    this.U.uViewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.U.uInvViewProj.value.copy(this.U.uViewProj.value).invert();
    this.U.uTerrainH.value = this.engine.terrain.heightTex[0] || null;
    this.clipmap.update(camera.position.x, camera.position.z, 0, 0);
    this.group.visible = this.hasWater;
  }

  dispose() {
    this.clipmap.dispose();
    for (const t of [this.aTex, this.bTex, this.lodTex, this.sTex, this.reflRT]) if (t) t.dispose();
  }
}
