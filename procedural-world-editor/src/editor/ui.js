// Editor shell: top bar, tool strip, scene hierarchy, asset browser, contextual inspector,
// environment / water / world panels, dialogs, progress and error states.

import { h, clear, slider, number, select, checkbox, text, color, button, section, note } from './dom.js';
import { TOOL_INFO } from './tools.js';
import { SCULPT_KINDS } from '../core/brushes.js';
import { MAT_NAMES, MAT_LABELS, MAT } from '../core/biomes.js';
import { WATER_PRESETS, BIOME_LIBRARY, newId } from '../core/project.js';
import { TERRAIN_PRESETS } from '../core/terrainGen.js';
import { HYDRAULIC_DEFAULTS, THERMAL_DEFAULTS } from '../core/erosion.js';
import { RIVER_DEFAULTS, ROAD_DEFAULTS } from '../core/carve.js';
import { QUALITY_PRESETS } from '../render/Engine.js';
import { NO_WATER } from '../core/waterField.js';
import { store } from './store.js';

const ICONS = {
  select: '<path d="M5 3l12 8-5 1 3 6-2 1-3-6-4 4z"/>',
  sculpt: '<path d="M3 18c4-9 6-9 9-4s5 1 9-8"/><path d="M3 21h18"/>',
  paint: '<path d="M14 4l6 6-9 9H5v-6z"/><path d="M12 6l6 6"/>',
  river: '<path d="M6 3c-3 5 6 6 3 11s5 5 3 7"/><path d="M14 3c-2 4 5 5 3 9"/>',
  lake: '<ellipse cx="12" cy="13" rx="9" ry="5"/><path d="M7 13c2-1 3 1 5 0s3-1 5 0"/>',
  road: '<path d="M8 21L10 3M16 21L14 3M12 5v3M12 11v3M12 17v3"/>',
  trail: '<path d="M6 20c2-4-1-6 3-9s2-5 6-8" stroke-dasharray="2.5 2.5"/>',
  place: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  structure: '<path d="M3 11l9-7 9 7"/><path d="M6 10v10h12V10"/><path d="M10 20v-6h4v6"/>',
  interact: '<circle cx="12" cy="12" r="2"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="10"/>',
};
const TOOL_ORDER = ['select', 'sculpt', 'paint', null, 'river', 'lake', null, 'road', 'trail', 'structure', 'place', null, 'interact'];
const CATEGORY_LABEL = { tree_conifer: 'Conifers', tree_broadleaf: 'Broadleaf', shrub: 'Shrubs', groundcover: 'Ground cover', grass: 'Grass', rock: 'Rocks', deadwood: 'Dead wood', prop: 'Props', structure: 'Structures', reed: 'Reeds' };

const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;

export class UI {
  constructor(app) {
    this.app = app;
    this.leftTab = 'scene';
    this.rightTab = 'inspector';
    this.assetCat = 'rock';
    this.assetKind = 'models';
    this.collapsed = new Set();
  }

  // ------------------------------------------------------------------------------------
  build() {
    const root = document.getElementById('app');
    clear(root);
    this.pname = h('input', { class: 'pname', title: 'Project name', onchange: () => this.app.world && this.app.edit('Rename project', (d) => (d.name = this.pname.value || 'Untitled'), 'none') });
    this.undoBtn = button('↶ Undo', () => this.app.undo(), { title: 'Undo (Ctrl+Z)' });
    this.redoBtn = button('↷ Redo', () => this.app.redo(), { title: 'Redo (Ctrl+Shift+Z)' });
    this.dirty = h('span', { class: 'dirty' });
    this.camSeg = h('div', { class: 'seg', title: 'Camera mode (1 / 2 / 3)' }, ['orbit', 'fly', 'walk'].map((m) => h('button', { dataset: { m }, onclick: () => this.app.cam.setMode(m) }, m[0].toUpperCase() + m.slice(1))));
    this.pauseBtn = button('❚❚ Simulation', () => this.togglePause(), { title: 'Pause / resume water, wind and clouds (K)' });
    this.qualitySel = h('select', { title: 'Render quality', onchange: () => this.app.setQuality(this.qualitySel.value) }, Object.entries(QUALITY_PRESETS).map(([k, v]) => h('option', { value: k }, v.label + ' quality')));
    const top = h(
      'div',
      { id: 'top' },
      h('div', { class: 'brand' }, 'TERRA', h('span', null, 'FORGE')),
      button('Projects', () => this.showProjects(), { title: 'Open, create, duplicate projects' }),
      this.pname,
      button('Save', () => this.app.save(), { title: 'Save (Ctrl+S)', class: 'primary' }),
      this.dirty,
      this.undoBtn,
      this.redoBtn,
      h('div', { class: 'sp' }),
      this.camSeg,
      this.pauseBtn,
      this.qualitySel,
      button('Export…', () => this.showExport(), { title: 'Export heightmaps, masks, GLB scene and placement data' }),
      button('?', () => this.showHelp(), { title: 'Controls and help (F1)' }),
    );
    this.toolbar = h('div', { id: 'toolbar' });
    for (const t of TOOL_ORDER) {
      if (!t) {
        this.toolbar.append(h('div', { class: 'sep' }));
        continue;
      }
      const b = h('button', { dataset: { tool: t }, title: `${TOOL_INFO[t].label} (${TOOL_INFO[t].key})`, onclick: () => this.app.tools.setTool(t) });
      b.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[t]}</svg>`;
      this.toolbar.append(b);
    }
    this.leftTabs = h('div', { class: 'tabs' }, [['scene', 'Scene'], ['assets', 'Assets']].map(([k, l]) => h('button', { dataset: { k }, onclick: () => this.setLeftTab(k) }, l)));
    this.leftPanel = h('div', { class: 'panel' });
    const left = h('aside', { id: 'left' }, this.leftTabs, this.leftPanel);
    this.canvas = h('canvas', { tabIndex: 0 });
    this.hud = h('div', { class: 'hud' });
    this.modeHint = h('div', { class: 'modehint' });
    this.viewport = h('section', { id: 'viewport' }, this.canvas, this.hud, this.modeHint);
    this.rightTabs = h('div', { class: 'tabs' }, [['inspector', 'Inspector'], ['env', 'Sky & light'], ['water', 'Water'], ['world', 'World']].map(([k, l]) => h('button', { dataset: { k }, onclick: () => this.setRightTab(k) }, l)));
    this.rightPanel = h('div', { class: 'panel' });
    const right = h('aside', { id: 'right' }, this.rightTabs, this.rightPanel);
    this.statusMsg = h('span', { class: 'msg' }, 'Starting…');
    this.statusCursor = h('span');
    this.statusFps = h('span');
    this.status = h('div', { id: 'status' }, this.statusMsg, this.statusCursor, this.statusFps);
    root.append(top, this.toolbar, left, this.viewport, right, this.status);
    this.toasts = document.body.appendChild(h('div', { id: 'toasts' }));
  }

  bind() {
    const app = this.app;
    const c = this.canvas;
    this.qualitySel.value = app.engine.qualityName;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.focus();
      c.setPointerCapture(e.pointerId);
      if (app.cam.onPointerDown(e)) return;
      app.tools.onPointerDown(e);
    });
    c.addEventListener('pointermove', (e) => {
      if (app.cam.onPointerMove(e)) return;
      app.tools.onPointerMove(e);
    });
    const up = (e) => {
      try {
        c.releasePointerCapture(e.pointerId);
      } catch {
        /* not captured */
      }
      if (app.cam.onPointerUp(e)) return;
      app.tools.onPointerUp(e);
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('dblclick', (e) => app.tools.onDoubleClick(e));
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      app.cam.onWheel(e);
    }, { passive: false });
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('keyup', (e) => app.cam.keys.delete(e.code));
    window.addEventListener('blur', () => app.cam.keys.clear());
    new ResizeObserver(() => app.resize()).observe(this.viewport);
    app.onCameraMode = () => this.refreshTop();
    this.refreshTools();
    this.setLeftTab('scene');
    this.setRightTab('inspector');
  }

  onKey(e) {
    const app = this.app;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      if (e.code === 'Escape') e.target.blur();
      // saving works from anywhere (otherwise the browser's own "save page" dialog would open)
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS' && !document.querySelector('.modal')) {
        e.preventDefault();
        e.target.blur();
        this.app.save();
      }
      return;
    }
    if (document.querySelector('.modal')) {
      if (e.code === 'Escape') this.closeModal();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.code === 'KeyZ') {
      e.preventDefault();
      return e.shiftKey ? app.redo() : app.undo();
    }
    if (mod && e.code === 'KeyY') {
      e.preventDefault();
      return app.redo();
    }
    if (mod && e.code === 'KeyS') {
      e.preventDefault();
      return app.save();
    }
    if (mod) return;
    if (e.code === 'F1') {
      e.preventDefault();
      return this.showHelp();
    }
    if (!app.world) return;
    if (app.tools.onKey(e)) return e.preventDefault();
    // movement keys go to the camera (in orbit mode WASD pans the focus point)
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight', 'Space', 'KeyC'].includes(e.code) || (app.cam.mode === 'fly' && (e.code === 'KeyQ' || e.code === 'KeyE'))) {
      app.cam.keys.add(e.code);
      if (e.code === 'Space') e.preventDefault();
      return;
    }
    if (e.code === 'Digit1') return app.cam.setMode('orbit');
    if (e.code === 'Digit2') return app.cam.setMode('fly');
    if (e.code === 'Digit3') return app.cam.setMode('walk');
    if (e.code === 'KeyK') return this.togglePause();
    if (e.code === 'KeyF') return this.focusSelection();
    for (const [k, t] of Object.entries(TOOL_INFO)) if ('Key' + t.key === e.code) return app.tools.setTool(k);
  }

  togglePause() {
    const eng = this.app.engine;
    eng.paused = !eng.paused;
    this.pauseBtn.textContent = eng.paused ? '▶ Simulation' : '❚❚ Simulation';
  }

  focusSelection() {
    const app = this.app;
    const sel = app.selection;
    const w = app.world;
    const it = app.resolve();
    let p = null;
    if (sel && sel.type === 'instance') p = sel;
    else if (it && it.nodes) p = it.nodes[it.nodes.length >> 1];
    else if (it && it.x !== undefined) p = it;
    if (!p) return;
    app.cam.focus(p.x, w.heightAt(p.x, p.z), p.z, sel.type === 'river' || sel.type === 'road' ? 220 : sel.type === 'lake' ? 320 : 30);
  }

  // ------------------------------------------------------------------------------------
  // Status, progress, toasts, modal
  // ------------------------------------------------------------------------------------
  setStatus(msg) {
    this.statusMsg.textContent = msg;
  }
  setCursorInfo(hit) {
    this._cursor = hit;
  }
  refreshStats() {
    const app = this.app;
    const eng = app.engine;
    const s = eng.frameStats();
    const hit = this._cursor;
    if (hit) this.statusCursor.innerHTML = `x <b>${hit.x.toFixed(1)}</b> z <b>${hit.z.toFixed(1)}</b> alt <b>${hit.y.toFixed(1)} m</b>${hit.water ? ` · water depth <b>${hit.depth.toFixed(2)} m</b>` : ''}`;
    this.statusFps.innerHTML = `<b>${s.fps.toFixed(0)}</b> fps · ${s.avg.toFixed(1)} ms · ${(eng.stats.triangles / 1e6).toFixed(1)}M tris · ${eng.stats.calls} draws${app.editLatency ? ` · brush ${app.editLatency.toFixed(0)} ms` : ''}`;
    const cam = app.cam;
    const p = eng.camera.position;
    const g = app.world.hFinal.inBounds(p.x, p.z) ? p.y - app.world.heightAt(p.x, p.z) : 0;
    this.hud.textContent = `${cam.mode.toUpperCase()}  ${g.toFixed(1)} m above ground${eng.cameraSubmerged ? '  ·  UNDERWATER' : ''}`;
    this.modeHint.textContent =
      cam.mode === 'orbit' ? 'RMB orbit · MMB pan · wheel zoom · WASD move focus' : cam.mode === 'fly' ? `RMB look · WASD move · Q/E down/up · Shift fast · wheel speed (${cam.flySpeed.toFixed(0)} m/s)` : 'RMB look · WASD walk · Shift run · Space jump · in deep water: C dive, Space rise';
  }

  progress(label, f = 0, onCancel, keep) {
    let el = document.getElementById('progress');
    if (label === null || label === undefined) {
      if (el) el.remove();
      this._cancel = null;
      return;
    }
    if (!el) {
      el = h('div', { id: 'progress' }, h('div', { class: 'box' }, h('div', { class: 'lbl' }), h('div', { class: 'bar' }, h('i')), h('div', { class: 'cancel' })));
      document.body.append(el);
    }
    el.querySelector('.lbl').textContent = label;
    el.querySelector('i').style.width = Math.round(Math.max(0, Math.min(1, f)) * 100) + '%';
    if (!keep) this._cancel = onCancel || null;
    const cz = el.querySelector('.cancel');
    if (this._cancel && !cz.firstChild) cz.append(button('Cancel', () => this._cancel && this._cancel()));
    if (!this._cancel) clear(cz);
  }

  toast(msg, kind = 'info') {
    const t = h('div', { class: 'toast ' + kind }, msg);
    this.toasts.append(t);
    while (this.toasts.children.length > 5) this.toasts.firstChild.remove();
    setTimeout(() => t.remove(), kind === 'error' ? 15000 : kind === 'warn' ? 7000 : 3500);
    this.setStatus(msg.split('\n')[0]);
  }

  modal(title, body, footer, opts = {}) {
    this.closeModal();
    const dlg = h('div', { class: 'dlg' }, h('header', null, h('span', null, title), opts.noClose ? null : button('✕', () => this.closeModal(), { class: 'small' })), h('div', { class: 'body' }, body), footer ? h('footer', null, footer) : null);
    const m = h('div', { class: 'modal', onpointerdown: (e) => e.target === m && !opts.noClose && this.closeModal() }, dlg);
    document.body.append(m);
    return m;
  }
  closeModal() {
    document.querySelector('.modal')?.remove();
  }

  // ------------------------------------------------------------------------------------
  // Refresh
  // ------------------------------------------------------------------------------------
  refreshAll() {
    this.refreshTop();
    this.refreshTools();
    this.refreshPanels(true);
  }
  refreshTop() {
    const app = this.app;
    if (app.world && document.activeElement !== this.pname) this.pname.value = app.world.project.name;
    this.undoBtn.disabled = !app.history.canUndo;
    this.redoBtn.disabled = !app.history.canRedo;
    this.undoBtn.title = app.history.canUndo ? `Undo: ${app.history.undoLabel} (Ctrl+Z)` : 'Nothing to undo';
    this.redoBtn.title = app.history.canRedo ? `Redo: ${app.history.redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo';
    this.dirty.textContent = app.history.dirty ? '● unsaved' : '';
    if (app.cam) for (const b of this.camSeg.children) b.classList.toggle('on', b.dataset.m === app.cam.mode);
  }
  refreshTools() {
    for (const b of this.toolbar.querySelectorAll('button')) b.classList.toggle('on', b.dataset.tool === this.app.tools?.active);
  }
  /** Rebuild the side panels. `force` also rebuilds while a field has focus (after undo/redo). */
  refreshPanels(force) {
    if (!this.app.world) return;
    const active = document.activeElement;
    const editing = active && this.rightPanel.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'SELECT') && active.type !== 'checkbox';
    this.renderLeft();
    if (!editing || force) this.renderRight();
  }
  setLeftTab(k) {
    this.leftTab = k;
    for (const b of this.leftTabs.children) b.classList.toggle('on', b.dataset.k === k);
    if (this.app.world) this.renderLeft();
  }
  setRightTab(k) {
    this.rightTab = k;
    for (const b of this.rightTabs.children) b.classList.toggle('on', b.dataset.k === k);
    if (this.app.world) this.renderRight();
  }

