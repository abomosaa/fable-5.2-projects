/**
 * Prints the performance figures the physics model produces for each airframe,
 * so they can be compared with real-world thrust-stand and flight data.
 *
 *   npm run bench
 */
import { DRONE_PRESETS, deriveParams, DroneParams } from '../src/sim/params';
import { Rotor } from '../src/sim/rotor';
import { Rng, GRAVITY, RAD2DEG, attitudeFromQuat } from '../src/sim/math';
import { Simulation, SIM_DT, SIM_HZ } from '../src/sim/simulation';
import { DEFAULT_ENV } from '../src/sim/environment';
import { actualRate } from '../src/sim/fc';

const RHO = 1.225;
const only = process.argv[2];

function thrustStand(p: DroneParams, volts: number): void {
  const d = deriveParams(p);
  const rng = new Rng(1);
  console.log(`  Thrust stand, one motor, constant ${volts.toFixed(1)} V supply, sea level:`);
  console.log('    duty    rpm   thrust[g]  phase[A]  supply[A]  power[W]   g/W   FM');
  for (const duty of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
    const r = new Rotor(p, d);
    for (let i = 0; i < 2.0 / SIM_DT; i++) r.update(SIM_DT, RHO, duty, volts, true, 0, 0, 0, 1, rng);
    const g = (r.thrust / GRAVITY) * 1000;
    const pw = r.busPower;
    const pIdeal = Math.pow(Math.max(r.thrust, 0), 1.5) / Math.sqrt(2 * RHO * d.discArea);
    const pShaft = r.aeroTorque * r.omega;
    console.log(
      `    ${duty.toFixed(2)}  ${r.rpm.toFixed(0).padStart(6)}  ${g.toFixed(0).padStart(8)}  ${r.current.toFixed(1).padStart(8)}  ${(pw / volts).toFixed(1).padStart(9)}  ${pw.toFixed(0).padStart(8)}  ${(g / pw).toFixed(2).padStart(5)}  ${(pIdeal / pShaft).toFixed(2)}`,
    );
  }
}

function makeSim(p: DroneParams): Simulation {
  const sim = new Simulation(p, { ...DEFAULT_ENV, windSpeed: 0, turbulence: 0, temperatureC: 15, elevation: 0 }, null);
  sim.damage = false;
  return sim;
}

function hover(p: DroneParams): void {
  const sim = makeSim(p);
  sim.drone.reset(0, 50, 0);
  sim.fc.cfg.mode = 'angle';
  sim.rc.throttle = 0;
  sim.arm();
  let thr = 0.25, integ = 0;
  let iAvg = 0, n = 0;
  for (let i = 0; i < 12 * SIM_HZ; i++) {
    // Simple altitude hold on throttle to find the trim.
    const err = 50 - sim.drone.pos.y;
    integ += err * SIM_DT;
    thr = Math.min(1, Math.max(0, 0.25 + 0.08 * err - 0.06 * sim.drone.vel.y + 0.03 * integ));
    sim.rc.throttle = thr;
    sim.stepOnce();
    if (i > 10 * SIM_HZ) { iAvg += sim.drone.packCurrent; n++; }
  }
  const dr = sim.drone;
  iAvg /= n;
  const cap = p.battery.capacityAh;
  console.log(
    `  Hover: throttle ${(sim.fc.throttle * 100).toFixed(1)} %, ${dr.rotors[0].rpm.toFixed(0)} rpm, ` +
      `${iAvg.toFixed(2)} A @ ${dr.vbus.toFixed(2)} V = ${(iAvg * dr.vbus).toFixed(0)} W ` +
      `(${((dr.d.mass * 1000) / (iAvg * dr.vbus)).toFixed(2)} g/W), ` +
      `hover endurance to 80 % DoD ~ ${(((cap * 0.8) / iAvg) * 60).toFixed(1)} min, v_i = ${dr.rotors[0].vi.toFixed(2)} m/s`,
  );
}

function punchOut(p: DroneParams): void {
  const sim = makeSim(p);
  sim.drone.reset(0, 20, 0);
  sim.fc.cfg.mode = 'angle';
  sim.rc.throttle = 0;
  sim.arm();
  sim.rc.throttle = 0.2;
  sim.run(1 * SIM_HZ);
  sim.drone.vel.y = 0;
  sim.rc.throttle = 1;
  let maxG = 0, t100 = -1, minV = 99, maxI = 0;
  const v0 = sim.drone.vbus;
  const y0 = sim.drone.pos.y;
  let tRise = -1;
  for (let i = 0; i < 6 * SIM_HZ; i++) {
    sim.stepOnce();
    const t = i * SIM_DT;
    maxG = Math.max(maxG, sim.gLoad);
    minV = Math.min(minV, sim.drone.vbus);
    maxI = Math.max(maxI, sim.drone.packCurrent);
    if (tRise < 0 && sim.drone.rotors[0].rpm > 0.9 * 0.67 * p.motor.kv * v0) tRise = t;
    if (t100 < 0 && sim.drone.pos.y - y0 >= 100) t100 = t;
  }
  console.log(
    `  Punch-out from hover: peak ${maxG.toFixed(1)} g, peak ${maxI.toFixed(0)} A, sag ${v0.toFixed(1)} -> ${minV.toFixed(1)} V, ` +
      `100 m climb in ${t100.toFixed(2)} s, vertical speed after 6 s ${sim.drone.vel.y.toFixed(1)} m/s (${(sim.drone.vel.y * 3.6).toFixed(0)} km/h)`,
  );
}

