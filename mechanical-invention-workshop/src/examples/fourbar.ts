/** Showcase 1 — motor-driven four-bar linkage with a coupler-point trace. */
import { Builder, GROUND } from '../core/model/builder';
import type { Project } from '../core/model/types';
import { RPM } from '../core/units';

export function buildFourBar(): Project {
  const b = new Builder('Four-bar linkage', 'example-fourbar');
  const T = 4;
  const ground = 100, crankL = 30, couplerL = 90, rockerL = 70;
  // frame: a plate carrying the two fixed pivots and the motor
  const plate = b.part('baseplate', 'Frame plate', {
    width: 150, height: 50, thickness: T, cornerRadius: 6,
    holes: [{ x: -50, y: 0, d: 5 }, { x: 50, y: 0, d: 4 }],
  }, { x: 50, y: 0, z: 0 }, { materialId: 'aluminum' });
  b.ground(plate);
  const motor = b.part('motor', 'Motor', { shape: 'square', size: 28, bodyLength: 30, shaftDiameter: 5, shaftLength: 7.5, mass: 0.11 }, { x: 0, y: 0, z: 0 });
  b.rigid(plate, 'H1', motor, 'shaft', 'Motor mount');
  const crank = b.part('link', 'Crank', { length: crankL, width: 12, thickness: T, holeDiameter: 5 }, { x: 0, y: 0, angle: Math.PI / 2, z: T + 0.5 }, { color: '#e8a33d' });
  const rocker = b.part('link', 'Rocker', { length: rockerL, width: 12, thickness: T, holeDiameter: 4 }, { x: ground, y: 0, angle: Math.PI / 2, z: T + 0.5 }, { color: '#4c9fd8' });
  const coupler = b.part('link', 'Coupler', { shape: 'ternary', length: couplerL, sideAC: 60, sideBC: 55, width: 12, thickness: T, holeDiameter: 4 }, { x: 0, y: crankL, angle: 0.4, z: 2 * T + 1 }, { color: '#62c370' });
  const jCrank = b.revolute(plate, 'H1', crank, 'A', 'Crank pivot (motor)', { pinDiameter: 5 });
  const jA = b.revolute(crank, 'B', coupler, 'A', 'Crank pin', { pinDiameter: 4 });
  b.revolute(rocker, 'B', coupler, 'B', 'Coupler–rocker pin', { pinDiameter: 4 });
  const jRock = b.revolute(plate, 'H2', rocker, 'A', 'Rocker pivot', { pinDiameter: 4 });
  b.motor(jCrank, { speed: 40 * RPM, maxTorque: null, rampTime: 0.3 });
  b.solve();

  const trace = b.probePoint('Coupler point', coupler, { x: 45, y: 36 }, true, '#f2b44a');
  const pRock = b.probeJoint('Rocker pivot', jRock);
  const pMotor = b.probeJoint('Crank motor', jCrank);
  const pPin = b.probeJoint('Crank pin', jA);
  const sys = b.probeSystem('Solver');
  b.plot('Coupler point position', [{ probe: trace, quantity: 'x' }, { probe: trace, quantity: 'y' }]);
  b.plot('Rocker angle', [{ probe: pRock, quantity: 'coord' }]);
  b.plot('Motor torque', [{ probe: pMotor, quantity: 'torque' }]);
  b.plot('Crank pin reaction', [{ probe: pPin, quantity: 'reaction' }]);
  b.plot('Closed-loop joint error', [{ probe: sys, quantity: 'posError' }, { probe: sys, quantity: 'drift' }]);

  const key = (id: string, k: string) => `part:${id}:${k}`;
  b.variant('Crank-rocker (valid)', 'Grashof: 30 + 100 < 90 + 70, the crank is the shortest link and turns fully.', {
    [key(crank, 'length')]: 30, [key(coupler, 'length')]: 90, [key(coupler, 'sideAC')]: 60, [key(coupler, 'sideBC')]: 55, [key(rocker, 'length')]: 70,
  });
  b.variant('Invalid: crank too long (locks at dead-centre)', 'Non-Grashof: 55 + 100 > 60 + 70. The linkage assembles, but the crank cannot complete a turn and the run stops with a diagnosis.', {
    [key(crank, 'length')]: 55, [key(coupler, 'length')]: 60, [key(coupler, 'sideAC')]: 45, [key(coupler, 'sideBC')]: 40, [key(rocker, 'length')]: 70,
  });
  b.variant('Invalid: coupler too short (cannot assemble)', 'Crank 30 + coupler 20 + rocker 30 cannot span the 100 mm between the fixed pivots, so no assembled pose exists.', {
    [key(crank, 'length')]: 30, [key(coupler, 'length')]: 20, [key(coupler, 'sideAC')]: 18, [key(coupler, 'sideBC')]: 18, [key(rocker, 'length')]: 30,
  });
  const p = b.project;
  p.activeVariant = p.variants[0].id;
  p.sim.mode = 'dynamic';
  p.description = [
    'A crank-rocker four-bar: frame 100 mm, crank 30 mm, coupler 90 mm, rocker 70 mm. The motor turns the crank; the orange curve is the path of a point fixed to the green coupler plate.',
    'Drag the orange probe marker to trace any other coupler point — the path is recomputed from the recorded motion of the coupler. Edit any link length in the inspector and the assembly re-solves.',
    'Open Variants to try the two deliberately invalid configurations: one violates the Grashof condition and locks at a dead-centre during the run; the other cannot be assembled at all. Both produce a diagnosis instead of a broken animation.',
    'Dynamic mode: joint reactions and motor torque come from the constraint multipliers of the solver (ideal pins, rigid links, gravity on).',
  ].join('\n\n');
  p.views = [
    { name: 'Front', position: [50, 30, 400], target: [50, 30, 6], ortho: true, zoom: 3.4 },
    { name: 'Three-quarter', position: [190, 150, 260], target: [50, 25, 6], ortho: false },
  ];
  void GROUND;
  return b.build();
}
