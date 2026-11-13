/**
 * Solver verification against analytic references. Tolerances are stated in
 * each test and repeated in docs/VERIFICATION.md.
 */
import { describe, expect, it } from 'vitest';
import { Builder, GROUND } from '../src/core/model/builder';
import { compile } from '../src/core/assembly/compile';
import { Simulation } from '../src/core/sim/solver';
import { SimRunner } from '../src/core/sim/runner';
import { solveAssembly } from '../src/core/assembly/solve';
import * as ops from '../src/core/model/ops';
import { camLift } from '../src/core/parts/profiles';
import { defaultParams } from '../src/core/parts/catalog';
import { G_STANDARD, RPM, DEG } from '../src/core/units';
import { findFourBars } from '../src/core/sim/diagnose';
import { createProject } from '../src/core/model/project';

const g = G_STANDARD;

function pendulum(theta0: number, extra: (b: Builder, link: string, joint: string) => void = () => {}) {
  const b = new Builder('pendulum', 't');
  const link = b.part('link', 'Pendulum', { length: 200, width: 10, thickness: 4, holeDiameter: 0 }, { angle: -Math.PI / 2 + theta0 });
  const j = b.revolute(GROUND, { x: 0, y: 0 }, link, 'A', 'Pivot');
  extra(b, link, j);
  return { project: b.build(), link, j };
}

describe('rigid-body dynamics vs analytic references', () => {
  it('compound pendulum: period within 1e-4 and no energy drift (< 1e-5 over 10 s)', () => {
    const th0 = 5 * DEG;
    const { project } = pendulum(th0);
    const m = compile(project, 'dynamic');
    const sim = new Simulation(m, 0.001);
    const B = m.bodies[0];
    const d = Math.hypot(B.x0, B.y0);
    const T = 2 * Math.PI * Math.sqrt((B.inertia + B.mass * d * d) / (B.mass * g * d)) * (1 + th0 ** 2 / 16);
    const E0 = sim.kineticEnergy() + sim.potentialEnergy();
    const cross: number[] = [];
    let prev = th0, maxErr = 0;
    for (let i = 0; i < 10000; i++) {
      sim.step();
      maxErr = Math.max(maxErr, sim.stats.posError);
      const th = sim.q[2] + th0;
      if (prev > 0 && th <= 0) cross.push(sim.t - sim.h * (0 - th) / (prev - th));
      prev = th;
    }
    const periods = cross.slice(1).map((c, i) => c - cross[i]);
    const Tm = periods.reduce((a, b) => a + b, 0) / periods.length;
    expect(Math.abs(Tm - T) / T).toBeLessThan(1e-4);
    const E1 = sim.kineticEnergy() + sim.potentialEnergy();
    // energy scale: m·g·d·(1 − cos θ0)
    expect(Math.abs(E1 - E0) / (B.mass * g * d * (1 - Math.cos(th0)))).toBeLessThan(1e-3);
    expect(Math.abs(E1 - E0) / Math.abs(E0)).toBeLessThan(1e-5);
    expect(maxErr).toBeLessThan(1e-6);
    // pivot reaction at rest position ≈ weight + centripetal: check magnitude order (static weight within 2 %)
    expect(Math.hypot(sim.lambda[0], sim.lambda[1])).toBeGreaterThan(0.98 * B.mass * g * Math.cos(th0));
  });

  it('spring–mass on a guide: x(t) = A·cos(ωt) within 0.5 % of amplitude over 5 periods; halving dt cuts the error ~4× (2nd order)', () => {
    const run = (dt: number) => {
      const b = new Builder('sm', 't');
      const s = b.part('slider', 'Mass', { length: 20, width: 10, thickness: 5, holeDiameter: 0 }, {}, { massOverride: { mass: 0.1 } });
      b.prismatic(GROUND, { x: 0, y: 0 }, s, 'pin', 'Guide', 0);
      b.spring(GROUND, { x: -50, y: 0 }, s, 'pin', 'Spring', 400, 40, 0);
      b.project.sim.gravityEnabled = false;
      const m = compile(b.build(), 'dynamic');
      const sim = new Simulation(m, dt);
      const w = Math.sqrt(400 / 0.1), T = (2 * Math.PI) / w, A = 10;
      let maxDev = 0;
      const n = Math.round((5 * T) / dt);
      for (let i = 0; i < n; i++) { sim.step(); maxDev = Math.max(maxDev, Math.abs(sim.q[0] - (-A + A * Math.cos(w * sim.t)))); }
      return maxDev / A;
    };
    const e1 = run(0.001), e2 = run(0.0005);
    expect(e1).toBeLessThan(0.005);
    expect(e2).toBeLessThan(0.0015);
    expect(e1 / e2).toBeGreaterThan(3.2);
    expect(e1 / e2).toBeLessThan(4.8);
  });

  it('free fall onto the floor comes to rest on the surface (inelastic contact, penetration < 1e-3 mm)', () => {
    const b = new Builder('drop', 't');
    b.part('baseplate', 'Box', { width: 40, height: 20, thickness: 10, cornerRadius: 0, holes: [] }, { y: 60 });
    b.project.sim.floor = { enabled: true, y: 0, friction: 0.5 };
    const r = new SimRunner(b.build());
    // analytic time to fall 50 mm: sqrt(2h/g)
    const tHit = Math.sqrt((2 * 50) / g);
    r.advance(Math.round(tHit / 0.001) - 2);
    expect(r.sim.contacts.filter((c) => c.fn > 0).length).toBe(0);
    expect(r.sim.q[1]).toBeCloseTo(60 - 0.5 * g * r.time ** 2, 0);
    r.advance(1500);
    expect(Math.abs(r.sim.q[1] - 10)).toBeLessThan(1e-3);
    expect(Math.abs(r.sim.v[1])).toBeLessThan(1e-6);
    const fn = r.sim.contacts.reduce((s, c) => s + c.fn, 0);
    expect(fn).toBeCloseTo(r.model.bodies[0].mass * g, 3);
  });

  it('Coulomb friction: block sticks below μ·m·g and slides with a = (F − μ·m·g)/m above it (1 %)', () => {
    const run = (ratio: number) => {
      const b = new Builder('fr', 't');
      const box = b.part('baseplate', 'Box', { width: 60, height: 20, thickness: 10, cornerRadius: 0, holes: [] }, { y: 10 }, { massOverride: { mass: 0.2 } });
      b.project.sim.floor = { enabled: true, y: 0, friction: 0.5 };
      // push at floor level so the force adds no tipping moment
      b.forceLoad(box, { x: 0, y: -10 }, ratio * 0.2 * g, 0, 'Push');
      const r = new SimRunner(b.build());
      r.advance(1000);
      return r.sim.q[0];
    };
    expect(Math.abs(run(0.45))).toBeLessThan(1e-3);            // F = 0.45 mg < μ mg = 0.5 mg → sticks
    const x = run(0.8), expected = 0.5 * (0.8 - 0.5) * g * 1 * 1; // a = 0.3 g for 1 s
    expect(Math.abs(x - expected) / expected).toBeLessThan(0.01);
  });
});

