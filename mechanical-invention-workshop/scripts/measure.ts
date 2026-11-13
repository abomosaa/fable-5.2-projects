/**
 * Measures the solver against analytic references and writes the numbers to
 * docs/verification/analytic.{json,md}. (The same cases are asserted with
 * tolerances in tests/solver.test.ts; this script records the actual values.)
 *   npx tsx scripts/measure.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Builder, GROUND } from '../src/core/model/builder';
import { compile } from '../src/core/assembly/compile';
import { Simulation } from '../src/core/sim/solver';
import { SimRunner } from '../src/core/sim/runner';
import { camLift } from '../src/core/parts/profiles';
import { defaultParams } from '../src/core/parts/catalog';
import { G_STANDARD as g, RPM, DEG } from '../src/core/units';
import { EXAMPLES } from '../src/examples';

const rows: { case: string; quantity: string; reference: string; measured: string; error: string; tolerance: string; settings: string }[] = [];
const add = (c: string, quantity: string, reference: string, measured: string, error: string, tolerance: string, settings: string) => { rows.push({ case: c, quantity, reference, measured, error, tolerance, settings }); console.log(`${c} | ${quantity} | ref ${reference} | meas ${measured} | err ${error} | tol ${tolerance}`); };
const e = (x: number) => x.toExponential(2);

{ // pendulum
  const th0 = 5 * DEG;
  const b = new Builder('p', 't');
  const l = b.part('link', 'P', { length: 200, width: 10, thickness: 4, holeDiameter: 0 }, { angle: -Math.PI / 2 + th0 });
  b.revolute(GROUND, { x: 0, y: 0 }, l, 'A');
  const m = compile(b.build(), 'dynamic');
  const sim = new Simulation(m, 0.001);
  const B = m.bodies[0], d = Math.hypot(B.x0, B.y0);
  const T = 2 * Math.PI * Math.sqrt((B.inertia + B.mass * d * d) / (B.mass * g * d)) * (1 + th0 ** 2 / 16);
  const E0 = sim.kineticEnergy() + sim.potentialEnergy();
  const cross: number[] = []; let prev = th0, maxErr = 0;
  for (let i = 0; i < 10000; i++) { sim.step(); maxErr = Math.max(maxErr, sim.stats.posError); const th = sim.q[2] + th0; if (prev > 0 && th <= 0) cross.push(sim.t - sim.h * (0 - th) / (prev - th)); prev = th; }
  const per = cross.slice(1).map((c, i) => c - cross[i]); const Tm = per.reduce((a, c) => a + c, 0) / per.length;
  const E1 = sim.kineticEnergy() + sim.potentialEnergy();
  add('Compound pendulum (200 mm bar, 5° amplitude)', 'period', `${T.toFixed(6)} s`, `${Tm.toFixed(6)} s`, e(Math.abs(Tm - T) / T) + ' rel', '1e-4 rel', 'dt 1 ms, 10 s');
  add('Compound pendulum', 'total energy change over 10 s (13 periods)', '0', e(E1 - E0) + ' µJ', e(Math.abs(E1 - E0) / Math.abs(E0)) + ' rel', '1e-5 rel', 'dt 1 ms');
  add('Compound pendulum', 'pivot joint error (max)', '0', e(maxErr) + ' mm', e(maxErr) + ' mm', '1e-6 mm', 'dt 1 ms');
}
{ // spring-mass
  const run = (dt: number) => {
    const b = new Builder('sm', 't');
    const s = b.part('slider', 'M', { length: 20, width: 10, thickness: 5, holeDiameter: 0 }, {}, { massOverride: { mass: 0.1 } });
    b.prismatic(GROUND, { x: 0, y: 0 }, s, 'pin', 'G', 0); b.spring(GROUND, { x: -50, y: 0 }, s, 'pin', 'S', 400, 40, 0);
    b.project.sim.gravityEnabled = false;
    const sim = new Simulation(compile(b.build(), 'dynamic'), dt);
    const w = Math.sqrt(400 / 0.1), T = (2 * Math.PI) / w; let dev = 0;
    for (let i = 0; i < Math.round((5 * T) / dt); i++) { sim.step(); dev = Math.max(dev, Math.abs(sim.q[0] - (-10 + 10 * Math.cos(w * sim.t)))); }
    return dev / 10;
  };
  const e1 = run(0.001), e2 = run(0.0005), e4 = run(0.00025);
  add('Spring–mass (k = 0.4 N/mm, m = 100 g, A = 10 mm)', 'max |x − A·cos ωt| / A over 5 periods', '0', e(e1), e(e1), '5e-3', 'dt 1 ms (ω·h = 0.063)');
  add('Spring–mass', 'same, dt halved / quartered', '÷4 per halving (2nd order)', `${e(e2)} / ${e(e4)}`, `ratios ${(e1 / e2).toFixed(2)}, ${(e2 / e4).toFixed(2)}`, '3.2–4.8', 'dt 0.5 / 0.25 ms');
}
{ // gear pair
  const b = new Builder('g', 't');
  const g1 = b.part('gear', 'G1', { module: 2, teeth: 18 }, { x: 0, y: 0 }), g2 = b.part('gear', 'G2', { module: 2, teeth: 45 }, { x: 70, y: 5 });
  const j1 = b.revolute(GROUND, { x: 0, y: 0 }, g1, 'center'); b.revolute(GROUND, { x: 70, y: 5 }, g2, 'center');
  b.gear(g1, g2); b.motor(j1, { speed: 100 * RPM, maxTorque: null, rampTime: 0.1 }); b.torqueLoad(g2, 100000, 'L'); b.project.sim.gravityEnabled = false;
  const r = new SimRunner(b.solve().build()); r.advance(20000);
  const w1 = r.sim.v[3 * r.model.partRef.get(g1)!.body + 2], w2 = r.sim.v[3 * r.model.partRef.get(g2)!.body + 2];
  const a1 = r.sim.q[3 * r.model.partRef.get(g1)!.body + 2], a2 = r.sim.q[3 * r.model.partRef.get(g2)!.body + 2];
  add('Gear pair 18 : 45, module 2', 'speed ratio ω₂/ω₁', (-18 / 45).toFixed(9), (w2 / w1).toFixed(9), e(Math.abs(w2 / w1 + 18 / 45)), '1e-10', 'dt 1 ms, 20 s');
  add('Gear pair', 'motor torque for 100 N·mm load', '40.0000 N·mm', (r.sim.motorEffort.get(j1)! / 1000).toFixed(4) + ' N·mm', e(Math.abs(r.sim.motorEffort.get(j1)! / 1000 - 40)), '1e-4 N·mm', 'steady state');
  add('Gear pair', 'accumulated phase error z₁θ₁ + z₂θ₂ after 33 input revolutions', '0', e(Math.abs(18 * a1 + 45 * a2)) + ' tooth·rad', e(Math.abs(18 * a1 + 45 * a2)), '1e-6', 'holonomic constraint, no drift');
}
{ // slider crank
  for (const mode of ['kinematic', 'dynamic'] as const) {
    const r0 = 20, l = 70;
    const b = new Builder('sc', 't');
    const crank = b.part('link', 'C', { length: r0 }), rod = b.part('link', 'R', { length: l }, { x: r0, y: 0, z: 5 }), sl = b.part('slider', 'S', {}, { x: r0 + l, y: 0, z: 10 });
    const j = b.revolute(GROUND, { x: 0, y: 0 }, crank, 'A'); b.revolute(crank, 'B', rod, 'A'); b.revolute(rod, 'B', sl, 'pin'); b.prismatic(GROUND, { x: 0, y: 0 }, sl, 'pin', 'S', 0);
    b.motor(j, { speed: 90 * RPM, maxTorque: null, rampTime: 0 }); b.project.sim.mode = mode;
    const r = new SimRunner(b.solve().build(), { interference: false });
    let me = 0, mv = 0;
    for (let i = 0; i < 2000; i++) { r.advance(1); const th = r.poseOf(crank)!.angle, x = r.poseOf(sl)!.x; const root = Math.sqrt(l * l - r0 * r0 * Math.sin(th) ** 2); me = Math.max(me, Math.abs(x - (r0 * Math.cos(th) + root))); mv = Math.max(mv, Math.abs(r.sim.v[3 * r.model.partRef.get(sl)!.body] + r0 * 90 * RPM * Math.sin(th) * (1 + (r0 * Math.cos(th)) / root))); }
    add(`Slider-crank r = 20, l = 70 mm (${mode})`, 'slider position vs r·cosθ + √(l² − r²sin²θ)', 'closed form', e(me) + ' mm max', e(me) + ' mm', '1e-6 mm', 'dt 1 ms, 3 revolutions');
    add(`Slider-crank (${mode})`, 'slider velocity vs closed form (peak 207 mm/s)', 'closed form', e(mv) + ' mm/s max', e(mv) + ' mm/s', mode === 'kinematic' ? '1e-6 mm/s' : '1.5 mm/s (mid-step velocity, O(h))', '90 rpm');
  }
}
{ // four-bar 60 s
  const p = EXAMPLES[0].build();
  const r = new SimRunner(p, { interference: false });
  let drift = 0; for (let i = 0; i < 600; i++) { r.advance(100); drift = Math.max(drift, r.sim.stats.driftBefore); }
  add('Four-bar showcase, 60 s (60 000 steps, 40 crank revolutions)', 'closed-loop joint error after projection (max over run)', '0', e(r.sim.stats.maxPosError) + ' mm', e(r.sim.stats.maxPosError) + ' mm', '1e-6 mm', 'dt 1 ms, dynamic');
  add('Four-bar showcase', 'drift produced by one step before projection (max)', '—', e(drift) + ' mm', 'removed each step', 'reported, not hidden', 'dt 1 ms');
}
{ // cam
  const segs = defaultParams('cam').segments;
  for (const mode of ['kinematic', 'dynamic'] as const) {
    const b = new Builder('cam', 't');
    const cam = b.part('cam', 'Cam', {}, { x: 0, y: 0 }), fol = b.part('follower', 'F', {}, { x: 0, y: 23 }, { massOverride: { mass: 0.02 } });
    const jc = b.revolute(GROUND, { x: 0, y: 0 }, cam, 'center'); b.prismatic(GROUND, { x: 0, y: 0 }, fol, 'roller', 'G', Math.PI / 2); b.cam(cam, fol, 'roller');
    b.spring(GROUND, { x: 0, y: 110 }, fol, 'top', 'S', 2000, 60, 0.2); b.motor(jc, { speed: 120 * RPM, maxTorque: null, rampTime: 0 });
    b.project.sim.mode = mode; b.project.sim.dt = 0.0005;
    const r = new SimRunner(b.solve().build(), { interference: false });
    let me = 0; for (let i = 0; i < 2000; i++) { r.advance(1); me = Math.max(me, Math.abs(r.poseOf(fol)!.y - (23 + camLift(segs, r.poseOf(cam)!.angle - Math.PI / 2).s))); }
    add(`Cam + roller follower, 120 rpm (${mode})`, 'follower height vs base + roller + lift(θ) of the motion program', 'cam program', e(me) + ' mm max', e(me) + ' mm', mode === 'kinematic' ? '1e-6 mm' : '2e-3 mm', 'dt 0.5 ms, 2 revolutions');
  }
}
{ // friction
  const run = (ratio: number) => { const b = new Builder('f', 't'); const box = b.part('baseplate', 'B', { width: 60, height: 20, thickness: 10, cornerRadius: 0, holes: [] }, { y: 10 }, { massOverride: { mass: 0.2 } }); b.project.sim.floor = { enabled: true, y: 0, friction: 0.5 }; b.forceLoad(box, { x: 0, y: -10 }, ratio * 0.2 * g, 0, 'P'); const r = new SimRunner(b.build()); r.advance(1000); return r.sim.q[0]; };
  const stick = run(0.45), slide = run(0.8), exp = 0.5 * 0.3 * g;
  add('Block on floor, μ = 0.5', 'displacement after 1 s, push 0.45·m·g (below μ·m·g)', '0 mm (sticks)', e(Math.abs(stick)) + ' mm', e(Math.abs(stick)) + ' mm', '1e-3 mm', 'dt 1 ms');
  add('Block on floor, μ = 0.5', 'displacement after 1 s, push 0.8·m·g', `${exp.toFixed(2)} mm (a = 0.3 g)`, slide.toFixed(2) + ' mm', e(Math.abs(slide - exp) / exp) + ' rel', '1e-2 rel', 'dt 1 ms');
}
{ // replay
  const p = EXAMPLES[4].build();
  const a = new SimRunner(p, { interference: false }), b = new SimRunner(p, { interference: false });
  a.advance(1200); a.advance(800); b.advance(2000);
  let same = true; for (let i = 0; i < a.sim.q.length; i++) if (a.sim.q[i] !== b.sim.q[i] || a.sim.v[i] !== b.sim.v[i]) same = false;
  add('Walker showcase, 2 s replayed twice (contact + friction)', 'state after 2000 steps, run A vs run B', 'identical', same ? 'bit-for-bit identical' : 'DIFFERENT', same ? '0' : '≠ 0', 'exact', 'dt 1 ms, 38 bodies');
  const total = a.model.bodies.reduce((s, x) => s + x.mass, 0);
  add('Walker showcase', 'total mass / weight', '—', `${(total * 1000).toFixed(1)} g / ${(total * g / 1000).toFixed(3)} N`, '—', '—', 'density × volume + motor');
}
mkdirSync('docs/verification', { recursive: true });
writeFileSync('docs/verification/analytic.json', JSON.stringify({ generated: new Date().toISOString(), node: process.version, rows }, null, 1));
const md = ['| Case | Quantity | Reference | Measured | Error | Tolerance (asserted in tests) | Settings |', '|---|---|---|---|---|---|---|', ...rows.map((r) => `| ${r.case} | ${r.quantity} | ${r.reference} | ${r.measured} | ${r.error} | ${r.tolerance} | ${r.settings} |`)].join('\n');
writeFileSync('docs/verification/analytic.md', `<!-- generated by scripts/measure.ts — do not edit by hand -->\n${md}\n`);
