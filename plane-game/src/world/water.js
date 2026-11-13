// The sea: one large plane at y = 0 with animated wave normals, Fresnel sky reflection,
// sun glitter, depth-dependent colour near the shore and the shared aerial perspective.

import * as THREE from 'three';
import { ATMO_PARS, atmoUniforms } from '../gfx/atmosphere.js';
import { WORLD_HALF } from './heightfield.js';

function makeWaveNormals() {
  // tileable height field from summed periodic sinusoid "gerstner-ish" bumps + noise -> normal map
  const S = 256;
  const h = new Float32Array(S * S);
  let seed = 9871;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return (seed >>> 8) / 16777216; };
  for (let k = 0; k < 46; k++) {
    const fx = Math.round((rnd() * 2 - 1) * (2 + k * 0.45)), fy = Math.round((rnd() * 2 - 1) * (2 + k * 0.45));
    if (fx === 0 && fy === 0) continue;
    const f = Math.hypot(fx, fy), amp = 1 / Math.pow(f, 1.25), ph = rnd() * 6.283;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const a = (fx * x + fy * y) * 6.283185 / S + ph;
      // sharpen crests
      const s = Math.sin(a);
      h[y * S + x] += amp * (1 - Math.abs(s)) * 0.6 + amp * s * 0.4;
    }
  }
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const hx = h[y * S + ((x + 1) % S)] - h[y * S + ((x + S - 1) % S)];
    const hy = h[((y + 1) % S) * S + x] - h[((y + S - 1) % S) * S + x];
    const i = (y * S + x) * 4;
    data[i] = Math.max(0, Math.min(255, 128 + hx * 150));
    data[i + 1] = Math.max(0, Math.min(255, 128 + hy * 150));
    data[i + 2] = 255; data[i + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true; tex.anisotropy = 8; tex.needsUpdate = true;
  return tex;
}

export class Water {
  constructor(scene) {
    this.uniforms = {
      ...atmoUniforms,
      uWaves: { value: makeWaveNormals() },
      uHeightMap: { value: null },
      uWorldHalf: { value: WORLD_HALF },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uSkyLight: { value: new THREE.Color(0.5, 0.6, 0.8) },
      uWind: { value: new THREE.Vector2(1, 0) },
      uRough: { value: 1 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
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
        uniform sampler2D uWaves; uniform sampler2D uHeightMap; uniform float uWorldHalf;
        uniform vec3 uSunColor; uniform vec3 uSkyLight; uniform vec3 uSunDisc;
        uniform float uTime; uniform vec2 uWind; uniform float uRough;
        varying vec3 vWorld;
        vec2 wave(vec2 uv, float scale, vec2 vel) {
          return texture2D(uWaves, uv / scale + vel * uTime / scale).xy - 0.5;
        }
        void main() {
          #include <logdepthbuf_fragment>
          vec3 toCam = cameraPosition - vWorld;
          float dist = length(toCam);
          vec3 V = toCam / dist;
          vec2 p = vWorld.xz;
          vec2 w = uWind;
          vec2 wp = vec2(-w.y, w.x);
          // three octaves of waves travelling roughly downwind
          vec2 g = wave(p, 9.0, w * 1.1 + wp * 0.3) * 0.55 * (1.0 - smoothstep(80.0, 700.0, dist));
          g += wave(p, 47.0, w * 2.3 - wp * 0.5) * 0.9 * (1.0 - smoothstep(500.0, 5000.0, dist));
          g += wave(p, 331.0, w * 4.5 + wp * 0.4) * 1.1 * (1.0 - smoothstep(4000.0, 40000.0, dist));
          g += wave(p, 2900.0, w * 6.0) * 0.5;
          g *= uRough;
          vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
          float ndv = max(dot(N, V), 0.0);
          float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
          // at grazing angles the micro-facets average out: limit the mirror-like horizon
          fres = min(fres, 0.72);
          vec3 R = reflect(-V, N);
          R.y = abs(R.y) + 0.02;
          vec3 refl = skyColor(normalize(R));
          // sun glitter: a tight core plus a wide rough lobe
          float rs = max(dot(normalize(R), uSunDir), 0.0);
          float spec = pow(rs, 900.0) * 1.0 + pow(rs, 90.0) * 0.045;
          // water body colour from depth
          vec2 huv = vec2(vWorld.z, vWorld.x) / (2.0 * uWorldHalf) + 0.5;
          float depth = -texture2D(uHeightMap, huv).r;
          float inside = step(abs(huv.x - 0.5), 0.5) * step(abs(huv.y - 0.5), 0.5);
          depth = mix(300.0, depth, inside);
          float sh = 1.0 - smoothstep(0.0, 28.0, depth);
          vec3 deep = vec3(0.006, 0.035, 0.075);
          vec3 shallow = vec3(0.02, 0.2, 0.2);
          vec3 light = uSkyLight * 0.55 + uSunColor * max(uSunDir.y, 0.0) * 0.5;
          vec3 body = mix(deep, shallow, sh * sh) * light;
          vec3 col = mix(body, refl, fres) + uSunDisc * spec * 0.05;
          float alpha = mix(1.0, 0.55, smoothstep(6.0, 0.0, depth) * inside);
          col = atmoOutput(col);
          float f = fogFactor(cameraPosition, vWorld);
          col = mix(col, atmoOutput(fogColor(cameraPosition, vWorld)), f);
          gl_FragColor = vec4(col, max(alpha, f));
        }`,
      transparent: true, depthWrite: true,
    });
    const geo = new THREE.PlaneGeometry(1, 1, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.scale.set(900000, 1, 900000);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
    scene.add(this.mesh);
  }

  /** Overview height data (Float32Array size*size, row = x index) -> texture for depth tinting. */
  setHeightMap(data, size) {
    const half = new Uint16Array(size * size);
    for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(Math.max(-500, Math.min(500, data[i])));
    const tex = new THREE.DataTexture(half, size, size, THREE.RedFormat, THREE.HalfFloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this.uniforms.uHeightMap.value = tex;
  }

  update(camera, sky, wind) {
    // keep the plane centred under the camera
    this.mesh.position.set(camera.position.x, 0, camera.position.z);
    this.uniforms.uSunColor.value.copy(sky.sun.color).multiplyScalar(sky.sun.intensity * 0.3);
    this.uniforms.uSkyLight.value.copy(sky.hemi.color).multiplyScalar(sky.hemi.intensity);
    if (wind) {
      const sp = Math.min(1.6, 0.35 + wind.speed / 12);
      // waves travel downwind (wind.dirFrom is where it comes from)
      this.uniforms.uWind.value.set(-Math.cos(wind.dirFrom) * sp, -Math.sin(wind.dirFrom) * sp);
      this.uniforms.uRough.value = 0.55 + Math.min(1.2, wind.speed / 10);
    }
  }
}