  // ------------------------------------------------------------------------------------
  // Left: scene hierarchy / asset browser
  // ------------------------------------------------------------------------------------
  renderLeft() {
    const st = this.leftPanel.scrollTop;
    clear(this.leftPanel);
    this.leftPanel.append(this.leftTab === 'scene' ? this.sceneTree() : this.assetBrowser());
    this.leftPanel.scrollTop = st;
  }

  sceneTree() {
    const app = this.app;
    const d = app.world.project;
    const sel = app.selection;
    const isSel = (type, id, extra) => sel && sel.type === type && sel.id === id && (!extra || sel.biome === extra);
    const row = (ico, name, meta, onClick, selected, acts) => h('div', { class: 'row' + (selected ? ' sel' : ''), onclick: onClick }, h('span', { class: 'ico' }, ico), h('span', { class: 'nm' }, name), meta ? h('span', { class: 'meta' }, meta) : null, acts || null);
    const grp = (label, add) => h('div', { class: 'grp' }, h('span', null, label), add ? h('a', { onclick: add[1] }, add[0]) : null);
    const pick = (s, tab = 'inspector') => () => {
      app.tools.active !== 'select' && app.tools.setTool('select');
      app.select(s);
      this.setRightTab(tab);
    };
    const wst = app.world.water.stats || {};
    const cell2 = app.world.hFinal.cell ** 2;
    const t = h('div', { class: 'tree' });
    t.append(grp('Terrain'), row('▲', `${TERRAIN_PRESETS[d.terrain.preset]?.label || d.terrain.preset}`, `${d.terrain.size} m · seed ${d.seed}`, () => this.setRightTab('world'), false));
    t.append(grp('Water', ['+ lake', () => app.tools.setTool('lake')]));
    t.append(row('≈', 'Sea', d.water.sea.enabled ? `level ${d.water.sea.level.toFixed(1)} m` : 'off', pick({ type: 'sea' }), sel && sel.type === 'sea'));
    d.water.lakes.forEach((l, i) => t.append(row('◍', l.name, `${((wst.lakeCells?.[i] || 0) * cell2 / 1e4).toFixed(1)} ha`, pick({ type: 'lake', id: l.id }), isSel('lake', l.id))));
    t.append(grp('Rivers', ['+ draw', () => app.tools.setTool('river')]));
    for (const r of d.water.rivers) t.append(row('∿', r.name, `${r.flow} m³/s`, pick({ type: 'river', id: r.id }), isSel('river', r.id) || (sel && sel.type === 'node' && sel.id === r.id)));
    t.append(grp('Roads & trails', ['+ draw', () => app.tools.setTool('road')]));
    for (const r of d.roads) t.append(row(r.kind === 'trail' ? '┄' : '═', r.name, r.kind, pick({ type: 'road', id: r.id }), isSel('road', r.id) || (sel && sel.type === 'node' && sel.id === r.id)));
    t.append(grp('Biomes', ['+ add', () => this.showAddBiome()]));
    d.biomes.forEach((b, bi) => {
      const open = !this.collapsed.has('b:' + b.id);
      t.append(
        row(
          h('span', { class: 'swatch', style: { background: b.color || '#888' } }),
          b.name,
          `#${bi + 1}`,
          pick({ type: 'biome', id: b.id }),
          isSel('biome', b.id),
          h('span', { class: 'act', title: open ? 'Collapse' : 'Expand', onclick: (e) => (e.stopPropagation(), open ? this.collapsed.add('b:' + b.id) : this.collapsed.delete('b:' + b.id), this.renderLeft()) }, open ? '▾' : '▸'),
        ),
      );
      if (open) {
        const kids = h('div', { class: 'kids' });
        for (const l of b.layers) kids.append(row(l.enabled === false ? '○' : '●', l.name, l.range && l.range <= 130 ? 'near' : '', pick({ type: 'layer', biome: b.id, id: l.id }), sel && sel.type === 'layer' && sel.id === l.id && sel.biome === b.id));
        t.append(kids);
      }
    });
    t.append(grp('Settlements', ['+ at view', () => {
      const c = app.cam.target;
      app.tools.addSettlement(c.x, c.z);
    }]));
    for (const s of d.settlements || []) t.append(row('⌂', s.name, `${d.structures.filter((q) => q.settlement === s.id).length} bldg`, pick({ type: 'settlement', id: s.id }), isSel('settlement', s.id)));
    t.append(grp('Structures', ['+ place', () => app.tools.setTool('structure')]));
    for (const s of d.structures) t.append(row('▣', s.name || (s.type === 'model' ? app.manifest.models[s.model]?.name || s.model : s.type), s.settlement ? 'auto' : '', pick({ type: 'structure', id: s.id }), isSel('structure', s.id)));
    t.append(grp('Objects', ['+ place', () => (this.setLeftTab('assets'), app.tools.setTool('place'))]));
    for (const o of d.objects) t.append(row(o.floating ? '◒' : '◆', app.manifest.models[o.model]?.name || o.model, o.floating ? 'floating' : '', pick({ type: 'object', id: o.id }), isSel('object', o.id)));
    return t;
  }

