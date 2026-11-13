// Camera controllers: orbit (editor default), free fly and grounded first-person walk.
// Mouse: RMB drag = look/orbit, MMB drag (or Shift+RMB) = pan, wheel = zoom / fly speed.
// Keys: WASD move, Q/E down/up (fly), Shift fast, Space jump (walk) / ascend (swim), C dive.

import * as THREE from 'three';
import { NO_WATER } from '../core/waterField.js';
import { INSTANCE_STRIDE, SCATTER_CELL } from '../core/biomes.js';

const EYE = 1.7;

export class CameraControl {
  constructor(app) {
    this.app = app;
    this.camera = app.engine.camera;
    this.mode = 'orbit';
    this.target = new THREE.Vector3();
    this.distance = 300;
    this.yaw = 0.6;
    this.pitch = -0.5;
    this.keys = new Set();
    this.flySpeed = 30;
    this.vel = new THREE.Vector3();
    this.vy = 0;
    this.onGround = false;
    this.swimming = false;
    this.fov = 55;
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this.drag = null;
    this.locked = false;
  }

  get world() {
    return this.app.world;
  }

  setMode(mode) {
    if (mode === this.mode) return;
    const cam = this.camera;
    const w = this.world;
    if (mode === 'orbit') {
      // orbit around the point the camera is looking at
      const dir = this._tmp.set(0, 0, -1).applyQuaternion(cam.quaternion);
      const hit = w && w.raycast(cam.position.x, cam.position.y, cam.position.z, dir.x, dir.y, dir.z, 4000);
      this.distance = hit ? Math.max(8, hit.t) : 150;
      this.target.copy(cam.position).addScaledVector(dir, this.distance);
    } else if (mode === 'walk' && w) {
      // drop to the ground below the camera (or the look-at point when coming from far away)
      let x = cam.position.x,
        z = cam.position.z;
      if (this.mode === 'orbit' && this.distance < 2500) {
        x = this.target.x;
        z = this.target.z;
      }
      const half = w.size / 2 - 3;
      x = Math.max(-half, Math.min(half, x));
      z = Math.max(-half, Math.min(half, z));
      cam.position.set(x, w.heightAt(x, z) + EYE, z);
      this.pitch = Math.max(-0.6, Math.min(0.4, this.pitch));
      this.vy = 0;
    }
    this.mode = mode;
    this.app.onCameraMode?.(mode);
  }

  /** Programmatic placement (bookmarks, showcases, tests). */
  setPose(p) {
    if (p.mode) this.mode = p.mode;
    const cam = this.camera;
    if (p.position) cam.position.set(p.position[0], p.position[1], p.position[2]);
    if (p.yaw !== undefined) this.yaw = p.yaw;
    if (p.pitch !== undefined) this.pitch = p.pitch;
    if (p.lookAt) {
      const d = this._tmp.set(p.lookAt[0], p.lookAt[1], p.lookAt[2]).sub(cam.position);
      this.distance = d.length();
      d.normalize();
      this.pitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
      this.yaw = Math.atan2(-d.x, -d.z);
      this.target.set(p.lookAt[0], p.lookAt[1], p.lookAt[2]);
    } else {
      const dir = this.forward(this._tmp);
      this.distance = p.distance ?? this.distance;
      this.target.copy(cam.position).addScaledVector(dir, this.distance);
    }
    if (p.fov) this.fov = p.fov;
    this.apply();
    this.app.onCameraMode?.(this.mode);
  }
  getPose() {
    const c = this.camera.position;
    return { mode: this.mode, position: [c.x, c.y, c.z], yaw: this.yaw, pitch: this.pitch, distance: this.distance, fov: this.fov };
  }

  forward(out) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  apply() {
    const cam = this.camera;
    if (this.mode === 'orbit') {
      const f = this.forward(this._tmp);
      cam.position.copy(this.target).addScaledVector(f, -this.distance);
      this._keepAboveGround(0.6);
    }
    cam.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    if (cam.fov !== this.fov) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
    // near plane adapts so close-up water / grass does not clip while distant terrain keeps precision
    const w = this.world;
    let near = 0.2;
    if (w && w.hFinal.inBounds(cam.position.x, cam.position.z)) {
      const alt = cam.position.y - w.heightAt(cam.position.x, cam.position.z);
      near = alt < 4 ? 0.06 : alt < 40 ? 0.15 : alt < 400 ? 0.5 : 2;
    } else near = 1;
    if (Math.abs(cam.near - near) > 1e-4) {
      cam.near = near;
      cam.updateProjectionMatrix();
    }
  }

  _keepAboveGround(margin) {
    const w = this.world;
    const p = this.camera.position;
    if (!w) return;
    const g = w.hFinal.inBounds(p.x, p.z) ? w.heightAt(p.x, p.z) : this.app.engine.terrain.ringHeightAt ? this.app.engine.terrain.ringHeightAt(p.x, p.z) : -1e9;
    if (p.y < g + margin) p.y = g + margin;
  }

