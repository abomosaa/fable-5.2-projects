/**
 * Three.js viewport: renders the designed assembly (or the running
 * simulation's transient poses), joint overlays, traces and diagnostics, and
 * handles picking / dragging / tools.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Joint, Part, Project } from '../../core/model/types';
import { GROUND } from '../../core/model/types';
import { anchorLocal, geometryOf, localToWorld, materialOf, worldToLocal } from '../../core/model/project';
import type { Layer, PartGeometry, Port } from '../../core/parts/catalog';
import { buildSolid, kernelReady } from '../../core/geom/kernel';
import type { SimRunner } from '../../core/sim/runner';
import { pointInPoly, signedArea } from '../../core/math/poly';
import { getState, simCtl, type AppState, type ViewSettings } from '../store';

export interface PickResult {
  partId: string | null;
  /** world point on the mechanism plane under the cursor */
  world: { x: number; y: number };
  port: Port | null;
  /** part-local coordinates of the pick (port position if snapped) */
  local: { x: number; y: number } | null;
  jointId: string | null;
  probeId: string | null;
}

export interface FrameInfo {
  mmPerPx: number;
  camQuat: THREE.Quaternion;
  fps: number;
}

type Pose = { x: number; y: number; angle: number };

const LOOKS: Record<string, { color: number; metalness: number; roughness: number }> = {
  steel: { color: 0xb4bac4, metalness: 1.0, roughness: 0.28 },
  dark: { color: 0x25282d, metalness: 0.55, roughness: 0.5 },
  rubber: { color: 0x1a1b1d, metalness: 0.0, roughness: 0.95 },
  brass: { color: 0xd6b25a, metalness: 1.0, roughness: 0.3 },
  copper: { color: 0xc77b4a, metalness: 1.0, roughness: 0.3 },
};

interface GeoSet { items: { look: string; geo: THREE.BufferGeometry; edges: THREE.BufferGeometry }[] }
const geoCache = new WeakMap<PartGeometry, GeoSet>();

function geometryFor(g: PartGeometry): GeoSet {
  let set = geoCache.get(g);
  if (set) return set;
  set = { items: [] };
  const groups = new Map<string, Layer[]>();
  for (const l of g.layers) {
    const k = l.look ?? 'body';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(l);
  }
  for (const [look, layers] of groups) {
    const solid = kernelReady() ? buildSolid(layers) : null;
    if (!solid) continue;
    let geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(solid.positions, 3));
    geo.setIndex(new THREE.BufferAttribute(solid.indices, 1));
    const edges = new THREE.EdgesGeometry(geo, 28);
    geo = toCreasedNormals(geo, (32 * Math.PI) / 180);
    geo.computeBoundingSphere();
    set.items.push({ look, geo, edges });
  }
  geoCache.set(g, set);
  return set;
}

interface PartView {
  group: THREE.Group;
  meshes: THREE.Mesh[];
  edges: THREE.LineSegments[];
  caps: THREE.Object3D[];
  geomRef: PartGeometry;
  styleKey: string;
  baseColor: THREE.Color;
  zLevel: number;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const UP_Z = new THREE.Vector3(0, 0, 1);

function makeLabelSprite(text: string, color = '#e8a33d'): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(16,18,22,0.85)';
  ctx.beginPath(); ctx.arc(32, 32, 26, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.stroke();
  ctx.fillStyle = color; ctx.font = '700 30px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 32, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false, transparent: true }));
  sp.scale.set(0.032, 0.032, 1);
  sp.renderOrder = 1000;
  return sp;
}

export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  private persp: THREE.PerspectiveCamera;
  private ortho: THREE.OrthographicCamera;
  camera: THREE.Camera;
  controls: OrbitControls;
  private container: HTMLElement;
  private parts = new Map<string, PartView>();
  private partRoot = new THREE.Group();
  private overlayRoot = new THREE.Group();
  private jointRoot = new THREE.Group();
  private dynRoot = new THREE.Group();
  private gridRoot = new THREE.Group();
  private floor: THREE.Mesh;
  private floorGrid: THREE.LineSegments | null = null;
  private keyLight: THREE.DirectionalLight;
  private lastProject: Project | null = null;
  private lastSelection: AppState['selection'] | null = null;
  private lastView: ViewSettings | null = null;
  private lastFocus: AppState['focus'] | undefined = undefined;
  private lastHover: AppState['hover'] | undefined = undefined;
  private lastTool: AppState['tool'] | null = null;
  private lastCamReq = -1;
  private raf = 0;
  private disposed = false;
  private raycaster = new THREE.Raycaster();
  private sectionPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
  private bbox = new THREE.Box3(new THREE.Vector3(-60, -40, -5), new THREE.Vector3(60, 40, 20));
  private jointObjs = new Map<string, { group: THREE.Group; key: string; update: (poseOf: (id: string) => Pose | null) => void }>();
  private traceLines = new Map<string, { line: THREE.Line; count: number; key: string }>();
  private probeMarks = new Map<string, THREE.Sprite>();
  private portPoints: THREE.Points;
  private contactArrows: THREE.ArrowHelper[] = [];
  private interfMarks: THREE.Mesh[] = [];
  private loadArrows = new Map<string, THREE.ArrowHelper>();
  private measureLine: THREE.Line;
  private snapRing: THREE.Mesh;
  measure: { a: THREE.Vector3 | null; b: THREE.Vector3 | null } = { a: null, b: null };
  onFrame: ((info: FrameInfo) => void) | null = null;
  private fpsAvg = 60;
  private lastFrameT = 0;
  private explodeZ = new Map<string, number>();
  private pmrem: THREE.PMREMGenerator;
  private dprCap = 2;
  frameCount = 0;

