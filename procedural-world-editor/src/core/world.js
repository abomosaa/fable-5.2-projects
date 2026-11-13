// World: owns the authoritative project data (heightfields, paint masks, JSON document) and all
// derived data (final terrain, water field, moisture, ground weights, scatter instances).
// DOM-free: used by the editor, the showcase builder, the exporter and the tests.

import { snapHeights, snapSediment } from './project.js';
import { Heightfield, unionRect, padRect } from './heightfield.js';
import { compileRiver, applyRiver, compileRoad, applyRoad, applyPad, padLevel } from './carve.js';
import { WaterField, computeWaterField, NO_WATER } from './waterField.js';
import { computeGround, computeMoisture, scatterLayer, INSTANCE_STRIDE, SCATTER_CELL, defaultMaterialRules } from './biomes.js';
import { priorityFlood, computeReceivers, accumulateArea } from './fluvial.js';
import { hash32, hashFloat, smoothstep } from './noise.js';
import { nearestOnPolyline } from './paths.js';
import { structureFootprint } from './structures.js';

export class World {
  /**
   * @param {object} project  JSON document (see project.js)
   * @param {object} data {heights:Float32Array, sediment?:Float32Array, ring?:{res,size,data}, paint?:object}
   * @param {object} assets asset manifest (models/textures); used for model radii
   */
  constructor(project, data, assets) {
    this.project = project;
    this.assets = assets || { models: {}, textures: {} };
    const { res, size } = project.terrain;
    this.res = res;
    this.size = size;
    this.hUser = new Heightfield(res, size, data.heights);
    this.hFinal = new Heightfield(res, size, new Float32Array(data.heights));
    const N = res * res;
    this.sediment = data.sediment || new Float32Array(N);
    this.ring = data.ring || null;
    this.paint = {
      biome: data.paint?.biome || new Uint8Array(N),
      exclude: data.paint?.exclude || new Uint8Array(N),
      mat: data.paint?.mat || new Array(9).fill(null),
      density: data.paint?.density || {},
    };
    this.masks = {
      channel: new Uint8Array(N),
      bank: new Uint8Array(N),
      road: new Uint8Array(N),
      roadKind: new Uint8Array(N),
      clear: new Uint8Array(N),
      pad: new Uint8Array(N),
    };
    this.water = new WaterField(res, size);
    this.moisture = new Uint8Array(N);
    this.weights = new Uint8Array(N * 8);
    this.biomeMap = new Uint8Array(N);
    this.drainage = { res: 513, data: new Float32Array(513 * 513).fill(3) };
    this.compiled = { rivers: [], roads: [] };
    this.scatterCells = new Map(); // "cx,cz" -> { layers: Map(layerKey -> {data:Float32Array,count,keys}) }
    this.detailCells = new Map();
    this.suppressed = new Set(project.scatter?.suppressed || []);
    this.listeners = new Set();
    this.version = { height: 0, water: 0, ground: 0, scatter: 0 };
    this._scratch = new Float32Array(INSTANCE_STRIDE * 60000);
    this._scratchKeys = new Int32Array(2 * 60000);
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(type, rect) {
    this.version[type] = (this.version[type] || 0) + 1;
    for (const fn of this.listeners) fn(type, rect);
  }

  fullRect() {
    return { x0: 0, z0: 0, x1: this.res - 1, z1: this.res - 1 };
  }

  get seaLevel() {
    const s = this.project.water.sea;
    return s && s.enabled ? s.level : null;
  }

  groundCtx() {
    return {
      hf: this.hFinal,
      wf: this.water,
      masks: this.masks,
      sediment: this.sediment,
      moisture: this.moisture,
      paint: this.paint,
      biomes: this.project.biomes,
      rules: { ...defaultMaterialRules(), ...(this.project.materials?.rules || {}) },
      seed: this.project.seed,
      seaLevel: this.seaLevel,
      weights: this.weights,
      biomeMap: this.biomeMap,
      drainage: this.drainage,
      suppressed: this.suppressed,
    };
  }

  // ------------------------------------------------------------------------------------
  // Derivation pipeline
  // ------------------------------------------------------------------------------------

  /** Recompute everything derived from the authoritative data. */
  deriveAll(onProgress) {
    const p = (label, f) => onProgress && onProgress(label, f);
    // keep the stored layers on their storage grids so a saved project reopens bit-identically
    snapHeights(this.hUser.data);
    snapSediment(this.sediment);
    p('Carving channels and roads', 0.05);
    this.applyModifiers(null);
    p('Solving water', 0.25);
    this.solveWater();
    p('Drainage and moisture', 0.5);
    this.computeDrainage();
    const full = this.fullRect();
    computeMoisture(this.groundCtx(), full);
    p('Ground materials', 0.65);
    computeGround(this.groundCtx(), full);
    p('Scattering vegetation and rocks', 0.8);
    this.scatterCells.clear();
    this.detailCells.clear();
    this.generateAllScatter();
    // boulders standing in a river deflect the flow: re-solve with obstacles
    const obs = this.collectObstacles();
    if (obs.length) {
      p('Flow around obstacles', 0.93);
      this.solveWater(obs);
    }
    this.emit('height', full);
    this.emit('water', full);
    this.emit('ground', full);
    this.emit('scatter', null);
    p('Done', 1);
  }

  /**
   * Re-derive after an edit touching `rect` of the user heightfield (or masks).
   * opts.fast: only carve + ground inside the rect (used while a brush stroke is in progress).
   */
  deriveRect(rect, opts = {}) {
    const r = padRect(rect, 3, this.res);
    snapHeights(this.hUser.data, this.res, r);
    snapSediment(this.sediment, this.res, r);
    if (opts.fast) {
      this.applyModifiers(r, true);
      computeGround(this.groundCtx(), r);
      this.emit('height', r);
      this.emit('ground', r);
      return r;
    }
    // full-quality local update: modifiers may reach beyond the rect (river profiles are global)
    let dirty = this.applyModifiers(r, false);
    dirty = unionRect(dirty, r);
    let gr = padRect(dirty, Math.ceil(70 / this.hFinal.cell), this.res);
    // water only needs re-solving when the edit can interact with it
    let waterChanged = false;
    if (opts.forceWater || this._touchesWater(padRect(dirty, 3, this.res))) {
      const before = new Uint8Array(this.water.type);
      this.solveWater(this._obstacles);
      const ch = this._typeDiffRect(before);
      if (ch) gr = unionRect(gr, padRect(ch, Math.ceil(72 / this.hFinal.cell), this.res));
      waterChanged = true;
    }
    computeMoisture(this.groundCtx(), gr);
    computeGround(this.groundCtx(), gr);
    this.invalidateScatter(gr);
    if (waterChanged && this.compiled.rivers.some(Boolean)) {
      const obs = this.collectObstacles();
      if (obs.length || (this._obstacles && this._obstacles.length)) this.solveWater(obs);
    }
    this.emit('height', dirty);
    if (waterChanged) this.emit('water', this.fullRect());
    this.emit('ground', gr);
    this.emit('scatter', gr);
    return gr;
  }

  _touchesWater(rect) {
    const res = this.res;
    const surf = this.water.surf;
    const lim = NO_WATER * 0.5;
    if (this.compiled.rivers.some(Boolean)) {
      for (const c of this.compiled.rivers) {
        if (!c) continue;
        const rr = c.raster.rect;
        if (rr.x0 <= rect.x1 && rr.x1 >= rect.x0 && rr.z0 <= rect.z1 && rr.z1 >= rect.z0) return true;
      }
    }
    const sea = this.seaLevel;
    const h = this.hFinal.data;
    let minLake = Infinity;
    for (const l of this.project.water.lakes || []) minLake = Math.min(minLake, l.level);
    for (let z = rect.z0; z <= rect.z1; z++) {
      for (let x = rect.x0; x <= rect.x1; x++) {
        const i = z * res + x;
        if (surf[i] > lim) return true;
        if (sea !== null && h[i] < sea + 0.3) return true;
      }
    }
    void minLake;
    return false;
  }

  _typeDiffRect(before) {
    const res = this.res;
    const t = this.water.type;
    let x0 = res,
      z0 = res,
      x1 = -1,
      z1 = -1;
    for (let z = 0; z < res; z++) {
      const row = z * res;
      for (let x = 0; x < res; x++) {
        if (t[row + x] !== before[row + x]) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (z < z0) z0 = z;
          if (z > z1) z1 = z;
        }
      }
    }
    return x1 < 0 ? null : { x0, z0, x1, z1 };
  }

