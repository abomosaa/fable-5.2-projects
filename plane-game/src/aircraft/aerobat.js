// Unlimited-category aerobatic monoplane: 315 hp, symmetric wing, enormous ailerons,
// constant-speed propeller, tailwheel gear, +-10 g airframe.

import { HP, KT } from '../core/math.js';

const SYM = { a0: 6.0, alpha0: 0, clMax: 1.5, clMin: -1.5, cd0: 0.0075, cm0: 0 };
const TAIL = { a0: 6.0, alpha0: 0, clMax: 1.2, clMin: -1.2, cd0: 0.0072, cm0: 0 };

export default {
  id: 'aerobat',
  name: 'Vortex 330',
  category: 'Unlimited aerobatic monoplane',
  description: 'Carbon-fibre aerobat with a 400 deg/s roll rate and a +-10 g airframe. Tailwheel gear: keep it straight with your feet.',
  specs: { 'Engine': '315 hp flat-six', 'Top speed': '200 kt', 'Roll rate': '400 deg/s', 'Limits': '+10 / -10 g' },
  cg: [0, 0, 0],
  mass: { empty: 760, fuelMax: 120, refMass: 830, inertia: [560, 1950, 1500] },
  downwashFactor: 1.0,
  surfaces: [
    {
      kind: 'wing', name: 'wing', strips: 6, airfoil: SYM,
      semiSpan: 4.0, rootChord: 1.85, tipChord: 0.83, sweepLE: 3, dihedral: 1.0,
      incidence: 0, twist: 0, rootLE: [0.5, -0.28, 0], e: 0.82,
      controls: [{ type: 'aileron', from: 0.14, to: 0.98, chordFrac: 0.3, eff: 0.9 }],
      propwash: [{ from: 0, to: 0.24, frac: 0.6 }],
    },
    {
      kind: 'htail', name: 'stab', strips: 2, airfoil: TAIL,
      semiSpan: 1.6, rootChord: 1.05, tipChord: 0.65, sweepLE: 8, dihedral: 0,
      incidence: 0, rootLE: [-3.95, 0.22, 0], e: 0.8, downwash: 1, qFactor: 0.95,
      controls: [{ type: 'elevator', from: 0, to: 1, chordFrac: 0.5 }],
      propwash: [{ from: 0, to: 0.6, frac: 0.7 }],
    },
    {
      kind: 'vtail', name: 'fin', strips: 2, airfoil: TAIL,
      semiSpan: 1.5, rootChord: 1.45, tipChord: 0.7, sweepLE: 25,
      rootLE: [-3.8, 0.25, 0], e: 0.8, swirl: 0.15, qFactor: 0.97,
      controls: [{ type: 'rudder', from: 0, to: 1, chordFrac: 0.5 }],
      propwash: [{ from: 0, to: 0.7, frac: 0.7 }],
    },
  ],
  bodies: [
    { pos: [0.9, 0, 0], cdA: [0.1, 0.9, 2.0] },
    { pos: [-2.1, 0.05, 0], cdA: [0.0, 0.8, 2.4] },
    { pos: [0.5, -0.9, 0], cdA: [0.055, 0.03, 0.08] },
  ],
  engines: [{
    type: 'piston', power: 315 * HP, ratedRpm: 2700, idleRpm: 720, pos: [1.75, 0, 0], dir: 1,
    prop: { diameter: 2.0, blades: 3, constantSpeed: { min: 13, max: 42 }, designPitch: 24, cMax: 0.155, inertia: 1.9 },
    sound: 'flat6',
  }],
  gear: [
    { name: 'left', pos: [0.55, -1.15, -0.95], travel: 0.2, k: 40000, c: 3100, radius: 0.2, brake: true },
    { name: 'right', pos: [0.55, -1.15, 0.95], travel: 0.2, k: 40000, c: 3100, radius: 0.2, brake: true },
    { name: 'tail', pos: [-4.6, -0.42, 0], travel: 0.1, k: 24000, c: 1500, radius: 0.08, steer: 24 },
  ],
  contactPoints: [
    { name: 'prop', type: 'prop', pos: [1.9, -0.98, 0] },
    { name: 'nose', type: 'nose', pos: [2.15, 0, 0] },
    { name: 'belly', type: 'belly', pos: [0.3, -0.6, 0] },
    { name: 'tail', type: 'tail', pos: [-4.95, 0.05, 0] },
    { name: 'tipL', type: 'wing', pos: [0.05, -0.2, -4.0] },
    { name: 'tipR', type: 'wing', pos: [0.05, -0.2, 4.0] },
    { name: 'fin', type: 'wing', pos: [-4.7, 1.78, 0] },
    { name: 'canopy', type: 'wing', pos: [-0.4, 0.95, 0] },
  ],
  controls: {
    elevUp: 25, elevDown: 25, aileron: 30, rudder: 30, trimRange: 8, trimTakeoff: 0.3,
    qRefPitch: 3600, qRefRoll: 6200, qRefYaw: 3000, rate: 220, autoTrimRate: 0.16,
    rigAileron: 0.152, rigRudder: 0.3, rigTorque: 0.47, arBeta: 2.0, arRate: 0.5,
  },
  limits: {
    gPos: 10, gNeg: -10, vne: 220 * KT, vno: 158 * KT,
    gearCrashSink: 4.4, bodyCrashSink: 3.2, scrapeCrashSpeed: 22, brakeMu: 0.5,
  },
  speeds: { vr: 62 * KT, vy: 95 * KT, cruise: 160 * KT, approach: 80 * KT },
  autopilot: { vs: 6, bank: 30 },
  view: { pilot: [-0.55, 0.72, 0], chase: 11, height: 2.6 },
};
