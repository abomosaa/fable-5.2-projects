/**
 * Prints how the model behaves in a handful of telling manoeuvres (developer tool):
 * random-input soak, flip, descent through prop wash, turtle mode, endurance.
 *
 *   npm run dynamics
 */
import { Simulation, SIM_HZ, SIM_DT } from '../src/sim/simulation';
import { getPreset } from '../src/sim/params';
import { DEFAULT_ENV } from '../src/sim/environment';
import { CollisionWorld, Heightfield } from '../src/sim/world';
import { Rng, RAD2DEG, attitudeFromQuat, qFromHeadingPitchRoll, quat } from '../src/sim/math';
import { buildMap } from '../src/world/map';

const CALM = { ...DEFAULT_ENV, windSpeed: 0, turbulence: 0 };
const att = { heading: 0, pitch: 0, roll: 0 };
const flat = () => new CollisionWorld(new Heightfield(400, 4, () => 0));

// 1. soak with random sticks in the real map, wind and turbulence
{
  const map = buildMap();
  const sim = new Simulation(getPreset('freestyle5'), { ...DEFAULT_ENV, windSpeed: 6, turbulence: 1.5 }, map.collision);
  sim.gates = map.gates;
  const rng = new Rng(7);
  let maxV = 0, maxW = 0, crashes = 0, nan = false, maxRpm = 0;
  sim.onEvent = (e) => { if (e === 'crash') crashes++; };
  const t0 = performance.now();
  for (let k = 0; k < 600; k++) {       // 600 x 0.5 s = 300 s
    if (sim.crashed || k % 60 === 0) { sim.reset(); sim.rc.throttle = 0; sim.arm(); }
    sim.fc.cfg.mode = k % 3 === 0 ? 'angle' : 'acro';
    sim.rc.throttle = rng.next() * rng.next() * 1.4 > 1 ? 1 : rng.next() * 0.7;
    sim.rc.roll = rng.range(-1, 1); sim.rc.pitch = rng.range(-1, 1); sim.rc.yaw = rng.range(-1, 1);
    for (let i = 0; i < 0.5 * SIM_HZ; i++) {
      sim.stepOnce();
      const d = sim.drone;
      const v = Math.hypot(d.vel.x, d.vel.y, d.vel.z), w = Math.hypot(d.omega.x, d.omega.y, d.omega.z);
      if (!(v >= 0) || !(w >= 0) || !(d.pos.y > -1e6)) { nan = true; break; }
      maxV = Math.max(maxV, v); maxW = Math.max(maxW, w);
      for (const r of d.rotors) maxRpm = Math.max(maxRpm, Math.abs(r.rpm));
    }
    if (nan) { console.log('NaN at chunk', k); break; }
  }
  console.log(`soak: 300 s in ${((performance.now() - t0) / 1000).toFixed(1)} s wall, NaN=${nan}, crashes=${crashes}, max speed ${maxV.toFixed(1)} m/s, max body rate ${(maxW * RAD2DEG).toFixed(0)} deg/s, max rpm ${maxRpm.toFixed(0)}`);
}

// 2. acro: 360 flip then hold, altitude loss
{
  const sim = new Simulation(getPreset('freestyle5'), CALM, null);
  sim.drone.reset(0, 100, 0); sim.fc.cfg.mode = 'acro'; sim.fc.gyroNoise = 0; sim.arm();
  sim.rc.throttle = 0.17; sim.run(1 * SIM_HZ);
  const y0 = sim.drone.pos.y;
  sim.rc.throttle = 0.6; sim.run(0.25 * SIM_HZ);     // blip
  sim.rc.throttle = 0.05; sim.rc.roll = 1;
  let ang = 0, t = 0;
  while (ang < 350 && t < 2) { sim.stepOnce(); ang += -sim.drone.omega.z * RAD2DEG * SIM_DT; t += SIM_DT; }
  sim.rc.roll = 0; sim.rc.throttle = 0.35; sim.run(0.6 * SIM_HZ);
  attitudeFromQuat(sim.drone.q, att);
  console.log(`flip: 350 deg in ${t.toFixed(2)} s, roll after ${(att.roll * RAD2DEG).toFixed(1)} deg, altitude change ${(sim.drone.pos.y - y0).toFixed(1)} m`);
}

