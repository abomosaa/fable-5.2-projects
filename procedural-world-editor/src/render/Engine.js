// Render engine: owns the WebGL renderer, shared uniforms, render targets and the frame graph.
//   shadows -> planar reflection -> opaque (MSAA HDR) -> AO/contact -> water -> overlays -> post

import * as THREE from 'three';
import { Atmosphere } from './Atmosphere.js';
import { Shadows } from './Shadows.js';
import { TerrainRenderer } from './TerrainRenderer.js';
import { WaterSim } from './WaterSim.js';
import { WaterRenderer } from './WaterRenderer.js';
import { Spray } from './Spray.js';
import { ModelLibrary } from './Models.js';
import { Vegetation } from './Vegetation.js';
import { SceneObjects } from './SceneObjects.js';
import { Post } from './Post.js';
import { NO_WATER } from '../core/waterField.js';
import { waveNumber } from '../core/waterField.js';

export const QUALITY_PRESETS = {
  low: { label: 'Low', renderScale: 0.75, msaa: 0, shadowSize: 1024, terrainGrid: 192, waterGrid: 160, terrainTexSize: 512, modelTexSize: 512, reflectionScale: 0.35, cloudScale: 0.35, treeLod: [18, 50, 120], detailDensity: 0.5, anisotropy: 4, rippleSize: 256, ao: false },
  medium: { label: 'Medium', renderScale: 1, msaa: 2, shadowSize: 1536, terrainGrid: 224, waterGrid: 192, terrainTexSize: 1024, modelTexSize: 1024, reflectionScale: 0.5, cloudScale: 0.4, treeLod: [24, 65, 150], detailDensity: 0.75, anisotropy: 8, rippleSize: 512, ao: true },
  high: { label: 'High', renderScale: 1, msaa: 4, shadowSize: 2048, terrainGrid: 256, waterGrid: 224, terrainTexSize: 1024, modelTexSize: 1024, reflectionScale: 0.5, cloudScale: 0.5, treeLod: [26, 62, 125], detailDensity: 1, anisotropy: 8, rippleSize: 512, ao: true },
  ultra: { label: 'Ultra', renderScale: 1, msaa: 4, shadowSize: 3072, terrainGrid: 320, waterGrid: 256, terrainTexSize: 2048, modelTexSize: 2048, reflectionScale: 0.75, cloudScale: 0.6, treeLod: [36, 90, 190], detailDensity: 1.2, anisotropy: 16, rippleSize: 512, ao: true },
};

export class Engine {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.qualityName = opts.quality || 'high';
    this.quality = { ...QUALITY_PRESETS[this.qualityName] };
    this.onError = opts.onError || ((m) => console.error(m));
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance', reversedDepthBuffer: true, preserveDrawingBuffer: !!opts.preserveDrawingBuffer });
    this.renderer = renderer;
    renderer.setPixelRatio(1);
    renderer.autoClear = false;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // the composite pass writes display-encoded values itself
    renderer.info.autoReset = false;
    renderer.debug.checkShaderErrors = true;
    renderer.debug.onShaderError = (gl, program, vs, fs) => {
      const vlog = gl.getShaderInfoLog(vs),
        flog = gl.getShaderInfoLog(fs),
        plog = gl.getProgramInfoLog(program);
      this.shaderErrors = (this.shaderErrors || 0) + 1;
      console.error('SHADER ERROR\n' + plog + '\nVS: ' + vlog + '\nFS: ' + flog);
      this.onError('A shader failed to compile on this GPU/driver: ' + (flog || vlog || plog).slice(0, 300));
    };
    const gl = renderer.getContext();
    this.gl = gl;
    this.reversed = renderer.capabilities.reversedDepthBuffer === true;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpuName = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
    if (!gl.getExtension('EXT_color_buffer_float') || !gl.getExtension('OES_texture_float_linear')) {
      throw new Error('This GPU/browser lacks float render targets (EXT_color_buffer_float / OES_texture_float_linear), which the water simulation requires.');
    }

