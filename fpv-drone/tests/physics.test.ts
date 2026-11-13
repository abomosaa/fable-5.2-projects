import { describe, it, expect } from 'vitest';
import { Simulation, SIM_DT, SIM_HZ } from '../src/sim/simulation';
import { DRONE_PRESETS, getPreset, deriveParams, computeMassProperties } from '../src/sim/params';
import { DEFAULT_ENV, Environment } from '../src/sim/environment';
import { Rotor, inducedVelocityRatio, PLATE_CD } from '../src/sim/rotor';
import { Battery, cellOcv } from '../src/sim/battery';
import { CollisionWorld, Heightfield, crossedGate } from '../src/sim/world';
import { actualRate, throttleCurve } from '../src/sim/fc';
import {
  GRAVITY, RAD2DEG, DEG2RAD, Rng, quat, qFromHeadingPitchRoll, attitudeFromQuat, qIntegrate, qRotate, qRotateInv, vec3,
} from '../src/sim/math';
import { buildMap } from '../src/world/map';

const CALM = { ...DEFAULT_ENV, windSpeed: 0, turbulence: 0, temperatureC: 15, elevation: 0 };
const five = getPreset('freestyle5');

function flatWorld(): CollisionWorld {
  return new CollisionWorld(new Heightfield(400, 4, () => 0));
}

function airborne(mode: 'acro' | 'angle' | 'horizon' = 'angle', alt = 100, preset = five): Simulation {
  const sim = new Simulation(preset, CALM, null);
  sim.damage = false;
  sim.drone.reset(0, alt, 0);
  sim.fc.cfg.mode = mode;
  sim.fc.gyroNoise = 0;
  sim.arm();
  return sim;
}

/** Hold altitude with a simple throttle loop for `seconds`. */
function holdAltitude(sim: Simulation, alt: number, seconds: number): void {
  let integ = 0;
  for (let i = 0; i < seconds * SIM_HZ; i++) {
    const err = alt - sim.drone.pos.y;
    integ += err * SIM_DT;
    sim.rc.throttle = Math.min(1, Math.max(0, 0.2 + 0.08 * err - 0.06 * sim.drone.vel.y + 0.03 * integ));
    sim.stepOnce();
  }
}

describe('math', () => {
  it('attitude round-trips through the quaternion', () => {
    const att = { heading: 0, pitch: 0, roll: 0 };
    for (const [h, p, r] of [[30, 10, -20], [-140, -35, 60], [170, 50, 5], [0, 0, 179]]) {
      const q = qFromHeadingPitchRoll(quat(), h * DEG2RAD, p * DEG2RAD, r * DEG2RAD);
      attitudeFromQuat(q, att);
      expect(att.heading * RAD2DEG).toBeCloseTo(h, 6);
      expect(att.pitch * RAD2DEG).toBeCloseTo(p, 6);
      expect(att.roll * RAD2DEG).toBeCloseTo(r, 6);
    }
  });

  it('heading is still read correctly when the nose points straight up or down', () => {
    const att = { heading: 0, pitch: 0, roll: 0 };
    for (const [h, p] of [[30, 90], [30, -90], [-120, 90], [90, -90]]) {
      attitudeFromQuat(qFromHeadingPitchRoll(quat(), h * DEG2RAD, p * DEG2RAD, 0), att);
      expect(att.heading * RAD2DEG).toBeCloseTo(h, 5);
      expect(att.pitch * RAD2DEG).toBeCloseTo(p, 5);
    }
  });

  it('heading 90 deg faces east (+X), pitch up raises the nose', () => {
    const q = qFromHeadingPitchRoll(quat(), 90 * DEG2RAD, 0, 0);
    const f = qRotate(vec3(), q, vec3(0, 0, -1));
    expect(f.x).toBeCloseTo(1, 9);
    const q2 = qFromHeadingPitchRoll(quat(), 0, 30 * DEG2RAD, 0);
    expect(qRotate(vec3(), q2, vec3(0, 0, -1)).y).toBeCloseTo(0.5, 9);
  });

  it('integrating a constant body rate for one revolution returns to the start', () => {
    const q = qFromHeadingPitchRoll(quat(), 0.3, 0.2, -0.4);
    const q0 = { ...q };
    const w = 7.5;
    const n = 4000;
    const dt = (2 * Math.PI) / w / n;
    for (let i = 0; i < n; i++) qIntegrate(q, 0, 0, w, dt);
    // q and -q are the same rotation
    const dot = Math.abs(q.w * q0.w + q.x * q0.x + q.y * q0.y + q.z * q0.z);
    expect(dot).toBeCloseTo(1, 9);
  });

  it('rotate / inverse rotate are inverses', () => {
    const q = qFromHeadingPitchRoll(quat(), 1.1, -0.6, 2.2);
    const v = vec3(0.3, -1.2, 2.5);
    const r = qRotateInv(vec3(), q, qRotate(vec3(), q, v));
    expect(r.x).toBeCloseTo(v.x, 12);
    expect(r.y).toBeCloseTo(v.y, 12);
    expect(r.z).toBeCloseTo(v.z, 12);
  });
});

describe('mass properties', () => {
  it('parallel-axis theorem for two point masses', () => {
    const mp = computeMassProperties([
      { name: 'a', mass: 1, pos: [1, 0, 0], size: [0, 0, 0] },
      { name: 'b', mass: 1, pos: [-1, 0, 0], size: [0, 0, 0] },
    ]);
    expect(mp.mass).toBe(2);
    expect(mp.inertia[0]).toBeCloseTo(0, 12); // about X: on the axis
    expect(mp.inertia[1]).toBeCloseTo(2, 12);
    expect(mp.inertia[2]).toBeCloseTo(2, 12);
  });

  it('presets have plausible mass and inertia ordering (yaw > pitch > roll)', () => {
    for (const p of DRONE_PRESETS) {
      const d = deriveParams(p);
      expect(d.mass).toBeGreaterThan(0.15);
      expect(d.mass).toBeLessThan(0.9);
      expect(d.inertia[1]).toBeGreaterThan(d.inertia[0]);
      expect(d.inertia[0]).toBeGreaterThan(d.inertia[2]);
    }
  });
});