// 3. prop wash: vertical descent in acro at constant throttle
for (const thr of [0.08, 0.12]) {
  const sim = new Simulation(getPreset('freestyle5'), CALM, null);
  sim.drone.reset(0, 300, 0); sim.fc.cfg.mode = 'acro'; sim.arm();
  sim.rc.throttle = 0.17; sim.run(1 * SIM_HZ);
  sim.rc.throttle = thr;
  let maxTilt = 0, vrs = 0, rateRms = 0, n = 0, vy = 0;
  for (let i = 0; i < 6 * SIM_HZ; i++) {
    sim.stepOnce();
    if (i > 2 * SIM_HZ) {
      attitudeFromQuat(sim.drone.q, att);
      maxTilt = Math.max(maxTilt, Math.abs(att.roll), Math.abs(att.pitch));
      vrs = Math.max(vrs, sim.drone.rotors[0].vrs);
      rateRms += sim.drone.omega.x ** 2 + sim.drone.omega.z ** 2; n++;
      vy = sim.drone.vel.y;
    }
  }
  console.log(`descent thr ${thr}: sink ${(-vy).toFixed(1)} m/s (v_h ~6.8), VRS ${vrs.toFixed(2)}, max tilt ${(maxTilt * RAD2DEG).toFixed(1)} deg, rate rms ${(Math.sqrt(rateRms / n) * RAD2DEG).toFixed(1)} deg/s`);
}

// 4. turtle mode: upside down on the ground
{
  const sim = new Simulation(getPreset('freestyle5'), CALM, flat());
  const q = qFromHeadingPitchRoll(quat(), 0, 0, Math.PI);
  sim.drone.reset(0, 0.3, 0, q);
  sim.run(1.5 * SIM_HZ);
  attitudeFromQuat(sim.drone.q, att);
  console.log(`inverted at rest: roll ${(att.roll * RAD2DEG).toFixed(0)}, y ${sim.drone.pos.y.toFixed(3)}, arm normally -> ${sim.arm()} (${sim.armBlock})`);
  sim.fc.turtle = true;
  console.log('turtle arm ->', sim.arm());
  sim.rc.roll = 1.0;
  let tUp = -1;
  for (let i = 0; i < 3 * SIM_HZ; i++) {
    sim.stepOnce();
    const upY = 1 - 2 * (sim.drone.q.x ** 2 + sim.drone.q.z ** 2);
    if (upY > -0.3) sim.rc.roll = 0;          // pilot lets go once it is past the balance point
    if (tUp < 0 && upY > 0.9) tUp = i * SIM_DT;
  }
  attitudeFromQuat(sim.drone.q, att);
  console.log(`turtle: upright after ${tUp.toFixed(2)} s, final roll ${(att.roll * RAD2DEG).toFixed(0)}, motors rpm ${sim.drone.rotors.map((r) => r.rpm.toFixed(0)).join(',')}, x ${sim.drone.pos.x.toFixed(2)} y ${sim.drone.pos.y.toFixed(2)}`);
}

// 5. battery endurance: aggressive cruise
{
  const sim = new Simulation(getPreset('freestyle5'), CALM, null);
  sim.drone.reset(0, 100, 0); sim.fc.cfg.mode = 'angle'; sim.arm();
  let t = 0, lowAt = -1;
  let integ = 0;
  while (t < 900 && sim.drone.battery.soc > 0.02) {
    const err = 100 - sim.drone.pos.y; integ = Math.max(-5, Math.min(5, integ + err * SIM_DT));
    sim.rc.throttle = Math.min(1, Math.max(0, 0.3 + 0.05 * err - 0.05 * sim.drone.vel.y + 0.03 * integ));
    sim.rc.pitch = 0.8;   // 44 deg forward
    sim.stepOnce(); t += SIM_DT;
    if (lowAt < 0 && sim.drone.vbus / 6 < 3.5) lowAt = t;
  }
  const v = sim.drone.vel;
  console.log(`cruise at 44 deg: ${(Math.hypot(v.x, v.z) * 3.6).toFixed(0)} km/h, ${sim.drone.packCurrent.toFixed(1)} A; 3.5 V/cell reached after ${(lowAt / 60).toFixed(1)} min; empty after ${(t / 60).toFixed(1)} min, used ${(sim.drone.battery.usedAh * 1000).toFixed(0)} mAh, alt ${sim.drone.pos.y.toFixed(0)}`);
}
