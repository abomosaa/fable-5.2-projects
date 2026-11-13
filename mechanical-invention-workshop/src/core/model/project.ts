import type {
  Anchor, Clearances, Joint, Material, Part, PartKind, Pose, Project, SimSettings,
} from './types';
import { GROUND } from './types';
import { DEFAULT_PREFS, G_STANDARD, UNIT_TABLE } from '../units';
import { PART_DEFS, defaultParams, partGeometry, findPort, type BuildContext, type PartGeometry } from '../parts/catalog';
import { areaProps, type Poly } from '../math/poly';
import { cleanContours, kernelReady } from '../geom/kernel';

export const BUILTIN_MATERIALS: Material[] = [
  { id: 'pla', name: 'PLA (printed)', density: 1.24e-6, color: '#d9dde3', metalness: 0.0, roughness: 0.55, process: '3D print (FDM)' },
  { id: 'petg', name: 'PETG (printed)', density: 1.27e-6, color: '#7fb7d8', metalness: 0.0, roughness: 0.4, process: '3D print (FDM)' },
  { id: 'abs', name: 'ABS', density: 1.04e-6, color: '#e9e4d4', metalness: 0.0, roughness: 0.5, process: '3D print (FDM)' },
  { id: 'nylon', name: 'Nylon PA12', density: 1.01e-6, color: '#f1efe9', metalness: 0.0, roughness: 0.6, process: '3D print (SLS)' },
  { id: 'pom', name: 'Acetal (POM)', density: 1.41e-6, color: '#f4f4f0', metalness: 0.0, roughness: 0.35, process: 'CNC mill / laser' },
  { id: 'acrylic', name: 'Acrylic', density: 1.18e-6, color: '#9fd3e6', metalness: 0.0, roughness: 0.12, process: 'Laser cut' },
  { id: 'plywood', name: 'Birch plywood', density: 0.68e-6, color: '#c9a271', metalness: 0.0, roughness: 0.8, process: 'Laser cut' },
  { id: 'aluminum', name: 'Aluminium 6061', density: 2.70e-6, color: '#c9ced6', metalness: 1.0, roughness: 0.32, process: 'CNC mill / waterjet' },
  { id: 'steel', name: 'Steel', density: 7.85e-6, color: '#a9afb8', metalness: 1.0, roughness: 0.28, process: 'Purchased / turned' },
  { id: 'brass', name: 'Brass', density: 8.50e-6, color: '#d8b45a', metalness: 1.0, roughness: 0.3, process: 'CNC turn' },
  { id: 'rubber', name: 'Rubber (TPU)', density: 1.21e-6, color: '#26282c', metalness: 0.0, roughness: 0.92, process: '3D print (TPU)', frictionFactor: 1.3 },
  { id: 'motor', name: 'Motor assembly', density: 4.0e-6, color: '#2b2e33', metalness: 0.6, roughness: 0.45, process: 'Purchased' },
];

export function materialOf(project: Project, id: string): Material {
  return project.materials.find((m) => m.id === id) ?? BUILTIN_MATERIALS.find((m) => m.id === id) ?? BUILTIN_MATERIALS[0];
}

export function allMaterials(project: Project): Material[] {
  const ids = new Set(project.materials.map((m) => m.id));
  return [...BUILTIN_MATERIALS.filter((m) => !ids.has(m.id)), ...project.materials];
}

export const DEFAULT_CLEARANCES: Clearances = { hole: 0.2, slide: 0.15, backlash: 0.1, minFeature: 0.8 };

export const DEFAULT_SIM: SimSettings = {
  mode: 'dynamic',
  dt: 0.001,
  gravity: { x: 0, y: -G_STANDARD },
  gravityEnabled: true,
  floor: { enabled: false, y: 0, friction: 0.8 },
  stopOnInterference: false,
  sampleRate: 250,
};

