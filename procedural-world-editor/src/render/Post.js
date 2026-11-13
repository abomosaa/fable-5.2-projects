// Post-processing: screen-space ambient occlusion + sun contact shadows (applied to the opaque
// scene before water is drawn), bloom, underwater attenuation / waterline, exposure, AgX tone map.

import * as THREE from 'three';
import { FullscreenPass } from './Atmosphere.js';
import { NOISE_GLSL, DEPTH_GLSL, TONEMAP_GLSL, GLOBALS_GLSL } from './shaders/common.glsl.js';
import { WATER_COMMON } from './WaterRenderer.js';

const VERT = /* glsl */ `
out vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const AO_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv; out vec4 outColor;
${NOISE_GLSL}
${DEPTH_GLSL}
uniform highp sampler2D uDepth;
uniform vec2 uTexel;       // 1 / full resolution
uniform vec3 uSunView;     // sun direction in view space
uniform float uFrame;
vec3 viewPos(vec2 uv){
  float d = textureLod(uDepth, uv, 0.0).r;
  float z = isSkyDepth(d) ? 1e5 : linearDepth(d);
  return vec3((uv * 2.0 - 1.0) * vec2(uProjInfo.z, uProjInfo.w) * z, -z);
}
void main(){
  vec3 p = viewPos(vUv);
  if (-p.z > 9e4) { outColor = vec4(1.0); return; }
  // normal from depth derivatives (choose the smaller difference on each axis to respect edges)
  vec3 px1 = viewPos(vUv + vec2(uTexel.x, 0.0)), px0 = viewPos(vUv - vec2(uTexel.x, 0.0));
  vec3 py1 = viewPos(vUv + vec2(0.0, uTexel.y)), py0 = viewPos(vUv - vec2(0.0, uTexel.y));
  vec3 dx = abs(px1.z - p.z) < abs(p.z - px0.z) ? px1 - p : p - px0;
  vec3 dy = abs(py1.z - p.z) < abs(p.z - py0.z) ? py1 - p : p - py0;
  vec3 n = normalize(cross(dx, dy));
  float dist = -p.z;
  // white noise, not an ordered pattern: interleaved-gradient noise is nearly constant down each
  // column, which survives the half-resolution blur as vertical stripes in shaded areas
  float rnd = fract(sin(dot(gl_FragCoord.xy, vec2(41.31, 289.17)) + uFrame * 0.37) * 43758.5453);
  // ---- horizon-style AO: 10 samples on a spiral, world radius grows slowly with distance ----
  float radius = clamp(0.5 + dist * 0.012, 0.5, 6.0);
  float rpx = radius / (dist * uProjInfo.w) * 0.5;      // radius in uv units (vertical)
  float ao = 0.0;
  const int NS = 10;
  for (int i = 0; i < NS; i++) {
    float fi = (float(i) + rnd) / float(NS);
    float ang = fi * 6.2831853 * 2.4 + rnd * 6.2831853;
    vec2 off = vec2(cos(ang), sin(ang)) * rpx * (0.15 + 0.85 * fi) * vec2(uProjInfo.w / uProjInfo.z, 1.0);
    vec3 s = viewPos(vUv + off);
    vec3 v = s - p;
    float vv = dot(v, v);
    float vn = dot(v, n);
    float f = max(vn - 0.02 * dist * 0.02 - 0.015, 0.0) / (vv + 1e-4);
    ao += f * radius * smoothstep(radius * radius * 1.6, radius * radius * 0.3, vv) * 1.0;
  }
  ao = clamp(1.0 - ao / float(NS) * 1.7, 0.0, 1.0);
  // far away a screen-space radius of a few metres is below the depth resolution: the baked
  // terrain horizon AO takes over
  ao = mix(ao, 1.0, smoothstep(70.0, 220.0, dist));
  // ---- contact shadow: short ray march towards the sun in screen space ----
  float contact = 1.0;
  if (uSunView.z < 0.98) {
    float len = clamp(0.08 + dist * 0.01, 0.08, 1.2);
    const int CS = 10;
    vec3 stepV = uSunView * (len / float(CS));
    vec3 q = p + n * (0.01 + dist * 0.0012);
    float occ = 0.0;
    // white (not ordered) jitter: an ordered pattern turns into column stripes at half resolution
    float rnd2 = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + uFrame * 0.1) * 43758.5453);
    for (int i = 1; i <= CS; i++) {
      vec3 s = q + stepV * (float(i) - 0.5 + rnd2 * 0.9);
      if (s.z > -0.05) break;
      vec2 suv = (s.xy / (-s.z)) / vec2(uProjInfo.z, uProjInfo.w) * 0.5 + 0.5;
      if (suv.x < 0.0 || suv.y < 0.0 || suv.x > 1.0 || suv.y > 1.0) break;
      float d = textureLod(uDepth, suv, 0.0).r;
      if (isSkyDepth(d)) continue;
      float sz = linearDepth(d);
      float delta = -s.z - sz;                           // > 0: ray is behind the depth buffer
      float thickness = 0.06 + dist * 0.01;
      if (delta > 0.004 + dist * 0.0006 && delta < thickness) occ = max(occ, 1.0 - float(i - 1) / float(CS));
    }
    // screen-space contact shadows only make sense near the camera: far away the depth buffer
    // cannot resolve a 1 m ray and the march turns into stripes at low sun
    contact = 1.0 - occ * 0.7 * (1.0 - smoothstep(25.0, 80.0, dist));
  }
  outColor = vec4(ao, contact, dist, 1.0);
}
`;

