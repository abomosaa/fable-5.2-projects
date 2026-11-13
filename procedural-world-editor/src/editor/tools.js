// Viewport tools: select/move, sculpt, paint, path drawing (rivers, roads, trails), lakes,
// object / structure / settlement placement, water interaction.

import { applySculpt, paintMask, paintIndex, SCULPT_KINDS } from '../core/brushes.js';
import { MAT_LABELS } from '../core/biomes.js';
import { newId } from '../core/project.js';
import { nearestOnPolyline } from '../core/paths.js';
import { NO_WATER } from '../core/waterField.js';
import { unionRect } from '../core/heightfield.js';

export const TOOL_INFO = {
  select: { label: 'Select / move', key: 'V', hint: 'Click to select · drag to move · Q/E rotate · Del delete · drag floating objects through water' },
  sculpt: { label: 'Sculpt terrain', key: 'B', hint: 'Drag to sculpt · [ ] radius · Shift = smooth · Ctrl = invert' },
  paint: { label: 'Paint', key: 'P', hint: 'Drag to paint materials, biomes, exclusion zones or scatter density · Ctrl = erase' },
  river: { label: 'Draw river', key: 'R', hint: 'Click to add points downstream · Enter / double-click to finish · Esc to cancel' },
  lake: { label: 'Add lake', key: 'L', hint: 'Click the lowest point of a basin to fill it' },
  road: { label: 'Draw road', key: 'T', hint: 'Click to add points · Enter / double-click to finish · Esc to cancel' },
  trail: { label: 'Draw trail', key: 'Y', hint: 'Click to add points · Enter / double-click to finish · Esc to cancel' },
  place: { label: 'Place object', key: 'O', hint: 'Pick a model in the asset browser, then click to place · Q/E rotate · Esc to stop' },
  structure: { label: 'Place structure', key: 'H', hint: 'Click to place · Q/E rotate · invalid sites (water, steep slope) are rejected' },
  interact: { label: 'Touch water', key: 'I', hint: 'Click water to drop a stone · drag to stir · floating objects react' },
};

export class Tools {
  constructor(app) {
    this.app = app;
    this.active = 'select';
    this.busy = false; // a stroke / drag is in progress
    this.brush = { radius: 18, strength: 0.5, hardness: 0.3, kind: 'raise', step: 4, depth: 2.5 };
    this.paint = { mode: 'material', material: 0, biome: 1, group: 'trees', densityTarget: 0, radius: 14, strength: 0.7 };
    this.pathDraft = null; // {kind, nodes:[]}
    this.placeModel = null;
    this.placeRot = 0;
    this.placeScale = 1;
    this.placeFloating = false;
    this.structureType = 'cabin';
    this.lakeDepth = 2.5;
    this.cursor = null;
    this.stroke = null;
    this.dragSel = null;
    this.lastPointer = null;
  }

  reset() {
    this.pathDraft = null;
    this.stroke = null;
    this.dragSel = null;
    this.busy = false;
  }

  setTool(name) {
    if (!TOOL_INFO[name]) return;
    if (this.pathDraft) this.finishPath(true);
    this.active = name;
    this.app.status(TOOL_INFO[name].hint);
    this.app.ui.refreshTools();
    this.app.ui.refreshPanels();
    this.app.overlays.rebuild();
  }

  get world() {
    return this.app.world;
  }

  // ------------------------------------------------------------------------------------
  // Pointer events (left button; the camera controller consumes right / middle)
  // ------------------------------------------------------------------------------------
  onPointerDown(e) {
    const app = this.app;
    const w = this.world;
    if (!w || e.button !== 0) return;
    this.lastPointer = e;
    const hit = app.pickSurface(e);
    switch (this.active) {
      case 'sculpt':
      case 'paint':
        if (hit) this.beginStroke(hit, e);
        break;
      case 'river':
      case 'road':
      case 'trail':
        if (hit) this.addPathNode(hit);
        break;
      case 'lake':
        if (hit) this.addLake(hit);
        break;
      case 'place':
        if (hit) this.placeObject(hit);
        break;
      case 'structure':
        if (hit) this.placeStructure(hit);
        break;
      case 'interact':
        if (hit && hit.water) {
          app.engine.waterSim.addSource(hit.x, hit.z, 0.35, -0.05);
          this.stir = { x: hit.x, z: hit.z };
          this.busy = true;
        }
        break;
      default:
        this.selectDown(e, hit);
    }
  }

