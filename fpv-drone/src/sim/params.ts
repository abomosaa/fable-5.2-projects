/**
 * Physical description of an airframe. Every number here is a real, measurable
 * quantity in SI units - there are no "arcade" tuning knobs. The flight model in
 * drone.ts derives all behaviour (hover throttle, top speed, punch, prop wash,
 * battery sag, ...) from these.
 */

export interface RotorParams {
  /** Propeller radius [m]. */
  radius: number;
  /** Number of blades. */
  blades: number;
  /** Mean blade chord [m] (used for solidity sigma = N*c / (pi*R)). */
  chord: number;
  /** 2D lift-curve slope of the blade section at these Reynolds numbers [1/rad]. */
  liftSlope: number;
  /**
   * Effective blade pitch at 75% radius, measured from the zero-lift line [rad]
   * (geometric pitch angle + camber zero-lift offset).
   */
  pitch: number;
  /** Section profile drag polar: cd = cd0 + cd2 * alpha^2. */
  cd0: number;
  cd2: number;
  /** Mean blade angle of attack where lift stops growing [rad]. */
  alphaStall: number;
  /** Induced power factor (tip loss, non-uniform inflow). 1.0 = ideal momentum theory. */
  kappa: number;
  /** Thrust-vector tilt per unit advance ratio (blade flapping / flex) [rad]. */
  flapK: number;
  /** Polar moment of inertia of the propeller alone [kg m^2]. */
  inertia: number;
}

export interface MotorParams {
  /** Velocity constant [rpm/V]. */
  kv: number;
  /** Phase-to-phase equivalent DC resistance (hot winding + ESC FETs + wiring) [ohm]. */
  resistance: number;
  /**
   * Phase reactance per unit mechanical speed [ohm s/rad] (effective inductance
   * times pole pairs): X = reactance * omega. The torque-producing current sees
   * Z = R + X^2 / R. This is why a loaded motor only reaches ~65-70 % of KV*V.
   */
  reactance: number;
  /**
   * ESC switching / PWM-ripple loss coefficient [S]: P = k * V_bus^2 * d * (1 - d).
   * Vanishes at full duty; it is why part-throttle g/W on a thrust stand is lower
   * than the motor constants alone suggest.
   */
  pwmLoss: number;
  /** No-load current at the reference voltage [A] (iron + bearing losses). */
  noLoadCurrent: number;
  /** Voltage at which noLoadCurrent was measured [V]. */
  noLoadVoltage: number;
  /** Polar inertia of the rotating bell + magnets + shaft [kg m^2]. */
  bellInertia: number;
  /** ESC phase-current limit [A] (burst). Also limits active-braking current. */
  maxCurrent: number;
}

export interface BatteryParams {
  /** Series cell count. */
  cells: number;
  /** Capacity [Ah]. */
  capacityAh: number;
  /** DC internal resistance per cell [ohm]. */
  cellResistance: number;
  /** Battery lead + connector + ESC bus resistance [ohm]. */
  leadResistance: number;
  /** Constant avionics draw (FC, VTX, camera, RX) [W]. */
  avionicsPower: number;
}

export interface MassComponent {
  name: string;
  /** [kg] */
  mass: number;
  /** Centre position in the build frame (origin: centre of the arm plane) [m]. */
  pos: [number, number, number];
  /** Bounding box size used for the component's own inertia [m]. */
  size: [number, number, number];
}

export interface AirframeParams {
  /** Half track: lateral distance of motors from centreline [m]. */
  motorX: number;
  /** Half wheelbase: longitudinal distance of motors from centre [m]. */
  motorZ: number;
  /** Height of the rotor disc above the arm plane [m]. */
  rotorHeight: number;
  /** Mass breakdown; mass, CG and inertia tensor are computed from this. */
  components: MassComponent[];
  /** Drag areas Cd*A for flow along the body X (side), Y (top/bottom), Z (front/back) axes [m^2]. */
  dragArea: [number, number, number];
  /** Aerodynamic centre offset above the CG [m] (battery/top-plate side catches more air). */
  dragCenterY: number;
  /** Rotational drag coefficient about body axes [N m / (rad/s)^2]. */
  angularDrag: [number, number, number];
}

/** Collision sphere attached to the airframe (body frame, relative to CG). */
export interface ContactSphere {
  pos: [number, number, number];
  radius: number;
}

