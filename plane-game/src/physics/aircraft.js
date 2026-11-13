// Six-degree-of-freedom rigid-body flight model.
//
// State: position & velocity (world frame), attitude quaternion (body -> world), angular
// velocity (body frame). Forces: gravity, aerodynamic strips, fuselage/gear drag bodies,
// compressibility (wave) drag, engines + propeller effects (torque, P-factor, slipstream,
// gyroscopic precession), landing gear and airframe ground contact.

import { Vec3, Quat, DEG, G0, clamp, smoothstep, eulerFromQuat, interp1, approach } from '../core/math.js';
import { atmosphere, casFromTas, RHO0 } from './atmosphere.js';
import { buildLiftingSurface, stripForce } from './aero.js';
import { createEngine } from './engines.js';
import { Undercarriage, SURFACE } from './gear.js';
import { FlightControlSystem, Autopilot } from './fcs.js';

export const PHYSICS_DT = 1 / 300;

const _v = new Vec3(), _vs = new Vec3(), _F = new Vec3(), _r = new Vec3(), _t = new Vec3();
const _wind = new Vec3(), _Fw = new Vec3();
const _g = { h: 0, nx: 0, ny: 1, nz: 0, type: 0, mu: 0.8, rr: 0.02 };
const _fx = { lift: 1, clMax: 1, cd0: 1, kInd: 1, ground: 1, acShift: 0 };

function liftSlopeMach(AR, tanHalf, M) {
  const sub = (m) => (2 * Math.PI * AR) / (2 + Math.sqrt(4 + AR * AR * (1 - m * m + tanHalf * tanHalf)));
  if (M <= 0.9) return sub(M);
  const a09 = sub(0.9);
  const sup = (m) => { const B = Math.sqrt(m * m - 1); return Math.min(a09 * 1.05, (4 / B) * Math.max(0.5, 1 - 1 / (2 * AR * B))); };
  if (M >= 1.25) return sup(M);
  return a09 + (sup(1.25) - a09) * (M - 0.9) / 0.35;
}

