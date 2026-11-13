// Scatter rendering: GPU-instanced meshes with per-instance LOD selection, dithered LOD
// cross-fades, multi-view impostors for distant trees and on-demand near-camera detail layers
// (grass, ferns, flowers). Instance data comes from World.scatterCells / getDetailCell.

import * as THREE from 'three';
import { INSTANCE_STRIDE, SCATTER_CELL } from '../core/biomes.js';

const DETAIL_CELL = 16;

class Batch {
  /** One (model, lod) batch: every primitive shares the same instance buffers. */
  constructor(rec, lodIndex, group, opts) {
    this.rec = rec;
    this.lodIndex = lodIndex;
    this.capacity = 256;
    this.count = 0;
    this.a0 = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    this.a1 = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    this.a0.setUsage(THREE.DynamicDrawUsage);
    this.a1.setUsage(THREE.DynamicDrawUsage);
    this.meshes = [];
    this.group = group;
    this.opts = opts;
    this._build();
  }
  _build() {
    for (const m of this.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
    }
    this.meshes = [];
    const lod = this.rec.lods[this.lodIndex];
    for (const prim of lod.prims) {
      const g = new THREE.InstancedBufferGeometry();
      g.index = prim.geometry.index;
      g.setAttribute('position', prim.geometry.getAttribute('position'));
      g.setAttribute('normal', prim.geometry.getAttribute('normal'));
      g.setAttribute('uv', prim.geometry.getAttribute('uv'));
      g.setAttribute('aI0', this.a0);
      g.setAttribute('aI1', this.a1);
      g.instanceCount = 0;
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
      const mesh = new THREE.Mesh(g, prim.mats.instanced);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      if (this.opts.shadow) {
        mesh.userData.depthMaterial = prim.mats.instancedDepth;
        mesh.layers.enable(2);
      }
      if (this.opts.detail) mesh.layers.set(3);
      else if (this.opts.mainOnly) {
        // drawn in the main view (layer 7) and shadows (layer 2); the planar reflection uses impostors instead
        mesh.layers.set(7);
        if (this.opts.shadow) mesh.layers.enable(2);
      }
      // which shadow cascades this batch is drawn into (near geometry is irrelevant to far cascades)
      mesh.userData.cascadeMask = this.opts.detail ? 0b0001 : this.opts.small ? 0b0011 : this.lodIndex >= 2 ? 0b0110 : 0b0011;
      mesh.renderOrder = this.opts.detail ? -3 : -10 + this.lodIndex;
      mesh.visible = false;
      this.group.add(mesh);
      this.meshes.push(mesh);
    }
  }
  ensure(n) {
    if (n <= this.capacity) return;
    let c = this.capacity;
    while (c < n) c *= 2;
    const n0 = new Float32Array(c * 4),
      n1 = new Float32Array(c * 4);
    n0.set(this.a0.array.subarray(0, this.count * 4));
    n1.set(this.a1.array.subarray(0, this.count * 4));
    this.capacity = c;
    this.a0 = new THREE.InstancedBufferAttribute(n0, 4);
    this.a1 = new THREE.InstancedBufferAttribute(n1, 4);
    this.a0.setUsage(THREE.DynamicDrawUsage);
    this.a1.setUsage(THREE.DynamicDrawUsage);
    for (const m of this.meshes) {
      m.geometry.setAttribute('aI0', this.a0);
      m.geometry.setAttribute('aI1', this.a1);
    }
  }
  push(x, y, z, scale, rot, tx, tz, seed, fade) {
    if (this.count >= this.capacity) this.ensure(this.count + 1);
    const o = this.count * 4;
    const a = this.a0.array,
      b = this.a1.array;
    a[o] = x;
    a[o + 1] = y;
    a[o + 2] = z;
    a[o + 3] = scale;
    b[o] = rot;
    b[o + 1] = tx;
    b[o + 2] = tz;
    b[o + 3] = Math.min(0.999, seed) + Math.round(fade * 255);
    this.count++;
  }
  commit() {
    const n = this.count;
    for (const m of this.meshes) {
      m.geometry.instanceCount = n;
      m.visible = n > 0;
    }
    if (n > 0) {
      this.a0.clearUpdateRanges();
      this.a0.addUpdateRange(0, n * 4);
      this.a0.needsUpdate = true;
      this.a1.clearUpdateRanges();
      this.a1.addUpdateRange(0, n * 4);
      this.a1.needsUpdate = true;
    }
  }
  dispose() {
    for (const m of this.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
    }
  }
}

