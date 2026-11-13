// Flight control system and autopilot.
//
// "direct" law: cables and pushrods. Stick position maps to surface deflection; the pilot's
//   strength limits the deflection at high dynamic pressure (surface hinge moments grow with q).
// "fbw" law: fly-by-wire. Pitch stick commands load factor (g) with angle-of-attack protection
//   and automatic trim, roll stick commands roll rate, the rudder is coordinated automatically.

import { DEG, G0, clamp, smoothstep, wrapPi, approach } from '../core/math.js';

export class FlightControlSystem {
  constructor(ac) {
    this.ac = ac;
    this.c = ac.def.controls;
    this.fbw = this.c.fbw || null;
    this.integ = 0;        // pitch integrator (normalised elevator)
    this.blend = 0;        // 0 direct .. 1 full fly-by-wire
    this.nzCmd = 1;
    this.rollInt = 0;
    this.hdgRef = null;    // heading held by the ground-roll assist
    this.bankRef = null;   // bank angle held by the bank-hold assist
    this.refX = 0; this.refZ = 0;
    // normalised commands (after laws), for visualising the stick
    this.elevN = 0; this.ailN = 0; this.rudN = 0;
  }

  reset() { this.integ = 0; this.blend = 0; this.rollInt = 0; this.nzCmd = 1; this.hdgRef = null; this.bankRef = null; }

