// Sky dome, sun / moon light, ambient light, stars and the image-based-lighting environment.
// Everything is driven by the time of day.

import * as THREE from 'three';
import { ATMO_PARS, atmoUniforms } from '../gfx/atmosphere.js';

const DEG = Math.PI / 180;
const LATITUDE = 42 * DEG, DECLINATION = 18 * DEG;

// palette keyframes over the sun elevation angle (degrees); colours are linear RGB
const KEYS = [
    { e: -18, zen: [0.004, 0.007, 0.018], hor: [0.012, 0.018, 0.04], glow: [0, 0, 0], sun: [0.4, 0.5, 0.75], sunI: 0.34, hemi: [0.1, 0.14, 0.26], hemiI: 0.5, gnd: [0.02, 0.022, 0.035] },
    { e: -10, zen: [0.007, 0.013, 0.036], hor: [0.03, 0.04, 0.085], glow: [0.05, 0.03, 0.03], sun: [0.4, 0.5, 0.75], sunI: 0.3, hemi: [0.1, 0.14, 0.26], hemiI: 0.5, gnd: [0.02, 0.022, 0.035] },
  { e: -5, zen: [0.02, 0.04, 0.12], hor: [0.3, 0.16, 0.13], glow: [0.7, 0.25, 0.1], sun: [0.4, 0.4, 0.55], sunI: 0.06, hemi: [0.11, 0.13, 0.22], hemiI: 0.44, gnd: [0.05, 0.04, 0.04] },
  { e: 0, zen: [0.06, 0.11, 0.3], hor: [0.85, 0.42, 0.2], glow: [1.6, 0.7, 0.25], sun: [1, 0.42, 0.18], sunI: 0.78, hemi: [0.35, 0.35, 0.46], hemiI: 0.64, gnd: [0.15, 0.12, 0.1] },
  { e: 4, zen: [0.08, 0.17, 0.44], hor: [0.9, 0.6, 0.38], glow: [1.6, 0.9, 0.45], sun: [1, 0.62, 0.36], sunI: 1.87, hemi: [0.5, 0.55, 0.7], hemiI: 0.80, gnd: [0.2, 0.17, 0.13] },
  { e: 10, zen: [0.09, 0.22, 0.55], hor: [0.78, 0.72, 0.66], glow: [1.2, 0.9, 0.6], sun: [1, 0.8, 0.6], sunI: 2.65, hemi: [0.6, 0.7, 0.9], hemiI: 0.92, gnd: [0.22, 0.2, 0.15] },
  { e: 25, zen: [0.085, 0.235, 0.62], hor: [0.6, 0.72, 0.88], glow: [0.8, 0.75, 0.65], sun: [1, 0.93, 0.82], sunI: 3.28, hemi: [0.65, 0.78, 1.0], hemiI: 1.00, gnd: [0.22, 0.21, 0.16] },
  { e: 60, zen: [0.075, 0.215, 0.62], hor: [0.52, 0.68, 0.9], glow: [0.6, 0.6, 0.55], sun: [1, 0.97, 0.92], sunI: 3.59, hemi: [0.65, 0.8, 1.0], hemiI: 1.04, gnd: [0.22, 0.21, 0.16] },
];

function palette(e, out) {
  let a = KEYS[0], b = KEYS[KEYS.length - 1], t = 0;
  if (e <= a.e) b = a;
  else if (e >= b.e) a = b;
  else for (let i = 1; i < KEYS.length; i++) if (e <= KEYS[i].e) { a = KEYS[i - 1]; b = KEYS[i]; t = (e - a.e) / (b.e - a.e); break; }
  for (const k of ['zen', 'hor', 'glow', 'sun', 'hemi', 'gnd']) out[k] = a[k].map((v, i) => v + (b[k][i] - v) * t);
  out.sunI = a.sunI + (b.sunI - a.sunI) * t;
  out.hemiI = a.hemiI + (b.hemiI - a.hemiI) * t;
  return out;
}

