// Headless three.js renderer (Playwright + Chromium, hardware WebGL through ANGLE/Vulkan) used by preview.mjs.
// Serves ROOT read-only over a loopback HTTP server; the page loads three from ROOT/node_modules/three.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.mjs';

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.html': 'text/html' };

const PAGE = String.raw`<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>
<style>html,body{margin:0;background:#000}canvas{display:block}</style></head><body>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);
const pmrem = new THREE.PMREMGenerator(renderer);
const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
const loader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();

function makeScene(bg) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(bg);
  scene.environment = envTex; scene.environmentIntensity = 0.55;
  const sun = new THREE.DirectionalLight(0xfff2e0, 3.2); sun.position.set(-0.55, 0.75, 0.6); scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x4a4436, 0.9));
  return scene;
}
function describe(root) {
  const box = new THREE.Box3().setFromObject(root);
  let tris = 0; const mats = []; let meshes = 0; let identity = true;
  root.traverse((o) => {
    if (o !== root && (o.position.lengthSq() > 1e-12 || Math.abs(o.scale.x - 1) > 1e-6 || Math.abs(o.quaternion.w) < 0.999999)) identity = false;
    if (!o.isMesh) return;
    meshes++;
    const g = o.geometry; tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    const m = o.material;
    mats.push({ name: m.name, map: !!m.map, mapSize: m.map?.image ? [m.map.image.width, m.map.image.height] : null, normalMap: !!m.normalMap, orm: !!m.roughnessMap, ao: !!m.aoMap, alphaTest: m.alphaTest, transparent: m.transparent, side: m.side,
      hasNormals: !!g.attributes.normal, hasUv: !!g.attributes.uv, hasColor: !!g.attributes.color });
  });
  return { tris, meshes, identity, min: box.min.toArray(), max: box.max.toArray(), mats };
}
async function load(url) { const g = await loader.loadAsync(url); await new Promise((r) => setTimeout(r, 0)); return g.scene; }

function frame(camera, box, az, el, aspect, pad = 1.08) {
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
  // fit the box's projected extent
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
  const up = new THREE.Vector3().crossVectors(dir, right).normalize();
  let hw = 0, hh = 0;
  for (let i = 0; i < 8; i++) {
    const p = new THREE.Vector3(i & 1 ? s.x : -s.x, i & 2 ? s.y : -s.y, i & 4 ? s.z : -s.z).multiplyScalar(0.5);
    hw = Math.max(hw, Math.abs(p.dot(right))); hh = Math.max(hh, Math.abs(p.dot(up)));
  }
  const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const d = Math.max(hh / t, hw / (t * aspect)) * pad + s.length() * 0.25;
  camera.aspect = aspect; camera.near = d / 200; camera.far = d * 10;
  camera.position.copy(c).addScaledVector(dir, d); camera.lookAt(c); camera.updateProjectionMatrix();
}
function originMarker(size) {
  const g = new THREE.Group();
  const grid = new THREE.GridHelper(size * 2, 8, 0x30363c, 0x596069); grid.material.opacity = 0.55; grid.material.transparent = true; g.add(grid);
  const ax = new THREE.AxesHelper(size * 0.35); g.add(ax);
  return g;
}
function disposeTree(root) {
  root.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); const m = o.material; for (const k of ['map', 'normalMap', 'roughnessMap', 'aoMap', 'metalnessMap']) m[k]?.dispose(); m.dispose(); } });
}

// Render all LODs side by side with an identical camera. far > 1 additionally renders the same strip with the
// camera pulled back by that factor (what the LODs look like at the distance they are meant for, mip-mapping included).
window.renderModel = async ({ urls, cell = 420, az = 0.65, el = 0.22, far = 0, bg = 0xaab7c4 }) => {
  const roots = []; const infos = [];
  for (const u of urls) { const r = await load(u); roots.push(r); infos.push(describe(r)); }
  const box = new THREE.Box3().setFromObject(roots[0]);
  const size = box.getSize(new THREE.Vector3());
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 100);
  const scene = makeScene(bg);
  const marker = originMarker(Math.max(size.x, size.z, size.y * 0.4)); scene.add(marker);
  const strip = (c, pad) => {
    renderer.setScissorTest(false);
    renderer.setSize(c * urls.length, c, false);
    renderer.setScissorTest(true);
    frame(camera, box, az, el, 1, pad);
    roots.forEach((r, i) => {
      roots.forEach((o) => scene.remove(o)); scene.add(r);
      renderer.setViewport(i * c, 0, c, c); renderer.setScissor(i * c, 0, c, c);
      renderer.render(scene, camera);
    });
    return renderer.domElement.toDataURL('image/png');
  };
  const near = strip(cell, 1.08);
  let farUrl = null;
  if (far > 1) { scene.remove(marker); farUrl = strip(Math.round(cell / far), 1.08); }
  renderer.setScissorTest(false);
  roots.forEach(disposeTree);
  return { strip: near, far: farUrl, infos };
};

// Close-up of the upper part of lod0 against a bright background (to inspect alpha edges / halos / bark)
window.renderCloseup = async ({ url, w = 900, h = 700, az = 0.65, el = 0.1, region = [0.35, 0.75], zoom = 0.35, bg = 0xd8e2ee }) => {
  const r = await load(url);
  const box = new THREE.Box3().setFromObject(r);
  const s = box.getSize(new THREE.Vector3());
  const sub = box.clone();
  sub.min.y = box.min.y + s.y * region[0]; sub.max.y = box.min.y + s.y * region[1];
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
  sub.min.x = cx - s.x * zoom; sub.max.x = cx + s.x * zoom; sub.min.z = cz - s.z * zoom; sub.max.z = cz + s.z * zoom;
  const scene = makeScene(bg); scene.add(r);
  const camera = new THREE.PerspectiveCamera(26, w / h, 0.1, 100);
  renderer.setScissorTest(false); renderer.setSize(w, h, false); renderer.setViewport(0, 0, w, h);
  frame(camera, sub, az, el, w / h, 1.0);
  renderer.render(scene, camera);
  const out = renderer.domElement.toDataURL('image/jpeg', 0.93);
  disposeTree(r);
  return out;
};

// A PBR texture set: 2x2 tiles on a plane under raking light (seams + normal convention, displacement inset) and
// 3x1.5 tiles on a lit sphere.
window.renderTexture = async ({ dir, cell = 420 }) => {
  const load2 = async (n, srgb) => { const t = await texLoader.loadAsync(dir + '/' + n + '.jpg'); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 8; return t; };
  const [map, normalMap, arm, disp] = await Promise.all([load2('diff', true), load2('nor', false), load2('arm', false), load2('disp', false)]);
  const sizes = Object.fromEntries([['diff', map], ['nor', normalMap], ['arm', arm], ['disp', disp]].map(([k, t]) => [k, [t.image.width, t.image.height]]));
  const mat = new THREE.MeshStandardMaterial({ map, normalMap, roughnessMap: arm, metalnessMap: arm, aoMap: arm, metalness: 1, roughness: 1 });
  renderer.setScissorTest(true);
  renderer.setSize(cell * 2, cell, false);
  {
    const scene = makeScene(0x30353b);
    const geo = new THREE.PlaneGeometry(2, 2, 1, 1); geo.attributes.uv.array.forEach((v, i, a) => (a[i] = v * 2));
    scene.add(new THREE.Mesh(geo, mat));
    const hgeo = new THREE.PlaneGeometry(0.62, 0.62); const hm = new THREE.Mesh(hgeo, new THREE.MeshBasicMaterial({ map: disp })); hm.position.set(0.68, -0.68, 0.01); scene.add(hm);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10); camera.position.set(0, 0, 3); camera.lookAt(0, 0, 0);
    scene.children.find((c) => c.isDirectionalLight).position.set(-1, 1, 0.55);
    renderer.setViewport(0, 0, cell, cell); renderer.setScissor(0, 0, cell, cell);
    renderer.render(scene, camera);
    geo.dispose(); hgeo.dispose(); hm.material.dispose();
  }
  {
    const scene = makeScene(0x23272c);
    const geo = new THREE.SphereGeometry(1, 96, 64); geo.attributes.uv.array.forEach((v, i, a) => (a[i] = v * (i % 2 ? 1.5 : 3)));
    scene.add(new THREE.Mesh(geo, mat));
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20); camera.position.set(0, 0.4, 4.1); camera.lookAt(0, 0, 0);
    renderer.setViewport(cell, 0, cell, cell); renderer.setScissor(cell, 0, cell, cell);
    renderer.render(scene, camera);
    geo.dispose();
  }
  renderer.setScissorTest(false);
  const out = renderer.domElement.toDataURL('image/png');
  [map, normalMap, arm, disp].forEach((t) => t.dispose()); mat.dispose();
  return { image: out, sizes };
};
{ const gl = renderer.getContext(); const ext = gl.getExtension('WEBGL_debug_renderer_info'); window.__gl = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); }
window.__ready = true;
</script></body></html>`;

