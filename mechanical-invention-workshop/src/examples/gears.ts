/** Showcase 2 — two-stage spur-gear reduction with a loaded output shaft. */
import { Builder } from '../core/model/builder';
import type { Project } from '../core/model/types';
import { RPM } from '../core/units';

export function buildGearReduction(): Project {
  const b = new Builder('Two-stage gear reduction', 'example-gears');
  const m = 2, z1 = 16, z2 = 48, z3 = 14, z4 = 56, face = 6, T = 4;
  const c12 = (m * (z1 + z2)) / 2, c34 = (m * (z3 + z4)) / 2;
  const P1 = { x: 0, y: 0 };
  const P2 = { x: c12 * Math.cos(0.35), y: c12 * Math.sin(0.35) };
  const P3 = { x: P2.x + c34 * Math.cos(-0.25), y: P2.y + c34 * Math.sin(-0.25) };
  const cx = (P1.x + P3.x) / 2, cy = 14;
  const plate = b.part('baseplate', 'Gearbox plate', {
    width: 260, height: 150, thickness: T, cornerRadius: 8,
    holes: [{ x: P1.x - cx, y: P1.y - cy, d: 5 }, { x: P2.x - cx, y: P2.y - cy, d: 5 }, { x: P3.x - cx, y: P3.y - cy, d: 6 }],
  }, { x: cx, y: cy, z: 0 }, { materialId: 'aluminum' });
  b.ground(plate);
  const z1a = T + 0.5, z2a = z1a + face + 0.5;
  const motor = b.part('motor', 'Motor', { shape: 'square', size: 28, bodyLength: 32, shaftDiameter: 5, shaftLength: z1a + face - 0.2, mass: 0.14 }, { x: 0, y: 0, z: 0 });
  b.rigid(plate, 'H1', motor, 'shaft', 'Motor mount');
  const g1 = b.part('gear', 'Pinion 16T', { module: m, teeth: z1, thickness: face, boreDiameter: 5 }, { ...P1, z: z1a }, { color: '#e8a33d' });
  const g2 = b.part('gear', 'Gear 48T', { module: m, teeth: z2, thickness: face, boreDiameter: 5 }, { ...P2, z: z1a }, { color: '#4c9fd8' });
  const g3 = b.part('gear', 'Pinion 14T', { module: m, teeth: z3, thickness: face, boreDiameter: 5 }, { ...P2, z: z2a }, { color: '#4c9fd8' });
  const g4 = b.part('gear', 'Output gear 56T', { module: m, teeth: z4, thickness: face, boreDiameter: 6 }, { ...P3, z: z2a }, { color: '#62c370' });
  const lay = b.part('shaft', 'Lay shaft', { diameter: 5, length: z2a + face + 1 }, { ...P2, z: 0 });
  const out = b.part('shaft', 'Output shaft', { diameter: 6, length: z2a + face + 16 }, { ...P3, z: 0 });
  const drum = b.part('pulley', 'Load drum', { pitchDiameter: 30, beltWidth: 8, beltThickness: 1, flangeHeight: 2.5, flangeThickness: 1.5, boreDiameter: 6 }, { ...P3, z: z2a + face + 1 }, { color: '#c9ced6', materialId: 'aluminum' });
  b.rigid(lay, 'center', g2, 'center', 'Gear 48T on lay shaft');
  b.rigid(lay, 'center', g3, 'center', 'Pinion 14T on lay shaft');
  b.rigid(out, 'center', g4, 'center', 'Output gear on shaft');
  b.rigid(out, 'center', drum, 'center', 'Drum on shaft');
  const jIn = b.revolute(plate, 'H1', g1, 'center', 'Input bearing (motor)', { pinDiameter: 5 });
  b.revolute(plate, 'H2', lay, 'center', 'Lay shaft bearing', { pinDiameter: 5, friction: 0 });
  const jOut = b.revolute(plate, 'H3', out, 'center', 'Output bearing', { pinDiameter: 6 });
  const mesh1 = b.gear(g1, g2, 'Mesh 16:48');
  const mesh2 = b.gear(g3, g4, 'Mesh 14:56');
  b.motor(jIn, { speed: 240 * RPM, maxTorque: 50000, rampTime: 0.4, type: 'servo' });
  // the load: a constant torque resisting the output's rotation (output turns the same way as the input: two reversals)
  const load = b.torqueLoad(drum, -300000, 'Output load torque');
  b.solve();

  const pIn = b.probeJoint('Input (motor)', jIn);
  const pOut = b.probeJoint('Output shaft', jOut);
  const pM1 = b.probeJoint('Mesh 16:48', mesh1);
  const pM2 = b.probeJoint('Mesh 14:56', mesh2);
  b.plot('Shaft speeds', [{ probe: pIn, quantity: 'rate' }, { probe: pOut, quantity: 'rate' }]);
  b.plot('Motor torque', [{ probe: pIn, quantity: 'torque' }]);
  b.plot('Tooth forces (ideal mesh)', [{ probe: pM1, quantity: 'toothForce' }, { probe: pM2, quantity: 'toothForce' }]);
  b.plot('Motor power', [{ probe: pIn, quantity: 'power' }]);

  const k = (id: string) => `part:${id}:teeth`;
  b.variant('12 : 1  (16:48 × 14:56)', 'Baseline. Motor torque ≈ load / 12.', { [k(g1)]: 16, [k(g2)]: 48, [k(g3)]: 14, [k(g4)]: 56, [`load:${load}:torque`]: -300000 });
  b.variant('5.5 : 1  (20:44 × 20:50)', 'Taller gearing: the same load now needs 54.5 N·mm, more than the motor\'s 50 N·mm limit — the load overhauls the motor.', { [k(g1)]: 20, [k(g2)]: 44, [k(g3)]: 20, [k(g4)]: 50, [`load:${load}:torque`]: -300000 });
  b.variant('12 : 1 with triple load', 'Load raised to 0.9 N·m: needs 75 N·mm at the motor, more than its limit — the load drives the train backwards.', { [k(g1)]: 16, [k(g2)]: 48, [k(g3)]: 14, [k(g4)]: 56, [`load:${load}:torque`]: -900000 });
  const p = b.project;
  p.activeVariant = p.variants[0].id;
  p.sim.mode = 'dynamic';
  p.sim.gravityEnabled = true;
  p.description = [
    'A two-stage reduction: 16-tooth pinion → 48-tooth gear, sharing a lay shaft with a 14-tooth pinion → 56-tooth output gear (module 2). Overall ratio (48/16)·(56/14) = 12 : 1. A constant 0.3 N·m torque loads the output drum.',
    'Change any tooth count: the involute geometry is regenerated, the shafts (and their holes in the plate) move to the new centre distance m·(z₁+z₂)/2, the teeth are re-phased, and the speed ratio and motor torque in the plots follow.',
    'Gear meshes are IDEAL rolling couplings at the pitch point (no tooth-by-tooth contact, backlash dynamics or friction losses). The drawn teeth are true involutes phased consistently with that constraint; the interference checker verifies they do not overlap.',
    'The motor is torque-limited (50 N·mm) and the load behaves like a weight on the drum: when the ratio or the load asks for more than the limit, the diagnostics report the motor saturating and being driven backwards.',
  ].join('\n\n');
  p.views = [
    { name: 'Front', position: [cx, cy, 500], target: [cx, cy, 8], ortho: true, zoom: 2.4 },
    { name: 'Three-quarter', position: [cx + 190, cy + 130, 300], target: [cx, cy, 8], ortho: false },
  ];
  return b.build();
}