class ImpostorBatch {
  constructor(rec, imp, group, reflectionOnly = false) {
    this.reflectionOnly = reflectionOnly;
    this.capacity = 1024;
    this.count = 0;
    this.a0 = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    this.a1 = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.geometry = g;
    this._attach();
    this.mesh = new THREE.Mesh(g, imp.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.userData.depthMaterial = imp.depthMaterial;
    if (reflectionOnly) {
      this.mesh.layers.set(6);
      this.mesh.userData.depthMaterial = null;
    } else this.mesh.layers.enable(2);
    this.mesh.userData.cascadeMask = 0b1100;
    this.mesh.renderOrder = -2;
    this.mesh.visible = false;
    group.add(this.mesh);
    this.group = group;
  }
  _attach() {
    this.a0.setUsage(THREE.DynamicDrawUsage);
    this.a1.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aI0', this.a0);
    this.geometry.setAttribute('aI1', this.a1);
  }
  ensure(n) {
    if (n <= this.capacity) return;
    let c = this.capacity;
    while (c < n) c *= 2;
    const n0 = new Float32Array(c * 4),
      n1 = new Float32Array(c * 4);
    n0.set(this.a0.array.subarray(0, this.count * 4));
    n1.set(this.a1.array.subarray(0, this.count * 4));
    this.capacity = c;
    this.a0 = new THREE.InstancedBufferAttribute(n0, 4);
    this.a1 = new THREE.InstancedBufferAttribute(n1, 4);
    this._attach();
    this._realloc = true;
  }
  push(x, y, z, scale, rot, seed, fade) {
    if (this.count >= this.capacity) this.ensure(this.count + 1);
    const o = this.count * 4;
    this.a0.array[o] = x;
    this.a0.array[o + 1] = y;
    this.a0.array[o + 2] = z;
    this.a0.array[o + 3] = scale;
    this.a1.array[o] = rot;
    this.a1.array[o + 3] = Math.min(0.999, seed) + Math.round(fade * 255);
    this.count++;
  }
  /** `from`: first instance whose data changed this frame (far cells are static between rebuilds). */
  commit(from = 0) {
    this.geometry.instanceCount = this.count;
    this.mesh.visible = this.count > 0;
    if (this._realloc) {
      from = 0;
      this._realloc = false;
    }
    const n = this.count - from;
    if (n > 0) {
      for (const a of [this.a0, this.a1]) {
        a.clearUpdateRanges();
        a.addUpdateRange(from * 4, n * 4);
        a.needsUpdate = true;
      }
    }
  }
  dispose() {
    this.group.remove(this.mesh);
    this.geometry.dispose();
  }
}

export class Vegetation {
  constructor(engine, library) {
    this.engine = engine;
    this.library = library;
    this.group = new THREE.Group();
    this.group.name = 'scatter';
    this.batches = new Map(); // "model|lod|detail" -> Batch
    this.impostors = new Map(); // model -> ImpostorBatch
    this.impostorsR = new Map(); // model -> reflection-only impostors standing in for mesh LOD1/2
    this.layerInfo = new Map(); // layerKey -> {layer, recs:[rec|null], detail}
    this.stats = { instances: 0, triangles: 0, impostors: 0 };
    this.treeLod = engine.quality.treeLod || [26, 62, 125];
    this.impostorRange = engine.quality.impostorRange || 4200;
    this.detailScale = engine.quality.detailDensity ?? 1;
    this.ready = false;
    this._farKey = '';
    this._farLists = new Map();
  }

  /** Load every model referenced by the world's biomes. */
  async setWorld(world, onProgress) {
    this.clear();
    this.world = world;
    const layers = world.layerList();
    const ids = new Set();
    for (const L of layers) for (const m of L.layer.models) ids.add(m.id);
    let done = 0;
    const total = ids.size;
    const errors = [];
    await Promise.all(
      [...ids].map((id) =>
        this.library
          .load(id)
          .catch((e) => {
            errors.push(e.message);
            return null;
          })
          .then(() => onProgress && onProgress(`Loading models (${++done}/${total})`, done / total)),
      ),
    );
    if (errors.length) throw new Error(`${errors.length} scatter model(s) failed to load:\n${[...new Set(errors)].slice(0, 6).join('\n')}`);
    this.refreshLayers();
    this.ready = true;
  }