describe('rotor aerodynamics', () => {
  it('induced velocity: hover, climb, forward flight and windmill limits', () => {
    expect(inducedVelocityRatio(0, 0)).toBeCloseTo(1, 9);
    // axial climb: nu = -lc/2 + sqrt(lc^2/4 + 1)
    expect(inducedVelocityRatio(2, 0)).toBeCloseTo(-1 + Math.sqrt(2), 9);
    // fast forward flight: nu -> 1/mu
    expect(inducedVelocityRatio(0, 8)).toBeCloseTo(1 / 8, 2);
    // Glauert at mu = 1, level: nu^4 + nu^2 - 1 = 0
    const nu = inducedVelocityRatio(0, 1);
    expect(nu ** 4 + nu ** 2).toBeCloseTo(1, 6);
    // vortex ring state: more induced velocity than hover
    expect(inducedVelocityRatio(-1, 0)).toBeGreaterThan(1.5);
    // continuous at the windmill-brake boundary
    expect(inducedVelocityRatio(-2.0000001, 0)).toBeCloseTo(inducedVelocityRatio(-1.9999999, 0), 2);
    expect(inducedVelocityRatio(-3, 0)).toBeCloseTo(1.5 - Math.sqrt(1.25), 9);
  });

  it('static thrust satisfies momentum theory: T = 2 rho A v_i^2', () => {
    const d = deriveParams(five);
    const r = new Rotor(five, d);
    const rng = new Rng(1);
    for (let i = 0; i < 2 * SIM_HZ; i++) r.update(SIM_DT, 1.225, 0.6, 24, true, 0, 0, 0, 1, rng);
    expect(r.thrust).toBeGreaterThan(5);
    expect(2 * 1.225 * d.discArea * r.vi * r.vi).toBeCloseTo(r.thrust, 1);
  });

  it('full-throttle bench figures match thrust-stand data for the motor/prop class', () => {
    const d = deriveParams(five);
    const r = new Rotor(five, d);
    const rng = new Rng(1);
    for (let i = 0; i < 2 * SIM_HZ; i++) r.update(SIM_DT, 1.225, 1, 24, true, 0, 0, 0, 1, rng);
    const grams = (r.thrust / GRAVITY) * 1000;
    expect(grams).toBeGreaterThan(1450);
    expect(grams).toBeLessThan(1800);
    expect(r.rpm).toBeGreaterThan(25500);
    expect(r.rpm).toBeLessThan(29500);
    const amps = r.busPower / 24;
    expect(amps).toBeGreaterThan(33);
    expect(amps).toBeLessThan(45);
    // loaded speed is well below KV * V
    expect(r.rpm / (five.motor.kv * 24)).toBeLessThan(0.72);
  });

  it('thrust falls with axial inflow and vanishes near pitch speed', () => {
    const d = deriveParams(five);
    const rng = new Rng(1);
    const thrustAt = (v: number) => {
      const r = new Rotor(five, d);
      for (let i = 0; i < 2 * SIM_HZ; i++) r.update(SIM_DT, 1.225, 1, 24, true, 0, v, 0, 1, rng);
      return r;
    };
    const t0 = thrustAt(0).thrust, t20 = thrustAt(20).thrust, t40 = thrustAt(40).thrust;
    expect(t20).toBeLessThan(t0 * 0.85);
    expect(t40).toBeLessThan(t20 * 0.7);
    // prop unloads: rpm rises with airspeed
    expect(thrustAt(40).rpm).toBeGreaterThan(thrustAt(0).rpm);
    // far beyond pitch speed the prop windmills and drags
    expect(thrustAt(90).thrust).toBeLessThan(0);
  });

  it('translational lift: same rpm, more thrust in edgewise flow', () => {
    const d = deriveParams(five);
    const rng = new Rng(1);
    const run = (vx: number) => {
      const r = new Rotor(five, d);
      for (let i = 0; i < 2 * SIM_HZ; i++) {
        r.omega = 900; // hold speed
        r.update(SIM_DT, 1.225, 0.2, 24, true, vx, 0, 0, 1, rng);
      }
      return r;
    };
    const hover = run(0), fwd = run(12);
    expect(fwd.thrust).toBeGreaterThan(hover.thrust * 1.1);
    expect(fwd.vi).toBeLessThan(hover.vi * 0.8);
    // and an in-plane drag force opposing the motion
    expect(fwd.hx).toBeLessThan(0);
  });

  it('ground effect raises thrust at constant rpm', () => {
    const d = deriveParams(five);
    const rng = new Rng(1);
    const run = (ge: number) => {
      const r = new Rotor(five, d);
      for (let i = 0; i < 2 * SIM_HZ; i++) {
        r.omega = 900;
        r.update(SIM_DT, 1.225, 0.2, 24, true, 0, 0, 0, ge, rng);
      }
      return r.thrust;
    };
    expect(run(0.85)).toBeGreaterThan(run(1) * 1.03);
  });

  it('descending into its own wake triggers vortex ring state', () => {
    const d = deriveParams(five);
    const rng = new Rng(3);
    const r = new Rotor(five, d);
    let min = Infinity, max = -Infinity, vrs = 0;
    for (let i = 0; i < 4 * SIM_HZ; i++) {
      r.omega = 900;
      r.update(SIM_DT, 1.225, 0.2, 24, true, 0, -7, 0, 1, rng);
      if (i > SIM_HZ) {
        min = Math.min(min, r.thrust);
        max = Math.max(max, r.thrust);
        vrs = Math.max(vrs, r.vrs);
      }
    }
    expect(vrs).toBeGreaterThan(0.6);
    expect((max - min) / max).toBeGreaterThan(0.15); // unsteady thrust
    // but with strong edgewise flow the wake is flushed away
    const r2 = new Rotor(five, d);
    for (let i = 0; i < SIM_HZ; i++) {
      r2.omega = 900;
      r2.update(SIM_DT, 1.225, 0.2, 24, true, 14, -7, 0, 1, rng);
    }
    expect(r2.vrs).toBe(0);
  });

  it('induced velocity is continuous between climb and descent at any edgewise speed', () => {
    for (const mu of [0, 0.2, 0.35, 0.5, 0.7, 1, 1.5, 3]) {
      const up = inducedVelocityRatio(1e-7, mu), down = inducedVelocityRatio(-1e-7, mu);
      expect(Math.abs(up - down)).toBeLessThan(1e-4);
    }
    // and varies smoothly through slow descent
    for (const mu of [0, 0.35, 0.7]) {
      let prev = inducedVelocityRatio(0.05, mu);
      for (let lc = 0.04; lc > -0.6; lc -= 0.01) {
        const nu = inducedVelocityRatio(lc, mu);
        expect(Math.abs(nu - prev)).toBeLessThan(0.03);
        prev = nu;
      }
    }
  });

  it('electrical power balance: bus power = duty x V x I; a shorted motor returns nothing to the pack', () => {
    const d = deriveParams(five);
    const rng = new Rng(1);
    const r = new Rotor(five, d);
    for (let i = 0; i < 2 * SIM_HZ; i++) r.update(SIM_DT, 1.225, 0.6, 24, true, 0, 0, 0, 1, rng);
    // steady state, not current limited: input power is duty * V * I (plus the small switching loss)
    const sw = five.motor.pwmLoss * 24 * 24 * 0.6 * 0.4;
    expect(r.busPower - sw).toBeCloseTo(0.6 * 24 * r.current, 6);
    // all of it is accounted for: shaft work + winding heat
    const shaft = r.shaftTorque * r.omega;
    const heat = r.impedance() * r.current * r.current;
    const iron = r.backEmf() * r.current - shaft; // loss torque times speed
    expect(shaft + heat + iron + sw).toBeCloseTo(r.busPower, 6);
    expect(shaft / r.busPower).toBeGreaterThan(0.5);
    expect(shaft / r.busPower).toBeLessThan(0.8);

    // chop the throttle to zero duty: strong braking, but no energy flows back to the bus
    const w0 = r.omega;
    r.update(SIM_DT, 1.225, 0, 24, true, 0, 0, 0, 1, rng);
    expect(r.current).toBeLessThan(-60); // more than the drive limit: nothing limits a shorted winding but its impedance
    expect(Math.abs(r.busPower)).toBeLessThan(1e-6);
    for (let i = 0; i < 0.03 * SIM_HZ; i++) r.update(SIM_DT, 1.225, 0, 24, true, 0, 0, 0, 1, rng);
    expect(r.omega).toBeLessThan(0.6 * w0);
  });

  it('active braking: a spinning motor commanded low slows much faster than coasting', () => {
    const d = deriveParams(five);
    const rng = new Rng(1);
    const spinDown = (driven: boolean) => {
      const r = new Rotor(five, d);
      for (let i = 0; i < SIM_HZ; i++) r.update(SIM_DT, 1.225, 0.8, 24, true, 0, 0, 0, 1, rng);
      const w0 = r.omega;
      for (let i = 0; i < 0.05 * SIM_HZ; i++) r.update(SIM_DT, 1.225, 0.06, 24, driven, 0, 0, 0, 1, rng);
      return r.omega / w0;
    };
    expect(spinDown(true)).toBeLessThan(spinDown(false) * 0.8);
  });
});