  /** Recompute after water-only changes (levels, lakes, flow) without touching the terrain. */
  deriveWater() {
    this.solveWater(this._obstacles);
    const full = this.fullRect();
    computeMoisture(this.groundCtx(), full);
    computeGround(this.groundCtx(), full);
    this.scatterCells.clear();
    this.detailCells.clear();
    this.generateAllScatter();
    this.emit('water', full);
    this.emit('ground', full);
    this.emit('scatter', null);
  }

  /** Recompute ground + scatter after biome / rule / paint changes. */
  deriveGround(rect) {
    const r = rect ? padRect(rect, 2, this.res) : this.fullRect();
    computeGround(this.groundCtx(), r);
    if (rect) this.invalidateScatter(r);
    else {
      this.scatterCells.clear();
      this.detailCells.clear();
      this.generateAllScatter();
    }
    this.emit('ground', r);
    this.emit('scatter', rect ? r : null);
  }

  applyModifiers(clip, reuseCompiled = false) {
    const { hUser, hFinal, masks, project } = this;
    const res = this.res;
    let dirty = null;
    if (!reuseCompiled || !this.compiled.ready) {
      const oldRects = [...this.compiled.rivers, ...this.compiled.roads].filter(Boolean).map((c) => c.raster.rect);
      this.compiled.rivers = (project.water.rivers || []).map((r) => (r.hidden ? null : compileRiver(r, hUser, project.seed)));
      this.compiled.roads = (project.roads || []).map((r) => compileRoad(r, hUser));
      this.compiled.pads = this.structurePads();
      this.compiled.ready = true;
      if (clip) {
        // modifiers changed shape: everything they covered before or cover now must be redone
        for (const rc of oldRects) dirty = unionRect(dirty, rc);
        for (const c of [...this.compiled.rivers, ...this.compiled.roads]) if (c) dirty = unionRect(dirty, c.raster.rect);
        for (const p of this.compiled.pads) dirty = unionRect(dirty, hUser.rectFromWorld(p.x - p.reach, p.z - p.reach, p.x + p.reach, p.z + p.reach, 2));
        if (this._lastPadRects) for (const rc of this._lastPadRects) dirty = unionRect(dirty, rc);
      }
    }
    const area = clip ? unionRect(dirty, clip) : this.fullRect();
    // reset the area to the user surface and clear masks
    for (let iz = area.z0; iz <= area.z1; iz++) {
      const a = iz * res + area.x0;
      const b = iz * res + area.x1 + 1;
      hFinal.data.set(hUser.data.subarray(a, b), a);
      masks.channel.fill(0, a, b);
      masks.bank.fill(0, a, b);
      masks.road.fill(0, a, b);
      masks.roadKind.fill(0, a, b);
      masks.clear.fill(0, a, b);
      masks.pad.fill(0, a, b);
    }
    // order matters: roads first, then foundation pads (a pad overrides road cut / fill under the
    // building so structureLevel() is the real ground level), rivers last (the channel always wins)
    this._lastPadRects = [];
    for (const c of this.compiled.roads) if (c) applyRoad(c, hUser, hFinal, masks, area);
    for (const p of this.compiled.pads) this._lastPadRects.push(applyPad(p, hUser, hFinal, masks, area));
    for (const c of this.compiled.rivers) if (c) applyRiver(c, hUser, hFinal, masks, area);
    return area;
  }