  refreshLayers() {
    this.layerInfo.clear();
    for (const L of this.world.layerList()) {
      const recs = L.layer.models.map((m) => this.library.models.get(m.id) || null);
      for (const r of recs) if (r && r.isTree && r.lods.length >= 3) this.library.bakeImpostor(r);
      this.layerInfo.set(L.key, { layer: L.layer, recs, detail: L.detail });
    }
    this._farKey = '';
  }

  /** Ensure models for newly referenced ids are loaded (after biome edits). */
  async ensureModels() {
    const ids = new Set();
    for (const L of this.world.layerList()) for (const m of L.layer.models) ids.add(m.id);
    await Promise.all([...ids].map((id) => this.library.load(id)));
    this.refreshLayers();
  }

  _batch(rec, lod, detail) {
    const key = rec.id + '|' + lod + (detail ? '|d' : '');
    let b = this.batches.get(key);
    if (!b) {
      const tree = rec.isTree && rec.lods.length >= 3;
      b = new Batch(rec, lod, this.group, { shadow: !detail, detail, small: !tree, mainOnly: tree && lod >= 1 && !detail });
      this.batches.set(key, b);
    }
    return b;
  }
  _impostor(rec) {
    let b = this.impostors.get(rec.id);
    if (!b) {
      const imp = this.library.bakeImpostor(rec);
      b = new ImpostorBatch(rec, imp, this.group);
      this.impostors.set(rec.id, b);
    }
    return b;
  }

  _impostorR(rec) {
    let b = this.impostorsR.get(rec.id);
    if (!b) {
      b = new ImpostorBatch(rec, this.library.bakeImpostor(rec), this.group, true);
      this.impostorsR.set(rec.id, b);
    }
    return b;
  }

  invalidate() {
    this._farKey = '';
  }