export class Aircraft {
  constructor(def, env) {
    this.def = def;
    this.env = env;
    const cg = def.cg;

    // --- aerodynamic surfaces
    this.surfaces = [];
    let wing = null, tailX = cg[0] - 4;
    for (const sd of def.surfaces) {
      const built = buildLiftingSurface(sd);
      for (const s of built.surfaces) {
        s.r.set(s.pos.x - cg[0], s.pos.y - cg[1], s.pos.z - cg[2]);
        this.surfaces.push(s);
      }
      if (sd.kind === 'wing' && !wing) { wing = built; wing.def = sd; }
      if (sd.kind === 'htail') tailX = built.surfaces[0].pos.x;
    }
    this.wingStrips = this.surfaces.filter((s) => s.group === 'wing');
    const wd = wing.def;
    this.machAR = wing.AR;
    this.machTanHalf = Math.tan((wd.sweepLE || 0) * DEG) - (wd.rootChord - wd.tipChord) * 0.5 / wd.semiSpan;
    this.wingHeight = wd.rootLE[1] - cg[1];
    const m0 = def.mass.empty + def.mass.fuelMax * 0.5;
    const clMaxFlap = wd.airfoil.clMax + (wd.flapData ? wd.flapData.dClMax * 0.6 : 0);
    def.ref = {
      S: wing.area, b: wing.span, mac: wing.mac, AR: wing.AR, a: wing.a,
      tailArm: Math.max(1, cg[0] - tailX),
      vs: Math.sqrt(2 * m0 * G0 / (RHO0 * wing.area * wd.airfoil.clMax * 0.95)),
      vs0: Math.sqrt(2 * m0 * G0 / (RHO0 * wing.area * clMaxFlap * 0.95)),
    };
    // roll moment coefficient per radian of aileron (from the strip geometry)
    let cl = 0;
    for (const st of this.surfaces) if (st.ctrlAxis === 'aileron') cl += st.a * st.ctrlTau * st.area * Math.abs(st.r.z);
    def.ref.clDa = Math.max(0.03, cl / (wing.area * wing.span));
    this.downwashK = (def.downwashFactor ?? 1) * 2 / (Math.PI * wing.AR);

    this.bodies = (def.bodies || []).map((b) => ({
      r: new Vec3(b.pos[0] - cg[0], b.pos[1] - cg[1], b.pos[2] - cg[2]),
      cdA: b.cdA, gear: !!b.gear, spoiler: !!b.spoiler, flap: !!b.flap,
    }));

    // --- systems
    this.engines = def.engines.map((e) => {
      const eng = createEngine(e);
      eng.r = new Vec3(e.pos[0] - cg[0], e.pos[1] - cg[1], e.pos[2] - cg[2]);
      return eng;
    });
    this.gear = new Undercarriage(def, cg);
    this.fcs = new FlightControlSystem(this);
    this.ap = new Autopilot(this);

    // --- state
    this.pos = new Vec3(0, 1000, 0);
    this.vel = new Vec3();
    this.q = new Quat();
    this.omega = new Vec3();       // body rates: x roll (right +), y yaw (left +), z pitch (up +)
    this.fuel = def.mass.fuelMax * 0.6;
    this.mass = def.mass.empty + this.fuel;

    // pilot inputs
    this.ctrl = {
      pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, parkingBrake: false,
      flapIndex: 0, gearDown: true, spoiler: 0, trim: 0, reverse: false,
    };
    this.assist = { autoRudder: true, autoTrim: true, bankHold: true };
    this.realism = { structural: true };
    // commanded and actual surface positions (rad; flap/spoiler/gear 0..1)
    this.cmd = { elevator: 0, aileron: 0, rudder: 0, steer: 0 };
    this.surf = { elevator: 0, aileron: 0, rudder: 0, flap: 0, spoiler: 0, gear: 1 };

    // derived quantities (updated every step)
    this.atm = { T: 288, p: 101325, rho: 1.225, a: 340, sigma: 1 };
    this.vB = new Vec3();          // velocity relative to the air mass, body frame
    this.wind = new Vec3();
    this.tas = 0; this.ias = 0; this.cas = 0; this.mach = 0; this.qbar = 0;
    this.alpha = 0; this.beta = 0;
    this.euler = { heading: 0, pitch: 0, roll: 0 };
    this.nz = 1; this.ny = 0; this.nx = 0;
    this.accB = new Vec3();        // specific force in body axes (what the pilot feels), m/s^2
    this.agl = 1000; this.groundH = 0; this.groundType = 0;
    this.eps = 0; this.clWing = 0;
    this.stalled = 0; this.stallWarning = false; this.buffet = 0;
    this.slipstream = 0;
    this.iasRate = 0; this._iasPrev = 0;
    this.thrust = 0;
    this.time = 0;
    this.airTime = 0;              // seconds since last ground contact
    this.wheelAirTime = 0;         // seconds since a wheel last carried load
    this.groundTime = 0;
    this.crashed = null;
    this.damage = { gear: false, prop: false, airframe: false };
    this.overG = 0; this.overSpeed = 0;
    this.events = [];
    this.maxG = 1; this.minG = 1;
    this.lastTouchdown = null;
    this._Fb = new Vec3(); this._Mb = new Vec3();
  }

  // ------------------------------------------------------------------ helpers
  get onGround() { return this.gear.onGround; }
  get fuelFraction() { return this.fuel / this.def.mass.fuelMax; }
  get flapSetting() { return this.def.flaps ? this.def.flaps.settings[this.ctrl.flapIndex] : 0; }
  get throttleCmd() { return this.ap.autothrottle ? this.ap.throttle : this.ctrl.throttle; }

  brakeCmd(w) {
    const c = this.ctrl;
    if (c.parkingBrake) return 1;
    let b = c.brake;
    if (b > 0 && w.side !== 0) {
      // differential braking with rudder pedals
      const y = this.cmd.steer;
      b *= w.side < 0 ? 1 - Math.max(0, y) * 0.8 : 1 - Math.max(0, -y) * 0.8;
    }
    return b;
  }