function topSpeed(p: DroneParams): void {
  const sim = makeSim(p);
  sim.drone.reset(0, 100, 0);
  sim.fc.cfg.mode = 'acro';
  sim.rc.throttle = 0;
  sim.arm();
  const att = { heading: 0, pitch: 0, roll: 0 };
  let integ = 0;
  let pitchCmd = 0;
  for (let i = 0; i < 25 * SIM_HZ; i++) {
    // Full throttle; a scripted pilot holds altitude with pitch attitude.
    attitudeFromQuat(sim.drone.q, att);
    const t = i * SIM_DT;
    sim.rc.throttle = t < 0.5 ? 0.3 : 1;
    const altErr = 100 - sim.drone.pos.y;
    integ = Math.max(-40, Math.min(40, integ + altErr * SIM_DT));
    // Desired nose-down angle: more nose down if climbing.
    const want = Math.max(5, Math.min(86, 60 - 2.0 * altErr + 3.0 * sim.drone.vel.y - 0.6 * integ));
    const have = -att.pitch * RAD2DEG;
    pitchCmd = Math.max(-1, Math.min(1, (want - have) * 0.03));
    sim.rc.pitch = pitchCmd;
    sim.stepOnce();
  }
  const v = sim.drone.vel;
  const sp = Math.hypot(v.x, v.z);
  attitudeFromQuat(sim.drone.q, att);
  console.log(
    `  Level top speed: ${sp.toFixed(1)} m/s (${(sp * 3.6).toFixed(0)} km/h) at ${(-att.pitch * RAD2DEG).toFixed(0)} deg nose-down, ` +
      `${sim.drone.rotors[0].rpm.toFixed(0)} rpm, ${sim.drone.packCurrent.toFixed(0)} A, ${sim.drone.vbus.toFixed(1)} V, vy ${v.y.toFixed(1)}`,
  );
}

function stepResponse(p: DroneParams, axis: 'roll' | 'pitch' | 'yaw', deflect = 0.6): void {
  const sim = makeSim(p);
  sim.drone.reset(0, 200, 0);
  sim.fc.cfg.mode = 'acro';
  sim.fc.gyroNoise = 0;
  sim.rc.throttle = 0;
  sim.arm();
  sim.rc.throttle = 0.3;
  sim.run(0.5 * SIM_HZ);
  sim.rc[axis] = deflect;
  const target = actualRate(deflect, sim.fc.cfg.rates[axis]);
  let t50 = -1, t90 = -1, peak = 0;
  for (let i = 0; i < 0.4 * SIM_HZ; i++) {
    sim.stepOnce();
    const w = sim.drone.omega;
    const rate = (axis === 'roll' ? -w.z : axis === 'pitch' ? -w.x : -w.y) * RAD2DEG;
    const t = i * SIM_DT * 1000;
    peak = Math.max(peak, rate);
    if (t50 < 0 && rate >= 0.5 * target) t50 = t;
    if (t90 < 0 && rate >= 0.9 * target) t90 = t;
  }
  const w = sim.drone.omega;
  const rate = (axis === 'roll' ? -w.z : axis === 'pitch' ? -w.x : -w.y) * RAD2DEG;
  console.log(
    `  ${axis.padEnd(5)} step to ${target.toFixed(0)} deg/s (incl. RC smoothing): 50 % at ${t50.toFixed(0)} ms, 90 % at ${t90.toFixed(0)} ms, ` +
      `overshoot ${(((peak - target) / target) * 100).toFixed(1)} %, final ${rate.toFixed(0)} deg/s`,
  );
}

function maxAngularAccel(p: DroneParams): void {
  const sim = makeSim(p);
  sim.drone.reset(0, 200, 0);
  sim.fc.cfg.mode = 'acro';
  sim.fc.gyroNoise = 0;
  sim.rc.throttle = 0;
  sim.arm();
  sim.rc.throttle = 0.5;
  sim.run(0.5 * SIM_HZ);
  sim.rc.roll = 1;
  let peak = 0, prev = 0;
  for (let i = 0; i < 0.15 * SIM_HZ; i++) {
    sim.stepOnce();
    const r = -sim.drone.omega.z * RAD2DEG;
    if (i % 40 === 39) {
      peak = Math.max(peak, (r - prev) / (40 * SIM_DT));
      prev = r;
    }
  }
  console.log(`  Peak roll acceleration at 50 % throttle: ${peak.toFixed(0)} deg/s^2`);
}

function perf(p: DroneParams): void {
  const sim = makeSim(p);
  sim.drone.reset(0, 50, 0);
  sim.rc.throttle = 0;
  sim.fc.cfg.mode = 'angle';
  sim.arm();
  sim.rc.throttle = 0.3;
  const n = 10 * SIM_HZ;
  const t0 = performance.now();
  sim.run(n);
  const ms = performance.now() - t0;
  console.log(`  CPU: ${((ms / n) * 1000).toFixed(2)} us per physics step (${(n / SIM_HZ / (ms / 1000)).toFixed(0)}x real time)`);
}

for (const p of DRONE_PRESETS) {
  if (only && p.id !== only) continue;
  const d = deriveParams(p);
  console.log(`\n=== ${p.name} (${p.id}) ===`);
  console.log(
    `  Mass ${(d.mass * 1000).toFixed(0)} g, inertia pitch/yaw/roll = ${d.inertia.map((v) => (v * 1e3).toFixed(3)).join(' / ')} g m^2, ` +
      `solidity ${d.solidity.toFixed(3)}, Kt ${(d.kt * 1000).toFixed(2)} mN m/A, CG offset ${d.modelOffset.map((v) => (-v * 1000).toFixed(1)).join(', ')} mm`,
  );
  const volts = p.battery.cells * 4.0;
  thrustStand(p, volts);
  hover(p);
  punchOut(p);
  topSpeed(p);
  stepResponse(p, 'roll');
  stepResponse(p, 'pitch');
  stepResponse(p, 'yaw');
  maxAngularAccel(p);
  perf(p);
}