  update(camera) {
    if (!this.ready || !this.world) return;
    const world = this.world;
    const cx = camera.position.x,
      cy = camera.position.y,
      cz = camera.position.z;
    for (const b of this.batches.values()) b.count = 0;
    for (const b of this.impostorsR.values()) b.count = 0;
    const [L0, L1, L2] = this.treeLod;
    const half = world.size / 2;
    const cs = SCATTER_CELL;
    const nc = Math.ceil(world.size / cs);
    const nearR = L2 + cs;
    const ccx = Math.floor((cx + half) / cs),
      ccz = Math.floor((cz + half) / cs);
    const rc = Math.ceil(nearR / cs);
    // far impostor cells only need rebuilding when the camera changes scatter cell
    const farKey = ccx + ',' + ccz + ',' + world.version.scatter;
    const rebuildFar = farKey !== this._farKey;
    if (rebuildFar) {
      this._farKey = farKey;
      for (const b of this.impostors.values()) b.count = 0;
      const maxC = Math.ceil(this.impostorRange / cs);
      for (let dz = -maxC; dz <= maxC; dz++) {
        for (let dx = -maxC; dx <= maxC; dx++) {
          if (Math.abs(dx) <= rc && Math.abs(dz) <= rc) continue;
          const gx = ccx + dx,
            gz = ccz + dz;
          if (gx < 0 || gz < 0 || gx >= nc || gz >= nc) continue;
          const cell = world.scatterCells.get(gx + ',' + gz);
          if (!cell) continue;
          for (const [key, inst] of cell.layers) {
            const info = this.layerInfo.get(key);
            if (!info) continue;
            const d = inst.data;
            for (let i = 0; i < inst.count; i++) {
              const o = i * INSTANCE_STRIDE;
              const variant = d[o + 7] | 0;
              const rec = info.recs[variant];
              if (!rec || !rec.isTree || rec.lods.length < 3) continue;
              this._impostor(rec).push(d[o], d[o + 1], d[o + 2], d[o + 3], d[o + 4], d[o + 7] - variant, 1);
            }
          }
        }
      }
      for (const b of this.impostors.values()) {
        b.farCount = b.count;
      }
    } else {
      for (const b of this.impostors.values()) b.count = b.farCount || 0;
    }
    // ---- near cells: per-instance LOD ----
    let instCount = 0;
    for (let dz = -rc; dz <= rc; dz++) {
      for (let dx = -rc; dx <= rc; dx++) {
        const gx = ccx + dx,
          gz = ccz + dz;
        if (gx < 0 || gz < 0 || gx >= nc || gz >= nc) continue;
        const cell = world.scatterCells.get(gx + ',' + gz);
        if (!cell) continue;
        for (const [key, inst] of cell.layers) {
          const info = this.layerInfo.get(key);
          if (!info) continue;
          const d = inst.data;
          for (let i = 0; i < inst.count; i++) {
            const o = i * INSTANCE_STRIDE;
            const variant = d[o + 7] | 0;
            const rec = info.recs[variant];
            if (!rec) continue;
            const x = d[o],
              y = d[o + 1],
              z = d[o + 2],
              sc = d[o + 3];
            const dist = Math.hypot(x - cx, y - cy, z - cz);
            const seed = d[o + 7] - variant;
            if (rec.isTree && rec.lods.length >= 3) {
              const size = Math.max(0.6, (rec.height * sc) / 16);
              const t0 = L0 * size,
                t1 = L1 * size,
                t2 = L2;
              let lod, fade = 1;
              if (dist < t0) lod = 0;
              else if (dist < t1) lod = 1;
              else if (dist < t2) lod = 2;
              else lod = 3;
              // cross-fade: the finer LOD dithers out over the last 10% while the coarser one is already drawn
              const lim = lod === 0 ? t0 : lod === 1 ? t1 : lod === 2 ? t2 : 0;
              if (lod < 3 && dist > lim * 0.9) {
                fade = (lim - dist) / (lim * 0.1);
                if (lod + 1 < 3) this._batch(rec, lod + 1, false).push(x, y, z, sc, d[o + 4], d[o + 5], d[o + 6], seed, 1);
                else this._impostor(rec).push(x, y, z, sc, d[o + 4], seed, 1);
              }
              if (lod === 3) this._impostor(rec).push(x, y, z, sc, d[o + 4], seed, 1);
              else {
                this._batch(rec, lod, false).push(x, y, z, sc, d[o + 4], d[o + 5], d[o + 6], seed, fade);
                if (lod >= 1) this._impostorR(rec).push(x, y, z, sc, d[o + 4], seed, 1);
              }
            } else {
              // small objects: LOD by apparent size
              const r = Math.max(rec.radius, rec.height * 0.5) * sc;
              const nl = rec.lods.length;
              const t0 = 2.5 + r * 20,
                t1 = 8 + r * 60,
                t2 = Math.min(nearR, 30 + r * 210);
              let lod;
              if (dist < t0) lod = 0;
              else if (dist < t1) lod = Math.min(1, nl - 1);
              else if (dist < t2) lod = nl - 1;
              else continue;
              const fade = dist > t2 * 0.88 ? (t2 - dist) / (t2 * 0.12) : 1;
              this._batch(rec, lod, false).push(x, y, z, sc, d[o + 4], d[o + 5], d[o + 6], seed, fade);
            }
            instCount++;
          }
        }
      }
    }
    // ---- detail layers around the camera ----
    const detailRange = 78;
    const dc = DETAIL_CELL;
    const dcx = Math.floor(cx / dc),
      dcz = Math.floor(cz / dc);
    const dr = Math.ceil(detailRange / dc);
    // only when reasonably close to the ground
    const ground = world.hFinal.inBounds(cx, cz) ? world.hFinal.sample(cx, cz) : -1e9;
    const alt = cy - ground;
    if (alt < 160) {
      const fwd = this._fwd || (this._fwd = new THREE.Vector3());
      fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
      for (let dz = -dr; dz <= dr; dz++) {
        for (let dx = -dr; dx <= dr; dx++) {
          const ox = (dcx + dx + 0.5) * dc - cx,
            oz = (dcz + dz + 0.5) * dc - cz;
          const cd = Math.hypot(ox, oz);
          if (cd > detailRange + dc) continue;
          // skip cells well behind the camera
          if (cd > dc * 1.6 && (ox * fwd.x + oz * fwd.z) / cd < -0.35) continue;
          const cell = world.getDetailCell(dcx + dx, dcz + dz, dc);
          for (const [key, inst] of cell.layers) {
            const info = this.layerInfo.get(key);
            if (!info) continue;
            const range = Math.min(detailRange, info.layer.range ?? 50) * (alt > 40 ? Math.max(0.3, 1 - (alt - 40) / 120) : 1);
            const d = inst.data;
            for (let i = 0; i < inst.count; i++) {
              const o = i * INSTANCE_STRIDE;
              const x = d[o],
                z = d[o + 2];
              const dist = Math.hypot(x - cx, d[o + 1] - cy, z - cz);
              if (dist > range) continue;
              const variant = d[o + 7] | 0;
              const rec = info.recs[variant];
              if (!rec) continue;
              const seed = d[o + 7] - variant;
              // distance thinning: far clumps are probabilistically dropped, survivors grow to keep coverage
              // dense carpet close to the viewer, thinning quickly with distance where the ground
              // texture takes over; survivors grow to keep the visual coverage
              const t = dist / range;
              const u = Math.min(1, Math.max(0, (t - 0.14) / 0.66));
              const keep = 1 - 0.86 * u * u * (3 - 2 * u);
              if (seed > keep * this.detailScale) continue;
              const grow = 1 + 0.9 * t;
              const fade = t > 0.82 ? (1 - t) / 0.18 : 1;
              const lod = dist < 4.5 ? 0 : dist < 16 ? Math.min(1, rec.lods.length - 1) : rec.lods.length - 1;
              this._batch(rec, lod, true).push(x, d[o + 1], z, d[o + 3] * grow, d[o + 4], d[o + 5], d[o + 6], seed, fade);
              instCount++;
            }
          }
        }
      }
    }
    let tris = 0;
    for (const b of this.batches.values()) {
      b.commit();
      tris += b.count * b.rec.lods[b.lodIndex].triangles;
    }
    let imps = 0;
    for (const b of this.impostors.values()) {
      b.commit(rebuildFar ? 0 : b.farCount || 0);
      imps += b.count;
    }
    for (const b of this.impostorsR.values()) b.commit();
    this.stats.instances = instCount;
    this.stats.triangles = tris;
    this.stats.impostors = imps;
  }

