// Airport scenery: runways with painted markings, taxiways, aprons, buildings, control towers,
// windsocks and a full lighting system (edge, threshold, centreline, approach lights with
// sequenced flashers, PAPI glide-path indicators, taxiway lights, rotating beacon).

import * as THREE from 'three';
import { AIRPORTS, airportPavement, PAVEMENT_OFFSET } from './heightfield.js';
import { withAtmosphere, atmoUniforms, ATMO_PARS } from '../gfx/atmosphere.js';

const DEG = Math.PI / 180;

// ----------------------------------------------------------------------------- textures
function asphalt(ctx, w, h, base = 44, seed = 1) {
  ctx.fillStyle = `rgb(${base},${base + 1},${base + 3})`;
  ctx.fillRect(0, 0, w, h);
  let s = seed * 7919;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 8) / 16777216; };
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 16;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  // long streaks, patches and seams
  for (let k = 0; k < 60; k++) {
    ctx.fillStyle = `rgba(${rnd() > 0.5 ? 255 : 0},${rnd() > 0.5 ? 255 : 0},${rnd() > 0.5 ? 255 : 0},${0.012 + rnd() * 0.02})`;
    ctx.fillRect(rnd() * w, rnd() * h, 40 + rnd() * w * 0.4, 2 + rnd() * 10);
  }
}

function makeTexture(canvas, repeatS = false) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 16;
  t.wrapS = repeatS ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.flipY = false;                 // canvas row 0 <-> v = -width/2
  return t;
}

/**
 * Runway end piece covering [u0, u1] metres from the runway end: canvas X runs inward along the
 * runway, canvas Y across the width. The first piece (threshold bars + number) is drawn at a
 * higher resolution than the long touchdown-zone piece.
 */