  onTouchdown(w, sink, surfaceType) {
    if (this.wheelAirTime > 0.6 && this.gear.wheelsOnGround === 0) {
      const info = {
        type: 'touchdown', sink, speed: this.vel.length(), ias: this.ias,
        pitch: this.euler.pitch, roll: this.euler.roll, surface: surfaceType,
        nz: this.nz, x: this.pos.x, z: this.pos.z, heading: this.euler.heading, time: this.time,
        drift: this.beta,
      };
      this.lastTouchdown = info;
      this.events.push(info);
    }
    if (this.vel.length() > 8) this.events.push({ type: 'chirp', sink, wheel: w.name });
  }
  onPropStrike() {
    if (!this.damage.prop) {
      this.damage.prop = true;
      for (const e of this.engines) if (e.type === 'piston') e.stop();
      this.events.push({ type: 'propstrike' });
    }
  }
  onScrape(type) {
    this.damage.airframe = true;
    this.events.push({ type: 'scrape', part: type });
  }

  /** Place the aircraft. opts: {x, z, heading, altitude?, speed?, onGround, gamma?} */
  reset(opts) {
    const def = this.def;
    this.crashed = null;
    this.damage = { gear: false, prop: false, airframe: false };
    this.events.length = 0;
    this.gear.reset();
    this.fcs.reset();
    this.ap.disengage();
    this.omega.set(0, 0, 0);
    this.time = 0; this.airTime = 0; this.groundTime = 0; this.wheelAirTime = 0;
    this.overG = 0; this.overSpeed = 0; this.maxG = 1; this.minG = 1;
    this.eps = 0; this.lastTouchdown = null;
    for (const s of this.surfaces) { s.x = 1; s.xTarget = 1; }
    this.fuel = def.mass.fuelMax * (opts.fuel ?? 0.6);
    this.mass = def.mass.empty + this.fuel;
    const c = this.ctrl;
    c.pitch = c.roll = c.yaw = 0; c.brake = 0; c.spoiler = 0; c.trim = def.controls.trimTakeoff ?? 0;
    c.reverse = false;
    this.surf.elevator = this.surf.aileron = this.surf.rudder = 0; this.surf.spoiler = 0;
    const heading = opts.heading ?? 0;
    if (opts.onGround) {
      // attitude at rest on the wheels
      let front = this.gear.wheels[0], rear = this.gear.wheels[0];
      for (const w of this.gear.wheels) { if (w.r0.x > front.r0.x) front = w; if (w.r0.x < rear.r0.x) rear = w; }
      const stat = (w) => w.r0.y + Math.min(w.travel * 0.6, (this.mass * G0 * 0.4) / w.k);
      const pitch = front === rear ? 0 : -Math.atan2(stat(front) - stat(rear), front.r0.x - rear.r0.x);
      this.q.setFromEuler(heading, pitch, 0);
      this.env.ground(opts.x, opts.z, _g);
      let low = 0;
      for (const w of this.gear.wheels) {
        _v.copy(w.r0).applyQuat(this.q);
        low = Math.min(low, _v.y + (this.mass * G0 / this.gear.wheels.length) / w.k * 0.9);
      }
      this.pos.set(opts.x, _g.h - low, opts.z);
      this.vel.set(0, 0, 0);
      c.throttle = 0; c.parkingBrake = opts.parkingBrake ?? true; c.gearDown = true;
      c.flapIndex = def.flaps && !def.flaps.auto ? (opts.flapIndex ?? 0) : 0;
      this.surf.gear = 1; this.surf.flap = def.flaps ? def.flaps.settings[c.flapIndex] / def.flaps.max : 0;
      for (const e of this.engines) {
        if (e.type === 'piston') { e.omega = e.omegaIdle; e.running = true; e.throttle = 0; e.pitch = e.pitchMin; }
        else { e.n1 = e.idleN1; e.running = true; e.ab = 0; e.reverse = 0; }
      }
    } else {
      const V = opts.speed ?? def.ref.vs * 1.6;
      const gamma = (opts.gamma ?? 0) * DEG;
      atmosphere(opts.altitude, this.atm);
      const tas = V / Math.sqrt(this.atm.sigma);
      const fi = opts.flapIndex ?? 0;
      const clNeed = this.mass * G0 / (0.5 * RHO0 * V * V * def.ref.S);
      const alpha = clamp(clNeed / def.ref.a - (fi > 0 ? 0.08 : 0.02), -0.05, 0.2);
      this.q.setFromEuler(heading, gamma + alpha, 0);
      this.pos.set(opts.x, opts.altitude, opts.z);
      this.vel.set(Math.cos(heading) * Math.cos(gamma) * tas, Math.sin(gamma) * tas, Math.sin(heading) * Math.cos(gamma) * tas);
      c.throttle = opts.throttle ?? 0.6; c.parkingBrake = false;
      c.gearDown = opts.gearDown ?? !def.retractable; c.flapIndex = fi;
      this.surf.gear = c.gearDown ? 1 : 0;
      this.surf.flap = def.flaps ? def.flaps.settings[fi] / def.flaps.max : 0;
      for (const e of this.engines) {
        if (e.type === 'piston') { e.omega = e.omegaRated * 0.85; e.running = true; e.throttle = c.throttle; }
        else { e.n1 = e.idleN1 + (1 - e.idleN1) * 0.7; e.running = true; }
      }
      this.airTime = 10; this.wheelAirTime = 10;
    }
    eulerFromQuat(this.q, this.euler);
    this.updateAirData(0);
    return this;
  }

