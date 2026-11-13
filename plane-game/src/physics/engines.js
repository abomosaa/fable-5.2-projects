// Powerplants: piston engine + propeller (fixed pitch or constant speed) and turbofan / turbojet.

import { DEG, clamp, smoothstep } from '../core/math.js';
import { buildPropTable, propLookup } from './propeller.js';

const TWO_PI = 2 * Math.PI;
const _pl = { ct: 0, cp: 0 };

/** Torque curve of a normally aspirated piston engine vs. speed ratio x = rpm / rated rpm. */
function torqueShape(x) {
  if (x >= 1) return Math.max(0, 1 - 1.6 * (x - 1));
  const d = 1 - x;
  return 1 + 0.15 * d - 0.6 * d * d;
}

export class PistonEngine {
  constructor(def) {
    this.def = def;
    this.type = 'piston';
    this.pos = def.pos;
    this.dir = def.dir ?? 1;                    // +1: clockwise seen from the cockpit
    const p = def.prop;
    this.D = p.diameter;
    this.blades = p.blades;
    this.inertia = p.inertia;
    this.constantSpeed = !!p.constantSpeed;
    const pitchMin = (this.constantSpeed ? p.constantSpeed.min : p.pitch) * DEG;
    const pitchMax = (this.constantSpeed ? p.constantSpeed.max : p.pitch) * DEG;
    this.table = buildPropTable({
      blades: p.blades, cMax: p.cMax ?? 0.15,
      designPitch: (p.designPitch ?? (this.constantSpeed ? 24 : p.pitch)) * DEG,
      pitchMin, pitchMax,
    });
    this.pitch = pitchMin;
    this.pitchMin = pitchMin; this.pitchMax = pitchMax;
    this.omegaRated = def.ratedRpm * TWO_PI / 60;
    this.omegaIdle = def.idleRpm * TWO_PI / 60;
    this.qRated = def.power / this.omegaRated;  // brake torque at rated power
    this.bsfc = def.bsfc ?? 7.6e-8;             // kg per joule of shaft work
    // manifold fraction that holds idle rpm against friction + static propeller load
    const nI = this.omegaIdle / TWO_PI;
    propLookup(this.table, 0, pitchMin, _pl);
    const qPropIdle = _pl.cp * 1.225 * nI * nI * Math.pow(this.D, 5) / TWO_PI;
    const xI = this.omegaIdle / this.omegaRated;
    this.idleLoad = (this.friction(this.omegaIdle, true) + qPropIdle) / (1.11 * this.qRated * torqueShape(xI));
    // state
    this.omega = this.omegaIdle;
    this.running = true;
    this.starter = 0;
    this.throttle = 0;
    // outputs
    this.thrust = 0; this.shaftTorque = 0; this.propTorque = 0; this.power = 0;
    this.fuelFlow = 0; this.vInduced = 0; this.vSwirl = 0; this.rpm = def.idleRpm; this.J = 0;
    this.load = 0;
  }

  friction(omega, running) {
    const x = omega / this.omegaRated;
    return this.qRated * (running ? 0.035 + 0.075 * x : 0.07 + 0.11 * x);
  }

  start() { if (!this.running) this.starter = 2.2; }
  stop() { this.running = false; this.starter = 0; }

  /**
   * @param throttle 0..1, @param atm atmosphere sample, @param vAxial airspeed along the shaft,
   * @param hasFuel bool
   */
  update(dt, throttle, atm, vAxial, hasFuel) {
    const rho = atm.rho;
    this.throttle += clamp(throttle - this.throttle, -4 * dt, 4 * dt);
    if (!hasFuel) this.running = false;
    const n = this.omega / TWO_PI;
    const D = this.D;
    const V = Math.max(vAxial, 0);
    const J = n > 0.05 ? V / (n * D) : (V > 0.5 ? 1e3 : 0);
    this.J = J;
    let T, Qp;
    if (J > 3) {
      // (nearly) stopped propeller in an airstream: forces scale with V^2
      propLookup(this.table, 3, this.pitch, _pl);
      T = (_pl.ct / 9) * rho * V * V * D * D;
      Qp = (_pl.cp / 9) * rho * V * V * D * D * D / TWO_PI;
    } else {
      propLookup(this.table, J, this.pitch, _pl);
      T = _pl.ct * rho * n * n * D * D * D * D;
      Qp = _pl.cp * rho * n * n * Math.pow(D, 5) / TWO_PI;
    }
    // engine torque
    let Qe = 0;
    const x = this.omega / this.omegaRated;
    if (this.running) {
      // a closed throttle passes a fixed air mass flow: idle torque falls off as the engine
      // is driven faster by the windmilling propeller
      const idle = this.idleLoad * Math.min(1, this.omegaIdle / Math.max(this.omega, 1));
      const load = idle + (1 - idle) * this.throttle;
      const altFactor = Math.max(0, 1.132 * atm.sigma - 0.132);
      this.load = load * altFactor;
      Qe = 1.11 * this.qRated * torqueShape(x) * load * altFactor - this.friction(this.omega, true);
      if (this.omega < 0.08 * this.omegaRated) this.running = false; // engine stalls
    } else {
      this.load = 0;
      Qe = -this.friction(this.omega, false);
      if (this.starter > 0) {
        this.starter -= dt;
        Qe += this.qRated * 0.45 * Math.max(0, 1 - x / 0.22);
        if (this.starter <= 0.6 && hasFuel && x > 0.1) { this.running = true; this.starter = 0; }
      }
    }
    let omega = this.omega + (Qe - Qp) / this.inertia * dt;
    if (omega < 0) omega = 0;
    // a dead engine at low speed is held by compression
    if (!this.running && this.starter <= 0 && omega < 6 && -Qp < this.friction(0, false) * 1.3) omega = 0;
    this.omega = omega;

    // constant-speed governor: coarsen the blades when overspeeding, fine when under speed
    if (this.constantSpeed) {
      const err = (this.omega - this.omegaRated) / this.omegaRated;
      this.pitch = clamp(this.pitch + clamp(10 * err, -0.5, 0.5) * dt, this.pitchMin, this.pitchMax);
    }

    this.thrust = T;
    this.propTorque = Qp;
    this.shaftTorque = Qe;
    this.rpm = this.omega * 60 / TWO_PI;
    this.power = Math.max(0, Qe * this.omega);
    this.fuelFlow = this.running ? this.bsfc * (this.power + 0.06 * this.def.power) : 0;
    // momentum theory: induced velocity at the disc and swirl in the slipstream
    const A = Math.PI * D * D / 4;
    const disc = V * V + 2 * T / (rho * A);
    this.vInduced = disc > 0 ? 0.5 * (-V + Math.sqrt(disc)) : -0.5 * V;
    const mdot = rho * A * Math.max(V + this.vInduced, 2);
    this.vSwirl = Math.max(0, Qp) / (mdot * D / 3);
    return dt * this.fuelFlow;
  }

