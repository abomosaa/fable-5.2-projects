/**
 * Project document model. Everything here is DESIGN data: it is what gets
 * saved, undone/redone and exported. Transient simulation state never lives in
 * this structure (see core/sim).
 *
 * Units: mm, kg, s, rad (see core/units.ts). Force mN, torque mN·mm.
 */
import type { Sketch } from '../sketch/types';
import type { UnitPrefs } from '../units';

export type PartKind =
  | 'link' | 'gear' | 'rack' | 'shaft' | 'bearing' | 'cam' | 'follower'
  | 'pulley' | 'rail' | 'slider' | 'crank' | 'baseplate' | 'plate'
  | 'fastener' | 'motor';

export interface Pose {
  x: number;
  y: number;
  /** rotation about +Z, rad */
  angle: number;
  /** offset of the part's local z = 0 plane along the stacking axis, mm */
  z: number;
}

export interface CamSegment {
  /** angular extent of this segment, rad */
  duration: number;
  /** follower lift at the END of the segment, mm above the base circle */
  lift: number;
  law: 'dwell' | 'cycloidal' | 'harmonic' | 'poly345' | 'linear';
}

export interface PlateHole { x: number; y: number; d: number }

export interface Part {
  id: string;
  name: string;
  kind: PartKind;
  /** kind-specific parameters; numeric values in internal units */
  params: Record<string, any>;
  pose: Pose;
  /** fixed to the world frame */
  grounded: boolean;
  suppressed?: boolean;
  materialId: string;
  /** optional explicit mass properties overriding density × geometry */
  massOverride?: { mass?: number; inertia?: number };
  groupId?: string;
  color?: string;
}

/** A point on a part: either a named geometric feature or explicit local coordinates. */
export interface Anchor {
  port?: string;
  x?: number;
  y?: number;
}

export type JointType = 'revolute' | 'prismatic' | 'rigid' | 'gear' | 'rackPinion' | 'belt' | 'cam' | 'spring';

export const GROUND = 'ground';

export interface MotorSpec {
  enabled: boolean;
  /** 'servo': speed regulated up to maxTorque. 'dc': linear torque–speed curve
   *  (stall torque = maxTorque at zero speed, zero torque at `speed`). */
  type: 'servo' | 'dc';
  /** target (servo) or no-load (dc) speed: rad/s for revolute, mm/s for prismatic */
  speed: number;
  /** torque limit mN·mm (force limit mN for prismatic); null = ideal, unlimited */
  maxTorque: number | null;
  /** time to ramp from rest to target speed, s */
  rampTime: number;
  profile: 'constant' | 'reversing';
  /** for 'reversing': time between direction changes, s */
  period?: number;
}

export interface Joint {
  id: string;
  name: string;
  type: JointType;
  /** part id or GROUND */
  a: string;
  b: string;
  anchorA: Anchor;
  anchorB: Anchor;
  suppressed?: boolean;

  /** prismatic: slide direction in part A's frame (rad from A's +x) */
  axisAngle?: number;
  /** rigid: angle of B relative to A (rad) */
  angle?: number;

  /** revolute/prismatic travel limits, measured from the as-designed pose */
  limits?: { enabled: boolean; lower: number; upper: number };
  motor?: MotorSpec;
  /** Coulomb friction: torque mN·mm (revolute) or force mN (prismatic) */
  friction?: number;
  /** viscous damping: mN·mm·s/rad (revolute) or mN·s/mm (prismatic) */
  damping?: number;
  /** revolute pin diameter for hardware / BOM, mm */
  pinDiameter?: number;

  /** belt */
  crossed?: boolean;
  beltWidth?: number;
  beltThickness?: number;

  /** spring (linear, between the two anchors) */
  stiffness?: number;      // mN/mm
  /** free length mm; if undefined it is derived from `preload` at the design pose */
  freeLength?: number;
  /** force at the as-designed length, mN (positive = spring is stretched / pulls anchors together) */
  preload?: number;
  springDamping?: number;  // mN·s/mm
  coilDiameter?: number;
  wireDiameter?: number;
  coils?: number;
}

export interface Load {
  id: string;
  name: string;
  type: 'force' | 'torque';
  part: string;
  anchor: Anchor;
  /** force components, mN */
  fx: number;
  fy: number;
  /** torque about +Z, mN·mm */
  torque: number;
  /** 'world': fixed direction; 'part': direction rotates with the part */
  frame: 'world' | 'part';
  enabled: boolean;
  /** active window, s (undefined = always) */
  tStart?: number;
  tEnd?: number;
}

export interface Probe {
  id: string;
  name: string;
  /** point probe on a part, or a joint probe */
  target: { kind: 'point'; part: string; anchor: Anchor } | { kind: 'joint'; joint: string } | { kind: 'part'; part: string } | { kind: 'system' };
  /** draw the path of a point probe in the viewport */
  trace: boolean;
  color: string;
}

/** identifies one plotted time series */
export interface Channel {
  probe: string;
  quantity: string;
}

export interface PlotSpec {
  id: string;
  title: string;
  channels: Channel[];
}

export interface Group {
  id: string;
  name: string;
  collapsed?: boolean;
}

export interface Material {
  id: string;
  name: string;
  /** kg/mm³ */
  density: number;
  color: string;
  metalness: number;
  roughness: number;
  /** process hint for BOM */
  process: string;
  /** friction multiplier applied to the floor coefficient for parts of this material */
  frictionFactor?: number;
}

export interface Clearances {
  /** added to every pin/shaft hole DIAMETER so pins turn freely, mm */
  hole: number;
  /** gap per side between a slider and its slot, mm */
  slide: number;
  /** circular backlash: each gear tooth is thinned by half of this at the pitch circle, mm */
  backlash: number;
  /** minimum printable wall / feature size used by the export checker, mm */
  minFeature: number;
}

export interface SimSettings {
  mode: 'kinematic' | 'dynamic';
  /** fixed physical timestep, s */
  dt: number;
  gravity: { x: number; y: number };
  gravityEnabled: boolean;
  floor: { enabled: boolean; y: number; friction: number };
  /** pause automatically when interference between parts is detected */
  stopOnInterference: boolean;
  /** recording rate for probes, Hz */
  sampleRate: number;
}

export interface CameraView {
  name: string;
  position: [number, number, number];
  target: [number, number, number];
  ortho: boolean;
  zoom?: number;
}

/** Named alternative parameter set ("configuration"). */
export interface Variant {
  id: string;
  name: string;
  note: string;
  /** keys: "part:<id>:<param>", "joint:<id>:<field.path>", "sim:<field.path>", "load:<id>:<field>" */
  values: Record<string, any>;
}

export interface Project {
  format: 'mechanism-workshop';
  version: 1;
  id: string;
  name: string;
  /** short explanation shown in the app (plain text with blank-line paragraphs) */
  description: string;
  createdAt: string;
  modifiedAt: string;
  parts: Part[];
  joints: Joint[];
  loads: Load[];
  probes: Probe[];
  plots: PlotSpec[];
  groups: Group[];
  sketches: Sketch[];
  variants: Variant[];
  activeVariant?: string;
  views: CameraView[];
  sim: SimSettings;
  clearances: Clearances;
  units: UnitPrefs;
  /** user materials (built-ins are always available) */
  materials: Material[];
}
