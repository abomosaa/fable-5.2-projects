// GPU water simulation:
//  * Wind waves: 4 band-limited FFT cascades (Tessendorf) from a directional JONSWAP spectrum with
//    capillary-gravity dispersion. Each cascade yields displacement, slopes and the Jacobian
//    (whitecap criterion) with temporally accumulated foam.
//  * Interactive ripples: Tessendorf's iWave convolution solver (correct deep-water dispersion,
//    unlike the plain wave equation) in a window that follows the focus point, advected by the
//    river flow field and blocked by the shoreline.
//  * Caustics: light-concentration map from the second derivatives of the fine cascades.

import * as THREE from 'three';
import { FullscreenPass } from './Atmosphere.js';
import { mulberry32 } from '../core/noise.js';

const N = 256;
const LOGN = 8;
const G = 9.81;
export const CASCADE_LENGTHS = [437, 107, 23.3, 5.3];
const KM = 370; // capillary-gravity crossover wavenumber

const VERT = /* glsl */ `
out vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const TIME_FRAG = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
uniform highp sampler2D uH0;      // atlas 4N x N: rg = h0(k), ba = conj(h0(-k))
uniform vec4 uLengths;
uniform float uT;
const float N = ${N}.0;
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  int c = p.x / ${N};
  float L = c == 0 ? uLengths.x : c == 1 ? uLengths.y : c == 2 ? uLengths.z : uLengths.w;
  vec2 n = vec2(float(p.x - c * ${N}), float(p.y));
  n = mix(n, n - N, step(N * 0.5, n));
  vec2 k = 6.28318530718 * n / L;
  float kl = length(k);
  vec4 h = texelFetch(uH0, p, 0);
  if (kl < 1e-6) { o0 = vec4(0.0); o1 = vec4(0.0); return; }
  float w = sqrt(9.81 * kl * (1.0 + kl * kl / (${KM}.0 * ${KM}.0)));
  // quantise frequencies so the animation loops seamlessly every 240 s (no visible repeat)
  const float w0 = 6.28318530718 / 240.0;
  w = floor(w / w0 + 0.5) * w0;
  float ph = w * uT;
  vec2 e = vec2(cos(ph), sin(ph));
  vec2 hk = cmul(h.rg, vec2(e.x, -e.y)) + cmul(h.ba, e);
  vec2 ih = vec2(-hk.y, hk.x);
  float kx = k.x, kz = k.y, ik = 1.0 / kl;
  o0 = vec4(hk * (1.0 - kx * ik), ih * (kz * ik - kx * kz * ik));
  o1 = vec4(cmul(hk, vec2(-kz, kx)), cmul(hk, vec2(-kx * kx * ik, -kz * kz * ik)));
}
`;

const FFT_FRAG = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
uniform highp sampler2D uIn0;
uniform highp sampler2D uIn1;
uniform highp sampler2D uButterfly;
uniform int uStage;
uniform int uVertical;
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  int c = p.x / ${N};
  int lx = p.x - c * ${N};
  ivec2 p0, p1; vec4 b;
  if (uVertical == 0) {
    b = texelFetch(uButterfly, ivec2(uStage, lx), 0);
    p0 = ivec2(c * ${N} + int(b.z), p.y); p1 = ivec2(c * ${N} + int(b.w), p.y);
  } else {
    b = texelFetch(uButterfly, ivec2(uStage, p.y), 0);
    p0 = ivec2(p.x, int(b.z)); p1 = ivec2(p.x, int(b.w));
  }
  vec4 a0 = texelFetch(uIn0, p0, 0), a1 = texelFetch(uIn0, p1, 0);
  o0 = vec4(a0.rg + cmul(b.rg, a1.rg), a0.ba + cmul(b.rg, a1.ba));
  a0 = texelFetch(uIn1, p0, 0); a1 = texelFetch(uIn1, p1, 0);
  o1 = vec4(a0.rg + cmul(b.rg, a1.rg), a0.ba + cmul(b.rg, a1.ba));
}
`;

const ASSEMBLE_FRAG = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 oDisp;   // xyz = displacement (x, height, z), a = foam
layout(location = 1) out vec4 oDeriv;  // xy = slope, z = dDx/dx, w = dDz/dz
uniform highp sampler2D uIn0;
uniform highp sampler2D uIn1;
uniform highp sampler2D uPrev;
uniform int uCascade;
uniform float uChop;
uniform float uDt;
uniform float uFoamBias;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy) + ivec2(uCascade * ${N}, 0);
  vec4 a = texelFetch(uIn0, p, 0);   // r = h, g = Dx, b = Dz, a = dDx/dz
  vec4 b = texelFetch(uIn1, p, 0);   // r = dh/dx, g = dh/dz, b = dDx/dx, a = dDz/dz
  float jxx = 1.0 + uChop * b.b, jzz = 1.0 + uChop * b.a, jxz = uChop * a.a;
  float J = jxx * jzz - jxz * jxz;
  float prev = texelFetch(uPrev, ivec2(gl_FragCoord.xy), 0).a;
  float gen = clamp((uFoamBias - J) * 2.2, 0.0, 1.0);
  float foam = max(prev * exp(-uDt * 0.35), gen);
  oDisp = vec4(uChop * a.g, a.r, uChop * a.b, foam);
  oDeriv = vec4(b.r, b.g, b.b, b.a);
}
`;

