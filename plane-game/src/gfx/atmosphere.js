// Shared atmosphere model for every shader in the game: analytic sky colour and aerial
// perspective (exponential height fog whose colour is the sky colour in the view direction, so
// distant terrain melts into the horizon). Built-in three.js materials get it by overriding the
// fog shader chunks; custom shaders include ATMO_PARS and call the same functions.

import * as THREE from 'three';

export const atmoUniforms = {
  uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.5).normalize() },
  uZenith: { value: new THREE.Color(0.1, 0.25, 0.6) },
  uHorizon: { value: new THREE.Color(0.6, 0.72, 0.9) },
  uSunGlow: { value: new THREE.Color(1, 0.9, 0.7) },
  uSunDisc: { value: new THREE.Color(20, 18, 15) },
  uFogDensity: { value: 0.00006 },
  uFogHeight: { value: 1800 },
  uFogTint: { value: new THREE.Color(1, 1, 1) },
  uNight: { value: 0 },
  uTime: { value: 0 },
  uCloudShadowMap: { value: null },
  uCloudShadowParams: { value: new THREE.Vector4(0, 0, 1 / 80000, 0) }, // offset x, z, 1/tile, strength
};

export const ATMO_PARS = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunGlow;
uniform float uFogDensity;
uniform float uFogHeight;
uniform vec3 uFogTint;

vec3 skyColor(vec3 d) {
  float y = max(d.y, 0.0);
  float t = 1.0 - y;
  float t2 = t * t;
  float hz = t2 * t2 * t;                      // strong weighting toward the horizon
  vec3 c = mix(uZenith, uHorizon, hz + 0.18 * t2 * (1.0 - hz));
  float mu = max(dot(d, uSunDir), 0.0);
  float mu2 = mu * mu; float mu8 = mu2 * mu2; mu8 *= mu8;
  float glow = mu8 * 0.22 + mu8 * mu8 * mu8 * mu8 * 0.5;
  c += uSunGlow * glow * (0.3 + 0.7 * hz);
  return c;
}

// optical depth of an exponential atmosphere along the segment camera -> p, as transmittance loss
float fogFactor(vec3 cam, vec3 p) {
  vec3 rd = p - cam;
  float dist = length(rd);
  float b = 1.0 / uFogHeight;
  float k = rd.y * b;                          // (dy / H)
  float od = uFogDensity * exp(-max(cam.y, -200.0) * b) * dist;
  od *= abs(k) > 1e-4 ? (1.0 - exp(-k)) / k : 1.0;
  return 1.0 - exp(-od);
}

vec3 fogColor(vec3 cam, vec3 p) {
  vec3 d = normalize(p - cam);
  return skyColor(normalize(vec3(d.x, max(d.y, 0.0) * 0.4 + 0.02, d.z))) * uFogTint;
}

vec3 atmoOutput(vec3 c) {
  #ifdef TONE_MAPPING
    c = toneMapping(c);
  #endif
  return linearToOutputTexel(vec4(c, 1.0)).rgb;
}
`;

let installed = false;

/** Replace three.js' fog chunks. Must run before any material is compiled. */
export function installAtmosphere() {
  if (installed) return;
  installed = true;
  const C = THREE.ShaderChunk;
  C.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vAtmoWorld;
#endif`;
  C.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  {
    vec4 atmoWP = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      atmoWP = instanceMatrix * atmoWP;
    #endif
    vAtmoWorld = (modelMatrix * atmoWP).xyz;
  }
#endif`;
  C.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vAtmoWorld;
  ${ATMO_PARS}
#endif`;
  C.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  {
    float atmoF = fogFactor(cameraPosition, vAtmoWorld);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, atmoOutput(fogColor(cameraPosition, vAtmoWorld)), atmoF);
  }
#endif`;
}

/** Give a built-in material access to the atmosphere uniforms (chains existing hooks). */
export function withAtmosphere(material, extra, key) {
  const prev = material.onBeforeCompile;
  if (extra) material.customProgramCacheKey = () => key || extra.toString();
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(material, shader, renderer);
    for (const k in atmoUniforms) shader.uniforms[k] = atmoUniforms[k];
    if (extra) extra(shader);
  };
  material.fog = true;
  return material;
}

/** Patch every material in an object tree (aircraft models, scenery). */
export function applyAtmosphereToTree(root) {
  const seen = new Set();
  root.traverse((o) => {
    if (!o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (seen.has(m) || m.userData.atmo || m.isShaderMaterial || m.isSpriteMaterial || m.fog === false) continue;
      seen.add(m);
      m.userData.atmo = true;
      withAtmosphere(m);
      m.needsUpdate = true;
    }
  });
}