export class Sky {
  constructor(scene, renderer, opts = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.time = 10;
    this.sunDir = new THREE.Vector3(0, 1, 0);      // toward the sun
    this.lightDir = new THREE.Vector3(0, 1, 0);    // toward the dominant light (sun or moon)
    this.elevation = 45;
    this.night = 0;
    this.overcast = 0;                             // 0 clear .. 1 fully overcast (greys the palette)
    this.pal = {};

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    const sh = this.sun.shadow;
    sh.mapSize.set(opts.shadowSize ?? 2048, opts.shadowSize ?? 2048);
    sh.bias = -0.00004;
    sh.normalBias = 0.05;
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    scene.add(this.hemi);

    this.uniforms = {
      ...atmoUniforms,
      uGroundMix: { value: 0 },
      uGround: { value: new THREE.Color(0.1, 0.12, 0.07) },
    };
    const makeDome = (groundMix) => {
      const mat = new THREE.ShaderMaterial({
        uniforms: { ...this.uniforms, uGroundMix: { value: groundMix } },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = position;
            vec4 p = viewMatrix * vec4(position, 0.0);
            gl_Position = projectionMatrix * vec4(p.xyz, 1.0);
            gl_Position.z = gl_Position.w;
          }`,
        fragmentShader: /* glsl */ `
          ${ATMO_PARS}
          uniform vec3 uSunDisc; uniform float uNight; uniform float uTime;
          uniform float uGroundMix; uniform vec3 uGround;
          varying vec3 vDir;
          float sHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
          void main() {
            vec3 d = normalize(vDir);
            vec3 c = skyColor(d);
            float mu = dot(d, uSunDir);
            c += uSunDisc * smoothstep(0.99995, 0.99998, mu) * smoothstep(-0.03, 0.01, d.y);
            if (uNight > 0.01 && d.y > -0.03) {
              vec3 p = d * 150.0; vec3 ip = floor(p);
              float h = sHash(ip);
              if (h > 0.984) {
                vec3 o = vec3(sHash(ip + 1.3), sHash(ip + 2.7), sHash(ip + 4.1)) * 0.6 + 0.2;
                float r = length(fract(p) - o);
                float b = (h - 0.984) / 0.016;
                float tw = 0.8 + 0.2 * sin(uTime * 3.0 + h * 400.0);
                c += uNight * vec3(0.85, 0.92, 1.0) * b * b * 1.6 * tw * smoothstep(0.2, 0.02, r) * smoothstep(-0.02, 0.2, d.y);
              }
            }
            c = mix(c, uGround, uGroundMix * smoothstep(0.0, -0.1, d.y));
            gl_FragColor = vec4(atmoOutput(c), 1.0);
          }`,
        depthTest: false, depthWrite: false, side: THREE.BackSide, fog: false,
      });
      const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 3), mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = -1000;
      mesh.matrixAutoUpdate = false;
      return mesh;
    };
    this.dome = makeDome(0);
    scene.add(this.dome);
    this.envScene = new THREE.Scene();
    this.envScene.add(makeDome(1));
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envTarget = null;
    this.envDirty = true;
    this._envTime = -1e9;
    this.setTime(this.time);
  }

  /** hours: 0..24 local solar time */
  setTime(hours) {
    this.time = ((hours % 24) + 24) % 24;
    const H = (this.time - 12) * 15 * DEG;
    const sd = Math.sin(DECLINATION), cd = Math.cos(DECLINATION), sl = Math.sin(LATITUDE), cl = Math.cos(LATITUDE);
    const east = -cd * Math.sin(H);
    const north = sd * cl - cd * sl * Math.cos(H);
    const up = sd * sl + cd * cl * Math.cos(H);
    this.sunDir.set(north, up, east).normalize();
    this.elevation = Math.asin(this.sunDir.y) / DEG;
    this.applyPalette();
  }

  setOvercast(v) { this.overcast = v; this.applyPalette(); }

  applyPalette() {
    const e = this.elevation, p = palette(e, this.pal), u = atmoUniforms;
    const oc = this.overcast;
    const grey = (c, k) => { const l = 0.3 * c[0] + 0.5 * c[1] + 0.2 * c[2]; return c.map((v) => v + (l * k - v) * oc); };
    const zen = grey(p.zen, 1.9), hor = grey(p.hor, 0.95);
    u.uZenith.value.setRGB(zen[0], zen[1], zen[2]);
    u.uHorizon.value.setRGB(hor[0], hor[1], hor[2]);
    u.uSunGlow.value.setRGB(p.glow[0], p.glow[1], p.glow[2]).multiplyScalar(1 - 0.9 * oc);
    this.night = 1 - THREE.MathUtils.smoothstep(e, -12, -3);
    u.uNight.value = this.night * (1 - oc);
    u.uSunDir.value.copy(this.sunDir);
    const discK = e > -3 ? 9 * (1 - oc) : 0;
    u.uSunDisc.value.setRGB(p.sun[0] * p.sunI * discK, p.sun[1] * p.sunI * discK, p.sun[2] * p.sunI * discK);
    // dominant light: the sun by day, the moon by night
    if (e > -5) this.lightDir.copy(this.sunDir);
    else this.lightDir.set(-0.35, 0.72, 0.6).normalize();
    if (this.lightDir.y < 0.035) { this.lightDir.y = 0.035; this.lightDir.normalize(); }
    const direct = p.sunI * (1 - 0.82 * oc);
    this.sun.color.setRGB(p.sun[0], p.sun[1], p.sun[2]);
    if (oc > 0) this.sun.color.lerp(new THREE.Color(0.8, 0.82, 0.86), oc * 0.8);
    this.sun.intensity = direct;
    const hemi = grey(p.hemi, 1.15);
    this.hemi.color.setRGB(hemi[0], hemi[1], hemi[2]);
    this.hemi.groundColor.setRGB(p.gnd[0], p.gnd[1], p.gnd[2]);
    this.hemi.intensity = p.hemiI * (1 - 0.25 * oc);
    this.uniforms.uGround.value.setRGB(p.gnd[0] * 0.8, p.gnd[1] * 0.9, p.gnd[2] * 0.7).multiplyScalar(0.25 + 0.2 * p.hemiI);
    this.sun.castShadow = e > -4 && oc < 0.8;
    this.sunStrength = direct;       // for other shaders (water, clouds)
    this.sunColor = this.sun.color;
    this.envDirty = true;
  }

  /** Regenerate the reflection environment (rate limited). */
  updateEnvironment(now, force = false) {
    if (!this.envDirty || (!force && now - this._envTime < 4)) return;
    this.envDirty = false;
    this._envTime = now;
    const old = this.envTarget;
    this.envTarget = this.pmrem.fromScene(this.envScene, 0, 0.1, 100);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = 1.0;
    if (old) old.dispose();
  }

  /**
   * @param camera active camera
   * @param focus  point that must receive detailed shadows (the aircraft)
   * @param radius shadow box half-size around the focus
   * @param agl    height of the focus above ground (to reach the terrain with the shadow)
   */
  update(camera, focus, radius, agl, now) {
    atmoUniforms.uTime.value = now;
    const d = this.lightDir;
    const dist = 400;
    this.sun.position.set(focus.x + d.x * dist, focus.y + d.y * dist, focus.z + d.z * dist);
    this.sun.target.position.copy(focus);
    this.sun.target.updateMatrixWorld();
    const cam = this.sun.shadow.camera;
    if (cam.right !== radius) {
      cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius;
    }
    cam.near = dist - radius * 1.5;
    cam.far = dist + radius * 1.5 + Math.min(9000, Math.max(0, agl) / Math.max(d.y, 0.08));
    cam.updateProjectionMatrix();
    this.updateEnvironment(now);
  }
}