const AO_APPLY_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv; out vec4 outColor;
${DEPTH_GLSL}
uniform sampler2D uAO;
uniform sampler2D uSceneA;      // a = fraction of radiance due to direct sun
uniform highp sampler2D uDepth;
uniform vec2 uAOTexel;
uniform float uStrength;
void main(){
  float d = textureLod(uDepth, vUv, 0.0).r;
  if (isSkyDepth(d)) { outColor = vec4(1.0); return; }
  float z = linearDepth(d);
  // depth-aware 3x3 blur of the half-resolution AO / contact terms
  vec2 acc = vec2(0.0); float wsum = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec4 s = textureLod(uAO, vUv + vec2(float(i), float(j)) * uAOTexel * 1.5, 0.0);
    float w = exp(-abs(s.b - z) / (0.02 * z + 0.05));
    acc += s.rg * w; wsum += w;
  }
  vec2 a = wsum > 1e-4 ? acc / wsum : vec2(1.0);
  float sunFrac = texture(uSceneA, vUv).a;
  float ao = mix(1.0, a.x, uStrength * (1.0 - 0.75 * sunFrac));
  float contact = 1.0 - sunFrac * (1.0 - a.y) * uStrength;
  outColor = vec4(vec3(ao * contact), 1.0);
}
`;

const DOWN_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform sampler2D uTex; uniform vec2 uTexel; uniform float uFirst;
vec3 soft(vec3 c){ return c / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722)) * 0.25); }
void main(){
  // 13-tap downsample (Jimenez 2014)
  vec3 a = texture(uTex, vUv + uTexel * vec2(-2.0, -2.0)).rgb, b = texture(uTex, vUv + uTexel * vec2(0.0, -2.0)).rgb, c = texture(uTex, vUv + uTexel * vec2(2.0, -2.0)).rgb;
  vec3 d = texture(uTex, vUv + uTexel * vec2(-2.0, 0.0)).rgb, e = texture(uTex, vUv).rgb, f = texture(uTex, vUv + uTexel * vec2(2.0, 0.0)).rgb;
  vec3 g = texture(uTex, vUv + uTexel * vec2(-2.0, 2.0)).rgb, h = texture(uTex, vUv + uTexel * vec2(0.0, 2.0)).rgb, i = texture(uTex, vUv + uTexel * vec2(2.0, 2.0)).rgb;
  vec3 j = texture(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb, k = texture(uTex, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  vec3 l = texture(uTex, vUv + uTexel * vec2(-1.0, 1.0)).rgb, m = texture(uTex, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  vec3 col;
  if (uFirst > 0.5) {
    // Karis average on the first level suppresses fireflies from tiny glints
    col = soft(e) * 0.125 + (soft(a) + soft(c) + soft(g) + soft(i)) * 0.03125 + (soft(b) + soft(d) + soft(f) + soft(h)) * 0.0625 + (soft(j) + soft(k) + soft(l) + soft(m)) * 0.125;
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  outColor = vec4(max(col, 0.0), 1.0);
}
`;