  updateAirData(dt) {
    atmosphere(this.pos.y, this.atm);
    _v.copy(this.vel).sub(this.wind).applyQuatInv(this.q);
    this.vB.copy(_v);
    const V = _v.length();
    this.tas = V;
    this.alpha = V > 0.5 ? Math.atan2(-_v.y, _v.x) : 0;
    this.beta = V > 0.5 ? Math.asin(clamp(_v.z / V, -1, 1)) : 0;
    this.qbar = 0.5 * this.atm.rho * V * V;
    this.mach = V / this.atm.a;
    this.ias = V * Math.sqrt(this.atm.sigma);
    this.cas = casFromTas(V, this.atm.p, this.atm.a);
    if (dt > 0) {
      const rate = (this.ias - this._iasPrev) / dt;
      this.iasRate += (rate - this.iasRate) * Math.min(1, dt * 2);
    }
    this._iasPrev = this.ias;
    eulerFromQuat(this.q, this.euler);
  }

  // ------------------------------------------------------------------ main step
  step(dt) {
    if (this.crashed) return;
    const def = this.def, c = this.ctrl, surf = this.surf, cmd = this.cmd;
    this.time += dt;

    // --- environment
    this.env.ground(this.pos.x, this.pos.z, _g);
    this.groundH = _g.h; this.groundType = _g.type;
    this.agl = this.pos.y - _g.h;
    if (this.env.wind) this.env.wind.step(dt, this.agl, this.pos.y, this.tas, this.wind);
    else this.wind.set(0, 0, 0);
    this.updateAirData(dt);
    const atm = this.atm, rho = atm.rho, vB = this.vB, V = this.tas, om = this.omega;

    // --- flight controls, actuators and systems
    let pitch = c.pitch, roll = c.roll;
    this.ap.update(dt);
    if (this.ap.engaged) { pitch = this.ap.pitch; roll = this.ap.roll; }
    this.fcs.update(dt, pitch, roll, c.yaw);
    const rate = (def.controls.rate ?? 90) * DEG * dt;
    surf.elevator = approach(surf.elevator, cmd.elevator, rate);
    surf.aileron = approach(surf.aileron, cmd.aileron, rate * 1.2);
    surf.rudder = approach(surf.rudder, cmd.rudder, rate);
    if (def.flaps) {
      if (def.flaps.auto === 'gear') c.flapIndex = c.gearDown && this.cas < 125 ? 1 : 0;
      const target = def.flaps.settings[c.flapIndex] / def.flaps.max;
      surf.flap = approach(surf.flap, target, dt / def.flaps.time);
    }
    if (def.retractable) {
      const want = c.gearDown || this.gear.onGround ? 1 : 0;
      if (this.gear.onGround) c.gearDown = true;
      surf.gear = approach(surf.gear, want, dt / def.retractable.time);
    }
    let spoilerCmd = c.spoiler;
    if (def.autoSpoilers && this.gear.onGround && this.throttleCmd < 0.15 && this.tas > 25 && this.groundTime > 0.3) spoilerCmd = 1;
    surf.spoiler = approach(surf.spoiler, spoilerCmd, dt * 2.5);
    const gs = Math.hypot(this.vel.x, this.vel.z);
    for (const w of this.gear.wheels) {
      if (w.steerMax) {
        const v0 = def.steerFadeSpeed ?? 14;
        // a steerable tailwheel swings the tail the other way to turn the nose the same way
        const sign = w.r0.x < 0 ? -1 : 1;
        w.steer = approach(w.steer, sign * cmd.steer * w.steerMax * DEG / (1 + (gs / v0) * (gs / v0)), 1.5 * dt);
      }
    }

    const Fb = this._Fb.set(0, 0, 0), Mb = this._Mb.set(0, 0, 0);
    let hx = 0;

    // --- engines
    const thr = this.throttleCmd;
    const hasFuel = this.fuel > 0;
    let slip = 0, swirl = 0, thrust = 0;
    for (const e of this.engines) {
      const burned = e.update(dt, thr, atm, vB.x, hasFuel, c.reverse);
      this.fuel = Math.max(0, this.fuel - burned);
      const T = e.thrust;
      thrust += T;
      let ry = e.r.y, rz = e.r.z;
      if (e.type === 'piston') {
        // P-factor: the thrust centre moves toward the down-going blade at an angle to the flow
        const R = e.D / 2;
        rz += e.dir * 0.3 * R * clamp(this.alpha, -0.45, 0.45);
        ry -= e.dir * 0.3 * R * clamp(this.beta, -0.45, 0.45);
        Mb.x -= e.dir * e.shaftTorque;           // torque reaction on the airframe
        hx += e.angularMomentum;
        slip = Math.max(-0.5 * Math.max(vB.x, 0), 1.8 * e.vInduced);
        swirl = e.vSwirl * e.dir;
      }
      Fb.x += T;
      Mb.y += rz * T;
      Mb.z -= ry * T;
    }
    this.thrust = thrust;
    this.slipstream = slip;
    this.mass = def.mass.empty + this.fuel;
    const mass = this.mass;

    // --- compressibility and ground effect factors
    const M = this.mach;
    _fx.lift = liftSlopeMach(this.machAR, this.machTanHalf, M) / liftSlopeMach(this.machAR, this.machTanHalf, 0);
    _fx.clMax = 1 - 0.28 * smoothstep(0.4, 0.95, M);
    _fx.kInd = 1 + 1.6 * smoothstep(0.95, 1.5, M);
    _fx.acShift = smoothstep(0.9, 1.3, M);
    const hw = Math.max(0.4, this.agl + this.wingHeight) / def.ref.b;
    const ge = (16 * hw) * (16 * hw);
    _fx.ground = hw < 1.2 ? ge / (1 + ge) : 1;

    // --- lifting surfaces
    const rollGust = this.env.wind ? this.env.wind.rollGust : 0;
    const wx = om.x - rollGust, wy = om.y, wz = om.z;
    const fwd = Math.max(vB.x, 0);
    let liftSum = 0, sepSum = 0, areaSum = 0, warn = false;
    for (const s of this.surfaces) {
      const r = s.r;
      let vx = vB.x + wy * r.z - wz * r.y;
      let vy = vB.y + wz * r.x - wx * r.z;
      let vz = vB.z + wx * r.y - wy * r.x;
      if (s.propwash > 0) vx += s.propwash * slip;
      if (s.swirl !== 0) vz -= s.swirl * swirl;
      if (s.downwash > 0) vy += s.downwash * this.eps * fwd;
      const cA = s.cAxis, nA = s.nAxis, sA = s.sAxis;
      const vc = vx * cA.x + vy * cA.y + vz * cA.z;
      const vn = vx * nA.x + vy * nA.y + vz * nA.z;
      const vsp = vx * sA.x + vy * sA.y + vz * sA.z;
      const defl = s.ctrlAxis ? surf[s.ctrlAxis] * s.ctrlSign : 0;
      const f = stripForce(s, vc, vn, vsp, rho, defl, surf.flap, surf.spoiler, _fx, false);
      // separation dynamics: the flow needs a few chord lengths of travel to detach / re-attach
      const tau = (s.xTarget < s.x ? 3 : 6) * s.chord / Math.max(Math.abs(vc), 8);
      s.x += (s.xTarget - s.x) * Math.min(1, dt / tau);
      const fxb = cA.x * f.fc + nA.x * f.fn, fyb = cA.y * f.fc + nA.y * f.fn, fzb = cA.z * f.fc + nA.z * f.fn;
      const rx = r.x - cA.x * f.xcp, ry = r.y - cA.y * f.xcp, rz = r.z - cA.z * f.xcp;
      Fb.x += fxb; Fb.y += fyb; Fb.z += fzb;
      Mb.x += ry * fzb - rz * fyb + s.mAxis.x * f.cm;
      Mb.y += rz * fxb - rx * fzb + s.mAxis.y * f.cm;
      Mb.z += rx * fyb - ry * fxb + s.mAxis.z * f.cm;
      if (s.group === 'wing') {
        liftSum += s.lift; sepSum += (1 - s.x) * s.area; areaSum += s.area;
        if (s.xTarget < 0.9) warn = true;
      }
    }
    const qS = this.qbar * def.ref.S;
    this.clWing = qS > 50 ? liftSum / qS : 0;
    // downwash at the tail follows the wing lift with a transport delay
    const epsNow = this.downwashK * this.clWing * _fx.ground;
    this.eps += (epsNow - this.eps) * Math.min(1, dt * Math.max(V, 5) / def.ref.tailArm);
    this.stalled = sepSum / areaSum;
    const airborne = !this.gear.onGround;
    this.stallWarning = warn && airborne && V > 5;
    this.buffet = airborne ? clamp(this.stalled * 1.5, 0, 1) * clamp(this.qbar / 600, 0, 1) : 0;

    // --- fuselage, gear, speed brakes: bluff-body drag in all three axes
    for (const b of this.bodies) {
      let k = 1;
      if (b.gear) k = surf.gear; else if (b.spoiler) k = surf.spoiler; else if (b.flap) k = surf.flap;
      if (k <= 0) continue;
      const r = b.r;
      const vx = vB.x + wy * r.z - wz * r.y;
      const vy = vB.y + wz * r.x - wx * r.z;
      const vz = vB.z + wx * r.y - wy * r.x;
      const h = -0.5 * rho * Math.sqrt(vx * vx + vy * vy + vz * vz) * k;
      const fxb = h * b.cdA[0] * vx, fyb = h * b.cdA[1] * vy, fzb = h * b.cdA[2] * vz;
      Fb.x += fxb; Fb.y += fyb; Fb.z += fzb;
      Mb.x += r.y * fzb - r.z * fyb;
      Mb.y += r.z * fxb - r.x * fzb;
      Mb.z += r.x * fyb - r.y * fxb;
    }

    // --- wave drag
    if (def.wave && M > def.wave[0][0] && V > 1) {
      const D = qS * interp1(def.wave, M);
      Fb.x -= D * vB.x / V; Fb.y -= D * vB.y / V; Fb.z -= D * vB.z / V;
    }

    // --- to world frame, ground reaction
    const Fw = _Fw.copy(Fb).applyQuat(this.q);
    let crash = null;
    if (this.agl < def.ref.b + 30) crash = this.gear.apply(this, dt, Fw, Mb);
    else if (this.gear.onGround) this.gear.reset();
    if (this.gear.onGround || this.gear.scrape > 0) { this.airTime = 0; this.groundTime += dt; }
    else { this.airTime += dt; this.groundTime = 0; }
    this.wheelAirTime = this.gear.onGround ? 0 : this.wheelAirTime + dt;

    // specific force (accelerometer): everything except gravity
    this.accB.copy(Fw).scale(1 / mass).applyQuatInv(this.q);
    this.nx = this.accB.x / G0; this.nz = this.accB.y / G0; this.ny = this.accB.z / G0;
    if (this.nz > this.maxG) this.maxG = this.nz;
    if (this.nz < this.minG) this.minG = this.nz;

    // --- integrate (semi-implicit Euler)
    Fw.y -= mass * G0;
    this.vel.addScaled(Fw, dt / mass);
    this.pos.addScaled(this.vel, dt);

    const k = mass / def.mass.refMass;
    const Ix = def.mass.inertia[0] * k, Iy = def.mass.inertia[1] * k, Iz = def.mass.inertia[2] * k;
    const Lx = Ix * om.x + hx, Ly = Iy * om.y, Lz = Iz * om.z;
    const ax = (Mb.x - (om.y * Lz - om.z * Ly)) / Ix;
    const ay = (Mb.y - (om.z * Lx - om.x * Lz)) / Iy;
    const az = (Mb.z - (om.x * Ly - om.y * Lx)) / Iz;
    om.x += ax * dt; om.y += ay * dt; om.z += az * dt;
    this.q.integrateBodyRate(om.x, om.y, om.z, dt);

    // --- structural limits
    if (this.realism.structural && !crash) {
      const lim = def.limits;
      const over = this.nz > lim.gPos * 1.5 || this.nz < lim.gNeg * 1.5;
      this.overG = over && airborne && this.airTime > 0.5 ? this.overG + dt : Math.max(0, this.overG - dt);
      if (this.overG > 0.25) crash = 'overstress';
      const fast = this.cas > lim.vne * 1.12 || (lim.mmo && M > lim.mmo + 0.12);
      this.overSpeed = fast ? this.overSpeed + dt : Math.max(0, this.overSpeed - dt);
      if (this.overSpeed > 4) crash = 'overspeed';
    }
    if (this.pos.y < -2 && !crash) crash = 'water';
    if (crash) this.crash(crash);
  }

