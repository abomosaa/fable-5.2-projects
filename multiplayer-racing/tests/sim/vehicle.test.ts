import { describe, expect, it } from 'vitest';
import { SIM_HZ } from '../../shared/constants';
import { collideCars } from '../../shared/sim/collision';
import { analyseTrack, makeQuery, pointAt, queryTrack, queryTrackBrute } from '../../shared/sim/track';
import { TRACK_DEFS, getTrack } from '../../shared/sim/tracks';
import { GLACIER } from '../../shared/sim/tracks/glacier';
import { HARBOR } from '../../shared/sim/tracks/harbor';
import { Rng } from '../../shared/sim/rng';
import { VEHICLE, gearForSpeed, makeCarState, rpmForSpeed } from '../../shared/sim/vehicle';
import { input, padRig, rig } from '../helpers/sim';

const FULL = 255;

describe('vehicle dynamics', () => {
  it('accelerates from rest and settles at a bounded top speed', () => {
    const r = padRig();
    r.step(input({ throttle: FULL }), SIM_HZ * 2);
    const early = r.tel.speed;
    expect(early).toBeGreaterThan(15);
    r.step(input({ throttle: FULL }), SIM_HZ * 60);
    const top = r.tel.speed;
    expect(top).toBeGreaterThan(60);
    expect(top).toBeLessThan(VEHICLE.maxSpeed);
    // Drag has balanced the engine: no more acceleration.
    r.step(input({ throttle: FULL }), SIM_HZ);
    expect(Math.abs(r.tel.speed - top)).toBeLessThan(0.2);
  });

  it('loses speed to drag when coasting', () => {
    const r = padRig(50);
    r.step(input(), SIM_HZ * 3);
    expect(r.tel.speed).toBeLessThan(47);
    expect(r.tel.speed).toBeGreaterThan(30);
  });

  it('brakes to a standstill without rolling backwards while the brake is tapped', () => {
    const r = padRig(40);
    let ticks = 0;
    while (r.forward() > 0.6 && ticks < SIM_HZ * 10) {
      r.step(input({ brake: FULL }));
      ticks++;
    }
    expect(ticks / SIM_HZ).toBeLessThan(4.5);
    expect(ticks / SIM_HZ).toBeGreaterThan(2);
    expect(r.forward()).toBeGreaterThanOrEqual(0);
    // Releasing leaves the car at rest.
    r.step(input(), SIM_HZ);
    expect(r.tel.speed).toBe(0);
  });

  it('reverses when the brake is held from a standstill, and stops again on throttle', () => {
    const r = padRig();
    r.step(input({ brake: FULL }), SIM_HZ * 3);
    expect(r.forward()).toBeLessThan(-5);
    expect(r.forward()).toBeGreaterThan(-VEHICLE.reverseMaxSpeed - 0.5);
    r.step(input({ throttle: FULL }), SIM_HZ * 4);
    expect(r.forward()).toBeGreaterThan(5);
  });

  it('steers right for positive steering and left for negative steering', () => {
    const right = padRig(20);
    right.step(input({ steer: 127, throttle: 120 }), SIM_HZ);
    expect(right.car.yawRate).toBeLessThan(-0.2);
    const left = padRig(20);
    left.step(input({ steer: -127, throttle: 120 }), SIM_HZ);
    expect(left.car.yawRate).toBeGreaterThan(0.2);
    // Mirror symmetric.
    expect(left.car.yawRate).toBeCloseTo(-right.car.yawRate, 6);
  });

  it('responds to steering progressively instead of instantly', () => {
    const r = padRig(25);
    r.step(input({ steer: 127 }));
    expect(Math.abs(r.car.steer)).toBeLessThan(0.2);
    r.step(input({ steer: 127 }), 30);
    expect(r.car.steer).toBeCloseTo(1, 5);
    r.step(input(), 30);
    expect(r.car.steer).toBeCloseTo(0, 5);
  });

  it('corners harder on asphalt than on ice', () => {
    const lateralG = (surface: typeof HARBOR.surface): number => {
      const r = padRig(25, surface);
      let sum = 0;
      for (let i = 0; i < SIM_HZ * 4; i++) {
        r.step(input({ steer: 127, throttle: r.tel.speed < 25 ? FULL : 0 }));
        if (i >= SIM_HZ * 3) sum += (r.tel.speed * Math.abs(r.car.yawRate)) / 9.81;
      }
      return sum / SIM_HZ;
    };
    const asphalt = lateralG(HARBOR.surface);
    const ice = lateralG(GLACIER.surface);
    expect(asphalt).toBeGreaterThan(1.0);
    expect(ice).toBeLessThan(0.85);
    expect(asphalt).toBeGreaterThan(ice * 1.5);
  });

  it('needs a much longer distance to stop on ice', () => {
    const distance = (surface: typeof HARBOR.surface): number => {
      const r = padRig(30, surface);
      const x0 = r.car.x;
      const z0 = r.car.z;
      for (let i = 0; i < SIM_HZ * 10 && r.forward() > 0.6; i++) r.step(input({ brake: FULL }));
      return Math.hypot(r.car.x - x0, r.car.z - z0);
    };
    expect(distance(GLACIER.surface)).toBeGreaterThan(distance(HARBOR.surface) * 1.5);
  });

  it('stays stable (no spin) under full steering lock at speed', () => {
    const r = padRig(45);
    let maxSlip = 0;
    for (let i = 0; i < SIM_HZ * 5; i++) {
      r.step(input({ steer: 127, throttle: FULL }));
      maxSlip = Math.max(maxSlip, Math.abs(Math.atan2(r.lateral(), Math.abs(r.forward()))));
    }
    expect(maxSlip).toBeLessThan(0.3);
    expect(r.forward()).toBeGreaterThan(20);
  });

  it('loses rear traction and drifts when the handbrake is pulled in a corner', () => {
    const grip = padRig(28);
    const drift = padRig(28);
    let gripAngle = 0;
    let driftAngle = 0;
    let driftSlip = 0;
    for (let i = 0; i < SIM_HZ; i++) {
      grip.step(input({ steer: 127 }));
      drift.step(input({ steer: 127, handbrake: i < 35 }));
      gripAngle = Math.max(gripAngle, Math.abs(Math.atan2(grip.lateral(), Math.abs(grip.forward()))));
      driftAngle = Math.max(driftAngle, Math.abs(Math.atan2(drift.lateral(), Math.abs(drift.forward()))));
      driftSlip = Math.max(driftSlip, drift.tel.slip);
    }
    expect(driftAngle).toBeGreaterThan(0.3);
    expect(driftAngle).toBeGreaterThan(gripAngle * 2.5);
    expect(driftSlip).toBeGreaterThan(1);
    // Counter-steering and easing off catches the slide.
    for (let i = 0; i < SIM_HZ * 2; i++) drift.step(input({ steer: i < 25 ? -100 : 0, throttle: 120 }));
    expect(Math.abs(Math.atan2(drift.lateral(), Math.abs(drift.forward())))).toBeLessThan(0.08);
  });

  it('spins the wheels on ice under full throttle', () => {
    const ice = padRig(0, GLACIER.surface);
    ice.step(input({ throttle: FULL }), 10);
    expect(ice.tel.wheelspin).toBeGreaterThan(0.2);
    const road = padRig();
    road.step(input({ throttle: FULL }), 10);
    expect(road.tel.wheelspin).toBe(0);
  });

  it('is slowed by the run-off and reports being off the road', () => {
    const track = getTrack('harbor');
    const start = { x: 0, z: 0, yaw: 0 };
    // On the main straight: once on the road, once on the grass.
    const run = (lat: number): { speed: number; offroad: number } => {
      const r = rig(track);
      pointAt(track, 20, lat, start);
      r.car.x = start.x;
      r.car.z = start.z;
      r.car.yaw = start.yaw;
      r.step(input({ throttle: FULL }), SIM_HZ * 3);
      return { speed: r.tel.speed, offroad: r.tel.offroad };
    };
    const road = run(0);
    const grass = run(track.halfWidth + 3);
    expect(road.offroad).toBe(0);
    expect(grass.offroad).toBe(1);
    expect(grass.speed).toBeLessThan(road.speed * 0.75);
  });

  it('holds a frozen car still and counts the freeze down', () => {
    const r = padRig();
    r.car.frozen = 30;
    r.step(input({ throttle: FULL, steer: 127 }), 29);
    expect(r.tel.speed).toBe(0);
    expect(r.car.frozen).toBe(1);
    r.step(input({ throttle: FULL }), 31);
    expect(r.car.frozen).toBe(0);
    expect(r.tel.speed).toBeGreaterThan(1);
  });

  it('cuts engine power while a penalty is being served', () => {
    const clean = padRig();
    const penalised = padRig();
    penalised.car.penalty = SIM_HZ * 2;
    clean.step(input({ throttle: FULL }), SIM_HZ * 2);
    penalised.step(input({ throttle: FULL }), SIM_HZ * 2);
    expect(penalised.tel.speed).toBeLessThan(clean.tel.speed * 0.6);
    expect(penalised.car.penalty).toBe(0);
  });

  it('never lets a car through the barriers, however hard it hits them', () => {
    for (const def of TRACK_DEFS) {
      const track = getTrack(def.id);
      const q = makeQuery();
      const rng = new Rng(7);
      for (let trial = 0; trial < 12; trial++) {
        const r = rig(track);
        const spot = { x: 0, z: 0, yaw: 0 };
        pointAt(track, rng.range(0, track.length), rng.range(-2, 2), spot);
        r.car.x = spot.x;
        r.car.z = spot.z;
        // Aim across the track at a random angle and floor it.
        r.car.yaw = spot.yaw + rng.range(0.5, 2.6) * (trial % 2 === 0 ? 1 : -1);
        let hit = 0;
        for (let i = 0; i < SIM_HZ * 6; i++) {
          r.step(input({ throttle: FULL, steer: Math.round(rng.range(-127, 127)) }));
          hit = Math.max(hit, r.tel.wallHit);
          const d = queryTrackBrute(track, r.car.x, r.car.z, q).dist;
          expect(d).toBeLessThanOrEqual(track.wallDist + 1e-6);
          expect(Number.isFinite(r.car.x + r.car.z + r.car.yaw + r.car.vx + r.car.vz + r.car.yawRate)).toBe(true);
        }
        expect(hit).toBeGreaterThan(0);
      }
    }
  });

  it('bounces off a barrier rather than sticking to it', () => {
    const track = getTrack('harbor');
    const r = rig(track, 0);
    const spot = { x: 0, z: 0, yaw: 0 };
    pointAt(track, 60, 0, spot);
    r.car.x = spot.x;
    r.car.z = spot.z;
    r.car.yaw = spot.yaw + 0.5;
    r.car.vx = Math.sin(r.car.yaw) * 30;
    r.car.vz = Math.cos(r.car.yaw) * 30;
    let impact = 0;
    for (let i = 0; i < SIM_HZ * 2; i++) {
      r.step(input({ throttle: 100 }));
      impact = Math.max(impact, r.tel.wallHit);
    }
    expect(impact).toBeGreaterThan(5);
    // A glancing hit keeps most of the car's speed and turns it along the wall.
    expect(r.tel.speed).toBeGreaterThan(8);
  });

  it('is deterministic: identical inputs give bit-identical states', () => {
    const run = (): number[] => {
      const r = rig(getTrack('glacier'), 10);
      const rng = new Rng(99);
      for (let i = 0; i < SIM_HZ * 30; i++) {
        r.step(
          input({
            steer: Math.round(rng.range(-127, 127)),
            throttle: Math.round(rng.range(0, 255)),
            brake: rng.next() < 0.1 ? 200 : 0,
            handbrake: rng.next() < 0.05,
          }),
        );
      }
      return [r.car.x, r.car.z, r.car.yaw, r.car.vx, r.car.vz, r.car.yawRate, r.car.steer];
    };
    expect(run()).toEqual(run());
  });

  it('maps speed to a sensible gear and engine speed', () => {
    expect(gearForSpeed(-3, 1)).toBe(-1);
    expect(gearForSpeed(0, 3)).toBe(1);
    let gear = 1;
    const seen = new Set<number>();
    for (let v = 0; v < 75; v += 0.5) {
      gear = gearForSpeed(v, gear);
      seen.add(gear);
      const rpm = rpmForSpeed(v, gear);
      expect(rpm).toBeGreaterThanOrEqual(0.12);
      expect(rpm).toBeLessThanOrEqual(1);
    }
    expect(seen.size).toBeGreaterThanOrEqual(5);
  });
});

