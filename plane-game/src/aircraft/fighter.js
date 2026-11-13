// Single-engine supersonic multirole fighter with fly-by-wire controls and afterburner.

import { KT } from '../core/math.js';

const WING = { a0: 6.0, alpha0: -0.4, clMax: 1.55, clMin: -1.05, cd0: 0.0056, cm0: 0 };
const TAIL = { a0: 6.0, alpha0: 0, clMax: 1.25, clMin: -1.25, cd0: 0.0056, cm0: 0 };

export default {
  id: 'fighter',
  name: 'F-21 Peregrine',
  category: 'Supersonic fly-by-wire fighter',
  description: 'Afterburning turbofan, 9 g airframe and a fly-by-wire system that commands g and roll rate. Mach 2 at altitude.',
  specs: { 'Thrust': '76 kN dry / 129 kN afterburner', 'Top speed': 'Mach 2.0', 'Limits': '+9 / -3 g', 'Ceiling': '50,000 ft' },
  cg: [0, 0, 0],
  mass: { empty: 9000, fuelMax: 3200, refMass: 10900, inertia: [12875, 85552, 75674] },
  downwashFactor: 0.75,
  retractable: { time: 5 },
  surfaces: [
    {
      kind: 'wing', name: 'wing', strips: 5, airfoil: WING,
      semiSpan: 4.72, rootChord: 5.04, tipChord: 1.0, sweepLE: 40, dihedral: 0,
      incidence: 0, twist: -1.5, rootLE: [2.6, 0.05, 0], e: 0.78, liftEff: 1.1,
      controls: [
        { type: 'flap', from: 0.24, to: 0.76 },
        { type: 'aileron', from: 0.24, to: 0.76, chordFrac: 0.22 },
      ],
      flapData: { dCl0: 0.42, dClMax: 0.22, dCd0: 0.02, dCm: -0.06 },
    },
    {
      kind: 'htail', name: 'stab', strips: 2, airfoil: TAIL,
      semiSpan: 2.78, rootChord: 2.3, tipChord: 0.6, sweepLE: 40, dihedral: -10,
      incidence: 0, rootLE: [-4.2, -0.05, 0], e: 0.8, downwash: 1, qFactor: 1.0,
      controls: [{ type: 'elevator', from: 0.18, to: 1, allMoving: true }],
    },
    {
      kind: 'vtail', name: 'fin', strips: 2, airfoil: TAIL,
      semiSpan: 2.9, rootChord: 2.7, tipChord: 1.0, sweepLE: 47,
      rootLE: [-3.3, 0.65, 0], e: 0.8, qFactor: 1.0, endPlate: 1.4,
      controls: [{ type: 'rudder', from: 0.08, to: 0.88, chordFrac: 0.28 }],
    },
  ],
  bodies: [
    { pos: [3.2, 0.1, 0], cdA: [0.3, 3.2, 2.6] },
    { pos: [-2.8, 0, 0], cdA: [0.0, 3.5, 4.2] },
    { pos: [0.5, -1.2, 0], cdA: [0.36, 0, 0.1], gear: true },
    { pos: [-5.6, 0.1, 0], cdA: [0.95, 0, 0], spoiler: true },
  ],
  wave: [[0.8, 0], [0.9, 0.0015], [0.95, 0.006], [1.0, 0.016], [1.05, 0.027], [1.1, 0.031], [1.2, 0.031],
         [1.4, 0.027], [1.6, 0.024], [2.0, 0.0215], [2.5, 0.021]],
  engines: [{
    type: 'jet', bypass: 'low', thrust: 76300, abThrust: 129000, abDetent: 0.82, idleN1: 0.3,
    spoolRate: 0.24, tsfc: 2.1e-5, tsfcAB: 5.6e-5, pos: [-6.6, 0, 0], sound: 'turbofan-ab',
  }],
  gear: [
    { name: 'nose', pos: [3.9, -1.78, 0], travel: 0.3, k: 115000, c: 13000, radius: 0.23, steer: 32 },
    { name: 'left', pos: [-0.75, -1.75, -1.18], travel: 0.4, k: 228000, c: 26000, radius: 0.33, brake: true },
    { name: 'right', pos: [-0.75, -1.75, 1.18], travel: 0.4, k: 228000, c: 26000, radius: 0.33, brake: true },
  ],
  contactPoints: [
    { name: 'nose', type: 'nose', pos: [7.3, -0.15, 0] },
    { name: 'intake', type: 'belly', pos: [2.2, -1.0, 0] },
    { name: 'bellyL', type: 'belly', pos: [-1.0, -0.82, -0.75] },
    { name: 'bellyR', type: 'belly', pos: [-1.0, -0.82, 0.75] },
    { name: 'ventral', type: 'belly', pos: [-4.8, -0.85, 0] },
    { name: 'nozzle', type: 'tail', pos: [-7.4, -0.35, 0] },
    { name: 'tipL', type: 'wing', pos: [-1.6, 0.05, -4.72] },
    { name: 'tipR', type: 'wing', pos: [-1.6, 0.05, 4.72] },
    { name: 'fin', type: 'wing', pos: [-6.3, 3.5, 0] },
    { name: 'canopy', type: 'wing', pos: [3.3, 1.25, 0] },
  ],
  controls: {
    elevUp: 25, elevDown: 25, aileron: 21, rudder: 30, trimRange: 5, trimTakeoff: 0,
    qRefPitch: 13000, qRefRoll: 20000, qRefYaw: 9000, rate: 70, arBeta: 3.5, arRate: 1.2,
    fbw: {
      nMax: 9, nMin: -3, alphaMax: 25, alphaMin: -10, rollRate: 270,
      kp: 0.07, ki: 0.55, kq: 0.45, qRef: 15000, qMin: 2600, kRoll: 0.35,
    },
  },
  flaps: { settings: [0, 20], labels: ['UP', 'DN'], max: 20, time: 3, auto: 'gear' },
  steerFadeSpeed: 22,
  limits: {
    gPos: 9, gNeg: -3, vne: 800 * KT, mmo: 2.05, vle: 300 * KT,
    gearCrashSink: 5.0, bodyCrashSink: 3.5, scrapeCrashSpeed: 45, brakeMu: 0.6,
  },
  speeds: { vr: 145 * KT, vy: 350 * KT, cruise: 400 * KT, approach: 155 * KT },
  autopilot: { vs: 30, bank: 35, thrKp: 0.02, thrKi: 0.006 },
  view: { pilot: [3.35, 0.95, 0], chase: 22, height: 4.5 },
};
