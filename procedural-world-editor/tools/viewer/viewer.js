// Standalone viewer for Terraforge exports. Uses ONLY stock three.js (GLTFLoader, OrbitControls,
// RoomEnvironment) - nothing from the editor's src/ tree - so it shows what any glTF consumer gets.
//
// URL parameters:
//   glb=/export/scene.glb          scene to load
//   env=/export/environment.json   optional: sun direction for the directional light
//   hud=0                          hide the text overlay (used for screenshots)
//   budget=250                     max triangles (millions) drawn through GPU instancing; denser
//                                  scenes are thinned for DISPLAY only (statistics use all instances)
//
// Automation API (used by tools/verify-export.mjs):
//   await window.viewer.ready            -> resolves when the scene is loaded (rejects on error)
//   window.viewer.stats                  -> measurements (tools/viewer/stats.js)
//   await window.viewer.setCamera({eye:[x,y,z], target:[x,y,z], fov?}) -> renders, resolves after the frame
//   window.viewer.error                  -> message if loading failed

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { collectStats, thinInstances } from './stats.js';

const params = new URLSearchParams(location.search);
const glbUrl = params.get('glb') || '/export/scene.glb';
const envUrl = params.get('env') ?? '/export/environment.json';
const hud = document.getElementById('hud');
if (params.get('hud') === '0') hud.style.display = 'none';
const budget = (params.has('budget') ? +params.get('budget') : 250) * 1e6;

const viewer = { stats: null, error: null, thinning: 1, renderer: null, frames: 0 };
window.viewer = viewer;

function fail(msg) {
  viewer.error = msg;
  hud.style.display = '';
  hud.className = 'error';
  hud.textContent = msg;
}

async function main() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  document.body.prepend(renderer.domElement);
  viewer.renderer = renderer;
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  viewer.gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);

  const scene = new THREE.Scene();
  const sky = new THREE.Color(0x9db4c8);
  scene.background = sky;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.45;
  pmrem.dispose();

  // sun from environment.json (unit vector towards the sun); default: high south-east sun
  let sunDir = new THREE.Vector3(-0.45, 0.75, 0.48).normalize();
  if (envUrl) {
    try {
      const res = await fetch(envUrl);
      if (res.ok) {
        const env = await res.json();
        const d = env?.sun?.direction;
        if (Array.isArray(d) && d.length === 3 && d[1] > 0.12) sunDir = new THREE.Vector3(d[0], d[1], d[2]).normalize();
        viewer.environment = env;
      }
    } catch {
      /* optional */
    }
  }
  const sun = new THREE.DirectionalLight(0xfff2de, 3.0);
  sun.position.copy(sunDir).multiplyScalar(1000);
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0xbfd4ee, 0x4a4436, 0.9));

  const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.5, 30000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;

  let needsRender = true;
  const render = () => {
    renderer.render(scene, camera);
    viewer.frames++;
    needsRender = false;
  };
  controls.addEventListener('change', () => (needsRender = true));
  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    needsRender = true;
  });
  const loop = () => {
    if (needsRender) render();
    requestAnimationFrame(loop);
  };

  hud.textContent = `loading ${glbUrl} …`;
  const loader = new GLTFLoader();
  const gltf = await new Promise((resolve, reject) =>
    loader.load(
      glbUrl,
      resolve,
      (ev) => {
        if (ev.total) hud.textContent = `loading ${glbUrl} … ${Math.round((ev.loaded / ev.total) * 100)} %`;
      },
      (err) => reject(new Error(`GLTFLoader failed for ${glbUrl}: ${err?.message || err}`)),
    ),
  );
  scene.add(gltf.scene);
  gltf.scene.updateMatrixWorld(true);
  viewer.gltfInfo = { extensionsUsed: gltf.parser.json.extensionsUsed || [], extensionsRequired: gltf.parser.json.extensionsRequired || [], generator: gltf.asset?.generator || null, sceneExtras: gltf.scene.userData || {} };

  // statistics over the full scene, then (display only) thinning of dense instancing
  const stats = collectStats(THREE, gltf.scene);
  viewer.thinning = thinInstances(THREE, gltf.scene, budget);
  stats.gpu = viewer.gpu;
  stats.displayThinning = viewer.thinning;
  viewer.stats = stats;
  // instanced foliage is not frustum-culled per instance; skip per-object culling for robustness
  gltf.scene.traverse((o) => {
    if (o.isInstancedMesh) o.frustumCulled = false;
  });

  // frame the scene
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const span = Math.max(size.x, size.z, 1);
  scene.fog = new THREE.Fog(sky, span * 0.9, span * 4.5);
  viewer.bounds = { min: box.min.toArray(), max: box.max.toArray() };

  viewer.setCamera = async ({ eye, target, fov }) => {
    camera.fov = fov || 45;
    const e = new THREE.Vector3(...eye),
      t = new THREE.Vector3(...target);
    const dist = e.distanceTo(t);
    camera.near = Math.max(0.2, Math.min(5, dist * 0.01));
    camera.far = Math.max(span * 6, dist * 20);
    camera.position.copy(e);
    camera.updateProjectionMatrix();
    controls.target.copy(t);
    controls.update();
    camera.lookAt(t);
    // two frames: the first compiles shaders / uploads textures
    render();
    await new Promise((r) => requestAnimationFrame(() => r()));
    render();
    await new Promise((r) => requestAnimationFrame(() => r()));
    return { drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  };

  await viewer.setCamera({ eye: [centre.x + span * 0.08, box.max.y + span * 0.7, centre.z + span * 0.75], target: [centre.x, centre.y - size.y * 0.2, centre.z] });
  const t = stats.totals;
  hud.className = '';
  hud.textContent =
    `Terraforge export - stock three.js r${THREE.REVISION} GLTFLoader\n` +
    `${glbUrl}\n` +
    `extent ${size.x.toFixed(0)} x ${size.z.toFixed(0)} m, y ${box.min.y.toFixed(1)} .. ${box.max.y.toFixed(1)} m\n` +
    `meshes ${t.meshes} (${t.instancedMeshes} instanced), instances ${t.instances}\n` +
    `triangles ${t.triangles} unique, ${(t.instancedTriangles / 1e6).toFixed(1)} M instanced` +
    (viewer.thinning > 1 ? `\ndisplay shows 1/${viewer.thinning} of the instances (budget ${budget / 1e6} M triangles)` : '') +
    `\nwater bodies ${stats.water.length}, structures ${stats.structures.length}, objects ${stats.objects.length}, roads ${stats.roads.length}\n` +
    `GPU: ${viewer.gpu}`;
  loop();
}

viewer.ready = main().catch((e) => {
  fail(String(e?.stack || e?.message || e));
  throw e;
});
viewer.ready.catch(() => {});