describe('car-to-car collisions', () => {
  it('separates overlapping cars and exchanges momentum', () => {
    const a = makeCarState(0, 0, 0);
    const b = makeCarState(0, 4.2, 0);
    a.vz = 20; // a drives into the back of b
    const impact = collideCars(a, b, true, true);
    expect(impact).toBeCloseTo(20, 5);
    expect(a.vz).toBeLessThan(20);
    expect(b.vz).toBeGreaterThan(0);
    // Momentum along the line of impact is conserved.
    expect(a.vz + b.vz).toBeCloseTo(20, 6);
    expect(b.z - a.z).toBeGreaterThan(4.2);
  });

  it('reports no contact for distant cars', () => {
    expect(collideCars(makeCarState(0, 0, 0), makeCarState(0, 30, 0), true, true)).toBe(-1);
  });

  it('gives the local car the same response when predicted against a fixed proxy', () => {
    const a1 = makeCarState(0.3, 0, 0.1);
    const b1 = makeCarState(0, 4.0, -0.05);
    a1.vz = 18;
    b1.vz = 9;
    const a2 = { ...a1 };
    const b2 = { ...b1 };
    collideCars(a1, b1, true, true);
    collideCars(a2, b2, true, false);
    expect(a2).toEqual(a1);
    expect(b2.vz).toBe(9);
  });
});

