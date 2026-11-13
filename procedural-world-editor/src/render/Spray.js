// Spray thrown up by breaking waves. Stateless GPU particles: a grid of soft sprites around the
// camera, each anchored to a world cell of the surf zone. A particle is launched when a breaking
// crest of the refracted swell passes its cell (time since the crest passed comes from the wave
// phase), flies ballistically forward with the wave and falls back. Because everything derives
// from the same swell field as the water surface, spray always sits on the waves that break.
import * as THREE from 'three';
import { GLOBALS_GLSL, NOISE_GLSL, ATMOS_GLSL } from './shaders/common.glsl.js';
import { WATER_COMMON } from './WaterRenderer.js';

const GRID = 176; // cells per side
const CELL = 0.7; // m

const VERT = /* glsl */ `
precision highp float;
${GLOBALS_GLSL}
${NOISE_GLSL}
${WATER_COMMON}
in vec2 aCell;
uniform vec3 uGrid;      // xy = world position of cell (0,0), z = cell size
uniform vec3 uCamRight; uniform vec3 uCamUp;
out vec2 vQuad; out float vAlpha; out vec3 vWorld; out float vSeed; out float vViewDepth; out float vK;
float h1(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main(){
  vQuad = position.xy;
  vec2 wc = floor(uGrid.xy / uGrid.z + 0.5) + aCell;          // world cell index (stable while the grid moves)
  float r0 = h1(wc), r1 = h1(wc + 17.3), r2 = h1(wc + 41.9), r3 = h1(wc + 73.1);
  vec2 xz = (wc + vec2(r0, r1)) * uGrid.z;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vAlpha = 0.0; vWorld = vec3(0.0); vSeed = r2; vViewDepth = 0.0; vK = 0.0;
  WaterBase b = waterBaseAt(xz, 0.0);
  if (!b.valid || b.ocean < 0.5) return;
  float th = terrainHeightAt(xz);
  float depth = th < -9e3 ? 60.0 : b.surf - th;
  if (depth < 0.12) return;
  vec2 sl; vec3 info; vec4 fr;
  float sw = swellWave(xz, depth, b.shore, b.ocean, sl, info, fr);
  if (gSwellBrk < 0.25) return;
  float period = 6.2831853 / max(uSwellParams.y, 0.1);
  float tb = fract(-fr.x / 6.2831853);
  float t = tb * period;
  if (t > period * 0.5) t -= period;                           // just ahead of the crest: negative
  float delay = mix(-0.2, 0.55, r2 * r2);
  float life = mix(0.4, 1.3, r3);
  float tp = t - delay;
  if (tp < 0.0 || tp > life) return;
  // only a fraction of the cells throw spray, more where breaking is violent
  // spray comes off the crest in bursts: clumps a few metres long with gaps between them
  float clump = smoothstep(0.35, 0.7, vnoise(xz * 0.22 + floor(-fr.x / 6.2831853 + 0.5) * 3.7));
  if (gSwellH < 0.22 || r0 * 1.1 > gSwellBrk * (0.15 + 0.85 * clump) * (0.3 + 0.7 * smoothstep(0.3, 1.1, gSwellH))) return;
  float c = min(fr.y, 8.0);
  float v0 = (1.1 + 2.3 * r1) * sqrt(max(gSwellH, 0.05)) * 1.6;
  float crest = b.surf + gSwellH * 0.62;
  vec3 p = vec3(xz.x, crest, xz.y);
  // the crest has moved on by c * t since it passed this cell; the spray starts at the crest
  p.xz += fr.zw * c * (delay + tp * (0.75 + 0.35 * r3));
  p.xz += (vec2(r1, r2) - 0.5) * 0.9 * tp;
  p.y += v0 * tp - 4.9 * tp * tp * 0.8;
  float k = tp / life;
  float size = mix(0.12, 0.7, sqrt(k)) * (0.35 + 1.3 * r3 * r3) * (0.6 + 0.6 * sqrt(max(gSwellH, 0.1)));
  if (p.y < b.surf - 0.15) return;
  // stretched along its motion early on (thrown sheets and fingers of water), rounder as it turns to mist
  float stretch = mix(1.9, 1.0, smoothstep(0.0, 0.6, k));
  vec3 wp = p + (uCamRight * position.x + (uCamUp * 0.85 + vec3(fr.z, 0.0, fr.w) * 0.25) * position.y * stretch) * size;
  vWorld = wp;
  vAlpha = smoothstep(0.0, 0.08, k) * (1.0 - smoothstep(0.3, 0.9, k)) * (0.5 + 0.4 * gSwellBrk);
  vK = k;
  vec4 vp = viewMatrix * vec4(wp, 1.0);
  vViewDepth = -vp.z;
  // no sprite right in front of the lens; beyond a few hundred metres individual puffs are below a pixel
  vAlpha *= smoothstep(1.0, 4.0, vViewDepth) * (1.0 - smoothstep(180.0, 420.0, vViewDepth));
  gl_Position = projectionMatrix * vp;
}
`;

