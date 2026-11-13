// Particle effects: tyre smoke, dust, aerobatic smoke, contrails, explosions, wreck smoke, rain.
// One instanced, camera-facing quad per particle; a per-particle "additive" factor lets fire and
// smoke share a single draw call.

import * as THREE from 'three';
import { ATMO_PARS, atmoUniforms } from './atmosphere.js';

const MAX = 3000;

function blobTexture() {
  const S = 64, c = document.createElement('canvas'); c.width = c.height = S;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,0.62)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.18)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(c);
}

export class Effects {
  constructor(scene) {
    this.p = [];                     // live particles
    this.pool = [];
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    this.iCol = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    this.iMisc = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 2), 2);
    for (const a of [this.iPos, this.iCol, this.iMisc]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.iPos); geo.setAttribute('iCol', this.iCol); geo.setAttribute('iMisc', this.iMisc);
    geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...atmoUniforms, uTex: { value: blobTexture() }, uLight: { value: new THREE.Color(1, 1, 1) } },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec4 iPos; attribute vec4 iCol; attribute vec2 iMisc;
        varying vec2 vUv; varying vec4 vCol; varying float vAdd; varying vec3 vWorld;
        void main() {
          vec4 mv = viewMatrix * vec4(iPos.xyz, 1.0);
          float a = iMisc.y; float ca = cos(a), sa = sin(a);
          vec2 c = vec2(position.x * ca - position.y * sa, position.x * sa + position.y * ca);
          mv.xy += c * iPos.w;
          vUv = position.xy * 0.5 + 0.5; vCol = iCol; vAdd = iMisc.x; vWorld = iPos.xyz;
          gl_Position = projectionMatrix * mv;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        ${ATMO_PARS}
        uniform sampler2D uTex; uniform vec3 uLight;
        varying vec2 vUv; varying vec4 vCol; varying float vAdd; varying vec3 vWorld;
        void main() {
          #include <logdepthbuf_fragment>
          float a = texture2D(uTex, vUv).a * vCol.a;
          if (a < 0.003) discard;
          vec3 col = vCol.rgb * mix(uLight, vec3(1.0), vAdd);
          col = atmoOutput(col);
          float f = fogFactor(cameraPosition, vWorld) * (1.0 - vAdd);
          col = mix(col, atmoOutput(fogColor(cameraPosition, vWorld)), f);
          gl_FragColor = vec4(col * a, a * (1.0 - vAdd));
        }`,
      transparent: true, depthWrite: false, fog: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 15;
    scene.add(this.mesh);
    this.emitters = [];
    this.trailDist = 0; this.conDist = 0;
  }

  spawn(x, y, z, o) {
    if (this.p.length >= MAX) return;
    const q = this.pool.pop() || {};
    q.x = x; q.y = y; q.z = z;
    q.vx = o.vx || 0; q.vy = o.vy || 0; q.vz = o.vz || 0;
    q.life = o.life; q.age = 0;
    q.s0 = o.s0; q.s1 = o.s1 ?? o.s0;
    q.r = o.r; q.g = o.g; q.b = o.b; q.a = o.a ?? 1;
    q.add = o.add || 0; q.drag = o.drag || 0; q.grav = o.grav || 0;
    q.rot = Math.random() * 6.28; q.spin = (Math.random() - 0.5) * (o.spin ?? 0.6);
    q.fadeIn = o.fadeIn ?? 0.08;
    q.r1 = o.r1 ?? o.r; q.g1 = o.g1 ?? o.g; q.b1 = o.b1 ?? o.b;
    this.p.push(q);
  }

  explosion(x, y, z, scale = 1, vx = 0, vy = 0, vz = 0) {
    const R = () => Math.random() - 0.5;
    for (let i = 0; i < 46; i++) {
      this.spawn(x + R() * 3 * scale, y + Math.random() * 2 * scale, z + R() * 3 * scale, {
        vx: vx * 0.3 + R() * 22 * scale, vy: Math.random() * 16 * scale, vz: vz * 0.3 + R() * 22 * scale,
        life: 0.5 + Math.random() * 0.9, s0: 2 * scale, s1: (7 + Math.random() * 8) * scale,
        r: 4.0, g: 1.9, b: 0.5, r1: 1.2, g1: 0.25, b1: 0.05, a: 0.9, add: 0.85, drag: 2.2,
      });
    }
    for (let i = 0; i < 60; i++) {
      this.spawn(x + R() * 5 * scale, y + Math.random() * 3 * scale, z + R() * 5 * scale, {
        vx: vx * 0.2 + R() * 14 * scale, vy: 4 + Math.random() * 14 * scale, vz: vz * 0.2 + R() * 14 * scale,
        life: 3 + Math.random() * 5, s0: 3 * scale, s1: (16 + Math.random() * 18) * scale,
        r: 0.05, g: 0.05, b: 0.05, a: 0.75, drag: 0.9, grav: -0.6,
      });
    }
    for (let i = 0; i < 40; i++) {
      this.spawn(x, y + 1, z, {
        vx: vx * 0.5 + R() * 60 * scale, vy: Math.random() * 45 * scale, vz: vz * 0.5 + R() * 60 * scale,
        life: 0.8 + Math.random() * 1.4, s0: 0.35 * scale, s1: 0.1, r: 5, g: 3, b: 1, add: 1, grav: 9.8, drag: 0.4, fadeIn: 0,
      });
    }
    this.emitters.push({ x, y, z, t: 0, life: 45, rate: 14, scale, acc: 0 });
  }

  splash(x, y, z, scale = 1) {
    const R = () => Math.random() - 0.5;
    for (let i = 0; i < 70; i++) {
      this.spawn(x + R() * 6 * scale, y, z + R() * 6 * scale, {
        vx: R() * 26 * scale, vy: 8 + Math.random() * 30 * scale, vz: R() * 26 * scale,
        life: 1.2 + Math.random() * 1.8, s0: 1.5 * scale, s1: (5 + Math.random() * 6) * scale,
        r: 0.85, g: 0.9, b: 0.95, a: 0.8, grav: 9.8, drag: 0.6,
      });
    }
  }

  tyreSmoke(x, y, z, vx, vz, k = 1) {
    for (let i = 0; i < 7; i++) {
      this.spawn(x + (Math.random() - 0.5), y + 0.2, z + (Math.random() - 0.5), {
        vx: vx * 0.25 + (Math.random() - 0.5) * 3, vy: 0.6 + Math.random() * 1.6, vz: vz * 0.25 + (Math.random() - 0.5) * 3,
        life: 1.2 + Math.random() * 1.6, s0: 0.5, s1: 3 + Math.random() * 3 * k, r: 0.78, g: 0.78, b: 0.8, a: 0.4 * k, drag: 1.5,
      });
    }
  }

  dust(x, y, z, vx, vz) {
    this.spawn(x, y + 0.2, z, {
      vx: vx * 0.3 + (Math.random() - 0.5) * 2, vy: 0.5 + Math.random(), vz: vz * 0.3 + (Math.random() - 0.5) * 2,
      life: 1.5 + Math.random() * 1.5, s0: 0.6, s1: 3.5 + Math.random() * 2, r: 0.5, g: 0.43, b: 0.3, a: 0.28, drag: 1.2,
    });
  }

  /** smoke / vapour trail emitted along the flight path (call every frame with the nozzle position) */
  trail(prev, cur, spacing, opts) {
    const dx = cur.x - prev.x, dy = cur.y - prev.y, dz = cur.z - prev.z;
    const d = Math.hypot(dx, dy, dz);
    opts._acc = (opts._acc || 0) + d;
    while (opts._acc >= spacing) {
      opts._acc -= spacing;
      const t = d > 0 ? 1 - opts._acc / d : 1;
      this.spawn(prev.x + dx * t + (Math.random() - 0.5) * opts.jitter, prev.y + dy * t + (Math.random() - 0.5) * opts.jitter, prev.z + dz * t + (Math.random() - 0.5) * opts.jitter, opts);
    }
  }

  clear() { for (const q of this.p) this.pool.push(q); this.p.length = 0; this.emitters.length = 0; }

  update(dt, camera, sky, wind) {
    // wreck fires keep smoking
    for (const e of this.emitters) {
      e.t += dt; e.acc += dt * e.rate * Math.max(0.15, 1 - e.t / e.life);
      while (e.acc >= 1) {
        e.acc -= 1;
        const fire = Math.random() < 0.3 && e.t < e.life * 0.6;
        if (fire) this.spawn(e.x + (Math.random() - 0.5) * 3, e.y + 0.5, e.z + (Math.random() - 0.5) * 3, { vy: 2 + Math.random() * 3, life: 0.5 + Math.random() * 0.5, s0: 1.2 * e.scale, s1: 2.6 * e.scale, r: 3.5, g: 1.5, b: 0.3, r1: 1, g1: 0.2, b1: 0.02, a: 0.8, add: 0.9 });
        else this.spawn(e.x + (Math.random() - 0.5) * 3, e.y + 1, e.z + (Math.random() - 0.5) * 3, { vx: (Math.random() - 0.5) * 2, vy: 4 + Math.random() * 4, vz: (Math.random() - 0.5) * 2, life: 6 + Math.random() * 6, s0: 2 * e.scale, s1: (14 + Math.random() * 10) * e.scale, r: 0.06, g: 0.06, b: 0.06, a: 0.6, drag: 0.3 });
      }
    }
    this.emitters = this.emitters.filter((e) => e.t < e.life);
    const wx = wind ? wind.current.x : 0, wz = wind ? wind.current.z : 0;
    const P = this.iPos.array, C = this.iCol.array, M = this.iMisc.array;
    let n = 0;
    const live = this.p;
    for (let i = 0; i < live.length; i++) {
      const q = live[i];
      q.age += dt;
      if (q.age >= q.life) { this.pool.push(q); continue; }
      const k = Math.exp(-q.drag * dt);
      // particles slow down relative to the moving air
      q.vx = wx + (q.vx - wx) * k; q.vz = wz + (q.vz - wz) * k; q.vy = q.vy * k - q.grav * dt;
      q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
      q.rot += q.spin * dt;
      const t = q.age / q.life;
      const o = n * 4;
      P[o] = q.x; P[o + 1] = q.y; P[o + 2] = q.z; P[o + 3] = q.s0 + (q.s1 - q.s0) * Math.sqrt(t);
      C[o] = q.r + (q.r1 - q.r) * t; C[o + 1] = q.g + (q.g1 - q.g) * t; C[o + 2] = q.b + (q.b1 - q.b) * t;
      C[o + 3] = q.a * Math.min(1, q.age / Math.max(q.fadeIn, 1e-3)) * (1 - t) * (1 - t * t);
      M[n * 2] = q.add; M[n * 2 + 1] = q.rot;
      live[n++] = q;
    }
    live.length = n;
    this.iPos.needsUpdate = true; this.iCol.needsUpdate = true; this.iMisc.needsUpdate = true;
    this.mesh.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    const u = this.mesh.material.uniforms.uLight.value;
    u.copy(sky.hemi.color).multiplyScalar(sky.hemi.intensity * 0.5).add(this._tmp.copy(sky.sun.color).multiplyScalar(sky.sun.intensity * 0.22));
  }
  _tmp = new THREE.Color();
}

/** Rain: streaks in a box that travels with the camera; their slant follows the relative wind. */
export class Rain {
  constructor(scene, count = 2600) {
    const pos = new Float32Array(count * 6), end = new Float32Array(count * 2);
    let seed = 777;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 8) / 16777216; };
    for (let i = 0; i < count; i++) {
      const x = rnd(), y = rnd(), z = rnd();
      pos.set([x, y, z, x, y, z], i * 6);
      end[i * 2] = 0; end[i * 2 + 1] = 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    this.uniforms = {
      uOffset: { value: new THREE.Vector3() }, uStreak: { value: new THREE.Vector3(0, -1, 0) },
      uBox: { value: 46 }, uAlpha: { value: 0 }, uColor: { value: new THREE.Color(0.7, 0.75, 0.8) },
    };
    const m = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute float aEnd;
        uniform vec3 uOffset; uniform vec3 uStreak; uniform float uBox;
        varying float vA;
        void main() {
          vec3 p = mod(position * uBox + uOffset, uBox) - 0.5 * uBox;
          vA = (1.0 - smoothstep(0.3 * uBox, 0.5 * uBox, length(p))) * (1.0 - aEnd * 0.7);
          p += cameraPosition + uStreak * aEnd;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform float uAlpha; uniform vec3 uColor;
        varying float vA;
        void main() {
          #include <logdepthbuf_fragment>
          gl_FragColor = vec4(uColor, vA * uAlpha);
        }`,
      transparent: true, depthWrite: false, fog: false,
    });
    this.mesh = new THREE.LineSegments(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 18;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.prev = new THREE.Vector3(); this.rel = new THREE.Vector3(); this.has = false; this.level = 0;
  }

  update(dt, camera, wind, intensity, sky) {
    this.level += (intensity - this.level) * Math.min(1, dt * 0.8);
    if (this.level < 0.01 || dt <= 0) { this.mesh.visible = false; this.prev.copy(camera.position); this.has = true; return; }
    this.mesh.visible = true;
    // rain velocity in the world (falling at ~9 m/s and drifting with the wind) relative to the camera
    const vx = wind ? wind.current.x : 0, vz = wind ? wind.current.z : 0;
    const cvx = this.has ? (camera.position.x - this.prev.x) / dt : 0, cvy = this.has ? (camera.position.y - this.prev.y) / dt : 0, cvz = this.has ? (camera.position.z - this.prev.z) / dt : 0;
    this.prev.copy(camera.position); this.has = true;
    const o = this.uniforms.uOffset.value;
    // drops move through the box with their own velocity; the box itself rides with the camera
    o.x += (vx - cvx) * dt; o.y += (-9 - cvy) * dt; o.z += (vz - cvz) * dt;
    const B = this.uniforms.uBox.value;
    o.x = ((o.x % B) + B) % B; o.y = ((o.y % B) + B) % B; o.z = ((o.z % B) + B) % B;
    this.rel.set(vx - cvx, -9 - cvy, vz - cvz);
    const sp = this.rel.length();
    // streak length = distance travelled during the eye's integration time
    this.uniforms.uStreak.value.copy(this.rel).multiplyScalar(Math.min(0.045, 6 / Math.max(sp, 1)));
    this.uniforms.uAlpha.value = 0.5 * this.level;
    const l = 0.25 + 0.75 * Math.min(1, sky.hemi.intensity);
    this.uniforms.uColor.value.setRGB(0.72 * l, 0.77 * l, 0.84 * l);
  }
}