    // ---- shared uniforms ----
    const sh = [];
    for (let i = 0; i < 9; i++) sh.push(new THREE.Vector3(0.2, 0.2, 0.2));
    const sm = [];
    for (let i = 0; i < 4; i++) sm.push(new THREE.Matrix4());
    const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    black.needsUpdate = true;
    const noWater = new THREE.DataTexture(new Float32Array([NO_WATER, 0, 0, -64]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    noWater.needsUpdate = true;
    const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    white.needsUpdate = true;
    const blackCube = new THREE.CubeTexture();
    this.G = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Vector3(1, 1, 1) },
      uSH: { value: sh },
      uEnvMap: { value: blackCube },
      uEnvMaxMip: { value: 5 },
      uCamPos: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uClipY: { value: -1e9 },
      uWorldRect: { value: new THREE.Vector4(1024, 1 / 2048, 1 / 2049, 1) },
      uSkyLUT: { value: black },
      uBetaR: { value: new THREE.Vector3(5.8e-6, 13.5e-6, 33.1e-6) },
      uHaze: { value: new THREE.Vector4(1e-5, 1200, 0, 100) },
      uDatum: { value: 0 },
      uCloudShadow: { value: new THREE.Vector4(0, 2000, 0, 1 / 2600) },
      uCloudOffset: { value: new THREE.Vector2() },
      uWaterA: { value: noWater },
      uSea: { value: new THREE.Vector4(0, -1e5, 0, 0) },
      uWaterAbsorb: { value: new THREE.Vector3(0.4, 0.07, 0.04) },
      uWaterScatter: { value: new THREE.Vector3(0.01, 0.03, 0.03) },
      uCaustics: { value: white },
      uCausticParams: { value: new THREE.Vector4(1, 10, 0, 0.1) },
      uWetness: { value: 0 },
      uShadowMap: { value: null },
      uShadowMat: { value: sm },
      uShadowSplits: { value: new THREE.Vector4(20, 80, 320, 1600) },
      uShadowTexel: { value: new THREE.Vector4(1 / 4096, 0.02, 0, 0) },
      uShadowTexW: { value: [0.02, 0.09, 0.35, 1.7] },
      uProjInfo: { value: new THREE.Vector4() },
    };
    this._noWater = noWater;