const FRAG = /* glsl */ `
precision highp float;
${GLOBALS_GLSL}
${NOISE_GLSL}
${ATMOS_GLSL}
in vec2 vQuad; in float vAlpha; in vec3 vWorld; in float vSeed; in float vViewDepth; in float vK;
out vec4 outColor;
vec3 shIrr(vec3 n){
  return uSH[0] + uSH[1] * n.y + uSH[2] * n.z + uSH[3] * n.x + uSH[4] * (n.x*n.y) + uSH[5] * (n.y*n.z) + uSH[6] * (3.0*n.z*n.z - 1.0) + uSH[7] * (n.x*n.z) + uSH[8] * (n.x*n.x - n.y*n.y);
}
void main(){
  if (vAlpha <= 0.002) discard;
  float r = length(vQuad);
  if (r > 1.0) discard;
  // ragged droplet cloud: soft disc broken up by noise that is fixed to the sprite
  // droplets and fingers early (hard, speckled), fine mist later (soft)
  float n = vnoise(vQuad * 3.4 + vSeed * 37.0) * 0.5 + vnoise(vQuad * 9.0 + vSeed * 91.0) * 0.5;
  float hard = smoothstep(0.52, 0.66, n + (1.0 - r) * 0.22);
  float soft = smoothstep(0.3, 0.8, n + (1.0 - r) * 0.5) * 0.55;
  float a = smoothstep(1.0, 0.3, r) * mix(hard, soft, smoothstep(0.15, 0.6, vK)) * vAlpha;
  if (a < 0.004) discard;
  // spray is a cloud of droplets: forward scattering towards the sun, sky light otherwise
  vec3 V = normalize(uCamPos - vWorld);
  float fw = pow(clamp(dot(-V, uSunDir), 0.0, 1.0), 6.0);
  vec3 sky = max(shIrr(vec3(0.0, 1.0, 0.0)), vec3(0.0));
  vec3 col = (uSunColor * (0.42 + 1.2 * fw) * (0.35 + 0.65 * max(uSunDir.y, 0.0)) + sky * 0.9) * 0.92 / 3.14159265;
  col = applyFog(col, vWorld);
  outColor = vec4(col * a, a);    // premultiplied
}
`;

export class Spray {
  constructor(engine) {
    this.engine = engine;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const cells = new Float32Array(GRID * GRID * 2);
    for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
      cells[(j * GRID + i) * 2] = i - GRID / 2;
      cells[(j * GRID + i) * 2 + 1] = j - GRID / 2;
    }
    g.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2));
    g.instanceCount = GRID * GRID;
    this.U = { uGrid: { value: new THREE.Vector3(0, 0, CELL) }, uCamRight: { value: new THREE.Vector3(1, 0, 0) }, uCamUp: { value: new THREE.Vector3(0, 1, 0) } };
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { ...engine.G, ...engine.water.U, ...this.U },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(4);
    this.mesh.renderOrder = 20; // after the water surface
    this.mesh.visible = false;
  }

  update(camera) {
    const w = this.engine.world;
    const on = !!(w && w.project.water.sea && w.project.water.sea.enabled && (w.project.water.swell?.height ?? 1) > 0.05 && !this.engine.cameraSubmerged);
    this.mesh.visible = on;
    if (!on) return;
    // grid centred ahead of the camera so most of it is in view
    const f = this._f || (this._f = new THREE.Vector3());
    f.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const l = Math.hypot(f.x, f.z) || 1;
    const reach = Math.min(GRID * CELL * 0.42, 8 + Math.max(0, camera.position.y) * 1.2 + 30);
    this.U.uGrid.value.set(camera.position.x + (f.x / l) * reach, camera.position.z + (f.z / l) * reach, CELL);
    this.U.uCamRight.value.set(1, 0, 0).applyQuaternion(camera.quaternion);
    this.U.uCamUp.value.set(0, 1, 0).applyQuaternion(camera.quaternion);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
