// Individually placed things: parametric structures, model structures, manual objects and
// floating objects with rigid-body buoyancy that couples to the ripple simulation.

import * as THREE from 'three';
import { buildStructureGeometry, cabinParams, MODEL_DECK_Y } from '../core/structures.js';
import { NO_WATER } from '../core/waterField.js';
import { CASCADE_LENGTHS } from './WaterSim.js';

const STRUCT_ROLES = { wall: 'wood_planks', roof: 'roof', stone: 'stone_wall', door: 'wood_door', trim: 'wood_planks' };

export class SceneObjects {
  constructor(engine, library, manifest, baseUrl) {
    this.engine = engine;
    this.library = library;
    this.manifest = manifest;
    this.baseUrl = baseUrl;
    this.group = new THREE.Group();
    this.group.name = 'objects';
    this.structures = new Map(); // id -> {group, doc}
    this.objects = new Map(); // id -> {group, doc, rec, body?}
    this.texLoader = new THREE.TextureLoader();
    this.structMats = new Map();
    this.selected = null;
    this.bodies = [];
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
  }

  _tex(url, srgb) {
    const t = this.texLoader.load(url, undefined, undefined, () => this.engine.reportError(`Missing texture ${url}. Run "npm run assets".`));
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  }

  /** Materials for a structure slot, from the project's structure material assignment. */
  _structMaterial(slot, project) {
    const assign = project.materials?.structure || {};
    let texId = assign[slot];
    if (!texId && STRUCT_ROLES[slot]) {
      const role = STRUCT_ROLES[slot];
      texId = Object.keys(this.manifest.textures).find((k) => this.manifest.textures[k].role === role);
    }
    const key = slot + ':' + (texId || 'flat');
    if (this.structMats.has(key)) return this.structMats.get(key);
    const lib = this.library;
    const fake = { height: 6, radius: 5 };
    let entry;
    if (slot === 'glass') {
      const orm = new THREE.DataTexture(new Uint8Array([255, 22, 0, 255]), 1, 1);
      orm.needsUpdate = true;
      entry = { mats: lib._makeMaterials({ name: 'glass', map: null, nor: null, orm, foliage: false, doubleSided: true, rec: fake, flex: 0 }), tint: [0.02, 0.028, 0.035], uv: 1 };
    } else {
      if (!texId) throw new Error(`No texture set with role "${STRUCT_ROLES[slot]}" for structure ${slot}. Run "npm run assets".`);
      const t = this.manifest.textures[texId];
      const map = this._tex(this.baseUrl + t.files.diff, true);
      const nor = this._tex(this.baseUrl + t.files.nor, false);
      const orm = this._tex(this.baseUrl + t.files.arm, false);
      // geometry uvs are in metres * 0.5; rescale to the texture's real tile size
      entry = { mats: lib._makeMaterials({ name: slot, map, nor, orm, foliage: false, doubleSided: true, rec: fake, flex: 0 }), tint: slot === 'trim' ? [0.62, 0.58, 0.54] : slot === 'door' ? [0.8, 0.8, 0.8] : [1, 1, 1], uv: 2 / (t.tileSizeM || 2) };
    }
    this.structMats.set(key, entry);
    return entry;
  }

  /** A fresh material pair (own transform uniform) for one structure part. */
  _structPair(slot, project) {
    const e = this._structMaterial(slot, project);
    const pair = this.library.singleMaterials(e.mats);
    for (const m of [pair.color, pair.depth]) {
      m.uniforms.uTint.value.set(e.tint[0], e.tint[1], e.tint[2]);
      m.uniforms.uMatParams.value.w = e.uv;
    }
    return pair;
  }