function runwayEndTexture(a, number, u0, u1, W) {
  const len = u1 - u0;
  const H = Math.max(128, Math.min(1024, Math.pow(2, Math.ceil(Math.log2(W * a.width / len)))));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  asphalt(ctx, W, H, 42, number.charCodeAt(0) + number.charCodeAt(1) + u0);
  const sx = W / len, sy = H / a.width;
  const white = 'rgba(232,232,226,0.95)';
  const R = (u, v, lu, lv) => ctx.fillRect((u - u0) * sx, (v + a.width / 2) * sy, lu * sx, lv * sy);
  // tyre rubber in the touchdown zone
  const aim = a.length >= 2400 ? 400 : a.length >= 1200 ? 300 : 150;
  let seed = 99 + u0;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 8) / 16777216; };
  for (let k = 0; k < 260; k++) {
    const u = aim - 150 + rnd() * 560, v = (rnd() - 0.5) * a.width * 0.42 + (rnd() > 0.5 ? 1 : -1) * a.width * 0.09;
    ctx.fillStyle = `rgba(8,8,9,${0.03 + rnd() * 0.07})`;
    R(u, v, 25 + rnd() * 90, 0.5 + rnd() * 0.9);
  }
  ctx.fillStyle = white;
  // side stripes
  R(u0, -a.width / 2 + 0.6, len, 0.9); R(u0, a.width / 2 - 1.5, len, 0.9);
  // threshold "piano keys"
  const nKeys = a.width >= 45 ? 12 : a.width >= 30 ? 8 : a.width >= 23 ? 6 : 4;
  const keyW = Math.min(1.8, (a.width - 6) / (nKeys * 2));
  const span = a.width - 6, half = nKeys / 2;
  for (let i = 0; i < half; i++) {
    const off = 1.8 + i * (span / 2 - 1.8) / half;
    R(6, off, 30, keyW); R(6, -off - keyW, 30, keyW);
  }
  // designation number, readable from the approach
  if (u0 < 47) {
    ctx.save();
    ctx.translate((47 - u0) * sx, H / 2);
    ctx.rotate(Math.PI / 2);
    ctx.scale(1, sx / sy);
    const fh = Math.min(9, a.width * 0.26) * sy;
    ctx.font = `bold ${fh * 1.25}px "Arial Narrow", "Liberation Sans Narrow", Arial, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(number, 0, 0);
    ctx.restore();
  }
  // centre line: 30 m stripes, 20 m gaps
  for (let u = 70; u < u1; u += 50) if (u + 30 > u0) R(u, -0.45, Math.min(30, u1 - u), 0.9);
  // aiming point and touchdown zone bars
  if (a.width >= 23) {
    const bw = a.width >= 45 ? 9 : a.width >= 30 ? 6 : 4;
    R(aim, a.width * 0.16, a.length >= 2400 ? 60 : 45, bw); R(aim, -a.width * 0.16 - bw, a.length >= 2400 ? 60 : 45, bw);
    if (a.size !== 'small') {
      for (const u of a.length >= 2400 ? [150, 300, 600, 750, 900] : [150, 450]) {
        const n = u <= 300 ? 3 : u <= 600 ? 2 : 1;
        for (let i = 0; i < n; i++) { R(u, a.width * 0.12 + i * 3, 22.5, 1.8); R(u, -a.width * 0.12 - i * 3 - 1.8, 22.5, 1.8); }
      }
    }
  }
  return makeTexture(c);
}

function runwayMidTexture(a) {
  const W = 256, H = 256, len = 50;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  asphalt(ctx, W, H, 42, 77);
  const sx = W / len, sy = H / a.width;
  ctx.fillStyle = 'rgba(232,232,226,0.95)';
  ctx.fillRect(0, (a.width / 2 - 0.45) * sy, 30 * sx, 0.9 * sy);
  ctx.fillRect(0, 0.6 * sy, W, 0.9 * sy); ctx.fillRect(0, (a.width - 1.5) * sy, W, 0.9 * sy);
  return makeTexture(c, true);
}

function windowTexture(cols, rows, lit) {
  const c = document.createElement('canvas'); c.width = cols * 16; c.height = rows * 16;
  const ctx = c.getContext('2d');
  ctx.fillStyle = lit ? '#000' : '#b9bcc0'; ctx.fillRect(0, 0, c.width, c.height);
  let s = cols * 31 + rows;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 8) / 16777216; };
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const on = rnd() > 0.45;
    ctx.fillStyle = lit ? (on ? `rgb(255,${200 + rnd() * 40 | 0},${130 + rnd() * 60 | 0})` : '#050505') : '#2c3f52';
    ctx.fillRect(x * 16 + 2, y * 16 + 3, 12, 9);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

// ----------------------------------------------------------------------------- helpers
/** depth bias for flat decals under a logarithmic depth buffer (polygonOffset has no effect) */
function decal(material, bias) {
  withAtmosphere(material, (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <logdepthbuf_fragment>',
      `#include <logdepthbuf_fragment>
       #if defined( USE_LOGARITHMIC_DEPTH_BUFFER )
         gl_FragDepth -= ${bias.toExponential(2)};
       #endif`);
  }, 'decal' + bias);
  return material;
}