  assetBrowser() {
    const app = this.app;
    const m = app.manifest;
    const wrap = h('div');
    wrap.append(h('div', { class: 'seg', style: { marginBottom: '6px' } }, [['models', 'Models'], ['textures', 'Materials']].map(([k, l]) => h('button', { class: this.assetKind === k ? 'on' : '', onclick: () => ((this.assetKind = k), this.renderLeft()) }, l))));
    if (this.assetKind === 'models') {
      const cats = [...new Set(Object.values(m.models).map((v) => v.category))];
      wrap.append(h('div', { class: 'chips', style: { marginBottom: '6px' } }, cats.map((c) => h('span', { class: 'chip' + (c === this.assetCat ? ' on' : ''), onclick: () => ((this.assetCat = c), this.renderLeft()) }, CATEGORY_LABEL[c] || c))));
      const grid = h('div', { class: 'agrid' });
      for (const [id, v] of Object.entries(m.models)) {
        if (v.category !== this.assetCat) continue;
        const tile = h(
          'div',
          {
            class: 'atile' + (app.tools.placeModel === id ? ' on' : ''),
            title: `${v.name}\n${v.height.toFixed(2)} m tall · ${v.lods.map((l) => l.triangles).join(' / ')} tris\n${v.source?.authors?.join?.(', ') || ''} · ${v.source?.license || ''}`,
            onclick: () => {
              app.tools.placeModel = id;
              app.tools.structureType = v.category === 'structure' ? 'model' : app.tools.structureType;
              app.tools.setTool(v.category === 'structure' ? 'structure' : 'place');
              this.renderLeft();
            },
          },
          h('img', { loading: 'lazy', src: `/assets/thumbs/${id}.jpg`, alt: '', onerror: (e) => (e.target.style.visibility = 'hidden') }),
          h('div', null, v.name || id),
        );
        grid.append(tile);
      }
      wrap.append(grid, note('Click a model, then click in the viewport to place it. Scatter layers reference these models in the biome inspector. All assets are CC0 — see ASSETS.md.'));
    } else {
      const layerIdx = app.tools.paint.material;
      const layerName = MAT_NAMES[layerIdx];
      wrap.append(note(`Click a material to assign it to the ground layer “${MAT_LABELS[layerIdx]}” (choose the layer in the Paint tool or World ▸ Ground materials).`));
      const grid = h('div', { class: 'agrid' });
      const cur = app.world.project.materials.layers[layerName]?.texture;
      for (const [id, v] of Object.entries(m.textures)) {
        grid.append(
          h(
            'div',
            {
              class: 'atile' + (cur === id ? ' on' : ''),
              title: `${v.name || id}\nrole: ${v.role} · tile ${v.tileSizeM} m\n${v.source?.authors?.join?.(', ') || ''}`,
              onclick: () => app.edit('Assign ground material', (doc) => (doc.materials.layers[layerName] = { ...doc.materials.layers[layerName], texture: id }), 'materials'),
            },
            h('img', { loading: 'lazy', src: '/assets/' + v.files.diff, alt: '' }),
            h('div', null, v.name || id),
          ),
        );
      }
      wrap.append(grid);
    }
    return wrap;
  }

  // ------------------------------------------------------------------------------------
  // Right panels
  // ------------------------------------------------------------------------------------
  renderRight() {
    const st = this.rightPanel.scrollTop;
    clear(this.rightPanel);
    let c;
    try {
      c = this.rightTab === 'env' ? this.envPanel() : this.rightTab === 'water' ? this.waterPanel() : this.rightTab === 'world' ? this.worldPanel() : this.inspector();
    } catch (e) {
      c = note('Panel error: ' + e.message, 'err');
      console.error(e);
    }
    this.rightPanel.append(c);
    this.rightPanel.scrollTop = st;
  }

  /** Bound slider editing a document value with live preview and a single undo entry. */
  ds(label, get, set, min, max, step, kind, opts = {}) {
    const app = this.app;
    const doc = app.world.project;
    const key = opts.key || label;
    return slider(
      label,
      get(doc) ?? opts.def ?? min,
      min,
      max,
      step,
      (v) => app.edit(label, (d) => set(d, v), kind, { live: true, mergeKey: key }),
      (v) => app.edit(label, (d) => set(d, v), kind, { mergeKey: key }),
      opts,
    );
  }

  toolOptions() {
    const app = this.app;
    const tools = app.tools;
    const t = tools.active;
    const out = [];
    if (t === 'sculpt') {
      const b = tools.brush;
      out.push(
        section(
          'Sculpt brush',
          h('div', { class: 'chips' }, Object.entries(SCULPT_KINDS).map(([k, l]) => h('span', { class: 'chip' + (b.kind === k ? ' on' : ''), onclick: () => ((b.kind = k), this.renderRight()) }, l))),
          slider('Radius', b.radius, 2, 250, 1, (v) => (b.radius = v), null, { unit: 'm' }),
          slider('Strength', b.strength, 0.02, 1, 0.01, (v) => (b.strength = v)),
          slider('Hardness', b.hardness, 0, 0.95, 0.01, (v) => (b.hardness = v)),
          b.kind === 'terrace' ? slider('Step height', b.step, 0.5, 30, 0.5, (v) => (b.step = v), null, { unit: 'm' }) : null,
          b.kind === 'carve' ? slider('Channel depth', b.depth, 0.3, 20, 0.1, (v) => (b.depth = v), null, { unit: 'm' }) : null,
          note(
            b.kind === 'flatten'
              ? 'Flattens towards the height where the stroke starts.'
              : b.kind === 'carve'
                ? 'Cuts a channel whose bed only descends along the stroke, so water can follow it. For a river with flowing water use the River tool.'
                : b.kind === 'erode'
                  ? 'Runs droplet erosion under the brush: gullies form on slopes and sediment settles below.'
                  : 'Hold Shift to smooth, Ctrl to invert. Rivers, roads and foundations are re-applied on top of sculpted terrain.',
          ),
        ),
      );
    } else if (t === 'paint') {
      const p = tools.paint;
      const d = app.world.project;
      const groups = [...new Set(d.biomes.flatMap((b) => b.layers.map((l) => l.group || 'trees')))];
      out.push(
        section(
          'Paint',
          h('div', { class: 'chips' }, [['material', 'Ground material'], ['biome', 'Biome'], ['density', 'Scatter density'], ['exclude', 'Exclusion zone']].map(([k, l]) => h('span', { class: 'chip' + (p.mode === k ? ' on' : ''), onclick: () => ((p.mode = k), k !== 'exclude' && app.overlays.hideMask(), k === 'exclude' && app.overlays.showMask(app.world.paint.exclude, [1, 0.25, 0.2]), k === 'biome' && this.showBiomeOverlay(true), this.renderRight()) }, l))),
          p.mode === 'material' ? select('Layer', p.material, MAT_LABELS.map((l, i) => [i, l]), (v) => ((p.material = +v), this.renderLeft())) : null,
          p.mode === 'biome' ? select('Biome', p.biome, [[0, 'Automatic (rules)'], ...d.biomes.map((b, i) => [i + 1, b.name])], (v) => (p.biome = +v)) : null,
          p.mode === 'density' ? select('Layer group', p.group, groups, (v) => (p.group = v)) : null,
          p.mode === 'density' ? select('Action', p.densityTarget, [[0, 'Erase / thin out'], [255, 'Add / thicken']], (v) => (p.densityTarget = +v)) : null,
          slider('Radius', p.radius, 1.5, 250, 0.5, (v) => (p.radius = v), null, { unit: 'm' }),
          p.mode !== 'biome' && p.mode !== 'exclude' ? slider('Strength', p.strength, 0.05, 1, 0.01, (v) => (p.strength = v)) : null,
          note(p.mode === 'exclude' ? 'Nothing is scattered inside exclusion zones (shown in red). Ctrl+drag removes the zone.' : p.mode === 'density' ? 'Thins or thickens one scatter group without changing the biome rules. Ctrl+drag restores the rule density.' : p.mode === 'biome' ? 'Painted biomes override automatic selection; ground materials and scatter update on release. Ctrl+drag returns the area to automatic.' : 'Painted material overrides the rule-based ground cover. Ctrl+drag erases the override.'),
          p.mode === 'biome' ? checkbox('Show biome map', !!this._biomeOverlay, (v) => this.showBiomeOverlay(v)) : null,
        ),
      );
    } else if (t === 'river') {
      out.push(section('New river', slider('Width', tools.riverWidth ?? 8, 2, 40, 0.5, (v) => (tools.riverWidth = v), null, { unit: 'm' }), slider('Depth', tools.riverDepth ?? 0.7, 0.2, 4, 0.05, (v) => (tools.riverDepth = v), null, { unit: 'm' }), slider('Discharge', tools.riverFlow ?? 5, 0.2, 80, 0.1, (v) => (tools.riverFlow = v), null, { unit: 'm³/s' }), note('Click points from source to mouth. The channel is carved so the bed always descends; where the path climbs, a gorge is cut. Finish with Enter or a double-click.')));
    } else if (t === 'lake') {
      out.push(section('New lake', slider('Initial depth', tools.lakeDepth, 0.5, 30, 0.1, (v) => (tools.lakeDepth = v), null, { unit: 'm' }), note('Click the deepest point of a hollow. Water fills every connected cell below the level; adjust the level afterwards in the inspector.')));
    } else if (t === 'road' || t === 'trail') {
      const def = ROAD_DEFAULTS[t];
      out.push(section(t === 'road' ? 'New road' : 'New trail', note(`${t === 'road' ? 'Gravel road' : 'Foot trail'}: ${def.width} m wide, grades limited to ${(def.maxGrade * 100).toFixed(0)} %. The surface is graded with cut/fill banks and vegetation is cleared along it.`)));
    } else if (t === 'structure') {
      out.push(section('Structure', select('Type', tools.structureType, [['cabin', 'Timber cabin'], ['shed', 'Shed'], ['model', 'Model from asset browser']], (v) => ((tools.structureType = v), this.renderRight())), tools.structureType === 'model' ? note(tools.placeModel ? 'Model: ' + (app.manifest.models[tools.placeModel]?.name || tools.placeModel) : 'Choose a model in Assets ▸ Structures.', tools.placeModel ? '' : 'warn') : null, slider('Rotation', deg(tools.placeRot), -180, 180, 1, (v) => (tools.placeRot = rad(v)), null, { unit: '°' }), note('Sites under water, too close to water, on a road or steeper than the structure rule are rejected. The foundation pad is levelled and vegetation cleared.')));
    } else if (t === 'place') {
      out.push(section('Place object', note(tools.placeModel ? 'Model: ' + (app.manifest.models[tools.placeModel]?.name || tools.placeModel) : 'Choose a model in the Assets tab.', tools.placeModel ? '' : 'warn'), slider('Scale', tools.placeScale, 0.2, 5, 0.05, (v) => (tools.placeScale = v)), slider('Rotation', deg(tools.placeRot), -180, 180, 1, (v) => (tools.placeRot = rad(v)), null, { unit: '°' }), checkbox('Floating (when placed on water)', tools.placeFloating, (v) => (tools.placeFloating = v))));
    } else if (t === 'interact') {
      out.push(section('Touch water', note('Click on water to drop a stone, drag to stir. Ripples are solved with a dispersive wave model, reflect off the shore and drift with the river current. Floating objects can be dragged with the Select tool.')));
    }
    return out;
  }