  // ---- input ----
  onPointerDown(e) {
    if (e.button === 2 || e.button === 1 || (e.button === 0 && e.altKey)) {
      this.drag = { x: e.clientX, y: e.clientY, pan: e.button === 1 || e.shiftKey, button: e.button };
      return true;
    }
    return false;
  }
  onPointerMove(e) {
    if (!this.drag && !this.locked) return false;
    const dx = this.locked ? e.movementX : e.clientX - this.drag.x;
    const dy = this.locked ? e.movementY : e.clientY - this.drag.y;
    if (this.drag) {
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
    }
    if (this.drag && this.drag.pan && this.mode !== 'walk') {
      const cam = this.camera;
      const right = this._tmp.set(1, 0, 0).applyQuaternion(cam.quaternion);
      const up = this._tmp2.set(0, 1, 0).applyQuaternion(cam.quaternion);
      const k = (this.mode === 'orbit' ? this.distance : 60) * 0.0016;
      const mv = right.multiplyScalar(-dx * k).addScaledVector(up, dy * k);
      if (this.mode === 'orbit') this.target.add(mv);
      else cam.position.add(mv);
    } else {
      this.yaw -= dx * 0.0032;
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - dy * 0.0032));
    }
    return true;
  }
  onPointerUp() {
    const had = !!this.drag;
    this.drag = null;
    return had;
  }
  onWheel(e) {
    const s = Math.sign(e.deltaY);
    if (this.mode === 'orbit') {
      // zoom towards the cursor's terrain point
      const hit = this.app.pickTerrain(e);
      const old = this.distance;
      this.distance = Math.max(1.5, Math.min(30000, this.distance * (s > 0 ? 1.14 : 0.877)));
      if (hit && s < 0) this.target.lerp(this._tmp.set(hit.x, hit.y, hit.z), 0.12);
      void old;
    } else if (this.mode === 'fly') {
      this.flySpeed = Math.max(1, Math.min(600, this.flySpeed * (s > 0 ? 0.8 : 1.25)));
      this.app.status?.(`Fly speed ${this.flySpeed.toFixed(0)} m/s`);
    } else {
      this.fov = Math.max(20, Math.min(80, this.fov + s * 3));
    }
  }
  focus(x, y, z, dist) {
    this.mode = 'orbit';
    this.target.set(x, y, z);
    this.distance = dist ?? this.distance;
    this.app.onCameraMode?.('orbit');
  }

  update(dt) {
    const cam = this.camera;
    const w = this.world;
    const k = this.keys;
    const fwd = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const str = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const fast = k.has('ShiftLeft') || k.has('ShiftRight');
    if (this.mode === 'orbit') {
      if (fwd || str) {
        const sp = this.distance * 0.9 * dt * (fast ? 3 : 1);
        this.target.x += (-Math.sin(this.yaw) * fwd + Math.cos(this.yaw) * str) * sp;
        this.target.z += (-Math.cos(this.yaw) * fwd - Math.sin(this.yaw) * str) * sp;
      }
      // the orbit target rides on the terrain so zooming in always arrives at the ground
      if (w && w.hFinal.inBounds(this.target.x, this.target.z)) {
        const g = w.heightAt(this.target.x, this.target.z);
        if (fwd || str) this.target.y = g;
      }
    } else if (this.mode === 'fly') {
      const up = (k.has('KeyE') || k.has('Space') ? 1 : 0) - (k.has('KeyQ') || k.has('KeyC') ? 1 : 0);
      const f = this.forward(this._tmp);
      const right = this._tmp2.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const sp = this.flySpeed * (fast ? 4 : 1);
      const want = new THREE.Vector3().addScaledVector(f, fwd * sp).addScaledVector(right, str * sp);
      want.y += up * sp;
      // smooth acceleration
      this.vel.lerp(want, Math.min(1, dt * 8));
      cam.position.addScaledVector(this.vel, dt);
      this._keepAboveGround(0.25);
    } else if (this.mode === 'walk' && w) {
      this._walk(dt, fwd, str, fast);
    }
    this.apply();
  }

  _walk(dt, fwd, str, fast) {
    const cam = this.camera;
    const w = this.world;
    const p = cam.position;
    const half = w.size / 2 - 2;
    const ground = w.heightAt(p.x, p.z);
    const surf = w.waterSurfaceAt(p.x, p.z);
    const depth = surf > NO_WATER * 0.5 ? surf - ground : 0;
    const swim = depth > 1.35;
    const k = this.keys;
    let speed = fast ? 5.2 : 1.6;
    if (depth > 0.3) speed *= swim ? 0.55 : Math.max(0.45, 1 - depth * 0.5); // wading slows you down
    const dirx = -Math.sin(this.yaw) * fwd + Math.cos(this.yaw) * str;
    const dirz = -Math.cos(this.yaw) * fwd - Math.sin(this.yaw) * str;
    const l = Math.hypot(dirx, dirz) || 1;
    let nx = p.x + (dirx / l) * speed * dt * (fwd || str ? 1 : 0);
    let nz = p.z + (dirz / l) * speed * dt * (fwd || str ? 1 : 0);
    // river current pushes a wading / swimming walker
    if (depth > 0.5) {
      const v = w.water.velocityAt(p.x, p.z);
      const push = Math.min(1, depth / 1.2) * 0.5;
      nx += v[0] * push * dt;
      nz += v[1] * push * dt;
    }
    nx = Math.max(-half, Math.min(half, nx));
    nz = Math.max(-half, Math.min(half, nz));
    // slope limit: cannot walk up faces steeper than ~50 degrees
    const g2 = w.heightAt(nx, nz);
    const step = Math.hypot(nx - p.x, nz - p.z);
    if (!swim && step > 1e-5 && (g2 - ground) / step > 1.2) {
      nx = p.x;
      nz = p.z;
    }
    [nx, nz] = this._collide(nx, nz);
    p.x = nx;
    p.z = nz;
    const g = w.heightAt(p.x, p.z);
    if (swim) {
      // float with the eyes just above the surface; C dives, Space rises
      const s2 = this.app.engine.waterLevelAtCamera > NO_WATER * 0.5 ? this.app.engine.waterLevelAtCamera : surf;
      const dive = (k.has('KeyC') ? 1 : 0) - (k.has('Space') ? 1 : 0);
      if (dive !== 0 || this.diving) {
        this.diving = p.y < s2 - 0.05 || dive > 0;
        this.vy += (-dive * 2.2 - this.vy * 2.5) * dt;
        if (dive === 0) this.vy += 0.5 * dt; // slight positive buoyancy
        p.y += this.vy * dt;
        if (p.y > s2 + 0.22) {
          p.y = s2 + 0.22;
          this.diving = false;
        }
      } else {
        const tgt = s2 + 0.22;
        p.y += (tgt - p.y) * Math.min(1, dt * 5);
        this.vy = 0;
      }
      if (p.y < g + 0.35) p.y = g + 0.35;
      this.onGround = false;
    } else {
      this.diving = false;
      const feet = g + EYE;
      if (this.onGround && k.has('Space')) {
        this.vy = 4.2;
        this.onGround = false;
      }
      this.vy -= 9.81 * dt;
      p.y += this.vy * dt;
      if (p.y <= feet) {
        // smooth step-up, hard landing
        p.y = this.onGround ? p.y + (feet - p.y) * Math.min(1, dt * 14) : feet;
        this.vy = 0;
        this.onGround = true;
      } else if (p.y - feet > 0.25) this.onGround = false;
      // head bob while walking on land
      if (this.onGround && (fwd || str)) {
        this.bob = (this.bob || 0) + dt * speed * 3.6;
        p.y += Math.sin(this.bob) * 0.012 * Math.min(1.5, speed);
      }
    }
  }

  /** Circle collisions against tree trunks, boulders and structure footprints. */
  _collide(x, z) {
    const w = this.world;
    const R = 0.32;
    const half = w.size / 2;
    const cs = SCATTER_CELL;
    const cx = Math.floor((x + half) / cs),
      cz = Math.floor((z + half) / cs);
    const veg = this.app.engine.vegetation;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cell = w.scatterCells.get(cx + dx + ',' + (cz + dz));
        if (!cell) continue;
        for (const [key, inst] of cell.layers) {
          const info = veg.layerInfo.get(key);
          if (!info) continue;
          const d = inst.data;
          for (let i = 0; i < inst.count; i++) {
            const o = i * INSTANCE_STRIDE;
            const ex = x - d[o],
              ez = z - d[o + 2];
            if (Math.abs(ex) > 4 || Math.abs(ez) > 4) continue;
            const rec = info.recs[d[o + 7] | 0];
            if (!rec) continue;
            const sc = d[o + 3];
            let r;
            if (rec.isTree) r = Math.max(0.08, (rec.info.trunkRadius || 0.15) * sc);
            else if (rec.info.category === 'rock' && rec.height * sc > 0.55) r = rec.radius * sc * 0.62;
            else continue;
            const dist = Math.hypot(ex, ez);
            if (dist < r + R && dist > 1e-4) {
              x = d[o] + (ex / dist) * (r + R);
              z = d[o + 2] + (ez / dist) * (r + R);
            }
          }
        }
      }
    }
    for (const s of this.app.engine.objects.structures.values()) {
      const doc = s.doc;
      const fp = this.app.footprint(doc);
      if (!fp || fp.overWater) continue;
      const c = Math.cos(doc.rot || 0),
        sn = Math.sin(doc.rot || 0);
      const lx = (x - doc.x) * c - (z - doc.z) * sn,
        lz = (x - doc.x) * sn + (z - doc.z) * c;
      const hx = fp.halfX + R,
        hz = fp.halfZ + R;
      if (Math.abs(lx) < hx && Math.abs(lz) < hz) {
        // push out along the axis of least penetration
        const px = hx - Math.abs(lx),
          pz = hz - Math.abs(lz);
        let ox = lx,
          oz = lz;
        if (px < pz) ox = Math.sign(lx || 1) * hx;
        else oz = Math.sign(lz || 1) * hz;
        x = doc.x + ox * c + oz * sn;
        z = doc.z - ox * sn + oz * c;
      }
    }
    return [x, z];
  }
}