export async function startRenderer() {
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
      if (url.pathname === '/__render.html') { res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE); return; }
      const p = path.resolve(ROOT, '.' + decodeURIComponent(url.pathname));
      if (!p.startsWith(ROOT + path.sep) || !fs.existsSync(p) || !fs.statSync(p).isFile()) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      fs.createReadStream(p).pipe(res);
    } catch (e) { res.writeHead(500).end(String(e)); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { server.close(); throw new Error('playwright not found (run npm ci in the project root)'); }
  if (!fs.existsSync(path.join(ROOT, 'node_modules/three/build/three.module.js'))) { server.close(); throw new Error('three not found at ROOT/node_modules/three (run npm ci in the project root).'); }
  const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  await page.goto(`${base}/__render.html`);
  await page.waitForFunction('window.__ready === true', null, { timeout: 60000 });
  const decode = (dataUrl) => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  const gl = await page.evaluate(() => window.__gl);
  return {
    base, errors, decode, gl,
    renderModel: (o) => page.evaluate((a) => window.renderModel(a), o),
    renderCloseup: (o) => page.evaluate((a) => window.renderCloseup(a), o),
    renderTexture: (o) => page.evaluate((a) => window.renderTexture(a), o),
    close: async () => { await browser.close(); server.close(); },
  };
}