  /** Pick the nearest persistent scatter instance hit by a ray (bounding-sphere test). */
  pick(origin, dir, maxDist = 400) {
    const world = this.world;
    if (!world) return null;
    let best = null;
    const half = world.size / 2;
    const cs = SCATTER_CELL;
    const nc = Math.ceil(world.size / cs);
    for (const cell of world.scatterCells.values()) {
      const cxm = -half + (cell.cx + 0.5) * cs,
        czm = -half + (cell.cz + 0.5) * cs;
      // quick reject: distance from the cell centre to the ray in xz
      const vx = cxm - origin.x,
        vz = czm - origin.z;
      const tproj = vx * dir.x + vz * dir.z;
      if (tproj < -cs || tproj > maxDist + cs) continue;
      const px = vx - dir.x * tproj,
        pz = vz - dir.z * tproj;
      if (px * px + pz * pz > cs * cs * 1.2) continue;
      for (const [key, inst] of cell.layers) {
        const info = this.layerInfo.get(key);
        if (!info) continue;
        const d = inst.data;
        for (let i = 0; i < inst.count; i++) {
          const o = i * INSTANCE_STRIDE;
          const variant = d[o + 7] | 0;
          const rec = info.recs[variant];
          if (!rec) continue;
          const sc = d[o + 3];
          const h = rec.height * sc,
            r = Math.max(0.25, rec.radius * sc * (rec.isTree ? 0.45 : 0.9));
          // capsule approximated by sphere at mid height
          const ccx = d[o] - origin.x,
            ccy = d[o + 1] + h * 0.5 - origin.y,
            ccz = d[o + 2] - origin.z;
          const tt = ccx * dir.x + ccy * dir.y + ccz * dir.z;
          if (tt < 0 || tt > maxDist) continue;
          const ex = ccx - dir.x * tt,
            ey = (ccy - dir.y * tt) * (r / Math.max(r, h * 0.5)),
            ez = ccz - dir.z * tt;
          if (ex * ex + ey * ey + ez * ez < r * r && (!best || tt < best.t)) {
            best = { t: tt, layerKey: key, cell, index: i, modelId: rec.id, x: d[o], y: d[o + 1], z: d[o + 2], scale: sc, rot: d[o + 4], gi: inst.keys ? inst.keys[i * 2] : 0, gj: inst.keys ? inst.keys[i * 2 + 1] : 0, layerId: info.layer.id };
          }
        }
      }
    }
    void nc;
    return best;
  }

  clear() {
    for (const b of this.batches.values()) b.dispose();
    for (const b of this.impostors.values()) b.dispose();
    for (const b of this.impostorsR.values()) b.dispose();
    this.batches.clear();
    this.impostors.clear();
    this.impostorsR.clear();
    this.ready = false;
  }
}