// iWave: h'' = -g * (G * h) - alpha h' ; explicit second-order time stepping
const RIPPLE_FRAG = /* glsl */ `
precision highp float;
out vec4 outColor;
in vec2 vUv;
uniform highp sampler2D uState;     // r = h, g = h_prev, b = obstruction, a = unused
uniform highp sampler2D uKernel;    // 13x13 kernel (R32F)
uniform highp sampler2D uWaterA;    // world water field: r = surface, gb = velocity, a = shore distance
uniform sampler2D uSources;         // rg: additive height source (+/-), b: obstruction mask
uniform vec4 uWindow;               // xy = centre (world), z = size (m), w = texel (m)
uniform vec2 uShift;                // texel shift of the window since last step
uniform vec4 uWorldRect;
uniform float uDt;
uniform float uDamping;
const int R = 6;
void main(){
  vec2 res = vec2(textureSize(uState, 0));
  vec2 world = uWindow.xy + (vUv - 0.5) * uWindow.z;
  // semi-Lagrangian advection by the depth-averaged flow, plus the window scroll
  vec2 wuv = (world + uWorldRect.x) * uWorldRect.y;
  vec4 wa = textureLod(uWaterA, wuv, 0.0);
  vec2 vel = wa.r > -5e4 ? wa.gb : vec2(0.0);
  vec2 src = vUv + uShift / res - vel * uDt / uWindow.z;
  if (src.x < 0.0 || src.y < 0.0 || src.x > 1.0 || src.y > 1.0) { outColor = vec4(0.0); return; }
  vec4 s = textureLod(uState, src, 0.0);
  float conv = 0.0;
  for (int j = -R; j <= R; j++) for (int i = -R; i <= R; i++) {
    float k = texelFetch(uKernel, ivec2(i + R, j + R), 0).r;
    conv += k * textureLod(uState, src + vec2(float(i), float(j)) / res, 0.0).r;
  }
  float a = uDamping * uDt;
  float g = 9.81 * uDt * uDt / uWindow.w;
  float h = (s.r * (2.0 - a) - s.g - g * conv) / (1.0 + a);
  vec4 so = texture(uSources, vUv);
  h += so.r - so.g;
  // shore: water shallower than a few cm does not carry waves; soft absorb near the window edge
  float obstruct = wa.r > -5e4 ? smoothstep(0.25, -0.05, wa.a) : 1.0;
  obstruct = max(obstruct, so.b);
  vec2 e = min(vUv, 1.0 - vUv);
  float edge = smoothstep(0.0, 0.06, min(e.x, e.y));
  h *= (1.0 - obstruct) * mix(0.9, 1.0, edge);
  h = clamp(h, -0.6, 0.6);
  outColor = vec4(h, s.r * (1.0 - obstruct), obstruct, 1.0);
}
`;