  update(dt, pitch, roll, yaw) {
    const ac = this.ac, c = this.c, cmd = ac.cmd;
    const qbar = Math.max(ac.qbar, 20);
    const onGround = ac.gear.onGround;
    const kP = Math.min(1, c.qRefPitch / qbar);
    const kR = Math.min(1, c.qRefRoll / qbar);
    const kY = Math.min(1, c.qRefYaw / qbar);

    // --- rudder: pedal + automatic turn coordination / yaw damper
    let yawCmd = yaw;
    const autoCoord = (this.fbw || ac.assist.autoRudder) && !onGround && ac.tas > 0.6 * ac.def.ref.vs;
    if (!onGround) this.hdgRef = null;
    if (autoCoord) {
      const rCoord = G0 * Math.sin(ac.euler.roll) * Math.cos(ac.euler.pitch) / Math.max(ac.tas, 20);
      const r = -ac.omega.y;
      yawCmd += clamp((c.arBeta ?? 3.0) * ac.beta + (c.arRate ?? 0.8) * (rCoord - r), -0.8, 0.8);
    } else if (onGround && ac.assist.autoRudder) {
      // on the ground the roll input also steers, so that keyboard pilots can taxi; with the
      // controls neutral the assist holds the heading against torque, P-factor and crosswind
      const steering = Math.abs(yaw) > 0.05 || Math.abs(roll) > 0.05;
      const gs = Math.hypot(ac.vel.x, ac.vel.z);
      if (steering || gs < 0.6 || this.hdgRef === null) { this.hdgRef = ac.euler.heading; this.refX = ac.pos.x; this.refZ = ac.pos.z; }
      if (Math.abs(yaw) < 0.05) yawCmd += roll * 0.7;
      if (!steering && gs >= 0.6) {
        // track the line through the point where the controls were released, not just its direction
        const cross = -(ac.pos.x - this.refX) * Math.sin(this.hdgRef) + (ac.pos.z - this.refZ) * Math.cos(this.hdgRef);
        const target = this.hdgRef - clamp(cross * 0.012, -0.1, 0.1);
        yawCmd += clamp(8 * wrapPi(target - ac.euler.heading) + 2.2 * ac.omega.y, -1, 1);
      }
    } else if (c.yawDamper && !onGround) {
      yawCmd += clamp(c.yawDamper * ac.omega.y, -0.4, 0.4);
    }
    yawCmd = clamp(yawCmd, -1, 1);
    this.rudN = yawCmd;
    cmd.rudder = (yawCmd * c.rudder * kY + (c.rigRudder ?? 0)) * DEG;
    cmd.steer = yawCmd;

    if (!this.fbw) {
      // --- direct law
      const e = pitch >= 0 ? pitch * c.elevUp : pitch * c.elevDown;
      this.elevN = clamp(pitch * kP + ac.ctrl.trim * (c.trimRange / c.elevUp), -1, 1);
      cmd.elevator = clamp(e * DEG * kP + ac.ctrl.trim * c.trimRange * DEG, -c.elevDown * DEG, c.elevUp * DEG);
      // rigging offsets counter the engine torque at cruise power (as bent trim tabs do)
      cmd.aileron = (roll * c.aileron * kR + (c.rigAileron ?? 0)) * DEG;
      if (ac.assist.bankHold && !onGround && Math.abs(roll) < 0.02 && !ac.stallWarning) {
        // assist: with the roll control released, hold the bank angle (cancels engine torque
        // and the slow spiral divergence, like a wing leveller with a memory)
        if (this.bankRef === null) { const b = ac.euler.roll + ac.omega.x * 0.12; this.bankRef = Math.abs(b) < 4 * DEG ? 0 : clamp(b, -1.2, 1.2); }
        const u = clamp(1.5 * wrapPi(this.bankRef - ac.euler.roll) - 0.25 * ac.omega.x, -0.5, 0.5);
        cmd.aileron += u * c.aileron * DEG * kR;
      } else this.bankRef = null;
      this.ailN = roll * kR;
      // keyboard assist: slowly re-trim in the direction of a held pitch input
      // (never into a stall, and not while manoeuvring hard: that is not a trim condition)
      if (ac.assist.autoTrim && !onGround && Math.abs(pitch) > 0.05 && !ac.stallWarning && Math.abs(ac.nz - 1) < 0.7) {
        const t = ac.ctrl.trim + pitch * kP * (c.autoTrimRate ?? 0.1) * dt;
        if (Math.abs(t) < 0.7 || Math.abs(t) < Math.abs(ac.ctrl.trim)) ac.ctrl.trim = t;
      }
      return;
    }

    // --- fly-by-wire law
    const f = this.fbw;
    const wantBlend = onGround ? 0 : smoothstep(0.25 * f.qMin, f.qMin, ac.qbar);
    this.blend = approach(this.blend, wantBlend, dt / 1.2);
    const sched = clamp(f.qRef / qbar, 0.08, 4);

    // pitch: load-factor command with alpha protection
    const nMax = f.nMax, nMin = f.nMin;
    let nzCmd = pitch >= 0 ? 1 + pitch * (nMax - 1) : 1 + pitch * (1 - nMin);
    if (f.pathStable) {
      // hold the flight path hands-off: compensate for bank and pitch attitude
      const cr = Math.cos(ac.euler.roll);
      nzCmd += Math.cos(ac.euler.pitch) / clamp(cr, 0.55, 1) - 1;
    }
    const nzAlpha = Math.max(0.5, ac.qbar * ac.def.ref.S * ac.def.ref.a / (ac.mass * G0)); // g per rad
    const aMax = f.alphaMax * DEG, aMin = (f.alphaMin ?? -8) * DEG;
    const pitchRate = ac.omega.z;
    // angle-of-attack protection with pitch-rate anticipation
    const aPred = ac.alpha + (f.alphaLead ?? 0.35) * pitchRate;
    const nzHi = ac.nz + nzAlpha * (aMax - aPred);
    const nzLo = ac.nz + nzAlpha * (aMin - aPred);
    nzCmd = clamp(nzCmd, Math.min(nzLo, 1), Math.max(nzHi, 0));
    // command pre-filter: limits the g onset rate
    this.nzCmd += (nzCmd - this.nzCmd) * Math.min(1, dt / (f.tau ?? 0.3));
    const err = this.nzCmd - ac.nz;
    const out = (f.kp * err + this.integ) * sched - f.kq * pitchRate * Math.sqrt(sched);
    const sat = Math.abs(out) >= 1;
    if (this.blend > 0.5 && !(sat && Math.sign(err) === Math.sign(out))) {
      // the short-period mode slows down with sqrt(q): slow the integrator with it
      const kiEff = f.ki * clamp(1 / Math.sqrt(sched), 0.35, 1.4);
      this.integ = clamp(this.integ + kiEff * err * dt, -1 / sched, 1 / sched);
    }
    const direct = clamp(pitch * kP + ac.ctrl.trim * 0.3, -1, 1);
    if (this.blend < 0.02) this.integ = direct / sched;   // bumpless transfer after lift-off
    const eN = clamp(direct + (clamp(out, -1, 1) - direct) * this.blend, -1, 1);
    this.elevN = eN;
    cmd.elevator = eN * (eN >= 0 ? c.elevUp : c.elevDown) * DEG;

    // roll: rate command with bank-angle protection
    let pCmd = roll * f.rollRate * DEG;
    if (f.bankLimit) {
      const lim = f.bankLimit * DEG, phi = ac.euler.roll;
      if (phi > lim) pCmd = Math.min(pCmd, -(phi - lim) * 1.5);
      else if (phi < -lim) pCmd = Math.max(pCmd, -(phi + lim) * 1.5);
    }
    const p = ac.omega.x;
    const rs = Math.pow(sched, 0.75);
    const pErr = pCmd - p;
    const rollRaw = (f.kRoll * pErr + this.rollInt) * rs;
    if (this.blend > 0.5 && (Math.abs(rollRaw) < 1 || Math.sign(pErr) !== Math.sign(rollRaw))) {
      this.rollInt = clamp(this.rollInt + (f.kiRoll ?? f.kRoll * 4) * pErr * dt, -1 / rs, 1 / rs);
    } else if (this.blend <= 0.5) this.rollInt = 0;
    const rollOut = clamp(rollRaw, -1, 1);
    const aN = roll * kR + (rollOut - roll * kR) * this.blend;
    this.ailN = aN;
    cmd.aileron = aN * c.aileron * DEG;
  }
}