    this.scene = new THREE.Scene();
    this.overlayScene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.2, 90000);
    if (this.reversed) this.camera._reversedDepth = true;
    this.camera.position.set(0, 200, 300);
    this.atmosphere = new Atmosphere(renderer, this.G);
    this.G.uSkyLUT.value = this.atmosphere.skyRT.texture;
    this.shadows = new Shadows(this);
    this.waterSim = new WaterSim(this);
    this.terrain = new TerrainRenderer(this);
    this.water = new WaterRenderer(this);
    this.post = new Post(this);
    this.scene.add(this.terrain.group);
    this.scene.add(this.water.group);
    this.spray = new Spray(this);
    this.water.group.add(this.spray.mesh);
    this.scene.add(this.atmosphere.skyMesh);
    this.sceneRT = null;
    this.time = 0;
    this.simTime = 0;
    this.frame = 0;
    this.paused = false;
    this.world = null;
    this.frameTimes = new Float32Array(240);
    this.frameIdx = 0;
    this.stats = { fps: 0, ms: 0, calls: 0, triangles: 0 };
    this.casters = [];
    this.exposureEV = 0;
    this.baseExposure = 0.225;
    this.cameraSubmerged = false;
    this.waterLevelAtCamera = NO_WATER;
    this._lastReadback = 0;
  }

  reportError(msg) {
    this.onError(msg);
  }

  async initAssets(manifest, baseUrl) {
    this.manifest = manifest;
    this.assetBase = baseUrl;
    this.library = new ModelLibrary(this, manifest, baseUrl);
    this.vegetation = new Vegetation(this, this.library);
    this.objects = new SceneObjects(this, this.library, manifest, baseUrl);
    this.scene.add(this.vegetation.group);
    this.scene.add(this.objects.group);
  }

  /** Bind a world; loads materials and models, uploads all derived data. */
  async setWorld(world, onProgress) {
    const p = (l, f) => onProgress && onProgress(l, f);
    const T = (this.loadTimings = {});
    let tPrev = performance.now();
    const mark = (k) => {
      const n = performance.now();
      T[k] = Math.round(n - tPrev);
      tPrev = n;
    };
    this.world = world;
    if (this._unsub) this._unsub();
    await this.terrain.setMaterials(world.project.materials.layers, this.manifest, this.assetBase, (l, f) => p(l, 0.05 + f * 0.25));
    mark('materials');
    p('Uploading terrain', 0.32);
    this.terrain.setWorld(world);
    mark('terrain');
    this.water.setWorld(world);
    mark('water');
    p('Loading vegetation and rock models', 0.4);
    await this.vegetation.setWorld(world, (l, f) => p(l, 0.4 + f * 0.5));
    mark('vegetation');
    p('Placing structures and objects', 0.92);
    this.objects.clear();
    await this.objects.sync(world);
    this.applyEnvironment();
    this._unsub = world.on((type, rect) => this.onWorldChange(type, rect));
    mark('objects');
    this.atmosphere.resetTemporal();
    this.shadows.forceUpdate();
    p('Ready', 1);
  }

  onWorldChange(type, rect) {
    if (!this.world) return;
    if (type === 'height') {
      this.terrain.updateHeights(rect || this.world.fullRect());
      this.shadows.forceUpdate();
    } else if (type === 'ground') this.terrain.updateGround(rect || this.world.fullRect());
    else if (type === 'water') {
      this.water.upload();
      // the height LOD pyramid depends on where water is
      this.terrain.updateHeights(this.world.fullRect());
    } else if (type === 'scatter') this.vegetation.invalidate();
  }

  applyEnvironment() {
    const w = this.world;
    if (!w) return;
    const env = w.project.env;
    this.atmosphere.setEnvironment(env, w.project.terrain.baseAltitude || 0);
    this.exposureEV = env.exposure || 0;
    this.water.setParams(w.project);
    this.shadows.forceUpdate();
  }

  setQuality(name) {
    this.qualityName = name;
    Object.assign(this.quality, QUALITY_PRESETS[name]);
    this.vegetation.treeLod = this.quality.treeLod;
    this.vegetation.detailScale = this.quality.detailDensity;
    this.atmosphere.cloudQuality = this.quality.cloudScale;
    if (this.sceneRT) {
      this.sceneRT.dispose();
      this.sceneRT = null;
    }
  }

  resize(w, h) {
    this.viewW = w;
    this.viewH = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _ensureTargets() {
    const w = Math.max(16, Math.round(this.viewW * this.quality.renderScale)),
      h = Math.max(16, Math.round(this.viewH * this.quality.renderScale));
    if (!this.sceneRT || this.sceneRT.width !== w || this.sceneRT.height !== h || this.sceneRT.samples !== this.quality.msaa) {
      if (this.sceneRT) this.sceneRT.dispose();
      this.sceneRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true, samples: this.quality.msaa, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
      this.sceneRT.depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
      this.sceneRT.depthTexture.format = THREE.DepthFormat;
      this.sceneRT.depthTexture.minFilter = THREE.NearestFilter;
      this.sceneRT.depthTexture.magFilter = THREE.NearestFilter;
      this.atmosphere.resetTemporal();
    }
  }

  /** Render sky + opaque geometry with the given camera into a target (used for reflection). */
  renderScenePass(camera, target, opts = {}) {
    const r = this.renderer;
    const G = this.G;
    const prevCam = G.uCamPos.value.clone();
    G.uCamPos.value.copy(camera.position);
    const pe = camera.projectionMatrix.elements;
    const prevProj = G.uProjInfo.value.clone();
    G.uProjInfo.value.set(pe[10], pe[14], Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect, Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    const prevMain = this.atmosphere._mainPass;
    this.atmosphere._mainPass = !opts.reflection;
    camera.layers.set(0);
    if (opts.reflection) camera.layers.enable(6);
    else {
      camera.layers.enable(3);
      camera.layers.enable(7);
    }
    r.setRenderTarget(target);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    r.render(this.scene, camera);
    this.atmosphere._mainPass = prevMain;
    G.uCamPos.value.copy(prevCam);
    G.uProjInfo.value.copy(prevProj);
  }

  /** CPU evaluation of the refracted swell height (matches the shader closely enough for buoyancy). */
  swellHeightCPU(x, z, depth, shore) {
    const w = this.world;
    const wdoc = w.project.water;
    if (!wdoc.sea || !wdoc.sea.enabled) return 0;
    const sw = wdoc.swell || {};
    const H0 = (sw.height ?? 1) * (wdoc.waveScale ?? 1);
    if (H0 <= 0.01) return 0;
    const wf = w.water;
    const sres = wf.sres;
    const gx = Math.max(0, Math.min(sres - 1.001, ((x + w.size / 2) / w.size) * (sres - 1))),
      gz = Math.max(0, Math.min(sres - 1.001, ((z + w.size / 2) / w.size) * (sres - 1)));
    const i = gx | 0,
      j = gz | 0;
    const fx = gx - i,
      fz = gz - j;
    const o = j * sres + i;
    const bil = (a) => a[o] * (1 - fx) * (1 - fz) + a[o + 1] * fx * (1 - fz) + a[o + sres] * (1 - fx) * fz + a[o + sres + 1] * fx * fz;
    const phase = bil(wf.swellPhase);
    const Hf = bil(wf.swellH);
    const omega = (2 * Math.PI) / (sw.period || 9);
    const k = waveNumber(omega, Math.max(0.25, depth));
    const shallow = Math.max(0, Math.min(1, 1 - k * Math.max(depth, 0) * 1.1));
    const th = phase - omega * this.simTime;
    // must mirror swellWave() in WaterRenderer.js (per-wave height, depth-limited breaking)
    const fr = (v) => v - Math.floor(v);
    const hsh = (x, y) => {
      let p3x = fr(x * 0.1031), p3y = fr(y * 0.1031), p3z = fr(x * 0.1031);
      const d = p3x * (p3y + 33.33) + p3y * (p3z + 33.33) + p3z * (p3x + 33.33);
      p3x += d; p3y += d; p3z += d;
      return fr((p3x + p3y) * p3z);
    };
    const vn = (x, y) => {
      const ix = Math.floor(x), iy = Math.floor(y);
      let fx = x - ix, fy = y - iy;
      fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
      const a = hsh(ix, iy), b = hsh(ix + 1, iy), c2 = hsh(ix, iy + 1), d = hsh(ix + 1, iy + 1);
      return a + (b - a) * fx + (c2 - a) * fy + (a - b - c2 + d) * fx * fy;
    };
    const widx = Math.floor(th / (2 * Math.PI) + 0.5);
    const setN = vn(widx * 0.37, 1.7);
    const grp = (0.62 + 0.55 * setN) * (0.8 + 0.4 * vn(x * 0.021 + widx * 7.31, z * 0.021 + widx * 7.31));
    const Hloc = H0 * Hf * grp;
    const Hb = 0.78 * Math.max(depth, 0.04);
    const brk = Math.min(1, Math.max(0, (Hloc / Hb - 0.82) / 0.18));
    const H = Math.min(Hloc, Hb);
    const lean = (0.3 + 0.62 * brk) * shallow;
    const c = 0.5 + 0.5 * Math.cos(th + lean * Math.sin(th));
    const p = 1 + 2.0 * shallow;
    let y = H * (Math.pow(c, p) - (0.5 - 0.16 * shallow));
    y += 0.35 * H0 * Math.pow(0.5 + 0.5 * Math.cos(th - 0.6), 2) * (0.55 + 0.6 * setN) * Math.exp(-Math.max(shore, 0) / 9);
    return y;
  }

  /** Still-water + wave surface elevation near the camera (for the submerged test / waterline). */
  _cameraWater() {
    const w = this.world;
    const c = this.camera.position;
    let level = NO_WATER;
    if (w.hFinal.inBounds(c.x, c.z)) {
      const s = w.waterSurfaceAt(c.x, c.z);
      const ground = w.hFinal.sample(c.x, c.z);
      if (s > NO_WATER * 0.5 && s > ground - 0.05) {
        const gi = Math.round(w.hFinal.toGridZ(c.z)) * w.res + Math.round(w.hFinal.toGridX(c.x));
        // only real water (not the dry margin of the extended surface)
        if (w.water.type[gi] || s - ground > 0.02) level = s;
      }
    } else if (w.seaLevel !== null) level = w.seaLevel;
    if (level > NO_WATER * 0.5) {
      const tmp = this._wtmp || (this._wtmp = { level: 0, vx: 0, vz: 0 });
      this.objects.waterAt(c.x, c.z, tmp);
      if (tmp.level > NO_WATER * 0.5) level = tmp.level;
    }
    return level;
  }

  render(dt) {
    const r = this.renderer;
    const G = this.G;
    const world = this.world;
    if (!world || !this.viewW) return;
    const t0 = performance.now();
    const prof = this.prof || (this.prof = {});
    let tp = t0;
    const mark = (k) => {
      const n = performance.now();
      prof[k] = Math.max(prof[k] || 0, n - tp);
      tp = n;
    };
    r.info.reset();
    this._ensureTargets();
    const camera = this.camera;
    const simDt = this.paused ? 0 : Math.min(dt, 0.05);
    this.time += dt;
    this.simTime += simDt;
    this.frame++;
    camera.updateMatrixWorld(true);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    G.uCamPos.value.copy(camera.position);
    G.uTime.value = this.simTime;
    const pe = camera.projectionMatrix.elements;
    const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    G.uProjInfo.value.set(pe[10], pe[14], tanY * camera.aspect, tanY);

    // ---- simulation ----
    const env = world.project.env;
    const windStrength = Math.min(1.6, env.windSpeed / 9);
    this.library.setWind(Math.cos(env.windDir), Math.sin(env.windDir), 0.25 + windStrength, this.simTime);
    this.waterSim.setFocus(this.rippleFocus ? this.rippleFocus.x : camera.position.x, this.rippleFocus ? this.rippleFocus.z : camera.position.z);
    this.waterSim.causticAmp = 1;
    if (simDt > 0) {
      this.objects.step(simDt, this.simTime);
      this.waterSim.update(simDt);
    }
    if (this.objects.bodies.length && this.frame % 2 === 0) this.waterSim.readHeights();
    else if (this.frame % 6 === 0 && world.seaLevel !== null) this.waterSim.readHeights();

    mark('sim');
    this.atmosphere._mainPass = true;
    this.atmosphere.update(simDt, camera, this.sceneRT.width, this.sceneRT.height);
    mark('atmo');
    this.terrain.update(camera);
    this.vegetation.update(camera);
    mark('vegUpdate');

    // ---- shadows ----
    this.casters.length = 0;
    this.scene.traverseVisible((o) => {
      if (o.isMesh && o.userData.depthMaterial) this.casters.push(o);
    });
    const waterVisible = this.water.group.visible;
    this.water.group.visible = false;
    this.atmosphere.skyMesh.visible = false;
    this.shadows.render(this.scene, camera, this.atmosphere.sunDir, this.casters);
    this.atmosphere.skyMesh.visible = true;

    mark('shadows');
    // ---- camera vs water ----
    const level = this._cameraWater();
    this.waterLevelAtCamera = level;
    const nearH = camera.near * tanY * 1.6 + 0.02;
    this.cameraSubmerged = level > NO_WATER * 0.5 && camera.position.y < level;
    const nearSurface = level > NO_WATER * 0.5 && Math.abs(camera.position.y - level) < nearH + 0.6;
    this.water.U.uCamUnder.value = this.cameraSubmerged ? 1 : 0;

    // ---- planar reflection ----
    this.water.hasWater = this.water.hasWater && true;
    if (this.water.hasWater && !this.cameraSubmerged) this.water.renderReflection(camera, this.scene, this.sceneRT.width, this.sceneRT.height);
    else this.water.U.uReflValid.value = 0;

    mark('reflection');
    // ---- opaque ----
    this.renderScenePass(camera, this.sceneRT, {});
    mark('opaque');
    // ---- AO + contact shadows (multiplied into the MSAA buffer) ----
    if (this.quality.ao) this.post.applyAO(this.sceneRT, camera, this.atmosphere.sunDir);
    mark('ao');
    // ---- water ----
    this.water.update(camera, this.sceneRT);
    this.spray.update(camera);
    if (this.water.hasWater) {
      this.water.group.visible = true;
      camera.layers.set(4);
      r.setRenderTarget(this.sceneRT);
      r.render(this.scene, camera);
    }
    this.water.group.visible = waterVisible;
    // ---- editor overlays (gizmos, path handles) ----
    if (this.overlayScene.children.length) {
      camera.layers.set(5);
      r.setRenderTarget(this.sceneRT);
      r.render(this.overlayScene, camera);
    }
    camera.layers.set(0);
    mark('water');
    // ---- post ----
    const sigma = new THREE.Vector3().copy(G.uWaterAbsorb.value).addScaledVector(G.uWaterScatter.value, 0.5);
    const sunIn = Math.max(0, this.atmosphere.sunDir.y);
    const sky = this.atmosphere.skyIrradiance || [0.3, 0.4, 0.6];
    const sc = G.uWaterScatter.value, ab = G.uWaterAbsorb.value;
    const Rw = (b, a) => (0.33 * b * 0.14) / (a + b * 0.14);
    // looking horizontally through water the path radiance saturates at ~ the diffuse body colour
    const underColor = new THREE.Vector3(Rw(sc.x, ab.x) * (G.uSunColor.value.x * sunIn + sky[0]), Rw(sc.y, ab.y) * (G.uSunColor.value.y * sunIn + sky[1]), Rw(sc.z, ab.z) * (G.uSunColor.value.z * sunIn + sky[2])).multiplyScalar(1.15 / Math.PI);
    // multiple scattering washes the body colour out a little compared with the single-scattering estimate
    { const g = (underColor.x + underColor.y + underColor.z) / 3; underColor.lerp(new THREE.Vector3(g, g, g), 0.3); }
    this.post.aoStrength = 1;
    // exposure: follows scene illuminance like a camera's metering (partial compensation keeps dusk darker than noon)
    let expo = this.baseExposure;
    if (env.autoExposure !== false) {
      const sc3 = G.uSunColor.value;
      const cover = env.cloudCover ?? 0.3;
      const Eh = (0.2126 * sc3.x + 0.7152 * sc3.y + 0.0722 * sc3.z) * sunIn * (1 - 0.5 * cover) + (0.2126 * sky[0] + 0.7152 * sky[1] + 0.0722 * sky[2]);
      const target = this.baseExposure * Math.pow(15 / Math.max(Eh, 0.02), 0.72);
      const clamped = Math.min(this.baseExposure * 40, Math.max(this.baseExposure * 0.6, target));
      this._expo = this._expo ? this._expo + (clamped - this._expo) * Math.min(1, dt * 3) : clamped;
      expo = this._expo;
    }
    let finalSrc = this.sceneRT;
    if (this.debugView === 'refl' && this.water.reflRT) finalSrc = { texture: this.water.reflRT.texture, depthTexture: this.sceneRT.depthTexture, width: this.sceneRT.width, height: this.sceneRT.height };
    this.post.finish(finalSrc, camera, this.outputTarget || null, {
      exposure: expo * Math.pow(2, this.exposureEV),
      waterLevel: level,
      waterLineEnabled: this.cameraSubmerged || nearSurface,
      time: this.simTime,
      underAbsorb: sigma,
      underColor,
    });
    mark('post');
    // ---- stats ----
    const ms = performance.now() - t0;
    this.frameTimes[this.frameIdx++ % this.frameTimes.length] = dt * 1000;
    this.stats.ms = ms;
    this.stats.calls = r.info.render.calls;
    this.stats.triangles = r.info.render.triangles;
  }

  /** Average / percentile frame time over the recent window (ms). */
  frameStats() {
    const n = Math.min(this.frameIdx, this.frameTimes.length);
    if (!n) return { avg: 0, p95: 0, fps: 0 };
    const a = Array.from(this.frameTimes.subarray(0, n)).sort((x, y) => x - y);
    const avg = a.reduce((s, v) => s + v, 0) / n;
    return { avg, p95: a[Math.floor(n * 0.95)], p99: a[Math.floor(n * 0.99)], fps: 1000 / avg, n };
  }

  dispose() {
    this.renderer.dispose();
  }
}