  structurePads() {
    const pads = [];
    for (const s of this.project.structures || []) {
      const fp = structureFootprint(s, this.assets);
      if (!fp || fp.pad === false) continue;
      const lv = padLevel(this.hUser, s.x, s.z, s.rot || 0, fp.halfX, fp.halfZ);
      const level = s.level ?? lv.level + (fp.levelBias ?? 0);
      pads.push({ id: s.id, x: s.x, z: s.z, rot: s.rot || 0, halfX: fp.halfX + 0.6, halfZ: fp.halfZ + 0.6, level, margin: fp.margin ?? 4, reach: Math.hypot(fp.halfX, fp.halfZ) + (fp.margin ?? 4) + 2 });
    }
    return pads;
  }

  /** Ground elevation a structure should sit on (pad level). */
  structureLevel(s) {
    const p = (this.compiled.pads || []).find((q) => q.id === s.id);
    if (p) return p.level;
    return this.hFinal.sample(s.x, s.z);
  }

  solveWater(obstacles) {
    this._obstacles = obstacles || null;
    const w = this.project.water;
    const waterDoc = { sea: w.sea, lakes: w.lakes, wind: { dir: this.project.env.windDir, speed: this.project.env.windSpeed }, swell: w.swell };
    return computeWaterField(this.water, this.hFinal, waterDoc, this.compiled.rivers, { obstacles });
  }

