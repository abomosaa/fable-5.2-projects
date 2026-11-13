/**
 * Renderer: scene, sky, lighting, cameras and the lens/tone-mapping pass.
 *
 * Pipeline: scene -> HDR multisampled target (rectilinear, slightly over-scanned)
 *           -> full-screen pass: wide-angle lens mapping, vignette, sensor noise,
 *              ACES tone mapping, sRGB.
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { MapData } from '../world/map';
import { Simulation } from '../sim/simulation';
import { Drone } from '../sim/drone';
import { DroneModel } from './droneModel';
import { buildScenery, Scenery } from './scenery';
import { blobTexture } from './textures';

export type CameraMode = 'fpv' | 'los' | 'chase';
export type Quality = 'low' | 'medium' | 'high';

export interface ViewOptions {
  /** Horizontal field of view of the FPV camera on a 16:9 frame [deg]. */
  fov: number;
  /** 0 = rectilinear, 1 = equidistant fisheye. */
  lens: number;
  /** FPV camera uptilt [deg]. */
  cameraTilt: number;
  /** Highlight the next race gate. */
  gateMarker: boolean;
}

const LENS_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
uniform float aspect;
uniform float tanH;
uniform float halfH;
uniform float tanHs;
uniform float lens;
uniform float vignette;
uniform float grain;
uniform float time;
varying vec2 vUv;
#include <tonemapping_pars_fragment>
#include <colorspace_pars_fragment>

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 lensMap(vec2 pa, float k) {
  float rho = length(pa);
  if (rho < 1e-5) return pa;
  float theta = mix(atan(rho * tanH), rho * halfH, lens) * k;
  theta = min(theta, 1.5);
  return pa / rho * (tan(theta) / tanHs);
}

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  vec2 pa = vec2(p.x, p.y / aspect);
  vec3 col;
  if (lens > 0.001) {
    // Slight lateral chromatic aberration, as on a real wide-angle lens.
    vec2 sr = lensMap(pa, 1.0 + 0.0022 * lens);
    vec2 sg = lensMap(pa, 1.0);
    vec2 sb = lensMap(pa, 1.0 - 0.0022 * lens);
    col.r = texture2D(tDiffuse, vec2(sr.x, sr.y * aspect) * 0.5 + 0.5).r;
    col.g = texture2D(tDiffuse, vec2(sg.x, sg.y * aspect) * 0.5 + 0.5).g;
    col.b = texture2D(tDiffuse, vec2(sb.x, sb.y * aspect) * 0.5 + 0.5).b;
  } else {
    col = texture2D(tDiffuse, vUv).rgb;
  }
  float rc = length(pa) / length(vec2(1.0, 1.0 / aspect));
  col *= 1.0 - vignette * smoothstep(0.35, 1.05, rc) * 0.75;
  col = ACESFilmicToneMapping(col);
  vec4 o = sRGBTransferOETF(vec4(col, 1.0));
  float n = hash(gl_FragCoord.xy + fract(time) * 917.0) - 0.5;
  o.rgb += n * grain;
  gl_FragColor = vec4(o.rgb, 1.0);
}`;

const LENS_VERT = /* glsl */ `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

export class View {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sunDir = new THREE.Vector3();
  quality: Quality = 'high';

  private readonly map: MapData;
  private scenery: Scenery;
  private sky: Sky;
  private sun: THREE.DirectionalLight;
  private model: DroneModel | null = null;
  private blob: THREE.Mesh;
  private target: THREE.WebGLRenderTarget;
  private postScene = new THREE.Scene();
  private postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private postMat: THREE.RawShaderMaterial;
  private width = 1;
  private height = 1;
  private renderScale = 1;
  private time = 0;
  private chasePos = new THREE.Vector3();
  private chaseInit = false;
  private losFov = 50;
  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private tiltQ = new THREE.Quaternion();
  private xAxis = new THREE.Vector3(1, 0, 0);
  private shadowsBaked = 0;