describe('transmissions obey their geometry', () => {
  it('simple gear pair: ratio −z1/z2 exactly, torque balance, reaction on shafts', () => {
    const b = new Builder('pair', 't');
    const g1 = b.part('gear', 'G1', { module: 2, teeth: 18 }, { x: 0, y: 0 });
    const g2 = b.part('gear', 'G2', { module: 2, teeth: 45 }, { x: 70, y: 5 });
    const j1 = b.revolute(GROUND, { x: 0, y: 0 }, g1, 'center', 'S1');
    b.revolute(GROUND, { x: 70, y: 5 }, g2, 'center', 'S2');
    const mesh = b.gear(g1, g2, 'Mesh');
    b.motor(j1, { speed: 100 * RPM, maxTorque: null, rampTime: 0.1 });
    b.torqueLoad(g2, 100000, 'Load');     // +100 N·mm on the driven gear (it turns negative, so this resists)
    b.project.sim.gravityEnabled = false;
    b.solve();
    const p = b.build();
    const P = (id: string) => p.parts.find((x) => x.id === id)!.pose;
    expect(Math.hypot(P(g2).x - P(g1).x, P(g2).y - P(g1).y)).toBeCloseTo((2 * (18 + 45)) / 2, 9);   // centre distance m(z1+z2)/2
    const r = new SimRunner(p);
    expect(r.staticDiagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    r.advance(1000);
    const w1 = r.sim.v[3 * r.model.partRef.get(g1)!.body + 2], w2 = r.sim.v[3 * r.model.partRef.get(g2)!.body + 2];
    expect(w1).toBeCloseTo(100 * RPM, 9);
    expect(w2 / w1).toBeCloseTo(-18 / 45, 10);
    // steady state: motor torque = load × z1/z2 ; tooth force = load / r2
    expect(r.sim.motorEffort.get(j1)!).toBeCloseTo(100000 * (18 / 45), 4);
    const row = r.model.cons.find((c) => c.jointId === mesh)!.row;
    expect(Math.abs(r.sim.lambda[row])).toBeCloseTo(100000 / 45, 4);
    expect(r.events.filter((e) => e.code.startsWith('interference'))).toEqual([]);
  });

  it('rack and pinion: rack speed = pitch radius × pinion speed, travel = r·θ', () => {
    const b = new Builder('rack', 't');
    const pin = b.part('gear', 'Pinion', { module: 2, teeth: 20 }, { x: 60, y: 20.3 });
    const rack = b.part('rack', 'Rack', { module: 2, teeth: 30 }, { x: 0, y: 0 });
    const j = b.revolute(GROUND, { x: 60, y: 20.3 }, pin, 'center', 'Shaft');
    b.prismatic(GROUND, { x: 0, y: 0 }, rack, 'start', 'Slide', 0);
    b.rack(pin, rack, 'Mesh');
    b.motor(j, { speed: 30 * RPM, maxTorque: null, rampTime: 0 });
    b.project.sim.gravityEnabled = false;
    b.solve();
    const p = b.build();
    expect(p.parts.find((x) => x.id === rack)!.pose.y).toBeCloseTo(20.3 - 20, 9);   // pitch line tangent to pitch circle (r = 20)
    const r = new SimRunner(p);
    expect(r.staticDiagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const x0 = r.poseOf(rack)!.x;
    r.advance(500);
    const vx = r.sim.v[3 * r.model.partRef.get(rack)!.body];
    // pinion above the rack turning CCW drives the rack toward −x … relative rolling: |v| = r·ω
    expect(Math.abs(vx)).toBeCloseTo(20 * 30 * RPM, 8);
    expect(Math.abs(r.poseOf(rack)!.x - x0)).toBeCloseTo(20 * 30 * RPM * 0.5, 6);
    expect(r.events.filter((e) => e.code.startsWith('interference'))).toEqual([]);
  });

  it('belt: ratio = pitch diameters, same direction (open) / reversed (crossed)', () => {
    for (const crossed of [false, true]) {
      const b = new Builder('belt', 't');
      const p1 = b.part('pulley', 'P1', { pitchDiameter: 20 }, { x: 0, y: 0 });
      const p2 = b.part('pulley', 'P2', { pitchDiameter: 50 }, { x: 80, y: 30 });
      const j = b.revolute(GROUND, { x: 0, y: 0 }, p1, 'center', 'S1');
      b.revolute(GROUND, { x: 80, y: 30 }, p2, 'center', 'S2');
      b.belt(p1, p2, 'Belt', { crossed });
      b.motor(j, { speed: 60 * RPM, maxTorque: null, rampTime: 0 });
      const r = new SimRunner(b.solve().build());
      r.advance(300);
      const w1 = r.sim.v[3 * r.model.partRef.get(p1)!.body + 2], w2 = r.sim.v[3 * r.model.partRef.get(p2)!.body + 2];
      expect(w2 / w1).toBeCloseTo((crossed ? -1 : 1) * 20 / 50, 10);
    }
  });

  it('gear constraints do not drift: phase error after 20 s of running is < 1e-9 rad', () => {
    const b = new Builder('pair', 't');
    const g1 = b.part('gear', 'G1', { module: 1.5, teeth: 17 }, { x: 0, y: 0 });
    const g2 = b.part('gear', 'G2', { module: 1.5, teeth: 41 }, { x: 40, y: 0 });
    const j1 = b.revolute(GROUND, { x: 0, y: 0 }, g1, 'center', 'S1');
    b.revolute(GROUND, { x: 40, y: 0 }, g2, 'center', 'S2');
    b.gear(g1, g2, 'Mesh');
    b.motor(j1, { speed: 300 * RPM, maxTorque: null, rampTime: 0.05 });
    const r = new SimRunner(b.solve().build(), { interference: false });
    const a1 = () => r.sim.q[3 * r.model.partRef.get(g1)!.body + 2], a2 = () => r.sim.q[3 * r.model.partRef.get(g2)!.body + 2];
    r.advance(20000);
    expect(Math.abs(17 * a1() + 41 * a2())).toBeLessThan(1e-9 * 41 * 20);
  });
});

describe('linkage kinematics', () => {
  function sliderCrank(mode: 'kinematic' | 'dynamic', r = 20, l = 70) {
    const b = new Builder('sc', 't');
    const crank = b.part('link', 'Crank', { length: r }, { x: 0, y: 0, angle: 0 });
    const rod = b.part('link', 'Rod', { length: l }, { x: r, y: 0, angle: 0, z: 5 });
    const slider = b.part('slider', 'Slider', {}, { x: r + l, y: 0, z: 10 });
    const j = b.revolute(GROUND, { x: 0, y: 0 }, crank, 'A', 'Main');
    b.revolute(crank, 'B', rod, 'A', 'Pin');
    b.revolute(rod, 'B', slider, 'pin', 'Wrist');
    const sl = b.prismatic(GROUND, { x: 0, y: 0 }, slider, 'pin', 'Slide', 0);
    b.motor(j, { speed: 90 * RPM, maxTorque: null, rampTime: 0 });
    b.project.sim.mode = mode;
    b.project.sim.sampleRate = 1000;
    return { p: b.solve().build(), crank, slider, sl, r, l };
  }
  it('slider-crank position matches x = r·cosθ + √(l² − r²·sin²θ) to 1e-6 mm (kinematic) and 1e-6 mm (dynamic)', () => {
    for (const mode of ['kinematic', 'dynamic'] as const) {
      const { p, crank, slider, r, l } = sliderCrank(mode);
      const run = new SimRunner(p, { interference: false });
      let maxErr = 0, maxV = 0;
      for (let i = 0; i < 1500; i++) {
        run.advance(1);
        const th = run.poseOf(crank)!.angle;
        const x = run.poseOf(slider)!.x;
        maxErr = Math.max(maxErr, Math.abs(x - (r * Math.cos(th) + Math.sqrt(l * l - r * r * Math.sin(th) ** 2))));
        // analytic slider velocity
        const w = 90 * RPM;
        const vx = -r * w * Math.sin(th) * (1 + (r * Math.cos(th)) / Math.sqrt(l * l - r * r * Math.sin(th) ** 2));
        maxV = Math.max(maxV, Math.abs(run.sim.v[3 * run.model.partRef.get(slider)!.body] - vx));
      }
      expect(maxErr).toBeLessThan(1e-6);
      // kinematic velocities are solved analytically from the Jacobian; dynamic ones are step differences (O(h))
      expect(maxV).toBeLessThan(mode === 'kinematic' ? 1e-6 : 1.5);
      expect(run.sim.stats.maxPosError).toBeLessThan(1e-6);
    }
  });

  it('four-bar closed loop: constraint residual stays below 1e-6 mm for 60 s (60 000 steps), with measured pre-projection drift', () => {
    const b = new Builder('fb', 't');
    const crank = b.part('link', 'Crank', { length: 30 }, { angle: Math.PI / 2 });
    const coupler = b.part('link', 'Coupler', { length: 90 }, { x: 0, y: 30, angle: 0.3 });
    const rocker = b.part('link', 'Rocker', { length: 70 }, { x: 100, y: 0, angle: Math.PI / 2 });
    const j = b.revolute(GROUND, { x: 0, y: 0 }, crank, 'A', 'O2');
    b.revolute(crank, 'B', coupler, 'A', 'A');
    b.revolute(coupler, 'B', rocker, 'B', 'B');
    b.revolute(GROUND, { x: 100, y: 0 }, rocker, 'A', 'O4');
    b.motor(j, { speed: 120 * RPM, maxTorque: null, rampTime: 0.1 });
    const p = b.solve().build();
    const r = new SimRunner(p, { interference: false });
    expect(r.dof).toBe(1);
    expect(r.dofDriven).toBe(0);
    let maxDrift = 0;
    for (let i = 0; i < 600; i++) { r.advance(100); maxDrift = Math.max(maxDrift, r.sim.stats.driftBefore); }
    expect(r.sim.status).toBe('ok');
    expect(r.sim.stats.maxPosError).toBeLessThan(1e-6);
    // independent re-evaluation of the loop closure from part poses
    const P = (id: string) => r.poseOf(id)!;
    const tip = (id: string, L: number) => ({ x: P(id).x + L * Math.cos(P(id).angle), y: P(id).y + L * Math.sin(P(id).angle) });
    const a = tip(crank, 30), cA = P(coupler), bC = tip(coupler, 90), bR = tip(rocker, 70);
    expect(Math.hypot(a.x - cA.x, a.y - cA.y)).toBeLessThan(1e-6);
    expect(Math.hypot(bC.x - bR.x, bC.y - bR.y)).toBeLessThan(1e-6);
    expect(Math.hypot(P(rocker).x - 100, P(rocker).y)).toBeLessThan(1e-6);
    // the per-step drift that projection removes is small but non-zero (it is measured, not hidden)
    expect(maxDrift).toBeGreaterThan(0);
    expect(maxDrift).toBeLessThan(0.5);
    const fb = findFourBars(r.model)[0];
    expect(fb.type).toBe('crank-rocker');
    expect(fb.crankCanRotate).toBe(true);
  });

  it('non-Grashof four-bar stops at the dead-centre with a diagnosis instead of teleporting; the last committed state is valid', () => {
    for (const mode of ['kinematic', 'dynamic'] as const) {
      const b = new Builder('fb', 't');
      const crank = b.part('link', 'Crank', { length: 55 }, { angle: Math.PI / 2 });
      const coupler = b.part('link', 'Coupler', { length: 60 }, { x: 0, y: 55, angle: 0.3 });
      const rocker = b.part('link', 'Rocker', { length: 70 }, { x: 100, y: 0, angle: Math.PI / 2 });
      const j = b.revolute(GROUND, { x: 0, y: 0 }, crank, 'A', 'O2');
      b.revolute(crank, 'B', coupler, 'A', 'A');
      b.revolute(coupler, 'B', rocker, 'B', 'B');
      b.revolute(GROUND, { x: 100, y: 0 }, rocker, 'A', 'O4');
      b.motor(j, { speed: 60 * RPM, maxTorque: null, rampTime: 0.1 });
      b.project.sim.mode = mode;
      const r = new SimRunner(b.solve().build(), { interference: false });
      r.advance(5000);
      expect(r.finished).toBe(true);
      expect(r.sim.status).toBe('locked');
      expect(r.time).toBeLessThan(1);
      const ev = r.events.find((e) => e.code === 'sim.locked')!;
      expect(ev.detail).toMatch(/Grashof condition violated/);
      expect(ev.joints.length).toBeGreaterThan(0);
      // state was not advanced into an invalid configuration
      expect(r.sim.constraintError().pos).toBeLessThan(1e-6);
      expect(r.advance(10)).toBe(0);
    }
  });

  it('dead-centre is reached by a torque-limited motor without divergence, and flagged as near-singular or saturated', () => {
    const b = new Builder('fb', 't');
    const crank = b.part('link', 'Crank', { length: 55 }, { angle: Math.PI / 2 });
    const coupler = b.part('link', 'Coupler', { length: 60 }, { x: 0, y: 55, angle: 0.3 });
    const rocker = b.part('link', 'Rocker', { length: 70 }, { x: 100, y: 0, angle: Math.PI / 2 });
    const j = b.revolute(GROUND, { x: 0, y: 0 }, crank, 'A', 'O2');
    b.revolute(crank, 'B', coupler, 'A', 'A');
    b.revolute(coupler, 'B', rocker, 'B', 'B');
    b.revolute(GROUND, { x: 100, y: 0 }, rocker, 'A', 'O4');
    b.motor(j, { speed: 60 * RPM, maxTorque: 20000, rampTime: 0.1 });
    const r = new SimRunner(b.solve().build(), { interference: false });
    r.advance(4000);
    expect(r.sim.status).toBe('ok');
    expect(r.sim.stats.maxPosError).toBeLessThan(1e-6);
    expect(Math.abs(r.sim.motorEffort.get(j)!)).toBeLessThanOrEqual(20000 * (1 + 1e-9));
    expect(r.events.some((e) => e.code.startsWith('motor.') || e.code === 'sim.singular')).toBe(true);
    // crank never passes the geometric limit (~23° beyond the start for these lengths)
    expect(r.sim.coordValue(r.model.coords.get(j)!, r.sim.q)).toBeLessThan(40 * DEG);
  });
});

describe('joint limits, motors, reversal', () => {
  it('revolute limit stops a pendulum (inelastic), never exceeding the limit by more than 1e-3 rad', () => {
    const { project, j } = pendulum(60 * DEG, (b, _l, joint) => b.joint(joint, { limits: { enabled: true, lower: -80 * DEG, upper: 10 * DEG } }));
    const r = new SimRunner(project, { interference: false });
    let minA = 0;
    for (let i = 0; i < 3000; i++) { r.advance(1); minA = Math.min(minA, r.sim.coordValue(r.model.coords.get(j)!, r.sim.q)); }
    expect(minA).toBeGreaterThan(-80 * DEG - 1e-3);
    expect(minA).toBeLessThan(-79 * DEG);
    expect(r.events.some((e) => e.code === 'joint.limit-hit')).toBe(true);
    expect(r.sim.status).toBe('ok');
  });

  it('prismatic limits bound a driven slider; a torque-limited actuator stalls against the stop (diagnosed)', () => {
    const b = new Builder('lim', 't');
    const s = b.part('slider', 'Slider', {});
    const j = b.prismatic(GROUND, { x: 0, y: 0 }, s, 'pin', 'Slide', 0, { limits: { enabled: true, lower: -5, upper: 12 } });
    b.motor(j, { speed: 40, maxTorque: 2000, rampTime: 0 });
    b.project.sim.gravityEnabled = false;
    const r = new SimRunner(b.build(), { interference: false });
    r.advance(1500);
    expect(r.poseOf(s)!.x).toBeLessThan(12 + 1e-3);
    expect(r.poseOf(s)!.x).toBeGreaterThan(12 - 1e-2);
    expect(r.events.some((e) => e.code === 'motor.stall')).toBe(true);
    expect(r.events.some((e) => e.code === 'joint.limit-hit')).toBe(true);
  });

  it('reversing motor profile reverses the mechanism and returns to its start', () => {
    const b = new Builder('rev', 't');
    const l = b.part('link', 'Arm', { length: 50 });
    const j = b.revolute(GROUND, { x: 0, y: 0 }, l, 'A', 'Pivot');
    b.motor(j, { speed: 60 * RPM, maxTorque: null, rampTime: 0, profile: 'reversing', period: 0.5 });
    b.project.sim.gravityEnabled = false;
    const r = new SimRunner(b.build(), { interference: false });
    r.advance(500);
    expect(r.poseOf(l)!.angle).toBeCloseTo(Math.PI, 6);       // 60 rpm for 0.5 s = half a turn
    r.advance(500);
    expect(r.poseOf(l)!.angle).toBeCloseTo(0, 6);             // and back
  });

  it('DC motor curve: no-load speed without load, linear torque–speed under load', () => {
    const b = new Builder('dc', 't');
    const d = b.part('crank', 'Disc', { diameter: 60, pinRadius: 20 });
    const j = b.revolute(GROUND, { x: 0, y: 0 }, d, 'center', 'Shaft');
    b.motor(j, { type: 'dc', speed: 100, maxTorque: 50000, rampTime: 0 });
    b.torqueLoad(d, -20000, 'Load');
    b.project.sim.gravityEnabled = false;
    const r = new SimRunner(b.build(), { interference: false });
    r.advance(8000);
    // steady state: τ = τ_stall (1 − ω/ω0) = 20000 → ω = 100·(1 − 0.4) = 60 rad/s
    expect(r.sim.v[2]).toBeCloseTo(60, 3);
    expect(r.sim.motorEffort.get(j)!).toBeCloseTo(20000, 1);
  });

  it('a DC motor that cannot hold its load is reported; a DC motor without a stall torque is an error, not a silent zero', () => {
    const arm = (spec: Parameters<Builder['motor']>[1]) => {
      const b = new Builder('dc', 't');
      const l = b.part('link', 'Arm', { length: 150, width: 20, thickness: 10 }, {}, { materialId: 'steel' });
      const j = b.revolute(GROUND, { x: 0, y: 0 }, l, 'A', 'Pivot');
      b.motor(j, spec);
      return { r: new SimRunner(b.build(), { interference: false }), j };
    };
    // holding torque ≈ m·g·75 mm ≈ 0.18 N·m; a 0.1 N·m stall torque cannot lift it
    const weak = arm({ type: 'dc', speed: 3, maxTorque: 100000, rampTime: 0 });
    weak.r.advance(3000);
    expect(weak.r.events.map((e) => e.code)).toEqual(expect.arrayContaining(['motor.backdriven']));
    expect(weak.r.events.some((e) => e.code === 'motor.stall' || e.code === 'motor.saturated')).toBe(true);
    const strong = arm({ type: 'dc', speed: 3, maxTorque: 2e6, rampTime: 0 });
    strong.r.advance(1500);
    expect(strong.r.events.filter((e) => e.code.startsWith('motor.'))).toEqual([]);
    const none = arm({ type: 'dc', speed: 3, maxTorque: null, rampTime: 0 });
    const d = none.r.staticDiagnostics.find((x) => x.code === 'motor.dc-no-stall')!;
    expect(d.severity).toBe('error');
    expect(d.joints).toEqual([none.j]);
    expect(none.r.model.motors.length).toBe(0);
  });

  it('joint Coulomb friction holds a pendulum below the breakaway torque and viscous damping decays it', () => {
    const hold = pendulum(10 * DEG, (b, _l, joint) => b.joint(joint, { friction: 1e7 }));
    const r1 = new SimRunner(hold.project, { interference: false });
    r1.advance(1000);
    expect(Math.abs(r1.sim.q[2])).toBeLessThan(1e-9);
    const damp = pendulum(30 * DEG, (b, _l, joint) => b.joint(joint, { damping: 3000 }));
    const r2 = new SimRunner(damp.project, { interference: false });
    const E0 = r2.sim.kineticEnergy() + r2.sim.potentialEnergy();
    r2.advance(4000);
    const E1 = r2.sim.kineticEnergy() + r2.sim.potentialEnergy();
    expect(E1).toBeLessThan(E0);
    expect(Math.abs(r2.sim.q[2] + 30 * DEG)).toBeLessThan(2 * DEG);   // settled hanging straight down
  });
});

describe('cam and follower', () => {
  function camRig(mode: 'kinematic' | 'dynamic', rpm: number, k = 2000) {
    const b = new Builder('cam', 't');
    const cam = b.part('cam', 'Cam', {}, { x: 0, y: 0 });
    const fol = b.part('follower', 'Follower', {}, { x: 0, y: 23 }, { massOverride: { mass: 0.02 } });
    const jc = b.revolute(GROUND, { x: 0, y: 0 }, cam, 'center', 'Shaft');
    const jg = b.prismatic(GROUND, { x: 0, y: 0 }, fol, 'roller', 'Guide', Math.PI / 2);
    const jx = b.cam(cam, fol, 'roller', 'Contact');
    b.spring(GROUND, { x: 0, y: 110 }, fol, 'top', 'Spring', k, 60, 0.2);
    b.motor(jc, { speed: rpm * RPM, maxTorque: null, rampTime: 0 });
    b.project.sim.mode = mode;
    b.project.sim.dt = 0.0005;
    return { p: b.solve().build(), cam, fol, jg, jx };
  }
  it('follower height equals base + roller + lift(θ) from the cam program: 1e-6 mm kinematic, 2e-3 mm dynamic', () => {
    const segs = defaultParams('cam').segments;
    for (const mode of ['kinematic', 'dynamic'] as const) {
      const { p, cam, fol } = camRig(mode, 120);
      const r = new SimRunner(p, { interference: false });
      let maxErr = 0;
      for (let i = 0; i < 1200; i++) {
        r.advance(1);
        const th = r.poseOf(cam)!.angle;
        const y = r.poseOf(fol)!.y;
        // follower sits at +90° in the world; in the cam frame that is φ = 90° − θ, i.e. cam rotation ϑ = θ − 90°
        const exact = 18 + 5 + camLift(segs, th - Math.PI / 2).s;
        maxErr = Math.max(maxErr, Math.abs(y - exact));
      }
      expect(maxErr).toBeLessThan(mode === 'kinematic' ? 1e-6 : 2e-3);
    }
  });
  it('follower motion is NOT prescribed: with a weak spring at high speed it leaves the cam (gap > 0) and lands again', () => {
    const { p, jx } = camRig('dynamic', 1500, 100);
    const r = new SimRunner(p, { interference: false });
    let maxGap = 0, contactAfterFloat = false, floated = false;
    for (let i = 0; i < 4000; i++) {
      r.advance(1);
      const st = r.sim.camStates[0];
      maxGap = Math.max(maxGap, st.gap);
      if (st.gap > 0.05) floated = true;
      if (floated && st.force > 0) contactAfterFloat = true;
      expect(st.gap).toBeGreaterThan(-0.05);
      expect(st.force).toBeGreaterThanOrEqual(0);     // contact can only push
    }
    expect(maxGap).toBeGreaterThan(0.1);
    expect(contactAfterFloat).toBe(true);
    expect(r.events.some((e) => e.code === 'cam.float' && e.joints.includes(jx))).toBe(true);
  });
});

describe('repeatability, reset and failure handling', () => {
  it('replay from initial conditions is bit-for-bit identical; reset does not touch the design', () => {
    const { p } = (() => { const b = new Builder('fb', 't'); const c = b.part('link', 'Crank', { length: 30 }, { angle: 1 }); const k = b.part('link', 'Coupler', { length: 90 }, { x: 0, y: 30 }); const r = b.part('link', 'Rocker', { length: 70 }, { x: 100, y: 0, angle: 1.5 }); const j = b.revolute(GROUND, { x: 0, y: 0 }, c, 'A'); b.revolute(c, 'B', k, 'A'); b.revolute(k, 'B', r, 'B'); b.revolute(GROUND, { x: 100, y: 0 }, r, 'A'); b.motor(j, { speed: 50 * RPM, maxTorque: 30000 }); b.project.sim.floor = { enabled: true, y: -60, friction: 0.4 }; return { p: b.solve().build() }; })();
    const frozen = JSON.stringify(p);
    const a = new SimRunner(p), b2 = new SimRunner(p);
    a.advance(700); a.advance(800);
    b2.advance(1500);
    expect(Array.from(a.sim.q)).toEqual(Array.from(b2.sim.q));
    expect(Array.from(a.sim.v)).toEqual(Array.from(b2.sim.v));
    expect(Array.from(a.T.subarray(0, a.n))).toEqual(Array.from(b2.T.subarray(0, b2.n)));
    expect(JSON.stringify(p)).toBe(frozen);                 // simulation never mutates the design
    const c = new SimRunner(p);
    expect(c.sim.t).toBe(0);
    const pose0 = c.poseOf(p.parts[0].id)!;
    expect(pose0.x).toBeCloseTo(p.parts[0].pose.x, 12);
    expect(pose0.y).toBeCloseTo(p.parts[0].pose.y, 12);
    expect(pose0.angle).toBeCloseTo(p.parts[0].pose.angle, 12);
  });

  it('counts degrees of freedom from Jacobian rank and reports redundant constraints', () => {
    // parallelogram linkage with a redundant third rocker: 4 bodies (12 coordinates), 12 equations, rank 11 → 1 DOF, 1 redundant equation
    const b = new Builder('pl', 't');
    const mk = (x: number, n: string) => { const l = b.part('link', n, { length: 40 }, { x, y: 0, angle: Math.PI / 2 }); b.revolute(GROUND, { x, y: 0 }, l, 'A', `${n} pivot`); return l; };
    const l1 = mk(0, 'R1'), l2 = mk(50, 'R2'), l3 = mk(100, 'R3');
    const bar = b.part('baseplate', 'Bar', { width: 120, height: 10, thickness: 4, holes: [{ x: -50, y: 0, d: 4 }, { x: 0, y: 0, d: 4 }, { x: 50, y: 0, d: 4 }] }, { x: 50, y: 40, z: 5 });
    b.revolute(l1, 'B', bar, 'H1', 'J1'); b.revolute(l2, 'B', bar, 'H2', 'J2'); b.revolute(l3, 'B', bar, 'H3', 'J3');
    const r = new SimRunner(b.solve().build(), { interference: false });
    expect(r.dof).toBe(1);
    const red = r.staticDiagnostics.find((d) => d.code === 'model.redundant')!;
    expect(red.title).toMatch(/1 redundant/);
    r.advance(800);
    expect(r.sim.status).toBe('ok');
    expect(r.sim.stats.maxPosError).toBeLessThan(1e-6);
  });

  it('impossible assembly: solver refuses, reports the gaps and returns the project unchanged', () => {
    const b = new Builder('bad', 't');
    const c = b.part('link', 'Crank', { length: 30 }, { angle: 1 });
    const k = b.part('link', 'Coupler', { length: 20 }, { x: 0, y: 30 });
    const r = b.part('link', 'Rocker', { length: 30 }, { x: 100, y: 0, angle: 1.5 });
    b.revolute(GROUND, { x: 0, y: 0 }, c, 'A'); b.revolute(c, 'B', k, 'A'); b.revolute(k, 'B', r, 'B'); b.revolute(GROUND, { x: 100, y: 0 }, r, 'A');
    const p = b.build();
    const res = solveAssembly(p);
    expect(res.ok).toBe(false);
    expect(res.project).toBe(p);
    const issue = res.issues.find((i) => i.code === 'assembly.cannot-close')!;
    expect(issue.joints.length).toBeGreaterThanOrEqual(2);
    expect(issue.detail).toMatch(/gaps/);
    // the runner flags the open joints and never produces NaN
    const run = new SimRunner(p, { interference: false });
    expect(run.staticDiagnostics.some((d) => d.code === 'assembly.open-joint')).toBe(true);
    expect(Array.from(run.sim.q).every(Number.isFinite)).toBe(true);
  });

  it('refuses to run from an inconsistent design: open loops and gears at the wrong centre distance are blocked, not simulated', () => {
    const b = new Builder('bad', 't');
    const c = b.part('link', 'Crank', { length: 30 }, { angle: 1 });
    const k = b.part('link', 'Coupler', { length: 50 }, { x: 0, y: 30 });
    const r = b.part('link', 'Rocker', { length: 60 }, { x: 200, y: 0, angle: 1.5 });
    const j = b.revolute(GROUND, { x: 0, y: 0 }, c, 'A', 'O2'); b.revolute(c, 'B', k, 'A', 'A'); b.revolute(k, 'B', r, 'B', 'B'); b.revolute(GROUND, { x: 200, y: 0 }, r, 'A', 'O4');
    b.motor(j, { speed: 6, maxTorque: null });
    const run = new SimRunner(b.build(), { interference: false });
    expect(run.blocked).toBe(true);
    expect(run.advance(100)).toBe(0);
    expect(run.events).toEqual([]);                               // no misleading "locked at a dead-centre" story at t = 0
    expect(run.staticDiagnostics.some((d) => d.code === 'assembly.open-joint')).toBe(true);
    // two gears 10 mm too far apart (as could come from an edited file)
    const g = new Builder('gap', 't');
    const g1 = g.part('gear', 'G1', { module: 2, teeth: 20 }, { x: 0, y: 0 }), g2 = g.part('gear', 'G2', { module: 2, teeth: 20 }, { x: 50, y: 0 });
    const j1 = g.revolute(GROUND, { x: 0, y: 0 }, g1, 'center'); g.revolute(GROUND, { x: 50, y: 0 }, g2, 'center'); g.gear(g1, g2, 'Mesh');
    g.motor(j1, { speed: 6, maxTorque: null });
    const gr = new SimRunner(g.build(), { interference: false });
    expect(gr.staticDiagnostics.find((d) => d.code === 'gear.center-distance')!.detail).toMatch(/50.000 mm apart.*need 40.000 mm/);
    expect(gr.blocked).toBe(true);
    expect(gr.advance(100)).toBe(0);
  });

  it('design-time solving: a slide keeps the slider aligned when the guide is turned; a free gear and rack are brought into mesh', () => {
    let q = createProject('s');
    q = ops.addPart(q, 'rail', { id: 'rail', grounded: true }).project;
    q = ops.addPart(q, 'slider', { id: 's', pose: { x: 12, y: 0 } }).project;
    q = ops.matePrismatic(q, 'rail', { port: 'mid' }, 's', { port: 'pin' }).project;
    const turned = solveAssembly(ops.setPartPose(q, 'rail', { y: 40, angle: Math.PI / 6 }));
    expect(turned.ok).toBe(true);
    const S = turned.project.parts.find((x) => x.id === 's')!.pose;
    expect(S.angle).toBeCloseTo(Math.PI / 6, 9);                                   // rotated with the guide
    expect(-Math.sin(Math.PI / 6) * S.x + Math.cos(Math.PI / 6) * (S.y - 40)).toBeCloseTo(0, 7);   // on the guide axis
    let p = createProject('r');
    p = ops.addPart(p, 'gear', { id: 'g', pose: { x: 10, y: 40 } }).project;
    p = ops.addPart(p, 'rack', { id: 'r', pose: { x: -30, y: -10, angle: 0.2 } }).project;
    p = ops.mateCoupling(p, 'rackPinion', 'g', 'r').project;
    const res = solveAssembly(p);
    const run = new SimRunner(res.project, { interference: false });
    expect(run.staticDiagnostics.filter((d) => d.severity === 'error')).toEqual([]);   // pitch line tangent to the pitch circle, teeth in phase
  });

  it('a diverging setup is detected (stiff spring, coarse step) and warned about beforehand', () => {
    const b = new Builder('stiff', 't');
    const s = b.part('slider', 'Mass', {}, {}, { massOverride: { mass: 1e-4 } });
    b.prismatic(GROUND, { x: 0, y: 0 }, s, 'pin', 'Guide', 0);
    b.spring(GROUND, { x: -30, y: 0 }, s, 'pin', 'Spring', 5e6, 20, 0);
    b.project.sim.dt = 0.002;
    const r = new SimRunner(b.build(), { interference: false });
    expect(r.staticDiagnostics.some((d) => d.code === 'sim.stiff-spring')).toBe(true);
    r.advance(3000);
    expect(r.sim.status).toBe('diverged');
    expect(r.events.some((e) => e.code === 'sim.diverged')).toBe(true);
  });

  it('design-time edits propagate: changing a link length re-solves joints; changing teeth moves the shaft', () => {
    const b = new Builder('fb', 't');
    const c = b.part('link', 'Crank', { length: 30 }, { angle: Math.PI / 2 });
    const k = b.part('link', 'Coupler', { length: 90 }, { x: 0, y: 30, angle: 0.3 });
    const r = b.part('link', 'Rocker', { length: 70 }, { x: 100, y: 0, angle: Math.PI / 2 });
    b.revolute(GROUND, { x: 0, y: 0 }, c, 'A'); b.revolute(c, 'B', k, 'A'); b.revolute(k, 'B', r, 'B'); b.revolute(GROUND, { x: 100, y: 0 }, r, 'A');
    const p0 = b.solve().build();
    const res = solveAssembly(ops.setPartParam(p0, k, 'length', 100));
    expect(res.ok).toBe(true);
    expect(res.moved).toBeGreaterThan(1);
    expect(res.pos).toBeLessThan(1e-6);
  });
});