  computeDrainage() {
    const n = this.drainage.res;
    const res = this.res;
    const h = new Float32Array(n * n);
    const sc = (res - 1) / (n - 1);
    const src = this.hFinal.data;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[j * n + i] = src[Math.round(j * sc) * res + Math.round(i * sc)];
    const outlet = new Uint8Array(n * n);
    for (let i = 0; i < n; i++) outlet[i] = outlet[(n - 1) * n + i] = outlet[i * n] = outlet[i * n + n - 1] = 1;
    const dx = this.size / (n - 1);
    const pf = priorityFlood(h, n, outlet, 1e-3 * dx);
    const rr = computeReceivers(pf.filled, n, outlet, null, null, dx);
    const area = accumulateArea(pf.order, pf.count, rr.recv, n, dx);
    const out = this.drainage.data;
    for (let i = 0; i < n * n; i++) out[i] = Math.log10(Math.max(1, area[i]));
    // light blur so moisture does not follow single-cell flow lines
    const tmp = new Float32Array(out);
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        const c = j * n + i;
        out[c] = Math.max(tmp[c] * 0.4 + (tmp[c - 1] + tmp[c + 1] + tmp[c - n] + tmp[c + n]) * 0.15, tmp[c] - 0.6);
      }
    }
  }

  // ------------------------------------------------------------------------------------
  // Scatter
  // ------------------------------------------------------------------------------------

  /** All scatter layers flattened: [{biomeIndex, biome, layer, key, detail}] */
  layerList() {
    if (this._layerList && this._layerListSrc === this.project.biomes) return this._layerList;
    const list = [];
    this.project.biomes.forEach((b, bi) => {
      for (const l of b.layers || []) {
        if (l.enabled === false) continue;
        list.push({ biomeIndex: bi, biome: b, layer: l, key: b.id + '/' + l.id, detail: (l.range ?? 1e9) <= 130 });
      }
    });
    this._layerList = list;
    this._layerListSrc = this.project.biomes;
    return list;
  }
  invalidateLayerList() {
    this._layerList = null;
  }

  cellBounds(cx, cz, cellSize = SCATTER_CELL) {
    const x0 = -this.size / 2 + cx * cellSize;
    const z0 = -this.size / 2 + cz * cellSize;
    return [x0, z0, x0 + cellSize, z0 + cellSize];
  }

  generateScatterCell(cx, cz) {
    const [x0, z0, x1, z1] = this.cellBounds(cx, cz);
    const ctx = this.groundCtx();
    const layers = new Map();
    for (const L of this.layerList()) {
      if (L.detail) continue;
      const n = scatterLayer(ctx, L.biomeIndex, L.layer, x0, z0, x1, z1, this._scratch, this._scratchKeys);
      if (n > 0) layers.set(L.key, { data: this._scratch.slice(0, n * INSTANCE_STRIDE), keys: this._scratchKeys.slice(0, n * 2), count: n });
    }
    const cell = { cx, cz, layers };
    this.scatterCells.set(cx + ',' + cz, cell);
    return cell;
  }

  generateAllScatter() {
    const nc = Math.ceil(this.size / SCATTER_CELL);
    for (let cz = 0; cz < nc; cz++) for (let cx = 0; cx < nc; cx++) this.generateScatterCell(cx, cz);
  }

  invalidateScatter(rect) {
    const hf = this.hFinal;
    const cs = SCATTER_CELL;
    const nc = Math.ceil(this.size / cs);
    const cx0 = Math.max(0, Math.floor((hf.toWorldX(rect.x0) + this.size / 2) / cs)),
      cx1 = Math.min(nc - 1, Math.floor((hf.toWorldX(rect.x1) + this.size / 2) / cs));
    const cz0 = Math.max(0, Math.floor((hf.toWorldZ(rect.z0) + this.size / 2) / cs)),
      cz1 = Math.min(nc - 1, Math.floor((hf.toWorldZ(rect.z1) + this.size / 2) / cs));
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) this.generateScatterCell(cx, cz);
    // detail cells are regenerated lazily
    const xmin = hf.toWorldX(rect.x0),
      xmax = hf.toWorldX(rect.x1),
      zmin = hf.toWorldZ(rect.z0),
      zmax = hf.toWorldZ(rect.z1);
    for (const [k, c] of this.detailCells) {
      if (c.x1 >= xmin && c.x0 <= xmax && c.z1 >= zmin && c.z0 <= zmax) this.detailCells.delete(k);
    }
  }

  /** Detail (near-camera) layers for a small cell; generated on demand and cached. */
  getDetailCell(dx, dz, cellSize) {
    const k = dx + ',' + dz;
    let c = this.detailCells.get(k);
    if (c) return c;
    const x0 = dx * cellSize,
      z0 = dz * cellSize;
    const ctx = this.groundCtx();
    const layers = new Map();
    for (const L of this.layerList()) {
      if (!L.detail) continue;
      const n = scatterLayer(ctx, L.biomeIndex, L.layer, x0, z0, x0 + cellSize, z0 + cellSize, this._scratch, null);
      if (n > 0) layers.set(L.key, { data: this._scratch.slice(0, n * INSTANCE_STRIDE), count: n });
    }
    c = { x0, z0, x1: x0 + cellSize, z1: z0 + cellSize, layers };
    this.detailCells.set(k, c);
    if (this.detailCells.size > 1400) {
      // drop the oldest entries
      let i = 0;
      for (const key of this.detailCells.keys()) {
        if (i++ > 300) break;
        this.detailCells.delete(key);
      }
    }
    return c;
  }

  /** Rocks large enough to deflect river flow. */
  collectObstacles() {
    const obs = [];
    const models = this.assets.models || {};
    const layerByKey = new Map(this.layerList().map((L) => [L.key, L]));
    const add = (x, y, z, scale, id) => {
      const m = models[id];
      const r = (m ? m.radius : 0.8) * scale * 0.62;
      const hgt = (m ? m.height : 1) * scale;
      if (r < 0.45) return;
      const gi = Math.round(this.hFinal.toGridZ(z)) * this.res + Math.round(this.hFinal.toGridX(x));
      if (!this.masks.bank[gi]) return;
      obs.push({ x, z, r, top: y + hgt * 0.8 });
    };
    for (const cell of this.scatterCells.values()) {
      for (const [key, inst] of cell.layers) {
        const L = layerByKey.get(key);
        if (!L || !L.layer.obstacle) continue;
        for (let i = 0; i < inst.count; i++) {
          const o = i * INSTANCE_STRIDE;
          const variant = Math.floor(inst.data[o + 7]);
          add(inst.data[o], inst.data[o + 1], inst.data[o + 2], inst.data[o + 3], L.layer.models[variant].id);
        }
      }
    }
    for (const ob of this.project.objects || []) {
      if (ob.floating) continue;
      const m = models[ob.model];
      if (m && m.category === 'rock') add(ob.x, ob.y ?? this.hFinal.sample(ob.x, ob.z), ob.z, ob.scale || 1, ob.model);
    }
    return obs;
  }

  // ------------------------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------------------------

  heightAt(x, z) {
    return this.hFinal.sample(x, z);
  }
  waterSurfaceAt(x, z) {
    return this.water.surfaceAt(this.hFinal, x, z);
  }
  waterDepthAt(x, z) {
    const s = this.water.surfaceAt(this.hFinal, x, z);
    if (s <= NO_WATER * 0.5) return -1;
    return s - this.hFinal.sample(x, z);
  }

  /** Ray-march the final heightfield. Returns {x,y,z,t} or null. */
  raycast(ox, oy, oz, dx, dy, dz, maxT = 20000) {
    const hf = this.hFinal;
    const half = this.size / 2;
    // clip to terrain bounds in xz
    let t0 = 0,
      t1 = maxT;
    for (const [o, d] of [
      [ox, dx],
      [oz, dz],
    ]) {
      if (Math.abs(d) < 1e-9) {
        if (o < -half || o > half) return null;
      } else {
        let a = (-half - o) / d,
          b = (half - o) / d;
        if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, b);
      }
    }
    if (t0 >= t1) return null;
    let t = t0;
    let prevT = t0;
    let prevD = oy + dy * t - hf.sample(ox + dx * t, oz + dz * t);
    if (prevD < 0) return null;
    while (t < t1) {
      // step proportional to height above ground (bounded by cell size)
      const step = Math.max(hf.cell * 0.5, Math.min(40, prevD * 0.4));
      t += step;
      const d = oy + dy * t - hf.sample(ox + dx * t, oz + dz * t);
      if (d <= 0) {
        let a = prevT,
          b = t;
        for (let i = 0; i < 18; i++) {
          const m = (a + b) / 2;
          if (oy + dy * m - hf.sample(ox + dx * m, oz + dz * m) > 0) a = m;
          else b = m;
        }
        const tt = (a + b) / 2;
        return { x: ox + dx * tt, y: oy + dy * tt, z: oz + dz * tt, t: tt };
      }
      prevT = t;
      prevD = d;
    }
    return null;
  }

  /** Validate a structure site; returns null if OK or a human-readable reason. */
  checkStructureSite(s, rules = {}) {
    const fp = structureFootprint(s, this.assets) || { halfX: 3, halfZ: 3 };
    if (fp.overWater) return null;
    const lv = padLevel(this.hUser, s.x, s.z, s.rot || 0, fp.halfX, fp.halfZ);
    const maxSlope = rules.maxSlope ?? 0.4;
    const slope = (lv.max - lv.min) / (2 * Math.hypot(fp.halfX, fp.halfZ));
    if (slope > maxSlope) return `slope too steep (${(Math.atan(slope) * 57.3).toFixed(0)}° > ${(Math.atan(maxSlope) * 57.3).toFixed(0)}°)`;
    const c = Math.cos(s.rot || 0),
      sn = Math.sin(s.rot || 0);
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const lx = i * (fp.halfX + 1),
          lz = j * (fp.halfZ + 1);
        const x = s.x + lx * c + lz * sn,
          z = s.z - lx * sn + lz * c;
        if (!this.hFinal.inBounds(x, z)) return 'outside the terrain';
        const d = this.waterDepthAt(x, z);
        if (d > 0.02) return 'site is under water';
        const gi = Math.round(this.hFinal.toGridZ(z)) * this.res + Math.round(this.hFinal.toGridX(x));
        if (-this.water.shore[gi] < (rules.minWaterDist ?? 3) && this.water.shore[gi] > -64) return `too close to water (< ${rules.minWaterDist ?? 3} m)`;
        if (this.masks.road[gi] > 100) return 'site overlaps a road';
      }
    }
    return null;
  }

  /** Deterministically place structures for a settlement rule set; returns new structure docs. */
  generateSettlement(st) {
    const out = [];
    const rules = st.rules || {};
    const count = st.count ?? 5;
    const seed = hash32(this.project.seed, st.seed ?? 1, 4242);
    const types = st.types && st.types.length ? st.types : ['cabin'];
    const roads = this.project.roads || [];
    let tries = 0;
    const placed = [];
    const existing = (this.project.structures || []).filter((s) => s.settlement !== st.id);
    while (out.length < count && tries < count * 220) {
      tries++;
      const a = hashFloat(tries, 1, seed) * Math.PI * 2;
      const r = Math.sqrt(hashFloat(tries, 2, seed)) * st.radius;
      const x = st.x + Math.cos(a) * r,
        z = st.z + Math.sin(a) * r;
      let rot = hashFloat(tries, 3, seed) * Math.PI * 2;
      // road relationship: keep within range and face the road
      let roadD = Infinity;
      let face = null;
      for (const rd of roads) {
        const np = nearestOnPolyline(rd.nodes, x, z);
        if (np.dist < roadD) {
          roadD = np.dist;
          const n0 = rd.nodes[np.seg],
            n1 = rd.nodes[np.seg + 1];
          const px = n0.x + (n1.x - n0.x) * np.t,
            pz = n0.z + (n1.z - n0.z) * np.t;
          face = Math.atan2(px - x, pz - z);
        }
      }
      if (roads.length && rules.maxRoadDist !== undefined && (roadD > rules.maxRoadDist || roadD < (rules.minRoadDist ?? 7))) continue;
      if (face !== null && roadD < 60) rot = face + (hashFloat(tries, 5, seed) - 0.5) * 0.3;
      const type = types[Math.floor(hashFloat(tries, 4, seed) * types.length) % types.length];
      const s = { id: `${st.id}-s${out.length + 1}`, type, x, z, rot, settlement: st.id, variant: Math.floor(hashFloat(tries, 6, seed) * 1000) };
      const minSp = rules.minSpacing ?? 16;
      if ([...placed, ...existing].some((q) => Math.hypot(q.x - x, q.z - z) < minSp)) continue;
      if (this.checkStructureSite(s, rules)) continue;
      const alt = this.hUser.sample(x, z);
      if (alt < (rules.altMin ?? -1e9) || alt > (rules.altMax ?? 1e9)) continue;
      placed.push(s);
      out.push(s);
    }
    return out;
  }
}

export { INSTANCE_STRIDE, SCATTER_CELL };