  crash(reason) {
    if (this.crashed) return;
    if (reason === 'ditched') { this.vel.scale(0); }
    this.crashed = { reason, speed: this.vel.length(), time: this.time };
    for (const e of this.engines) e.stop();
    this.events.push({ type: 'crash', reason, speed: this.crashed.speed });
  }

  /**
   * Fly the aircraft to a steady trimmed condition (using the autopilot on a private copy of
   * the environment) and keep attitude, controls, trim and engine state. Used for air starts.
   */
  trimInAir(ias, gammaDeg = 0, seconds = 40) {
    const env = this.env;
    const x0 = this.pos.x, z0 = this.pos.z, y0 = this.pos.y, hdg = this.euler.heading;
    this.env = { ground: (x, z, o) => { o.h = -5000; o.nx = 0; o.ny = 1; o.nz = 0; o.type = 0; o.mu = 0.8; o.rr = 0.02; return o; }, wind: null };
    const structural = this.realism.structural;
    this.realism.structural = false;
    const ap = this.ap;
    ap.engaged = true; ap.autothrottle = true;
    ap.altitude = y0; ap.heading = hdg; ap.speed = ias; ap.thrInt = this.ctrl.throttle;
    const vsLimit = ap.vsLimit;
    const dt = PHYSICS_DT, n = Math.round(seconds / dt);
    const tasTarget = ias / Math.sqrt(this.atm.sigma);
    const vsTarget = Math.sin(gammaDeg * DEG) * tasTarget;
    for (let i = 0; i < n; i++) {
      // follow a moving altitude target to trim on a climb / descent path
      ap.altitude = this.pos.y + vsTarget / ap.altGain;
      ap.vsLimit = Math.max(vsLimit, Math.abs(vsTarget) + 1);
      this.step(dt);
      if (this.crashed) break;
    }
    ap.vsLimit = vsLimit;
    // hand the elevator position over to the trim so that the stick is centred
    const c = this.def.controls;
    if (!this.fcs.fbw) {
      const kP = Math.min(1, c.qRefPitch / Math.max(this.qbar, 20));
      const e = ap.pitch >= 0 ? ap.pitch * c.elevUp : ap.pitch * c.elevDown;
      this.ctrl.trim = clamp(this.ctrl.trim + e * kP / c.trimRange, -1, 1);
    }
    this.ctrl.throttle = ap.throttle;
    ap.disengage();
    this.env = env;
    this.realism.structural = structural;
    this.crashed = null; this.events.length = 0;
    // restore the position, keep the trimmed attitude and speed
    const speed = this.vel.length();
    const gamma = Math.asin(clamp(this.vel.y / Math.max(speed, 1), -1, 1));
    const alphaPitch = this.euler.pitch;
    this.q.setFromEuler(hdg, alphaPitch, 0);
    this.vel.set(Math.cos(hdg) * Math.cos(gamma) * speed, Math.sin(gamma) * speed, Math.sin(hdg) * Math.cos(gamma) * speed);
    this.pos.set(x0, y0, z0);
    this.omega.set(0, 0, 0);
    this.time = 0; this.airTime = 10; this.wheelAirTime = 10; this.maxG = 1; this.minG = 1;
    this.updateAirData(0);
  }
}

export { SURFACE };
