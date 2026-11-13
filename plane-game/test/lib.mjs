import { Aircraft, PHYSICS_DT } from '../src/physics/aircraft.js';
import { DEG, RAD, KT, FPM, clamp, G0 } from '../src/core/math.js';
export { DEG, RAD, KT, FPM, clamp, G0, PHYSICS_DT };

export function flatEnv(h = 0, wind = null) {
  return { ground: (x, z, o) => { o.h = h; o.nx = 0; o.ny = 1; o.nz = 0; o.type = 0; o.mu = 0.8; o.rr = 0.02; return o; }, wind };
}
export function make(def, env = flatEnv()) { return new Aircraft(def, env); }
export function run(ac, seconds, fn) {
  const n = Math.round(seconds / PHYSICS_DT);
  for (let i = 0; i < n; i++) { if (fn) fn(i * PHYSICS_DT, ac); ac.step(PHYSICS_DT); if (ac.crashed) return false; }
  return true;
}
export const kt = (v) => (v / KT).toFixed(1);
export const fpm = (v) => (v / FPM).toFixed(0);
export const deg = (v) => (v * RAD).toFixed(2);

export function groundStatic(def) {
  const ac = make(def);
  ac.reset({ x: 0, z: 0, heading: 0, onGround: true });
  run(ac, 5);
  const e = ac.engines[0];
  console.log(`[ground idle] y=${ac.pos.y.toFixed(3)} pitch=${deg(ac.euler.pitch)} rpm/n1=${e.rpm.toFixed(0)} thrust=${ac.thrust.toFixed(0)}N creep=${Math.hypot(ac.pos.x, ac.pos.z).toFixed(3)}m loads=${ac.gear.wheels.map(w => (w.load / G0).toFixed(0) + 'kg/' + w.compression.toFixed(3)).join(' ')}`);
  ac.ctrl.throttle = 1;
  run(ac, 8);
  console.log(`[static full] rpm/n1=${e.rpm.toFixed(0)} thrust=${ac.thrust.toFixed(0)}N (${(ac.thrust / (ac.mass * G0)).toFixed(2)} T/W) creep=${Math.hypot(ac.pos.x, ac.pos.z).toFixed(3)}m roll=${deg(ac.euler.roll)} fuelflow=${(e.fuelFlow * 3600).toFixed(0)}kg/h`);
  return ac;
}

export function takeoff(def, opts = {}) {
  const ac = make(def);
  ac.reset({ x: 0, z: 0, heading: 0, onGround: true });
  ac.ctrl.flapIndex = opts.flapIndex ?? 0;
  run(ac, 3);
  ac.ctrl.parkingBrake = false; ac.ctrl.throttle = 1;
  const vr = def.speeds.vr, vy = def.speeds.vy;
  let liftT = -1, liftX = 0, t50 = -1, x50 = 0, maxDev = 0;
  const pitchTarget = (opts.pitch ?? 9) * DEG;
  let integ = 0;
  const ok = run(ac, opts.time ?? 90, (t, a) => {
    if (a.ias > vr) {
      // rotate and hold pitch attitude, then hold Vy with pitch
      let target = pitchTarget;
      if (a.agl > 15 && !opts.holdPitch) { integ = clamp(integ + (a.ias - vy) * 0.0006 * PHYSICS_DT * 300 / 300, -0.2, 0.2); target = pitchTarget + (a.ias - vy) * 0.012 + integ; }
      a.ctrl.pitch = clamp((target - a.euler.pitch) * 4 - a.omega.z * 1.2, -1, 1);
    }
    a.ctrl.roll = clamp(-a.euler.roll * 2 - a.omega.x * 0.5, -1, 1);
    if (a.onGround) a.ctrl.yaw = clamp(-(a.euler.heading > Math.PI ? a.euler.heading - 2 * Math.PI : a.euler.heading) * 3 - a.pos.z * 0.05, -1, 1); else a.ctrl.yaw = 0;
    if (liftT < 0 && !a.onGround && a.agl > 1.5) { liftT = t; liftX = a.pos.x; }
    if (liftT < 0) maxDev = Math.max(maxDev, Math.abs(a.pos.z));
    if (t50 < 0 && a.agl > 15.24 + 1.2) { t50 = t; x50 = a.pos.x; if (def.retractable) a.ctrl.gearDown = false; }
  });
  console.log(`[takeoff] ok=${ok}${ac.crashed ? ' CRASH ' + ac.crashed.reason : ''} liftoff t=${liftT.toFixed(1)}s roll=${liftX.toFixed(0)}m  50ft at ${x50.toFixed(0)}m  maxLateralDev=${maxDev.toFixed(1)}m  end: alt=${ac.pos.y.toFixed(0)}m ias=${kt(ac.ias)}kt vs=${fpm(ac.vel.y)}fpm pitch=${deg(ac.euler.pitch)} alpha=${deg(ac.alpha)}`);
  return ac;
}