const SOURCE_VERT = /* glsl */ `
in vec4 aData;   // xy = world position, z = radius (m), w = strength (m of height per step, signed)
in vec2 aParam;  // x = mode (0 source, 1 obstruction), y = unused
uniform vec4 uWindow;
out vec2 vLocal; out float vStrength; out float vMode;
void main(){
  vec2 corner = position.xy;
  vLocal = corner; vStrength = aData.w; vMode = aParam.x;
  vec2 world = aData.xy + corner * aData.z;
  vec2 ndc = (world - uWindow.xy) / uWindow.z * 2.0;
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;
const SOURCE_FRAG = /* glsl */ `
precision highp float;
in vec2 vLocal; in float vStrength; in float vMode;
out vec4 outColor;
void main(){
  float r2 = dot(vLocal, vLocal);
  if (r2 > 1.0) discard;
  float f = exp(-r2 * 3.0) * (1.0 - r2);
  if (vMode > 0.5) outColor = vec4(0.0, 0.0, smoothstep(1.0, 0.6, r2), 0.0);
  else outColor = vec4(max(vStrength, 0.0) * f, max(-vStrength, 0.0) * f, 0.0, 0.0);
}
`;

const CAUSTIC_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform sampler2D uDerivA;   // fine cascade slopes
uniform sampler2D uDerivB;   // finest cascade slopes
uniform vec2 uTiles;         // caustic tile / cascade length ratios
uniform vec2 uAmp;
uniform float uDepth;
void main(){
  // second derivatives of the surface by finite differences of the slope field
  vec2 e = vec2(1.0 / 512.0, 0.0);
  vec2 sxa = (texture(uDerivA, (vUv + e.xy) * uTiles.x).xy - texture(uDerivA, (vUv - e.xy) * uTiles.x).xy);
  vec2 sza = (texture(uDerivA, (vUv + e.yx) * uTiles.x).xy - texture(uDerivA, (vUv - e.yx) * uTiles.x).xy);
  vec2 sxb = (texture(uDerivB, (vUv + e.xy) * uTiles.y).xy - texture(uDerivB, (vUv - e.xy) * uTiles.y).xy);
  vec2 szb = (texture(uDerivB, (vUv + e.yx) * uTiles.y).xy - texture(uDerivB, (vUv - e.yx) * uTiles.y).xy);
  // d(slope)/dx in 1/m: divide by 2 * texel size (caustic tile = uTiles-independent world size folded into uAmp)
  vec2 dsdx = sxa * uAmp.x + sxb * uAmp.y;
  vec2 dsdz = sza * uAmp.x + szb * uAmp.y;
  // refraction maps surface point p to bed point p - depth * eta * slope ; intensity = 1 / |det J|
  float eta = 0.25 * uDepth;
  float jxx = 1.0 - eta * dsdx.x, jzz = 1.0 - eta * dsdz.y, jxz = -eta * 0.5 * (dsdx.y + dsdz.x);
  float det = abs(jxx * jzz - jxz * jxz);
  float I = 1.0 / max(det, 0.12);
  outColor = vec4(min(I, 7.0), 0.0, 0.0, 1.0);
}
`;