  onPointerMove(e) {
    this.lastPointer = e;
    const app = this.app;
    if (!this.world) return;
    const hit = app.pickSurface(e);
    this.cursor = hit;
    if (this.stroke && hit) {
      this.stroke.pos = hit;
    } else if (this.dragSel && hit) this.selectDrag(hit, e);
    else if (this.stir && hit && hit.water) {
      const dx = hit.x - this.stir.x,
        dz = hit.z - this.stir.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.08) {
        // a moving disturbance: push water up ahead and down behind
        const n = Math.min(6, Math.ceil(d / 0.25));
        for (let i = 1; i <= n; i++) {
          const x = this.stir.x + (dx * i) / n,
            z = this.stir.z + (dz * i) / n;
          app.engine.waterSim.addSource(x + (dx / d) * 0.2, z + (dz / d) * 0.2, 0.3, 0.012);
          app.engine.waterSim.addSource(x - (dx / d) * 0.2, z - (dz / d) * 0.2, 0.3, -0.012);
        }
        this.stir = { x: hit.x, z: hit.z };
      }
    }
    if (hit) app.ui.setCursorInfo(hit);
  }

  onPointerUp() {
    if (this.stroke) this.endStroke();
    if (this.dragSel) this.selectUp();
    if (this.stir) {
      this.stir = null;
      this.busy = false;
    }
  }

  onDoubleClick() {
    if (this.pathDraft) {
      // the second click of the double-click already added a node at the same place
      const n = this.pathDraft.nodes;
      if (n.length > 2) n.pop();
      this.finishPath(false);
    }
  }

  onKey(e) {
    const app = this.app;
    const k = e.code;
    if (k === 'Escape') {
      if (this.pathDraft) this.finishPath(true);
      else if (this.active !== 'select') this.setTool('select');
      else app.select(null);
      return true;
    }
    if (k === 'Enter' && this.pathDraft) {
      this.finishPath(false);
      return true;
    }
    if (k === 'Backspace' && this.pathDraft) {
      this.pathDraft.nodes.pop();
      app.overlays.rebuild();
      return true;
    }
    if (k === 'BracketLeft' || k === 'BracketRight') {
      const b = this.active === 'paint' ? this.paint : this.brush;
      b.radius = Math.max(1, Math.min(400, b.radius * (k === 'BracketLeft' ? 0.87 : 1.15)));
      app.ui.refreshPanels();
      return true;
    }
    if ((k === 'KeyQ' || k === 'KeyE') && app.cam.mode !== 'fly') {
      const step = (e.shiftKey ? 5 : 15) * (Math.PI / 180) * (k === 'KeyQ' ? 1 : -1);
      if (this.active === 'place' || this.active === 'structure') {
        this.placeRot += step;
        return true;
      }
      const sel = app.selection;
      if (sel && (sel.type === 'object' || sel.type === 'structure')) {
        app.edit('Rotate ' + sel.type, () => (app.resolve().rot = ((app.resolve().rot || 0) + step) % (Math.PI * 2)), sel.type === 'object' ? 'objects' : 'modifiers', { mergeKey: 'rot:' + sel.id });
        return true;
      }
    }
    if (k === 'Delete' || (k === 'Backspace' && !this.pathDraft)) {
      const sel = app.selection;
      if (sel && sel.type === 'node') this.deleteNode(sel);
      else if (sel && sel.type === 'instance') this.deleteInstance(sel);
      else app.deleteSelection();
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------------------------
  // Per-frame
  // ------------------------------------------------------------------------------------
  update(dt) {
    const app = this.app;
    const w = this.world;
    const terr = app.engine.terrain;
    // brush cursor
    const showBrush = (this.active === 'sculpt' || this.active === 'paint') && this.cursor && !app.cam.drag;
    if (showBrush) {
      const b = this.active === 'paint' ? this.paint : this.brush;
      const col = this.active === 'paint' ? [0.3, 0.9, 1.0, 1] : [1.0, 0.75, 0.25, 1];
      terr.setBrush(this.cursor.x, this.cursor.z, b.radius, this.stroke ? 1 : 0.5, col);
    } else terr.setBrush(0, 0, 1, 0);
    if (this.stroke && this.stroke.pos) this.applyStroke(dt);
    // keep the ripple window around what the user interacts with
    const sel = app.selection;
    const eng = app.engine;
    if (this.active === 'interact' && this.cursor && this.cursor.water) eng.rippleFocus = { x: this.cursor.x, z: this.cursor.z };
    else if (sel && sel.type === 'object' && eng.objects.objects.get(sel.id)?.body) {
      const b = eng.objects.objects.get(sel.id).body;
      eng.rippleFocus = { x: b.pos.x, z: b.pos.z };
    } else {
      // nearest floating body within range of the camera, else the camera itself
      let best = null,
        bd = 60 * 60;
      for (const b of eng.objects.bodies) {
        const d = (b.pos.x - eng.camera.position.x) ** 2 + (b.pos.z - eng.camera.position.z) ** 2;
        if (d < bd) {
          bd = d;
          best = b;
        }
      }
      eng.rippleFocus = best ? { x: best.pos.x, z: best.pos.z } : null;
    }
    void w;
  }

  // ------------------------------------------------------------------------------------
  // Sculpt / paint strokes
  // ------------------------------------------------------------------------------------
  beginStroke(hit, e) {
    const w = this.world;
    const isPaint = this.active === 'paint';
    const s = { pos: hit, rect: null, state: {}, invert: e.ctrlKey || e.metaKey, smooth: e.shiftKey, paint: isPaint, grids: [] };
    if (!isPaint) {
      s.grids.push({ grid: w.hUser.data, before: new Float32Array(w.hUser.data) });
      s.target = w.hUser.sample(hit.x, hit.z);
      s.kind = s.smooth ? 'smooth' : this.brush.kind;
      if (s.invert && (s.kind === 'raise' || s.kind === 'lower')) s.kind = s.kind === 'raise' ? 'lower' : 'raise';
    } else {
      const p = this.paint;
      const N = w.res * w.res;
      let grid;
      if (p.mode === 'material') {
        if (!w.paint.mat[p.material]) w.paint.mat[p.material] = new Uint8Array(N);
        grid = w.paint.mat[p.material];
      } else if (p.mode === 'biome') grid = w.paint.biome;
      else if (p.mode === 'exclude') grid = w.paint.exclude;
      else {
        if (!w.paint.density[p.group]) w.paint.density[p.group] = new Uint8Array(N).fill(128);
        grid = w.paint.density[p.group];
      }
      s.grid = grid;
      s.grids.push({ grid, before: new Uint8Array(grid) });
    }
    this.stroke = s;
    this.busy = true;
    this._t0 = performance.now();
  }

  applyStroke(dt) {
    const w = this.world;
    const s = this.stroke;
    const t0 = performance.now();
    let rect;
    if (!s.paint) {
      const b = this.brush;
      rect = applySculpt(w.hUser, s.kind, s.pos.x, s.pos.z, { radius: b.radius, strength: b.strength, hardness: b.hardness, dt, target: s.target, step: b.step, depth: b.depth, state: s.state, seed: w.project.seed });
      s.rect = unionRect(s.rect, rect);
      w.deriveRect(rect, { fast: true });
    } else {
      const p = this.paint;
      const hf = w.hUser;
      if (p.mode === 'material') rect = paintMask(s.grid, hf, s.pos.x, s.pos.z, p.radius, s.invert ? 0 : 255, p.strength, dt);
      else if (p.mode === 'biome') rect = paintIndex(s.grid, hf, s.pos.x, s.pos.z, p.radius, s.invert ? 0 : p.biome);
      else if (p.mode === 'exclude') rect = paintMask(s.grid, hf, s.pos.x, s.pos.z, p.radius, s.invert ? 0 : 255, 1, dt * 4);
      else rect = paintMask(s.grid, hf, s.pos.x, s.pos.z, p.radius, s.invert ? 128 : p.densityTarget, p.strength, dt);
      s.rect = unionRect(s.rect, rect);
      w.deriveRect(rect, { fast: true });
      if (p.mode === 'exclude') this.app.overlays.showMask(s.grid, [1.0, 0.25, 0.2]);
    }
    this.app.editLatency = performance.now() - t0;
  }

  endStroke() {
    const app = this.app;
    const w = this.world;
    const s = this.stroke;
    this.stroke = null;
    this.busy = false;
    if (!s.rect) return;
    const paint = s.paint;
    const apply = (rect) => {
      if (paint) w.deriveGround(rect);
      else w.deriveRect(rect);
    };
    const label = paint ? 'Paint ' + this.paint.mode : SCULPT_KINDS[s.kind] || 'Sculpt';
    if (app.pushGridEdit(label, s.grids, s.rect, apply)) apply(s.rect);
  }

  // ------------------------------------------------------------------------------------
  // Paths
  // ------------------------------------------------------------------------------------
  addPathNode(hit) {
    const kind = this.active;
    if (!this.pathDraft) this.pathDraft = { kind, nodes: [] };
    const n = this.pathDraft.nodes;
    const last = n[n.length - 1];
    if (last && Math.hypot(last.x - hit.x, last.z - hit.z) < 1.5) return;
    n.push({ x: hit.x, z: hit.z });
    this.app.overlays.rebuild();
    this.app.status(`${n.length} point${n.length > 1 ? 's' : ''} — Enter to finish, Backspace to remove the last point`);
  }

  finishPath(cancel) {
    const d = this.pathDraft;
    this.pathDraft = null;
    const app = this.app;
    if (!d || cancel || d.nodes.length < 2) {
      app.overlays.rebuild();
      return;
    }
    const id = newId(d.kind);
    if (d.kind === 'river') {
      app.edit('Add river', (doc) => doc.water.rivers.push({ id, name: 'River ' + (doc.water.rivers.length + 1), nodes: d.nodes, width: this.riverWidth ?? 8, depth: this.riverDepth ?? 0.7, flow: this.riverFlow ?? 5 }), 'modifiers');
      app.select({ type: 'river', id });
    } else {
      app.edit('Add ' + d.kind, (doc) => doc.roads.push({ id, kind: d.kind, name: (d.kind === 'trail' ? 'Trail ' : 'Road ') + (doc.roads.length + 1), nodes: d.nodes }), 'modifiers');
      app.select({ type: 'road', id });
    }
    this.setTool('select');
  }

  pathOf(sel) {
    const d = this.world.project;
    if (sel.path === 'river') return d.water.rivers.find((r) => r.id === sel.id);
    return d.roads.find((r) => r.id === sel.id);
  }

  deleteNode(sel) {
    const app = this.app;
    const p = this.pathOf(sel);
    if (!p || p.nodes.length <= 2) return app.toast('A path needs at least two points — delete the whole path instead.', 'warn');
    app.edit('Delete path point', () => this.pathOf(sel).nodes.splice(sel.index, 1), 'modifiers');
    app.select({ type: sel.path === 'river' ? 'river' : 'road', id: sel.id });
  }

  // ------------------------------------------------------------------------------------
  // Lakes, objects, structures
  // ------------------------------------------------------------------------------------
  addLake(hit) {
    const app = this.app;
    const w = this.world;
    const id = newId('lake');
    const ground = w.heightAt(hit.x, hit.z);
    app.edit('Add lake', (doc) => doc.water.lakes.push({ id, name: 'Lake ' + (doc.water.lakes.length + 1), x: hit.x, z: hit.z, level: ground + this.lakeDepth }), 'water');
    app.select({ type: 'lake', id });
    this.setTool('select');
  }

  placeObject(hit) {
    const app = this.app;
    if (!this.placeModel) return app.toast('Choose a model in the asset browser first (Assets tab).', 'warn');
    const info = app.manifest.models[this.placeModel];
    const floating = hit.water && hit.depth > 0.25 && (this.placeFloating || (info.tags || []).includes('floating') || info.category === 'prop');
    if (hit.water && hit.depth > 0.25 && !floating && info.category !== 'rock' && info.category !== 'structure') return app.toast('This model does not float — place it on land, or enable "Floating".', 'warn');
    const id = newId('obj');
    const o = { id, model: this.placeModel, x: hit.x, z: hit.z, rot: this.placeRot, scale: this.placeScale };
    if (floating) o.floating = true;
    if (info.category === 'rock') o.sink = 0.15;
    app.edit('Place ' + (info.name || this.placeModel), (doc) => doc.objects.push(o), 'objects');
    app.select({ type: 'object', id });
  }

  placeStructure(hit) {
    const app = this.app;
    const w = this.world;
    const id = newId('struct');
    const s = { id, type: this.structureType, x: hit.x, z: hit.z, rot: this.placeRot, variant: Math.floor(Math.random() * 1000) };
    if (this.structureType === 'model') {
      if (!this.placeModel) return app.toast('Choose a structure model in the asset browser first.', 'warn');
      s.model = this.placeModel;
      const info = app.manifest.models[s.model];
      if ((info.tags || []).includes('pier') || /pier/.test(s.model)) s.overWater = true;
    }
    const bad = w.checkStructureSite(s, w.project.structureRules || {});
    if (bad) return app.toast(`Cannot build here: ${bad}.`, 'warn');
    app.edit('Place structure', (doc) => doc.structures.push(s), 'modifiers');
    app.select({ type: 'structure', id });
  }

  addSettlement(x, z) {
    const app = this.app;
    const w = this.world;
    const st = { id: newId('settle'), name: 'Settlement', x, z, radius: 70, count: 6, seed: 1, types: ['cabin', 'cabin', 'shed'], rules: { maxSlope: 0.28, minWaterDist: 6, minSpacing: 18, maxRoadDist: 45, minRoadDist: 8 } };
    const made = w.generateSettlement(st);
    if (!made.length) return app.toast('No valid building sites found here (too steep, too wet or too far from a road).', 'warn');
    app.edit(
      'Add settlement',
      (doc) => {
        doc.settlements.push(st);
        doc.structures.push(...made);
      },
      'modifiers',
    );
    app.select({ type: 'settlement', id: st.id });
  }

  regenerateSettlement(id) {
    const app = this.app;
    const w = this.world;
    const st = w.project.settlements.find((s) => s.id === id);
    if (!st) return;
    const made = w.generateSettlement(st);
    app.edit(
      'Regenerate settlement',
      (doc) => {
        // manually moved / edited buildings (settlement link removed) are preserved
        doc.structures = doc.structures.filter((s) => s.settlement !== id).concat(made);
      },
      'modifiers',
    );
    if (made.length < st.count) app.toast(`Only ${made.length} of ${st.count} buildings fit the rules.`, 'warn');
  }

  // ------------------------------------------------------------------------------------
  // Selection tool
  // ------------------------------------------------------------------------------------
  selectDown(e, hit) {
    const app = this.app;
    const w = this.world;
    const ray = app.rayFromEvent(e);
    // 1. handles of the selected path / lake markers (screen-space)
    const hnd = app.overlays.pickHandle(e);
    if (hnd) {
      if (hnd.type === 'node') {
        if (e.shiftKey) return;
        app.select(hnd);
        this.dragSel = { sel: hnd, moved: false };
        this.busy = true;
        return;
      }
      app.select(hnd);
      this.dragSel = { sel: hnd, moved: false };
      this.busy = true;
      return;
    }
    // 2. shift-click on a selected path inserts a node
    const sel = app.selection;
    if (e.shiftKey && sel && (sel.type === 'river' || sel.type === 'road') && hit) {
      const p = app.resolve();
      const np = nearestOnPolyline(p.nodes, hit.x, hit.z);
      if (np.dist < 40) {
        app.edit('Insert path point', () => app.resolve().nodes.splice(np.seg + 1, 0, { x: hit.x, z: hit.z }), 'modifiers');
        return;
      }
    }
    // 3. objects / structures
    const op = app.engine.objects.pick(ray.origin, ray.dir);
    if (op && (!hit || op.t < hit.t + 3)) {
      const s = { type: op.kind, id: op.id };
      app.select(s);
      this.dragSel = { sel: s, moved: false, start: hit };
      this.busy = true;
      const body = app.engine.objects.objects.get(op.id)?.body;
      if (body && hit) body.held = { x: hit.x, z: hit.z };
      return;
    }
    // 4. paths
    if (hit) {
      let best = null;
      const tol = Math.max(4, hit.t * 0.02);
      for (const r of w.project.water.rivers) {
        const np = nearestOnPolyline(r.nodes, hit.x, hit.z);
        if (np.dist < Math.max(tol, (r.width || 8) * 0.8) && (!best || np.dist < best.d)) best = { d: np.dist, sel: { type: 'river', id: r.id } };
      }
      for (const r of w.project.roads) {
        const np = nearestOnPolyline(r.nodes, hit.x, hit.z);
        if (np.dist < Math.max(tol, 4) && (!best || np.dist < best.d)) best = { d: np.dist, sel: { type: 'road', id: r.id } };
      }
      if (best) return app.select(best.sel);
    }
    // 5. scatter instances
    const ip = app.engine.vegetation.pick(ray.origin, ray.dir, hit ? hit.t + 5 : 600);
    if (ip) return app.select({ type: 'instance', ...ip, cell: undefined, cellKey: ip.cell.cx + ',' + ip.cell.cz });
    // 6. water bodies
    if (hit && hit.water) {
      const gi = Math.round(w.hFinal.toGridZ(hit.z)) * w.res + Math.round(w.hFinal.toGridX(hit.x));
      const t = w.water.type[gi];
      if (t === 3) return app.select({ type: 'sea' });
      if (t === 2) {
        const lake = w.project.water.lakes.find((l) => Math.abs(l.level - hit.y) < 0.05);
        if (lake) return app.select({ type: 'lake', id: lake.id });
      }
    }
    app.select(null);
  }

  selectDrag(hit) {
    const app = this.app;
    const d = this.dragSel;
    const sel = d.sel;
    d.moved = true;
    d.pos = hit;
    if (sel.type === 'object') {
      const e = app.engine.objects.objects.get(sel.id);
      if (e && e.body) {
        e.body.held = { x: hit.x, z: hit.z };
        return;
      }
      if (e) {
        // live preview without touching the document
        const doc = app.resolve(sel);
        e.group.position.set(hit.x, app.world.heightAt(hit.x, hit.z) - (doc.sink ?? 0) * (doc.scale || 1), hit.z);
        e.group.updateMatrixWorld(true);
        app.engine.objects._pushMatrices(e);
      }
    } else if (sel.type === 'structure') {
      const e = app.engine.objects.structures.get(sel.id);
      if (e) {
        e.group.position.set(hit.x, app.world.heightAt(hit.x, hit.z), hit.z);
        e.group.updateMatrixWorld(true);
        app.engine.objects._pushMatrices(e);
      }
    } else if (sel.type === 'node' || sel.type === 'lake' || sel.type === 'settlement') {
      app.overlays.previewHandle(sel, hit);
    }
  }

  selectUp() {
    const app = this.app;
    const d = this.dragSel;
    this.dragSel = null;
    this.busy = false;
    const sel = d.sel;
    const body = sel.type === 'object' ? app.engine.objects.objects.get(sel.id)?.body : null;
    if (body) {
      body.held = null;
      if (d.moved) {
        // commit where the physics left it; the body keeps its state
        const x = body.pos.x,
          z = body.pos.z;
        app.edit('Move floating object', () => Object.assign(app.resolve(sel), { x, z }), 'none');
        const o = app.resolve(sel);
        body.resetKey = `${o.x},${o.z},${o.scale},${o.rot}`;
      }
      return;
    }
    if (!d.moved || !d.pos) return;
    const hit = d.pos;
    if (sel.type === 'object') {
      const floating = app.resolve(sel).floating;
      if (hit.water && hit.depth > 0.3 && !floating && app.manifest.models[app.resolve(sel).model]?.category !== 'rock') {
        app.toast('That object does not float. Enable "Floating" in the inspector to put it on water.', 'warn');
        app.engine.objects.sync(app.world);
        return;
      }
      app.edit('Move object', () => Object.assign(app.resolve(sel), { x: hit.x, z: hit.z, y: undefined }), 'objects');
    } else if (sel.type === 'structure') {
      const s = { ...app.resolve(sel), x: hit.x, z: hit.z };
      const bad = app.world.checkStructureSite(s, app.world.project.structureRules || {});
      if (bad) {
        app.toast(`Cannot move the structure there: ${bad}.`, 'warn');
        app.engine.objects.sync(app.world);
        return;
      }
      // a hand-placed position detaches the building from its settlement rules
      app.edit('Move structure', () => Object.assign(app.resolve(sel), { x: hit.x, z: hit.z, settlement: undefined, level: undefined }), 'modifiers');
    } else if (sel.type === 'node') {
      app.edit('Move path point', () => Object.assign(this.pathOf(sel).nodes[sel.index], { x: hit.x, z: hit.z }), 'modifiers');
    } else if (sel.type === 'lake') {
      app.edit('Move lake', () => Object.assign(app.resolve(sel), { x: hit.x, z: hit.z }), 'water');
    } else if (sel.type === 'settlement') {
      app.edit('Move settlement', () => Object.assign(app.resolve(sel), { x: hit.x, z: hit.z }), 'none');
      this.regenerateSettlement(sel.id);
    }
  }

  // ------------------------------------------------------------------------------------
  // Scatter instances: delete / detach into an individually editable object
  // ------------------------------------------------------------------------------------
  deleteInstance(sel) {
    const app = this.app;
    const key = `${sel.layerId}:${sel.gi}:${sel.gj}`;
    app.edit(
      'Remove scattered instance',
      (doc) => {
        doc.scatter = doc.scatter || { suppressed: [] };
        doc.scatter.suppressed.push(key);
      },
      'scatter',
    );
    app.select(null);
  }

  detachInstance(sel) {
    const app = this.app;
    const key = `${sel.layerId}:${sel.gi}:${sel.gj}`;
    const id = newId('obj');
    app.edit(
      'Detach instance',
      (doc) => {
        doc.scatter = doc.scatter || { suppressed: [] };
        doc.scatter.suppressed.push(key);
        doc.objects.push({ id, model: sel.modelId, x: sel.x, y: sel.y, z: sel.z, rot: sel.rot, scale: sel.scale, detached: true });
      },
      'scatter',
    );
    app.select({ type: 'object', id });
  }
}

export { SCULPT_KINDS, MAT_LABELS, NO_WATER };
