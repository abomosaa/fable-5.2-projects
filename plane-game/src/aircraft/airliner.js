// Narrow-body twin-engine jet airliner (150-180 seat class) with fly-by-wire flight controls.

import { KT } from '../core/math.js';

const SUPERCRIT = { a0: 6.2, alpha0: -2.4, clMax: 1.5, clMin: -1.0, cd0: 0.0062, cm0: -0.07 };
const TAIL = { a0: 6.0, alpha0: 0, clMax: 1.2, clMin: -1.2, cd0: 0.006, cm0: 0 };

export default {
  id: 'airliner',
  name: 'Meridian 320',
  category: 'Twin-engine jet airliner',
  description: 'Sixty-five tonnes of momentum. Plan ahead: engines take seconds to spool, and stopping needs spoilers, reversers and brakes.',
  specs: { 'Thrust': '2 x 120 kN turbofan', 'Cruise': 'Mach 0.78', 'Approach': '138 kt', 'Mass': '63 t' },
  cg: [0, 0, 0],
  mass: { empty: 52000, fuelMax: 18700, refMass: 64000, inertia: [1.28e6, 4.88e6, 3.78e6] },
  downwashFactor: 1.0,
  retractable: { time: 8 },
  autoSpoilers: true,
  surfaces: [
    {
      kind: 'wing', name: 'wing', strips: 7, airfoil: SUPERCRIT,
      semiSpan: 17.05, rootChord: 5.9, tipChord: 1.45, sweepLE: 27, dihedral: 5,
      incidence: 3.2, twist: -4.0, rootLE: [4.5, -0.7, 0], e: 0.82,
      controls: [
        { type: 'flap', from: 0.1, to: 0.74 },
        { type: 'spoiler', from: 0.3, to: 0.72 },
        { type: 'aileron', from: 0.76, to: 0.96, chordFrac: 0.26, eff: 1.7 },
      ],
      flapData: { dCl0: 1.12, dClMax: 1.5, dCd0: 0.07, dCm: -0.26 },
    },
    {
      kind: 'htail', name: 'stab', strips: 3, airfoil: TAIL,
      semiSpan: 6.2, rootChord: 4.2, tipChord: 1.3, sweepLE: 32, dihedral: 6,
      incidence: -1.0, rootLE: [-14.3, 0.95, 0], e: 0.8, downwash: 1, qFactor: 0.95,
      controls: [{ type: 'elevator', from: 0, to: 1, allMoving: true }],
    },
    {
      kind: 'vtail', name: 'fin', strips: 3, airfoil: TAIL,
      semiSpan: 5.9, rootChord: 5.6, tipChord: 1.8, sweepLE: 40,
      rootLE: [-12.5, 2.2, 0], e: 0.8, qFactor: 1.0,
      controls: [{ type: 'rudder', from: 0.05, to: 0.95, chordFrac: 0.3 }],
    },
  ],
  bodies: [
    { pos: [8, 0.3, 0], cdA: [1.0, 13, 14] },
    { pos: [-8, 0.4, 0], cdA: [0.22, 13, 19] },
    { pos: [0.5, -2.7, 0], cdA: [2.4, 0, 0.5], gear: true },
  ],
  wave: [[0.72, 0], [0.76, 0.0003], [0.78, 0.001], [0.8, 0.0025], [0.82, 0.005], [0.85, 0.012],
         [0.88, 0.025], [0.92, 0.05], [1.0, 0.1], [1.3, 0.12]],
  engines: [
    { type: 'jet', bypass: 'high', thrust: 120000, idleN1: 0.22, spoolRate: 0.13, tsfc: 1.0e-5,
      pos: [1.9, -1.4, -5.75], reverser: true, sound: 'turbofan' },
    { type: 'jet', bypass: 'high', thrust: 120000, idleN1: 0.22, spoolRate: 0.13, tsfc: 1.0e-5,
      pos: [1.9, -1.4, 5.75], reverser: true, sound: 'turbofan' },
  ],
  gear: [
    { name: 'nose', pos: [11.4, -3.2, 0], travel: 0.4, k: 360000, c: 47000, radius: 0.38, steer: 42 },
    { name: 'left', pos: [-1.5, -3.25, -3.8], travel: 0.5, k: 1090000, c: 140000, radius: 0.58, brake: true },
    { name: 'right', pos: [-1.5, -3.25, 3.8], travel: 0.5, k: 1090000, c: 140000, radius: 0.58, brake: true },
  ],
  contactPoints: [
    { name: 'nose', type: 'nose', pos: [18.4, 0.2, 0] },
    { name: 'bellyF', type: 'belly', pos: [8, -1.62, 0] },
    { name: 'bellyA', type: 'belly', pos: [-6, -1.6, 0] },
    { name: 'tail', type: 'tail', pos: [-13.5, -0.55, 0] },
    { name: 'podL', type: 'belly', pos: [2.6, -2.45, -5.75] },
    { name: 'podR', type: 'belly', pos: [2.6, -2.45, 5.75] },
    { name: 'tipL', type: 'wing', pos: [-5.2, 0.8, -17.05] },
    { name: 'tipR', type: 'wing', pos: [-5.2, 0.8, 17.05] },
    { name: 'fin', type: 'wing', pos: [-18, 8.6, 0] },
    { name: 'roof', type: 'wing', pos: [6, 2.45, 0] },
  ],
  controls: {
    elevUp: 16, elevDown: 10, aileron: 22, rudder: 25, trimRange: 4, trimTakeoff: 0,
    qRefPitch: 9000, qRefRoll: 9000, qRefYaw: 4200, rate: 32, arBeta: 3.0, arRate: 1.5,
    fbw: {
      nMax: 2.5, nMin: -1.0, alphaMax: 14, alphaMin: -5, rollRate: 15, bankLimit: 67, pathStable: true,
      kp: 0.25, ki: 0.5, kq: 1.6, qRef: 6500, qMin: 1900, kRoll: 4.0,
    },
  },
  flaps: { settings: [0, 8, 15, 22, 35], labels: ['UP', '1', '2', '3', 'FULL'], max: 35, time: 22 },
  steerFadeSpeed: 12,
  limits: {
    gPos: 2.5, gNeg: -1.0, vne: 350 * KT, mmo: 0.82, vfe: 177 * KT, vle: 280 * KT,
    gearCrashSink: 5.5, bodyCrashSink: 3.5, scrapeCrashSpeed: 55, brakeMu: 0.62,
  },
  speeds: { vr: 145 * KT, vy: 250 * KT, cruise: 290 * KT, approach: 140 * KT },
  autopilot: { vs: 10, bank: 25, thrKp: 0.035, thrKi: 0.008, thrKd: 0.25, gammaGain: 0.3, altGain: 0.1 },
  view: { pilot: [15.9, 1.15, -0.5], chase: 62, height: 13 },
};
