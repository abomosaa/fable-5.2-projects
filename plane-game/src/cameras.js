// Camera rig: chase, cockpit, orbit, fly-by and tower views with mouse look, zoom, smoothing
// and vibration (buffet, ground roll, touchdown).

import * as THREE from 'three';
import { nearestAirport, airportWorld } from './world/heightfield.js';

const DEG = Math.PI / 180;
export const CAMERA_MODES = ['chase', 'cockpit', 'orbit', 'flyby', 'tower'];
export const CAMERA_NAMES = { chase: 'Chase view', cockpit: 'Cockpit', orbit: 'Orbit view', flyby: 'Fly-by', tower: 'Tower view' };

const BODY_TO_CAM = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
const UP = new THREE.Vector3(0, 1, 0);

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.mode = 'chase';
    this.az = 0; this.el = 0;              // smoothed flight direction (chase)
    this.yawOff = 0; this.pitchOff = 0;    // user orbit offsets
    this.zoom = 1;
    this.headYaw = 0; this.headPitch = 0;  // cockpit look
    this.cockpitFov = 72;
    this.orbitAz = 0.6; this.orbitEl = 0.25;
    this.flyPos = new THREE.Vector3(); this.flyValid = false;
    this.shake = 0;                        // transient shake energy (touchdown, crash)
    this.gOffset = 0;
    this.time = 0;
    this._f = new THREE.Vector3(); this._t = new THREE.Vector3(); this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion(); this._q2 = new THREE.Quaternion(); this._e = new THREE.Euler();
    this._w = { x: 0, z: 0 };
    this.first = true;
  }

  setMode(mode) {
    if (!CAMERA_MODES.includes(mode)) return;
    this.mode = mode;
    this.first = true;
    this.flyValid = false;
    this.yawOff = 0; this.pitchOff = 0;
    this.headYaw = 0; this.headPitch = 0;
  }
  cycle() { this.setMode(CAMERA_MODES[(CAMERA_MODES.indexOf(this.mode) + 1) % CAMERA_MODES.length]); }
  recenter() { this.yawOff = 0; this.pitchOff = 0; this.headYaw = 0; this.headPitch = 0; this.zoom = 1; }
  bump(v) { this.shake = Math.min(1.5, this.shake + v); }

  /**
   * @param s {pos: Vector3, quat: Quaternion, ac: Aircraft, def, eye: Vector3 (body), groundHeight(x,z)}
   */
  update(dt, s, look) {
    const cam = this.camera, ac = s.ac, def = s.def;
    this.time += dt;
    const pos = s.pos;
    const f = this._f.set(1, 0, 0).applyQuaternion(s.quat);
    const speed = ac.vel.length();
    // blend body direction and flight path so that the camera shows where the aircraft is going
    if (speed > 12) { f.multiplyScalar(0.5); f.x += 0.5 * ac.vel.x / speed; f.y += 0.5 * ac.vel.y / speed; f.z += 0.5 * ac.vel.z / speed; f.normalize(); }
    const azT = Math.atan2(f.z, f.x), elT = Math.asin(THREE.MathUtils.clamp(f.y, -1, 1));
    if (this.first) { this.az = azT; this.el = elT; }
    let da = azT - this.az;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    // near the vertical the azimuth is meaningless: slow the follow down
    const horiz = Math.cos(elT);
    this.az += da * Math.min(1, dt * 3.2 * horiz * horiz);
    this.el += (elT - this.el) * Math.min(1, dt * 2.6);

    const sens = 0.0042;
    this.shake = Math.max(0, this.shake - dt * 1.8);
    const rumble = ac.onGround ? Math.min(1, speed / 60) * (ac.gear.wheels[0]?.surface === 0 ? 0.25 : 1) : 0;
    const vib = this.shake + ac.buffet * 0.6 + rumble * 0.25;
    let fov = 60;
    const t = this.time;
    const n1 = Math.sin(t * 47.1) * Math.sin(t * 31.7 + 1.3), n2 = Math.sin(t * 53.9 + 2.1) * Math.sin(t * 27.3), n3 = Math.sin(t * 39.7 + 0.7) * Math.sin(t * 61.1);

    if (this.mode === 'cockpit') {
      this.headYaw = THREE.MathUtils.clamp(this.headYaw + look.dx * sens, -2.6, 2.6);
      this.headPitch = THREE.MathUtils.clamp(this.headPitch - look.dy * sens, -1.1, 1.3);
      this.cockpitFov = THREE.MathUtils.clamp(this.cockpitFov + look.wheel * 4, 30, 100);
      // the pilot's head sinks under g and is tossed around by buffet
      this.gOffset += ((ac.nz - 1) * -0.012 - this.gOffset) * Math.min(1, dt * 6);
      const eye = this._p.copy(s.eye);
      eye.y += THREE.MathUtils.clamp(this.gOffset, -0.06, 0.04) + n1 * vib * 0.012;
      eye.z += n2 * vib * 0.01; eye.x += n3 * vib * 0.006;
      eye.applyQuaternion(s.quat).add(pos);
      cam.position.copy(eye);
      this._q.setFromEuler(this._e.set(this.headPitch + n1 * vib * 0.004, -this.headYaw + n2 * vib * 0.004, n3 * vib * 0.004, 'YXZ'));
      cam.quaternion.copy(s.quat).multiply(BODY_TO_CAM).multiply(this._q);
      fov = this.cockpitFov;
    } else if (this.mode === 'chase' || this.mode === 'orbit') {
      this.zoom = THREE.MathUtils.clamp(this.zoom * (1 + look.wheel * 0.1), 0.35, 6);
      let azC, phi;
      if (this.mode === 'chase') {
        this.yawOff += look.dx * sens; this.pitchOff = THREE.MathUtils.clamp(this.pitchOff + look.dy * sens, -1.2, 1.3);
        azC = this.az + this.yawOff;
        phi = 11 * DEG + this.pitchOff - this.el * 0.55;
      } else {
        this.orbitAz += look.dx * sens; this.orbitEl = THREE.MathUtils.clamp(this.orbitEl + look.dy * sens, -1.4, 1.45);
        azC = this.orbitAz; phi = this.orbitEl;
      }
      phi = THREE.MathUtils.clamp(phi, -1.45, 1.5);
      const D = def.view.chase * this.zoom;
      const cp = Math.cos(phi), sp = Math.sin(phi);
      cam.position.set(pos.x - Math.cos(azC) * D * cp, pos.y + D * sp, pos.z - Math.sin(azC) * D * cp);
      const gh = s.groundHeight(cam.position.x, cam.position.z) + 1.0;
      if (cam.position.y < gh) cam.position.y = gh;
      const lead = this.mode === 'chase' ? D * 0.18 : 0;
      this._t.set(pos.x + Math.cos(this.az) * Math.cos(this.el) * lead, pos.y + Math.sin(this.el) * lead + def.view.height * 0.18, pos.z + Math.sin(this.az) * Math.cos(this.el) * lead);
      cam.up.copy(UP);
      cam.lookAt(this._t);
      cam.position.x += n1 * vib * 0.05; cam.position.y += n2 * vib * 0.05;
    } else {
      // fixed observers: fly-by spot or control tower
      if (this.mode === 'flyby') {
        const dist = this.flyValid ? this.flyPos.distanceTo(pos) : Infinity;
        if (dist > Math.max(500, speed * 7) || !this.flyValid) {
          const v = speed > 5 ? this._t.copy(ac.vel).multiplyScalar(1 / speed) : this._t.set(1, 0, 0).applyQuaternion(s.quat);
          const ahead = Math.max(60, speed * 3.5);
          const sideSign = Math.sin(this.time * 12.9898) > 0 ? 1 : -1;
          const side = (25 + def.ref.b * 1.5) * sideSign;
          this.flyPos.set(pos.x + v.x * ahead - v.z * side, pos.y + v.y * ahead - 4 - def.ref.b * 0.3, pos.z + v.z * ahead + v.x * side);
          const gh = s.groundHeight(this.flyPos.x, this.flyPos.z) + 1.7;
          if (this.flyPos.y < gh || ac.agl < 60) this.flyPos.y = gh;
          this.flyValid = true;
        }
        cam.position.copy(this.flyPos);
      } else {
        const na = nearestAirport(pos.x, pos.z).airport;
        const tp = na.towerPos || { u: 0, v: 80, h: 12 };
        airportWorld(na, tp.u, tp.v, this._w);
        cam.position.set(this._w.x, na.elevation + tp.h + 2.2, this._w.z);
      }
      cam.up.copy(UP);
      cam.lookAt(pos);
      const d = cam.position.distanceTo(pos);
      this.zoom = THREE.MathUtils.clamp(this.zoom * (1 + look.wheel * 0.1), 0.3, 5);
      fov = THREE.MathUtils.clamp(2 * Math.atan((def.ref.b * 2.2 * this.zoom) / Math.max(d, 1)) / DEG, 1.2, 60);
      cam.rotateX(n1 * vib * 0.002);
    }
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov += (fov - cam.fov) * (this.first ? 1 : Math.min(1, dt * 8)); cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
    this.first = false;
  }
}