describe('battery', () => {
  it('open-circuit voltage is monotonic in state of charge', () => {
    let prev = 0;
    for (let s = 0; s <= 1.0001; s += 0.01) {
      const v = cellOcv(s);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(cellOcv(1)).toBeCloseTo(4.2, 6);
  });

  it('counts coulombs and sags under load', () => {
    const b = new Battery(five.battery);
    const v0 = b.ocv();
    for (let i = 0; i < 36 * SIM_HZ; i++) b.step(65, v0, SIM_DT); // 65 A for 36 s = 650 mAh
    expect(b.usedAh).toBeCloseTo(0.65, 4);
    expect(b.soc).toBeCloseTo(0.5, 3);
    expect(b.vrc).toBeGreaterThan(0.3);
    expect(b.emf()).toBeLessThan(v0);
  });
});

describe('environment', () => {
  it('ISA sea-level density and log wind profile', () => {
    const e = new Environment({ ...CALM, windSpeed: 6 });
    expect(e.rho).toBeCloseTo(1.225, 2);
    expect(e.meanSpeedAt(10)).toBeCloseTo(6, 6);
    expect(e.meanSpeedAt(2)).toBeLessThan(e.meanSpeedAt(10));
    expect(e.meanSpeedAt(40)).toBeGreaterThan(e.meanSpeedAt(10));
    expect(e.meanSpeedAt(0)).toBe(0);
    const hot = new Environment({ ...CALM, temperatureC: 35, elevation: 1500 });
    expect(hot.rho).toBeLessThan(1.0);
  });

  it('wind from the west blows towards +X; gust statistics follow the Dryden intensities', () => {
    const e = new Environment({ ...CALM, windSpeed: 8, windFrom: 270, turbulence: 1 });
    const w = vec3();
    let sx = 0, sxx = 0, n = 0;
    for (let i = 0; i < 120 * 400; i++) {
      e.step(w, 1 / 400, 10, 8);
      sx += w.x; sxx += w.x * w.x; n++;
    }
    const mean = sx / n, sd = Math.sqrt(sxx / n - mean * mean);
    expect(mean).toBeGreaterThan(6.5);
    expect(mean).toBeLessThan(9.5);
    expect(sd).toBeGreaterThan(0.6);
    expect(sd).toBeLessThan(2.5);
  });
});

describe('flight controller', () => {
  it('Betaflight actual rates', () => {
    const r = { center: 200, max: 800, expo: 0.5 };
    expect(actualRate(1, r)).toBeCloseTo(800, 9);
    expect(actualRate(-1, r)).toBeCloseTo(-800, 9);
    expect(actualRate(0, r)).toBe(0);
    // small deflection ~ centre sensitivity
    expect(actualRate(0.1, r)).toBeCloseTo(20 + 600 * 0.1 * (0.5 * 1e-5 + 0.05), 6);
    expect(throttleCurve(0.3, 0.5, 0)).toBe(0.3);
    expect(throttleCurve(1, 0.5, 0.6)).toBeCloseTo(1, 9);
    expect(throttleCurve(0.5, 0.5, 0.6)).toBeCloseTo(0.5, 9);
  });

  it('refuses to arm with throttle raised or when tipped over', () => {
    const sim = new Simulation(five, CALM, flatWorld());
    sim.rc.throttle = 0.5;
    expect(sim.arm()).toBe(false);
    expect(sim.armBlock).toBe('THROTTLE');
    sim.rc.throttle = 0;
    expect(sim.arm()).toBe(true);
  });

  it('stick directions: roll right, pitch forward, yaw right', () => {
    const att = { heading: 0, pitch: 0, roll: 0 };
    let sim = airborne('acro');
    sim.rc.throttle = 0.2;
    sim.rc.roll = 0.3;
    sim.run(0.25 * SIM_HZ);
    attitudeFromQuat(sim.drone.q, att);
    expect(att.roll).toBeGreaterThan(0.1);
    expect(sim.drone.vel.x).toBeGreaterThan(0); // drifts right

    sim = airborne('acro');
    sim.rc.throttle = 0.2;
    sim.rc.pitch = 0.3;
    sim.run(0.25 * SIM_HZ);
    attitudeFromQuat(sim.drone.q, att);
    expect(att.pitch).toBeLessThan(-0.1); // nose down
    expect(sim.drone.vel.z).toBeLessThan(0); // accelerates forward (north)

    sim = airborne('acro');
    sim.rc.throttle = 0.2;
    sim.rc.yaw = 0.3;
    sim.run(0.5 * SIM_HZ);
    attitudeFromQuat(sim.drone.q, att);
    expect(att.heading).toBeGreaterThan(0.1); // clockwise seen from above
  });

  it('tracks commanded rates: a full-stick roll is ~720 deg/s', () => {
    const sim = airborne('acro', 300);
    sim.rc.throttle = 0.25;
    sim.run(0.2 * SIM_HZ);
    sim.rc.roll = 1;
    sim.run(0.3 * SIM_HZ);
    let acc = 0;
    const n = 0.5 * SIM_HZ;
    for (let i = 0; i < n; i++) {
      sim.stepOnce();
      acc += -sim.drone.omega.z * RAD2DEG;
    }
    expect(acc / n).toBeGreaterThan(690);
    expect(acc / n).toBeLessThan(750);
  });

  it('horizon mode self-levels near centre stick but lets a full-stick flip through', () => {
    const sim = airborne('horizon', 200);
    const att = { heading: 0, pitch: 0, roll: 0 };
    sim.rc.throttle = 0.25;
    sim.rc.roll = 0.3;
    sim.run(1.0 * SIM_HZ);
    sim.rc.roll = 0;
    sim.run(1.2 * SIM_HZ);
    attitudeFromQuat(sim.drone.q, att);
    expect(Math.abs(att.roll * RAD2DEG)).toBeLessThan(3);
    sim.rc.roll = 1;
    let turned = 0;
    for (let i = 0; i < 0.6 * SIM_HZ; i++) {
      sim.stepOnce();
      turned += -sim.drone.omega.z * RAD2DEG / SIM_HZ;
    }
    expect(turned).toBeGreaterThan(300);
  });

  it('angle mode self-levels and limits bank angle', () => {
    const sim = airborne('angle');
    const att = { heading: 0, pitch: 0, roll: 0 };
    sim.rc.throttle = 0.3;
    sim.rc.roll = 1;
    sim.run(1.0 * SIM_HZ);
    attitudeFromQuat(sim.drone.q, att);
    expect(att.roll * RAD2DEG).toBeGreaterThan(50);
    expect(att.roll * RAD2DEG).toBeLessThan(58);
    sim.rc.roll = 0;
    sim.run(1.0 * SIM_HZ);
    attitudeFromQuat(sim.drone.q, att);
    expect(Math.abs(att.roll * RAD2DEG)).toBeLessThan(1.5);
  });
});

describe('vehicle dynamics', () => {
  it('falls at g with motors off and reaches the analytic terminal velocity', () => {
    const sim = new Simulation(five, CALM, null);
    sim.drone.reset(0, 2000, 0);
    sim.run(0.2 * SIM_HZ);
    // early: v ~ g t (drag still tiny)
    expect(-sim.drone.vel.y).toBeCloseTo(GRAVITY * 0.2, 1);
    sim.run(25 * SIM_HZ);
    const d = sim.drone.d;
    // drag area: airframe seen from below plus twelve stopped blades broadside to the flow
    const cda = five.frame.dragArea[1] + 4 * d.solidity * d.discArea * PLATE_CD;
    const vt = Math.sqrt((2 * d.mass * GRAVITY) / (sim.env.rho * cda));
    expect(-sim.drone.vel.y / vt).toBeGreaterThan(0.97);
    expect(-sim.drone.vel.y / vt).toBeLessThan(1.03);
  });

  it('torque-free tumbling conserves angular momentum and rotational energy', () => {
    const sim = new Simulation(five, CALM, null);
    sim.env.rho = 0; // vacuum
    sim.drone.reset(0, 1000, 0);
    const w = sim.drone.omega;
    w.x = 6; w.y = 2; w.z = -9;
    const I = sim.drone.d.inertia;
    const L = () => {
      const l = qRotate(vec3(), sim.drone.q, vec3(I[0] * w.x, I[1] * w.y, I[2] * w.z));
      return l;
    };
    const E = () => 0.5 * (I[0] * w.x * w.x + I[1] * w.y * w.y + I[2] * w.z * w.z);
    const l0 = L(), e0 = E();
    sim.run(2 * SIM_HZ);
    const l1 = L();
    expect(l1.x).toBeCloseTo(l0.x, 4);
    expect(l1.y).toBeCloseTo(l0.y, 4);
    expect(l1.z).toBeCloseTo(l0.z, 4);
    expect(E() / e0).toBeCloseTo(1, 2);
    // and the fall is exactly ballistic
    expect(sim.drone.pos.y).toBeCloseTo(1000 - 0.5 * GRAVITY * 4, 1);
  });

  it('body + rotors: total angular momentum is conserved while spinning rotors coast down', () => {
    // In vacuum with the ESCs off, the only torques are internal (bearing / iron
    // drag between rotor and stator), so momentum can only move between the
    // rotors and the airframe. This exercises the gyroscopic coupling term and
    // the sign of the motor reaction torque together.
    const sim = new Simulation(five, CALM, null);
    sim.env.rho = 0;
    sim.drone.reset(0, 1000, 0);
    const d = sim.drone;
    d.omega.x = 5; d.omega.y = -3; d.omega.z = 8;
    [1500, 2600, 900, 2000].forEach((w, i) => { d.rotors[i].omega = w; });
    const L = () => {
      const I = d.d.inertia;
      let h = 0;
      for (let i = 0; i < 4; i++) h += d.d.rotorSpin[i] * d.d.rotorInertia * d.rotors[i].omega;
      return qRotate(vec3(), d.q, vec3(I[0] * d.omega.x, I[1] * d.omega.y + h, I[2] * d.omega.z));
    };
    const l0 = L();
    const mag = Math.hypot(l0.x, l0.y, l0.z);
    sim.run(4 * SIM_HZ);
    for (const r of d.rotors) expect(Math.abs(r.omega)).toBeLessThan(1); // they have stopped
    const l1 = L();
    expect(Math.hypot(l1.x - l0.x, l1.y - l0.y, l1.z - l0.z) / mag).toBeLessThan(5e-3);
  });

  it('hovers at a realistic throttle with thrust equal to weight', () => {
    const sim = airborne('angle', 50);
    holdAltitude(sim, 50, 8);
    const dr = sim.drone;
    expect(Math.abs(dr.vel.y)).toBeLessThan(0.05);
    expect(dr.totalThrust).toBeCloseTo(dr.d.mass * GRAVITY, 1);
    expect(sim.fc.throttle).toBeGreaterThan(0.1);
    expect(sim.fc.throttle).toBeLessThan(0.3);
    expect(dr.packCurrent).toBeGreaterThan(3);
    expect(dr.packCurrent).toBeLessThan(9);
    // all four rotors share the load
    for (const r of dr.rotors) expect(r.thrust).toBeCloseTo(dr.totalThrust / 4, 1);
  });

  it('every preset hovers, and heavier builds need more throttle', () => {
    const thr: Record<string, number> = {};
    for (const p of DRONE_PRESETS) {
      const sim = airborne('angle', 50, p);
      holdAltitude(sim, 50, 8);
      expect(Math.abs(sim.drone.vel.y)).toBeLessThan(0.1);
      thr[p.id] = sim.fc.throttle;
    }
    expect(thr.freestyle5cam).toBeGreaterThan(thr.freestyle5);
    expect(thr.race5).toBeLessThan(thr.freestyle5);
  });

  it('punch-out sags the battery and pulls several g', () => {
    const sim = airborne('angle', 50);
    holdAltitude(sim, 50, 3);
    const v0 = sim.drone.vbus;
    sim.rc.throttle = 1;
    let maxG = 0, minV = 100;
    for (let i = 0; i < 1.5 * SIM_HZ; i++) {
      sim.stepOnce();
      maxG = Math.max(maxG, sim.gLoad);
      minV = Math.min(minV, sim.drone.vbus);
    }
    expect(maxG).toBeGreaterThan(5);
    expect(maxG).toBeLessThan(12);
    expect(v0 - minV).toBeGreaterThan(2);
    expect(minV).toBeGreaterThan(17);
    expect(sim.drone.vel.y).toBeGreaterThan(20);
  });

  it('gyroscopic and reaction torques: yaw authority comes from differential rotor torque', () => {
    const sim = airborne('acro', 100);
    sim.rc.throttle = 0.25;
    sim.run(0.3 * SIM_HZ);
    sim.rc.yaw = 1;
    sim.run(0.4 * SIM_HZ);
    const dr = sim.drone;
    // yaw right = CCW rotors (FR, RL) faster
    expect(dr.rotors[1].omega).toBeGreaterThan(dr.rotors[0].omega);
    expect(dr.rotors[2].omega).toBeGreaterThan(dr.rotors[3].omega);
    expect(-dr.omega.y * RAD2DEG).toBeGreaterThan(400);
  });

  it('is deterministic', () => {
    const run = () => {
      const sim = new Simulation(five, { ...CALM, windSpeed: 5, turbulence: 1 }, flatWorld());
      sim.arm();
      sim.rc.throttle = 0.4;
      sim.rc.pitch = 0.2;
      sim.rc.roll = -0.1;
      sim.run(2 * SIM_HZ);
      return [sim.drone.pos.x, sim.drone.pos.y, sim.drone.pos.z, sim.drone.q.w];
    };
    expect(run()).toEqual(run());
  });
});

describe('flight behaviour', () => {
  it('acro: a full-stick flip takes about half a second and the quad keeps the attitude it is left in', () => {
    const sim = airborne('acro', 200);
    sim.rc.throttle = 0.17;
    sim.run(1 * SIM_HZ);
    sim.rc.roll = 1;
    let ang = 0, t = 0;
    while (ang < 360 && t < 2) {
      sim.stepOnce();
      ang += -sim.drone.omega.z * RAD2DEG * SIM_DT;
      t += SIM_DT;
    }
    expect(t).toBeGreaterThan(0.45);
    expect(t).toBeLessThan(0.7);
    sim.rc.roll = 0;
    sim.run(0.5 * SIM_HZ);
    const a1 = attitudeFromQuat(sim.drone.q, { heading: 0, pitch: 0, roll: 0 }).roll;
    sim.run(0.5 * SIM_HZ);
    const a2 = attitudeFromQuat(sim.drone.q, { heading: 0, pitch: 0, roll: 0 }).roll;
    expect(Math.abs(a2 - a1) * RAD2DEG).toBeLessThan(2); // no self-levelling
  });

  it('prop wash: descending through its own wake makes the quad wobble', () => {
    const wobble = (throttle: number) => {
      const sim = airborne('acro', 400);
      sim.fc.gyroNoise = 0;
      sim.rc.throttle = 0.17;
      sim.run(1 * SIM_HZ);
      sim.rc.throttle = throttle;
      let acc = 0, n = 0, vrs = 0;
      for (let i = 0; i < 6 * SIM_HZ; i++) {
        sim.stepOnce();
        if (i > 2 * SIM_HZ) {
          acc += sim.drone.omega.x ** 2 + sim.drone.omega.z ** 2;
          n++;
          vrs = Math.max(vrs, sim.drone.rotors[0].vrs);
        }
      }
      return { rms: Math.sqrt(acc / n) * RAD2DEG, vrs };
    };
    const hover = wobble(0.17), sink = wobble(0.12);
    expect(hover.vrs).toBe(0);
    expect(hover.rms).toBeLessThan(0.5);
    expect(sink.vrs).toBeGreaterThan(0.8);
    expect(sink.rms).toBeGreaterThan(5);
    expect(sink.rms).toBeLessThan(40);
  });

  it('levelling out at speed balloons upwards (translational lift)', () => {
    const sim = airborne('angle', 100);
    holdAltitude(sim, 100, 3);
    const thr = sim.rc.throttle;
    sim.drone.vel.z = -22; // 80 km/h, level attitude, hover throttle
    sim.rc.throttle = thr;
    sim.run(1 * SIM_HZ);
    expect(sim.drone.vel.y).toBeGreaterThan(2);
  });

  it('flies upwind slower than downwind and drifts with the wind when hovering', () => {
    const sim = new Simulation(five, { ...CALM, windSpeed: 8, windFrom: 0 }, null); // from the north: blows towards +Z
    sim.damage = false;
    sim.drone.reset(0, 30, 0);
    sim.fc.cfg.mode = 'angle';
    sim.arm();
    holdAltitude(sim, 30, 4);
    expect(sim.drone.vel.z).toBeGreaterThan(3);
    expect(Math.abs(sim.drone.vel.x)).toBeLessThan(0.5);
  });

  it('thin air needs more throttle to hover', () => {
    const thr = (env: typeof CALM) => {
      const sim = new Simulation(five, env, null);
      sim.drone.reset(0, 50, 0);
      sim.fc.cfg.mode = 'angle';
      sim.arm();
      holdAltitude(sim, 50, 8);
      return sim.fc.throttle;
    };
    expect(thr({ ...CALM, elevation: 2500, temperatureC: 30 })).toBeGreaterThan(thr(CALM) * 1.08);
  });

  it('a pack lasts a few minutes of hard flying and then cannot hold altitude', () => {
    const sim = airborne('angle', 100);
    let t = 0, integ = 0, lowAt = -1;
    while (t < 600 && sim.drone.battery.soc > 0.03) {
      const err = 100 - sim.drone.pos.y;
      integ = Math.max(-5, Math.min(5, integ + err * SIM_DT));
      sim.rc.throttle = Math.min(1, Math.max(0, 0.3 + 0.05 * err - 0.05 * sim.drone.vel.y + 0.03 * integ));
      sim.rc.pitch = 0.8;
      sim.stepOnce();
      t += SIM_DT;
      if (lowAt < 0 && sim.drone.vbus / 6 < 3.5) lowAt = t;
    }
    expect(lowAt).toBeGreaterThan(90);
    expect(lowAt).toBeLessThan(240);
    expect(sim.drone.battery.usedAh).toBeGreaterThan(1.2);
    expect(sim.drone.battery.usedAh).toBeLessThanOrEqual(1.3 + 1e-6);
  });

  it('turtle mode flips an inverted quad back onto its feet', () => {
    const sim = new Simulation(five, CALM, flatWorld());
    sim.drone.reset(0, 0.3, 0, qFromHeadingPitchRoll(quat(), 0, 0, Math.PI));
    sim.run(1.5 * SIM_HZ);
    expect(sim.arm()).toBe(false);
    expect(sim.armBlock).toBe('ANGLE');
    sim.fc.turtle = true;
    expect(sim.arm()).toBe(true);
    sim.rc.roll = 1;
    for (let i = 0; i < 3 * SIM_HZ; i++) {
      sim.stepOnce();
      const upY = 1 - 2 * (sim.drone.q.x ** 2 + sim.drone.q.z ** 2);
      if (upY > -0.3) sim.rc.roll = 0;
    }
    const upY = 1 - 2 * (sim.drone.q.x ** 2 + sim.drone.q.z ** 2);
    expect(upY).toBeGreaterThan(0.98);
  });

  it('survives five minutes of random stick inputs in the real map without numerical trouble', () => {
    const map = buildMap();
    const sim = new Simulation(five, { ...DEFAULT_ENV, windSpeed: 6, turbulence: 1.5 }, map.collision);
    const rng = new Rng(7);
    let maxV = 0;
    for (let k = 0; k < 600; k++) {
      if (sim.crashed || k % 60 === 0) { sim.reset(); sim.rc.throttle = 0; sim.arm(); }
      sim.fc.cfg.mode = k % 3 === 0 ? 'angle' : 'acro';
      sim.rc.throttle = rng.next() * 0.8;
      sim.rc.roll = rng.range(-1, 1); sim.rc.pitch = rng.range(-1, 1); sim.rc.yaw = rng.range(-1, 1);
      sim.run(0.5 * SIM_HZ);
      const d = sim.drone;
      const v = Math.hypot(d.vel.x, d.vel.y, d.vel.z);
      expect(Number.isFinite(v)).toBe(true);
      expect(Number.isFinite(d.q.w)).toBe(true);
      expect(d.pos.y).toBeGreaterThan(-1);
      maxV = Math.max(maxV, v);
    }
    expect(maxV).toBeLessThan(70);
  });
});

describe('ground and collisions', () => {
  it('sits still on the ground when disarmed', () => {
    const sim = new Simulation(five, CALM, flatWorld());
    sim.run(3 * SIM_HZ);
    const dr = sim.drone;
    expect(Math.hypot(dr.vel.x, dr.vel.y, dr.vel.z)).toBeLessThan(1e-3);
    expect(dr.pos.y).toBeCloseTo(dr.restHeight, 2);
    expect(Math.hypot(dr.pos.x, dr.pos.z)).toBeLessThan(1e-3);
    const att = attitudeFromQuat(dr.q, { heading: 0, pitch: 0, roll: 0 });
    expect(Math.abs(att.roll)).toBeLessThan(0.01);
    expect(Math.abs(att.pitch)).toBeLessThan(0.01);
    expect(dr.contacts).toBeGreaterThanOrEqual(4);
  });

  it('idles on the ground when armed without creeping or flipping', () => {
    const sim = new Simulation(five, CALM, flatWorld());
    sim.arm();
    sim.run(3 * SIM_HZ);
    const dr = sim.drone;
    expect(dr.pos.y).toBeLessThan(dr.restHeight + 0.01);
    expect(Math.hypot(dr.pos.x, dr.pos.z)).toBeLessThan(0.05);
    expect(dr.rotors[0].rpm).toBeGreaterThan(1500);
    expect(dr.rotors[0].rpm).toBeLessThan(4500);
  });

  it('takes off and climbs when throttle is raised', () => {
    const sim = new Simulation(five, CALM, flatWorld());
    sim.fc.cfg.mode = 'angle';
    sim.arm();
    sim.rc.throttle = 0.3;
    sim.run(1.5 * SIM_HZ);
    expect(sim.drone.pos.y).toBeGreaterThan(1.0);
    expect(sim.drone.contacts).toBe(0);
  });

  it('a 1 m drop bounces a little and comes to rest upright', () => {
    const sim = new Simulation(five, CALM, flatWorld());
    sim.drone.reset(0, 1 + sim.drone.restHeight, 0);
    let maxImpact = 0;
    for (let i = 0; i < 3 * SIM_HZ; i++) {
      sim.stepOnce();
      maxImpact = Math.max(maxImpact, sim.drone.impactSpeed);
    }
    expect(maxImpact).toBeGreaterThan(4.0);
    expect(maxImpact).toBeLessThan(4.6); // sqrt(2 g h) = 4.43 m/s
    expect(sim.crashed).toBe(false);
    expect(sim.drone.pos.y).toBeCloseTo(sim.drone.restHeight, 2);
    expect(Math.abs(sim.drone.vel.y)).toBeLessThan(0.01);
  });

  it('hitting a wall at speed is a crash and the wall is not tunnelled', () => {
    const world = flatWorld();
    world.addBox(0, 40, -30, 40, 80, 0.3);
    const sim = new Simulation(five, CALM, world);
    sim.drone.reset(0, 4, 0);
    sim.fc.cfg.mode = 'angle';
    sim.arm();
    sim.drone.vel.z = -25;
    sim.rc.throttle = 0.25;
    let crashed = false;
    sim.onEvent = (e) => { if (e === 'crash') crashed = true; };
    let minZ = 0;
    for (let i = 0; i < 3 * SIM_HZ; i++) {
      sim.stepOnce();
      minZ = Math.min(minZ, sim.drone.pos.z);
    }
    expect(crashed).toBe(true);
    expect(sim.crashed).toBe(true);
    expect(sim.fc.armed).toBe(false);
    expect(minZ).toBeGreaterThan(-29.9);
    expect(sim.arm()).toBe(false);
    sim.reset();
    sim.rc.throttle = 0;
    expect(sim.crashed).toBe(false);
    expect(sim.arm()).toBe(true);
  });

  it('a prop that clips a post is braked and chipped, and the quad is knocked off course', () => {
    const world = flatWorld();
    world.addCylinder(0.085, 0, -6, 0.03, 10); // post in the path of the front-right prop
    const sim = new Simulation(five, CALM, world);
    sim.drone.reset(0, 3, 0);
    sim.fc.cfg.mode = 'acro';
    sim.arm();
    sim.rc.throttle = 0.17;
    sim.run(0.3 * SIM_HZ);
    sim.drone.vel.z = -6;
    let minRpm = Infinity, maxYawRate = 0;
    for (let i = 0; i < 1.5 * SIM_HZ; i++) {
      sim.stepOnce();
      minRpm = Math.min(minRpm, sim.drone.rotors[1].rpm);
      maxYawRate = Math.max(maxYawRate, Math.abs(sim.drone.omega.y));
    }
    expect(minRpm).toBeLessThan(4000); // hover is ~8400 rpm
    expect(sim.drone.rotors[1].health).toBeLessThan(1);
    expect(sim.drone.rotors[0].health).toBe(1);
    expect(maxYawRate * RAD2DEG).toBeGreaterThan(100);
    expect(sim.crashed).toBe(false); // 6 m/s is survivable
  });

  it('standing on its arms does not count as a prop strike', () => {
    const sim = new Simulation(five, CALM, flatWorld());
    sim.arm();
    sim.run(2 * SIM_HZ);
    for (const r of sim.drone.rotors) {
      expect(r.health).toBe(1);
      // 5.5 % idle on a full 6S pack is ~2400 rpm unloaded; nothing is rubbing the props.
      expect(r.rpm).toBeGreaterThan(2200);
      expect(r.rpm).toBeLessThan(2500);
    }
  });

  it('every airframe sits still where it is spawned (contact solver is stable for light quads too)', () => {
    for (const p of DRONE_PRESETS) {
      const sim = new Simulation(p, CALM, flatWorld());
      const e0 = sim.drone.energy();
      let maxRate = 0, maxSpeed = 0;
      for (let i = 0; i < 3 * SIM_HZ; i++) {
        sim.stepOnce();
        const d = sim.drone;
        maxRate = Math.max(maxRate, Math.hypot(d.omega.x, d.omega.y, d.omega.z));
        maxSpeed = Math.max(maxSpeed, Math.hypot(d.vel.x, d.vel.y, d.vel.z));
        // dropping 2 mm onto the ground must never add energy
        expect(d.energy()).toBeLessThan(e0 + 1e-6);
      }
      const d = sim.drone;
      expect(maxSpeed).toBeLessThan(0.25); // sqrt(2 g * 2 mm) = 0.2 m/s at touch-down
      expect(maxRate * RAD2DEG).toBeLessThan(40); // the CG is a few mm off the centre of the contact patch
      expect(Math.hypot(d.vel.x, d.vel.y, d.vel.z)).toBeLessThan(1e-3);
      expect(1 - 2 * (d.q.x * d.q.x + d.q.z * d.q.z)).toBeGreaterThan(0.9999);
      expect(d.contacts).toBe(7);
    }
  });

  it('a level drop lands flat: little bounce, little leftover spin, never more energy than it came with', () => {
    for (const [p, h] of [[five, 0.3], [five, 3], [getPreset('three4s'), 1], [getPreset('freestyle5cam'), 1]] as const) {
      const sim = new Simulation(p, CALM, flatWorld());
      sim.damage = false;
      sim.drone.reset(0, h + sim.drone.restHeight, 0);
      const e0 = sim.drone.energy();
      let airborneRate = 0, touched = false, rebound = 0;
      for (let i = 0; i < 5 * SIM_HZ; i++) {
        sim.stepOnce();
        const d = sim.drone;
        if (d.contacts > 0) touched = true;
        if (touched) {
          rebound = Math.max(rebound, d.pos.y - d.restHeight);
          // rotation the quad leaves the ground with (the impact itself is a sub-millisecond transient)
          if (d.contacts === 0) airborneRate = Math.max(airborneRate, Math.hypot(d.omega.x, d.omega.y, d.omega.z));
        }
        expect(d.energy()).toBeLessThan(e0 + 1e-6);
      }
      const d = sim.drone;
      expect(rebound).toBeLessThan(0.1 * h);
      // Heel-and-toe rocking as a slightly tilted frame touches down is real rigid-body
      // behaviour (omega ~ v / arm); it must stay of that order and die out.
      expect(airborneRate * RAD2DEG).toBeLessThan(1200);
      expect(Math.hypot(d.pos.x, d.pos.z)).toBeLessThan(0.25);
      expect(1 - 2 * (d.q.x * d.q.x + d.q.z * d.q.z)).toBeGreaterThan(0.999);
      expect(d.pos.y).toBeCloseTo(d.restHeight, 2);
      expect(Math.hypot(d.vel.x, d.vel.y, d.vel.z)).toBeLessThan(1e-3);
    }
  });

  it('sliding along the ground into a wall still counts as an impact', () => {
    const world = flatWorld();
    world.addBox(0, 2, -4, 20, 4, 0.3);
    const sim = new Simulation(five, CALM, world);
    sim.run(0.5 * SIM_HZ); // settled on the ground
    sim.drone.vel.z = -15;
    let maxImpact = 0;
    for (let i = 0; i < 2 * SIM_HZ; i++) {
      sim.stepOnce();
      maxImpact = Math.max(maxImpact, sim.drone.impactSpeed);
    }
    expect(maxImpact).toBeGreaterThan(9);
    expect(sim.crashed).toBe(true);
    expect(sim.drone.pos.z).toBeGreaterThan(-3.9);
  });

  it('friction brings a sliding quad to rest and holds it on a slope', () => {
    const sim = new Simulation(five, CALM, flatWorld());
    sim.damage = false;
    sim.run(0.5 * SIM_HZ);
    sim.drone.vel.x = 4;
    sim.run(3 * SIM_HZ);
    // v^2 / (2 mu g) = 16 / (2 * 0.65 * 9.81) = 1.25 m
    expect(sim.drone.pos.x).toBeGreaterThan(0.9);
    expect(sim.drone.pos.x).toBeLessThan(1.6);
    expect(Math.abs(sim.drone.vel.x)).toBeLessThan(1e-3);

    // 15 degree slope (tan = 0.27 < mu): must not slide away
    const slope = new CollisionWorld(new Heightfield(400, 4, (x) => 0.268 * x));
    const s2 = new Simulation(five, CALM, slope);
    s2.spawn = { x: 5, z: 5, heading: 0 };
    s2.reset();
    s2.run(4 * SIM_HZ);
    // (static friction is regularised: it holds, with a creep of a few mm/s)
    expect(Math.hypot(s2.drone.pos.x - 5, s2.drone.pos.z - 5)).toBeLessThan(0.05);
    expect(Math.hypot(s2.drone.vel.x, s2.drone.vel.y, s2.drone.vel.z)).toBeLessThan(0.01);
    expect(1 - 2 * (s2.drone.q.x ** 2 + s2.drone.q.z ** 2)).toBeCloseTo(Math.cos(Math.atan(0.268)), 2);
  });

  it('sphere queries against boxes, cylinders and spheres', () => {
    const world = flatWorld();
    world.addBox(10, 1, 0, 2, 2, 2, Math.PI / 4);
    world.addCylinder(-10, 0, 0, 0.5, 3);
    world.addSphere(0, 5, 20, 2, 'soft');
    const out: any[] = [];
    // rotated box: corner points along +X at distance sqrt(2)
    expect(world.querySphere(10 + Math.SQRT2 + 0.05, 1, 0, 0.1, out)).toBe(1);
    expect(out[0].nx).toBeCloseTo(1, 5);
    expect(out[0].depth).toBeCloseTo(0.05, 5);
    expect(world.querySphere(10 + Math.SQRT2 + 0.2, 1, 0, 0.1, out)).toBe(0);
    // cylinder side and top
    expect(world.querySphere(-9.45, 1.5, 0, 0.1, out)).toBe(1);
    expect(out[0].nx).toBeCloseTo(1, 5);
    expect(world.querySphere(-10, 3.05, 0, 0.1, out)).toBe(1);
    expect(out[0].ny).toBeCloseTo(1, 5);
    // soft sphere
    expect(world.querySphere(0, 5, 17.95, 0.1, out)).toBe(1);
    expect(out[0].surface).toBe('soft');
    expect(out[0].nz).toBeCloseTo(-1, 5);
    // ground
    expect(world.querySphere(50, 0.05, 50, 0.1, out)).toBe(1);
    expect(out[0].ground).toBe(true);
    expect(out[0].depth).toBeCloseTo(0.05, 6);
  });

  it('gate timing only counts forward passes through the opening', () => {
    const g = { x: 0, y: 1, z: -10, heading: 0, width: 2, height: 2 };
    expect(crossedGate(g, 0, 1, -9, 0, 1, -11)).toBe(true);
    expect(crossedGate(g, 0, 1, -11, 0, 1, -9)).toBe(false); // backwards
    expect(crossedGate(g, 1.5, 1, -9, 1.5, 1, -11)).toBe(false); // outside
    expect(crossedGate(g, 0, 2.5, -9, 0, 2.5, -11)).toBe(false); // above
    const east = { ...g, heading: Math.PI / 2 };
    expect(crossedGate(east, -1, 1, -10, 1, 1, -10)).toBe(true);
  });
});

describe('map', () => {
  const map = buildMap();
  it('the launch pad is clear and flat', () => {
    expect(map.terrain.heightAt(0, 0)).toBe(0);
    const out: any[] = [];
    expect(map.collision.querySphere(0, 1, 0, 0.2, out)).toBe(0);
  });
  it('every start location is on open, level ground', () => {
    const out: any[] = [];
    for (const sp of map.spawns) {
      expect(map.terrain.heightAt(sp.x, sp.z)).toBe(0);
      for (const [dx, dz] of [[0, 0], [0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4]]) {
        expect(map.collision.querySphere(sp.x + dx, 0.5, sp.z + dz, 0.24, out)).toBe(0);
      }
      // and the first few metres straight ahead are clear for take-off
      const fx = Math.sin(sp.heading), fz = -Math.cos(sp.heading);
      for (let d = 1; d <= 5; d++) expect(map.collision.querySphere(sp.x + fx * d, 1.2, sp.z + fz * d, 0.24, out)).toBe(0);
    }
  });
  it('every airframe rests quietly at every start location of the real map', () => {
    for (const p of DRONE_PRESETS) {
      for (const sp of map.spawns) {
        const sim = new Simulation(p, CALM, map.collision);
        sim.spawn = sp;
        sim.reset();
        sim.run(1.5 * SIM_HZ);
        const d = sim.drone;
        expect(Math.hypot(d.vel.x, d.vel.y, d.vel.z)).toBeLessThan(1e-3);
        expect(Math.hypot(d.pos.x - sp.x, d.pos.z - sp.z)).toBeLessThan(0.01);
        expect(1 - 2 * (d.q.x * d.q.x + d.q.z * d.q.z)).toBeGreaterThan(0.9999);
        expect(sim.arm()).toBe(true);
      }
    }
  });
  it('gate openings are unobstructed and the frames are solid', () => {
    const out: any[] = [];
    for (const g of map.gates) {
      expect(map.collision.querySphere(g.x, g.y, g.z, 0.2, out)).toBe(0);
      const rx = Math.cos(g.heading), rz = Math.sin(g.heading);
      const d = g.width / 2 + 0.07;
      expect(map.collision.querySphere(g.x + rx * d, g.y, g.z + rz * d, 0.1, out)).toBeGreaterThan(0);
    }
  });
  it('a drone can fly the lap in the simulation and laps are timed', () => {
    const sim = new Simulation(five, CALM, map.collision);
    sim.gates = map.gates;
    // teleport along the gate centres
    const pts = [...map.gates, map.gates[0]];
    let laps = 0;
    sim.onEvent = (e) => { if (e === 'lap') laps++; };
    sim.damage = false;
    for (const g of pts) {
      const fx = Math.sin(g.heading), fz = -Math.cos(g.heading);
      sim.drone.reset(g.x - fx * 0.5, g.y, g.z - fz * 0.5);
      (sim as any).prevX = sim.drone.pos.x; (sim as any).prevY = sim.drone.pos.y; (sim as any).prevZ = sim.drone.pos.z;
      sim.drone.vel.x = fx * 10; sim.drone.vel.z = fz * 10;
      sim.run(0.1 * SIM_HZ);
    }
    expect(laps).toBe(1);
    expect(sim.lap.laps).toBe(1);
  });
});
