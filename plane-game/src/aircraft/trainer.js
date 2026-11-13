// Four-seat high-wing piston trainer (in the class of the classic 180 hp club aircraft).
// All positions are metres relative to the centre of gravity: +X forward, +Y up, +Z right.

import { HP, KT } from '../core/math.js';

const NACA2412 = { a0: 6.1, alpha0: -2.1, clMax: 1.6, clMin: -1.15, cd0: 0.0078, cm0: -0.045 };
const NACA0009 = { a0: 6.0, alpha0: 0, clMax: 1.15, clMin: -1.15, cd0: 0.0072, cm0: 0 };

export default {
  id: 'trainer',
  name: 'Kestrel 180',
  category: 'Single-engine piston trainer',
  description: 'Forgiving high-wing trainer. Gentle stall, fixed gear, fixed-pitch propeller. The perfect place to start.',
  specs: { 'Engine': '180 hp flat-four', 'Cruise': '120 kt', 'Stall (flaps)': '48 kt', 'Ceiling': '14,000 ft' },
  cg: [0, 0, 0],
  mass: { empty: 905, fuelMax: 144, refMass: 1043, inertia: [1285, 2667, 1825] },
  downwashFactor: 1.05,
  surfaces: [
    {
      kind: 'wing', name: 'wing', strips: 6, airfoil: NACA2412,
      semiSpan: 5.5, rootChord: 1.72, tipChord: 1.22, sweepLE: 1.5, dihedral: 3.6,   // geometric 1.7 deg + high-wing/fuselage interference
      incidence: 1.5, twist: -3.0, rootLE: [0.47, 0.82, 0], e: 0.8,
      controls: [
        { type: 'flap', from: 0.08, to: 0.5 },
        { type: 'aileron', from: 0.5, to: 0.96, chordFrac: 0.25, eff: 0.8 },
      ],
      flapData: { dCl0: 0.95, dClMax: 0.78, dCd0: 0.06, dCm: -0.19 },
      propwash: [{ from: 0, to: 0.17, frac: 0.55 }],
    },
    {
      kind: 'htail', name: 'stab', strips: 2, airfoil: NACA0009,
      semiSpan: 1.72, rootChord: 1.15, tipChord: 0.76, sweepLE: 6, dihedral: 0,
      incidence: -1.5, rootLE: [-4.0, 0.12, 0], e: 0.8, downwash: 1, qFactor: 0.92,
      controls: [{ type: 'elevator', from: 0, to: 1, chordFrac: 0.42 }],
      propwash: [{ from: 0, to: 0.5, frac: 0.65 }],
    },
    {
      kind: 'vtail', name: 'fin', strips: 2, airfoil: NACA0009,
      semiSpan: 1.62, rootChord: 1.42, tipChord: 0.72, sweepLE: 35,
      rootLE: [-3.75, 0.28, 0], e: 0.8, swirl: 0.15, qFactor: 0.95,
      controls: [{ type: 'rudder', from: 0, to: 1, chordFrac: 0.4 }],
      propwash: [{ from: 0, to: 0.6, frac: 0.6 }],
    },
  ],
  bodies: [
    { pos: [0.75, -0.05, 0], cdA: [0.265, 1.3, 1.3] },      // cowling + cabin + wing struts
    { pos: [-2.4, 0.05, 0], cdA: [0.02, 1.0, 1.4] },        // tail cone
    { pos: [0.1, -1.0, 0], cdA: [0.1, 0.05, 0.12] },        // fixed landing gear
  ],
  engines: [{
    type: 'piston', power: 180 * HP, ratedRpm: 2700, idleRpm: 680, pos: [1.78, 0.02, 0], dir: 1,
    prop: { diameter: 1.93, blades: 2, pitch: 21.2, cMax: 0.15, inertia: 1.15 },
    sound: 'flat4',
  }],
  gear: [
    { name: 'nose', pos: [1.42, -1.2, 0], travel: 0.2, k: 26000, c: 2100, radius: 0.18, steer: 16 },
    { name: 'left', pos: [-0.44, -1.24, -1.27], travel: 0.25, k: 40000, c: 3000, radius: 0.21, brake: true },
    { name: 'right', pos: [-0.44, -1.24, 1.27], travel: 0.25, k: 40000, c: 3000, radius: 0.21, brake: true },
  ],
  contactPoints: [
    { name: 'prop', type: 'prop', pos: [1.85, -0.9, 0] },
    { name: 'nose', type: 'nose', pos: [2.05, -0.1, 0] },
    { name: 'belly', type: 'belly', pos: [0.2, -0.72, 0] },
    { name: 'tail', type: 'tail', pos: [-5.1, -0.05, 0] },
    { name: 'tipL', type: 'wing', pos: [0.0, 0.98, -5.5] },
    { name: 'tipR', type: 'wing', pos: [0.0, 0.98, 5.5] },
    { name: 'fin', type: 'wing', pos: [-5.0, 1.95, 0] },
    { name: 'roof', type: 'wing', pos: [0.3, 1.05, 0] },
  ],
  controls: {
    elevUp: 28, elevDown: 23, aileron: 17.5, rudder: 17, trimRange: 11, trimTakeoff: 0.3,
    qRefPitch: 1200, qRefRoll: 1700, qRefYaw: 1400, rate: 100, autoTrimRate: 0.2,
    rigAileron: 0.187, rigRudder: 0.59, rigTorque: 0.69,
  },
  flaps: { settings: [0, 10, 20, 30], max: 30, time: 6 },
  limits: {
    gPos: 3.8, gNeg: -1.52, vne: 163 * KT, vno: 129 * KT, vfe: 85 * KT,
    gearCrashSink: 4.6, bodyCrashSink: 3.2, scrapeCrashSpeed: 24, brakeMu: 0.5,
  },
  speeds: { vr: 55 * KT, vy: 76 * KT, cruise: 118 * KT, approach: 65 * KT },
  autopilot: { vs: 3.5, bank: 22 },
  view: { pilot: [0.28, 0.62, -0.25], chase: 14, height: 3.2 },
};
