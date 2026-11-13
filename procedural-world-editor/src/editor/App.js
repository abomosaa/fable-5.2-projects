// Application core: project lifecycle, document edits with undo/redo, derivation, main loop.

import * as THREE from 'three';
import { Engine, QUALITY_PRESETS } from '../render/Engine.js';
import { World } from '../core/world.js';
import { createProjectDoc, newId, resolveBiomes, BIOME_LIBRARY } from '../core/project.js';
import { structureFootprint } from '../core/structures.js';
import { NO_WATER } from '../core/waterField.js';
import { History, docCommand, gridsCommand, extractRect, replaceObject } from './history.js';
import { CameraControl } from './cameraControl.js';
import { store } from './store.js';
import { Tools } from './tools.js';
import { Overlays } from './overlays.js';
import { UI } from './ui.js';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

export class App {
  constructor() {
    this.history = new History();
    this.world = null;
    this.manifest = null;
    this.selection = null; // {type, id, ...}
    this.jobs = new Map();
    this.jobId = 0;
    this.autosaveInterval = 60000;
    this.lastAutosave = 0;
    this.autosavedRevision = 0;
    this.errors = [];
    this.ready = false;
    this.busy = false;
    this.frame = 0;
  }

  async init() {
    this.ui = new UI(this);
    this.ui.build();
    this.ui.progress('Loading asset manifest', 0.02);
    let res;
    try {
      res = await fetch('/assets/manifest.json');
    } catch (e) {
      throw new Error('Cannot reach the Terraforge server. Start it with "npm start".');
    }
    if (!res.ok) throw new Error('The asset library is not installed (public/assets/manifest.json is missing). Run "npm run assets" once to download and process the CC0 asset library, then reload.');
    this.manifest = await res.json();
    const canvas = this.ui.canvas;
    const params = new URLSearchParams(location.search);
    this.engine = new Engine(canvas, { quality: params.get('quality') || localStorage.getItem('tf.quality') || 'high', onError: (m) => this.error(m), preserveDrawingBuffer: params.has('capture') });
    await this.engine.initAssets(this.manifest, '/assets/');
    this.cam = new CameraControl(this);
    this.overlays = new Overlays(this);
    this.tools = new Tools(this);
    this.worker = new Worker(new URL('../workers/gen.worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev) => this._onWorker(ev.data);
    this.worker.onerror = (e) => this.error('Background worker failed: ' + (e.message || e));
    this.ui.bind();
    this.history.onChange(() => this.ui.refreshTop());
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('beforeunload', (e) => {
      if (this.history.dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
    this.resize();
    this._last = performance.now();
    requestAnimationFrame((t) => this.loop(t));
    // open the requested project, or the first showcase so the editor starts on finished work
    const list = await store.list();
    this.projectList = list;
    const want = params.get('project');
    const first = list.find((p) => p.id === want) || list.find((p) => p.showcase) || list[0];
    if (first) await this.openProject(first.id);
    else {
      this.ui.progress(null);
      this.ui.showProjects();
    }
    this.ready = true;
  }

  // ------------------------------------------------------------------------------------
  // Errors / status
  // ------------------------------------------------------------------------------------
  error(msg) {
    console.error(msg);
    this.errors.push(String(msg));
    this.ui?.toast(String(msg), 'error');
  }
  status(msg) {
    this.ui?.setStatus(msg);
  }
  toast(msg, kind = 'info') {
    this.ui?.toast(msg, kind);
  }

  resize() {
    const r = this.ui.viewport.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) this.engine.resize(Math.round(r.width), Math.round(r.height));
  }

  // ------------------------------------------------------------------------------------
  // Project lifecycle
  // ------------------------------------------------------------------------------------
  async openProject(id, opts = {}) {
    if (this.busy) return;
    this.busy = true;
    try {
      this.ui.progress('Opening project', 0.02);
      await nextFrame();
      const { doc, data } = await store.load(id, opts);
      await this._adoptWorld(doc, data);
      if (opts.autosave) {
        this.history.revision++;
        this.toast('Recovered the autosaved version. Save to keep it.');
      }
      history.replaceState(null, '', '?project=' + encodeURIComponent(id) + (new URLSearchParams(location.search).has('capture') ? '&capture' : ''));
      // offer recovery if a newer autosave exists
      if (!opts.autosave) {
        const meta = (await store.list()).find((p) => p.id === id);
        if (meta && meta.autosave) this.ui.offerRecovery(id, meta.autosave);
      }
    } catch (e) {
      this.error(`Could not open project "${id}": ${e.message}`);
      this.ui.progress(null);
      if (!this.world) this.ui.showProjects();
    } finally {
      this.busy = false;
    }
  }

  async _adoptWorld(doc, data) {
    const T = (this.loadTimings = {});
    let tPrev = performance.now();
    const mark = (k) => {
      const n = performance.now();
      T[k] = Math.round(n - tPrev);
      tPrev = n;
    };
    const p = (l, f) => this.ui.progress(l, f);
    p('Deriving world', 0.1);
    await nextFrame();
    const world = new World(doc, data, this.manifest);
    world.suppressed = new Set(doc.scatter?.suppressed || []);
    const steps = [];
    world.deriveAll((l, f) => steps.push([l, f]));
    mark('derive');
    p('Loading materials and models', 0.4);
    await nextFrame();
    this.loading = true;
    this.world = world;
    this.selection = null;
    try {
      await this.engine.setWorld(world, (l, f) => p(l, 0.4 + f * 0.58));
    } finally {
      this.loading = false;
    }
    this._loopErr = false;
    mark('engine');
    Object.assign(T, this.engine.loadTimings || {});
    this.history.clear();
    this.autosavedRevision = 0;
    this.tools.reset();
    this.overlays.rebuild();
    if (doc.view) this.cam.setPose(doc.view);
    else this.frameAll();
    this.ui.refreshAll();
    p(null);
    this.engine.atmosphere.resetTemporal();
  }

  frameAll() {
    const w = this.world;
    const t = w.project.water;
    let x = 0,
      z = 0;
    if (t.rivers[0]) {
      const n = t.rivers[0].nodes[t.rivers[0].nodes.length >> 1];
      x = n.x;
      z = n.z;
    } else if (t.lakes[0]) {
      x = t.lakes[0].x;
      z = t.lakes[0].z;
    }
    const y = w.heightAt(x, z);
    this.cam.setPose({ mode: 'orbit', position: [x + w.size * 0.1, y + w.size * 0.09, z + w.size * 0.14], lookAt: [x, y, z] });
  }

  /** Create a new world from a seed. Runs generation in the worker with progress + cancel. */
  async newProject({ name, preset, seed, size, res, relief }) {
    if (this.busy) return;
    this.busy = true;
    try {
      const { doc, missing } = createProjectDoc({ name, preset, seed, manifest: this.manifest, terrain: { size, res, relief } });
      if (missing.length) throw new Error(`The asset library is incomplete (missing: ${missing.slice(0, 8).join(', ')}). Run "npm run assets".`);
      const gen = await this.runJob('generate', { params: doc.terrain }, 'Generating terrain');
      if (!gen) return null;
      doc.terrain = { ...doc.terrain, ...gen.params, hMin: 0, hMax: 1, operations: [] };
      const sug = gen.suggested;
      if (sug.seaLevel !== null) doc.water.sea = { enabled: true, level: sug.seaLevel };
      for (const l of sug.lakes) doc.water.lakes.push({ id: newId('lake'), name: 'Lake', x: l.x, z: l.z, level: l.level });
      if (sug.rivers[0] && preset !== 'coast') {
        const pts = sug.rivers[0];
        doc.water.rivers.push({ id: newId('river'), name: 'River', nodes: pts.map((q) => ({ x: q.x, z: q.z })), width: preset === 'alpine' ? 11 : 8, depth: 0.8, flow: preset === 'alpine' ? 9 : 5 });
      }
      await store.save(new World(doc, gen, this.manifest), this.manifest, {});
      await this._adoptWorld(doc, gen);
      history.replaceState(null, '', '?project=' + encodeURIComponent(doc.id));
      this.saveThumbSoon();
      return doc.id;
    } catch (e) {
      this.error('New project failed: ' + e.message);
      this.ui.progress(null);
      return null;
    } finally {
      this.busy = false;
    }
  }

  async save() {
    if (!this.world) return;
    try {
      this.status('Saving…');
      this.world.project.view = this.cam.getPose();
      await store.save(this.world, this.manifest, {});
      this.history.markSaved();
      this.autosavedRevision = this.history.revision;
      await this.saveThumb();
      this.status('Saved ' + new Date().toLocaleTimeString());
      this.toast('Project saved');
    } catch (e) {
      this.error('Save failed: ' + e.message);
    }
  }

  async autosave() {
    if (!this.world || this.busy || this.tools.busy) return;
    if (this.history.revision === this.autosavedRevision || !this.history.dirty) return;
    try {
      const rev = this.history.revision;
      await store.save(this.world, this.manifest, { autosave: true });
      this.autosavedRevision = rev;
      this.status('Autosaved ' + new Date().toLocaleTimeString());
    } catch (e) {
      this.status('Autosave failed: ' + e.message);
    }
  }

  saveThumbSoon() {
    setTimeout(() => this.saveThumb().catch(() => {}), 2500);
  }
  async saveThumb() {
    const blob = await this.captureBlob(480, 270);
    if (blob) await store.saveThumb(this.world.project.id, blob);
  }
  /** Capture the viewport right after a render (works without preserveDrawingBuffer). */
  captureBlob(w, h, type = 'image/jpeg', q = 0.85) {
    return new Promise((resolve) => {
      this._afterRender = () => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d').drawImage(this.ui.canvas, 0, 0, w, h);
        c.toBlob((b) => resolve(b), type, q);
      };
    });
  }

  async duplicateProject(id, name) {
    const newIdStr = newId('proj');
    await store.duplicate(id, newIdStr, name);
    return newIdStr;
  }

  // ------------------------------------------------------------------------------------
  // Worker jobs (generation, erosion) with progress and cancellation
  // ------------------------------------------------------------------------------------
  runJob(type, payload, label, transfer = []) {
    const job = ++this.jobId;
    return new Promise((resolve, reject) => {
      this.jobs.set(job, { resolve, reject, label });
      this.ui.progress(label, 0, () => {
        this.worker.postMessage({ type: 'cancel', job });
        if (type === 'generate') {
          // generation is synchronous inside the worker: restart the worker to abort immediately
          this.worker.terminate();
          this.worker = new Worker(new URL('../workers/gen.worker.js', import.meta.url), { type: 'module' });
          this.worker.onmessage = (ev) => this._onWorker(ev.data);
          this.jobs.delete(job);
          this.ui.progress(null);
          resolve(null);
        }
      });
      this.worker.postMessage({ type, job, ...payload }, transfer);
    });
  }
  _onWorker(m) {
    const j = this.jobs.get(m.job);
    if (!j) return;
    if (m.type === 'progress') this.ui.progress(`${j.label} — ${m.phase}`, m.f, undefined, true);
    else {
      this.jobs.delete(m.job);
      this.ui.progress(null);
      if (m.type === 'done') j.resolve(m.result);
      else if (m.type === 'cancelled') j.resolve(null);
      else j.reject(new Error(m.message));
    }
  }

  // ------------------------------------------------------------------------------------
  // Document edits
  // ------------------------------------------------------------------------------------
  /**
   * Edit the project document.
   * @param {string} label   undo label
   * @param {(doc)=>void} mutate
   * @param {string} kind    what to re-derive: env | wind | water | modifiers | ground | materials | objects | none
   * @param {object} [o] {live: true while dragging a slider (no history entry yet), mergeKey}
   */
  edit(label, mutate, kind, o = {}) {
    const doc = this.world.project;
    const key = o.mergeKey || label;
    if (!this._live || this._live.key !== key) this._live = { key, before: JSON.stringify(doc) };
    mutate(doc);
    if (o.live) {
      this.applyDoc(kind, true);
      return;
    }
    const before = this._live.before;
    this._live = null;
    const after = JSON.stringify(doc);
    if (after === before) return;
    this.applyDoc(kind, false);
    this.history.push(docCommand(label, doc, before, after, () => this.applyDoc(kind, false, true), o.mergeKey));
  }

  /** Re-derive after a document change. */
  applyDoc(kind, live = false, fromHistory = false) {
    const w = this.world;
    const eng = this.engine;
    w.suppressed = new Set(w.project.scatter?.suppressed || []);
    try {
      switch (kind) {
        case 'env':
          eng.applyEnvironment();
          break;
        case 'wind':
          eng.applyEnvironment();
          if (!live) {
            w.solveWater(w._obstacles);
            w.emit('water', w.fullRect());
          }
          break;
        case 'water':
          if (live) {
            w.solveWater(w._obstacles);
            w.emit('water', w.fullRect());
          } else w.deriveWater();
          eng.applyEnvironment();
          break;
        case 'modifiers':
          w.deriveRect({ x0: 0, z0: 0, x1: 0, z1: 0 }, { forceWater: true });
          eng.objects.sync(w).catch((e) => this.error(e.message));
          break;
        case 'ground':
          w.invalidateLayerList();
          eng.vegetation.refreshLayers();
          if (!live) {
            w.deriveGround();
            eng.vegetation
              .ensureModels()
              .then(() => eng.vegetation.invalidate())
              .catch((e) => this.error(e.message));
          }
          break;
        case 'materials':
          eng.terrain
            .setMaterials(w.project.materials.layers, this.manifest, '/assets/')
            .then(() => {
              if (!live) w.deriveGround();
            })
            .catch((e) => this.error(e.message));
          break;
        case 'objects':
          eng.objects.sync(w).catch((e) => this.error(e.message));
          break;
        case 'scatter':
          w.scatterCells.clear();
          w.detailCells.clear();
          w.generateAllScatter();
          w.emit('scatter', null);
          eng.objects.sync(w).catch((e) => this.error(e.message));
          break;
        default:
          break;
      }
    } catch (e) {
      this.error('Update failed: ' + e.message);
    }
    if (kind !== 'env' && kind !== 'wind') {
      w.invalidateLayerList();
      eng.vegetation.refreshLayers();
    }
    this.overlays.rebuild();
    if (!live || fromHistory) this.ui.refreshPanels(fromHistory);
  }

  /** Record a finished grid edit (sculpt / paint stroke or a whole-terrain operation). */
  pushGridEdit(label, grids, rect, apply) {
    // grids: [{grid, before (full copy taken before the stroke)}]
    const res = this.world.res;
    const entries = [];
    for (const g of grids) {
      const before = extractRect(g.before, res, rect);
      const after = extractRect(g.grid, res, rect);
      let same = true;
      for (let i = 0; i < before.length; i++) {
        if (before[i] !== after[i]) {
          same = false;
          break;
        }
      }
      if (!same) entries.push({ grid: g.grid, before, after });
    }
    if (!entries.length) return false;
    this.history.push(gridsCommand(label, res, rect, entries, apply));
    return true;
  }

  undo() {
    if (this.tools.busy) return;
    const l = this.history.undo();
    if (l) this.status('Undid: ' + l);
  }
  redo() {
    if (this.tools.busy) return;
    const l = this.history.redo();
    if (l) this.status('Redid: ' + l);
  }

  // ------------------------------------------------------------------------------------
  // Whole-terrain operations
  // ------------------------------------------------------------------------------------
  async runErosion(kind, params) {
    const w = this.world;
    const heights = new Float32Array(w.hUser.data);
    const result = await this.runJob('erode', { heights, res: w.res, cell: w.hUser.cell, kind, params }, kind === 'hydraulic' ? 'Hydraulic erosion' : 'Thermal erosion', [heights.buffer]);
    if (!result) {
      this.toast('Erosion cancelled — terrain unchanged');
      return false;
    }
    const beforeH = new Float32Array(w.hUser.data);
    const beforeS = new Float32Array(w.sediment);
    w.hUser.data.set(result.heights);
    for (let i = 0; i < w.sediment.length; i++) w.sediment[i] = Math.max(0, Math.min(1, w.sediment[i] + Math.max(0, result.sediment[i]) * 1.2));
    const full = w.fullRect();
    const apply = () => {
      this.ui.progress('Updating world', 0.5);
      w.deriveAll();
      this.ui.progress(null);
    };
    this.pushGridEdit(kind === 'hydraulic' ? 'Hydraulic erosion' : 'Thermal erosion', [{ grid: w.hUser.data, before: beforeH }, { grid: w.sediment, before: beforeS }], full, apply);
    apply();
    w.project.terrain.operations.push({ op: kind, params, time: new Date().toISOString() });
    return true;
  }

  /** Regenerate the terrain from (possibly changed) generator parameters. Undoable. */
  async regenerateTerrain(params) {
    const w = this.world;
    const doc = w.project;
    const p = { ...doc.terrain, ...params, res: w.res, size: w.size };
    const gen = await this.runJob('generate', { params: p }, 'Generating terrain');
    if (!gen) {
      this.toast('Generation cancelled — terrain unchanged');
      return false;
    }
    const beforeH = new Float32Array(w.hUser.data);
    const beforeS = new Float32Array(w.sediment);
    const beforeRing = w.ring;
    const beforeDoc = JSON.stringify(doc);
    w.hUser.data.set(gen.heights);
    w.sediment.set(gen.sediment);
    w.ring = gen.ring;
    doc.seed = p.seed;
    doc.terrain = { ...doc.terrain, ...gen.params, operations: [] };
    const afterDoc = JSON.stringify(doc);
    const afterRing = gen.ring;
    const apply = () => {
      this.ui.progress('Updating world', 0.5);
      w.deriveAll();
      this.engine.terrain.buildRing();
      this.ui.progress(null);
      this.ui.refreshPanels(true);
    };
    const full = w.fullRect();
    const grids = gridsCommand('Regenerate terrain', w.res, full, [
      { grid: w.hUser.data, before: beforeH, after: new Float32Array(w.hUser.data) },
      { grid: w.sediment, before: beforeS, after: new Float32Array(w.sediment) },
    ], () => {});
    this.history.push({
      label: 'Regenerate terrain',
      bytes: grids.bytes,
      undo: () => {
        grids.undo();
        w.ring = beforeRing;
        replaceObject(doc, JSON.parse(beforeDoc));
        apply();
      },
      redo: () => {
        grids.redo();
        w.ring = afterRing;
        replaceObject(doc, JSON.parse(afterDoc));
        apply();
      },
    });
    apply();
    return true;
  }

  // ------------------------------------------------------------------------------------
  // Selection and helpers
  // ------------------------------------------------------------------------------------
  select(sel) {
    this.selection = sel;
    const id = sel && (sel.type === 'object' || sel.type === 'structure') ? sel.id : null;
    this.engine.objects.setSelected(id);
    this.overlays.rebuild();
    this.ui.refreshPanels();
  }

  footprint(doc) {
    return structureFootprint(doc, this.manifest);
  }

  /** Find a document item by selection. */
  resolve(sel = this.selection) {
    if (!sel || !this.world) return null;
    const d = this.world.project;
    switch (sel.type) {
      case 'river':
        return d.water.rivers.find((r) => r.id === sel.id);
      case 'lake':
        return d.water.lakes.find((r) => r.id === sel.id);
      case 'road':
        return d.roads.find((r) => r.id === sel.id);
      case 'structure':
        return d.structures.find((r) => r.id === sel.id);
      case 'settlement':
        return d.settlements.find((r) => r.id === sel.id);
      case 'object':
        return d.objects.find((r) => r.id === sel.id);
      case 'biome':
        return d.biomes.find((r) => r.id === sel.id);
      case 'layer': {
        const b = d.biomes.find((r) => r.id === sel.biome);
        return b && b.layers.find((l) => l.id === sel.id);
      }
      default:
        return null;
    }
  }

  deleteSelection() {
    const sel = this.selection;
    if (!sel) return;
    const rm = (arr, id) => {
      const i = arr.findIndex((q) => q.id === id);
      if (i >= 0) arr.splice(i, 1);
    };
    const kinds = { river: 'modifiers', road: 'modifiers', structure: 'modifiers', lake: 'water', object: 'objects', settlement: 'modifiers' };
    if (!(sel.type in kinds)) return;
    this.selection = null;
    this.edit(
      'Delete ' + sel.type,
      (d) => {
        if (sel.type === 'river') rm(d.water.rivers, sel.id);
        else if (sel.type === 'lake') rm(d.water.lakes, sel.id);
        else if (sel.type === 'road') rm(d.roads, sel.id);
        else if (sel.type === 'structure') rm(d.structures, sel.id);
        else if (sel.type === 'object') rm(d.objects, sel.id);
        else if (sel.type === 'settlement') {
          rm(d.settlements, sel.id);
          d.structures = d.structures.filter((s) => s.settlement !== sel.id);
        }
      },
      kinds[sel.type],
    );
    this.engine.objects.setSelected(null);
  }

  /** Add a biome from the library to the project. */
  addBiome(libId) {
    const { biomes, missing } = resolveBiomes([libId], this.manifest);
    if (missing.length) this.toast('Some models of this biome are not installed: ' + missing.join(', '), 'warn');
    const b = biomes[0];
    this.edit(
      'Add biome',
      (d) => {
        let id = b.id,
          n = 2;
        while (d.biomes.some((q) => q.id === id)) id = b.id + '_' + n++;
        b.id = id;
        d.biomes.push(b);
      },
      'ground',
    );
    void BIOME_LIBRARY;
  }

  // ------------------------------------------------------------------------------------
  // Picking
  // ------------------------------------------------------------------------------------
  rayFromEvent(e, out = {}) {
    const r = this.ui.canvas.getBoundingClientRect();
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = -(((e.clientY - r.top) / r.height) * 2 - 1);
    return this.rayFromNDC(nx, ny, out);
  }
  rayFromNDC(nx, ny, out = {}) {
    const cam = this.engine.camera;
    const tanY = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const dir = (this._rayDir || (this._rayDir = new THREE.Vector3())).set(nx * tanY * cam.aspect, ny * tanY, -1).normalize().applyQuaternion(cam.quaternion);
    out.origin = cam.position;
    out.dir = dir;
    return out;
  }
  pickTerrain(e) {
    if (!this.world) return null;
    const { origin, dir } = this.rayFromEvent(e);
    return this.world.raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z);
  }
  /** Terrain or water surface, whichever the ray meets first. Returns {x,y,z,water:boolean,depth}. */
  pickSurface(e) {
    const w = this.world;
    if (!w) return null;
    const { origin, dir } = this.rayFromEvent(e);
    const hit = w.raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z);
    if (!hit) {
      // open sea beyond the terrain
      const sea = w.seaLevel;
      if (sea !== null && dir.y < -1e-3) {
        const t = (sea - origin.y) / dir.y;
        return { x: origin.x + dir.x * t, y: sea, z: origin.z + dir.z * t, water: true, depth: 30, t };
      }
      return null;
    }
    const s = w.waterSurfaceAt(hit.x, hit.z);
    if (s > NO_WATER * 0.5 && s > hit.y + 0.01 && dir.y < -1e-3) {
      const t = (s - origin.y) / dir.y;
      const x = origin.x + dir.x * t,
        z = origin.z + dir.z * t;
      const s2 = w.waterSurfaceAt(x, z);
      if (s2 > NO_WATER * 0.5) return { x, y: s2, z, water: true, depth: s2 - w.heightAt(x, z), t };
    }
    return { ...hit, water: false, depth: 0 };
  }

  // ------------------------------------------------------------------------------------
  // Main loop
  // ------------------------------------------------------------------------------------
  loop(t) {
    requestAnimationFrame((tt) => this.loop(tt));
    const dt = Math.min(0.1, (t - this._last) / 1000);
    this._last = t;
    if (!this.world || this.loading || this.manual) return;
    this.frame++;
    try {
      this.cam.update(dt);
      this.tools.update(dt);
      this.overlays.update();
      this.engine.render(dt);
    } catch (e) {
      if (!this._loopErr) this.error('Render error: ' + (e.stack || e.message));
      this._loopErr = true;
      return;
    }
    if (this._afterRender) {
      const f = this._afterRender;
      this._afterRender = null;
      f();
    }
    if (this.frame % 20 === 0) this.ui.refreshStats();
    if (t - this.lastAutosave > this.autosaveInterval) {
      this.lastAutosave = t;
      this.autosave();
    }
  }

  /**
   * Deterministic stepping for captures and tests: while `manual` is set the animation loop is
   * idle and frames advance only through this call (fixed dt, n frames).
   */
  stepManual(dt = 1 / 60, n = 1) {
    this.manual = true;
    for (let i = 0; i < n; i++) {
      this.frame++;
      this.cam.update(dt);
      this.tools.update(dt);
      this.overlays.update();
      this.engine.render(dt);
    }
    this.ui.refreshStats();
  }
  resumeLoop() {
    this.manual = false;
    this._last = performance.now();
  }

  setQuality(q) {
    if (!QUALITY_PRESETS[q]) return;
    localStorage.setItem('tf.quality', q);
    // texture sizes are fixed at start-up; other settings apply immediately
    this.engine.setQuality(q);
    this.toast(`Quality: ${QUALITY_PRESETS[q].label}. Texture resolution changes apply after reload.`);
  }
}