export function airStart(def, iasKt, altM, opts = {}) {
  const ac = make(def);
  ac.reset({ x: 0, z: 0, heading: opts.heading ?? 0, altitude: altM, speed: iasKt * KT, onGround: false, flapIndex: opts.flapIndex ?? 0, gearDown: opts.gearDown });
  ac.trimInAir(iasKt * KT, opts.gamma ?? 0, opts.seconds ?? 30);
  return ac;
}

export function report(tag, ac) {
  console.log(`[${tag}] alt=${ac.pos.y.toFixed(0)}m ias=${kt(ac.ias)}kt tas=${kt(ac.tas)}kt M=${ac.mach.toFixed(3)} vs=${fpm(ac.vel.y)}fpm pitch=${deg(ac.euler.pitch)} roll=${deg(ac.euler.roll)} alpha=${deg(ac.alpha)} beta=${deg(ac.beta)} thr=${ac.throttleCmd.toFixed(2)} rpm=${ac.engines[0].rpm.toFixed(0)} trim=${ac.ctrl.trim.toFixed(3)} elev=${deg(ac.surf.elevator)} nz=${ac.nz.toFixed(2)} T=${ac.thrust.toFixed(0)}N`);
}

export function cruise(def, iasKt, altM) {
  const ac = airStart(def, iasKt, altM);
  report(`trim ${iasKt}kt @${altM}m`, ac);
  return ac;
}

export function maxSpeed(def, altM, startKt) {
  const ac = airStart(def, startKt, altM);
  ac.ap.engage(); ac.ap.altitude = altM; ac.ctrl.throttle = 1;
  run(ac, 180);
  report(`max level speed @${altM}m`, ac);
  return ac;
}

export function climb(def, iasKt, altM = 300) {
  const ac = airStart(def, iasKt, altM);
  // full throttle, hold airspeed with pitch
  ac.ctrl.throttle = 1;
  let integ = 0; let h0 = 0, t0 = 20;
  run(ac, 60, (t, a) => {
    const e = a.ias - iasKt * KT;
    integ = clamp(integ + e * 0.02 * PHYSICS_DT, -0.3, 0.3);
    const target = e * 0.02 + integ + 6 * DEG;
    a.ctrl.pitch = clamp((target - a.euler.pitch) * 4 - a.omega.z * 1.2, -1, 1);
    a.ctrl.roll = clamp(-a.euler.roll * 2 - a.omega.x * 0.5, -1, 1);
    if (Math.abs(t - t0) < PHYSICS_DT / 2) h0 = a.pos.y;
  });
  console.log(`[climb @${iasKt}kt] avg ROC=${fpm((ac.pos.y - h0) / 40)}fpm  ias=${kt(ac.ias)} pitch=${deg(ac.euler.pitch)} rpm=${ac.engines[0].rpm.toFixed(0)} beta=${deg(ac.beta)} rud=${deg(ac.surf.rudder)}`);
  return ac;
}

export function glide(def, iasKt, altM = 1500) {
  const ac = airStart(def, iasKt, altM);
  ac.ctrl.throttle = 0;
  let integ = 0; let h0 = 0, x0 = 0;
  run(ac, 60, (t, a) => {
    const e = a.ias - iasKt * KT;
    integ = clamp(integ + e * 0.02 * PHYSICS_DT, -0.3, 0.3);
    const target = e * 0.02 + integ - 2 * DEG;
    a.ctrl.pitch = clamp((target - a.euler.pitch) * 4 - a.omega.z * 1.2, -1, 1);
    a.ctrl.roll = clamp(-a.euler.roll * 2 - a.omega.x * 0.5, -1, 1);
    if (Math.abs(t - 20) < PHYSICS_DT / 2) { h0 = a.pos.y; x0 = a.pos.x; }
  });
  console.log(`[glide @${iasKt}kt] sink=${fpm((ac.pos.y - h0) / 40)}fpm L/D=${((ac.pos.x - x0) / (h0 - ac.pos.y)).toFixed(1)} rpm=${ac.engines[0].rpm.toFixed(0)}`);
  return ac;
}