describe('tracks', () => {
  it('provides at least two complete tracks', () => {
    expect(TRACK_DEFS.length).toBeGreaterThanOrEqual(2);
  });

  for (const def of TRACK_DEFS) {
    describe(def.name, () => {
      const track = getTrack(def.id);
      const report = analyseTrack(track);

      it('is a closed loop with drivable geometry', () => {
        expect(report.length).toBeGreaterThan(800);
        // Corners are wider than the barrier offset, so the walls never fold over.
        expect(report.minRadius).toBeGreaterThan(track.wallDist);
        // Different parts of the circuit never share a corridor.
        expect(report.minSeparation).toBeGreaterThan(track.wallDist * 2 + 4);
        // Room for the whole grid on the approach to the line.
        expect(report.startStraight).toBeGreaterThan(40);
      });

      it('has ordered checkpoint gates spanning the whole corridor', () => {
        expect(track.gates.length).toBe(def.checkpoints);
        expect(track.gates[0]!.s).toBe(0);
        for (let i = 1; i < track.gates.length; i++) expect(track.gates[i]!.s).toBeGreaterThan(track.gates[i - 1]!.s);
        const q = makeQuery();
        for (const gate of track.gates) {
          const width = Math.hypot(gate.ax - gate.bx, gate.az - gate.bz);
          expect(width).toBeGreaterThan(track.wallDist * 2);
          // Both ends belong to this stretch of road, not to a neighbouring one.
          for (const [x, z] of [
            [gate.ax, gate.az],
            [gate.bx, gate.bz],
          ] as const) {
            const hit = queryTrackBrute(track, x, z, q);
            const along = Math.min(Math.abs(hit.s - gate.s), track.length - Math.abs(hit.s - gate.s));
            expect(along).toBeLessThan(6);
          }
        }
      });

      it('has a start grid on the road behind the line with room between cars', () => {
        const q = makeQuery();
        expect(track.grid.length).toBe(8);
        track.grid.forEach((slot, i) => {
          const hit = queryTrack(track, slot.x, slot.z, q);
          expect(Math.abs(hit.lat)).toBeLessThan(track.halfWidth - 1);
          expect(hit.s).toBeGreaterThan(track.length / 2); // behind the line
          for (let j = i + 1; j < track.grid.length; j++) {
            const other = track.grid[j]!;
            expect(Math.hypot(slot.x - other.x, slot.z - other.z)).toBeGreaterThan(4.4);
          }
        });
      });

      it('answers position queries exactly like an exhaustive search', () => {
        const rng = new Rng(3);
        const fast = makeQuery();
        const slow = makeQuery();
        const spot = { x: 0, z: 0, yaw: 0 };
        for (let i = 0; i < 400; i++) {
          const s = rng.range(0, track.length);
          const lat = rng.range(-track.wallDist - 3, track.wallDist + 3);
          pointAt(track, s, lat, spot);
          queryTrack(track, spot.x, spot.z, fast);
          queryTrackBrute(track, spot.x, spot.z, slow);
          expect(fast.seg).toBe(slow.seg);
          expect(fast.dist).toBe(slow.dist);
          expect(Math.abs(Math.abs(fast.lat) - Math.abs(lat))).toBeLessThan(0.6);
        }
      });
    });
  }

  it('makes the two tracks mechanically different', () => {
    expect(HARBOR.surface.grip).toBeGreaterThan(GLACIER.surface.grip * 1.5);
    expect(HARBOR.halfWidth).toBeGreaterThan(GLACIER.halfWidth);
    expect(HARBOR.runoff).toBeGreaterThan(GLACIER.runoff * 2);
    expect(GLACIER.surface.wallRestitution).toBeLessThan(HARBOR.surface.wallRestitution);
  });
});
