/** Showcase 4 — belt-driven slider-crank. */
import { Builder } from '../core/model/builder';
import type { Project } from '../core/model/types';
import { RPM } from '../core/units';

export function buildSliderCrank(): Project {
  const b = new Builder('Belt-driven slider-crank', 'example-slidercrank');
  const T = 4;
  const C = 85;              // pulley centre distance
  const throwR = 18, rod = 85;
  const zp = T + 0.5;        // pulleys
  const pulleyW = 1.2 * 2 + 6 + 0.3;
  const zRod = zp + pulleyW + 0.5;
  const zSlide = zRod - 5 - 0.5;
  const railStart = C + rod - throwR - 4;
  const travel = 2 * throwR + 8;
  const plate = b.part('baseplate', 'Base plate', {
    width: 330, height: 96, thickness: T, cornerRadius: 6,
    holes: [{ x: -125, y: 0, d: 5 }, { x: -125 + C, y: 0, d: 5 }],
  }, { x: 125, y: 0, z: 0 }, { materialId: 'aluminum' });
  b.ground(plate);
  const motor = b.part('motor', 'Motor', { shape: 'square', size: 28, bodyLength: 30, shaftDiameter: 5, shaftLength: zp + pulleyW - 0.3, mass: 0.11 }, { x: 0, y: 0, z: 0 });
  b.rigid(plate, 'H1', motor, 'shaft', 'Motor mount');
  const p1 = b.part('pulley', 'Motor pulley', { pitchDiameter: 20, beltWidth: 6, beltThickness: 1.5, flangeHeight: 2, flangeThickness: 1.2, boreDiameter: 5 }, { x: 0, y: 0, z: zp }, { color: '#e8a33d' });
  const p2 = b.part('pulley', 'Crank pulley', { pitchDiameter: 70, beltWidth: 6, beltThickness: 1.5, flangeHeight: 2, flangeThickness: 1.2, boreDiameter: 5, pinRadius: throwR, pinDiameter: 4 }, { x: C, y: 0, z: zp }, { color: '#4c9fd8' });
  const conrod = b.part('link', 'Connecting rod', { length: rod, width: 11, thickness: T, holeDiameter: 4 }, { x: C + throwR, y: 0, angle: 0, z: zRod }, { color: '#62c370' });
  const riser = b.part('baseplate', 'Rail riser', { width: travel + 46, height: 30, thickness: zSlide - T, cornerRadius: 2, holes: [] }, { x: railStart + travel / 2, y: 0, z: T }, { materialId: 'aluminum' });
  b.rigid(plate, { x: railStart + travel / 2 - 125, y: 0 }, riser, 'center', 'Riser on plate');
  const rail = b.part('rail', 'Slotted guide', { length: travel, slotWidth: 10, width: 26, overtravel: 13, thickness: 5 }, { x: railStart, y: 0, z: zSlide }, { color: '#8a93a3' });
  b.rigid(riser, { x: -travel / 2, y: 0 }, rail, 'start', 'Guide on riser');
  const slider = b.part('slider', 'Slider', { length: 22, width: 10, thickness: 5, holeDiameter: 4 }, { x: C + throwR + rod, y: 0, z: zSlide }, { color: '#d08770' });
  const jM = b.revolute(plate, 'H1', p1, 'center', 'Motor shaft', { pinDiameter: 5 });
  const jC = b.revolute(plate, 'H2', p2, 'center', 'Crank shaft', { pinDiameter: 5 });
  const jBelt = b.belt(p1, p2, 'Drive belt', { beltWidth: 6, beltThickness: 1.5 });
  const jPin = b.revolute(p2, 'pin', conrod, 'A', 'Crank pin', { pinDiameter: 4 });
  const jWrist = b.revolute(conrod, 'B', slider, 'pin', 'Wrist pin', { pinDiameter: 4 });
  const jSlide = b.prismatic(rail, 'start', slider, 'pin', 'Slide', undefined, { friction: 150 });
  b.motor(jM, { speed: 180 * RPM, maxTorque: 80000, rampTime: 0.3, type: 'servo' });
  const load = b.forceLoad(slider, 'pin', -800, 0, 'Process force on slider', {});
  b.solve();

  const pS = b.probeJoint('Slider', jSlide);
  const pM = b.probeJoint('Motor', jM);
  const pB = b.probeJoint('Belt', jBelt);
  const pC = b.probeJoint('Crank shaft', jC);
  const pP = b.probeJoint('Crank pin', jPin);
  const pW = b.probePoint('Wrist pin', slider, 'pin', true, '#f2b44a');
  void jWrist; void pW;
  b.plot('Slider position', [{ probe: pS, quantity: 'coord' }]);
  b.plot('Slider velocity', [{ probe: pS, quantity: 'rate' }]);
  b.plot('Slider acceleration', [{ probe: pS, quantity: 'accel' }]);
  b.plot('Shaft speeds', [{ probe: pM, quantity: 'rate' }, { probe: pC, quantity: 'rate' }]);
  b.plot('Motor torque & belt pull', [{ probe: pM, quantity: 'torque' }, { probe: pB, quantity: 'toothForce' }]);
  b.plot('Crank pin reaction', [{ probe: pP, quantity: 'reaction' }]);
  const base = { [`part:${p2}:pinRadius`]: 18, [`part:${p1}:pitchDiameter`]: 20, [`joint:${jM}:motor.speed`]: 180 * RPM, [`load:${load}:fx`]: -800 };
  b.variant('Stroke 36 mm, 3.5 : 1 belt, 180 rpm', 'Baseline.', base);
  b.variant('Stroke 24 mm', 'Crank throw 12 mm: shorter stroke, lower slider speed and motor torque.', { ...base, [`part:${p2}:pinRadius`]: 12 });
  b.variant('Stroke 36 mm, 2.33 : 1 belt (30 mm motor pulley)', 'Larger motor pulley: the crank turns faster and the motor works harder.', { ...base, [`part:${p1}:pitchDiameter`]: 30 });
  b.variant('Stroke 60 mm (slider runs out of guide)', 'A 30 mm throw needs more travel than the guide slot offers: the slider hits the ends of the slot and the interference is reported with its time and overlap.', { ...base, [`part:${p2}:pinRadius`]: 30 });
  const p = b.project;
  p.activeVariant = p.variants[0].id;
  p.sim.mode = 'dynamic';
  p.description = [
    'A motor drives a small pulley; an (ideal, non-slipping, inextensible) belt turns the 3.5× larger crank pulley; a pin on that pulley drives a connecting rod and a slider in a slotted guide. A constant 0.8 N process force and a little guide friction act on the slider.',
    'Stroke = 2 × the crank pin radius of the large pulley. Change it (or a pulley diameter, the rod length, the motor speed) and the change propagates: pulley geometry → pin position → rod and slider pose → belt routing and ratio → plots.',
    'The belt is a kinematic coupling on the pitch circles (ratio = pitch diameters); its drawn path is the tangent-line routing of the same two circles and its pitch length is reported in the BOM. Belt stretch, slip and pre-tension are not modelled.',
    'The last variant makes the stroke longer than the guide: the slider runs into the end of the slot and the interference checker flags the pair with the time and overlap.',
  ].join('\n\n');
  p.views = [
    { name: 'Front', position: [125, 0, 520], target: [125, 0, 10], ortho: true, zoom: 2.6 },
    { name: 'Three-quarter', position: [300, 170, 300], target: [125, 0, 10], ortho: false },
  ];
  return b.build();
}
