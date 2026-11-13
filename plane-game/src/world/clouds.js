// Clouds: fields of cumulus built from camera-facing soft "puffs" (instanced billboards lit by
// the sun with flat dark bases and bright tops), an optional stratus deck for overcast weather,
// and a matching shadow map that the terrain shader samples so cloud shadows drift over the land.

import * as THREE from 'three';
import { ATMO_PARS, atmoUniforms } from '../gfx/atmosphere.js';
import { hash2 } from './noise.js';
import { noised } from './noise.js';

const CELL = 2600;          // one potential cloud per cell (m)
const PERIOD = 64;          // the field repeats every PERIOD cells
const TILE = CELL * PERIOD;
const VIEW_CELLS = 13;
const MAX_PUFFS = 5200;

function puffTexture() {
  // 2x2 atlas of fluffy alpha blobs
  const S = 256, c = document.createElement('canvas');
  c.width = c.height = S * 2;
  const ctx = c.getContext('2d');
  let seed = 4242;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 8) / 16777216; };
  for (let v = 0; v < 4; v++) {
    const ox = (v % 2) * S, oy = Math.floor(v / 2) * S;
    ctx.save();
    ctx.beginPath(); ctx.rect(ox, oy, S, S); ctx.clip();
    for (let k = 0; k < 46; k++) {
      const a = rnd() * 6.283, d = Math.pow(rnd(), 0.8) * S * 0.25;
      const x = ox + S / 2 + Math.cos(a) * d, y = oy + S / 2 + Math.sin(a) * d * 0.85;
      const r = S * (0.1 + rnd() * 0.16) * (1 - d / (S * 0.42));
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(255,255,255,${0.22 + rnd() * 0.2})`);
      g.addColorStop(0.55, 'rgba(255,255,255,0.1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    ctx.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  return t;
}

export class Clouds {
  constructor(scene) {
    this.scene = scene;
    this.coverage = 0.3;
    this.base = 1500;
    this.thickness = 900;
    this.stratus = 0;            // 0..1 opacity of the overcast deck
    this.drift = new THREE.Vector2();
    this.puffs = [];             // {x, y, z, size, shade, seed, cloud radius}
    this.cellKey = '';
    this.sortFrame = 0;
    this.enabled = true;

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PUFFS * 4), 4);
    this.iData = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PUFFS * 4), 4);
    this.iPos.setUsage(THREE.DynamicDrawUsage); this.iData.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.iPos);
    geo.setAttribute('iData', this.iData);
    geo.instanceCount = 0;
    this.uniforms = {
      ...atmoUniforms,
      uPuff: { value: puffTexture() },
      uDrift: { value: new THREE.Vector3() },
      uSunCol: { value: new THREE.Color(1, 1, 1) },
      uAmbCol: { value: new THREE.Color(0.5, 0.6, 0.8) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec4 iPos; attribute vec4 iData;
        uniform vec3 uDrift;
        varying vec2 vUv; varying vec3 vWorld; varying vec4 vData; varying float vNear;
        void main() {
          vec3 center = iPos.xyz + uDrift;
          vec3 toCam = cameraPosition - center;
          float dist = length(toCam);
          vec3 f = toCam / max(dist, 1.0);
          vec3 r = normalize(cross(vec3(0.0, 1.0, 0.0), f) + vec3(1e-4, 0.0, 0.0));
          vec3 u = cross(f, r);
          float a = iData.y * 6.2831;
          float ca = cos(a), sa = sin(a);
          vec2 c = vec2(position.x * ca - position.y * sa, position.x * sa + position.y * ca);
          vec3 wp = center + (r * c.x + u * c.y) * iPos.w;
          vWorld = wp;
          float variant = floor(iData.y * 3.999);
          vUv = (position.xy * 0.5 + 0.5) * 0.5 + vec2(mod(variant, 2.0), floor(variant / 2.0)) * 0.5;
          vData = iData;
          // fade puffs as the camera flies into them instead of popping through a sprite
          vNear = smoothstep(iPos.w * 0.25, iPos.w * 1.1, dist);
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        ${ATMO_PARS}
        uniform sampler2D uPuff; uniform vec3 uSunCol; uniform vec3 uAmbCol;
        varying vec2 vUv; varying vec3 vWorld; varying vec4 vData; varying float vNear;
        void main() {
          #include <logdepthbuf_fragment>
          float a = texture2D(uPuff, vUv).a;
          a = smoothstep(0.02, 0.75, a) * vData.w * vNear;
          if (a < 0.004) discard;
          float h = vData.x;                         // 0 at the cloud base .. 1 at the top
          vec3 V = normalize(vWorld - cameraPosition);
          float toward = max(dot(V, uSunDir), 0.0);
          // sunlit tops, shaded bases; the side facing the sun is brighter
          float lit = mix(0.28, 1.0, smoothstep(0.0, 0.85, h)) * (0.72 + 0.28 * vData.z);
          vec3 col = uAmbCol * (0.5 + 0.5 * h) + uSunCol * lit;
          // silver lining when looking toward the sun through thin edges
          col += uSunCol * pow(toward, 8.0) * (1.0 - a) * 1.2;
          col = atmoOutput(col);
          float f = fogFactor(cameraPosition, vWorld);
          col = mix(col, atmoOutput(fogColor(cameraPosition, vWorld)), f);
          gl_FragColor = vec4(col * a, a);
        }`,
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    scene.add(this.mesh);

    // overcast deck
    const sm = new THREE.ShaderMaterial({
      uniforms: { ...atmoUniforms, uSunCol: this.uniforms.uSunCol, uAmbCol: this.uniforms.uAmbCol, uOpacity: { value: 0 }, uDrift: this.uniforms.uDrift },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec3 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        ${ATMO_PARS}
        uniform vec3 uSunCol; uniform vec3 uAmbCol; uniform float uOpacity; uniform vec3 uDrift;
        varying vec3 vWorld;
        float h21(vec2 p) { p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
        float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
        float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vn(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }
        void main() {
          #include <logdepthbuf_fragment>
          vec2 p = (vWorld.xz - uDrift.xz) / 5200.0;
          float n = fbm(p) * 0.65 + fbm(p * 4.3) * 0.35;
          float a = smoothstep(0.62 - uOpacity * 0.5, 0.78 - uOpacity * 0.38, n + uOpacity * 0.3) * min(1.0, uOpacity * 1.6);
          float above = step(vWorld.y, cameraPosition.y);
          vec3 col = mix(uAmbCol * 0.42 + uSunCol * 0.05, uAmbCol * 0.75 + uSunCol * (0.55 + 0.4 * n), above);
          col = atmoOutput(col);
          float f = fogFactor(cameraPosition, vWorld);
          col = mix(col, atmoOutput(fogColor(cameraPosition, vWorld)), f);
          gl_FragColor = vec4(col, a * (1.0 - f * f));
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
    });
    const sg = new THREE.PlaneGeometry(1, 1); sg.rotateX(-Math.PI / 2);
    this.deck = new THREE.Mesh(sg, sm);
    this.deck.scale.set(400000, 1, 400000);
    this.deck.frustumCulled = false;
    this.deck.renderOrder = 9;
    this.deck.visible = false;
    scene.add(this.deck);

    this.shadowCanvas = document.createElement('canvas');
    this.shadowCanvas.width = this.shadowCanvas.height = 256;
    this.shadowTex = new THREE.CanvasTexture(this.shadowCanvas);
    this.shadowTex.wrapS = this.shadowTex.wrapT = THREE.RepeatWrapping;
    this.shadowTex.flipY = false;
    this.shadowTex.minFilter = THREE.LinearFilter; this.shadowTex.generateMipmaps = false;
    atmoUniforms.uCloudShadowMap.value = this.shadowTex;
    atmoUniforms.uCloudShadowParams.value.z = 1 / TILE;
    this.setWeather({ coverage: 0.3, base: 1500 });
  }

  /** deterministic description of the cloud in cell (i, j), or null */
  cloudInCell(i, j) {
    const pi = ((i % PERIOD) + PERIOD) % PERIOD, pj = ((j % PERIOD) + PERIOD) % PERIOD;
    const r = hash2(pi * 3 + 11, pj * 5 + 7);
    // clumps and gaps on a larger scale (periodic noise lookup)
    const cl = 0.55 + 0.9 * (noised(pi * 0.19 + 3.3, pj * 0.19 + 9.1) * 0.5 + 0.5) * (pi > 2 && pj > 2 ? 1 : 0.6);
    if (r > this.coverage * cl) return null;
    const r2 = hash2(pi + 131, pj + 977), r3 = hash2(pi + 4441, pj + 23), r4 = hash2(pi * 7 + 1, pj * 3 + 5);
    return {
      x: (i + 0.15 + 0.7 * r2) * CELL, z: (j + 0.15 + 0.7 * r3) * CELL,
      radius: (520 + 1100 * r4 * r4) * (0.8 + 0.7 * this.coverage),
      seed: pi * 131 + pj * 17 + 1,
    };
  }

  setWeather({ coverage, base, stratus = 0, thickness }) {
    this.coverage = coverage; this.base = base; this.stratus = stratus;
    this.thickness = thickness ?? 500 + 900 * coverage;
    this.cellKey = '';
    this.deck.visible = stratus > 0.01;
    this.deck.material.uniforms.uOpacity.value = stratus;
    // shadow map for one period of the field
    const ctx = this.shadowCanvas.getContext('2d'), S = 256, k = S / TILE;
    ctx.globalCompositeOperation = 'source-over';
    const baseShade = Math.round(stratus * 150);
    ctx.fillStyle = `rgb(${baseShade},${baseShade},${baseShade})`; ctx.fillRect(0, 0, S, S);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < PERIOD; i++) for (let j = 0; j < PERIOD; j++) {
      const c = this.cloudInCell(i, j);
      if (!c) continue;
      for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
        const x = c.x * k + ox, y = c.z * k + oy, r = c.radius * k * 1.25;
        if (x < -r || y < -r || x > S + r || y > S + r) continue;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(255,255,255,0.85)'); g.addColorStop(0.6, 'rgba(255,255,255,0.6)'); g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g; ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
      }
    }
    this.shadowTex.needsUpdate = true;
  }

  rebuild(ci, cj) {
    const puffs = this.puffs;
    puffs.length = 0;
    if (this.coverage <= 0.001) return;
    for (let i = ci - VIEW_CELLS; i <= ci + VIEW_CELLS; i++) for (let j = cj - VIEW_CELLS; j <= cj + VIEW_CELLS; j++) {
      const di = i - ci, dj = j - cj;
      if (di * di + dj * dj > VIEW_CELLS * VIEW_CELLS) continue;
      const c = this.cloudInCell(i, j);
      if (!c) continue;
      let s = c.seed * 2654435761 >>> 0;
      const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return (s >>> 8) / 16777216; };
      const R = c.radius, height = Math.min(this.thickness, R * (0.7 + 0.7 * rnd()));
      const n = Math.min(26, Math.round(7 + R / 95));
      const edge = 1 - Math.max(0, (Math.sqrt(di * di + dj * dj) - (VIEW_CELLS - 3)) / 3);    // fade in at the rim
      for (let k = 0; k < n; k++) {
        const a = rnd() * 6.283, d = Math.sqrt(rnd()) * R * 0.85;
        const dome = 1 - (d / R) * (d / R);
        const yf = k < n * 0.4 ? rnd() * 0.25 : rnd() * dome;       // many puffs along the flat base
        const size = (240 + 300 * rnd()) * (0.75 + R / 1700) * (1 - 0.35 * yf);
        if (puffs.length >= MAX_PUFFS) break;
        puffs.push({
          x: c.x + Math.cos(a) * d, y: this.base + size * 0.42 + yf * height, z: c.z + Math.sin(a) * d,
          size, shade: Math.min(1, yf * 1.15 + 0.08 * rnd()), seed: rnd(), ox: Math.cos(a) * d / R, oz: Math.sin(a) * d / R,
          alpha: edge * (0.75 + 0.25 * rnd()), dist: 0,
        });
      }
    }
  }

  /** 0..1: how deep inside cloud the point is (for the white-out effect) */
  densityAt(p) {
    let dens = 0;
    if (this.stratus > 0.01) {
      const t = 1 - Math.abs(p.y - this.base) / 180;
      if (t > 0) dens = Math.max(dens, t * Math.min(1, this.stratus * 1.4));
    }
    if (this.coverage > 0 && p.y > this.base - 300 && p.y < this.base + this.thickness + 700) {
      const dx = this.drift.x, dz = this.drift.y;
      for (const q of this.puffs) {
        const x = q.x + dx - p.x, y = (q.y - p.y) * 1.3, z = q.z + dz - p.z;
        const r = q.size * 0.8;
        const d2 = x * x + y * y + z * z;
        if (d2 < r * r) dens = Math.max(dens, (1 - Math.sqrt(d2) / r) * 1.6 * q.alpha);
      }
    }
    return Math.min(1, dens);
  }

  update(camera, sky, wind, dt) {
    // drift with the wind aloft
    if (wind && wind.speed > 0) {
      const sp = wind.speed * 1.3;
      this.drift.x -= Math.cos(wind.dirFrom) * sp * dt;
      this.drift.y -= Math.sin(wind.dirFrom) * sp * dt;
    }
    const cp = camera.position;
    this.uniforms.uDrift.value.set(this.drift.x, 0, this.drift.y);
    this.uniforms.uSunCol.value.copy(sky.sun.color).multiplyScalar(sky.sun.intensity * 0.46);
    this.uniforms.uAmbCol.value.copy(sky.hemi.color).multiplyScalar(sky.hemi.intensity * 0.8);
    this.deck.position.set(cp.x, this.base + (this.stratus > 0 ? 60 : 0), cp.z);
    // shadows are displaced along the sun direction
    const sd = sky.lightDir, k = (this.base + 300) / Math.max(sd.y, 0.2);
    const par = atmoUniforms.uCloudShadowParams.value;
    par.x = sd.x * k - this.drift.x; par.y = sd.z * k - this.drift.y;
    par.w = this.enabled ? Math.min(1, sky.sun.intensity / 2.2) : 0;
    if (!this.enabled) { this.mesh.visible = false; return; }
    this.mesh.visible = true;

    const ci = Math.floor((cp.x - this.drift.x) / CELL), cj = Math.floor((cp.z - this.drift.y) / CELL);
    const key = ci + ',' + cj;
    let dirty = false;
    if (key !== this.cellKey) { this.cellKey = key; this.rebuild(ci, cj); dirty = true; }
    if (dirty || (this.sortFrame++ % 6) === 0) {
      // back-to-front order for correct blending
      const puffs = this.puffs, dx = this.drift.x - cp.x, dz = this.drift.y - cp.z;
      for (const q of puffs) { const x = q.x + dx, y = q.y - cp.y, z = q.z + dz; q.dist = x * x + y * y + z * z; }
      puffs.sort((a, b) => b.dist - a.dist);
      const P = this.iPos.array, D = this.iData.array;
      const sx = sky.lightDir.x, sz = sky.lightDir.z;
      for (let i = 0; i < puffs.length; i++) {
        const q = puffs[i], o = i * 4;
        P[o] = q.x; P[o + 1] = q.y; P[o + 2] = q.z; P[o + 3] = q.size;
        D[o] = q.shade; D[o + 1] = q.seed; D[o + 2] = Math.max(0, Math.min(1, 0.5 + 0.6 * (q.ox * sx + q.oz * sz))); D[o + 3] = q.alpha;
      }
      this.iPos.needsUpdate = true; this.iData.needsUpdate = true;
      this.mesh.geometry.instanceCount = puffs.length;
    }
  }
}