export function stall(def, altM = 1500, flapIndex = 0, startKt) {
  const ac = airStart(def, startKt ?? (def.ref ? def.ref.vs * 1.5 / KT : 80), altM, { flapIndex });
  ac.ctrl.throttle = 0;
  let minIas = 1e9, maxAlpha = 0, breakT = -1, rollAtBreak = 0, clMax = 0;
  const alt0 = ac.pos.y;
  let pitchCmd = ac.euler.pitch;
  run(ac, 80, (t, a) => {
    // slowly raise the nose to bleed speed ~1 kt/s while keeping wings level with rudder+aileron
    if (breakT < 0) {
      const vsErr = 0 - a.vel.y;
      a.ctrl.pitch = clamp(a.ctrl.pitch + clamp(vsErr * 0.02 - a.omega.z * 0.5, -0.4, 0.15) * PHYSICS_DT, -1, 1);
      if (a.stalled > 0.5 || (a.vel.y < -6 && a.ctrl.pitch > 0.95)) { breakT = t; rollAtBreak = a.euler.roll; }
      minIas = Math.min(minIas, a.ias); maxAlpha = Math.max(maxAlpha, a.alpha); clMax = Math.max(clMax, a.clWing);
    } else {
      a.ctrl.pitch = -0.2; if (t - breakT > 3) a.ctrl.pitch = 0.2;
    }
    a.ctrl.roll = clamp(-a.euler.roll * 1.5 - a.omega.x * 0.5, -1, 1);
  });
  console.log(`[stall flaps=${flapIndex}] Vs=${kt(minIas)}kt alphaMax=${deg(maxAlpha)} CLwing=${clMax.toFixed(2)} break at t=${breakT.toFixed(1)} altLoss=${(alt0 - ac.pos.y).toFixed(0)}m  end ias=${kt(ac.ias)} roll=${deg(ac.euler.roll)} ${ac.crashed ? 'CRASH ' + ac.crashed.reason : ''}`);
  return ac;
}

export function rollRate(def, iasKt, altM = 1000) {
  const ac = airStart(def, iasKt, altM);
  let peak = 0, t360 = -1, acc = 0, maxBeta = 0;
  run(ac, 6, (t, a) => {
    a.ctrl.roll = t > 0.5 ? 1 : 0;
    if (t > 0.5) { peak = Math.max(peak, a.omega.x); acc += a.omega.x * PHYSICS_DT; if (t360 < 0 && acc > 2 * Math.PI) t360 = t - 0.5; maxBeta = Math.max(maxBeta, Math.abs(a.beta)); }
  });
  console.log(`[roll @${iasKt}kt] peak=${(peak * RAD).toFixed(0)}deg/s  360 in ${t360.toFixed(2)}s maxBeta=${deg(maxBeta)}`);
}

export function handsOff(def, iasKt, altM = 1500, seconds = 120, disturb = true) {
  const ac = airStart(def, iasKt, altM);
  const log = [];
  if (disturb) { ac.omega.z += 0.1; ac.omega.y += 0.1; }
  run(ac, seconds, (t, a) => { if (Math.round(t / PHYSICS_DT) % Math.round(10 / PHYSICS_DT) === 0) log.push(`${t.toFixed(0)}s: alt=${a.pos.y.toFixed(0)} ias=${kt(a.ias)} roll=${deg(a.euler.roll)} hdg=${deg(a.euler.heading)} beta=${deg(a.beta)}`); });
  console.log(`[hands-off @${iasKt}kt]\n  ` + log.join('\n  '));
  return ac;
}

export function pullUp(def, iasKt, altM = 1500, stick = 1, secs = 4) {
  const ac = airStart(def, iasKt, altM);
  let maxG = 0, maxAlpha = 0; const tr = [];
  run(ac, secs, (t, a) => { a.ctrl.pitch = t > 0.3 ? stick : 0; maxG = Math.max(maxG, a.nz); maxAlpha = Math.max(maxAlpha, a.alpha); if (Math.round(t / PHYSICS_DT) % 60 === 0) tr.push(a.nz.toFixed(1)); });
  console.log(`[pull ${stick} @${iasKt}kt] maxG=${maxG.toFixed(2)} maxAlpha=${deg(maxAlpha)} ${ac.crashed ? 'CRASH ' + ac.crashed.reason : ''} nz: ${tr.join(' ')}`);
}