class QuadBuilder {
  constructor() { this.pos = []; this.uv = []; this.col = []; this.idx = []; }
  /** quad in airport-local coordinates (u along runway, v to the right), CCW seen from above */
  quad(a, u0, v0, u1, v1, y, color, uvRect) {
    const base = this.pos.length / 3;
    const P = (u, v) => { this.pos.push(a.dirX * u + a.sideX * v, y, a.dirZ * u + a.sideZ * v); };
    P(u0, v0); P(u1, v0); P(u1, v1); P(u0, v1);
    const [s0, t0, s1, t1] = uvRect || [0, 0, 1, 1];
    this.uv.push(s0, t0, s1, t0, s1, t1, s0, t1);
    for (let i = 0; i < 4; i++) this.col.push(color[0], color[1], color[2]);
    // (u0,v0) -> (u0,v1) -> (u1,v1): right x forward = up
    this.idx.push(base, base + 3, base + 2, base, base + 2, base + 1);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

// ----------------------------------------------------------------------------- lights
const LIGHT_VS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 color;
  attribute vec4 aDir;      // xyz direction (0 = omni), w = beam sharpness
  attribute vec4 aParam;    // x size, y kind (0 steady, 1 sequenced strobe, 2 PAPI, 3 beacon, 4 flasher), z phase / angle, w = day visibility
  uniform float uPixelScale; uniform float uNightLights; uniform float uTime; uniform float uFogDensity; uniform float uFogHeight;
  varying vec4 vColor;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vec3 toCam = cameraPosition - wp.xyz;
    float dist = length(toCam);
    vec3 dirToCam = toCam / dist;
    float k = mix(aParam.w, 1.0, uNightLights);
    vec3 col = color;
    float kind = aParam.y;
    float beam = 1.0;
    if (aDir.w > 0.0) beam = smoothstep(0.0, 1.0, (dot(aDir.xyz, dirToCam) - (1.0 - 1.0 / aDir.w)) * aDir.w + 0.15);
    if (kind > 0.5 && kind < 1.5) {
      float ph = fract(uTime * 2.0 - aParam.z);
      k *= smoothstep(0.07, 0.0, ph) * 3.0;
    } else if (kind > 1.5 && kind < 2.5) {
      // PAPI: red below the unit's angle, white above
      float ang = atan(toCam.y, length(toCam.xz));
      col = mix(vec3(1.0, 0.05, 0.03), vec3(1.0), smoothstep(-0.0012, 0.0012, ang - aParam.z));
    } else if (kind > 2.5 && kind < 3.5) {
      float ph = fract(uTime * 0.42);
      col = ph < 0.5 ? vec3(0.2, 1.0, 0.3) : vec3(1.0);
      k *= smoothstep(0.1, 0.0, abs(fract(ph * 2.0) - 0.5) - 0.06) * 2.0;
    } else if (kind > 3.5) {
      k *= step(fract(uTime * 1.6 + aParam.z), 0.08) * 3.0;
    }
    // haze extinction
    float od = uFogDensity * exp(-max(cameraPosition.y, 0.0) / uFogHeight) * dist;
    float trans = exp(-od * 1.3);
    float inten = aParam.x * k * beam * trans;
    vec4 mv = viewMatrix * wp;
    gl_Position = projectionMatrix * mv;
    // apparent size: capped glare disc up close, a constant small sprite far away whose
    // brightness then follows the inverse-square law
    float px = uPixelScale * 0.85 * sqrt(max(inten, 0.0)) / max(-mv.z, 1.0);
    float maxPx = (2.6 + 0.62 * log2(1.0 + inten)) * uPixelScale / 1250.0;
    float minPx = 1.7 * uPixelScale / 1250.0;
    float fade = min(1.0, px / minPx);
    gl_PointSize = clamp(px, minPx, maxPx);
    vColor = vec4(col, fade * fade * step(0.0005, inten));
    #include <logdepthbuf_vertex>
  }`;
const LIGHT_FS = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  varying vec4 vColor;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 p = gl_PointCoord - 0.5;
    float r = length(p) * 2.0;
    float a = smoothstep(1.0, 0.0, r);
    a = a * a * 0.7 + smoothstep(0.35, 0.0, r) * 0.9;
    if (vColor.a * a < 0.004) discard;
    gl_FragColor = vec4(vColor.rgb * a * vColor.a * 1.6, 1.0);
  }`;

export const lightUniforms = {
  uPixelScale: { value: 1000 },
  uNightLights: { value: 0 },
  uTime: atmoUniforms.uTime,
  uFogDensity: atmoUniforms.uFogDensity,
  uFogHeight: atmoUniforms.uFogHeight,
};

export class LightBuilder {
  constructor() { this.pos = []; this.col = []; this.dir = []; this.par = []; }
  add(a, u, v, y, color, size, opt = {}) {
    this.pos.push(a.dirX * u + a.sideX * v, y, a.dirZ * u + a.sideZ * v);
    this.col.push(color[0], color[1], color[2]);
    const d = opt.dir;      // [du, dv, dy] in local coords
    if (d) {
      const x = a.dirX * d[0] + a.sideX * d[1], z = a.dirZ * d[0] + a.sideZ * d[1], l = Math.hypot(x, d[2], z);
      this.dir.push(x / l, d[2] / l, z / l, opt.sharp ?? 1.6);
    } else this.dir.push(0, 0, 0, 0);
    this.par.push(size, opt.kind ?? 0, opt.phase ?? 0, opt.day ?? 0.12);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aDir', new THREE.Float32BufferAttribute(this.dir, 4));
    g.setAttribute('aParam', new THREE.Float32BufferAttribute(this.par, 4));
    const m = new THREE.ShaderMaterial({
      uniforms: lightUniforms, vertexShader: LIGHT_VS, fragmentShader: LIGHT_FS,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false,
    });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    pts.renderOrder = 20;
    return pts;
  }
}

const WHITE = [1, 0.95, 0.82], GREEN = [0.1, 1, 0.25], RED = [1, 0.06, 0.04], BLUE = [0.15, 0.3, 1], YELLOW = [1, 0.75, 0.15], FLOOD = [1, 0.85, 0.6];

function buildLights(a, L) {
  const half = a.length / 2, hw = a.width / 2, y = 0.5;
  const big = a.size === 'large';
  // runway edge lights
  const step = 60;
  for (let u = -half; u <= half + 1; u += step) {
    const nearEnd = a.ils && (half - Math.abs(u)) < 600;
    for (const s of [-1, 1]) L.add(a, u, s * (hw + 2), y, nearEnd ? YELLOW : WHITE, big ? 60 : 36, { day: 0.05 });
  }
  if (big) for (let u = -half + 30; u < half; u += 30) L.add(a, u, 0, 0.15, WHITE, 26, { day: 0.03 });
  for (const end of [-1, 1]) {
    // end = -1: threshold of the primary runway (landing toward +u)
    const u0 = end * half;
    const inward = -end;                          // direction of landing traffic
    const n = Math.round(a.width / 3);
    for (let i = 0; i <= n; i++) {
      const v = -hw + (a.width * i) / n;
      L.add(a, u0 - end * 0.5, v, y, GREEN, 70, { dir: [-inward, 0, 0.12], sharp: 1.3, day: 0.25 });
      L.add(a, u0 - end * 0.5, v, y, RED, 60, { dir: [inward, 0, 0.12], sharp: 1.3, day: 0.15 });
    }
    // PAPI on the left of the landing direction
    const papiU = u0 + inward * (a.length >= 2400 ? 420 : a.length >= 1200 ? 300 : 150);
    const left = -inward;                         // local v sign of the pilot's left when landing toward `inward`
    const angles = [3.5, 3.17, 2.83, 2.5];        // the unit nearest the runway turns white last
    for (let i = 0; i < 4; i++) {
      L.add(a, papiU, left * (hw + 15 + i * 9), 0.6, WHITE, 420, { kind: 2, phase: angles[i] * DEG, dir: [-inward, 0, 0.06], sharp: 1.15, day: 1 });
    }
    // approach lights
    if (a.ils) {
      const len = big ? 720 : 420;
      for (let d = 30; d <= len; d += 30) {
        const bars = d === 300 ? 9 : 2;
        for (let i = -bars; i <= bars; i++) L.add(a, u0 - inward * d, i * (d === 300 ? 1.7 : 1.0), 0.8, WHITE, 90, { dir: [-inward, 0, 0.1], sharp: 1.25, day: 0.07 });
        if (d > 300) L.add(a, u0 - inward * d, 0, 1.2, [1, 1, 1], 900, { kind: 1, phase: (len - d) / len, dir: [-inward, 0, 0.1], sharp: 1.2, day: 0.8 });
      }
      if (big) for (let d = 30; d <= 270; d += 30) for (const s of [-1, 1]) for (let i = 0; i < 3; i++) L.add(a, u0 - inward * d, s * (9 + i * 1.5), 0.8, RED, 60, { dir: [-inward, 0, 0.1], sharp: 1.25, day: 0.1 });
    } else {
      for (const s of [-1, 1]) L.add(a, u0, s * (hw + 6), 1.0, [1, 1, 1], 700, { kind: 4, phase: 0, dir: [-inward, 0, 0.1], sharp: 1.15, day: 0.8 });
    }
    // touchdown zone lights
    if (big) for (let d = 30; d <= 900; d += 60) for (const s of [-1, 1]) for (let i = 0; i < 3; i++) L.add(a, u0 + inward * d, s * (9 + i * 1.5), 0.15, WHITE, 22, { day: 0.02 });
  }
  // taxiway and apron lights
  for (const r of airportPavement(a)) {
    if (r.kind === 'taxiway') {
      const alongU = (r.u1 - r.u0) > (r.v1 - r.v0);
      const len = alongU ? r.u1 - r.u0 : r.v1 - r.v0;
      for (let d = 0; d <= len; d += 30) {
        if (alongU) { L.add(a, r.u0 + d, r.v0 - 1, 0.35, BLUE, 16, { day: 0.02 }); L.add(a, r.u0 + d, r.v1 + 1, 0.35, BLUE, 16, { day: 0.02 }); }
        else { L.add(a, r.u0 - 1, r.v0 + d, 0.35, BLUE, 16, { day: 0.02 }); L.add(a, r.u1 + 1, r.v0 + d, 0.35, BLUE, 16, { day: 0.02 }); }
      }
    } else if (r.kind === 'apron') {
      const n = Math.max(2, Math.round((r.u1 - r.u0) / 90));
      for (let i = 0; i <= n; i++) L.add(a, r.u0 + (r.u1 - r.u0) * i / n, r.v1 + 4, 18, FLOOD, 500, { day: 0.03 });
    }
  }
}

// ----------------------------------------------------------------------------- buildings
function box(group, mat, a, u, v, w, d, h, y0 = 0, rot = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  // box local X -> runway direction, local Z -> across
  m.position.set(a.dirX * u + a.sideX * v, y0 + h / 2, a.dirZ * u + a.sideZ * v);
  m.rotation.y = -Math.atan2(a.dirZ, a.dirX) + rot;
  m.castShadow = false; m.receiveShadow = true;
  group.add(m);
  return m;
}

function hangar(group, mats, a, u, v, w, d, h) {
  box(group, mats.hangar, a, u, v, w, d, h * 0.62);
  // barrel roof: half cylinder along the building's long axis
  const geo = new THREE.CylinderGeometry(d / 2, d / 2, w, 14, 1, false, 0, Math.PI);
  geo.rotateZ(Math.PI / 2);
  geo.scale(1, (h * 0.38) / (d / 2), 1);
  const roof = new THREE.Mesh(geo, mats.roof);
  roof.rotation.y = -Math.atan2(a.dirZ, a.dirX);
  roof.position.set(a.dirX * u + a.sideX * v, h * 0.62, a.dirZ * u + a.sideZ * v);
  group.add(roof);
  // door facing the apron
  box(group, mats.door, a, u, v - d / 2 - 0.05, w * 0.72, 0.3, h * 0.5);
}

function tower(group, mats, a, u, v, h) {
  box(group, mats.concrete, a, u, v, 7, 7, h);
  const cab = new THREE.Mesh(new THREE.CylinderGeometry(6.2, 5, 4.2, 8), mats.glass);
  cab.position.set(a.dirX * u + a.sideX * v, h + 2.1, a.dirZ * u + a.sideZ * v);
  group.add(cab);
  const top = new THREE.Mesh(new THREE.CylinderGeometry(6.8, 6.8, 0.7, 8), mats.concrete);
  top.position.set(cab.position.x, h + 4.5, cab.position.z);
  group.add(top);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 7, 5), mats.door);
  mast.position.set(cab.position.x, h + 8.3, cab.position.z);
  group.add(mast);
  return h + 5.2;
}