  /** angular momentum of the rotating assembly about the body X axis */
  get angularMomentum() { return this.dir * this.inertia * this.omega; }
  get n1() { return this.rpm / this.def.ratedRpm; }
}

export class JetEngine {
  constructor(def) {
    this.def = def;
    this.type = 'jet';
    this.pos = def.pos;
    this.dir = 0;
    this.idleN1 = def.idleN1 ?? 0.24;
    this.hasAB = !!def.abThrust;
    this.abDetent = def.abDetent ?? 0.82;
    this.n1 = this.idleN1;
    this.ab = 0;               // afterburner stage 0..1
    this.reverse = 0;          // reverser deployment 0..1
    this.running = true;
    this.thrust = 0; this.fuelFlow = 0; this.shaftTorque = 0;
    this.vInduced = 0; this.vSwirl = 0; this.rpm = 0; this.starter = 0;
  }

  start() { if (!this.running) { this.running = true; } }
  stop() { this.running = false; }

  update(dt, throttle, atm, vAxial, hasFuel, wantReverse) {
    const d = this.def;
    if (!hasFuel) this.running = false;
    let dry = throttle, abCmd = 0;
    if (this.hasAB) {
      dry = Math.min(1, throttle / this.abDetent);
      abCmd = throttle > this.abDetent ? (throttle - this.abDetent) / (1 - this.abDetent) : 0;
    }
    const target = this.running ? this.idleN1 + (1 - this.idleN1) * dry : 0.02 + Math.min(0.12, Math.max(0, vAxial) / 900);
    // spool dynamics: big fans accelerate slowly from low rpm
    const up = (d.spoolRate ?? 0.25) * (0.35 + 1.3 * this.n1);
    const down = (d.spoolRate ?? 0.25) * 1.2;
    this.n1 += clamp(target - this.n1, -down * dt, up * dt);
    this.ab += clamp((this.running && this.n1 > 0.93 ? abCmd : 0) - this.ab, -2.5 * dt, 1.6 * dt);
    this.reverse += clamp((wantReverse && d.reverser ? 1 : 0) - this.reverse, -0.7 * dt, 0.7 * dt);

    const M = Math.max(0, vAxial) / atm.a;
    const sigma = atm.sigma;
    const frac = Math.pow(clamp((this.n1 - 0.05) / 0.95, 0, 1), 2.3);
    let T, ff;
    if (d.bypass === 'high') {
      const m = Math.min(M, 1.2);
      const lapse = Math.pow(sigma, 0.62) * (0.568 + 0.25 * Math.pow(1.2 - m, 3));
      T = d.thrust * frac * lapse;
      ff = (d.tsfc ?? 1.05e-5) * (1 + 0.9 * M) * T + 0.012 * d.thrust * (d.tsfc ?? 1.05e-5) * sigma;
    } else {
      const lapseDry = Math.pow(sigma, 0.75) * (1 - 0.3 * M + 0.25 * M * M) * (1 - 0.5 * smoothstep(1.8, 2.6, M));
      T = d.thrust * frac * lapseDry;
      ff = (d.tsfc ?? 2.2e-5) * T + 0.02 * d.thrust * (d.tsfc ?? 2.2e-5) * sigma;
      if (this.hasAB && this.ab > 0.001) {
        const lapseAB = Math.pow(sigma, 0.72) * (1 + 0.15 * M * M) * (1 - 0.6 * smoothstep(1.9, 2.5, M));
        const Tab = Math.max(0, d.abThrust * lapseAB - d.thrust * lapseDry) * this.ab;
        T += Tab;
        ff += (d.tsfcAB ?? 5.6e-5) * Tab * 1.6;
      }
    }
    if (!this.running) { T *= 0.0; ff = 0; T -= 0.5 * atm.rho * vAxial * Math.abs(vAxial) * (d.windmillArea ?? 0.15); }
    // thrust reverser redirects a part of the fan flow forward
    if (this.reverse > 0.01) T *= 1 - 1.45 * this.reverse;
    this.thrust = T;
    this.fuelFlow = ff;
    this.rpm = this.n1 * 100;
    return dt * ff;
  }

  get angularMomentum() { return 0; }
}

export function createEngine(def) {
  return def.type === 'piston' ? new PistonEngine(def) : new JetEngine(def);
}