  async sync(world) {
    this.world = world;
    const project = world.project;
    // ---- structures ----
    const seen = new Set();
    for (const s of project.structures || []) {
      seen.add(s.id);
      const sig = JSON.stringify(s);
      let e = this.structures.get(s.id);
      if (!e || e.sig !== sig) {
        if (e) this._removeEntry(e);
        e = await this._buildStructure(s, project);
        e.sig = sig;
        this.structures.set(s.id, e);
      }
      const y = s.type === 'model' && !this._hasPad(s) ? (s.y ?? this._groundOrWater(s)) : world.structureLevel(s);
      e.group.position.set(s.x, y, s.z);
      e.group.rotation.set(0, s.rot || 0, 0);
      e.group.scale.setScalar(s.scale || 1);
      e.group.updateMatrixWorld(true);
      this._pushMatrices(e);
    }
    for (const [id, e] of this.structures) {
      if (!seen.has(id)) {
        this._removeEntry(e);
        this.structures.delete(id);
      }
    }
    // ---- objects ----
    const seenO = new Set();
    for (const o of project.objects || []) {
      seenO.add(o.id);
      let e = this.objects.get(o.id);
      const sig = o.model + '|' + !!o.floating;
      if (!e || e.sig !== sig) {
        if (e) this._removeEntry(e);
        e = await this._buildObject(o);
        e.sig = sig;
        this.objects.set(o.id, e);
      }
      e.doc = o;
      if (!o.floating || !e.body || e.body.resetKey !== `${o.x},${o.z},${o.scale},${o.rot}`) this._placeObject(e, o);
    }
    for (const [id, e] of this.objects) {
      if (!seenO.has(id)) {
        this._removeEntry(e);
        this.objects.delete(id);
      }
    }
    this.bodies = [...this.objects.values()].filter((e) => e.body).map((e) => e.body);
    this.applySelection();
  }

  _hasPad(s) {
    return s.pad === true;
  }
  _groundOrWater(s) {
    const w = this.world;
    const g = w.hFinal.sample(s.x, s.z);
    if (s.overWater) {
      const ws = w.waterSurfaceAt(s.x, s.z);
      // piles stand in the bed: the deck height above water positions the model, not the ground
      if (ws > NO_WATER * 0.5) return ws + (s.deckHeight ?? 0.45) - (s.modelDeckY ?? MODEL_DECK_Y[s.model] ?? 0);
    }
    return g;
  }

  _removeEntry(e) {
    this.group.remove(e.group);
    e.group.traverse((m) => {
      if (m.isMesh && m.userData.ownGeometry) m.geometry.dispose();
    });
  }

  _pushMatrices(e) {
    e.group.traverse((m) => {
      if (m.isMesh && m.material.uniforms?.uObjMatrix) {
        m.material.uniforms.uObjMatrix.value.copy(m.matrixWorld);
        if (m.userData.depthMaterial) m.userData.depthMaterial.uniforms.uObjMatrix.value.copy(m.matrixWorld);
      }
    });
  }