  constructor(container: HTMLElement) {
    this.container = container;
    const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    this.renderer = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.dprCap));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.92;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.localClippingEnabled = true;
    renderer.setClearColor(0x15171b, 1);
    container.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.outline = 'none';
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute('role', 'application');
    renderer.domElement.setAttribute('aria-label', '3D viewport of the mechanism. Drag to orbit, wheel to zoom; parts and joints are also listed in the Assembly tree.');

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = this.pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
    this.scene.environmentIntensity = 0.55;
    this.scene.background = new THREE.Color(0x15171b);
    this.scene.fog = null;

    this.persp = new THREE.PerspectiveCamera(32, 1, 1, 20000);
    this.ortho = new THREE.OrthographicCamera(-100, 100, 100, -100, -5000, 20000);
    this.persp.position.set(180, 120, 320);
    this.camera = this.persp;
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.controls.mouseButtons = { LEFT: -1 as any, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

    const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x20242c, 0.35);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xfff4e6, 1.9);
    key.position.set(120, 260, 220);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.6;
    key.shadow.radius = 5;
    this.keyLight = key;
    this.scene.add(key, key.target);
    const fill = new THREE.DirectionalLight(0x9db8ff, 0.35);
    fill.position.set(-200, 80, 120);
    this.scene.add(fill);

    // floor / bench
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: 0.92, metalness: 0.0 });
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), floorMat);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);

    this.scene.add(this.gridRoot, this.partRoot, this.jointRoot, this.dynRoot, this.overlayRoot);

    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 2048), 3));
    pg.setDrawRange(0, 0);
    this.portPoints = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0x4cc2ff, size: 9, sizeAttenuation: false, depthTest: false, transparent: true, opacity: 0.9, map: ringTexture(), alphaTest: 0.1 }));
    this.portPoints.renderOrder = 900;
    this.portPoints.frustumCulled = false;
    this.overlayRoot.add(this.portPoints);

    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.measureLine = new THREE.Line(mg, new THREE.LineBasicMaterial({ color: 0xffe08a, depthTest: false, transparent: true }));
    this.measureLine.renderOrder = 950; this.measureLine.visible = false; this.measureLine.frustumCulled = false;
    this.overlayRoot.add(this.measureLine);

    this.snapRing = new THREE.Mesh(new THREE.RingGeometry(0.75, 1, 32), new THREE.MeshBasicMaterial({ color: 0x7ee081, depthTest: false, transparent: true, side: THREE.DoubleSide }));
    this.snapRing.renderOrder = 960; this.snapRing.visible = false;
    this.overlayRoot.add(this.snapRing);

    this.resize();
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(container);
    this.resizeObserver = ro;
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }
  private resizeObserver: ResizeObserver;

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.pmrem.dispose();
    this.renderer.domElement.remove();
  }

  resize(): void {
    const w = Math.max(this.container.clientWidth, 10), h = Math.max(this.container.clientHeight, 10);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.updateOrthoFrustum();
  }

  private updateOrthoFrustum(): void {
    const w = this.container.clientWidth || 10, h = this.container.clientHeight || 10;
    const dist = this.camera.position.distanceTo(this.controls.target);
    const halfH = this.ortho === this.camera ? (this.ortho.top - this.ortho.bottom) / 2 : dist * Math.tan((this.persp.fov * Math.PI) / 360);
    const hh = halfH || 100;
    this.ortho.left = -hh * (w / h); this.ortho.right = hh * (w / h); this.ortho.top = hh; this.ortho.bottom = -hh;
    this.ortho.updateProjectionMatrix();
  }

  /** world millimetres per CSS pixel at the orbit target */
  mmPerPx(): number {
    const h = this.container.clientHeight || 10;
    if (this.camera === this.ortho) return (this.ortho.top - this.ortho.bottom) / this.ortho.zoom / h;
    const dist = this.camera.position.distanceTo(this.controls.target);
    return (2 * dist * Math.tan((this.persp.fov * Math.PI) / 360)) / h;
  }

  setOrtho(on: boolean): void {
    const want = on ? this.ortho : this.persp;
    if (this.camera === want) return;
    const dist = this.camera.position.distanceTo(this.controls.target);
    if (on) {
      const halfH = dist * Math.tan((this.persp.fov * Math.PI) / 360);
      const w = this.container.clientWidth || 10, h = this.container.clientHeight || 10;
      this.ortho.left = -halfH * (w / h); this.ortho.right = halfH * (w / h); this.ortho.top = halfH; this.ortho.bottom = -halfH;
      this.ortho.zoom = 1;
      this.ortho.position.copy(this.persp.position);
      this.ortho.quaternion.copy(this.persp.quaternion);
      this.ortho.updateProjectionMatrix();
    } else {
      const halfH = (this.ortho.top - this.ortho.bottom) / 2 / this.ortho.zoom;
      const d = halfH / Math.tan((this.persp.fov * Math.PI) / 360);
      const dir = _v.copy(this.ortho.position).sub(this.controls.target).normalize();
      this.persp.position.copy(this.controls.target).addScaledVector(dir, d);
      this.persp.quaternion.copy(this.ortho.quaternion);
    }
    this.camera = want;
    this.controls.object = want;
    this.controls.update();
  }

  /** point the camera along a standard direction, keeping the current target and scale */
  standardView(name: 'front' | 'back' | 'top' | 'bottom' | 'left' | 'right' | 'iso'): void {
    const dirs: Record<string, [number, number, number]> = {
      front: [0, 0, 1], back: [0, 0, -1], top: [0, 1, 0.0001], bottom: [0, -1, 0.0001], right: [1, 0, 0], left: [-1, 0, 0], iso: [0.55, 0.42, 0.72],
    };
    const d = new THREE.Vector3(...dirs[name]).normalize();
    const dist = this.camera.position.distanceTo(this.controls.target) || 300;
    this.camera.position.copy(this.controls.target).addScaledVector(d, dist);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }

  fit(margin = 1.25): void {
    const box = this.bbox.clone();
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const r = Math.max(size.length() / 2, 12) * margin;
    const dir = _v.copy(this.camera.position).sub(this.controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0.5, 0.4, 0.8);
    dir.normalize();
    this.controls.target.copy(c);
    const dist = r / Math.sin((this.persp.fov * Math.PI) / 360);
    this.camera.position.copy(c).addScaledVector(dir, dist);
    if (this.camera === this.ortho) {
      const w = this.container.clientWidth || 10, h = this.container.clientHeight || 10;
      // extents of the box corners in the camera's right/up directions
      this.camera.updateMatrixWorld();
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
      let ex = 1, ey = 1;
      for (let i = 0; i < 8; i++) {
        const p = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(c);
        ex = Math.max(ex, Math.abs(p.dot(right))); ey = Math.max(ey, Math.abs(p.dot(up)));
      }
      const hh = Math.max(ey, ex / (w / h)) * margin * 1.08;
      this.ortho.left = -hh * (w / h); this.ortho.right = hh * (w / h); this.ortho.top = hh; this.ortho.bottom = -hh;
      this.ortho.zoom = 1;
      this.ortho.updateProjectionMatrix();
    }
    this.controls.update();
  }

  applyProjectView(project: Project, index = 0): void {
    const v = project.views[index];
    if (!v) { this.standardView('iso'); this.computeBBox(project); this.fit(); return; }
    this.setOrtho(v.ortho);
    this.controls.target.set(...v.target);
    this.camera.position.set(...v.position);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    this.computeBBox(project);
    // keep the stored direction but frame the assembly
    this.fit(v.ortho ? 1.25 : 0.95);
  }

  private computeBBox(project: Project): void {
    const box = new THREE.Box3();
    for (const p of project.parts) {
      if (p.suppressed) continue;
      const g = geometryOf(project, p);
      const c = Math.cos(p.pose.angle), s = Math.sin(p.pose.angle);
      for (const l of g.layers) {
        for (const poly of l.contours) {
          const step = Math.max(1, Math.floor(poly.length / 48));
          for (let i = 0; i < poly.length; i += step) {
            const x = p.pose.x + c * poly[i][0] - s * poly[i][1], y = p.pose.y + s * poly[i][0] + c * poly[i][1];
            box.expandByPoint(_v.set(x, y, p.pose.z + l.z0));
            box.expandByPoint(_v.set(x, y, p.pose.z + l.z1));
          }
        }
      }
    }
    // ground-side anchors (springs, ground pivots) belong to the scene too
    if (!box.isEmpty()) {
      const zc = (box.min.z + box.max.z) / 2;
      for (const j of project.joints) {
        if (j.suppressed) continue;
        if (j.a === GROUND) box.expandByPoint(_v.set(j.anchorA.x ?? 0, j.anchorA.y ?? 0, zc));
        if (j.b === GROUND) box.expandByPoint(_v.set(j.anchorB.x ?? 0, j.anchorB.y ?? 0, zc));
      }
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-60, -40, -5), new THREE.Vector3(60, 40, 20));
    this.bbox = box;
  }

  // ---------------------------------------------------------------- sync with app state

  private sync(): void {
    const s = getState();
    const project = s.project;
    const projectChanged = project !== this.lastProject;
    const viewChanged = s.view !== this.lastView;
    if (projectChanged) {
      this.syncParts(project, s.view);
      this.syncJoints(project);
      this.computeBBox(project);
      this.syncEnvironment(project);
      this.lastProject = project;
    }
    if (viewChanged) {
      this.setOrtho(s.view.ortho);
      this.applyViewSettings(project, s.view, projectChanged);
      this.lastView = s.view;
    } else if (projectChanged) this.applyViewSettings(project, s.view, true);
    if (projectChanged || s.selection !== this.lastSelection || s.focus !== this.lastFocus || s.hover !== this.lastHover) {
      this.applyHighlights(s);
      this.lastSelection = s.selection; this.lastFocus = s.focus; this.lastHover = s.hover;
    }
    if (s.tool !== this.lastTool) {
      this.lastTool = s.tool;
      if (s.tool.kind !== 'measure') { this.measure = { a: null, b: null }; this.measureLine.visible = false; }
    }
    if (s.cameraRequest && s.cameraRequest.n !== this.lastCamReq) {
      this.lastCamReq = s.cameraRequest.n;
      const name = s.cameraRequest.name;
      if (name === 'default') this.applyProjectView(project, 0);
      else if (name === 'fit') { this.computeBBox(project); this.fit(); }
      else if (name.startsWith('view:')) this.applyProjectView(project, parseInt(name.slice(5), 10));
      else this.standardView(name as any);
    }
  }

  private syncParts(project: Project, view: ViewSettings): void {
    const alive = new Set<string>();
    // z levels for exploded view
    const zs = [...new Set(project.parts.filter((p) => !p.suppressed).map((p) => Math.round(p.pose.z * 100) / 100))].sort((a, b) => a - b);
    for (const p of project.parts) {
      if (p.suppressed) continue;
      alive.add(p.id);
      const g = geometryOf(project, p);
      const mat = materialOf(project, p.materialId);
      const styleKey = `${p.color ?? ''}|${mat.id}|${mat.color}|${mat.metalness}|${mat.roughness}`;
      let pv = this.parts.get(p.id);
      if (pv && (pv.geomRef !== g || pv.styleKey !== styleKey)) { this.removePartView(p.id); pv = undefined; }
      if (!pv) pv = this.createPartView(p, g, project, styleKey);
      pv.zLevel = zs.indexOf(Math.round(p.pose.z * 100) / 100);
    }
    for (const id of [...this.parts.keys()]) if (!alive.has(id)) this.removePartView(id);
    void view;
  }

  private createPartView(p: Part, g: PartGeometry, project: Project, styleKey: string): PartView {
    const mat = materialOf(project, p.materialId);
    const base = new THREE.Color(p.color ?? mat.color);
    const group = new THREE.Group();
    group.userData.partId = p.id;
    const pv: PartView = { group, meshes: [], edges: [], caps: [], geomRef: g, styleKey, baseColor: base, zLevel: 0 };
    const set = geometryFor(g);
    for (const it of set.items) {
      const look = LOOKS[it.look];
      const m = new THREE.MeshPhysicalMaterial({
        color: look ? look.color : base,
        metalness: look ? look.metalness : mat.metalness,
        roughness: look ? look.roughness : mat.roughness,
        clearcoat: look || mat.metalness > 0.5 ? 0 : 0.15, clearcoatRoughness: 0.6,
        envMapIntensity: 1.0,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      });
      m.userData.baseColor = (m.color as THREE.Color).clone();
      const mesh = new THREE.Mesh(it.geo, m);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.userData.partId = p.id;
      group.add(mesh);
      pv.meshes.push(mesh);
      const e = new THREE.LineSegments(it.edges, new THREE.LineBasicMaterial({ color: 0x0c0d10, transparent: true, opacity: 0.55 }));
      e.userData.partId = p.id;
      group.add(e);
      pv.edges.push(e);
    }
    this.partRoot.add(group);
    this.parts.set(p.id, pv);
    return pv;
  }

  private removePartView(id: string): void {
    const pv = this.parts.get(id);
    if (!pv) return;
    this.partRoot.remove(pv.group);
    for (const m of pv.meshes) (m.material as THREE.Material).dispose();
    for (const e of pv.edges) (e.material as THREE.Material).dispose();
    for (const c of pv.caps) { this.partRoot.remove(c); c.traverse((o) => { const mm = (o as THREE.Mesh).material as THREE.Material | undefined; mm?.dispose?.(); }); }
    this.parts.delete(id);
  }

  private applyViewSettings(project: Project, view: ViewSettings, rebuildCaps: boolean): void {
    // transparency
    for (const pv of this.parts.values()) {
      for (const m of pv.meshes) {
        const mat = m.material as THREE.MeshPhysicalMaterial;
        mat.transparent = view.transparent;
        mat.opacity = view.transparent ? 0.32 : 1;
        mat.depthWrite = !view.transparent;
        mat.needsUpdate = true;
        m.castShadow = view.shadows && !view.transparent;
      }
    }
    this.renderer.shadowMap.enabled = view.shadows;
    this.keyLight.castShadow = view.shadows;
    this.gridRoot.visible = view.showGrid;
    this.jointRoot.visible = view.showJoints;
    // section plane
    const sec = view.section;
    const n = new THREE.Vector3(sec.axis === 'x' ? 1 : 0, sec.axis === 'y' ? 1 : 0, sec.axis === 'z' ? 1 : 0);
    if (!sec.flip) n.negate();
    const c = this.bbox.getCenter(new THREE.Vector3());
    const size = this.bbox.getSize(new THREE.Vector3());
    const mid = sec.axis === 'x' ? c.x : sec.axis === 'y' ? c.y : c.z;
    const half = (sec.axis === 'x' ? size.x : sec.axis === 'y' ? size.y : size.z) / 2 + 2;
    const pos = mid + sec.offset * half;
    // plane: n·p + constant = 0 ; keep the side n points to
    this.sectionPlane.set(n, -n.dot(new THREE.Vector3(sec.axis === 'x' ? pos : 0, sec.axis === 'y' ? pos : 0, sec.axis === 'z' ? pos : 0)));
    const planes = sec.enabled ? [this.sectionPlane] : [];
    let idx = 0;
    for (const pv of this.parts.values()) {
      idx++;
      for (const m of pv.meshes) { (m.material as THREE.Material).clippingPlanes = planes; (m.material as THREE.Material).needsUpdate = true; }
      for (const e of pv.edges) { (e.material as THREE.Material).clippingPlanes = planes; (e.material as THREE.Material).needsUpdate = true; }
      const need = sec.enabled && !view.transparent;
      if ((!need || rebuildCaps) && pv.caps.length) {
        for (const cObj of pv.caps) { cObj.parent?.remove(cObj); }
        pv.caps = [];
      }
      if (need && pv.caps.length === 0) this.buildCaps(pv, idx);
    }
    for (const j of this.jointObjs.values()) j.group.traverse((o) => { const mm = (o as THREE.Mesh).material as THREE.Material | undefined; if (mm && (o as any).isMesh) { mm.clippingPlanes = planes; mm.needsUpdate = true; } });
    void project;
  }

  /** stencil-based cross-section caps so cut solids look solid */
  private buildCaps(pv: PartView, order: number): void {
    const plane = this.sectionPlane;
    for (const mesh of pv.meshes) {
      const mk = (side: THREE.Side, op: THREE.StencilOp) => {
        const m = new THREE.MeshBasicMaterial({ depthWrite: false, depthTest: false, colorWrite: false, stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, side, clippingPlanes: [plane], stencilFail: op, stencilZFail: op, stencilZPass: op });
        const s = new THREE.Mesh(mesh.geometry, m);
        s.renderOrder = order + 0.1;
        return s;
      };
      const back = mk(THREE.BackSide, THREE.IncrementWrapStencilOp);
      const front = mk(THREE.FrontSide, THREE.DecrementWrapStencilOp);
      pv.group.add(back, front);
      pv.caps.push(back, front);
    }
    const col = pv.baseColor.clone().multiplyScalar(0.55).lerp(new THREE.Color(0xe8a33d), 0.18);
    const capMat = new THREE.MeshStandardMaterial({ color: col, metalness: 0.1, roughness: 0.75, stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc, stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp, side: THREE.DoubleSide });
    const cap = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), capMat);
    cap.renderOrder = order + 0.2;
    cap.onAfterRender = (r) => r.clearStencil();
    cap.userData.isCap = true;
    this.partRoot.add(cap);
    pv.caps.push(cap);
  }

  private positionCaps(): void {
    const plane = this.sectionPlane;
    for (const pv of this.parts.values()) {
      for (const c of pv.caps) {
        if (!c.userData.isCap) continue;
        plane.coplanarPoint(c.position);
        c.lookAt(c.position.x - plane.normal.x, c.position.y - plane.normal.y, c.position.z - plane.normal.z);
      }
    }
  }

  private applyHighlights(s: AppState): void {
    const sel = new Set(s.selection.parts);
    const foc = new Set(s.focus?.parts ?? []);
    const hov = s.hover?.part;
    const runner = simCtl.runner;
    const interf = new Set<string>();
    if (runner) for (const i of runner.interferenceNow) { interf.add(i.a); interf.add(i.b); }
    for (const [id, pv] of this.parts) {
      const isSel = sel.has(id), isFoc = foc.has(id), isHov = hov === id, isInt = interf.has(id);
      for (const m of pv.meshes) {
        const mat = m.material as THREE.MeshPhysicalMaterial;
        if (isInt || isFoc) mat.emissive.setHex(isInt ? 0xb3261e : 0xb8741a);
        else if (isSel) mat.emissive.setHex(0x1f6fd0);
        else if (isHov) mat.emissive.setHex(0x1a3a66);
        else mat.emissive.setHex(0x000000);
        mat.emissiveIntensity = isInt || isFoc ? 0.6 : isSel ? 0.22 : isHov ? 0.14 : 0;
      }
      for (const e of pv.edges) {
        const mat = e.material as THREE.LineBasicMaterial;
        mat.color.setHex(isSel ? 0x7fc0ff : isFoc || isInt ? 0xffb347 : 0x0c0d10);
        mat.opacity = isSel || isFoc || isInt ? 1 : 0.55;
      }
    }
    const selJ = new Set(s.selection.joints), focJ = new Set(s.focus?.joints ?? []);
    for (const [id, jo] of this.jointObjs) {
      const col = focJ.has(id) ? 0xff6b5e : selJ.has(id) ? 0x7fc0ff : s.hover?.joint === id ? 0xffffff : null;
      jo.group.traverse((o) => {
        const mat = (o as any).material as THREE.LineBasicMaterial | undefined;
        if (!mat || !mat.color || (o as any).userData.fixedColor) return;
        if (mat.userData.base === undefined) mat.userData.base = mat.color.getHex();
        mat.color.setHex(col ?? mat.userData.base);
      });
    }
  }

  private syncEnvironment(project: Project): void {
    // back grid on the mechanism plane + bench/floor
    this.gridRoot.clear();
    const box = this.bbox;
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const half = Math.max(200, Math.ceil((Math.max(size.x, size.y) * 1.6) / 100) * 100);
    const cx = Math.round(c.x / 50) * 50, cy = Math.round(c.y / 50) * 50;
    const zBack = box.min.z - 0.6;
    const mkGrid = (step: number, color: number, opacity: number) => {
      const pts: number[] = [];
      for (let v = -half; v <= half + 1e-6; v += step) {
        pts.push(cx - half, cy + v, zBack, cx + half, cy + v, zBack, cx + v, cy - half, zBack, cx + v, cy + half, zBack);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
    };
    this.gridRoot.add(mkGrid(10, 0x8a93a3, 0.07), mkGrid(50, 0x8a93a3, 0.16));
    // world axes at the origin
    const ax = new THREE.BufferGeometry();
    ax.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, zBack, 40, 0, zBack, 0, 0, zBack, 0, 40, zBack], 3));
    ax.setAttribute('color', new THREE.Float32BufferAttribute([0.95, 0.35, 0.3, 0.95, 0.35, 0.3, 0.4, 0.85, 0.45, 0.4, 0.85, 0.45], 3));
    this.gridRoot.add(new THREE.LineSegments(ax, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 })));

    const floorOn = project.sim.floor.enabled;
    const y = floorOn ? project.sim.floor.y : box.min.y - Math.max(12, size.y * 0.12);
    const ext = Math.max(4000, half * 8);
    this.floor.scale.set(ext, ext, 1);
    this.floor.position.set(cx, y, c.z);
    (this.floor.material as THREE.MeshStandardMaterial).color.setHex(floorOn ? 0x2b2f36 : 0x1b1d21);
    if (this.floorGrid) { this.scene.remove(this.floorGrid); this.floorGrid.geometry.dispose(); this.floorGrid = null; }
    if (floorOn) {
      // 50 mm floor grid so travel is readable
      const pts: number[] = [];
      const L = 3000, zc = Math.round(c.z / 50) * 50;
      for (let v = -L; v <= L; v += 50) {
        pts.push(cx + v, y + 0.05, zc - 400, cx + v, y + 0.05, zc + 400);
      }
      for (let v = -400; v <= 400; v += 50) pts.push(cx - L, y + 0.05, zc + v, cx + L, y + 0.05, zc + v);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      this.floorGrid = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x9aa3b2, transparent: true, opacity: 0.2 }));
      this.scene.add(this.floorGrid);
    }
    // shadow frustum
    const r = Math.max(size.length() * 0.75, 120);
    const cam = this.keyLight.shadow.camera;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r; cam.near = 1; cam.far = r * 6;
    cam.updateProjectionMatrix();
    this.shadowRadius = r;
  }
  private shadowRadius = 200;

  // ---------------------------------------------------------------- joints / hardware overlays

  private syncJoints(project: Project): void {
    const alive = new Set<string>();
    for (const j of project.joints) {
      if (j.suppressed) continue;
      const a = j.a === GROUND ? null : project.parts.find((p) => p.id === j.a);
      const b = j.b === GROUND ? null : project.parts.find((p) => p.id === j.b);
      if ((j.a !== GROUND && (!a || a.suppressed)) || (j.b !== GROUND && (!b || b.suppressed))) continue;
      alive.add(j.id);
      const key = JSON.stringify(j) + (a ? `${a.pose.z}|${geometryOf(project, a).zMax}` : '') + (b ? `${b.pose.z}|${geometryOf(project, b).zMax}` : '') + (a?.params === undefined ? '' : '') ;
      const geomKey = `${key}#${a ? idOf(geometryOf(project, a)) : 0}#${b ? idOf(geometryOf(project, b)) : 0}`;
      const cur = this.jointObjs.get(j.id);
      if (cur && cur.key === geomKey) continue;
      if (cur) this.jointRoot.remove(cur.group);
      const made = this.makeJointObject(project, j, a ?? null, b ?? null);
      this.jointRoot.add(made.group);
      this.jointObjs.set(j.id, { ...made, key: geomKey });
    }
    for (const [id, jo] of this.jointObjs) if (!alive.has(id)) { this.jointRoot.remove(jo.group); this.jointObjs.delete(id); }
    // loads
    for (const [id, arrow] of this.loadArrows) { this.overlayRoot.remove(arrow); this.loadArrows.delete(id); }
    for (const l of project.loads) {
      if (!l.enabled) continue;
      const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 20, 0xff7b72, 5, 3);
      (arrow.line.material as THREE.Material).depthTest = false; (arrow.cone.material as THREE.Material).depthTest = false;
      arrow.renderOrder = 800;
      arrow.userData.loadId = l.id;
      this.overlayRoot.add(arrow);
      this.loadArrows.set(l.id, arrow);
    }
    // probe markers
    for (const [id, sp] of this.probeMarks) { this.overlayRoot.remove(sp); this.probeMarks.delete(id); }
    for (const pr of project.probes) {
      if (pr.target.kind !== 'point') continue;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture(pr.color), depthTest: false, sizeAttenuation: false, transparent: true }));
      sp.scale.set(0.022, 0.022, 1);
      sp.renderOrder = 990;
      sp.userData.probeId = pr.id;
      this.overlayRoot.add(sp);
      this.probeMarks.set(pr.id, sp);
    }
  }

  private makeJointObject(project: Project, j: Joint, a: Part | null, b: Part | null): { group: THREE.Group; update: (poseOf: (id: string) => Pose | null) => void } {
    const group = new THREE.Group();
    group.userData.jointId = j.id;
    const zOf = (p: Part | null) => (p ? { z0: p.pose.z + geometryOf(project, p).zMin, z1: p.pose.z + geometryOf(project, p).zMax } : null);
    const za = zOf(a), zb = zOf(b);
    const z0 = Math.min(za?.z0 ?? zb!.z0, zb?.z0 ?? za!.z0), z1 = Math.max(za?.z1 ?? zb!.z1, zb?.z1 ?? za!.z1);
    const la = anchorLocal(project, j.a, j.anchorA), lb = anchorLocal(project, j.b, j.anchorB);
    const worldA = (poseOf: (id: string) => Pose | null) => { if (!a) return { x: la.x, y: la.y }; const p = poseOf(a.id) ?? a.pose; return localToWorld(p, la.x, la.y); };
    const worldB = (poseOf: (id: string) => Pose | null) => { if (!b) return { x: lb.x, y: lb.y }; const p = poseOf(b.id) ?? b.pose; return localToWorld(p, lb.x, lb.y); };
    const lineMat = (color: number) => new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
    const circlePts = (r: number, n = 40, a0 = 0, a1 = Math.PI * 2) => { const pts: THREE.Vector3[] = []; for (let i = 0; i <= n; i++) { const t = a0 + ((a1 - a0) * i) / n; pts.push(new THREE.Vector3(r * Math.cos(t), r * Math.sin(t), 0)); } return pts; };
    const explodeOf = (id: string | undefined) => (id ? this.explodeZ.get(id) ?? 0 : 0);

    if (j.type === 'revolute') {
      const d = j.pinDiameter ?? la.port?.d ?? lb.port?.d ?? 3;
      const r = Math.max(d / 2 - 0.02, 0.4);
      // physical pin (hardware) through both parts
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, 20), new THREE.MeshPhysicalMaterial({ color: 0xc7ccd4, metalness: 1, roughness: 0.25 }));
      pin.rotation.x = Math.PI / 2;
      pin.castShadow = true;
      const head = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.55, r * 1.55, 0.8, 20), pin.material);
      head.rotation.x = Math.PI / 2;
      // axis + rotation symbol
      const axis = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, -6), new THREE.Vector3(0, 0, 6)]), new THREE.LineDashedMaterial({ color: 0x4cc2ff, dashSize: 2, gapSize: 1.5, depthTest: false, transparent: true }));
      axis.computeLineDistances();
      const ringR = Math.max(r * 2.4, 3.2);
      const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(circlePts(ringR, 40, 0.5, Math.PI * 2 - 0.5)), lineMat(j.motor?.enabled ? 0xf2b44a : 0x4cc2ff));
      const arrowHead = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(ringR * Math.cos(-0.5) - 1.1, ringR * Math.sin(-0.5) - 1.3, 0), new THREE.Vector3(ringR * Math.cos(-0.5), ringR * Math.sin(-0.5), 0), new THREE.Vector3(ringR * Math.cos(-0.5) + 1.5, ringR * Math.sin(-0.5) - 0.9, 0),
      ]), ring.material);
      const glyph = new THREE.Group();
      glyph.add(axis, ring, arrowHead);
      if (j.motor?.enabled) { const sp = makeLabelSprite('M'); sp.position.set(ringR + 3, ringR + 3, 0); glyph.add(sp); }
      if (j.limits?.enabled) {
        const lim = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), ...circlePts(ringR * 1.5, 24, j.limits.lower, j.limits.upper), new THREE.Vector3(0, 0, 0)]), lineMat(0xff7b72));
        lim.userData.limit = true;
        glyph.add(lim);
      }
      glyph.traverse((o) => { o.renderOrder = 700; });
      group.add(pin, head, glyph);
      const update = (poseOf: (id: string) => Pose | null) => {
        const w = worldA(poseOf);
        const ea = a ? explodeOf(a.id) : explodeOf(b?.id), eb = b ? explodeOf(b.id) : ea;
        const zz0 = Math.min((za?.z0 ?? zb!.z0) + ea, (zb?.z0 ?? za!.z0) + eb), zz1 = Math.max((za?.z1 ?? zb!.z1) + ea, (zb?.z1 ?? za!.z1) + eb);
        pin.position.set(w.x, w.y, (zz0 + zz1) / 2);
        pin.scale.set(1, zz1 - zz0 + 1.2, 1);
        head.position.set(w.x, w.y, zz1 + 0.9);
        glyph.position.set(w.x, w.y, zz1 + 1.6);
        const lim = glyph.children.find((c) => c.userData.limit);
        if (lim) { const pa = a ? (poseOf(a.id) ?? a.pose) : { angle: 0 }; const pb = b ? (poseOf(b.id) ?? b.pose) : { angle: 0 }; const des = (b?.pose.angle ?? 0) - (a?.pose.angle ?? 0); lim.rotation.z = pb.angle - ((pb.angle - pa.angle) - des) ; }
      };
      return { group, update };
    }
    if (j.type === 'prismatic') {
      const axisLocal = j.axisAngle ?? la.port?.axis ?? 0;
      const len = 26;
      const mk = lineMat(j.motor?.enabled ? 0xf2b44a : 0x62c370);
      const body = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-len, 0, 0), new THREE.Vector3(len, 0, 0)]), mk);
      const h1 = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(len - 4, 2.2, 0), new THREE.Vector3(len, 0, 0), new THREE.Vector3(len - 4, -2.2, 0)]), mk);
      const h2 = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-len + 4, 2.2, 0), new THREE.Vector3(-len, 0, 0), new THREE.Vector3(-len + 4, -2.2, 0)]), mk);
      const glyph = new THREE.Group();
      glyph.add(body, h1, h2);
      if (j.limits?.enabled) {
        for (const v of [j.limits.lower, j.limits.upper]) {
          const tick = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(v, -4, 0), new THREE.Vector3(v, 4, 0)]), lineMat(0xff7b72));
          tick.userData.limitTick = true;
          glyph.add(tick);
        }
      }
      glyph.traverse((o) => { o.renderOrder = 700; });
      group.add(glyph);
      const design = (() => { const wa = a ? localToWorld(a.pose, la.x, la.y) : la; const wb = b ? localToWorld(b.pose, lb.x, lb.y) : lb; const ang = axisLocal + (a?.pose.angle ?? 0); return Math.cos(ang) * (wb.x - wa.x) + Math.sin(ang) * (wb.y - wa.y); })();
      const update = (poseOf: (id: string) => Pose | null) => {
        const w = worldB(poseOf);
        const wa = worldA(poseOf);
        const pa = a ? (poseOf(a.id) ?? a.pose) : { angle: 0 };
        const e = Math.max(explodeOf(a?.id), explodeOf(b?.id));
        glyph.position.set(w.x, w.y, z1 + e + 1.2);
        glyph.rotation.z = axisLocal + pa.angle;
        // limit ticks are drawn in the axis frame relative to the design position of B
        const ang = axisLocal + pa.angle;
        const s = Math.cos(ang) * (w.x - wa.x) + Math.sin(ang) * (w.y - wa.y);
        for (const cObj of glyph.children) if (cObj.userData.limitTick) cObj.position.x = -(s - design);
      };
      return { group, update };
    }
    if (j.type === 'rigid') {
      const s = 2.2;
      const sq = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-s, -s, 0), new THREE.Vector3(s, -s, 0), new THREE.Vector3(s, s, 0), new THREE.Vector3(-s, s, 0), new THREE.Vector3(-s, -s, 0), new THREE.Vector3(s, s, 0)]), lineMat(0xb0b7c3));
      sq.renderOrder = 700;
      group.add(sq);
      return { group, update: (poseOf) => { const w = worldA(poseOf); const e = Math.max(explodeOf(a?.id), explodeOf(b?.id)); sq.position.set(w.x, w.y, z1 + e + 1.0); } };
    }
    if (j.type === 'gear' || j.type === 'rackPinion') {
      const ga = a ? geometryOf(project, a) : null, gb = b ? geometryOf(project, b) : null;
      const mat = new THREE.LineDashedMaterial({ color: 0xc792ea, dashSize: 2.2, gapSize: 1.6, depthTest: false, transparent: true, opacity: 0.9 });
      const ca = new THREE.Line(new THREE.BufferGeometry().setFromPoints(circlePts(ga?.pitchRadius || 1, 96)), mat);
      ca.computeLineDistances();
      const second = j.type === 'gear'
        ? new THREE.Line(new THREE.BufferGeometry().setFromPoints(circlePts(gb?.pitchRadius || 1, 96)), mat)
        : new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3((b?.params.teeth ?? 10) * Math.PI * (b?.params.module ?? 1), 0, 0)]), mat);
      second.computeLineDistances();
      const pitchPt = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 8), new THREE.MeshBasicMaterial({ color: 0xc792ea, depthTest: false }));
      for (const o of [ca, second, pitchPt]) o.renderOrder = 700;
      group.add(ca, second, pitchPt);
      return {
        group, update: (poseOf) => {
          const pa = a ? (poseOf(a.id) ?? a.pose) : null, pb = b ? (poseOf(b.id) ?? b.pose) : null;
          if (!pa || !pb) return;
          const e = Math.max(explodeOf(a?.id), explodeOf(b?.id));
          const zz = z1 + e + 0.8;
          ca.position.set(pa.x, pa.y, zz);
          second.position.set(pb.x, pb.y, zz);
          if (j.type === 'gear') {
            const ra = ga?.pitchRadius ?? 0, rb = gb?.pitchRadius ?? 0;
            const dx = pb.x - pa.x, dy = pb.y - pa.y, d = Math.hypot(dx, dy) || 1;
            pitchPt.position.set(pa.x + (dx / d) * ra, pa.y + (dy / d) * ra, zz);
            void rb;
          } else {
            second.rotation.z = pb.angle;
            const nx = -Math.sin(pb.angle), ny = Math.cos(pb.angle);
            const side = nx * (pa.x - pb.x) + ny * (pa.y - pb.y);
            pitchPt.position.set(pa.x - nx * side, pa.y - ny * side, zz);
          }
        },
      };
    }
    if (j.type === 'belt') return this.makeBelt(project, j, a, b, group);
    if (j.type === 'spring') return this.makeSpring(j, group, worldA, worldB, z0, z1, a, b);
    if (j.type === 'cam') {
      const ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]), lineMat(0xff9e64));
      ln.renderOrder = 700; ln.frustumCulled = false;
      group.add(ln);
      return {
        group, update: (poseOf) => {
          const w = worldB(poseOf);
          const pa = a ? (poseOf(a.id) ?? a.pose) : null;
          if (!pa) return;
          const pos = ln.geometry.getAttribute('position') as THREE.BufferAttribute;
          const zz = z1 + Math.max(explodeOf(a?.id), explodeOf(b?.id)) + 0.8;
          pos.setXYZ(0, pa.x, pa.y, zz); pos.setXYZ(1, w.x, w.y, zz); pos.needsUpdate = true;
        },
      };
    }
    return { group, update: () => {} };
  }

  private makeBelt(project: Project, j: Joint, a: Part | null, b: Part | null, group: THREE.Group) {
    const ga = a ? geometryOf(project, a) : null, gb = b ? geometryOf(project, b) : null;
    const ra = ga?.pitchRadius ?? 10, rb = gb?.pitchRadius ?? 10;
    const width = j.beltWidth ?? a?.params.beltWidth ?? 6, thick = j.beltThickness ?? a?.params.beltThickness ?? 1.5;
    const mat = new THREE.MeshPhysicalMaterial({ color: 0x17181b, roughness: 0.9, metalness: 0 });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    mesh.castShadow = true;
    const nMarks = 28;
    const marks = new THREE.InstancedMesh(new THREE.BoxGeometry(1.1, thick + 0.5, width * 0.86), new THREE.MeshPhysicalMaterial({ color: 0x3b3e45, roughness: 0.8 }), nMarks);
    group.add(mesh, marks);
    let lastKey = '';
    let path: { pts: [number, number][]; len: number[]; total: number } = { pts: [], len: [], total: 1 };
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1), ps = new THREE.Vector3();
    const zMid = (p: Part | null, g: PartGeometry | null) => (p && g ? p.pose.z + (g.zMin + g.zMax) / 2 : 0);
    const update = (poseOf: (id: string) => Pose | null) => {
      const pa = a ? (poseOf(a.id) ?? a.pose) : null, pb = b ? (poseOf(b.id) ?? b.pose) : null;
      if (!pa || !pb) return;
      const dx = pb.x - pa.x, dy = pb.y - pa.y;
      const C = Math.hypot(dx, dy);
      const key = `${C.toFixed(3)}|${ra}|${rb}|${j.crossed ? 1 : 0}`;
      if (key !== lastKey) {
        lastKey = key;
        path = beltPath(C, ra, rb, !!j.crossed);
        mesh.geometry.dispose();
        mesh.geometry = beltGeometry(path.pts, thick, width);
      }
      const ang = Math.atan2(dy, dx);
      const e = Math.max(this.explodeZ.get(a?.id ?? '') ?? 0, this.explodeZ.get(b?.id ?? '') ?? 0);
      const z = (zMid(a, ga) + zMid(b, gb)) / 2 + e;
      mesh.position.set(pa.x, pa.y, z);
      mesh.rotation.z = ang;
      // cleats travel with the belt: surface travel = ra·(rotation of pulley A relative to the centre line)
      const travel = ra * (pa.angle - (a?.pose.angle ?? 0) - (ang - Math.atan2((b?.pose.y ?? 0) - (a?.pose.y ?? 0), (b?.pose.x ?? 0) - (a?.pose.x ?? 0))));
      const c = Math.cos(ang), s = Math.sin(ang);
      for (let i = 0; i < nMarks; i++) {
        let d = ((i / nMarks) * path.total + travel) % path.total;
        if (d < 0) d += path.total;
        // locate on path
        let k = 0;
        while (k < path.len.length - 2 && path.len[k + 1] < d) k++;
        const t = (d - path.len[k]) / Math.max(path.len[k + 1] - path.len[k], 1e-9);
        const p0 = path.pts[k], p1 = path.pts[(k + 1) % path.pts.length];
        const lx = p0[0] + (p1[0] - p0[0]) * t, ly = p0[1] + (p1[1] - p0[1]) * t;
        const ta = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
        ps.set(pa.x + c * lx - s * ly, pa.y + s * lx + c * ly, z);
        q.setFromAxisAngle(UP_Z, ta + ang);
        m4.compose(ps, q, sc);
        marks.setMatrixAt(i, m4);
      }
      marks.instanceMatrix.needsUpdate = true;
    };
    return { group, update };
  }

  private makeSpring(j: Joint, group: THREE.Group, worldA: (f: (id: string) => Pose | null) => { x: number; y: number }, worldB: (f: (id: string) => Pose | null) => { x: number; y: number }, z0: number, z1: number, a: Part | null, b: Part | null) {
    const coils = j.coils ?? 8, R = (j.coilDiameter ?? 8) / 2, wire = (j.wireDiameter ?? 0.8) / 2;
    const mat = new THREE.MeshPhysicalMaterial({ color: 0xbfc5ce, metalness: 1, roughness: 0.3 });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    mesh.castShadow = true;
    group.add(mesh);
    let lastL = -1;
    const zc = (z0 + z1) / 2;
    const update = (poseOf: (id: string) => Pose | null) => {
      const wa = worldA(poseOf), wb = worldB(poseOf);
      const dx = wb.x - wa.x, dy = wb.y - wa.y;
      const L = Math.max(Math.hypot(dx, dy), 0.5);
      if (Math.abs(L - lastL) > 0.02) {
        lastL = L;
        const pts: THREE.Vector3[] = [];
        const n = coils * 14;
        const lead = Math.min(2.5, L * 0.08);
        pts.push(new THREE.Vector3(0, 0, 0));
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          const ang = t * coils * Math.PI * 2;
          pts.push(new THREE.Vector3(lead + t * (L - 2 * lead), R * Math.sin(ang), R * Math.cos(ang) - R));
        }
        pts.push(new THREE.Vector3(L, 0, 0));
        mesh.geometry.dispose();
        mesh.geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.1), n + 2, wire, 6, false);
      }
      const e = Math.max(this.explodeZ.get(a?.id ?? '') ?? 0, this.explodeZ.get(b?.id ?? '') ?? 0);
      mesh.position.set(wa.x, wa.y, zc + R + e);
      mesh.rotation.z = Math.atan2(dy, dx);
    };
    return { group, update };
  }

  // ---------------------------------------------------------------- per-frame update

  private currentPoseFn(): (id: string) => Pose | null {
    const s = getState();
    const runner = simCtl.runner;
    if (runner && runner.sim.stepCount > 0 && runner.project === s.project) return runner.poseOf;
    const map = new Map(s.project.parts.map((p) => [p.id, p.pose] as const));
    return (id) => map.get(id) ?? null;
  }

  private loop(now: number): void {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const t0 = performance.now();
    simCtl.frame(now);
    this.sync();
    this.updateFrame();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    const ms = performance.now() - t0;
    simCtl.frameMs += (ms - simCtl.frameMs) * 0.05;
    simCtl.frameMsMax = Math.max(simCtl.frameMsMax * 0.995, ms);
    if (this.lastFrameT) { const fps = 1000 / Math.max(now - this.lastFrameT, 1); this.fpsAvg += (fps - this.fpsAvg) * 0.05; }
    this.lastFrameT = now;
    simCtl.fps = this.fpsAvg;
    this.frameCount++;
    this.onFrame?.({ mmPerPx: this.mmPerPx(), camQuat: this.camera.quaternion, fps: this.fpsAvg });
  }

  private updateFrame(): void {
    const s = getState();
    const project = s.project;
    const poseOf = this.currentPoseFn();
    const runner = simCtl.runner && simCtl.runner.project === project ? simCtl.runner : null;
    const explode = s.view.explode;
    const spacing = 14 * explode;
    // parts
    for (const p of project.parts) {
      const pv = this.parts.get(p.id);
      if (!pv) continue;
      const pose = poseOf(p.id) ?? p.pose;
      const ez = spacing * pv.zLevel;
      this.explodeZ.set(p.id, ez);
      pv.group.position.set(pose.x, pose.y, p.pose.z + ez);
      pv.group.rotation.z = pose.angle;
    }
    if (s.view.section.enabled) this.positionCaps();
    for (const jo of this.jointObjs.values()) jo.update(poseOf);
    // follow camera target for free-body runs: keep light + floor centred on the machine
    let cx = this.bbox.getCenter(_v).x;
    if (runner && runner.model.floorEnabled && runner.walk.refPart) {
      const pp = poseOf(runner.walk.refPart);
      const dp = project.parts.find((x) => x.id === runner.walk.refPart);
      if (pp && dp) cx += pp.x - dp.pose.x;
    }
    // follow camera: keep a free-body machine in view by translating camera and target with it
    const refX = cx - this.bbox.getCenter(_v).x;
    if (s.view.follow && runner && runner.model.floorEnabled && runner.sim.stepCount > 0) {
      const d = refX - this.followX;
      if (Math.abs(d) > 1e-9) { this.camera.position.x += d; this.controls.target.x += d; }
    }
    this.followX = runner && runner.sim.stepCount > 0 ? refX : 0;
    const c = this.bbox.getCenter(_v2);
    this.keyLight.target.position.set(cx, c.y, c.z);
    this.keyLight.position.set(cx + this.shadowRadius * 0.55, c.y + this.shadowRadius * 1.6, c.z + this.shadowRadius * 1.25);
    this.keyLight.target.updateMatrixWorld();
    this.floor.position.x = Math.round(cx / 50) * 50;
    if (this.floorGrid) this.floorGrid.position.x = Math.round((cx - this.bbox.getCenter(_v).x) / 50) * 50;

    // port markers when a tool needs anchors
    const showPorts = s.tool.kind !== 'select' || this.dragging;
    const pos = this.portPoints.geometry.getAttribute('position') as THREE.BufferAttribute;
    let n = 0;
    if (showPorts) {
      for (const p of project.parts) {
        if (p.suppressed) continue;
        const g = geometryOf(project, p);
        const pose = poseOf(p.id) ?? p.pose;
        const ez = this.explodeZ.get(p.id) ?? 0;
        for (const port of g.ports) {
          if (n >= 2048) break;
          const w = localToWorld(pose, port.x, port.y);
          pos.setXYZ(n++, w.x, w.y, p.pose.z + g.zMax + ez + 0.3);
        }
      }
      pos.needsUpdate = true;
    }
    this.portPoints.geometry.setDrawRange(0, n);

    // loads
    for (const l of project.loads) {
      const arrow = this.loadArrows.get(l.id);
      if (!arrow) continue;
      const part = project.parts.find((p) => p.id === l.part);
      if (!part) { arrow.visible = false; continue; }
      const pose = poseOf(part.id) ?? part.pose;
      const la = anchorLocal(project, l.part, l.anchor);
      const w = localToWorld(pose, la.x, la.y);
      const g = geometryOf(project, part);
      const z = part.pose.z + g.zMax + (this.explodeZ.get(part.id) ?? 0) + 1.5;
      if (l.type === 'force') {
        let fx = l.fx, fy = l.fy;
        if (l.frame === 'part') { const cc = Math.cos(pose.angle), ss = Math.sin(pose.angle); fx = cc * l.fx - ss * l.fy; fy = ss * l.fx + cc * l.fy; }
        const mag = Math.hypot(fx, fy);
        if (mag < 1e-9) { arrow.visible = false; continue; }
        const len = 14 + 10 * Math.log10(1 + mag / 100);
        arrow.visible = s.view.showForces;
        arrow.setDirection(_v.set(fx / mag, fy / mag, 0));
        arrow.setLength(len, 5, 3);
        arrow.position.set(w.x - (fx / mag) * len, w.y - (fy / mag) * len, z);
      } else {
        arrow.visible = s.view.showForces;
        arrow.setDirection(_v.set(0, 0, l.torque >= 0 ? 1 : -1));
        arrow.setLength(16, 5, 3);
        arrow.position.set(w.x, w.y, z);
      }
      arrow.setColor(s.selection.loads.includes(l.id) ? 0xffffff : 0xff7b72);
    }

    // probes + traces
    for (const pr of project.probes) {
      const sp = this.probeMarks.get(pr.id);
      if (pr.target.kind !== 'point' || !sp) continue;
      const part = project.parts.find((p) => p.id === (pr.target as any).part);
      if (!part) { sp.visible = false; continue; }
      const pose = poseOf(part.id) ?? part.pose;
      const la = anchorLocal(project, part.id, pr.target.anchor);
      const w = localToWorld(pose, la.x, la.y);
      const g = geometryOf(project, part);
      const z = part.pose.z + g.zMax + (this.explodeZ.get(part.id) ?? 0) + 0.6;
      sp.visible = true;
      sp.position.set(w.x, w.y, z);
      const sel = s.selection.probes.includes(pr.id);
      sp.scale.setScalar(sel ? 0.03 : 0.022);
      // trace
      let tl = this.traceLines.get(pr.id);
      const wantTrace = pr.trace && s.view.showTraces && runner && runner.n > 1;
      if (!wantTrace) { if (tl) tl.line.visible = false; continue; }
      const key = `${runner!.model === (tl as any)?.model ? 1 : 0}|${la.x}|${la.y}|${pr.color}`;
      if (!tl) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 4096), 3));
        const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: pr.color, depthTest: false, transparent: true, opacity: 0.95 }));
        line.renderOrder = 850; line.frustumCulled = false;
        this.overlayRoot.add(line);
        tl = { line, count: 0, key: '' };
        this.traceLines.set(pr.id, tl);
      }
      tl.line.visible = true;
      (tl.line.material as THREE.LineBasicMaterial).color.set(pr.color);
      const rKey = `${key}|${runner!.sampleEvery}`;
      if (tl.key !== rKey || (tl as any).runner !== runner || tl.count > runner!.n) { tl.count = 0; tl.key = rKey; (tl as any).runner = runner; }
      if (tl.count < runner!.n) {
        let attr = tl.line.geometry.getAttribute('position') as THREE.BufferAttribute;
        if (attr.count < runner!.n) {
          const cap = Math.max(runner!.n * 2, 4096);
          const arr = new Float32Array(cap * 3);
          arr.set((attr.array as Float32Array).subarray(0, tl.count * 3));
          attr = new THREE.BufferAttribute(arr, 3);
          tl.line.geometry.setAttribute('position', attr);
        }
        const pts = runner!.tracePoint(part.id, la.x, la.y, tl.count);
        for (let i = 0; i < pts.length / 2; i++) attr.setXYZ(tl.count + i, pts[2 * i], pts[2 * i + 1], z);
        tl.count = runner!.n;
        attr.needsUpdate = true;
        tl.line.geometry.setDrawRange(0, tl.count);
      }
    }
    for (const [id, tl] of this.traceLines) if (!project.probes.some((p) => p.id === id)) { this.overlayRoot.remove(tl.line); this.traceLines.delete(id); }

    // floor contact forces
    let ci = 0;
    if (runner && s.view.showForces && runner.model.floorEnabled) {
      const zc = this.bbox.getCenter(_v).z;
      for (const c of runner.sim.contacts) {
        if (c.fn <= 0) continue;
        const f = Math.hypot(c.fn, c.ft);
        let arrow = this.contactArrows[ci];
        if (!arrow) {
          arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 10, 0x7ee081, 4, 2.4);
          (arrow.line.material as THREE.Material).depthTest = false; (arrow.cone.material as THREE.Material).depthTest = false;
          arrow.renderOrder = 820;
          this.dynRoot.add(arrow);
          this.contactArrows[ci] = arrow;
        }
        const partZ = project.parts.find((p) => p.id === c.partId)?.pose.z ?? zc;
        arrow.visible = true;
        arrow.position.set(c.x, c.y, partZ + 1.5);
        arrow.setDirection(_v.set(c.ft / f, c.fn / f, 0));
        arrow.setLength(8 + 14 * Math.log10(1 + f / 100), 4, 2.4);
        arrow.setColor(Math.abs(c.slipSpeed) > 2 ? 0xff7b72 : 0x7ee081);
        ci++;
      }
    }
    for (let i = ci; i < this.contactArrows.length; i++) this.contactArrows[i].visible = false;

    // interference markers
    let ii = 0;
    if (runner) {
      for (const it of runner.interferenceNow) {
        let m = this.interfMarks[ii];
        if (!m) {
          m = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff4d3d, transparent: true, opacity: 0.55, depthTest: false }));
          m.renderOrder = 870;
          this.dynRoot.add(m);
          this.interfMarks[ii] = m;
        }
        const pa = project.parts.find((p) => p.id === it.a);
        m.visible = true;
        m.position.set(it.x, it.y, (pa?.pose.z ?? 0) + 3);
        m.scale.setScalar(Math.max(3, Math.sqrt(Math.max(it.area, 1)) * 0.9) * (1 + 0.12 * Math.sin(performance.now() / 160)));
        ii++;
      }
      if (runner.interferenceNow.length !== this.lastInterfCount) { this.lastInterfCount = runner.interferenceNow.length; this.applyHighlights(s); }
    } else if (this.lastInterfCount !== 0) { this.lastInterfCount = 0; this.applyHighlights(s); }
    for (let i = ii; i < this.interfMarks.length; i++) this.interfMarks[i].visible = false;

    // measurement line
    if (this.measure.a && this.measure.b) {
      const attr = this.measureLine.geometry.getAttribute('position') as THREE.BufferAttribute;
      attr.setXYZ(0, this.measure.a.x, this.measure.a.y, this.measure.a.z);
      attr.setXYZ(1, this.measure.b.x, this.measure.b.y, this.measure.b.z);
      attr.needsUpdate = true;
      this.measureLine.visible = true;
    }
  }
  private lastInterfCount = 0;
  private followX = 0;
  dragging = false;

  // ---------------------------------------------------------------- picking

  private ndc(clientX: number, clientY: number): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  }

  /** world point where the cursor ray meets the plane z = planeZ */
  planePoint(clientX: number, clientY: number, planeZ: number): THREE.Vector3 | null {
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const pl = new THREE.Plane(new THREE.Vector3(0, 0, 1), -planeZ);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(pl, out) ? out : null;
  }

  toScreen(v: THREE.Vector3): { x: number; y: number; visible: boolean } {
    const p = v.clone().project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: ((p.x + 1) / 2) * r.width, y: ((1 - p.y) / 2) * r.height, visible: p.z < 1 };
  }

  pick(clientX: number, clientY: number, opts: { ports?: boolean; excludePart?: string } = {}): PickResult {
    const s = getState();
    const project = s.project;
    const poseOf = this.currentPoseFn();
    const rect = this.renderer.domElement.getBoundingClientRect();
    const mx = clientX - rect.left, my = clientY - rect.top;
    const res: PickResult = { partId: null, world: { x: 0, y: 0 }, port: null, local: null, jointId: null, probeId: null };

    // probe markers first (small, on top)
    for (const [id, sp] of this.probeMarks) {
      if (!sp.visible) continue;
      const sc = this.toScreen(sp.position);
      if (Math.hypot(sc.x - mx, sc.y - my) < 11) { res.probeId = id; break; }
    }
    // ports in screen space (hole centres are empty space, a ray would miss them)
    let best = opts.ports === false ? 0 : 13;
    let bestPort: { part: Part; port: Port; z: number } | null = null;
    if (opts.ports !== false) {
      for (const p of project.parts) {
        if (p.suppressed || p.id === opts.excludePart) continue;
        const g = geometryOf(project, p);
        const pose = poseOf(p.id) ?? p.pose;
        const z = p.pose.z + g.zMax + (this.explodeZ.get(p.id) ?? 0);
        for (const port of g.ports) {
          const w = localToWorld(pose, port.x, port.y);
          const sc = this.toScreen(_v.set(w.x, w.y, z));
          const d = Math.hypot(sc.x - mx, sc.y - my);
          if (d < best) { best = d; bestPort = { part: p, port, z }; }
        }
      }
    }
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const meshes: THREE.Object3D[] = [];
    for (const [id, pv] of this.parts) { if (id !== opts.excludePart) meshes.push(...pv.meshes); }
    let hits = this.raycaster.intersectObjects(meshes, false);
    if (s.view.section.enabled) hits = hits.filter((h) => this.sectionPlane.distanceToPoint(h.point) >= 0);
    let hit = hits[0];
    // prefer an already selected part when it lies (almost) at the same depth as the first hit
    if (hit) {
      const selSet = new Set(s.selection.parts);
      if (!selSet.has(hit.object.userData.partId)) {
        const alt = hits.find((h) => selSet.has(h.object.userData.partId) && h.distance - hit.distance < 1.0);
        if (alt) hit = alt;
      }
    }
    if (bestPort) {
      const pose = poseOf(bestPort.part.id) ?? bestPort.part.pose;
      const w = localToWorld(pose, bestPort.port.x, bestPort.port.y);
      res.partId = bestPort.part.id; res.port = bestPort.port; res.local = { x: bestPort.port.x, y: bestPort.port.y }; res.world = w;
      return res;
    }
    if (hit) {
      const id = hit.object.userData.partId as string;
      const part = project.parts.find((p) => p.id === id)!;
      const pose = poseOf(id) ?? part.pose;
      res.partId = id;
      res.world = { x: hit.point.x, y: hit.point.y };
      res.local = worldToLocal(pose, hit.point.x, hit.point.y);
      return res;
    }
    // tools that need an anchor: a click inside a part's outline (a slot, a bore, a large hole) still means that part
    if (opts.ports !== false) {
      let bestZ = -Infinity;
      for (const p of project.parts) {
        if (p.suppressed || p.id === opts.excludePart) continue;
        const g = geometryOf(project, p);
        const z = p.pose.z + g.zMax + (this.explodeZ.get(p.id) ?? 0);
        if (z <= bestZ) continue;
        const pp = this.planePoint(clientX, clientY, z);
        if (!pp) continue;
        const pose = poseOf(p.id) ?? p.pose;
        const l = worldToLocal(pose, pp.x, pp.y);
        if (Math.hypot(l.x, l.y) > g.boundR) continue;
        const inside = g.layers.some((layer) => layer.contours.some((c) => signedArea(c) > 0 && pointInPoly(l.x, l.y, c)));
        if (inside) { bestZ = z; res.partId = p.id; res.world = { x: pp.x, y: pp.y }; res.local = l; }
      }
      if (res.partId) return res;
    }
    // joint glyphs
    if (s.view.showJoints) {
      let bj = 12, jid: string | null = null;
      for (const [id, jo] of this.jointObjs) {
        jo.group.traverse((o) => {
          if (!(o as any).isLine && !(o as any).isMesh) return;
          const wp = o.getWorldPosition(_v2);
          const sc = this.toScreen(wp);
          const d = Math.hypot(sc.x - mx, sc.y - my);
          if (d < bj) { bj = d; jid = id; }
        });
      }
      res.jointId = jid;
    }
    const pp = this.planePoint(clientX, clientY, this.bbox.getCenter(_v).z);
    if (pp) res.world = { x: pp.x, y: pp.y };
    return res;
  }

  showSnap(world: { x: number; y: number } | null, z = 0): void {
    if (!world) { this.snapRing.visible = false; return; }
    this.snapRing.visible = true;
    this.snapRing.position.set(world.x, world.y, z);
    this.snapRing.scale.setScalar(this.mmPerPx() * 9);
    this.snapRing.quaternion.copy(this.camera.quaternion);
  }

  topZ(partId: string): number {
    const s = getState();
    const p = s.project.parts.find((x) => x.id === partId);
    if (!p) return 0;
    return p.pose.z + geometryOf(s.project, p).zMax + (this.explodeZ.get(partId) ?? 0);
  }

  /** client (page) coordinates of a world point — used by tests and overlays */
  worldToClient(x: number, y: number, z: number): { x: number; y: number } {
    const sc = this.toScreen(new THREE.Vector3(x, y, z));
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: sc.x + r.left, y: sc.y + r.top };
  }

  /** client coordinates of a part's port (on the part's top face) at the current pose */
  portToClient(partId: string, portId: string): { x: number; y: number } | null {
    const s = getState();
    const p = s.project.parts.find((q) => q.id === partId);
    if (!p) return null;
    const g = geometryOf(s.project, p);
    const port = g.ports.find((q) => q.id === portId);
    if (!port) return null;
    const pose = this.currentPoseFn()(partId) ?? p.pose;
    const w = localToWorld(pose, port.x, port.y);
    return this.worldToClient(w.x, w.y, this.topZ(partId));
  }

  screenshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  stats(): { triangles: number; calls: number; parts: number; geometries: number } {
    const i = this.renderer.info;
    return { triangles: i.render.triangles, calls: i.render.calls, parts: this.parts.size, geometries: i.memory.geometries };
  }
}