export interface PidGains {
  p: number;
  i: number;
  d: number;
  f: number;
}

export interface DroneTune {
  roll: PidGains;
  pitch: PidGains;
  yaw: PidGains;
}

export interface DroneParams {
  id: string;
  name: string;
  description: string;
  rotor: RotorParams;
  motor: MotorParams;
  battery: BatteryParams;
  frame: AirframeParams;
  /** Betaflight-scaled PID gains that suit this airframe. */
  tune: DroneTune;
  /** Visual scale hints for the 3D model. */
  visual: {
    propColor: number;
    frameColor: number;
    batteryColor: number;
  };
}

export interface MassProperties {
  mass: number;
  /** CG in build frame. */
  cg: [number, number, number];
  /** Principal moments about the CG along body X (pitch), Y (yaw), Z (roll) [kg m^2]. */
  inertia: [number, number, number];
}

/**
 * Mass, centre of gravity and principal inertia from a component list.
 * Each component is treated as a uniform box; the parallel-axis theorem moves it
 * to the common CG. Products of inertia are neglected (layouts are left/right
 * symmetric and nearly fore/aft symmetric).
 */
export function computeMassProperties(components: MassComponent[]): MassProperties {
  let m = 0, cx = 0, cy = 0, cz = 0;
  for (const c of components) {
    m += c.mass;
    cx += c.mass * c.pos[0];
    cy += c.mass * c.pos[1];
    cz += c.mass * c.pos[2];
  }
  cx /= m;
  cy /= m;
  cz /= m;
  let ixx = 0, iyy = 0, izz = 0;
  for (const c of components) {
    const [sx, sy, sz] = c.size;
    const dx = c.pos[0] - cx, dy = c.pos[1] - cy, dz = c.pos[2] - cz;
    ixx += (c.mass / 12) * (sy * sy + sz * sz) + c.mass * (dy * dy + dz * dz);
    iyy += (c.mass / 12) * (sx * sx + sz * sz) + c.mass * (dx * dx + dz * dz);
    izz += (c.mass / 12) * (sx * sx + sy * sy) + c.mass * (dx * dx + dy * dy);
  }
  return { mass: m, cg: [cx, cy, cz], inertia: [ixx, iyy, izz] };
}

function quadComponents(o: {
  motorX: number;
  motorZ: number;
  motorMass: number;
  motorSize: [number, number, number];
  propMass: number;
  propDia: number;
  rotorHeight: number;
  armMass: number;
  bodyMass: number;
  bodySize: [number, number, number];
  stackMass: number;
  camMass: number;
  vtxMass: number;
  miscMass: number;
  batteryMass: number;
  batterySize: [number, number, number];
  batteryY: number;
  extra?: MassComponent[];
}): MassComponent[] {
  const list: MassComponent[] = [];
  const corners: [number, number][] = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  for (const [sx, sz] of corners) {
    list.push({
      name: 'motor',
      mass: o.motorMass,
      pos: [sx * o.motorX, o.motorSize[1] / 2, sz * o.motorZ],
      size: o.motorSize,
    });
    list.push({
      name: 'prop',
      mass: o.propMass,
      pos: [sx * o.motorX, o.rotorHeight, sz * o.motorZ],
      // A spinning prop does not add to yaw inertia about its own axis (it is on a
      // bearing), so give it zero horizontal extent; the parallel-axis term remains.
      size: [0, 0.006, 0],
    });
    // Arm: slender bar from the centre to the motor.
    list.push({
      name: 'arm',
      mass: o.armMass,
      pos: [(sx * o.motorX) / 2, 0, (sz * o.motorZ) / 2],
      size: [o.motorX, 0.005, o.motorZ],
    });
  }
  list.push({ name: 'body', mass: o.bodyMass, pos: [0, o.bodySize[1] / 2, 0], size: o.bodySize });
  list.push({ name: 'stack', mass: o.stackMass, pos: [0, 0.012, 0], size: [0.036, 0.016, 0.036] });
  list.push({
    name: 'camera',
    mass: o.camMass,
    pos: [0, o.bodySize[1] * 0.6, -o.bodySize[2] / 2],
    size: [0.02, 0.02, 0.02],
  });
  list.push({
    name: 'vtx',
    mass: o.vtxMass,
    pos: [0, o.bodySize[1] * 0.5, o.bodySize[2] / 2 - 0.015],
    size: [0.03, 0.01, 0.03],
  });
  list.push({ name: 'misc', mass: o.miscMass, pos: [0, o.bodySize[1] * 0.5, 0], size: o.bodySize });
  list.push({
    name: 'battery',
    mass: o.batteryMass,
    pos: [0, o.batteryY, 0],
    size: o.batterySize,
  });
  if (o.extra) list.push(...o.extra);
  return list;
}