/** Three-axis autopilot with autothrottle. Outputs stick / throttle commands. */
export class Autopilot {
  constructor(ac) {
    this.ac = ac;
    this.engaged = false;
    this.autothrottle = false;
    this.altitude = 1000;     // m
    this.heading = 0;         // rad
    this.speed = 60;          // m/s indicated
    this.vsLimit = ac.def.autopilot?.vs ?? 5;
    this.altGain = ac.def.autopilot?.altGain ?? 0.18;
    this.pitchInt = 0; this.thrInt = 0.5;
    this.pitch = 0; this.roll = 0; this.throttle = 0.5;
    this.approach = null;     // {runway} when flying a coupled ILS approach
  }

  engage() {
    const ac = this.ac;
    this.engaged = true;
    this.altitude = Math.round(ac.pos.y / 30.48) * 30.48;
    this.heading = ac.euler.heading;
    this.pitchInt = ac.fcs.fbw ? 0 : 0;
    this.pitch = 0; this.roll = 0;
  }
  engageAutothrottle() {
    this.autothrottle = true;
    this.speed = Math.max(this.ac.ias, this.ac.def.ref.vs * 1.25);
    this.thrInt = this.ac.ctrl.throttle;
  }
  disengage() { this.engaged = false; this.autothrottle = false; }

  update(dt) {
    const ac = this.ac, g = ac.def.autopilot || {};
    const V = Math.max(ac.tas, 15);
    if (this.autothrottle) {
      const e = this.speed - ac.ias;
      const kp = g.thrKp ?? 0.06, ki = g.thrKi ?? 0.012;
      const acc = ac.iasRate;
      this.thrInt = clamp(this.thrInt + ki * e * dt, 0, 1);
      this.throttle = clamp(this.thrInt + kp * e - (g.thrKd ?? 0.12) * acc, 0, 1);
    }
    if (!this.engaged) return;
    if (ac.gear.onGround || ac.stalled > 0.8) { this.engaged = false; ac.events.push({ type: 'ap-disconnect' }); return; }

    // lateral: heading -> bank -> roll stick
    const hErr = wrapPi(this.heading - ac.euler.heading);
    const bankMax = (g.bank ?? 25) * DEG;
    const phiCmd = clamp(hErr * (g.hdgGain ?? 1.4), -bankMax, bankMax);
    const phiErr = phiCmd - ac.euler.roll;
    if (ac.fcs.fbw) {
      const pCmd = clamp(phiErr * 1.6, -0.3, 0.3);
      this.roll = clamp(pCmd / (ac.fcs.fbw.rollRate * DEG), -1, 1);
    } else {
      const qs = Math.max(1, ac.qbar / ac.def.controls.qRefRoll);
      this.roll = clamp(((g.rollKp ?? 1.6) * phiErr - (g.rollKd ?? 0.5) * ac.omega.x) * Math.sqrt(qs), -1, 1);
    }

    // vertical: altitude -> vertical speed -> flight path angle -> pitch stick
    const altErr = this.altitude - ac.pos.y;
    const vsCmd = clamp(altErr * this.altGain, -this.vsLimit, this.vsLimit);
    const gamma = Math.asin(clamp(ac.vel.y / V, -1, 1));
    const gammaCmd = Math.asin(clamp(vsCmd / V, -0.4, 0.4));
    const gErr = gammaCmd - gamma;
    if (ac.fcs.fbw) {
      const f = ac.fcs.fbw;
      const cr = clamp(Math.cos(ac.euler.roll), 0.5, 1);
      let nz = (V / G0) * (g.gammaGain ?? 0.4) * gErr;
      if (!f.pathStable) nz += Math.cos(gamma) / cr - 1;
      nz = clamp(nz, -0.6, 0.9);
      this.pitch = nz >= 0 ? nz / (f.nMax - 1) : nz / (1 - f.nMin);
    } else {
      const qs = Math.max(1, ac.qbar / ac.def.controls.qRefPitch);
      const kp = g.pitchKp ?? 3.0, ki = g.pitchKi ?? 1.2, kd = g.pitchKd ?? 0.9;
      const bankComp = (1 / clamp(Math.cos(ac.euler.roll), 0.6, 1) - 1) * 0.6;
      const raw = kp * gErr + this.pitchInt - kd * ac.omega.z + bankComp;
      if (Math.abs(raw) < 1 || Math.sign(gErr) !== Math.sign(raw)) this.pitchInt = clamp(this.pitchInt + ki * gErr * dt, -1, 1);
      this.pitch = clamp(raw * Math.sqrt(qs), -1, 1);
    }
  }
}