let _id = 0;
const ids = new WeakMap<object, number>();
function idOf(o: object): number { let v = ids.get(o); if (!v) { v = ++_id; ids.set(o, v); } return v; }

let _ring: THREE.Texture | null = null;
function ringTexture(): THREE.Texture {
  if (_ring) return _ring;
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const ctx = c.getContext('2d')!;
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(16, 16, 10, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fill();
  _ring = new THREE.CanvasTexture(c);
  return _ring;
}

const dots = new Map<string, THREE.Texture>();
function dotTexture(color: string): THREE.Texture {
  let t = dots.get(color);
  if (t) return t;
  const c = document.createElement('canvas'); c.width = c.height = 48;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(10,12,14,0.9)'; ctx.beginPath(); ctx.arc(24, 24, 18, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(24, 24, 11, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(24, 24, 17, 0, Math.PI * 2); ctx.stroke();
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  dots.set(color, t);
  return t;
}

/** closed centre-line of a belt around two pulleys; pulley A at the origin, B at (C, 0) */
export function beltPath(C: number, ra: number, rb: number, crossed: boolean): { pts: [number, number][]; len: number[]; total: number } {
  const pts: [number, number][] = [];
  const arc = (cx: number, r: number, a0: number, a1: number) => {
    const n = Math.max(8, Math.ceil((Math.abs(a1 - a0) * r) / 1.5));
    for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; pts.push([cx + r * Math.cos(a), r * Math.sin(a)]); }
  };
  if (!crossed) {
    const beta = Math.asin(Math.max(-1, Math.min(1, (ra - rb) / Math.max(C, 1e-9))));
    // upper tangent leaves A at angle 90°−β; wrap A on the far (left) side, B on the right side
    const tA = Math.PI / 2 - beta;
    arc(0, ra, tA, 2 * Math.PI - tA);          // around A (counter-clockwise through 180°)
    arc(C, rb, -tA, tA);                        // around B
  } else {
    const beta = Math.asin(Math.max(-1, Math.min(1, (ra + rb) / Math.max(C, 1e-9))));
    const tA = Math.PI / 2 - beta;
    arc(0, ra, tA, 2 * Math.PI - tA);
    arc(C, rb, Math.PI - tA + 2 * Math.PI, Math.PI + tA);
  }
  const len: number[] = [0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    len.push(len[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return { pts, len, total: len[len.length - 1] };
}

function beltGeometry(pts: [number, number][], thick: number, width: number): THREE.BufferGeometry {
  // ribbon swept along the closed centre-line: outer/inner offset × ±width/2
  const n = pts.length;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[(i + 1) % n], p = pts[i];
    let tx = p1[0] - p0[0], ty = p1[1] - p0[1];
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    const nx = ty, ny = -tx; // outward for CCW path
    const o: [number, number] = [p[0] + (nx * thick) / 2, p[1] + (ny * thick) / 2], inn: [number, number] = [p[0] - (nx * thick) / 2, p[1] - (ny * thick) / 2];
    pos.push(o[0], o[1], width / 2, o[0], o[1], -width / 2, inn[0], inn[1], -width / 2, inn[0], inn[1], width / 2);
  }
  for (let i = 0; i < n; i++) {
    const a = i * 4, b = ((i + 1) % n) * 4;
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      idx.push(a + k, b + k, b + k2, a + k, b + k2, a + k2);
    }
  }
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g = toCreasedNormals(g, Math.PI / 4);
  return g;
}