  constructor(canvas: HTMLCanvasElement, map: MapData) {
    this.map = map;
    const r = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer = r;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NoToneMapping; // done in the lens pass
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.info.autoReset = true;

    this.camera = new THREE.PerspectiveCamera(90, 1, 0.02, 9000);
    this.scene.add(this.camera);

    // ---- sky -------------------------------------------------------------------
    const elevation = 40, azimuth = 148; // sun in the south-east, mid-morning
    const phi = THREE.MathUtils.degToRad(90 - elevation), theta = THREE.MathUtils.degToRad(azimuth);
    // azimuth as compass bearing: north = -Z, east = +X
    this.sunDir.set(Math.sin(phi) * Math.sin(theta), Math.cos(phi), -Math.sin(phi) * Math.cos(theta)).normalize();

    this.sky = new Sky();
    this.sky.scale.setScalar(8000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 3.2;
    u.rayleigh.value = 1.35;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.82;
    u.sunPosition.value.copy(this.sunDir);
    if (u.cloudCoverage) {
      u.cloudCoverage.value = 0.38;
      u.cloudDensity.value = 0.45;
      u.cloudElevation.value = 0.5;
    }

    // Image-based ambient light from the sky itself (sun disc excluded: the sun is a real light).
    const pmrem = new THREE.PMREMGenerator(r);
    const skyScene = new THREE.Scene();
    skyScene.add(this.sky);
    if (u.showSunDisc) u.showSunDisc.value = 0;
    const env = pmrem.fromScene(skyScene, 0, 1, 20000);
    if (u.showSunDisc) u.showSunDisc.value = 1;
    pmrem.dispose();
    this.scene.environment = env.texture;
    this.scene.environmentIntensity = 0.2;
    this.scene.add(this.sky);
    this.scene.fog = new THREE.FogExp2(0xbccfe0, 0.00058);

    this.sun = new THREE.DirectionalLight(0xfff0d8, 3.7);
    this.sun.position.copy(this.sunDir).multiplyScalar(500);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -235; sc.right = 235; sc.top = 235; sc.bottom = -235;
    sc.near = 50; sc.far = 1000;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.12;
    this.sun.shadow.radius = 2.5;
    // The world is static: bake the shadow map once instead of every frame.
    this.sun.shadow.autoUpdate = false;
    this.sun.shadow.needsUpdate = true;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.scene.add(new THREE.HemisphereLight(0xe9eef2, 0x6c6a52, 0.85));

    // ---- world -----------------------------------------------------------------
    this.scenery = buildScenery(map, r.capabilities.getMaxAnisotropy());
    this.scene.add(this.scenery.group);

    // Contact shadow of the drone (the baked shadow map only knows the static world).
    const blobGeo = new THREE.PlaneGeometry(1, 1);
    blobGeo.rotateX(-Math.PI / 2);
    this.blob = new THREE.Mesh(blobGeo, new THREE.MeshBasicMaterial({
      map: blobTexture(), transparent: true, depthWrite: false, opacity: 0.6,
      polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8, toneMapped: false,
    }));
    this.blob.renderOrder = 20;
    this.scene.add(this.blob);

    // ---- post ------------------------------------------------------------------
    this.target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4, depthBuffer: true });
    this.postMat = new THREE.RawShaderMaterial({
      vertexShader: LENS_VERT,
      fragmentShader: LENS_FRAG,
      uniforms: {
        tDiffuse: { value: this.target.texture },
        toneMappingExposure: { value: 0.42 },
        aspect: { value: 1 }, tanH: { value: 1 }, halfH: { value: 1 }, tanHs: { value: 1 },
        lens: { value: 0 }, vignette: { value: 0 }, grain: { value: 0 }, time: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    const quad = new THREE.Mesh(tri, this.postMat);
    quad.frustumCulled = false;
    this.postScene.add(quad);
  }

  setQuality(q: Quality): void {
    this.quality = q;
    const size = q === 'low' ? 2048 : 4096;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
      this.sun.shadow.needsUpdate = true;
    }
    this.resize(this.width, this.height, true);
  }

  setDrone(drone: Drone): void {
    if (this.model) this.scene.remove(this.model.root);
    this.model = new DroneModel(drone.p, drone.d);
    this.model.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = false;
        o.receiveShadow = true;
      }
    });
    this.scene.add(this.model.root);
    this.chaseInit = false;
  }

  resize(w: number, h: number, force = false): void {
    if (!force && w === this.width && h === this.height) return;
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(this.width, this.height, false);
    this.allocTarget();
  }

  private allocTarget(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality === 'high' ? 2 : 1.25);
    const q = this.quality === 'low' ? 0.8 : 1;
    let s = q * this.renderScale;
    let tw = Math.round(this.width * dpr * s), th = Math.round(this.height * dpr * s);
    // Keep the off-screen buffer within sane limits.
    const maxPixels = this.quality === 'high' ? 9.5e6 : this.quality === 'medium' ? 5e6 : 2.6e6;
    const px = tw * th;
    if (px > maxPixels) {
      const k = Math.sqrt(maxPixels / px);
      tw = Math.round(tw * k); th = Math.round(th * k);
    }
    const samples = this.quality === 'low' ? 0 : 4;
    if (this.target.width !== tw || this.target.height !== th || this.target.samples !== samples) {
      this.target.dispose();
      this.target = new THREE.WebGLRenderTarget(tw, th, { type: THREE.HalfFloatType, samples, depthBuffer: true });
      this.postMat.uniforms.tDiffuse.value = this.target.texture;
    }
    // The canvas itself is presented at device resolution.
    const cw = Math.round(this.width * dpr), ch = Math.round(this.height * dpr);
    const c = this.renderer.domElement;
    if (c.width !== cw || c.height !== ch) this.renderer.setSize(cw, ch, false);
  }

  /** Canvas backing-store size (device pixels). */
  get pixelSize(): { w: number; h: number } {
    return { w: this.renderer.domElement.width, h: this.renderer.domElement.height };
  }

  render(sim: Simulation, mode: CameraMode, dt: number, opt: ViewOptions): void {
    this.time += dt;
    const drone = sim.drone;
    const cam = this.camera;
    const aspect = this.width / this.height;
    const model = this.model!;
    model.setCameraTilt(THREE.MathUtils.degToRad(opt.cameraTilt));
    model.update(drone, dt * sim.timeScale, mode === 'fpv');
    const dp = model.root.position, dq = model.root.quaternion;

    let lens = 0, vignette = 0, grain = 0;
    let tanH: number;
    if (mode === 'fpv') {
      // Field of view is specified for a 16:9 frame; other aspect ratios keep the vertical angle.
      const tanH169 = Math.tan(THREE.MathUtils.degToRad(opt.fov) / 2);
      tanH = (tanH169 / (16 / 9)) * aspect;
      lens = opt.lens;
      vignette = 0.25 + 0.3 * opt.lens;
      grain = 0.012;
      cam.position.copy(model.cameraMount).applyQuaternion(dq).add(dp);
      this.tiltQ.setFromAxisAngle(this.xAxis, THREE.MathUtils.degToRad(opt.cameraTilt));
      cam.quaternion.copy(dq).multiply(this.tiltQ);
      cam.near = 0.012;
    } else if (mode === 'los') {
      const p = this.map.pilot;
      cam.position.set(p.x, p.y, p.z);
      const dist = cam.position.distanceTo(dp);
      // A screen cannot match the eye's acuity, so narrow the view as the craft
      // gets further away - about what you can actually resolve line-of-sight.
      const want = THREE.MathUtils.lerp(48, 17, THREE.MathUtils.smoothstep(dist, 4, 110));
      this.losFov += (want - this.losFov) * Math.min(1, dt * 3);
      tanH = Math.tan(THREE.MathUtils.degToRad(this.losFov) / 2) * aspect;
      cam.up.set(0, 1, 0);
      // Keep the craft in the upper part of the frame when it is high, so some
      // ground stays in view for reference (your peripheral vision does this for free).
      const horiz = Math.hypot(dp.x - p.x, dp.z - p.z);
      const elev = Math.atan2(dp.y - p.y, Math.max(horiz, 0.01));
      const shift = THREE.MathUtils.clamp(elev, 0, THREE.MathUtils.degToRad(this.losFov * 0.2));
      const aimElev = elev - shift;
      const k = horiz > 0.01 ? 1 / horiz : 0;
      const ax = (dp.x - p.x) * k, az = (dp.z - p.z) * k;
      const reach = Math.max(dist, 1);
      this.tmpV.set(p.x + ax * Math.cos(aimElev) * reach, p.y + Math.sin(aimElev) * reach, p.z + az * Math.cos(aimElev) * reach);
      if (horiz < 0.05) this.tmpV.copy(dp);
      cam.lookAt(this.tmpV);
      cam.near = 0.1;
    } else {
      // Chase: behind and above, following heading only.
      const f = this.tmpV.set(0, 0, -1).applyQuaternion(dq);
      f.y = 0;
      if (f.lengthSq() < 1e-4) f.set(0, 0, -1).applyQuaternion(dq).setY(0);
      if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
      f.normalize();
      const want = this.tmpV2.copy(dp).addScaledVector(f, -2.4);
      want.y += 0.9;
      const minY = this.map.terrain.heightAt(want.x, want.z) + 0.25;
      if (want.y < minY) want.y = minY;
      if (!this.chaseInit) { this.chasePos.copy(want); this.chaseInit = true; }
      this.chasePos.lerp(want, 1 - Math.exp(-dt * 7));
      cam.position.copy(this.chasePos);
      cam.up.set(0, 1, 0);
      cam.lookAt(this.tmpV.copy(dp).setY(dp.y + 0.15));
      tanH = Math.tan(THREE.MathUtils.degToRad(72) / 2) * aspect;
      cam.near = 0.05;
    }

    // Source (rectilinear) field of view needed to cover the lens mapping at the corners.
    const halfH = Math.atan(tanH);
    let tanHs = tanH;
    let scale = 1;
    if (lens > 0.001) {
      const rhoC = Math.hypot(1, 1 / aspect);
      const thetaC = Math.min(1.42, (1 - lens) * Math.atan(rhoC * tanH) + lens * rhoC * halfH);
      tanHs = Math.tan(thetaC) / rhoC;
      const mag = ((1 - lens) * tanH + lens * halfH) / tanHs;
      scale = THREE.MathUtils.clamp(1 / mag, 1, 1.6);
    }
    // Quantise so the buffer is not reallocated on tiny changes.
    scale = Math.round(scale * 10) / 10;
    if (scale !== this.renderScale) {
      this.renderScale = scale;
      this.allocTarget();
    }
    cam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(tanHs / aspect));
    cam.aspect = aspect;
    cam.far = 9000;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    // Sky follows the camera; clouds drift.
    this.sky.position.copy(cam.position);
    const su = this.sky.material.uniforms;
    if (su.time) su.time.value = this.time;

    this.scenery.update(sim.time, sim.env);

    // Next-gate marker.
    const mk = this.scenery.gateMarker;
    if (opt.gateMarker && sim.gates.length > 0) {
      const g = sim.gates[sim.lap.nextGate];
      mk.visible = true;
      mk.position.set(g.x, g.y, g.z);
      mk.rotation.y = -g.heading;
      const pulse = 0.55 + 0.3 * Math.sin(this.time * 5);
      mk.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
        if (m && 'opacity' in m) m.opacity = pulse;
      });
    } else {
      mk.visible = false;
    }

    // Contact shadow along the sun direction.
    const sd = this.sunDir;
    let gx = dp.x, gz = dp.z, gy = this.map.terrain.heightAt(gx, gz);
    for (let i = 0; i < 2; i++) {
      const t = (dp.y - gy) / sd.y;
      gx = dp.x - sd.x * t; gz = dp.z - sd.z * t;
      gy = this.map.terrain.heightAt(gx, gz);
    }
    const hgt = Math.max(0, dp.y - gy);
    const size = (drone.p.frame.motorX * 2 + drone.p.rotor.radius * 2) * (1.25 + hgt * 0.035);
    this.blob.position.set(gx, gy + 0.02, gz);
    this.blob.scale.set(size, 1, size);
    (this.blob.material as THREE.MeshBasicMaterial).opacity = 0.62 * Math.max(0, 1 - hgt / 45);
    this.blob.visible = hgt < 45;

    const u = this.postMat.uniforms;
    u.aspect.value = aspect;
    u.tanH.value = tanH;
    u.halfH.value = halfH;
    u.tanHs.value = tanHs;
    u.lens.value = lens;
    u.vignette.value = vignette;
    u.grain.value = grain;
    u.time.value = this.time;

    const r = this.renderer;
    r.setRenderTarget(this.target);
    r.render(this.scene, cam);
    r.setRenderTarget(null);
    r.render(this.postScene, this.postCam);

    // Textures are uploaded lazily; re-bake the static shadows once everything is on the GPU.
    if (this.shadowsBaked < 3) {
      this.shadowsBaked++;
      this.sun.shadow.needsUpdate = true;
    }
  }

  /** Project a world position to normalised device coordinates of the last frame; z > 1 = behind. */
  project(x: number, y: number, z: number, out: { x: number; y: number; behind: boolean }): void {
    const v = this.tmpV.set(x, y, z).applyMatrix4(this.camera.matrixWorldInverse);
    out.behind = v.z > 0;
    v.applyMatrix4(this.camera.projectionMatrix);
    out.x = v.x;
    out.y = v.y;
  }
}