/* -------------------------------------------------------------------------- */
/*  Presets                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 5" freestyle quad: 2207 1750KV motors, 5.1x3.6x3 props, 6S 1300 mAh.
 * ~600 g all-up. Reference figures this preset reproduces (see `npm run bench`):
 *   static thrust  ~1.6-1.7 kgf / motor at ~38-40 A, ~27.5k rpm (thrust-stand data for this class)
 *   hover throttle ~15-20 %, hover power ~130 W
 *   top speed      ~150 km/h
 */
const FIVE_INCH_FREESTYLE: DroneParams = {
  id: 'freestyle5',
  name: '5" Freestyle - 6S 1300 mAh',
  description:
    '2207 1750KV motors, 5.1x3.6x3 props, 6S 1300 mAh LiPo, ~600 g. The classic do-everything FPV quad.',
  rotor: {
    radius: 0.0648,
    blades: 3,
    chord: 0.0155,
    liftSlope: 4.9,
    pitch: 0.3243,
    cd0: 0.024,
    cd2: 1.2,
    alphaStall: 0.26,
    kappa: 1.25,
    flapK: 0.3,
    inertia: 3.5e-6,
  },
  motor: {
    kv: 1750,
    resistance: 0.085,
    reactance: 3.372e-5,
    pwmLoss: 0.04,
    noLoadCurrent: 1.6,
    noLoadVoltage: 10,
    bellInertia: 2.3e-6,
    maxCurrent: 60,
  },
  battery: {
    cells: 6,
    capacityAh: 1.3,
    cellResistance: 0.0028,
    leadResistance: 0.005,
    avionicsPower: 9,
  },
  frame: {
    motorX: 0.0795,
    motorZ: 0.0795,
    rotorHeight: 0.026,
    components: quadComponents({
      motorX: 0.0795,
      motorZ: 0.0795,
      motorMass: 0.034,
      motorSize: [0.028, 0.02, 0.028],
      propMass: 0.0043,
      propDia: 0.1296,
      rotorHeight: 0.026,
      armMass: 0.012,
      bodyMass: 0.082,
      bodySize: [0.042, 0.03, 0.16],
      stackMass: 0.03,
      camMass: 0.01,
      vtxMass: 0.025,
      miscMass: 0.035,
      batteryMass: 0.22,
      batterySize: [0.038, 0.042, 0.076],
      batteryY: 0.053,
    }),
    dragArea: [0.0125, 0.0176, 0.0068],
    dragCenterY: 0.004,
    angularDrag: [4e-6, 6e-6, 3e-6],
  },
  tune: {
    roll: { p: 45, i: 80, d: 40, f: 120 },
    pitch: { p: 47, i: 84, d: 46, f: 125 },
    yaw: { p: 45, i: 80, d: 0, f: 120 },
  },
  visual: { propColor: 0x29b6f6, frameColor: 0x1b1b1d, batteryColor: 0x202428 },
};

/**
 * Same airframe carrying a ~125 g action camera on the top plate. Heavier,
 * lazier, higher hover throttle, more sag - how most freestyle footage is flown.
 */
const FIVE_INCH_GOPRO: DroneParams = {
  ...FIVE_INCH_FREESTYLE,
  id: 'freestyle5cam',
  name: '5" Freestyle + action camera',
  description:
    'The same 5" quad carrying a 125 g action camera. ~730 g: more inertia, more sag, longer stopping distance.',
  frame: {
    ...FIVE_INCH_FREESTYLE.frame,
    components: [
      ...FIVE_INCH_FREESTYLE.frame.components,
      { name: 'actioncam', mass: 0.125, pos: [0, 0.055, -0.062], size: [0.06, 0.045, 0.033] },
    ],
    dragArea: [0.0142, 0.0196, 0.0094],
    dragCenterY: 0.008,
  },
};

/**
 * 5" race build: lighter, hotter motors, more aggressive props, small pack.
 */