export class AirportScenery {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'airports';
    scene.add(this.group);
    this.windsocks = [];
    this.obstacles = [];        // {a, u0, u1, v0, v1, h} boxes in airport-local coordinates
    this.nightMaterials = [];
    const mats = {
      hangar: withAtmosphere(new THREE.MeshLambertMaterial({ color: 0x9aa3a8 })),
      roof: withAtmosphere(new THREE.MeshLambertMaterial({ color: 0x5d6b78 })),
      door: withAtmosphere(new THREE.MeshLambertMaterial({ color: 0x39424a })),
      concrete: withAtmosphere(new THREE.MeshLambertMaterial({ color: 0xb4b2ab })),
      glass: withAtmosphere(new THREE.MeshStandardMaterial({ color: 0x1b3447, roughness: 0.15, metalness: 0.6, emissive: 0x443a22, emissiveIntensity: 0 })),
      terminal: withAtmosphere(new THREE.MeshLambertMaterial({ map: windowTexture(64, 4, false), emissiveMap: windowTexture(64, 4, true), emissive: 0xffffff, emissiveIntensity: 0 })),
      pole: withAtmosphere(new THREE.MeshLambertMaterial({ color: 0xdddddd })),
      sock: withAtmosphere(new THREE.MeshLambertMaterial({ color: 0xff5a1f, side: THREE.DoubleSide })),
    };
    this.mats = mats;
    this.nightMaterials.push(mats.glass, mats.terminal);
    for (const a of AIRPORTS) this.build(a, mats);
  }

  build(a, mats) {
    const g = new THREE.Group();
    g.position.set(a.x, a.elevation, a.z);
    const y = PAVEMENT_OFFSET;
    const half = a.length / 2, hw = a.width / 2;
    const endLen = Math.min(a.size === 'large' ? 1000 : a.size === 'medium' ? 520 : 300, half);

    // --- runway: two end pieces with markings and a tiled middle
    const rw = [a.runways[0].id, a.runways[1].id];
    const mk = (tex) => decal(new THREE.MeshLambertMaterial({ map: tex }), 6e-6);
    {
      const split = Math.min(100, endLen * 0.4);
      const piece = (u0, u1, W, num, primary) => {
        const q = new QuadBuilder();
        if (primary) q.quad(a, -half + u0, -hw, -half + u1, hw, y, [1, 1, 1], [0, 0, 1, 1]);
        else q.quad(a, half - u1, -hw, half - u0, hw, y, [1, 1, 1], [1, 1, 0, 0]);
        const m = new THREE.Mesh(q.build(), mk(runwayEndTexture(a, num, u0, u1, W)));
        m.receiveShadow = true; g.add(m);
      };
      for (const primary of [true, false]) {
        const num = primary ? rw[0] : rw[1];
        piece(0, split, 2048, num, primary);                       // threshold: bars and number, sharp
        piece(split, endLen, endLen > 600 ? 4096 : 2048, num, primary);
      }
      const midLen = a.length - 2 * endLen;
      if (midLen > 1) {
        const q3 = new QuadBuilder();
        q3.quad(a, -half + endLen, -hw, half - endLen, hw, y, [1, 1, 1], [0, 0, midLen / 50, 1]);
        const m3 = new THREE.Mesh(q3.build(), mk(runwayMidTexture(a)));
        m3.receiveShadow = true; g.add(m3);
      }
    }
    // --- other pavement
    {
      const q = new QuadBuilder();
      const lines = new QuadBuilder();
      for (const r of airportPavement(a)) {
        if (r.kind === 'runway') {
          // paved overruns beyond the runway ends + shoulders
          q.quad(a, r.u0, r.v0, -half, r.v1, y - 0.01, [0.2, 0.2, 0.21]);
          q.quad(a, half, r.v0, r.u1, r.v1, y - 0.01, [0.2, 0.2, 0.21]);
          continue;
        }
        const c = r.kind === 'apron' ? [0.43, 0.43, 0.42] : [0.24, 0.245, 0.25];
        q.quad(a, r.u0, r.v0, r.u1, r.v1, y - 0.012, c);
        if (r.kind === 'taxiway') {
          const alongU = (r.u1 - r.u0) > (r.v1 - r.v0);
          const yl = [0.85, 0.66, 0.08];
          if (alongU) lines.quad(a, r.u0, (r.v0 + r.v1) / 2 - 0.15, r.u1, (r.v0 + r.v1) / 2 + 0.15, y, yl);
          else lines.quad(a, (r.u0 + r.u1) / 2 - 0.15, r.v0 - (a.size === 'small' ? 0 : hw * 0.0), (r.u0 + r.u1) / 2 + 0.15, r.v1, y, yl);
        }
      }
      const pm = new THREE.Mesh(q.build(), decal(new THREE.MeshLambertMaterial({ vertexColors: true }), 4e-6));
      pm.receiveShadow = true; g.add(pm);
      if (lines.pos.length) {
        const lm = new THREE.Mesh(lines.build(), decal(new THREE.MeshLambertMaterial({ vertexColors: true }), 7e-6));
        g.add(lm);
      }
    }
    // --- buildings on the far side of the apron
    const ap = a.apronRect;
    const vB = ap.v1 + 6;
    const addObstacle = (u, v, w, d, h) => this.obstacles.push({ a, u0: u - w / 2, u1: u + w / 2, v0: v - d / 2, v1: v + d / 2, h });
    if (a.size === 'large') {
      box(g, mats.terminal, a, 0, vB + 24, 260, 44, 16); addObstacle(0, vB + 24, 260, 44, 16);
      box(g, mats.roof, a, 0, vB + 24, 264, 48, 1.2, 16);
      const th = tower(g, mats, a, 175, vB + 20, 42); addObstacle(175, vB + 20, 12, 12, th);
      a.towerPos = { u: 175, v: vB + 20, h: th };
      for (let i = 0; i < 3; i++) { hangar(g, mats, a, -210 - i * 75, vB + 32, 62, 56, 20); addObstacle(-210 - i * 75, vB + 32, 62, 56, 20); }
    } else if (a.size === 'medium') {
      box(g, mats.terminal, a, 20, vB + 14, 80, 24, 9); addObstacle(20, vB + 14, 80, 24, 9);
      box(g, mats.roof, a, 20, vB + 14, 83, 27, 0.8, 9);
      if (a.tower) { const th = tower(g, mats, a, 85, vB + 12, 22); addObstacle(85, vB + 12, 12, 12, th); a.towerPos = { u: 85, v: vB + 12, h: th }; }
      for (let i = 0; i < 2; i++) { hangar(g, mats, a, -55 - i * 45, vB + 20, 36, 32, 11); addObstacle(-55 - i * 45, vB + 20, 36, 32, 11); }
    } else {
      hangar(g, mats, a, -35, vB + 14, 24, 22, 8); addObstacle(-35, vB + 14, 24, 22, 8);
      box(g, mats.concrete, a, 15, vB + 8, 16, 9, 4.2); addObstacle(15, vB + 8, 16, 9, 4.2);
      box(g, mats.roof, a, 15, vB + 8, 17.5, 10.5, 0.5, 4.2);
    }
    if (!a.towerPos) a.towerPos = { u: 30, v: vB + 8, h: 9 };
    // --- windsock on the opposite side of the runway from the apron
    {
      const ws = new THREE.Group();
      const u = a.size === 'large' ? -half + 520 : 0, v = -(hw + (a.size === 'large' ? 55 : 28));
      ws.position.set(a.dirX * u + a.sideX * v, 0, a.dirZ * u + a.sideZ * v);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 6.5, 6), mats.pole);
      pole.position.y = 3.25; ws.add(pole);
      const pivot = new THREE.Group(); pivot.position.y = 6.4; ws.add(pivot);
      const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.5, 3.6, 10, 1, true), mats.sock);
      cone.rotation.z = -Math.PI / 2;          // axis along +X, wide end at the pole
      cone.position.x = 1.8;
      const arm = new THREE.Group(); arm.add(cone); pivot.add(arm);
      g.add(ws);
      this.windsocks.push({ pivot, arm, a });
    }
    // --- lights
    const L = new LightBuilder();
    buildLights(a, L);
    L.add(a, a.towerPos.u, a.towerPos.v, a.towerPos.h + 1.5, [1, 1, 1], 1500, { kind: 3, day: 0.2 });
    const pts = L.build();
    g.add(pts);
    g.updateMatrixWorld(true);
    this.group.add(g);
    a.sceneGroup = g;
  }

  /** point inside a building? (world coordinates) */
  hitsObstacle(x, y, z) {
    for (const o of this.obstacles) {
      const a = o.a;
      if (y - a.elevation > o.h) continue;
      const dx = x - a.x, dz = z - a.z;
      const u = dx * a.dirX + dz * a.dirZ;
      if (u < o.u0 || u > o.u1) continue;
      const v = dx * a.sideX + dz * a.sideZ;
      if (v >= o.v0 && v <= o.v1) return true;
    }
    return false;
  }

  update(wind, night, viewportHeight, fovDeg, time) {
    lightUniforms.uNightLights.value = night;
    lightUniforms.uPixelScale.value = viewportHeight / Math.tan(fovDeg * DEG / 2);
    for (const m of this.nightMaterials) m.emissiveIntensity = night * (m === this.mats.glass ? 0.6 : 0.9);
    // windsocks point downwind and droop in light winds
    const sp = wind ? wind.speed : 0, from = wind ? wind.dirFrom : 0;
    const to = from + Math.PI;
    for (const w of this.windsocks) {
      // world yaw so that local +X points downwind: world dir = (cos(to), sin(to)) in (x, z)
      w.pivot.rotation.y = -to + Math.sin(time * 1.3 + w.a.x) * 0.06 * Math.min(1, sp / 3);
      const droop = Math.max(0.05, 1.25 - sp / 7.5);
      w.arm.rotation.z = -Math.min(1.35, droop) + Math.sin(time * 4.1 + w.a.z) * 0.03;
    }
  }
}