const FOAMTEX_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv; out vec4 outColor;
vec2 hash2(vec2 p){ p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
// tiling cellular noise: returns (F1, F2)
vec2 cell(vec2 p, float freq){
  p *= freq; vec2 i = floor(p), f = fract(p); float f1 = 9.0, f2 = 9.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(x, y); vec2 h = hash2(mod(i + o, freq));
    float d = length(o + h - f);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
  }
  return vec2(f1, f2);
}
float vn(vec2 p, float freq){ p *= freq; vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  float a = hash2(mod(i, freq)).x, b = hash2(mod(i + vec2(1,0), freq)).x, c = hash2(mod(i + vec2(0,1), freq)).x, d = hash2(mod(i + vec2(1,1), freq)).x;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }
void main(){
  // R: bubble clusters (cell borders), G: fine bubbles, B: soft low-frequency breakup, A: lace
  vec2 c1 = cell(vUv, 9.0), c2 = cell(vUv + 0.37, 23.0), c3 = cell(vUv + 0.71, 57.0);
  float border1 = 1.0 - smoothstep(0.0, 0.22, c1.y - c1.x);
  float border2 = 1.0 - smoothstep(0.0, 0.25, c2.y - c2.x);
  float border3 = 1.0 - smoothstep(0.0, 0.3, c3.y - c3.x);
  float low = vn(vUv, 5.0) * 0.6 + vn(vUv + 0.5, 11.0) * 0.4;
  float bubbles = max(border2 * 0.8, border3 * 0.7) * 0.6 + (1.0 - c3.x) * 0.4;
  float lace = max(border1, border2 * 0.6);
  outColor = vec4(clamp(border1 * 0.55 + border2 * 0.45, 0.0, 1.0), bubbles, low, lace);
}
`;

function besselJ0(x) {
  const ax = Math.abs(x);
  if (ax < 8) {
    const y = x * x;
    const a1 = 57568490574.0 + y * (-13362590354.0 + y * (651619640.7 + y * (-11214424.18 + y * (77392.33017 + y * -184.9052456))));
    const a2 = 57568490411.0 + y * (1029532985.0 + y * (9494680.718 + y * (59272.64853 + y * (267.8532712 + y))));
    return a1 / a2;
  }
  const z = 8 / ax;
  const y = z * z;
  const xx = ax - 0.785398164;
  const a1 = 1 + y * (-0.1098628627e-2 + y * (0.2734510407e-4 + y * (-0.2073370639e-5 + y * 0.2093887211e-6)));
  const a2 = -0.1562499995e-1 + y * (0.1430488765e-3 + y * (-0.6911147651e-5 + y * (0.7621095161e-6 - y * 0.934935152e-7)));
  return Math.sqrt(0.636619772 / ax) * (Math.cos(xx) * a1 - z * Math.sin(xx) * a2);
}

/** iWave vertical-derivative kernel (Tessendorf 2004), radius 6. */
export function iwaveKernel(R = 6) {
  const size = 2 * R + 1;
  const out = new Float32Array(size * size);
  const dq = 0.001;
  const sigma = 1.0;
  let g0 = 0;
  for (let n = 1; n <= 10000; n++) {
    const q = n * dq;
    g0 += q * q * Math.exp(-sigma * q * q);
  }
  for (let j = -R; j <= R; j++) {
    for (let i = -R; i <= R; i++) {
      const r = Math.hypot(i, j);
      let s = 0;
      for (let n = 1; n <= 10000; n++) {
        const q = n * dq;
        s += q * q * Math.exp(-sigma * q * q) * besselJ0(r * q);
      }
      out[(j + R) * size + (i + R)] = s / g0;
    }
  }
  return out;
}

function jonswap(omega, U, F) {
  const alpha = 0.076 * Math.pow((U * U) / (F * G), 0.22);
  const wp = 22 * Math.pow((G * G) / (U * F), 1 / 3);
  const sigma = omega <= wp ? 0.07 : 0.09;
  const r = Math.exp(-Math.pow(omega - wp, 2) / (2 * sigma * sigma * wp * wp));
  return { S: ((alpha * G * G) / Math.pow(omega, 5)) * Math.exp(-1.25 * Math.pow(wp / omega, 4)) * Math.pow(3.3, r), wp };
}

export class WaterSim {
  constructor(engine) {
    this.engine = engine;
    const r = engine.renderer;
    this.renderer = r;
    const mrt = (w, h, type = THREE.FloatType, filter = THREE.NearestFilter) => {
      const t = new THREE.WebGLRenderTarget(w, h, { count: 2, type, format: THREE.RGBAFormat, depthBuffer: false, minFilter: filter, magFilter: filter });
      return t;
    };
    this.h0Data = new Float32Array(4 * N * N * 4);
    this.h0Tex = new THREE.DataTexture(this.h0Data, 4 * N, N, THREE.RGBAFormat, THREE.FloatType);
    this.h0Tex.minFilter = this.h0Tex.magFilter = THREE.NearestFilter;
    this.ping = [mrt(4 * N, N), mrt(4 * N, N)];
    this.butterfly = this._butterfly();
    this.timeMat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: TIME_FRAG, uniforms: { uH0: { value: this.h0Tex }, uLengths: { value: new THREE.Vector4(...CASCADE_LENGTHS) }, uT: { value: 0 } }, depthTest: false, depthWrite: false });
    this.fftMat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FFT_FRAG, uniforms: { uIn0: { value: null }, uIn1: { value: null }, uButterfly: { value: this.butterfly }, uStage: { value: 0 }, uVertical: { value: 0 } }, depthTest: false, depthWrite: false });
    this.asmMat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: ASSEMBLE_FRAG, uniforms: { uIn0: { value: null }, uIn1: { value: null }, uPrev: { value: null }, uCascade: { value: 0 }, uChop: { value: 1 }, uDt: { value: 0.016 }, uFoamBias: { value: 0.7 } }, depthTest: false, depthWrite: false });
    this.pass = new FullscreenPass(this.timeMat);
    // per-cascade outputs (ping-pong for foam persistence)
    this.cascades = [];
    for (let c = 0; c < 4; c++) {
      const mk = () => {
        const t = new THREE.WebGLRenderTarget(N, N, { count: 2, type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false });
        for (const tex of t.textures) {
          tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.generateMipmaps = true;
          tex.anisotropy = 4;
        }
        return t;
      };
      this.cascades.push({ rt: [mk(), mk()], idx: 0, slopeVar: 0, heightVar: 0 });
    }
    this.time = 0;
    this.chop = [0.9, 0.9, 0.8, 0.6];
    this.params = null;
    this.setWind({ speed: 6, dir: 0, fetch: 60000, amplitude: 1 });

    // ---- ripples ----
    const RS = engine.quality.rippleSize || 512;
    this.rippleSize = RS;
    this.rippleWindow = new THREE.Vector4(0, 0, RS * 0.11, 0.11);
    const rrt = () => new THREE.WebGLRenderTarget(RS, RS, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping });
    this.ripple = [rrt(), rrt()];
    this.rippleIdx = 0;
    const kd = iwaveKernel(6);
    this.kernelTex = new THREE.DataTexture(kd, 13, 13, THREE.RedFormat, THREE.FloatType);
    this.kernelTex.needsUpdate = true;
    this.sourceRT = new THREE.WebGLRenderTarget(RS, RS, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.rippleMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: RIPPLE_FRAG,
      uniforms: {
        uState: { value: null },
        uKernel: { value: this.kernelTex },
        uWaterA: engine.G.uWaterA,
        uSources: { value: this.sourceRT.texture },
        uWindow: { value: this.rippleWindow },
        uShift: { value: new THREE.Vector2() },
        uWorldRect: engine.G.uWorldRect,
        uDt: { value: 1 / 60 },
        uDamping: { value: 0.35 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.ripplePass = new FullscreenPass(this.rippleMat);
    // source splats (instanced quads, additive)
    this.maxSources = 256;
    const qg = new THREE.InstancedBufferGeometry();
    qg.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    qg.setIndex([0, 1, 2, 0, 2, 3]);
    this.srcData = new Float32Array(this.maxSources * 4);
    this.srcParam = new Float32Array(this.maxSources * 2);
    this.srcAttr = new THREE.InstancedBufferAttribute(this.srcData, 4);
    this.srcParamAttr = new THREE.InstancedBufferAttribute(this.srcParam, 2);
    this.srcAttr.setUsage(THREE.DynamicDrawUsage);
    this.srcParamAttr.setUsage(THREE.DynamicDrawUsage);
    qg.setAttribute('aData', this.srcAttr);
    qg.setAttribute('aParam', this.srcParamAttr);
    qg.instanceCount = 0;
    this.srcMesh = new THREE.Mesh(
      qg,
      new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: SOURCE_VERT, fragmentShader: SOURCE_FRAG, uniforms: { uWindow: { value: this.rippleWindow } }, depthTest: false, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor, transparent: true }),
    );
    this.srcMesh.frustumCulled = false;
    this.srcScene = new THREE.Scene();
    this.srcScene.add(this.srcMesh);
    this.srcCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.sources = [];
    this.rippleAcc = 0;

    // ---- caustics + foam pattern ----
    this.causticRT = new THREE.WebGLRenderTarget(512, 512, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false });
    const ct = this.causticRT.texture;
    ct.wrapS = ct.wrapT = THREE.RepeatWrapping;
    ct.minFilter = THREE.LinearMipmapLinearFilter;
    ct.magFilter = THREE.LinearFilter;
    ct.generateMipmaps = true;
    this.causticTile = CASCADE_LENGTHS[2] * 0.5;
    this.causticMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: CAUSTIC_FRAG,
      uniforms: { uDerivA: { value: null }, uDerivB: { value: null }, uTiles: { value: new THREE.Vector2(this.causticTile / CASCADE_LENGTHS[2], this.causticTile / CASCADE_LENGTHS[3]) }, uAmp: { value: new THREE.Vector2(1, 1) }, uDepth: { value: 0.7 } },
      depthTest: false,
      depthWrite: false,
    });
    this.causticPass = new FullscreenPass(this.causticMat);
    this.foamRT = new THREE.WebGLRenderTarget(1024, 1024, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false });
    const ft = this.foamRT.texture;
    ft.wrapS = ft.wrapT = THREE.RepeatWrapping;
    ft.minFilter = THREE.LinearMipmapLinearFilter;
    ft.magFilter = THREE.LinearFilter;
    ft.generateMipmaps = true;
    ft.anisotropy = 8;
    const fm = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FOAMTEX_FRAG, depthTest: false, depthWrite: false });
    new FullscreenPass(fm).render(r, this.foamRT);
    fm.dispose();
    engine.G.uCaustics.value = this.causticRT.texture;
  }

  _butterfly() {
    const data = new Float32Array(LOGN * N * 4);
    const rev = (x) => {
      let r = 0;
      for (let i = 0; i < LOGN; i++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      return r;
    };
    for (let s = 0; s < LOGN; s++) {
      const span = 1 << s;
      for (let k = 0; k < N; k++) {
        const j = k % (2 * span);
        const top = j < span;
        const ang = (2 * Math.PI * (j % span)) / (2 * span); // inverse transform: +i
        let wr = Math.cos(ang),
          wi = Math.sin(ang);
        let i0, i1;
        if (top) {
          i0 = k;
          i1 = k + span;
        } else {
          i0 = k - span;
          i1 = k;
          wr = -wr;
          wi = -wi;
        }
        if (s === 0) {
          i0 = rev(i0);
          i1 = rev(i1);
        }
        const o = (k * LOGN + s) * 4;
        data[o] = wr;
        data[o + 1] = wi;
        data[o + 2] = i0;
        data[o + 3] = i1;
      }
    }
    const t = new THREE.DataTexture(data, LOGN, N, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    return t;
  }

  /** Regenerate the initial spectrum. wind: {speed (m/s), dir (rad, towards), fetch (m), amplitude} */
  setWind(wind) {
    const key = JSON.stringify(wind);
    if (key === this._windKey) return;
    this._windKey = key;
    this.params = wind;
    const U = Math.max(0.5, wind.speed);
    const F = Math.max(200, wind.fetch || 60000);
    const dir = wind.dir || 0;
    const ampScale = wind.amplitude ?? 1;
    const rnd = mulberry32(1234567);
    const gauss = () => {
      let u = 0,
        v = 0;
      while (u === 0) u = rnd();
      v = rnd();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const data = this.h0Data;
    const tmp = new Float32Array(N * N * 2);
    const { wp } = jonswap(1, U, F);
    this.peakOmega = wp;
    for (let c = 0; c < 4; c++) {
      const L = CASCADE_LENGTHS[c];
      const dk = (2 * Math.PI) / L;
      const kLo = c === 0 ? 0 : (6 * 2 * Math.PI) / L;
      const kHi = c === 3 ? 1e9 : (6 * 2 * Math.PI) / CASCADE_LENGTHS[c + 1];
      let slopeVar = 0,
        heightVar = 0;
      for (let m = 0; m < N; m++) {
        for (let n = 0; n < N; n++) {
          const kx = dk * (n < N / 2 ? n : n - N);
          const kz = dk * (m < N / 2 ? m : m - N);
          const k = Math.hypot(kx, kz);
          let amp = 0;
          if (k > 1e-6 && k >= kLo && k < kHi) {
            const omega = Math.sqrt(G * k * (1 + (k * k) / (KM * KM)));
            const dwdk = (G * (1 + (3 * k * k) / (KM * KM))) / (2 * omega);
            const { S } = jonswap(omega, U, F);
            // Hasselmann-style spreading: narrow at the peak, broad for short waves
            const ratio = omega / wp;
            const sp = ratio < 1 ? 9.8 * Math.pow(ratio, 4.5) + 1 : Math.max(0.6, 9.8 * Math.pow(ratio, -2.4) + 0.6);
            const theta = Math.atan2(kz, kx) - dir;
            const ch = Math.abs(Math.cos(theta / 2));
            const D = (Math.sqrt(sp + 0.25) / (2 * Math.sqrt(Math.PI))) * Math.pow(ch, 2 * sp);
            // viscous / capillary cutoff
            const cut = Math.exp(-Math.pow(k / 900, 2));
            const Sk = (S * D * dwdk) / k * cut;
            amp = Math.sqrt((Sk * dk * dk) / 2) * ampScale;
            slopeVar += 2 * amp * amp * k * k;
            heightVar += 2 * amp * amp;
          }
          const o = (m * N + n) * 2;
          tmp[o] = (gauss() * amp) / Math.SQRT2;
          tmp[o + 1] = (gauss() * amp) / Math.SQRT2;
        }
      }
      this.cascades[c].slopeVar = slopeVar;
      this.cascades[c].heightVar = heightVar;
      for (let m = 0; m < N; m++) {
        for (let n = 0; n < N; n++) {
          const o = (m * (4 * N) + c * N + n) * 4;
          const s = (m * N + n) * 2;
          const mm = (N - m) % N,
            nn = (N - n) % N;
          const s2 = (mm * N + nn) * 2;
          data[o] = tmp[s];
          data[o + 1] = tmp[s + 1];
          data[o + 2] = tmp[s2];
          data[o + 3] = -tmp[s2 + 1];
        }
      }
    }
    this.h0Tex.needsUpdate = true;
    // significant wave height for diagnostics / UI
    this.Hs = 4 * Math.sqrt(this.cascades.reduce((s, c) => s + c.heightVar, 0));
  }

  addSource(x, z, radius, strength) {
    if (this.sources.length < this.maxSources) this.sources.push(x, z, radius, strength, 0);
  }
  addObstruction(x, z, radius) {
    if (this.sources.length < this.maxSources * 5) this.sources.push(x, z, radius, 0, 1);
  }

  /** Centre the ripple window (snapped to texels so the state scrolls without resampling blur). */
  setFocus(x, z) {
    const tex = this.rippleWindow.w;
    const nx = Math.round(x / tex) * tex,
      nz = Math.round(z / tex) * tex;
    this._pendingShift = this._pendingShift || new THREE.Vector2();
    this._pendingShift.x += (nx - this.rippleWindow.x) / tex;
    this._pendingShift.y += (nz - this.rippleWindow.y) / tex;
    this.rippleWindow.x = nx;
    this.rippleWindow.y = nz;
  }

  update(dt) {
    const r = this.renderer;
    this.time += dt;
    // ---- FFT ----
    this.timeMat.uniforms.uT.value = this.time;
    this.pass.material = this.timeMat;
    this.pass.render(r, this.ping[0]);
    let src = 0;
    this.pass.material = this.fftMat;
    const u = this.fftMat.uniforms;
    for (let v = 0; v < 2; v++) {
      u.uVertical.value = v;
      for (let s = 0; s < LOGN; s++) {
        u.uStage.value = s;
        u.uIn0.value = this.ping[src].textures[0];
        u.uIn1.value = this.ping[src].textures[1];
        this.pass.render(r, this.ping[1 - src]);
        src = 1 - src;
      }
    }
    this.pass.material = this.asmMat;
    const au = this.asmMat.uniforms;
    au.uIn0.value = this.ping[src].textures[0];
    au.uIn1.value = this.ping[src].textures[1];
    au.uDt.value = dt;
    for (let c = 0; c < 4; c++) {
      const cs = this.cascades[c];
      au.uCascade.value = c;
      au.uChop.value = this.chop[c];
      au.uPrev.value = cs.rt[cs.idx].textures[0];
      // whitecap onset: the Jacobian threshold loosens with wind speed (whitecap coverage grows
      // roughly with the cube of the wind; hardly any below ~5 m/s)
      const wk = Math.min(1, Math.max(0, ((this.params?.speed ?? 6) - 5) / 9));
      au.uFoamBias.value = c === 0 ? 0.62 + 0.36 * wk : c === 1 ? 0.55 + 0.43 * wk : c === 2 ? 0.4 + 0.5 * wk : 0.4;
      this.pass.render(r, cs.rt[1 - cs.idx]);
      cs.idx = 1 - cs.idx;
    }
    // ---- caustics ----
    const cu = this.causticMat.uniforms;
    cu.uDerivA.value = this.derivTex(2);
    cu.uDerivB.value = this.derivTex(3);
    const texel = this.causticTile / 512;
    cu.uAmp.value.set((this.causticAmp ?? 1) / (2 * texel), (this.causticAmp ?? 1) / (2 * texel));
    this.causticPass.render(r, this.causticRT);
    // ---- ripples (fixed 60 Hz substeps) ----
    this.rippleAcc = Math.min(this.rippleAcc + dt, 0.05);
    const h = 1 / 60;
    let steps = 0;
    while (this.rippleAcc >= h && steps < 3) {
      this._stepRipples(h, steps === 0);
      this.rippleAcc -= h;
      steps++;
    }
  }

  _stepRipples(dt, withSources) {
    const r = this.renderer;
    // rasterise sources / obstructions
    const n = withSources ? Math.min(this.maxSources, this.sources.length / 5) : 0;
    for (let i = 0; i < n; i++) {
      this.srcData[i * 4] = this.sources[i * 5];
      this.srcData[i * 4 + 1] = this.sources[i * 5 + 1];
      this.srcData[i * 4 + 2] = this.sources[i * 5 + 2];
      this.srcData[i * 4 + 3] = this.sources[i * 5 + 3];
      this.srcParam[i * 2] = this.sources[i * 5 + 4];
    }
    if (withSources) this.sources.length = 0;
    this.srcMesh.geometry.instanceCount = n;
    this.srcAttr.needsUpdate = true;
    this.srcParamAttr.needsUpdate = true;
    const prev = r.getRenderTarget();
    const prevAuto = r.autoClear;
    const prevColor = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    r.setRenderTarget(this.sourceRT);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.autoClear = false;
    if (n > 0) r.render(this.srcScene, this.srcCam);
    r.setRenderTarget(prev);
    r.setClearColor(prevColor, prevAlpha);
    r.autoClear = prevAuto;
    const u = this.rippleMat.uniforms;
    u.uState.value = this.ripple[this.rippleIdx].texture;
    u.uDt.value = dt;
    if (this._pendingShift) {
      u.uShift.value.copy(this._pendingShift);
      this._pendingShift.set(0, 0);
    } else u.uShift.value.set(0, 0);
    this.ripplePass.render(r, this.ripple[1 - this.rippleIdx]);
    this.rippleIdx = 1 - this.rippleIdx;
  }

  dispTex(c) {
    const cs = this.cascades[c];
    return cs.rt[cs.idx].textures[0];
  }
  derivTex(c) {
    const cs = this.cascades[c];
    return cs.rt[cs.idx].textures[1];
  }
  get rippleTex() {
    return this.ripple[this.rippleIdx].texture;
  }
  get foamTex() {
    return this.foamRT.texture;
  }

  /** Synchronous read-back of cascade heights at a few world positions (buoyancy). */
  readHeights() {
    // Reads the two largest cascades at reduced rate; see Buoyancy for use.
    const r = this.renderer;
    if (!this._hbuf) this._hbuf = [new Uint16Array(N * N * 4), new Uint16Array(N * N * 4)];
    for (let c = 0; c < 2; c++) {
      const cs = this.cascades[c];
      r.readRenderTargetPixels(cs.rt[cs.idx], 0, 0, N, N, this._hbuf[c], undefined, 0);
    }
    this._hbufValid = true;
  }

  /** CPU sample of the FFT displacement (cascades 0,1) from the last read-back. Returns height. */
  sampleHeight(x, z, weights) {
    if (!this._hbufValid) return 0;
    let h = 0;
    for (let c = 0; c < 2; c++) {
      const L = CASCADE_LENGTHS[c];
      let u = (x / L) % 1,
        v = (z / L) % 1;
      if (u < 0) u += 1;
      if (v < 0) v += 1;
      const fx = u * N - 0.5,
        fz = v * N - 0.5;
      const i0 = Math.floor(fx),
        j0 = Math.floor(fz);
      const tx = fx - i0,
        tz = fz - j0;
      const buf = this._hbuf[c];
      const at = (i, j) => THREE.DataUtils.fromHalfFloat(buf[((((j % N) + N) % N) * N + (((i % N) + N) % N)) * 4 + 1]);
      h += (at(i0, j0) * (1 - tx) * (1 - tz) + at(i0 + 1, j0) * tx * (1 - tz) + at(i0, j0 + 1) * (1 - tx) * tz + at(i0 + 1, j0 + 1) * tx * tz) * (weights ? weights[c] : 1);
    }
    return h;
  }

  dispose() {
    for (const t of [...this.ping, this.sourceRT, this.causticRT, this.foamRT, ...this.ripple]) t.dispose();
    for (const c of this.cascades) for (const t of c.rt) t.dispose();
    this.h0Tex.dispose();
    this.butterfly.dispose();
    this.kernelTex.dispose();
  }
}