const FIVE_INCH_RACE: DroneParams = {
  id: 'race5',
  name: '5" Racer - 6S 1100 mAh',
  description:
    '2207 1950KV motors, 5.1x4.6x3 props, 6S 1100 mAh, ~505 g. Brutal acceleration, short flight time.',
  rotor: {
    radius: 0.0648,
    blades: 3,
    chord: 0.0148,
    liftSlope: 4.9,
    pitch: 0.3743,
    cd0: 0.024,
    cd2: 1.4,
    alphaStall: 0.27,
    kappa: 1.25,
    flapK: 0.3,
    inertia: 3.3e-6,
  },
  motor: {
    kv: 1950,
    resistance: 0.070,
    reactance: 2.78e-5,
    pwmLoss: 0.04,
    noLoadCurrent: 1.8,
    noLoadVoltage: 10,
    bellInertia: 2.3e-6,
    maxCurrent: 70,
  },
  battery: {
    cells: 6,
    capacityAh: 1.1,
    cellResistance: 0.003,
    leadResistance: 0.005,
    avionicsPower: 8,
  },
  frame: {
    motorX: 0.077,
    motorZ: 0.077,
    rotorHeight: 0.024,
    components: quadComponents({
      motorX: 0.077,
      motorZ: 0.077,
      motorMass: 0.032,
      motorSize: [0.028, 0.02, 0.028],
      propMass: 0.0042,
      propDia: 0.1296,
      rotorHeight: 0.024,
      armMass: 0.009,
      bodyMass: 0.058,
      bodySize: [0.036, 0.022, 0.13],
      stackMass: 0.026,
      camMass: 0.008,
      vtxMass: 0.016,
      miscMass: 0.025,
      batteryMass: 0.19,
      batterySize: [0.036, 0.036, 0.072],
      batteryY: 0.042,
    }),
    dragArea: [0.0105, 0.0158, 0.0056],
    dragCenterY: 0.003,
    angularDrag: [4e-6, 6e-6, 3e-6],
  },
  tune: {
    roll: { p: 42, i: 80, d: 34, f: 130 },
    pitch: { p: 44, i: 84, d: 38, f: 135 },
    yaw: { p: 36, i: 80, d: 0, f: 100 },
  },
  visual: { propColor: 0xff5252, frameColor: 0x151517, batteryColor: 0x26282c },
};

/**
 * 3" lightweight quad on 4S: much gentler, less energy in a crash, floaty.
 * A common "practice in the park" craft.
 */
const THREE_INCH: DroneParams = {
  id: 'three4s',
  name: '3" Lightweight - 4S 650 mAh',
  description:
    '1404 3800KV motors, 3x1.8x3 props, 4S 650 mAh, ~190 g. Gentle, floaty and forgiving - good for learning.',
  rotor: {
    radius: 0.0381,
    blades: 3,
    chord: 0.0098,
    liftSlope: 4.7,
    pitch: 0.294,
    cd0: 0.042,
    cd2: 1.68,
    alphaStall: 0.25,
    kappa: 1.35,
    flapK: 0.3,
    inertia: 2.6e-7,
  },
  motor: {
    kv: 3800,
    resistance: 0.19,
    reactance: 4.23e-5,
    pwmLoss: 0.02,
    noLoadCurrent: 0.6,
    noLoadVoltage: 10,
    bellInertia: 3.2e-7,
    maxCurrent: 22,
  },
  battery: {
    cells: 4,
    capacityAh: 0.65,
    cellResistance: 0.0075,
    leadResistance: 0.008,
    avionicsPower: 5,
  },
  frame: {
    motorX: 0.0495,
    motorZ: 0.0495,
    rotorHeight: 0.017,
    components: quadComponents({
      motorX: 0.0495,
      motorZ: 0.0495,
      motorMass: 0.0098,
      motorSize: [0.018, 0.012, 0.018],
      propMass: 0.0012,
      propDia: 0.0762,
      rotorHeight: 0.017,
      armMass: 0.0035,
      bodyMass: 0.022,
      bodySize: [0.028, 0.02, 0.095],
      stackMass: 0.012,
      camMass: 0.005,
      vtxMass: 0.008,
      miscMass: 0.012,
      batteryMass: 0.074,
      batterySize: [0.031, 0.027, 0.058],
      batteryY: 0.034,
    }),
    dragArea: [0.0058, 0.0082, 0.0034],
    dragCenterY: 0.003,
    angularDrag: [6e-7, 9e-7, 5e-7],
  },
  tune: {
    roll: { p: 48, i: 85, d: 38, f: 110 },
    pitch: { p: 50, i: 90, d: 42, f: 115 },
    yaw: { p: 45, i: 85, d: 0, f: 100 },
  },
  visual: { propColor: 0xffc107, frameColor: 0x1b1b1d, batteryColor: 0x2a2d31 },
};