  async _buildStructure(s, project) {
    const group = new THREE.Group();
    group.userData.docId = s.id;
    group.userData.kind = 'structure';
    if (s.type === 'model') {
      const rec = await this.library.load(s.model);
      this._addModelMeshes(group, rec, 0);
      this.group.add(group);
      return { group, doc: s, rec, radius: rec.radius, height: rec.height };
    }
    const built = buildStructureGeometry(s);
    for (const part of built.parts) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(part.normals, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(part.uvs, 2));
      g.setIndex(new THREE.BufferAttribute(part.indices, 1));
      g.computeBoundingSphere();
      const pair = this._structPair(part.material, project);
      const mesh = new THREE.Mesh(g, pair.color);
      mesh.userData.depthMaterial = pair.depth;
      mesh.userData.ownGeometry = true;
      mesh.layers.enable(2);
      mesh.frustumCulled = false;
      group.add(mesh);
    }
    const P = cabinParams(s);
    this.group.add(group);
    return { group, doc: s, radius: Math.hypot(P.w, P.d) / 2 + 1, height: built.height };
  }

  _addModelMeshes(group, rec, lodIndex) {
    const lod = rec.lods[Math.min(lodIndex, rec.lods.length - 1)];
    for (const prim of lod.prims) {
      const pair = this.library.singleMaterials(prim.mats);
      const mesh = new THREE.Mesh(prim.geometry, pair.color);
      mesh.userData.depthMaterial = pair.depth;
      mesh.layers.enable(2);
      mesh.frustumCulled = false;
      group.add(mesh);
    }
  }

  async _buildObject(o) {
    const rec = await this.library.load(o.model);
    const group = new THREE.Group();
    group.userData.docId = o.id;
    group.userData.kind = 'object';
    this._addModelMeshes(group, rec, 0);
    this.group.add(group);
    const e = { group, doc: o, rec, radius: rec.radius * (o.scale || 1), height: rec.height * (o.scale || 1) };
    if (o.floating) e.body = this._makeBody(e, o);
    return e;
  }

  _placeObject(e, o) {
    const w = this.world;
    const sc = o.scale || 1;
    let y = o.y;
    if (y === undefined || y === null) y = w.hFinal.sample(o.x, o.z) - (o.sink ?? 0) * sc;
    e.group.position.set(o.x, y, o.z);
    e.group.rotation.set(o.pitch || 0, o.rot || 0, o.roll || 0);
    e.group.scale.setScalar(sc);
    e.group.updateMatrixWorld(true);
    this._pushMatrices(e);
    e.radius = e.rec.radius * sc;
    e.height = e.rec.height * sc;
    if (e.body) {
      const b = e.body;
      const ws = w.waterSurfaceAt(o.x, o.z);
      b.pos.set(o.x, (ws > NO_WATER * 0.5 ? ws : w.hFinal.sample(o.x, o.z)) + b.height * 0.2, o.z);
      b.vel.set(0, 0, 0);
      b.angVel.set(0, 0, 0);
      b.quat.setFromEuler(new THREE.Euler(0, o.rot || 0, 0));
      b.resetKey = `${o.x},${o.z},${o.scale},${o.rot}`;
      b.scale = sc;
      this._configureBody(b, e.rec, sc, o);
    }
  }

  _makeBody(e, o) {
    const b = { entry: e, pos: new THREE.Vector3(), vel: new THREE.Vector3(), angVel: new THREE.Vector3(), quat: new THREE.Quaternion(), points: [], resetKey: '', push: new THREE.Vector3(), held: null };
    this._configureBody(b, e.rec, o.scale || 1, o);
    return b;
  }

  _configureBody(b, rec, sc, o) {
    const bd = rec.info.bounds;
    const sx = (bd.max[0] - bd.min[0]) * sc,
      sy = (bd.max[1] - bd.min[1]) * sc,
      sz = (bd.max[2] - bd.min[2]) * sc;
    b.height = sy;
    b.size = new THREE.Vector3(sx, sy, sz);
    // fraction of the volume below the waterline at rest (relative density)
    b.density = o.density ?? 0.45;
    b.mass = Math.max(0.2, sx * sy * sz * 0.5 * 1000 * b.density);
    // buoyancy sample points on the footprint (model space, y measured from the base)
    const cx = ((bd.max[0] + bd.min[0]) / 2) * sc,
      cz = ((bd.max[2] + bd.min[2]) / 2) * sc;
    const hx = sx * 0.38,
      hz = sz * 0.38;
    b.points = [
      [cx - hx, cz - hz],
      [cx + hx, cz - hz],
      [cx + hx, cz + hz],
      [cx - hx, cz + hz],
      [cx, cz],
    ];
    b.centerY = sy * 0.45;
    // metacentric height: ballast / wide waterplane keep the object upright
    b.gm = o.gm ?? Math.max(0.12, 0.3 * Math.min(sx, sz) + 0.12 * sy);
    b.center = new THREE.Vector3(cx, 0, cz);
    // moment of inertia of a box
    b.inertia = new THREE.Vector3((b.mass * (sy * sy + sz * sz)) / 12, (b.mass * (sx * sx + sz * sz)) / 12, (b.mass * (sx * sx + sy * sy)) / 12);
  }

  /** Water surface elevation including dynamic waves, and the flow velocity, at a world point. */
  waterAt(x, z, out) {
    const w = this.world;
    const wf = w.water;
    let level = w.waterSurfaceAt(x, z);
    out.vx = 0;
    out.vz = 0;
    if (level <= NO_WATER * 0.5) {
      const sea = w.seaLevel;
      if (sea === null || w.hFinal.inBounds(x, z)) {
        out.level = NO_WATER;
        return out;
      }
      level = sea;
    }
    const sim = this.engine.waterSim;
    let weights = [0, 0];
    if (w.hFinal.inBounds(x, z)) {
      const gi = Math.round(w.hFinal.toGridZ(z)) * w.res + Math.round(w.hFinal.toGridX(x));
      const t = wf.typeExt[gi] || wf.type[gi];
      level += wf.relief[gi];
      const expo = wf.exposure[gi] / 255;
      const depth = level - w.hFinal.data[gi];
      const ws = w.project.water.waveScale ?? 1;
      if (t === 3) weights = [expo * ws * Math.min(1, Math.max(0, depth) / 6.5), expo * ws * Math.min(1, Math.max(0, depth) / 1.6)];
      else if (t === 2) weights = [0, 0.85 * (0.35 + 0.65 * Math.sqrt(expo)) * ws * (w.project.water.lakeWaveScale ?? 1) * (this.engine.water.lakeAmp ?? 0.5) * Math.min(1, Math.max(0, depth) / 1.6)];
      wf.velocityAt(x, z, this._vel || (this._vel = [0, 0]));
      out.vx = this._vel[0];
      out.vz = this._vel[1];
      if (t === 3) level += this.engine.swellHeightCPU(x, z, depth, wf.shore[gi]);
    } else weights = [1, 1];
    level += sim.sampleHeight(x, z, weights);
    out.level = level;
    return out;
  }

  /** Fixed-step rigid body integration with buoyancy, drag relative to the water, ripple sources. */
  step(dt, time) {
    if (!this.bodies.length || !this.world) return;
    const sim = this.engine.waterSim;
    const sub = 2;
    const h = dt / sub;
    if (!this._lv) this._lv = new THREE.Vector3();
    const tmp = { level: 0, vx: 0, vz: 0 };
    const g = 9.81;
    const r = new THREE.Vector3(),
      f = new THREE.Vector3(),
      torque = new THREE.Vector3(),
      pv = new THREE.Vector3(),
      force = new THREE.Vector3();
    for (const b of this.bodies) {
      for (let s = 0; s < sub; s++) {
        force.set(0, -b.mass * g, 0);
        torque.set(0, 0, 0);
        let wet = 0;
        const np = b.points.length;
        let sinkRate = 0;
        for (const p of b.points) {
          r.set(p[0] - b.center.x, -b.centerY, p[1] - b.center.z).applyQuaternion(b.quat);
          const px = b.pos.x + r.x,
            py = b.pos.y + r.y,
            pz = b.pos.z + r.z;
          this.waterAt(px, pz, tmp);
          if (tmp.level <= NO_WATER * 0.5) continue;
          const depth = tmp.level - py;
          if (depth <= 0) continue;
          wet++;
          const subm = Math.min(1, depth / b.height);
          // buoyancy: displaced-water weight of this column (full submersion carries mass / density)
          const fb = ((b.mass * g) / b.density / np) * subm;
          // point velocity relative to the water
          pv.copy(b.angVel).cross(r).add(b.vel);
          const rvx = pv.x - tmp.vx,
            rvy = pv.y,
            rvz = pv.z - tmp.vz;
          const cLin = (b.mass / np) * 1.6;
          const cQuad = (b.mass / np) * 0.9;
          const sp = Math.hypot(rvx, rvz);
          f.set(-rvx * (cLin * 0.9 + cQuad * sp) * subm, fb - rvy * cLin * 3.2 * subm - rvy * Math.abs(rvy) * cQuad * 2.5 * subm, -rvz * (cLin * 0.9 + cQuad * sp) * subm);
          force.add(f);
          // Torque: the column's buoyancy acts through its centre of buoyancy, which this point model
          // cannot resolve vertically, so the vertical force uses the horizontal lever only (it makes
          // the body follow the wave slope) and hydrostatic stability is the metacentric term below.
          // Horizontal drag acts at the hull (below the centre of mass) and pitches the body a little.
          const lv = this._lv.set(p[0] - b.center.x, 0, p[1] - b.center.z).applyQuaternion(b.quat);
          torque.x += r.y * f.z * 0.3 - lv.z * f.y;
          torque.y += lv.z * f.x - lv.x * f.z;
          torque.z += lv.x * f.y - r.y * f.x * 0.3;
          sinkRate += rvy;
        }
        if (wet > 0) {
          // righting moment m g GM sin(theta) about the horizontal axis (bodyUp x worldUp)
          const up = this._v.set(0, 1, 0).applyQuaternion(b.quat);
          const k = b.mass * g * b.gm * (wet / np);
          torque.x -= up.z * k;
          torque.z += up.x * k;
        }
        if (b.held) {
          // user drag: spring towards the cursor
          f.set((b.held.x - b.pos.x) * b.mass * 6 - b.vel.x * b.mass * 3, 0, (b.held.z - b.pos.z) * b.mass * 6 - b.vel.z * b.mass * 3);
          force.add(f);
        }
        force.add(b.push);
        b.vel.addScaledVector(force, h / b.mass);
        // angular: torque -> world-space angular velocity with heavy rotational damping in water
        const I = (b.inertia.x + b.inertia.y + b.inertia.z) / 3;
        b.angVel.addScaledVector(torque, h / Math.max(I, 1e-3));
        const damp = wet > 0 ? Math.exp(-2.6 * h) : Math.exp(-0.2 * h);
        b.angVel.multiplyScalar(damp);
        if (wet === 0) b.vel.multiplyScalar(Math.exp(-0.05 * h));
        b.pos.addScaledVector(b.vel, h);
        const wlen = b.angVel.length();
        if (wlen > 1e-6) {
          this._q.setFromAxisAngle(this._v.copy(b.angVel).multiplyScalar(1 / wlen), wlen * h);
          b.quat.premultiply(this._q).normalize();
        }
        // ground contact
        const ground = this.world.hFinal.inBounds(b.pos.x, b.pos.z) ? this.world.hFinal.sample(b.pos.x, b.pos.z) : -1e9;
        const minY = ground + b.centerY * 0.5;
        if (b.pos.y < minY) {
          b.pos.y = minY;
          if (b.vel.y < 0) b.vel.y *= -0.2;
          b.vel.x *= 0.9;
          b.vel.z *= 0.9;
          b.angVel.multiplyScalar(0.8);
        }
        // ---- couple to the ripple solver: heave displaces water, forward motion builds a bow wave ----
        if (wet > 0) {
          const rad = Math.max(0.25, Math.min(b.size.x, b.size.z) * 0.55);
          const heave = -(sinkRate / Math.max(1, wet)) * h * 0.55;
          if (Math.abs(heave) > 1e-5) sim.addSource(b.pos.x, b.pos.z, rad * 1.2, Math.max(-0.05, Math.min(0.05, heave)));
          this.waterAt(b.pos.x, b.pos.z, tmp);
          const rvx = b.vel.x - tmp.vx,
            rvz = b.vel.z - tmp.vz;
          const sp = Math.hypot(rvx, rvz);
          if (sp > 0.05) {
            const k = Math.min(0.012, sp * 0.004) * (wet / np);
            const ux = rvx / sp,
              uz = rvz / sp;
            const half = Math.max(b.size.x, b.size.z) * 0.45;
            sim.addSource(b.pos.x + ux * half, b.pos.z + uz * half, rad, k);
            sim.addSource(b.pos.x - ux * half, b.pos.z - uz * half, rad, -k * 0.8);
          }
        }
      }
      b.push.set(0, 0, 0);
      // write back to the scene graph
      const e = b.entry;
      const off = this._v.set(b.center.x, b.centerY, b.center.z).applyQuaternion(b.quat);
      e.group.position.set(b.pos.x - off.x, b.pos.y - off.y, b.pos.z - off.z);
      e.group.quaternion.copy(b.quat);
      e.group.updateMatrixWorld(true);
      this._pushMatrices(e);
    }
    void time;
    void CASCADE_LENGTHS;
  }

  setSelected(id) {
    this.selected = id;
    this.applySelection();
  }
  applySelection() {
    const mark = (e, on) =>
      e.group.traverse((m) => {
        if (m.isMesh && m.material.uniforms?.uHighlight) m.material.uniforms.uHighlight.value.w = on ? 0.35 : 0;
      });
    for (const [id, e] of this.structures) mark(e, id === this.selected);
    for (const [id, e] of this.objects) mark(e, id === this.selected);
  }

  /** Ray pick against bounding spheres of structures and objects. */
  pick(origin, dir) {
    let best = null;
    const test = (e, kind, id) => {
      const c = this._v.copy(e.group.position);
      c.y += (e.height || 1) * 0.5;
      const r = Math.max(0.4, Math.max(e.radius || 1, (e.height || 1) * 0.5));
      const ox = c.x - origin.x,
        oy = c.y - origin.y,
        oz = c.z - origin.z;
      const t = ox * dir.x + oy * dir.y + oz * dir.z;
      if (t < 0) return;
      const d2 = ox * ox + oy * oy + oz * oz - t * t;
      if (d2 < r * r && (!best || t < best.t)) best = { t, kind, id };
    };
    for (const [id, e] of this.structures) test(e, 'structure', id);
    for (const [id, e] of this.objects) test(e, 'object', id);
    return best;
  }

  clear() {
    for (const e of this.structures.values()) this._removeEntry(e);
    for (const e of this.objects.values()) this._removeEntry(e);
    this.structures.clear();
    this.objects.clear();
    this.bodies = [];
  }
}
