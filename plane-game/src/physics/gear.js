// Landing gear and airframe ground contact.
//
// Each wheel is an oleo strut (spring + asymmetric damper + bump stop) with a tyre modelled by
// a "brush" deflection state in the longitudinal and lateral directions. The brush gives a true
// static friction (the aircraft can sit still on a slope or in a crosswind), a slip-angle
// dependent cornering force with relaxation length at speed, and saturates on a friction circle.

import { Vec3, clamp, G0 } from '../core/math.js';

export const SURFACE = { RUNWAY: 0, GRASS: 1, ROUGH: 2, WATER: 3 };

const K_BRUSH = 60;          // tyre stiffness per unit load (1/m)
const RELAX = 0.12;          // tyre relaxation length (m)

const _p = new Vec3(), _rw = new Vec3(), _up = new Vec3(), _vc = new Vec3(), _ow = new Vec3();
const _n = new Vec3(), _fw = new Vec3(), _sd = new Vec3(), _F = new Vec3(), _t = new Vec3();
const _g = { h: 0, nx: 0, ny: 1, nz: 0, type: 0, mu: 0.8, rr: 0.02 };

export class Wheel {
  constructor(def, cg) {
    this.def = def;
    this.name = def.name;
    this.r0 = new Vec3(def.pos[0] - cg[0], def.pos[1] - cg[1], def.pos[2] - cg[2]);
    this.travel = def.travel;
    this.k = def.k; this.c = def.c;
    this.radius = def.radius;
    this.steerMax = def.steer || 0;
    this.braked = !!def.brake;
    this.side = Math.sign(def.pos[2]);
    this.compression = 0; this.load = 0; this.contact = false;
    this.steer = 0; this.dLong = 0; this.dLat = 0;
    this.spin = 0; this.angle = 0; this.slip = 0; this.surface = 0;
  }
  reset() {
    this.compression = 0; this.load = 0; this.contact = false;
    this.dLong = 0; this.dLat = 0; this.spin = 0; this.slip = 0;
  }
}

export class Undercarriage {
  constructor(def, cg) {
    this.wheels = def.gear.map((g) => new Wheel(g, cg));
    this.points = (def.contactPoints || []).map((p) => ({
      name: p.name, type: p.type || 'body',
      r: new Vec3(p.pos[0] - cg[0], p.pos[1] - cg[1], p.pos[2] - cg[2]), contact: false,
    }));
    this.onGround = false;       // any wheel carrying load
    this.wheelsOnGround = 0;
    this.totalLoad = 0;
    this.scrape = 0;             // airframe scraping the ground (for sound / sparks)
    this.maxSkid = 0;
  }

  reset() {
    for (const w of this.wheels) w.reset();
    for (const p of this.points) p.contact = false;
    this.onGround = false; this.wheelsOnGround = 0; this.scrape = 0;
  }

