/** Showcase 3 — plate cam with a spring-loaded translating roller follower. */
import { Builder, GROUND } from '../core/model/builder';
import type { Project } from '../core/model/types';
import { DEG, RPM } from '../core/units';

export function buildCamFollower(): Project {
  const b = new Builder('Cam and spring-loaded follower', 'example-cam');
  const T = 4, face = 6;
  const baseR = 20, rollerR = 6, lift = 12;
  const zc = T + 0.5;
  const plate = b.part('baseplate', 'Back plate', { width: 90, height: 190, thickness: T, cornerRadius: 6, holes: [{ x: 0, y: -55, d: 5 }] }, { x: 0, y: 55, z: 0 }, { materialId: 'aluminum' });
  b.ground(plate);
  const motor = b.part('motor', 'Motor', { shape: 'square', size: 28, bodyLength: 30, shaftDiameter: 5, shaftLength: zc + face - 0.2, mass: 0.11 }, { x: 0, y: 0, z: 0 });
  b.rigid(plate, 'H1', motor, 'shaft', 'Motor mount');
  const cam = b.part('cam', 'Cam', {
    profile: 'segments', baseRadius: baseR, rollerRadius: rollerR, thickness: face, boreDiameter: 5,
    segments: [
      { duration: 110 * DEG, lift, law: 'cycloidal' },
      { duration: 50 * DEG, lift, law: 'dwell' },
      { duration: 110 * DEG, lift: 0, law: 'cycloidal' },
      { duration: 90 * DEG, lift: 0, law: 'dwell' },
    ],
  }, { x: 0, y: 0, angle: Math.PI / 2 - 30 * DEG, z: zc }, { color: '#e8a33d' });   // follower (at +90°) sits on the final dwell: zero lift
  const stemW = 10;
  const follower = b.part('follower', 'Follower', { rollerDiameter: 2 * rollerR, stemWidth: stemW, stemLength: 95, thickness: face }, { x: 0, y: baseR + rollerR, z: zc }, { color: '#4c9fd8' });
  // open guide channel fixed to the plate; the stem runs between its two bars
  const guide = b.part('rail', 'Guide channel', { length: 36, slotWidth: stemW, width: 34, overtravel: 0, thickness: face, openEnds: true }, { x: 0, y: 62, angle: Math.PI / 2, z: zc }, { color: '#8a93a3' });
  b.rigid(plate, { x: 0, y: 7 }, guide, 'start', 'Guide fixed to plate');
  const jCam = b.revolute(plate, 'H1', cam, 'center', 'Cam shaft (motor)', { pinDiameter: 5 });
  const jGuide = b.prismatic(guide, 'start', follower, 'mid', 'Follower guide', undefined, { friction: 0 });
  const jContact = b.cam(cam, follower, 'roller', 'Cam contact');
  // compression spring between a fixed anchor above the follower and the stem top
  const jSpring = b.spring(GROUND, { x: 0, y: 160 }, follower, 'top', 'Return spring', 60, 62, 0.3, { coilDiameter: 9, wireDiameter: 0.9, coils: 9 });
  b.motor(jCam, { speed: 120 * RPM, maxTorque: null, rampTime: 0.3 });
  b.solve();

  const pF = b.probeJoint('Follower', jGuide);
  const pC = b.probeJoint('Cam contact', jContact);
  const pS = b.probeJoint('Return spring', jSpring);
  const pM = b.probeJoint('Cam motor', jCam);
  b.plot('Follower displacement', [{ probe: pF, quantity: 'coord' }]);
  b.plot('Follower velocity', [{ probe: pF, quantity: 'rate' }]);
  b.plot('Contact force & spring force', [{ probe: pC, quantity: 'contactForce' }, { probe: pS, quantity: 'force' }]);
  b.plot('Pressure angle', [{ probe: pC, quantity: 'pressureAngle' }]);
  b.plot('Motor torque', [{ probe: pM, quantity: 'torque' }]);
  const base = { [`joint:${jSpring}:stiffness`]: 60, [`joint:${jSpring}:freeLength`]: 62 };
  b.variant('120 rpm (follows the cam)', 'The spring keeps the roller on the profile for the whole revolution.', { ...base, [`joint:${jCam}:motor.speed`]: 120 * RPM });
  b.variant('1200 rpm (follower floats)', 'At this speed the profile decelerates the follower faster than the 0.06 N/mm spring can: the roller leaves the cam near the top of the rise and lands again later.', { ...base, [`joint:${jCam}:motor.speed`]: 1200 * RPM });
  b.variant('1200 rpm with a stiffer spring', 'Spring rate 0.4 N/mm restores contact, at the price of higher contact force and motor torque.', { [`joint:${jSpring}:stiffness`]: 400, [`joint:${jSpring}:freeLength`]: 62, [`joint:${jCam}:motor.speed`]: 1200 * RPM });
  const p = b.project;
  p.activeVariant = p.variants[0].id;
  p.sim.mode = 'dynamic';
  p.sim.dt = 0.00025;
  p.sim.sampleRate = 500;
  p.description = [
    'A plate cam (base circle R20, 12 mm lift: cycloidal rise over 110°, dwell 50°, cycloidal return 110°, dwell 90°) drives a roller follower that slides in a guide channel. A compression spring holds the roller on the cam.',
    'The follower is NOT given a prescribed motion. Cam and roller interact through a unilateral contact on the actual cam profile (the roller centre must stay outside the pitch curve, the cam surface being its inner offset by the roller radius). The spring, the follower mass and the cam speed decide whether contact is kept.',
    'Edit the motion program in the cam inspector (durations, lifts, motion laws) and the cam solid, the plots and the contact all change together. Try the 1200 rpm variant: the follower "floats" off the cam, which the diagnostics report with the time it happens.',
    'Plots: displacement and velocity are solver states of the guide joint; contact force is the contact multiplier; pressure angle is derived from the contact normal.',
  ].join('\n\n');
  p.views = [
    { name: 'Front', position: [0, 60, 420], target: [0, 60, 8], ortho: true, zoom: 2.9 },
    { name: 'Three-quarter', position: [170, 140, 260], target: [0, 55, 8], ortho: false },
  ];
  return b.build();
}