const UP_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform sampler2D uTex; uniform sampler2D uBase; uniform vec2 uTexel; uniform float uMix;
void main(){
  vec3 s = texture(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(uTex, vUv + uTexel * vec2(1.0, -1.0)).rgb + texture(uTex, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(uTex, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  s += 2.0 * (texture(uTex, vUv + uTexel * vec2(0.0, -1.0)).rgb + texture(uTex, vUv + uTexel * vec2(0.0, 1.0)).rgb + texture(uTex, vUv + uTexel * vec2(-1.0, 0.0)).rgb + texture(uTex, vUv + uTexel * vec2(1.0, 0.0)).rgb);
  s += 4.0 * texture(uTex, vUv).rgb;
  outColor = vec4(mix(texture(uBase, vUv).rgb, s / 16.0, uMix), 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv; out vec4 outColor;
${NOISE_GLSL}
${DEPTH_GLSL}
${TONEMAP_GLSL}
${GLOBALS_GLSL}
${WATER_COMMON}
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform highp sampler2D uDepth;
uniform float uExposure;
uniform float uBloomAmt;
uniform mat4 uInvViewProj;
uniform vec4 uWaterLine;     // x = water level at the camera, y = enabled, z = time, w = camera near
uniform vec3 uUnderAbsorb;   // extinction (1/m)
uniform vec3 uUnderColor;    // in-scattered radiance of the water body
uniform vec3 uCamRight; uniform vec3 uCamUp; uniform vec3 uCamFwd;
uniform vec3 uSunCol;
uniform float uDebug;
uniform vec2 uCausticInfo;   // x = strength, y = tile size (m)
void main(){
  vec2 uv = vUv;
  // world position of this pixel on the near plane -> is the lens under water here?
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 ray = normalize(uCamFwd + uCamRight * ndc.x * uProjInfo.z + uCamUp * ndc.y * uProjInfo.w);
  vec3 nearP = uCamPos + ray * (uWaterLine.w / max(dot(ray, uCamFwd), 0.05));
  float sub = 0.0;
  float line = 0.0;
  float lensLevel = uWaterLine.x;
  if (uWaterLine.y > 0.5) {
    // small capillary wobble along the lens waterline
    // the water climbs and slides on the lens: a slow slosh plus small capillary wobble
    float along = nearP.x * 0.8 + nearP.z * 0.6;
    float wob = (vnoise(vec2(along * 30.0, uWaterLine.z * 1.3)) - 0.5) * 0.006 + sin(along * 9.0 + uWaterLine.z * 2.3) * 0.0035 + sin(along * 3.1 - uWaterLine.z * 1.4) * 0.004;
    // the water level on the lens is the rendered surface itself (waves, flow relief, ripples), so
    // the split follows the waves and always agrees with the surface mesh
    bool wv;
    lensLevel = waterSurfaceNear(nearP.xz, 0.22, wv);
    if (!wv) lensLevel = uWaterLine.x;
    // (+4 mm: the mesh that draws the surface is piecewise linear between vertices 0.22 m apart,
    // so it can differ from this evaluation by a few millimetres; the film climbing the glass
    // covers that band)
    float dy = nearP.y - (lensLevel + 0.004 + wob * 0.5);
    sub = smoothstep(0.0012, -0.0012, dy);
    line = exp(-abs(dy) / 0.0042);
    // refraction across the meniscus bends the image slightly
    uv += vec2(0.0, line * 0.03 * sign(dy));
    if (sub > 0.5) uv += vec2(sin(vUv.y * 38.0 + uWaterLine.z * 1.7), cos(vUv.x * 31.0 + uWaterLine.z * 1.3)) * 0.0012;
  }
  vec3 col = texture(uScene, uv).rgb;
  if (sub > 0.001) {
    float d = texture(uDepth, uv).r;
    float z = isSkyDepth(d) ? 400.0 : linearDepth(d);
    float dist = z / max(dot(ray, uCamFwd), 0.05);
    // if the ray leaves the water (reaches the surface) the water pass already shaded that pixel; only the wet path counts
    float tSurf = ray.y > 1e-3 ? max(lensLevel - nearP.y, 0.0) / ray.y + uWaterLine.w : 1e6;
    float path = min(dist, max(tSurf, 0.0));
    vec3 T = exp(-uUnderAbsorb * path);
    // in-scattered light: brighter towards the refracted sun and upwards (downwelling light),
    // darker looking down into deep water
    float fw = pow(clamp(dot(ray, uSunDir) * 0.5 + 0.5, 0.0, 1.0), 6.0);
    vec3 ins = uUnderColor * (1.0 + 1.8 * fw) * mix(0.6, 1.3, smoothstep(-0.6, 0.5, ray.y));
    // light shafts: the wave-focused sunlight (same caustic field that lights the bed) seen in the
    // volume, integrated along the view ray
    if (uCausticInfo.x > 0.0 && uSunDir.y > 0.06) {
      vec3 L = refract(-uSunDir, vec3(0.0, 1.0, 0.0), 0.75);
      float tMax = min(path, 12.0);
      float jit = ign(gl_FragCoord.xy);
      float acc = 0.0, wsum = 0.0;
      for (int i = 0; i < 14; i++) {
        float t = tMax * (float(i) + 0.5 + (jit - 0.5) * 0.6) / 14.0;
        vec3 p = uCamPos + ray * t;
        float dz = max(lensLevel - p.y, 0.0);
        vec2 sp = p.xz - L.xz / max(-L.y, 0.2) * dz;
        float c = textureLod(uCaustics, sp / uCausticInfo.y, 2.2 + dz * 0.6).r;
        float wgt = exp(-t * 0.3) * exp(-dz * 0.35);
        acc += c * wgt; wsum += wgt;
      }
      float shaft = acc / max(wsum, 1e-3);
      ins *= mix(1.0, 0.45 + 0.6 * shaft, clamp(uCausticInfo.x, 0.0, 1.0) * smoothstep(0.06, 0.3, uSunDir.y));
    }
    vec3 under = col * T + ins * (1.0 - T);
    // suspended particles drifting past the lens (plankton, silt, small bubbles): sparse specks in
    // a few depth shells, anchored in the water, brighter towards the light
    float specks = 0.0;
    for (int i = 0; i < 4; i++) {
      float sd_ = 0.22 + 0.3 * float(i);
      if (sd_ > path) break;
      vec3 sp3 = (uCamPos + ray * sd_) / 0.045 + vec3(0.0, uWaterLine.z * 0.35, uWaterLine.z * 0.12);
      vec3 ci = floor(sp3);
      float hsh = fract(sin(dot(ci, vec3(127.1, 311.7, 74.7))) * 43758.5453);
      vec3 off3 = fract(sp3) - 0.5 - (vec3(fract(hsh * 7.1), fract(hsh * 13.3), fract(hsh * 29.7)) - 0.5) * 0.6;
      specks += step(0.965, hsh) * smoothstep(0.16, 0.02, length(off3)) * (1.0 - float(i) * 0.2);
    }
    under += ins * specks * (0.6 + 2.0 * uCausticInfo.x * 0.0 + 1.4 * fw) * 1.6;
    col = mix(col, under, sub);
  }
  // meniscus: seen through the lens the waterline is a thin dark band (total reflection at the
  // curved film) with a bright edge on the air side
  float core = exp(-abs(line > 0.0 ? (1.0 - line) : 1.0) * 4.0) * step(0.001, line);
  col *= 1.0 - 0.72 * core;
  // the film above the line is a strong lens: it gathers sky light into a bright rim
  float rim = line * (1.0 - core) * step(0.0, nearP.y - lensLevel);
  col += vec3(0.85, 0.93, 1.0) * rim * 0.22 * (dot(uUnderColor, vec3(1.0)) + 0.05 * dot(uSunCol, vec3(0.3)));
  vec3 bloom = texture(uBloom, vUv).rgb;
  col = mix(col, bloom, uBloomAmt);
  col *= uExposure;
  if (uDebug > 0.5) { outColor = vec4(col, 1.0); return; }
  vec3 t = agx(col);
  t = agxLook(t, 1.06, 1.04);
  t = agxEotf(t);
  t = clamp(t, 0.0, 1.0);
  // the AgX fit above is already in display (gamma ~2.2) space
  t += (hash12(gl_FragCoord.xy + fract(uWaterLine.z) * 61.0) - 0.5) / 255.0;
  outColor = vec4(t, 1.0);
}
`;

export class Post {
  constructor(engine) {
    this.engine = engine;
    const G = engine.G;
    this.aoRT = null;
    this.aoMat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: AO_FRAG, uniforms: { uDepth: { value: null }, uTexel: { value: new THREE.Vector2() }, uSunView: { value: new THREE.Vector3() }, uFrame: { value: 0 }, uProjInfo: G.uProjInfo }, depthTest: false, depthWrite: false });
    this.aoApplyMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: AO_APPLY_FRAG,
      uniforms: { uAO: { value: null }, uSceneA: { value: null }, uDepth: { value: null }, uAOTexel: { value: new THREE.Vector2() }, uStrength: { value: 1 }, uProjInfo: G.uProjInfo },
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      transparent: true,
    });
    this.downMat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: DOWN_FRAG, uniforms: { uTex: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 } }, depthTest: false, depthWrite: false });
    this.upMat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: UP_FRAG, uniforms: { uTex: { value: null }, uBase: { value: null }, uTexel: { value: new THREE.Vector2() }, uMix: { value: 0.5 } }, depthTest: false, depthWrite: false });
    this.compMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        // globals and the water-field uniforms first (for the lens waterline); the pass's own
        // uniforms below take precedence where names coincide
        ...G,
        ...engine.water.U,
        uScene: { value: null },
        uBloom: { value: null },
        uDepth: { value: null },
        uExposure: { value: 1 },
        uBloomAmt: { value: 0.035 },
        uInvViewProj: { value: new THREE.Matrix4() },
        uWaterLine: { value: new THREE.Vector4(0, 0, 0, 0.1) },
        uUnderAbsorb: { value: new THREE.Vector3(0.4, 0.1, 0.08) },
        uUnderColor: { value: new THREE.Vector3(0.02, 0.08, 0.08) },
        uCamRight: { value: new THREE.Vector3() },
        uCamUp: { value: new THREE.Vector3() },
        uCamFwd: { value: new THREE.Vector3() },
        uSunCol: { value: G.uSunColor.value },
        uProjInfo: G.uProjInfo,
        uDebug: { value: 0 },
        uCausticInfo: { value: new THREE.Vector2(0, 11) },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.pass = new FullscreenPass(this.aoMat);
    this.bloomRTs = [];
    this.frame = 0;
    this.aoStrength = 1;
  }

  _ensure(w, h) {
    const hw = Math.max(8, w >> 1),
      hh = Math.max(8, h >> 1);
    if (!this.aoRT || this.aoRT.width !== hw || this.aoRT.height !== hh) {
      if (this.aoRT) this.aoRT.dispose();
      this.aoRT = new THREE.WebGLRenderTarget(hw, hh, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
      for (const rt of this.bloomRTs) {
        rt.down.dispose();
        rt.up.dispose();
      }
      this.bloomRTs = [];
      let bw = hw,
        bh = hh;
      for (let i = 0; i < 6 && bw > 8 && bh > 8; i++) {
        const mk = () => new THREE.WebGLRenderTarget(bw, bh, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
        this.bloomRTs.push({ down: mk(), up: mk(), w: bw, h: bh });
        bw >>= 1;
        bh >>= 1;
      }
    }
  }

  /** Compute AO + contact shadows from the opaque depth and multiply them into the scene target. */
  applyAO(sceneRT, camera, sunDir) {
    const r = this.engine.renderer;
    this._ensure(sceneRT.width, sceneRT.height);
    this.frame++;
    const u = this.aoMat.uniforms;
    u.uDepth.value = sceneRT.depthTexture;
    u.uTexel.value.set(1 / sceneRT.width, 1 / sceneRT.height);
    u.uSunView.value.copy(sunDir).transformDirection(camera.matrixWorldInverse);
    u.uFrame.value = this.frame;
    this.pass.material = this.aoMat;
    this.pass.render(r, this.aoRT);
    const a = this.aoApplyMat.uniforms;
    a.uAO.value = this.aoRT.texture;
    a.uSceneA.value = sceneRT.texture;
    a.uDepth.value = sceneRT.depthTexture;
    a.uAOTexel.value.set(1 / this.aoRT.width, 1 / this.aoRT.height);
    a.uStrength.value = this.aoStrength;
    this.pass.material = this.aoApplyMat;
    this.pass.render(r, sceneRT);
  }

  /** Bloom + composite to the screen (or `target`). */
  finish(sceneRT, camera, target, params) {
    const r = this.engine.renderer;
    this._ensure(sceneRT.width, sceneRT.height);
    // bloom pyramid
    let src = sceneRT.texture;
    let sw = sceneRT.width,
      sh = sceneRT.height;
    this.pass.material = this.downMat;
    for (let i = 0; i < this.bloomRTs.length; i++) {
      const b = this.bloomRTs[i];
      this.downMat.uniforms.uTex.value = src;
      this.downMat.uniforms.uTexel.value.set(1 / sw, 1 / sh);
      this.downMat.uniforms.uFirst.value = i === 0 ? 1 : 0;
      this.pass.render(r, b.down);
      src = b.down.texture;
      sw = b.w;
      sh = b.h;
    }
    this.pass.material = this.upMat;
    let up = this.bloomRTs[this.bloomRTs.length - 1].down.texture;
    for (let i = this.bloomRTs.length - 2; i >= 0; i--) {
      const b = this.bloomRTs[i];
      const below = this.bloomRTs[i + 1];
      this.upMat.uniforms.uTex.value = up;
      this.upMat.uniforms.uBase.value = b.down.texture;
      this.upMat.uniforms.uTexel.value.set(1 / below.w, 1 / below.h);
      this.upMat.uniforms.uMix.value = 0.55;
      this.pass.render(r, b.up);
      up = b.up.texture;
    }
    const c = this.compMat.uniforms;
    c.uScene.value = sceneRT.texture;
    c.uBloom.value = up;
    c.uDepth.value = sceneRT.depthTexture;
    c.uExposure.value = params.exposure;
    c.uBloomAmt.value = params.bloom ?? 0.035;
    c.uCamRight.value.set(1, 0, 0).applyQuaternion(camera.quaternion);
    c.uCamUp.value.set(0, 1, 0).applyQuaternion(camera.quaternion);
    c.uCamFwd.value.set(0, 0, -1).applyQuaternion(camera.quaternion);
    c.uWaterLine.value.set(params.waterLevel ?? -1e5, params.waterLineEnabled ? 1 : 0, params.time, camera.near);
    if (params.underAbsorb) c.uUnderAbsorb.value.copy(params.underAbsorb);
    if (params.underColor) c.uUnderColor.value.copy(params.underColor);
    c.uDebug.value = params.linearOutput ? 1 : 0;
    c.uCausticInfo.value.set(this.engine.G.uCausticParams.value.x, this.engine.G.uCausticParams.value.y);
    this.pass.material = this.compMat;
    this.pass.render(r, target || null);
  }

  dispose() {
    if (this.aoRT) this.aoRT.dispose();
    for (const rt of this.bloomRTs) {
      rt.down.dispose();
      rt.up.dispose();
    }
  }
}