  /**
   * Accumulate ground forces. Fw: world force, Mb: body moment.
   * Returns a crash descriptor string or null.
   */
  apply(ac, dt, Fw, Mb) {
    const env = ac.env, q = ac.q;
    let crash = null;
    _ow.copy(ac.omega).applyQuat(q);
    _up.set(0, 1, 0).applyQuat(q);
    const gearDown = ac.surf.gear > 0.98;
    const speed = ac.vel.length();
    let nContact = 0, total = 0, maxSkid = 0;
    const lim = ac.def.limits;
    const mRef = ac.mass;

    for (const w of this.wheels) {
      const was = w.contact;
      w.contact = false;
      if (!gearDown) { w.load = 0; w.compression = 0; continue; }
      _rw.copy(w.r0).applyQuat(q);
      _p.copy(ac.pos).add(_rw);
      env.ground(_p.x, _p.z, _g);
      const depth = (_g.h - _p.y) * _g.ny;
      if (depth <= 0) {
        w.load = 0; w.compression = Math.max(0, w.compression - 2 * dt); w.dLong = 0; w.dLat = 0;
        w.spin *= 1 - 0.3 * dt; w.angle += w.spin * dt; w.slip = 0;
        continue;
      }
      if (_g.type === SURFACE.WATER) { crash = speed > 8 ? 'water' : 'ditched'; continue; }
      _n.set(_g.nx, _g.ny, _g.nz);
      const cosA = Math.max(0.35, _up.dot(_n));
      const comp = depth / cosA;
      // contact point (tyre footprint) and its velocity
      _rw.addScaled(_up, Math.min(comp, w.travel * 1.3));
      _vc.crossVectors(_ow, _rw).add(ac.vel);
      const vn = _vc.dot(_n);
      if (!was) {
        // touchdown: remember the sink rate for the landing report / gear overload
        ac.onTouchdown(w, -vn, _g.type);
        if (-vn > lim.gearCrashSink) crash = 'gear';
      }
      let N = w.k * comp + (vn < 0 ? w.c : w.c * 1.5) * -vn;
      if (comp > w.travel) {
        N += w.k * 10 * (comp - w.travel) + w.c * 3 * Math.max(0, -vn);
        if (comp > w.travel * 1.25 + 0.05 && -vn > 2.5) crash = 'gear';
      }
      if (N < 0) N = 0;
      const nMax = mRef * G0 * 9;
      if (N > nMax) N = nMax;
      w.contact = true; w.compression = Math.min(comp, w.travel * 1.1); w.load = N; w.surface = _g.type;
      nContact++; total += N;

      // wheel heading on the ground plane
      const st = w.steer;
      _fw.set(Math.cos(st), 0, Math.sin(st)).applyQuat(q);
      _fw.addScaled(_n, -_fw.dot(_n)).normalize();
      _sd.crossVectors(_fw, _n);
      const vl = _vc.dot(_fw), vs = _vc.dot(_sd);
      const kB = K_BRUSH * N + 1;
      const cB = 3.4 * N / (1 + Math.abs(vl) * 0.8);
      const mu = _g.mu;
      // longitudinal: rolling resistance + brakes
      const brake = w.braked ? ac.brakeCmd(w) : 0;
      const fMaxLong = N * (_g.rr + (lim.brakeMu ?? 0.55) * mu / 0.8 * brake);
      w.dLong += vl * dt;
      let fl = -kB * w.dLong - cB * vl;
      if (Math.abs(fl) > fMaxLong) { fl = Math.sign(fl) * fMaxLong; w.dLong = -fl / kB; }
      // lateral: brush with relaxation length
      w.dLat += (vs - Math.abs(vl) * w.dLat / RELAX) * dt;
      let fs = -kB * w.dLat - cB * vs;
      const fMaxLat = N * mu;
      if (Math.abs(fs) > fMaxLat) { fs = Math.sign(fs) * fMaxLat; w.dLat = -fs / kB; }
      // friction circle
      const ft = Math.hypot(fl, fs), fCap = N * mu;
      if (ft > fCap) { fl *= fCap / ft; fs *= fCap / ft; }
      w.slip = (Math.abs(vs) > 0.5 ? clamp(Math.abs(fs) / (fMaxLat + 1), 0, 1) * Math.min(1, Math.abs(vs) / 3) : 0)
             + (brake > 0.5 && Math.abs(vl) > 5 ? 0.15 : 0);
      if (w.slip > maxSkid) maxSkid = w.slip;
      // wheel rotation (visual): spins up on touchdown, locks with full brakes at low speed
      const target = vl / w.radius;
      w.spin += (target - w.spin) * Math.min(1, 12 * dt);
      w.angle += w.spin * dt;

      _F.set(0, 0, 0).addScaled(_n, N).addScaled(_fw, fl).addScaled(_sd, fs);
      Fw.add(_F);
      _t.crossVectors(_rw, _F).applyQuatInv(q);
      Mb.add(_t);
    }

    // airframe contact points (belly, wingtips, nose, tail, propeller)
    let scrape = 0;
    const kBody = mRef * G0 / 0.12, cBody = 2 * 0.5 * Math.sqrt(kBody * mRef);
    for (const pt of this.points) {
      _rw.copy(pt.r).applyQuat(q);
      _p.copy(ac.pos).add(_rw);
      // cheap reject: far above any terrain we have just sampled
      env.ground(_p.x, _p.z, _g);
      const depth = (_g.h - _p.y) * _g.ny;
      if (depth <= 0) { pt.contact = false; continue; }
      if (_g.type === SURFACE.WATER) { crash = speed > 8 ? 'water' : 'ditched'; continue; }
      _n.set(_g.nx, _g.ny, _g.nz);
      _vc.crossVectors(_ow, _rw).add(ac.vel);
      const vn = _vc.dot(_n);
      if (!pt.contact) {
        pt.contact = true;
        // a tail strike or a belly landing scrapes; noses, wings and roofs do not forgive
        const hard = pt.type === 'tail' ? lim.bodyCrashSink * 2.4 : pt.type === 'belly' ? lim.bodyCrashSink * 1.5 : lim.bodyCrashSink * 0.6;
        if (-vn > hard) crash = 'impact';
        else if ((pt.type === 'nose' || pt.type === 'wing') && speed > lim.scrapeCrashSpeed) crash = 'impact';
        else if (pt.type === 'prop') ac.onPropStrike();
        ac.onScrape(pt.type);
      }
      let N = kBody * depth - cBody * vn;
      if (N < 0) N = 0;
      if (N > mRef * G0 * 12) N = mRef * G0 * 12;
      _t.copy(_vc).addScaled(_n, -vn);
      const vt = _t.length();
      const fr = 0.45 * N * Math.min(1, vt / 0.4);
      _F.set(0, 0, 0).addScaled(_n, N);
      if (vt > 1e-4) _F.addScaled(_t, -fr / vt);
      Fw.add(_F);
      _t.crossVectors(_rw, _F).applyQuatInv(q);
      Mb.add(_t);
      scrape = Math.max(scrape, Math.min(1, vt / 30));
      total += N;
    }

    this.wheelsOnGround = nContact;
    this.onGround = nContact > 0;
    this.totalLoad = total;
    this.scrape = scrape;
    this.maxSkid = maxSkid;
    return crash;
  }
}