let idCounter = 0;
export function uid(prefix: string): string {
  idCounter++;
  const rnd = Math.floor(Math.random() * 1e9).toString(36);
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rnd}`;
}

/** Deterministic id generator for scripted project construction. */
export function makeIdGen(seed = ''): (prefix: string) => string {
  const n: Record<string, number> = {};
  return (prefix) => { n[prefix] = (n[prefix] ?? 0) + 1; return `${seed}${prefix}${n[prefix]}`; };
}

export function createProject(name = 'Untitled mechanism', id = uid('proj')): Project {
  const now = new Date().toISOString();
  return {
    format: 'mechanism-workshop', version: 1, id, name, description: '',
    createdAt: now, modifiedAt: now,
    parts: [], joints: [], loads: [], probes: [], plots: [], groups: [], sketches: [], variants: [], views: [],
    sim: structuredClone(DEFAULT_SIM),
    clearances: { ...DEFAULT_CLEARANCES },
    units: { ...DEFAULT_PREFS },
    materials: [],
  };
}

export function createPart(kind: PartKind, id: string, name?: string, params: Record<string, any> = {}, pose: Partial<Pose> = {}): Part {
  const def = PART_DEFS[kind];
  return {
    id, name: name ?? def.label, kind,
    params: { ...defaultParams(kind), ...params },
    pose: { x: 0, y: 0, angle: 0, z: 0, ...pose },
    grounded: false,
    materialId: def.defaultMaterial,
  };
}

export function buildCtx(project: Project): BuildContext {
  return { clearances: project.clearances, sketches: project.sketches };
}

export function geometryOf(project: Project, part: Part): PartGeometry {
  return partGeometry(part, buildCtx(project));
}

export function partById(project: Project, id: string): Part | undefined {
  return project.parts.find((p) => p.id === id);
}

/** local coordinates of an anchor on a part ([x,y] world coords if partId is GROUND) */
export function anchorLocal(project: Project, partId: string, anchor: Anchor): { x: number; y: number; ok: boolean; port?: ReturnType<typeof findPort> } {
  if (partId === GROUND) return { x: anchor.x ?? 0, y: anchor.y ?? 0, ok: true };
  const part = partById(project, partId);
  if (!part) return { x: 0, y: 0, ok: false };
  if (anchor.port !== undefined) {
    const port = findPort(geometryOf(project, part), anchor.port);
    if (!port) return { x: anchor.x ?? 0, y: anchor.y ?? 0, ok: false };
    return { x: port.x, y: port.y, ok: true, port };
  }
  return { x: anchor.x ?? 0, y: anchor.y ?? 0, ok: true };
}

export function localToWorld(pose: { x: number; y: number; angle: number }, lx: number, ly: number): { x: number; y: number } {
  const c = Math.cos(pose.angle), s = Math.sin(pose.angle);
  return { x: pose.x + c * lx - s * ly, y: pose.y + s * lx + c * ly };
}

export function worldToLocal(pose: { x: number; y: number; angle: number }, wx: number, wy: number): { x: number; y: number } {
  const c = Math.cos(pose.angle), s = Math.sin(pose.angle);
  const dx = wx - pose.x, dy = wy - pose.y;
  return { x: c * dx + s * dy, y: -s * dx + c * dy };
}

/** world position of an anchor at the DESIGN pose */
export function anchorWorld(project: Project, partId: string, anchor: Anchor): { x: number; y: number; ok: boolean } {
  const l = anchorLocal(project, partId, anchor);
  if (partId === GROUND) return l;
  const part = partById(project, partId);
  if (!part) return { x: 0, y: 0, ok: false };
  return { ...localToWorld(part.pose, l.x, l.y), ok: l.ok };
}

const cleaned = new WeakMap<object, Poly[]>();
/**
 * Contours of the actual region (union with holes subtracted). Raw contour lists can contain holes
 * that overlap each other or cut the outline; summing signed areas would then count material twice,
 * so mass properties use the same boolean result the exported solid is built from.
 */
function regionContours(contours: Poly[]): Poly[] {
  if (contours.length < 2 || !kernelReady()) return contours;
  let c = cleaned.get(contours);
  if (!c) {
    c = contours;
    try {
      const u = cleanContours(contours);
      // Use the boolean result only when it really differs (overlapping holes, holes cutting the outline).
      // Otherwise keep the raw contours so results are bit-identical with and without the kernel.
      const a0 = areaProps(contours).area, a1 = areaProps(u).area;
      if (Math.abs(a1 - a0) > 1e-7 * Math.max(Math.abs(a0), 1)) c = u;
    } catch { /* keep raw */ }
    cleaned.set(contours, c);
  }
  return c;
}

export interface MassProps { mass: number; cx: number; cy: number; inertia: number; volume: number }

/** Mass, centre of mass (part-local) and polar inertia about the COM (kg·mm²). */
export function massProps(project: Project, part: Part): MassProps {
  const g = geometryOf(project, part);
  const mat = materialOf(project, part.materialId);
  let V = 0, sx = 0, sy = 0;
  const pieces: { v: number; cx: number; cy: number; J: number; t: number }[] = [];
  for (const l of g.layers) {
    const a = areaProps(regionContours(l.contours));
    const t = l.z1 - l.z0;
    const v = a.area * t;
    V += v; sx += v * a.cx; sy += v * a.cy;
    pieces.push({ v, cx: a.cx, cy: a.cy, J: a.J, t });
  }
  if (V <= 1e-9) return { mass: 1e-6, cx: 0, cy: 0, inertia: 1e-6, volume: 0 };
  const cx = sx / V, cy = sy / V;
  let Jv = 0; // ∫ r² dV about COM
  for (const p of pieces) Jv += p.J * p.t + p.v * ((p.cx - cx) ** 2 + (p.cy - cy) ** 2);
  let mass = mat.density * V;
  let inertia = mat.density * Jv;
  const catalogMass = part.kind === 'motor' && part.params.mass > 0 ? part.params.mass : undefined;
  const mo = part.massOverride?.mass ?? catalogMass;
  if (mo !== undefined && mo > 0) { inertia *= mo / mass; mass = mo; }
  if (part.massOverride?.inertia !== undefined && part.massOverride.inertia > 0) inertia = part.massOverride.inertia;
  return { mass: Math.max(mass, 1e-9), cx, cy, inertia: Math.max(inertia, 1e-9), volume: V };
}

export function jointLabel(j: Joint): string {
  const names: Record<string, string> = {
    revolute: 'Revolute', prismatic: 'Prismatic', rigid: 'Rigid', gear: 'Gear mesh', rackPinion: 'Rack & pinion',
    belt: 'Belt', cam: 'Cam contact', spring: 'Spring',
  };
  return names[j.type] ?? j.type;
}

/** every quantity id a probe can offer (see sim/runner.ts quantitiesFor) */
const PLOT_QUANTITIES = ['x', 'y', 'vx', 'vy', 'speed', 'ax', 'ay', 'accel', 'angle', 'omega', 'alpha', 'coord', 'rate', 'torque', 'power', 'reaction', 'reactionX', 'reactionY', 'reactionMoment', 'toothForce', 'ratio', 'length', 'force', 'gap', 'contactForce', 'pressureAngle', 'kinetic', 'potential', 'energy', 'posError', 'drift', 'angError', 'contacts', 'normalForce'];
const JOINT_TYPES = ['revolute', 'prismatic', 'rigid', 'gear', 'rackPinion', 'belt', 'cam', 'spring'];
/** generous sanity cap for any length-like value in a file, mm */
export const MAX_LENGTH = 1e4;

/**
 * Validation + defaults for files opened from disk / storage.
 *
 * Structure and every numeric value are checked against the same schemas and
 * limits the inspector enforces. A file with invalid content is REJECTED with
 * a message that lists what is wrong — it is never opened half-broken (which
 * would surface later as NaN in the solver). Missing optional fields get
 * defaults, so older files keep opening.
 */
export function normalizeProject(raw: any, notices?: string[]): Project {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Not a Mechanism Workshop project (missing format tag).');
  if (raw.format !== 'mechanism-workshop') throw new Error('Not a Mechanism Workshop project (missing format tag).');
  if (raw.version !== 1) throw new Error(`Unsupported project version ${raw.version}. This build reads version 1.`);
  const problems: string[] = [];
  const bad = (msg: string) => { if (problems.length < 50) problems.push(msg); };
  /** harmless leftovers that are dropped; reported to the caller so the user can be told */
  const note = (msg: string) => { notices?.push(msg); };
  const isObj = (v: any) => !!v && typeof v === 'object' && !Array.isArray(v);
  const num = (v: any, what: string, min = -Infinity, max = Infinity): boolean => {
    if (typeof v !== 'number' || !Number.isFinite(v)) { bad(`${what} must be a finite number (found ${JSON.stringify(v) ?? typeof v})`); return false; }
    if (v < min - 1e-9 || v > max + 1e-9) { bad(`${what} = ${v} is outside the allowed range ${min === -Infinity ? '−∞' : min} … ${max === Infinity ? '∞' : max}`); return false; }
    return true;
  };
  const str = (v: any, what: string): boolean => { if (typeof v !== 'string' || v === '') { bad(`${what} must be a non-empty text`); return false; } return true; };
  const optNum = (o: any, k: string, what: string, min = -Infinity, max = Infinity) => { if (o[k] !== undefined && o[k] !== null) num(o[k], `${what}.${k}`, min, max); };
  const anchorOk = (a: any, what: string) => {
    if (!isObj(a)) { bad(`${what} must be an object`); return; }
    if (a.port !== undefined && typeof a.port !== 'string') bad(`${what}.port must be text`);
    optNum(a, 'x', what, -1e7, 1e7); optNum(a, 'y', what, -1e7, 1e7);
  };

  const base = createProject(typeof raw.name === 'string' && raw.name ? raw.name : 'Untitled', typeof raw.id === 'string' && raw.id ? raw.id : uid('proj'));
  for (const k of ['parts', 'joints', 'loads', 'probes', 'plots', 'groups', 'sketches', 'variants', 'views', 'materials'] as const) {
    if (raw[k] !== undefined && !Array.isArray(raw[k])) bad(`"${k}" must be a list`);
  }
  const arr = (k: string): any[] => (Array.isArray(raw[k]) ? raw[k] : []);

  // ---- parts
  const parts: Part[] = [];
  const ids = new Set<string>();
  arr('parts').forEach((pt, i) => {
    const what = `part #${i + 1}${isObj(pt) && typeof pt.name === 'string' ? ` "${pt.name}"` : ''}`;
    if (!isObj(pt)) { bad(`${what} is not an object`); return; }
    if (!str(pt.id, `${what}: id`)) return;
    if (pt.id === GROUND) { bad(`${what}: the id "${GROUND}" is reserved`); return; }
    if (ids.has(pt.id)) { bad(`${what}: duplicate id "${pt.id}"`); return; }
    ids.add(pt.id);
    if (pt.name !== undefined && typeof pt.name !== 'string') bad(`${what}: name must be text`);
    for (const k of ['grounded', 'suppressed']) if (pt[k] !== undefined && typeof pt[k] !== 'boolean') bad(`${what}: ${k} must be true or false`);
    const def = PART_DEFS[pt.kind as PartKind];
    if (!def) { bad(`${what}: unknown part kind ${JSON.stringify(pt.kind)}`); return; }
    if (pt.params !== undefined && !isObj(pt.params)) { bad(`${what}: params must be an object`); return; }
    const params: Record<string, any> = { ...defaultParams(pt.kind), ...(pt.params ?? {}) };
    for (const d of def.params) {
      const v = params[d.key], w = `${what}: ${d.label}`;
      switch (d.type) {
        case 'bool': if (typeof v !== 'boolean') bad(`${w} must be true or false`); break;
        case 'enum': if (!d.options!.some((o) => o.value === v)) bad(`${w} must be one of ${d.options!.map((o) => o.value).join(', ')}`); break;
        case 'int': if (num(v, w, d.min, d.max) && !Number.isInteger(v)) bad(`${w} must be a whole number`); break;
        case 'sketch': if (typeof v !== 'string') bad(`${w} must be a sketch id`); break;
        case 'camSegments':
          if (!Array.isArray(v) || v.length === 0) { bad(`${w} must be a non-empty list of segments`); break; }
          v.forEach((sg: any, k: number) => {
            if (!isObj(sg)) { bad(`${w}: segment ${k + 1} is not an object`); return; }
            num(sg.duration, `${w}: segment ${k + 1} duration`, 1e-6, 2 * Math.PI + 1e-6);
            num(sg.lift, `${w}: segment ${k + 1} lift`, -1e4, 1e4);
            if (!['dwell', 'cycloidal', 'harmonic', 'poly345', 'linear'].includes(sg.law)) bad(`${w}: segment ${k + 1} has unknown motion law ${JSON.stringify(sg.law)}`);
          });
          break;
        case 'holes':
          if (!Array.isArray(v)) { bad(`${w} must be a list`); break; }
          v.forEach((h: any, k: number) => {
            if (!isObj(h)) { bad(`${w}: hole ${k + 1} is not an object`); return; }
            num(h.x, `${w}: hole ${k + 1} x`, -MAX_LENGTH, MAX_LENGTH); num(h.y, `${w}: hole ${k + 1} y`, -MAX_LENGTH, MAX_LENGTH); num(h.d, `${w}: hole ${k + 1} diameter`, 0, MAX_LENGTH);
          });
          break;
        default: num(v, w, d.min, d.max ?? (d.type === 'length' ? MAX_LENGTH : Infinity));
      }
    }
    const pose = { ...{ x: 0, y: 0, angle: 0, z: 0 }, ...(isObj(pt.pose) ? pt.pose : {}) };
    if (pt.pose !== undefined && !isObj(pt.pose)) bad(`${what}: pose must be an object`);
    num(pose.x, `${what}: pose x`, -1e7, 1e7); num(pose.y, `${what}: pose y`, -1e7, 1e7); num(pose.angle, `${what}: pose angle`, -1e6, 1e6); num(pose.z, `${what}: pose z`, -1e6, 1e6);
    if (pt.massOverride !== undefined && pt.massOverride !== null) {
      if (!isObj(pt.massOverride)) bad(`${what}: massOverride must be an object`);
      else { optNum(pt.massOverride, 'mass', what, 0, 1e6); optNum(pt.massOverride, 'inertia', what, 0, 1e15); }
    }
    if (pt.color !== undefined && pt.color !== null && !/^#[0-9a-fA-F]{6}$/.test(String(pt.color))) bad(`${what}: colour must look like #rrggbb`);
    parts.push({
      ...pt, name: typeof pt.name === 'string' && pt.name ? pt.name : def.label, params,
      pose: { x: pose.x, y: pose.y, angle: pose.angle, z: pose.z }, grounded: !!pt.grounded,
      materialId: typeof pt.materialId === 'string' && pt.materialId ? pt.materialId : def.defaultMaterial,
    });
  });

  // ---- joints
  const joints: Joint[] = [];
  const jointIds = new Set<string>();
  arr('joints').forEach((j, i) => {
    const what = `joint #${i + 1}${isObj(j) && typeof j.name === 'string' ? ` "${j.name}"` : ''}`;
    if (!isObj(j)) { bad(`${what} is not an object`); return; }
    if (!str(j.id, `${what}: id`)) return;
    if (jointIds.has(j.id)) { bad(`${what}: duplicate id "${j.id}"`); return; }
    jointIds.add(j.id);
    if (!JOINT_TYPES.includes(j.type)) { bad(`${what}: unknown joint type ${JSON.stringify(j.type)}`); return; }
    if (j.name !== undefined && typeof j.name !== 'string') bad(`${what}: name must be text`);
    for (const k of ['suppressed', 'crossed']) if (j[k] !== undefined && typeof j[k] !== 'boolean') bad(`${what}: ${k} must be true or false`);
    if (isObj(j.motor) && j.motor.enabled !== undefined && typeof j.motor.enabled !== 'boolean') bad(`${what}: motor.enabled must be true or false`);
    if (isObj(j.limits) && j.limits.enabled !== undefined && typeof j.limits.enabled !== 'boolean') bad(`${what}: limits.enabled must be true or false`);
    if (!str(j.a, `${what}: part A`) || !str(j.b, `${what}: part B`)) return;
    anchorOk(j.anchorA ?? {}, `${what}: anchor A`); anchorOk(j.anchorB ?? {}, `${what}: anchor B`);
    for (const k of ['axisAngle', 'angle']) optNum(j, k, what, -1e6, 1e6);
    for (const k of ['friction', 'damping', 'stiffness', 'springDamping', 'freeLength']) optNum(j, k, what, 0, 1e12);
    for (const k of ['pinDiameter', 'beltWidth', 'beltThickness', 'coilDiameter', 'wireDiameter', 'coils']) optNum(j, k, what, 0, MAX_LENGTH);
    optNum(j, 'preload', what, -1e12, 1e12);
    if (j.limits !== undefined && j.limits !== null) {
      if (!isObj(j.limits)) bad(`${what}: limits must be an object`);
      else { num(j.limits.lower, `${what}: lower limit`, -1e6, 1e6); num(j.limits.upper, `${what}: upper limit`, -1e6, 1e6); }
    }
    if (j.motor !== undefined && j.motor !== null) {
      const m = j.motor;
      if (!isObj(m)) bad(`${what}: motor must be an object`);
      else {
        num(m.speed, `${what}: motor speed`, -1e6, 1e6);
        if (m.maxTorque !== null && m.maxTorque !== undefined) num(m.maxTorque, `${what}: motor torque limit`, 0, 1e15);
        num(m.rampTime ?? 0, `${what}: motor ramp time`, 0, 1e4);
        if (!['servo', 'dc'].includes(m.type)) bad(`${what}: motor type must be servo or dc`);
        if (!['constant', 'reversing'].includes(m.profile)) bad(`${what}: motor profile must be constant or reversing`);
        if (m.period !== undefined && m.period !== null) num(m.period, `${what}: motor reversal period`, 1e-4, 1e6);
      }
    }
    joints.push({ ...j, name: typeof j.name === 'string' && j.name ? j.name : j.type, anchorA: isObj(j.anchorA) ? j.anchorA : {}, anchorB: isObj(j.anchorB) ? j.anchorB : {} });
  });

  // ---- loads, probes, plots, groups, variants, views, materials
  for (const k of ['loads', 'probes', 'plots', 'groups', 'variants', 'sketches', 'materials']) {
    const seen = new Set<string>();
    for (const it of arr(k)) {
      if (!isObj(it) || typeof it.id !== 'string') continue;
      if (seen.has(it.id)) bad(`"${k}" contains the id "${it.id}" twice`);
      seen.add(it.id);
    }
  }
  if (raw.name !== undefined && typeof raw.name !== 'string') bad('project name must be text');
  if (raw.description !== undefined && typeof raw.description !== 'string') bad('project description must be text');
  const loads: Project['loads'] = [];
  arr('loads').forEach((l, i) => {
    const what = `load #${i + 1}`;
    if (!isObj(l) || !str(l.id, `${what}: id`) || !str(l.part, `${what}: part`)) { if (!isObj(l)) bad(`${what} is not an object`); return; }
    if (!['force', 'torque'].includes(l.type)) { bad(`${what}: type must be force or torque`); return; }
    if (!ids.has(l.part)) { bad(`${what}: acts on a part that is not in the file ("${l.part}")`); return; }
    if (l.enabled !== undefined && typeof l.enabled !== 'boolean') bad(`${what}: enabled must be true or false`);
    if (l.frame !== undefined && l.frame !== 'world' && l.frame !== 'part') bad(`${what}: frame must be "world" or "part"`);
    if (l.name !== undefined && typeof l.name !== 'string') bad(`${what}: name must be text`);
    num(l.fx ?? 0, `${what}: fx`, -1e12, 1e12); num(l.fy ?? 0, `${what}: fy`, -1e12, 1e12); num(l.torque ?? 0, `${what}: torque`, -1e15, 1e15);
    anchorOk(l.anchor ?? {}, `${what}: anchor`);
    optNum(l, 'tStart', what, 0, 1e9); optNum(l, 'tEnd', what, 0, 1e9);
    loads.push({ ...l, name: typeof l.name === 'string' && l.name ? l.name : 'Load', fx: l.fx ?? 0, fy: l.fy ?? 0, torque: l.torque ?? 0, anchor: isObj(l.anchor) ? l.anchor : {}, frame: l.frame === 'part' ? 'part' : 'world', enabled: l.enabled !== false });
  });
  const probes: Project['probes'] = [];
  arr('probes').forEach((pr, i) => {
    const what = `probe #${i + 1}`;
    if (!isObj(pr) || !str(pr.id, `${what}: id`)) { if (!isObj(pr)) bad(`${what} is not an object`); return; }
    const t = pr.target;
    if (!isObj(t) || !['point', 'joint', 'part', 'system'].includes(t.kind)) { bad(`${what}: target is invalid`); return; }
    if ((t.kind === 'point' || t.kind === 'part') && typeof t.part !== 'string') { bad(`${what}: target part is missing`); return; }
    if (t.kind === 'joint' && typeof t.joint !== 'string') { bad(`${what}: target joint is missing`); return; }
    if (t.kind === 'point') anchorOk(t.anchor ?? {}, `${what}: anchor`);
    if (pr.trace !== undefined && typeof pr.trace !== 'boolean') bad(`${what}: trace must be true or false`);
    if (pr.name !== undefined && typeof pr.name !== 'string') bad(`${what}: name must be text`);
    if ((t.kind === 'point' || t.kind === 'part') && !ids.has(t.part)) bad(`${what}: refers to a part that is not in the file ("${t.part}")`);
    if (t.kind === 'joint' && !jointIds.has(t.joint)) bad(`${what}: refers to a joint that is not in the file ("${t.joint}")`);
    probes.push({ ...pr, name: typeof pr.name === 'string' && pr.name ? pr.name : 'Probe', trace: !!pr.trace, color: /^#[0-9a-fA-F]{6}$/.test(String(pr.color)) ? pr.color : '#f2b44a', target: t.kind === 'point' ? { ...t, anchor: isObj(t.anchor) ? t.anchor : {} } : t });
  });
  const plots: Project['plots'] = [];
  arr('plots').forEach((pl, i) => {
    if (!isObj(pl) || typeof pl.id !== 'string' || !Array.isArray(pl.channels)) { bad(`plot #${i + 1} is invalid`); return; }
    for (const c of pl.channels) {
      if (!isObj(c) || typeof c.probe !== 'string' || typeof c.quantity !== 'string') bad(`plot #${i + 1}: a channel is invalid`);
      else if (!probes.some((x) => x.id === c.probe)) bad(`plot #${i + 1}: a channel refers to a probe that is not in the file ("${c.probe}")`);
      else if (!PLOT_QUANTITIES.includes(c.quantity)) bad(`plot #${i + 1}: unknown quantity ${JSON.stringify(c.quantity)}`);
    }
    if (pl.title !== undefined && typeof pl.title !== 'string') bad(`plot #${i + 1}: title must be text`);
    plots.push({ id: pl.id, title: typeof pl.title === 'string' ? pl.title : 'Plot', channels: pl.channels.filter((c: any) => isObj(c) && typeof c.probe === 'string' && typeof c.quantity === 'string').map((c: any) => ({ probe: c.probe, quantity: c.quantity })) });
  });
  const groups: Project['groups'] = [];
  arr('groups').forEach((g, i) => {
    if (!isObj(g) || typeof g.id !== 'string' || typeof g.name !== 'string') { bad(`group #${i + 1} is invalid (needs an id and a name)`); return; }
    groups.push({ id: g.id, name: g.name, ...(g.collapsed === true ? { collapsed: true } : {}) });
  });
  for (const pt of parts) if (pt.groupId !== undefined && pt.groupId !== null && !groups.some((g) => g.id === pt.groupId)) bad(`part "${pt.name}": refers to a group that is not in the file`);
  const variants: Project['variants'] = [];
  arr('variants').forEach((v, i) => {
    if (!isObj(v) || typeof v.id !== 'string' || !isObj(v.values)) { bad(`variant #${i + 1} is invalid`); return; }
    if (v.name !== undefined && typeof v.name !== 'string') bad(`variant #${i + 1}: name must be text`);
    if (v.note !== undefined && typeof v.note !== 'string') bad(`variant #${i + 1}: note must be text`);
    const vw = `variant "${typeof v.name === 'string' ? v.name : v.id}"`;
    const kept: Record<string, any> = {};
    for (const [key, val] of Object.entries(v.values)) {
      const [scope, a, b] = key.split(':');
      const w = `${vw}: ${key}`;
      if (scope === 'part') {
        const part = parts.find((x) => x.id === a);
        if (!part) { note(`${vw}: the entry ${key} refers to a part that no longer exists and was dropped`); continue; }
        const d = PART_DEFS[part.kind].params.find((x) => x.key === b);
        if (!d) { bad(`${w} is not a parameter of that part`); continue; }
        if (d.type === 'bool') { if (typeof val !== 'boolean') bad(`${w} must be true or false`); }
        else if (d.type === 'enum') { if (!d.options!.some((o) => o.value === val)) bad(`${w} has an unknown option`); }
        else if (d.type === 'int') { if (num(val, w, d.min, d.max) && !Number.isInteger(val)) bad(`${w} must be a whole number`); }
        else if (d.type === 'camSegments' || d.type === 'holes') { if (!Array.isArray(val)) bad(`${w} must be a list`); }
        else if (d.type === 'sketch') { if (typeof val !== 'string') bad(`${w} must be a sketch id`); }
        else num(val, w, d.min, d.max ?? (d.type === 'length' ? MAX_LENGTH : Infinity));
      } else if (scope === 'pose') {
        num(val, w, -1e7, 1e7);
      } else if (scope === 'joint') {
        if (b === 'motor.maxTorque') { if (val !== null) num(val, w, 0, 1e15); }
        else if (b === 'motor.speed') num(val, w, -1e6, 1e6);
        else if (['stiffness', 'freeLength', 'friction', 'damping', 'springDamping', 'motor.rampTime'].includes(b)) num(val, w, 0, 1e12);
        else if (['limits.lower', 'limits.upper', 'axisAngle', 'angle'].includes(b)) num(val, w, -1e6, 1e6);
        else bad(`${w} is not a joint setting a variant may change`);
      } else if (scope === 'load') {
        if (['fx', 'fy', 'torque'].includes(b)) num(val, w, -1e15, 1e15); else bad(`${w} is not a load setting a variant may change`);
      } else if (scope === 'sim') {
        if (a === 'dt') num(val, w, 1e-5, 0.02);
        else if (a === 'sampleRate') num(val, w, 10, 5000);
        else if (a === 'floor.friction') num(val, w, 0, 3);
        else if (['floor.y', 'gravity.x', 'gravity.y'].includes(a)) num(val, w, -1e7, 1e7);
        else if (a === 'mode') { if (val !== 'kinematic' && val !== 'dynamic') bad(`${w} must be "kinematic" or "dynamic"`); }
        else if (['floor.enabled', 'gravityEnabled', 'stopOnInterference'].includes(a)) { if (typeof val !== 'boolean') bad(`${w} must be true or false`); }
        else bad(`${w} is not a simulation setting a variant may change`);
      } else if (scope === 'clearance') {
        if (['hole', 'slide'].includes(a)) num(val, w, 0, 2); else if (a === 'backlash') num(val, w, 0, 1); else if (a === 'minFeature') num(val, w, 0.05, 5); else bad(`${w} is not a clearance`);
      } else bad(`${w} is not a recognised variant key`);
      if (scope === 'joint' && !jointIds.has(a)) { note(`${vw}: the entry ${key} refers to a joint that no longer exists and was dropped`); continue; }
      if (scope === 'load' && !loads.some((l) => l.id === a)) { note(`${vw}: the entry ${key} refers to a load that no longer exists and was dropped`); continue; }
      if (scope === 'pose' && !ids.has(a)) { note(`${vw}: the entry ${key} refers to a part that no longer exists and was dropped`); continue; }
      kept[key] = val;
    }
    variants.push({ id: v.id, name: typeof v.name === 'string' ? v.name : `Variant ${i + 1}`, note: typeof v.note === 'string' ? v.note : '', values: kept });
  });
  const views: Project['views'] = [];
  arr('views').forEach((v, i) => {
    const vec = (a: any) => Array.isArray(a) && a.length === 3 && a.every((x) => typeof x === 'number' && Number.isFinite(x));
    if (!isObj(v) || !vec(v.position) || !vec(v.target)) { bad(`saved camera #${i + 1} is invalid`); return; }
    views.push({ name: typeof v.name === 'string' ? v.name : `View ${i + 1}`, position: v.position, target: v.target, ortho: !!v.ortho, zoom: typeof v.zoom === 'number' && Number.isFinite(v.zoom) ? v.zoom : undefined });
  });
  const materials: Material[] = [];
  arr('materials').forEach((m, i) => {
    if (!isObj(m) || typeof m.id !== 'string') { bad(`material #${i + 1} is invalid`); return; }
    if (num(m.density, `material "${m.id}": density`, 1e-12, 1e-3)) materials.push({ id: m.id, name: typeof m.name === 'string' ? m.name : m.id, density: m.density, color: /^#[0-9a-fA-F]{6}$/.test(String(m.color)) ? m.color : '#cccccc', metalness: Number(m.metalness) || 0, roughness: Number.isFinite(Number(m.roughness)) ? Number(m.roughness) : 0.5, process: typeof m.process === 'string' ? m.process : '', frictionFactor: typeof m.frictionFactor === 'number' && Number.isFinite(m.frictionFactor) ? m.frictionFactor : undefined });
  });

  // ---- sketches
  const sketches: Project['sketches'] = [];
  arr('sketches').forEach((sk, i) => {
    const what = `sketch #${i + 1}`;
    if (!isObj(sk) || typeof sk.id !== 'string' || !Array.isArray(sk.points) || !Array.isArray(sk.entities) || !Array.isArray(sk.constraints)) { bad(`${what} is invalid`); return; }
    let ok = true;
    for (const p of sk.points) if (!isObj(p) || typeof p.id !== 'string' || typeof p.x !== 'number' || !Number.isFinite(p.x) || typeof p.y !== 'number' || !Number.isFinite(p.y)) ok = false;
    for (const e of sk.entities) if (!isObj(e) || typeof e.id !== 'string' || !['line', 'circle', 'arc'].includes(e.type) || (e.type === 'circle' && !(typeof e.r === 'number' && Number.isFinite(e.r) && e.r >= 0))) ok = false;
    for (const c of sk.constraints) if (!isObj(c) || typeof c.id !== 'string' || typeof c.type !== 'string' || ('value' in c && !(typeof c.value === 'number' && Number.isFinite(c.value)))) ok = false;
    if (!ok) { bad(`${what} "${sk.name ?? sk.id}" contains invalid points, entities or constraints`); return; }
    sketches.push({ id: sk.id, name: typeof sk.name === 'string' ? sk.name : `Sketch ${i + 1}`, points: sk.points, entities: sk.entities, constraints: sk.constraints });
  });

  // ---- settings
  const rs = raw.sim;
  if (rs !== undefined && !isObj(rs)) bad('"sim" must be an object');
  const simIn = isObj(rs) ? rs : {};
  const sim: SimSettings = {
    ...base.sim, ...simIn,
    gravity: { ...base.sim.gravity, ...(isObj(simIn.gravity) ? simIn.gravity : {}) },
    floor: { ...base.sim.floor, ...(isObj(simIn.floor) ? simIn.floor : {}) },
  };
  if (simIn.gravity !== undefined && !isObj(simIn.gravity)) bad('sim.gravity must be an object');
  if (simIn.floor !== undefined && !isObj(simIn.floor)) bad('sim.floor must be an object');
  if (!['kinematic', 'dynamic'].includes(sim.mode)) bad('sim.mode must be "kinematic" or "dynamic"');
  num(sim.dt, 'sim.dt (timestep)', 1e-5, 0.02);
  num(sim.sampleRate, 'sim.sampleRate', 10, 5000);
  num(sim.gravity.x, 'sim.gravity.x', -1e7, 1e7); num(sim.gravity.y, 'sim.gravity.y', -1e7, 1e7);
  num(sim.floor.y, 'sim.floor.y', -1e7, 1e7); num(sim.floor.friction, 'sim.floor.friction', 0, 3);
  for (const [v, w] of [[sim.gravityEnabled, 'sim.gravityEnabled'], [sim.floor.enabled, 'sim.floor.enabled'], [sim.stopOnInterference, 'sim.stopOnInterference']] as const) {
    if (typeof v !== 'boolean') bad(`${w} must be true or false`);
  }
  if (raw.clearances !== undefined && !isObj(raw.clearances)) bad('"clearances" must be an object');
  const clearances = { ...base.clearances, ...(isObj(raw.clearances) ? raw.clearances : {}) };
  num(clearances.hole, 'clearances.hole', 0, 2); num(clearances.slide, 'clearances.slide', 0, 2); num(clearances.backlash, 'clearances.backlash', 0, 1); num(clearances.minFeature, 'clearances.minFeature', 0.05, 5);
  // unknown display units fall back to defaults (display only, harmless)
  const units = { ...base.units } as Record<string, string>;
  if (raw.units !== undefined && !isObj(raw.units)) bad('"units" must be an object');
  if (isObj(raw.units)) for (const [k, u] of Object.entries(raw.units)) {
    if ((UNIT_TABLE as any)[k] && typeof u === 'string' && (UNIT_TABLE as any)[k][u] !== undefined) units[k] = u;
    else note(`display unit ${JSON.stringify(u)} for "${k}" is not known; the default (${units[k] ?? 'none'}) is used`);
  }
  // references that must resolve
  const matIds = new Set([...BUILTIN_MATERIALS.map((m) => m.id), ...materials.map((m) => m.id)]);
  for (const pt of parts) if (!matIds.has(pt.materialId)) bad(`part "${pt.name}": unknown material "${pt.materialId}"`);
  if (raw.activeVariant !== undefined && raw.activeVariant !== null && !variants.some((v) => v.id === raw.activeVariant)) bad(`activeVariant names a variant that is not in the file (${JSON.stringify(raw.activeVariant)})`);
  for (const pt of parts) if (pt.kind === 'plate' && pt.params.sketchId && !sketches.some((sk) => sk.id === pt.params.sketchId)) bad(`part "${pt.name}": refers to a sketch that is not in the file`);

  if (problems.length) {
    const shown = problems.slice(0, 4).join('; ');
    throw new Error(`the file contains ${problems.length} invalid value${problems.length === 1 ? '' : 's'}: ${shown}${problems.length > 4 ? `; … and ${problems.length - 4} more` : ''}. Nothing was opened.`);
  }
  return {
    format: 'mechanism-workshop', version: 1, id: base.id, name: base.name,
    description: typeof raw.description === 'string' ? raw.description : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : base.createdAt, modifiedAt: typeof raw.modifiedAt === 'string' ? raw.modifiedAt : base.modifiedAt,
    parts, joints, loads, probes, plots, groups, sketches, variants,
    views, sim, clearances, units, materials,
    ...(typeof raw.activeVariant === 'string' ? { activeVariant: raw.activeVariant } : {}),
  };
}

export function serializeProject(p: Project): string {
  return JSON.stringify(p, null, 1);
}