  inspector() {
    const app = this.app;
    const w = app.world;
    const d = w.project;
    const sel = app.selection;
    const wrap = h('div');
    for (const s of this.toolOptions()) wrap.append(s);
    if (!sel) {
      if (app.tools.active === 'select')
        wrap.append(
          h('div', { class: 'title' }, d.name),
          section('Project', h('div', { class: 'kv' }, 'Terrain', h('b', null, `${d.terrain.size} × ${d.terrain.size} m, ${w.res}² samples (${w.hFinal.cell.toFixed(2)} m)`), 'Seed', h('b', null, String(d.seed)), 'Water', h('b', null, `${d.water.rivers.length} river(s), ${d.water.lakes.length} lake(s)${d.water.sea.enabled ? ', sea' : ''}`), 'Biomes', h('b', null, String(d.biomes.length)), 'Structures', h('b', null, String(d.structures.length)), 'Objects', h('b', null, String(d.objects.length))), text('Notes', d.notes, (v) => app.edit('Edit notes', (q) => (q.notes = v), 'none'))),
          note('Select something in the viewport or the scene tree to edit it, or pick a tool on the left. Press F1 for the control guide.'),
        );
      return wrap;
    }
    const it = app.resolve();
    const del = () => button('Delete', () => app.deleteSelection(), { class: 'danger' });
    const nameField = (kind) => text('Name', it.name, (v) => app.edit('Rename', () => (app.resolve().name = v), kind));
    if (sel.type === 'sea') {
      wrap.append(h('div', { class: 'title' }, 'Sea'), this.seaSection(), note('More sea state (swell, wind waves) in the Water tab.'));
    } else if (sel.type === 'lake' && it) {
      const i = d.water.lakes.indexOf(it);
      const cells = w.water.stats.lakeCells?.[i] || 0;
      const ground = w.heightAt(it.x, it.z);
      wrap.append(
        h('div', { class: 'title' }, it.name, h('small', null, 'lake')),
        section('Lake', nameField('none'), this.ds('Water level', () => it.level, () => 0, Math.floor(ground - 2), Math.ceil(ground + 40), 0.05, 'water', { unit: 'm', key: 'lakeLevel' + it.id, hardMin: -1e4, hardMax: 1e4 }), h('div', { class: 'kv' }, 'Surface area', h('b', null, `${((cells * w.hFinal.cell ** 2) / 1e4).toFixed(2)} ha`), 'Depth at marker', h('b', null, `${Math.max(0, it.level - ground).toFixed(2)} m`)), cells === 0 ? note('The marker is above the water level — lower the marker (drag it into the basin) or raise the level.', 'warn') : null, note('Raising or lowering the level floods or exposes the shore; banks, reeds and ground materials follow.'), h('div', { class: 'rowbtns' }, del())),
      );
      // the level slider needs a real setter (closure over the item id)
      const sl = wrap.querySelector('.sec-body .field:nth-child(2)');
      sl.replaceWith(this.ds('Water level', () => app.resolve()?.level, (doc, v) => (doc.water.lakes.find((l) => l.id === sel.id).level = v), Math.floor(ground - 2), Math.ceil(ground + 40), 0.05, 'water', { unit: 'm', key: 'lakeLevel' + sel.id, hardMin: -1e4, hardMax: 1e4 }));
    } else if ((sel.type === 'river' || (sel.type === 'node' && sel.path === 'river')) && (it || app.tools.pathOf(sel))) {
      const r = it || app.tools.pathOf(sel);
      const set = (k) => (doc, v) => (doc.water.rivers.find((q) => q.id === r.id)[k] = v);
      const c = w.compiled.rivers[d.water.rivers.indexOf(r)];
      const P = (k) => r[k] ?? RIVER_DEFAULTS[k];
      wrap.append(h('div', { class: 'title' }, r.name, h('small', null, 'river')));
      wrap.append(
        section(
          'Channel',
          text('Name', r.name, (v) => app.edit('Rename', (doc) => (doc.water.rivers.find((q) => q.id === r.id).name = v), 'none')),
          this.ds('Width', () => P('width'), set('width'), 2, 60, 0.5, 'modifiers', { unit: 'm', key: 'rw' + r.id }),
          this.ds('Depth', () => P('depth'), set('depth'), 0.15, 5, 0.05, 'modifiers', { unit: 'm', key: 'rd' + r.id }),
          this.ds('Bank width', () => P('bankWidth'), set('bankWidth'), 1, 30, 0.5, 'modifiers', { unit: 'm', key: 'rb' + r.id }),
          this.ds('Bank slope', () => P('bankSlope'), set('bankSlope'), 0.1, 1.5, 0.01, 'modifiers', { key: 'rs' + r.id }),
          this.ds('Bed roughness', () => P('bedRoughness'), set('bedRoughness'), 0, 1, 0.01, 'modifiers', { key: 'rr' + r.id }),
          this.ds('Pools & riffles', () => P('poolRiffle'), set('poolRiffle'), 0, 1, 0.01, 'modifiers', { key: 'rp' + r.id }),
          this.ds('Bend asymmetry', () => P('meanderDepth'), set('meanderDepth'), 0, 1, 0.01, 'modifiers', { key: 'rm' + r.id }),
        ),
        section('Flow', this.ds('Discharge', () => P('flow'), set('flow'), 0.2, 120, 0.1, 'water', { unit: 'm³/s', key: 'rq' + r.id }), c ? h('div', { class: 'kv' }, 'Length', h('b', null, `${c.sp.length.toFixed(0)} m`), 'Total drop', h('b', null, `${(c.surf[0] - c.surf[c.sp.n - 1]).toFixed(1)} m`), 'Mean gradient', h('b', null, `${(((c.surf[0] - c.surf[c.sp.n - 1]) / c.sp.length) * 100).toFixed(2)} %`), 'Mean velocity', h('b', null, `${(P('flow') / (P('width') * P('depth') * 0.62)).toFixed(2)} m/s (Q / A)`)) : null, note('Velocity comes from a depth-averaged flow solve over the carved bed: it speeds up through narrows and shallows and splits around boulders. Foam appears where the Froude number approaches 1.')),
      );
      if (sel.type === 'node') {
        const n = r.nodes[sel.index];
        const setN = (k) => (doc, v) => (doc.water.rivers.find((q) => q.id === r.id).nodes[sel.index][k] = v);
        wrap.append(section(`Point ${sel.index + 1} of ${r.nodes.length}`, this.ds('Width here', () => n.width ?? P('width'), setN('width'), 2, 60, 0.5, 'modifiers', { unit: 'm', key: 'nw' + r.id + sel.index }), this.ds('Depth here', () => n.depth ?? P('depth'), setN('depth'), 0.15, 5, 0.05, 'modifiers', { unit: 'm', key: 'nd' + r.id + sel.index }), h('div', { class: 'rowbtns' }, button('Delete point', () => app.tools.deleteNode(sel), { class: 'danger' }), button('Reset overrides', () => app.edit('Reset point', (doc) => { const q = doc.water.rivers.find((x) => x.id === r.id).nodes[sel.index]; delete q.width; delete q.depth; }, 'modifiers')))));
      }
      wrap.append(note('Drag the white points to reroute the river — the old channel heals and a new one is carved. Shift+click on the line inserts a point.'), h('div', { class: 'rowbtns' }, button('Delete river', () => (app.select({ type: 'river', id: r.id }), app.deleteSelection()), { class: 'danger' })));
    } else if ((sel.type === 'road' || (sel.type === 'node' && sel.path === 'road')) && (it || app.tools.pathOf(sel))) {
      const r = it || app.tools.pathOf(sel);
      const def = ROAD_DEFAULTS[r.kind === 'trail' ? 'trail' : 'road'];
      const set = (k) => (doc, v) => (doc.roads.find((q) => q.id === r.id)[k] = v);
      wrap.append(
        h('div', { class: 'title' }, r.name, h('small', null, r.kind)),
        section('Path', text('Name', r.name, (v) => app.edit('Rename', (doc) => (doc.roads.find((q) => q.id === r.id).name = v), 'none')), select('Kind', r.kind, [['road', 'Gravel road'], ['trail', 'Foot trail']], (v) => app.edit('Change path kind', (doc) => (doc.roads.find((q) => q.id === r.id).kind = v), 'modifiers')), this.ds('Width', () => r.width ?? def.width, set('width'), 0.8, 14, 0.1, 'modifiers', { unit: 'm', key: 'pw' + r.id }), this.ds('Max grade', () => (r.maxGrade ?? def.maxGrade) * 100, (doc, v) => (doc.roads.find((q) => q.id === r.id).maxGrade = v / 100), 3, 40, 1, 'modifiers', { unit: '%', key: 'pg' + r.id }), this.ds('Shoulder', () => r.shoulder ?? def.shoulder, set('shoulder'), 0.2, 5, 0.1, 'modifiers', { unit: 'm', key: 'ps' + r.id })),
        sel.type === 'node' ? h('div', { class: 'rowbtns' }, button('Delete point', () => app.tools.deleteNode(sel), { class: 'danger' })) : null,
        note('The path is graded into the terrain with cut and fill banks; trees, shrubs and grass are cleared along it.'),
        (() => {
          const c = app.world.compiled.roads[app.world.project.roads.findIndex((q) => q.id === r.id)];
          if (!c) return null;
          const lim = r.maxGrade ?? def.maxGrade;
          return c.steepest > lim * 1.15
            ? h('div', { class: 'note warn' }, `Steepest section: ${(c.steepest * 100).toFixed(0)} % (limit ${(lim * 100).toFixed(0)} %). The ground here is too steep to hold the grade within ${c.maxEarth} m of cut and fill — reroute the path across the slope (add points) to ease it.`)
            : note(`Steepest section: ${(c.steepest * 100).toFixed(0)} %.`);
        })(),
        h('div', { class: 'rowbtns' }, button('Delete path', () => (app.select({ type: 'road', id: r.id }), app.deleteSelection()), { class: 'danger' })),
      );
    } else if (sel.type === 'structure' && it) {
      const set = (k) => (doc, v) => (doc.structures.find((q) => q.id === sel.id)[k] = v);
      wrap.append(
        h('div', { class: 'title' }, it.type === 'model' ? app.manifest.models[it.model]?.name || it.model : it.type === 'cabin' ? 'Timber cabin' : 'Shed', h('small', null, 'structure')),
        section('Transform', number('X', it.x, 0.1, (v) => app.edit('Move structure', (doc) => set('x')(doc, v), 'modifiers'), { unit: 'm' }), number('Z', it.z, 0.1, (v) => app.edit('Move structure', (doc) => set('z')(doc, v), 'modifiers'), { unit: 'm' }), this.ds('Rotation', () => deg(it.rot || 0), (doc, v) => set('rot')(doc, rad(v)), -180, 180, 1, 'modifiers', { unit: '°', key: 'sr' + sel.id }), it.type === 'model' ? this.ds('Scale', () => it.scale || 1, set('scale'), 0.2, 4, 0.01, 'objects', { key: 'ss' + sel.id }) : null),
        it.type !== 'model' ? section('Building', this.ds('Variant', () => it.variant || 0, (doc, v) => set('variant')(doc, Math.round(v)), 0, 999, 1, 'modifiers', { key: 'sv' + sel.id }), checkbox('Chimney', it.chimney ?? true, (v) => app.edit('Toggle chimney', (doc) => set('chimney')(doc, v), 'modifiers')), checkbox('Porch', it.porch ?? false, (v) => app.edit('Toggle porch', (doc) => set('porch')(doc, v), 'modifiers')), note(`Foundation level ${w.structureLevel(it).toFixed(2)} m. The stone plinth extends below grade so the building stays grounded on slopes.`)) : null,
        it.settlement ? note('Placed by a settlement rule. Moving it by hand detaches it so regeneration will not replace it.') : null,
        h('div', { class: 'rowbtns' }, del()),
      );
    } else if (sel.type === 'settlement' && it) {
      const set = (k) => (doc, v) => (doc.settlements.find((q) => q.id === sel.id)[k] = v);
      const setR = (k) => (doc, v) => (doc.settlements.find((q) => q.id === sel.id).rules[k] = v);
      const regen = () => app.tools.regenerateSettlement(sel.id);
      const sl = (label, get, setter, a, b, st, o) => slider(label, get(), a, b, st, null, (v) => (app.edit(label, (doc) => setter(doc, v), 'none'), regen()), o);
      wrap.append(
        h('div', { class: 'title' }, it.name, h('small', null, 'settlement rule')),
        section('Placement rules', text('Name', it.name, (v) => app.edit('Rename', (doc) => set('name')(doc, v), 'none')), sl('Buildings', () => it.count, (doc, v) => set('count')(doc, Math.round(v)), 1, 30, 1), sl('Radius', () => it.radius, set('radius'), 20, 300, 1, { unit: 'm' }), sl('Seed', () => it.seed, (doc, v) => set('seed')(doc, Math.round(v)), 1, 999, 1), sl('Max slope', () => deg(Math.atan(it.rules.maxSlope)), (doc, v) => setR('maxSlope')(doc, Math.tan(rad(v))), 3, 35, 1, { unit: '°' }), sl('Min water dist', () => it.rules.minWaterDist, setR('minWaterDist'), 2, 60, 1, { unit: 'm' }), sl('Min spacing', () => it.rules.minSpacing, setR('minSpacing'), 8, 80, 1, { unit: 'm' }), sl('Max road dist', () => it.rules.maxRoadDist ?? 45, setR('maxRoadDist'), 10, 200, 1, { unit: 'm' })),
        note(`${d.structures.filter((q) => q.settlement === sel.id).length} building(s) currently follow this rule. Buildings face the nearest road. Hand-moved buildings are kept when the rule regenerates.`),
        h('div', { class: 'rowbtns' }, button('Regenerate', regen), del()),
      );
    } else if (sel.type === 'object' && it) {
      const info = app.manifest.models[it.model];
      const set = (k) => (doc, v) => (doc.objects.find((q) => q.id === sel.id)[k] = v);
      const body = app.engine.objects.objects.get(sel.id)?.body;
      wrap.append(
        h('div', { class: 'title' }, info?.name || it.model, h('small', null, it.floating ? 'floating object' : 'object')),
        section('Transform', number('X', it.x, 0.1, (v) => app.edit('Move object', (doc) => set('x')(doc, v), 'objects'), { unit: 'm' }), number('Z', it.z, 0.1, (v) => app.edit('Move object', (doc) => set('z')(doc, v), 'objects'), { unit: 'm' }), this.ds('Rotation', () => deg(it.rot || 0), (doc, v) => set('rot')(doc, rad(v)), -180, 180, 1, 'objects', { unit: '°', key: 'or' + sel.id }), this.ds('Scale', () => it.scale || 1, set('scale'), 0.1, 6, 0.01, 'objects', { key: 'os' + sel.id }), !it.floating ? this.ds('Sink into ground', () => it.sink ?? 0, set('sink'), 0, 0.8, 0.01, 'objects', { key: 'ok' + sel.id }) : null),
        section(
          'Buoyancy',
          checkbox('Floating (rigid body on water)', !!it.floating, (v) => app.edit('Toggle floating', (doc) => set('floating')(doc, v || undefined), 'objects')),
          it.floating ? this.ds('Relative density', () => it.density ?? 0.45, set('density'), 0.1, 0.95, 0.01, 'objects', { key: 'od' + sel.id, title: 'Fraction of the hull below the waterline at rest' }) : null,
          it.floating && body ? h('div', { class: 'rowbtns' }, button('Push', () => { const f = app.cam.forward({ set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } }); body.vel.x += f.x * 2.2; body.vel.z += f.z * 2.2; }, { title: 'Shove it away from the camera' }), button('Lift & drop', () => { body.pos.y += 1.5; body.vel.set(0, 0, 0); }, { title: 'Raise it 1.5 m and let it fall back into the water' }), button('Rock', () => body.angVel.set(1.5, 0, 1.0))) : null,
          it.floating ? note('Buoyancy is integrated per hull sample point against the simulated surface; drag relative to the current carries it downstream, and its motion feeds the ripple solver. Drag it with the mouse to tow it.') : null,
        ),
        h('div', { class: 'rowbtns' }, del()),
      );
    } else if (sel.type === 'instance') {
      const info = app.manifest.models[sel.modelId];
      wrap.append(h('div', { class: 'title' }, info?.name || sel.modelId, h('small', null, 'scattered instance')), section('Instance', h('div', { class: 'kv' }, 'Layer', h('b', null, sel.layerKey), 'Position', h('b', null, `${sel.x.toFixed(1)}, ${sel.z.toFixed(1)}`), 'Scale', h('b', null, sel.scale.toFixed(2))), note('This instance is generated by a biome rule. Detach it to move, rotate or scale it individually; the rule will not put it back when the biome regenerates.'), h('div', { class: 'rowbtns' }, button('Detach & edit', () => app.tools.detachInstance(sel), { class: 'primary' }), button('Remove', () => app.tools.deleteInstance(sel), { class: 'danger' }), button('Edit layer rule', () => app.select({ type: 'layer', biome: sel.layerKey.split('/')[0], id: sel.layerId })))));
    } else if (sel.type === 'biome' && it) {
      wrap.append(this.biomeInspector(it));
    } else if (sel.type === 'layer' && it) {
      wrap.append(this.layerInspector(sel, it));
    } else wrap.append(note('The selected item no longer exists.'));
    return wrap;
  }

  biomeInspector(b) {
    const app = this.app;
    const d = app.world.project;
    const bi = d.biomes.indexOf(b);
    const B = (doc) => doc.biomes.find((q) => q.id === b.id);
    const a = b.auto || {};
    const setA = (k) => (doc, v) => ((B(doc).auto = B(doc).auto || {}), (B(doc).auto[k] = v));
    const mats = MAT_NAMES.slice(0, 8).map((n, i) => [n, MAT_LABELS[i]]);
    const wrap = h('div');
    // coverage statistics
    let cells = 0;
    const map = app.world.biomeMap;
    for (let i = 0; i < map.length; i += 7) if (map[i] === bi + 1) cells++;
    wrap.append(
      h('div', { class: 'title' }, b.name, h('small', null, `biome · ${(((cells * 7) / map.length) * 100).toFixed(1)} % of the map`)),
      section('Biome', text('Name', b.name, (v) => app.edit('Rename biome', (doc) => (B(doc).name = v), 'none')), select('Ground cover', b.ground?.primary || 'grass', mats, (v) => app.edit('Biome ground', (doc) => ((B(doc).ground = B(doc).ground || {}), (B(doc).ground.primary = v)), 'ground')), select('Secondary', b.ground?.secondary || '', [['', 'none'], ...mats], (v) => app.edit('Biome ground', (doc) => ((B(doc).ground = B(doc).ground || {}), (B(doc).ground.secondary = v || undefined)), 'ground')), b.ground?.secondary ? this.ds('Secondary amount', () => b.ground.secondaryAmount ?? 0.5, (doc, v) => (B(doc).ground.secondaryAmount = v), 0, 1, 0.01, 'ground', { key: 'bsa' + b.id }) : null),
      section('Where it grows (automatic)', checkbox('Enabled for automatic selection', a.enabled !== false, (v) => app.edit('Biome auto', (doc) => setA('enabled')(doc, v), 'ground')), this.ds('Priority', () => a.priority ?? 0, (doc, v) => setA('priority')(doc, Math.round(v)), 0, 10, 1, 'ground', { key: 'bp' + b.id, title: 'Higher priority biomes are tested first' }), this.ds('Altitude min', () => a.altMin ?? -100, setA('altMin'), -100, 4000, 5, 'ground', { unit: 'm', key: 'ba0' + b.id }), this.ds('Altitude max', () => a.altMax ?? 4000, setA('altMax'), -100, 4000, 5, 'ground', { unit: 'm', key: 'ba1' + b.id }), this.ds('Max slope', () => deg(Math.atan(a.slopeMax ?? 3)), (doc, v) => setA('slopeMax')(doc, Math.tan(rad(v))), 2, 72, 1, 'ground', { unit: '°', key: 'bs' + b.id }), this.ds('Moisture min', () => a.moistMin ?? 0, setA('moistMin'), 0, 1, 0.01, 'ground', { key: 'bm0' + b.id }), this.ds('Moisture max', () => a.moistMax ?? 1, setA('moistMax'), 0, 1, 0.01, 'ground', { key: 'bm1' + b.id }), this.ds('Max dist. to water', () => a.shoreMax ?? 64, setA('shoreMax'), 1, 64, 1, 'ground', { unit: 'm', key: 'bsh' + b.id, title: '64 = no limit' })),
      section('Scatter layers', ...b.layers.map((l) => h('div', { class: 'field' }, h('span', { class: 'lbl', style: { flex: '1', color: 'var(--txt)', cursor: 'pointer' }, onclick: () => app.select({ type: 'layer', biome: b.id, id: l.id }) }, l.name), h('span', { class: 'unit', style: { width: 'auto' } }, `${l.models.length} model(s)`))), h('div', { class: 'rowbtns' }, button('+ Layer', () => { const id = newId('layer'); app.edit('Add scatter layer', (doc) => B(doc).layers.push({ id, name: 'New layer', group: 'rocks', models: [], spacing: 8, density: 0.3, slope: [0, 0.8, 0.2], scale: [0.8, 1.2] }), 'ground'); app.select({ type: 'layer', biome: b.id, id }); }), button('Paint this biome', () => { app.tools.paint.mode = 'biome'; app.tools.paint.biome = bi + 1; app.tools.setTool('paint'); this.showBiomeOverlay(true); }))),
      note('Changing a rule regenerates ground materials and scatter for the whole map (undoable). Hand-detached objects, painted masks and exclusion zones are preserved.'),
      h('div', { class: 'rowbtns' }, checkbox('Show biome map', !!this._biomeOverlay, (v) => this.showBiomeOverlay(v)), button('Remove biome', () => (app.select(null), app.edit('Remove biome', (doc) => doc.biomes.splice(doc.biomes.findIndex((q) => q.id === b.id), 1), 'ground')), { class: 'danger', disabled: d.biomes.length <= 1 })),
    );
    return wrap;
  }

  layerInspector(sel, l) {
    const app = this.app;
    const L = (doc) => doc.biomes.find((q) => q.id === sel.biome).layers.find((q) => q.id === sel.id);
    const key = sel.biome + sel.id;
    const rng = (label, prop, def, a, b, st, unit, conv = [(x) => x, (x) => x]) => [
      this.ds(label + ' min', () => conv[0]((l[prop] || def)[0]), (doc, v) => { const q = L(doc); q[prop] = [...(q[prop] || def)]; q[prop][0] = conv[1](v); }, a, b, st, 'ground', { unit, key: key + prop + 0 }),
      this.ds(label + ' max', () => conv[0](Math.min((l[prop] || def)[1], conv[1](b))), (doc, v) => { const q = L(doc); q[prop] = [...(q[prop] || def)]; q[prop][1] = conv[1](v); }, a, b, st, 'ground', { unit, key: key + prop + 1 }),
    ];
    const slopeConv = [(t) => deg(Math.atan(t)), (dg) => Math.tan(rad(dg))];
    const wrap = h('div');
    const isDetail = (l.range ?? 1e9) <= 130;
    wrap.append(
      h('div', { class: 'title' }, l.name, h('small', null, 'scatter layer')),
      section('Layer', text('Name', l.name, (v) => app.edit('Rename layer', (doc) => (L(doc).name = v), 'none')), checkbox('Enabled', l.enabled !== false, (v) => app.edit('Toggle layer', (doc) => (L(doc).enabled = v), 'ground')), this.ds('Density', () => l.density ?? 1, (doc, v) => (L(doc).density = v), 0, 1, 0.01, 'ground', { key: key + 'dn' }), this.ds('Spacing', () => l.spacing, (doc, v) => (L(doc).spacing = v), isDetail ? 0.3 : 1.5, isDetail ? 6 : 40, 0.05, 'ground', { unit: 'm', key: key + 'sp', title: 'Candidate grid spacing; changing it reshuffles this layer' }), this.ds('Clumping', () => l.cluster ?? 0.5, (doc, v) => (L(doc).cluster = v), 0, 1, 0.01, 'ground', { key: key + 'cl' }), this.ds('Clump size', () => l.clusterScale ?? 40, (doc, v) => (L(doc).clusterScale = v), 3, 200, 1, 'ground', { unit: 'm', key: key + 'cs' }), ...rng('Scale', 'scale', [0.8, 1.2], 0.1, 4, 0.01, '×'), isDetail ? note('Near-camera detail layer: generated around the viewer, not stored or exported as instances.') : null),
      section('Site rules', ...rng('Slope', 'slope', [0, 0.7, 0.15], 0, 70, 1, '°', slopeConv), ...rng('Altitude', 'altitude', [-200, 5000, 0], -200, 5000, 5, 'm'), ...rng('Moisture', 'moisture', [0, 1, 0], 0, 1, 0.01, ''), this.ds('Min dist. to water', () => (l.waterDist || [0.5])[0], (doc, v) => { const q = L(doc); q.waterDist = [...(q.waterDist || [0.5, 1e9, 0])]; q.waterDist[0] = v; }, -5, 60, 0.1, 'ground', { unit: 'm', key: key + 'wd0' }), this.ds('Max dist. to water', () => Math.min((l.waterDist || [0, 200])[1], 200), (doc, v) => { const q = L(doc); q.waterDist = [...(q.waterDist || [0.5, 1e9, 0])]; q.waterDist[1] = v >= 200 ? 1e9 : v; }, 0, 200, 1, 'ground', { unit: 'm', key: key + 'wd1', title: '200 = no limit' }), this.ds('Max water depth', () => l.maxDepth ?? 0, (doc, v) => (L(doc).maxDepth = v), 0, 3, 0.05, 'ground', { unit: 'm', key: key + 'md', title: '0 = never stands in water' }), checkbox('Keep off roads / foundations', !l.ignoreClearing, (v) => app.edit('Layer clearing', (doc) => (L(doc).ignoreClearing = !v), 'ground')), checkbox('Deflects river flow (obstacle)', !!l.obstacle, (v) => app.edit('Layer obstacle', (doc) => (L(doc).obstacle = v), 'water'))),
      section('Models', ...l.models.map((m, i) => h('div', { class: 'field' }, h('span', { class: 'lbl', style: { flex: '1 1 110px', color: 'var(--txt)' }, title: m.id }, app.manifest.models[m.id]?.name || m.id), h('input', { type: 'number', class: 'num', step: 0.1, min: 0, value: (m.weight ?? 1).toFixed(2), title: 'Weight', onchange: (e) => app.edit('Model weight', (doc) => (L(doc).models[i].weight = Math.max(0, +e.target.value)), 'ground') }), h('input', { type: 'number', class: 'num', step: 0.05, min: 0.05, value: (m.scale ?? 1).toFixed(2), title: 'Scale multiplier', onchange: (e) => app.edit('Model scale', (doc) => (L(doc).models[i].scale = Math.max(0.05, +e.target.value)), 'ground') }), button('✕', () => app.edit('Remove model', (doc) => L(doc).models.splice(i, 1), 'ground'), { class: 'small danger' }))), h('div', { class: 'rowbtns' }, button(app.tools.placeModel ? `+ ${app.manifest.models[app.tools.placeModel]?.name || app.tools.placeModel}` : '+ model (pick one in Assets first)', () => app.edit('Add model to layer', (doc) => L(doc).models.push({ id: app.tools.placeModel, weight: 1, scale: 1 }), 'ground'), { disabled: !app.tools.placeModel || l.models.some((m) => m.id === app.tools.placeModel) })), note('Columns: weight, scale multiplier.')),
      h('div', { class: 'rowbtns' }, button('Paint density', () => { app.tools.paint.mode = 'density'; app.tools.paint.group = l.group || 'trees'; app.tools.setTool('paint'); }), button('Delete layer', () => (app.select({ type: 'biome', id: sel.biome }), app.edit('Delete layer', (doc) => { const b = doc.biomes.find((q) => q.id === sel.biome); b.layers.splice(b.layers.findIndex((q) => q.id === sel.id), 1); }, 'ground')), { class: 'danger' })),
    );
    return wrap;
  }

  showBiomeOverlay(on) {
    const app = this.app;
    this._biomeOverlay = on;
    if (!on) return app.overlays.hideMask();
    const pal = [[0, 0, 0], ...app.world.project.biomes.map((b) => { const c = b.color || '#888888'; return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255); })];
    app.overlays.showMask(app.world.biomeMap, pal, 0.6);
  }

  seaSection() {
    const app = this.app;
    const sea = app.world.project.water.sea;
    return section('Sea', checkbox('Enabled', sea.enabled, (v) => app.edit('Toggle sea', (d) => (d.water.sea.enabled = v), 'water')), this.ds('Sea level', (d) => d.water.sea.level, (d, v) => (d.water.sea.level = v), Math.floor(sea.level - 15), Math.ceil(sea.level + 15), 0.05, 'water', { unit: 'm', key: 'sealevel', hardMin: -1e4, hardMax: 1e4 }), note('Changing the level re-floods from the map edge: beaches widen or drown, the surf line and wet sand follow.'));
  }

  envPanel() {
    const app = this.app;
    const e = (k) => (d) => d.env[k];
    const s = (k) => (d, v) => (d.env[k] = v);
    const wrap = h('div');
    const sun = app.engine.atmosphere.sunDir;
    wrap.append(
      section('Sun', this.ds('Time of day', e('timeOfDay'), s('timeOfDay'), 0, 24, 0.05, 'env', { unit: 'h' }), this.ds('Sun path rotation', e('sunAzimuth'), s('sunAzimuth'), 0, 360, 1, 'env', { unit: '°', title: 'Rotates the whole sun path around the scene (compass offset)' }), this.ds('Latitude', e('latitude'), s('latitude'), -66, 66, 1, 'env', { unit: '°' }), this.ds('Day of year', e('dayOfYear'), s('dayOfYear'), 1, 365, 1, 'env'), h('div', { class: 'kv' }, 'Sun elevation', h('b', null, `${deg(Math.asin(sun.y)).toFixed(1)}°`)), h('div', { class: 'rowbtns' }, ...[['Dawn', 6.1], ['Morning', 9], ['Noon', 12.5], ['Golden hour', 18.6], ['Dusk', 20.3]].map(([l, t]) => button(l, () => app.edit('Time of day', (d) => (d.env.timeOfDay = t), 'env'), { class: 'small' })))),
      section('Sky & atmosphere', this.ds('Haze (turbidity)', e('turbidity'), s('turbidity'), 1, 8, 0.05, 'env'), this.ds('Cloud cover', e('cloudCover'), s('cloudCover'), 0, 1, 0.01, 'env'), this.ds('Cloud base', e('cloudHeight'), s('cloudHeight'), 400, 5000, 10, 'env', { unit: 'm' }), this.ds('Cloud drift', e('cloudSpeed'), s('cloudSpeed'), 0, 40, 0.5, 'env', { unit: 'm/s' }), this.ds('Valley fog', e('fogDensity'), s('fogDensity'), 0, 1, 0.01, 'env'), this.ds('Fog depth', e('fogHeight'), s('fogHeight'), 20, 1500, 5, 'env', { unit: 'm' })),
      section('Wind', this.ds('Direction', (d) => deg(d.env.windDir), (d, v) => (d.env.windDir = rad(v)), 0, 360, 1, 'wind', { unit: '°', title: 'Direction the wind blows towards (0° = +X / east)' }), this.ds('Speed', e('windSpeed'), s('windSpeed'), 0, 20, 0.1, 'wind', { unit: 'm/s' }), note('Wind drives vegetation sway, the wave spectrum (lake ripples, sea state), fetch-limited sheltering in the lee of shores, and cloud drift.')),
      section('Camera exposure', checkbox('Automatic metering', app.world.project.env.autoExposure !== false, (v) => app.edit('Auto exposure', (d) => (d.env.autoExposure = v), 'env')), this.ds('Exposure compensation', e('exposure'), s('exposure'), -3, 3, 0.05, 'env', { unit: 'EV' }), note('Scene-referred HDR is tone-mapped with AgX. No colour grading, vignette or depth of field is applied.')),
    );
    return wrap;
  }

  waterPanel() {
    const app = this.app;
    const d = app.world.project;
    const w = (k, def) => (doc) => doc.water[k] ?? def;
    const s = (k) => (doc, v) => (doc.water[k] = v);
    const o = d.water.optics;
    const wrap = h('div');
    wrap.append(
      this.seaSection(),
      section('Swell (sea)', this.ds('Offshore height', (doc) => doc.water.swell.height, (doc, v) => (doc.water.swell.height = v), 0, 3, 0.01, 'water', { unit: 'm' }), this.ds('Period', (doc) => doc.water.swell.period, (doc, v) => (doc.water.swell.period = v), 4, 16, 0.1, 'water', { unit: 's' }), this.ds('Direction', (doc) => deg(doc.water.swell.dir), (doc, v) => (doc.water.swell.dir = rad(v)), 0, 360, 1, 'water', { unit: '°', title: 'Direction of travel (0° = +X)' }), note('Swell is refracted over the sea bed (eikonal phase with the dispersion relation), shoals, and breaks where its height exceeds 0.78 × depth; run-up follows.')),
      section('Flow', checkbox('Show flow speed', app.engine.water.U.uFlowViz.value > 0.5, (v) => (app.engine.water.U.uFlowViz.value = v ? 1 : 0)), note('Colours the water by the solved current: blue 0 m/s, green 1, yellow 2, red 3 m/s and more; streaks move with the flow. View option only — not saved, not exported.')),
      section('Surface', this.ds('Wind-wave scale', w('waveScale', 1), s('waveScale'), 0, 2, 0.01, 'env'), this.ds('Lake ripple scale', w('lakeWaveScale', 1), s('lakeWaveScale'), 0, 2, 0.01, 'env'), this.ds('River turbulence', w('riverWaveScale', 1), s('riverWaveScale'), 0, 2, 0.01, 'env'), this.ds('Foam', w('foamAmount', 1), s('foamAmount'), 0, 2, 0.01, 'env'), this.ds('Caustics', w('causticStrength', 1), s('causticStrength'), 0, 2, 0.01, 'env'), note('Wind speed and direction (Sky & light tab) set the wave spectrum itself.')),
      section(
        'Optics',
        select('Water type', Object.keys(WATER_PRESETS).find((k) => JSON.stringify(WATER_PRESETS[k].absorb) === JSON.stringify(o.absorb)) || 'custom', [...Object.entries(WATER_PRESETS).map(([k, v]) => [k, v.label]), ['custom', 'Custom']], (v) => WATER_PRESETS[v] && app.edit('Water type', (doc) => (doc.water.optics = { ...WATER_PRESETS[v] }), 'env')),
        this.ds('Turbidity', (doc) => doc.water.optics.turbidity, (doc, v) => (doc.water.optics.turbidity = v), 0, 1.5, 0.01, 'env'),
        ...['Red', 'Green', 'Blue'].map((n, i) => this.ds(`Absorption ${n}`, (doc) => doc.water.optics.absorb[i], (doc, v) => (doc.water.optics.absorb[i] = v), 0.01, 2, 0.005, 'env', { unit: '/m', key: 'abs' + i })),
        ...['Red', 'Green', 'Blue'].map((n, i) => this.ds(`Scattering ${n}`, (doc) => doc.water.optics.scatter[i], (doc, v) => (doc.water.optics.scatter[i] = v), 0, 0.5, 0.002, 'env', { unit: '/m', key: 'sca' + i })),
        note('Beer–Lambert attenuation along the refracted path; body colour from the absorption / back-scatter ratio. Turbid water hides the bed sooner and suppresses caustics.'),
      ),
    );
    return wrap;
  }

  worldPanel() {
    const app = this.app;
    const w = app.world;
    const d = w.project;
    const tp = d.terrain;
    const wrap = h('div');
    this._gen = this._gen || { seed: d.seed, relief: tp.relief, detail: tp.detail };
    const g = this._gen;
    this._hy = this._hy || { droplets: Math.round(w.res * w.res * 0.12), erodeRate: HYDRAULIC_DEFAULTS.erodeRate, depositRate: HYDRAULIC_DEFAULTS.depositRate, capacity: HYDRAULIC_DEFAULTS.capacity, radius: 3, seed: 1 };
    this._th = this._th || { iterations: 30, talus: THERMAL_DEFAULTS.talus, rate: THERMAL_DEFAULTS.rate };
    const hy = this._hy,
      th = this._th;
    const rules = { rockSlope: [1.12, 1.6], screeSlope: [0.92, 1.25], snowLine: 2350, treeLine: 2050, beachTop: 2.6, shoreBand: 1.2, ...(d.materials.rules || {}) };
    const setRule = (k) => (doc, v) => ((doc.materials.rules = doc.materials.rules || {}), (doc.materials.rules[k] = v));
    wrap.append(
      section('Terrain generator', h('div', { class: 'kv' }, 'Preset', h('b', null, TERRAIN_PRESETS[tp.preset]?.label || tp.preset), 'Extent', h('b', null, `${tp.size} m, ${w.hFinal.cell.toFixed(2)} m / sample`)), number('Seed', g.seed, 1, (v) => (g.seed = Math.round(v)), { min: 0 }), slider('Relief', g.relief, 0.3, 2, 0.01, (v) => (g.relief = v)), slider('Detail', g.detail, 0, 2, 0.01, (v) => (g.detail = v)), h('div', { class: 'rowbtns' }, button('Regenerate terrain', () => app.regenerateTerrain({ seed: g.seed, relief: g.relief, detail: g.detail }), { title: 'Replaces the height field (sculpting is lost; one undo step). Rivers, roads and biomes are re-applied.' })), note('Deterministic: the same seed and parameters always give the same landscape. Generation = stream-power landscape evolution → alluvial valley floors → droplet + thermal erosion.')),
      section('Hydraulic erosion', slider('Droplets', hy.droplets, 20000, w.res * w.res, 1000, (v) => (hy.droplets = Math.round(v))), slider('Erosion rate', hy.erodeRate, 0.02, 1, 0.01, (v) => (hy.erodeRate = v)), slider('Deposition', hy.depositRate, 0.02, 1, 0.01, (v) => (hy.depositRate = v)), slider('Carrying capacity', hy.capacity, 0.5, 12, 0.1, (v) => (hy.capacity = v)), slider('Brush radius', hy.radius, 1, 6, 1, (v) => (hy.radius = v), null, { unit: 'cells' }), h('div', { class: 'rowbtns' }, button('Run hydraulic erosion', () => app.runErosion('hydraulic', { ...hy, seed: hy.seed++ })))),
      section('Thermal erosion', slider('Iterations', th.iterations, 2, 200, 1, (v) => (th.iterations = Math.round(v))), slider('Angle of repose', deg(Math.atan(th.talus)), 15, 60, 1, (v) => (th.talus = Math.tan(rad(v))), null, { unit: '°' }), slider('Rate', th.rate, 0.05, 1, 0.01, (v) => (th.rate = v)), h('div', { class: 'rowbtns' }, button('Run thermal erosion', () => app.runErosion('thermal', { ...th }))), note('Both run in a background worker with progress and Cancel; the result is one undo step.')),
      section('Ground materials', ...MAT_NAMES.map((n, i) => {
        const l = d.materials.layers[n];
        const tx = app.manifest.textures[l.texture];
        return h('div', { class: 'field' }, h('span', { class: 'lbl', title: MAT_LABELS[i] }, MAT_LABELS[i]), h('select', { style: { flex: '1', minWidth: '0' }, onchange: (e) => app.edit('Assign ground material', (doc) => (doc.materials.layers[n] = { ...doc.materials.layers[n], texture: e.target.value }), 'materials') }, Object.entries(app.manifest.textures).map(([id, v]) => h('option', { value: id, selected: id === l.texture }, v.name || id))), h('input', { type: 'color', title: 'Tint', value: '#' + (l.tint || [1, 1, 1]).map((c) => Math.round(Math.min(1, c / 2) * 255).toString(16).padStart(2, '0')).join(''), oninput: (e) => app.edit('Tint ' + n, (doc) => (doc.materials.layers[n].tint = [1, 3, 5].map((k) => (parseInt(e.target.value.slice(k, k + 2), 16) / 255) * 2)), 'materials', { live: true, mergeKey: 'tint' + n }), onchange: (e) => app.edit('Tint ' + n, (doc) => (doc.materials.layers[n].tint = [1, 3, 5].map((k) => (parseInt(e.target.value.slice(k, k + 2), 16) / 255) * 2)), 'materials', { mergeKey: 'tint' + n }) }), tx ? null : h('span', { class: 'note err' }, 'missing'));
      }), note('Tint 50 % grey = unchanged. Layers are height-blended PBR sets (albedo, normal, roughness, AO, displacement).')),
      section('Material rules', this.ds('Bedrock from slope', () => deg(Math.atan(rules.rockSlope[0])), (doc, v) => setRule('rockSlope')(doc, [Math.tan(rad(v)), Math.tan(rad(Math.min(80, v + 10)))]), 20, 70, 1, 'ground', { unit: '°' }), this.ds('Scree from slope', () => deg(Math.atan(rules.screeSlope[0])), (doc, v) => setRule('screeSlope')(doc, [Math.tan(rad(v)), Math.tan(rad(Math.min(78, v + 9)))]), 15, 65, 1, 'ground', { unit: '°' }), this.ds('Tree line', () => rules.treeLine, setRule('treeLine'), 0, 9000, 10, 'ground', { unit: 'm' }), this.ds('Snow line', () => rules.snowLine, setRule('snowLine'), 0, 9000, 10, 'ground', { unit: 'm' }), this.ds('Beach top', () => rules.beachTop, setRule('beachTop'), 0.5, 8, 0.1, 'ground', { unit: 'm' }), this.ds('Bare shore band', () => rules.shoreBand, setRule('shoreBand'), 0.1, 5, 0.05, 'ground', { unit: 'm' })),
      section('Structure rules', this.ds('Max site slope', () => deg(Math.atan(d.structureRules?.maxSlope ?? 0.4)), (doc, v) => ((doc.structureRules = doc.structureRules || {}), (doc.structureRules.maxSlope = Math.tan(rad(v)))), 3, 40, 1, 'none', { unit: '°' }), this.ds('Min dist. to water', () => d.structureRules?.minWaterDist ?? 3, (doc, v) => ((doc.structureRules = doc.structureRules || {}), (doc.structureRules.minWaterDist = v)), 0, 40, 0.5, 'none', { unit: 'm' }), note('Applied when placing or moving structures by hand; settlements carry their own rule set.')),
      section('Procedural update', note('Dependencies: terrain → channels / roads / foundations → water levels and flow → moisture → ground materials → scatter. Edits update the affected region; use this to recompute everything.'), h('div', { class: 'rowbtns' }, button('Regenerate all derived data', () => { this.progress('Regenerating world', 0.3); requestAnimationFrame(() => { w.deriveAll(); app.engine.objects.sync(w); this.progress(null); this.toast('World regenerated from rules'); }); }))),
    );
    return wrap;
  }

  // ------------------------------------------------------------------------------------
  // Dialogs
  // ------------------------------------------------------------------------------------
  async showProjects() {
    const app = this.app;
    let list = [];
    try {
      list = await store.list();
    } catch (e) {
      return app.error('Cannot list projects: ' + e.message);
    }
    const grid = h('div', { class: 'pgrid' });
    const open = async (id) => {
      if (app.history.dirty && !confirm('Discard unsaved changes to the current project?')) return;
      this.closeModal();
      await app.openProject(id);
    };
    for (const p of list) {
      const thumb = p.hasThumb ? h('img', { src: `/api/projects/${p.id}/file/thumb.jpg?t=${Date.parse(p.modified) || 0}`, onclick: () => open(p.id) }) : h('div', { class: 'ph', onclick: () => open(p.id) });
      grid.append(
        h(
          'div',
          { class: 'pcard' },
          thumb,
          h('div', { class: 'inf' }, h('b', null, p.name, p.showcase ? h('span', { class: 'badge' }, 'showcase') : null), h('small', null, p.error ? p.error : `${TERRAIN_PRESETS[p.preset]?.label || p.preset} · seed ${p.seed} · ${new Date(p.modified).toLocaleString()}`)),
          h(
            'div',
            { class: 'acts' },
            button('Open', () => open(p.id), { class: 'small primary' }),
            button('Duplicate', async () => { const name = prompt('Name of the copy', p.name + ' copy'); if (!name) return; try { await app.duplicateProject(p.id, name); this.toast('Duplicated'); this.showProjects(); } catch (e) { app.error(e.message); } }, { class: 'small' }),
            h('a', { class: 'btn small', href: store.packageUrl(p.id), title: 'Portable package: project + every referenced asset (.tar.gz)' }, 'Package'),
            p.showcase ? button('Restore', async () => { if (!confirm('Restore this showcase to its original state?')) return; await store.restoreShowcase(p.id); this.toast('Showcase restored'); if (app.world?.project.id === p.id) { this.closeModal(); app.history.clear(); await app.openProject(p.id); } else this.showProjects(); }, { class: 'small', title: 'Reset to the shipped version' }) : button('Delete', async () => { if (!confirm(`Delete project “${p.name}”? This cannot be undone.`)) return; await store.remove(p.id); this.showProjects(); }, { class: 'small danger', disabled: app.world?.project.id === p.id }),
          ),
        ),
      );
    }
    this.modal('Projects', h('div', null, grid, list.length ? null : note('No projects yet.')), [button('New world…', () => this.showNew(), { class: 'primary' }), app.world ? button('Close', () => this.closeModal()) : null], { noClose: !app.world });
  }

  showNew() {
    const app = this.app;
    const p = { name: 'New world', preset: 'alpine', seed: Math.floor(Math.random() * 9000) + 1, res: 2049, relief: 1 };
    const body = h('div', { style: { width: '380px', display: 'flex', flexDirection: 'column', gap: '7px' } }, text('Name', p.name, (v) => (p.name = v)), select('Landscape', p.preset, Object.entries(TERRAIN_PRESETS).map(([k, v]) => [k, `${v.label} (${v.size} m)`]), (v) => (p.preset = v)), number('Seed', p.seed, 1, (v) => (p.seed = Math.round(v)), { min: 0 }), select('Resolution', p.res, [[1025, '1025² (fast, coarser)'], [2049, '2049² (recommended)']], (v) => (p.res = +v)), slider('Relief', p.relief, 0.4, 1.8, 0.01, (v) => (p.relief = v)), note('Generation takes roughly 10–40 s and can be cancelled. The main river, lake or sea suggested by the drainage model is created automatically and stays fully editable.'));
    this.modal('New world', body, [button('Cancel', () => this.closeModal()), button('Generate', async () => { if (app.history.dirty && !confirm('Discard unsaved changes to the current project?')) return; this.closeModal(); await app.newProject({ ...p, size: TERRAIN_PRESETS[p.preset].size }); }, { class: 'primary' })]);
  }

  showAddBiome() {
    const app = this.app;
    const body = h('div', { style: { width: '380px' } }, Object.values(BIOME_LIBRARY).map((b) => h('div', { class: 'field' }, h('span', { class: 'swatch', style: { background: b.color } }), h('span', { class: 'lbl', style: { flex: '1', color: 'var(--txt)' } }, b.name), button('Add', () => (this.closeModal(), app.addBiome(b.id)), { class: 'small' }))), note('Added biomes take part in automatic selection according to their rules, or can be painted.'));
    this.modal('Add biome from library', body, [button('Close', () => this.closeModal())]);
  }

  offerRecovery(id, when) {
    const app = this.app;
    this.modal('Recover autosave?', h('div', { style: { width: '420px' } }, note(`An autosave from ${new Date(when).toLocaleString()} is newer than the last manual save of this project.`)), [button('Discard autosave', async () => { await store.discardAutosave(id); this.closeModal(); }), button('Recover', async () => { this.closeModal(); await app.openProject(id, { autosave: true }); }, { class: 'primary' })]);
  }

  showExport() {
    const app = this.app;
    if (!app.world) return;
    const o = { terrainMeshRes: 513, terrainTextureRes: 2048, vegetation: true, water: true, structures: true };
    const log = h('div', { class: 'note', style: { minHeight: '60px', whiteSpace: 'pre-wrap' } }, 'Files are written to exports/<project>/<timestamp>/ next to the application.');
    const run = async () => {
      try {
        const { exportWorld } = await import('../export/exporter.js');
        let cancelled = false;
        this.progress('Exporting', 0, () => (cancelled = true));
        const res = await exportWorld(app.world, app.manifest, {
          ...o,
          include: { terrain: true, water: o.water, vegetation: o.vegetation, structures: o.structures, objects: true, roads: true },
          loadAsset: async (rel) => { const r = await fetch('/assets/' + rel); if (!r.ok) throw new Error(`asset ${rel} is missing`); return new Uint8Array(await r.arrayBuffer()); },
          onProgress: (l, f) => (this.progress('Exporting — ' + l, f, undefined, true), !cancelled),
        });
        if (!res) { this.progress(null); return this.toast('Export cancelled'); }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        let n = 0, bytes = 0, dir = '';
        for (const f of res.files) {
          this.progress(`Writing ${f.name}`, n++ / res.files.length, undefined, true);
          const r = await store.exportFile(app.world.project.id, stamp, f.name, f.data);
          bytes += f.data.length;
          dir = r.path.replace(/\/[^/]+$/, '');
        }
        this.progress(null);
        log.textContent = `Exported ${res.files.length} files (${(bytes / 1e6).toFixed(1)} MB) to ${dir}/\n\n${res.files.map((f) => `${f.name}  ${(f.data.length / 1024).toFixed(0)} kB`).join('\n')}\n\nVerify independently with:\n  npm run verify:export -- ${dir}`;
        this.lastExport = { dir, files: res.files.map((f) => f.name), report: res.report };
        this.toast('Export finished: ' + dir);
      } catch (e) {
        this.progress(null);
        app.error('Export failed: ' + e.message);
      }
    };
    const body = h('div', { style: { width: '460px', display: 'flex', flexDirection: 'column', gap: '6px' } }, note('Heightmap (16-bit PNG + float32 raw), masks (materials, biomes, water, flow, moisture…), scene.glb (terrain, water, instanced vegetation and rocks, structures, roads), placements.json, environment.json.'), select('Terrain mesh', o.terrainMeshRes, [[257, '257² vertices'], [513, '513² vertices'], [1025, '1025² vertices']], (v) => (o.terrainMeshRes = +v)), select('Baked terrain texture', o.terrainTextureRes, [[1024, '1024²'], [2048, '2048²']], (v) => (o.terrainTextureRes = +v)), checkbox('Vegetation and rocks (GPU-instanced)', o.vegetation, (v) => (o.vegetation = v)), checkbox('Water surfaces', o.water, (v) => (o.water = v)), checkbox('Structures and objects', o.structures, (v) => (o.structures = v)), note('Not exported (renderer-specific): wave / flow animation, foam, caustics, refraction and reflections, wind, atmosphere and clouds (parameters only), near-camera grass and ferns (rules only), the layered terrain material (baked to one base-colour texture). See README_EXPORT.md in the export folder.', 'warn'), log);
    this.modal('Export', body, [button('Close', () => this.closeModal()), button('Export', run, { class: 'primary' })]);
  }

  showHelp() {
    const sec = (title, rows) => h('section', null, h('h3', null, title), h('table', null, rows.map(([k, v]) => h('tr', null, h('td', null, k), h('td', null, v)))));
    const body = h(
      'div',
      { class: 'help' },
      sec('Camera', [['1 / 2 / 3', 'Orbit, fly, walk'], ['Right drag', 'Orbit / look around'], ['Middle drag', 'Pan'], ['Wheel', 'Zoom (orbit), speed (fly), field of view (walk)'], ['W A S D', 'Move (orbit: move the focus point)'], ['Q / E', 'Down / up (fly)'], ['Shift', 'Fast / run'], ['Space', 'Jump; rise when swimming'], ['C', 'Dive (walk mode, deep water)'], ['F', 'Frame the selection']]),
      sec('Tools', Object.values(TOOL_INFO).map((t) => [t.key, t.label])),
      sec('Editing', [['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'], ['Ctrl+S', 'Save (autosave every minute)'], ['[ / ]', 'Brush radius'], ['Shift + drag', 'Smooth (sculpt)'], ['Ctrl + drag', 'Invert / erase'], ['Enter / double-click', 'Finish a path'], ['Backspace', 'Remove last path point'], ['Shift + click path', 'Insert a point'], ['Q / E', 'Rotate selection or placement'], ['Delete', 'Delete selection'], ['Esc', 'Cancel / deselect']]),
      sec('Simulation', [['K', 'Pause / resume water, wind, clouds'], ['I, then click water', 'Drop a stone; drag to stir'], ['V, drag a floating object', 'Tow it through the water']]),
      h('section', null, h('h3', null, 'Workflow'), note('Terrain is generated from a seed and can be sculpted or eroded. Rivers, roads and foundations are non-destructive modifiers applied on top, so they can be moved at any time. Water levels and flow, ground materials and scattered vegetation are derived from the result and update after each edit. Everything is undoable and saved in the project folder.')),
    );
    this.modal('Controls', body, [button('Close', () => this.closeModal())]);
  }
}

export { MAT, NO_WATER };