export const DRONE_PRESETS: DroneParams[] = [
  FIVE_INCH_FREESTYLE,
  FIVE_INCH_GOPRO,
  FIVE_INCH_RACE,
  THREE_INCH,
];

export function getPreset(id: string): DroneParams {
  return DRONE_PRESETS.find((p) => p.id === id) ?? DRONE_PRESETS[0];
}

/** Derived constants, computed once per airframe. */
export interface DerivedParams {
  mass: number;
  inertia: [number, number, number];
  invInertia: [number, number, number];
  /** Rotor hub positions relative to the CG, body frame. Order: RR, FR, RL, FL (Betaflight). */
  rotorPos: [number, number, number][];
  /** Spin direction about body +Y: +1 = counter-clockwise seen from above. */
  rotorSpin: number[];
  /** Disc area [m^2]. */
  discArea: number;
  solidity: number;
  /** Motor torque / back-EMF constant [N m / A] = [V s / rad]. */
  kt: number;
  /** Total rotating inertia per motor [kg m^2]. */
  rotorInertia: number;
  /** Geometric centre of the arm plane relative to CG (body frame) - where the 3D model's origin sits. */
  modelOffset: [number, number, number];
  contactSpheres: ContactSphere[];
}

export function deriveParams(p: DroneParams): DerivedParams {
  const mp = computeMassProperties(p.frame.components);
  const { motorX: mx, motorZ: mz, rotorHeight } = p.frame;
  const oy = -mp.cg[1];
  const oz = -mp.cg[2];
  const ry = rotorHeight + oy;
  // Betaflight "props-in" Quad-X: 1 = rear right (CW), 2 = front right (CCW),
  // 3 = rear left (CCW), 4 = front left (CW). Body +Z is backwards.
  const rotorPos: [number, number, number][] = [
    [mx, ry, mz + oz],
    [mx, ry, -mz + oz],
    [-mx, ry, mz + oz],
    [-mx, ry, -mz + oz],
  ];
  const rotorSpin = [-1, 1, 1, -1];
  const R = p.rotor.radius;
  const kt = 60 / (2 * Math.PI * p.motor.kv);

  // Collision proxy: one sphere per prop disc, plus the body. The lowest point of
  // every sphere sits on the bottom plane of the frame so the quad rests flat.
  const bottom = -0.012 + oy; // bottom of the arms / landing pads
  const propSphere = Math.max(0.6 * R, 0.022);
  const bodyLen = p.frame.components.find((c) => c.name === 'body')?.size[2] ?? 0.12;
  const bat = p.frame.components.find((c) => c.name === 'battery');
  const batTop = bat ? bat.pos[1] + bat.size[1] / 2 + oy : 0.05;
  const bodyR = Math.max(0.02, (batTop - bottom) / 2);
  const contactSpheres: ContactSphere[] = [
    { pos: [mx, bottom + propSphere, mz + oz], radius: propSphere },
    { pos: [mx, bottom + propSphere, -mz + oz], radius: propSphere },
    { pos: [-mx, bottom + propSphere, mz + oz], radius: propSphere },
    { pos: [-mx, bottom + propSphere, -mz + oz], radius: propSphere },
    { pos: [0, bottom + bodyR, oz], radius: bodyR },
    { pos: [0, bottom + bodyR, oz - bodyLen / 2 + bodyR * 0.5], radius: bodyR },
    { pos: [0, bottom + bodyR, oz + bodyLen / 2 - bodyR * 0.5], radius: bodyR },
  ];

  return {
    mass: mp.mass,
    inertia: mp.inertia,
    invInertia: [1 / mp.inertia[0], 1 / mp.inertia[1], 1 / mp.inertia[2]],
    rotorPos,
    rotorSpin,
    discArea: Math.PI * R * R,
    solidity: (p.rotor.blades * p.rotor.chord) / (Math.PI * R),
    kt,
    rotorInertia: p.rotor.inertia + p.motor.bellInertia,
    modelOffset: [0, oy, oz],
    contactSpheres,
  };
}
