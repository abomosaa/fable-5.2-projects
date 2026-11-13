/**
 * Pure authoring operations on a Project. Every function returns a new
 * Project (structural sharing) and never mutates its input, so the UI can
 * wrap them in undoable transactions and scripts/tests can build the very
 * same projects the editor does.
 */
import type { Anchor, Joint, JointType, Load, MotorSpec, Part, PartKind, Pose, Probe, Project, Variant } from './types';
import { GROUND } from './types';
import { anchorLocal, createPart, geometryOf, localToWorld, uid } from './project';
import { PART_DEFS } from '../parts/catalog';
import { RPM } from '../units';

export function uniqueName(existing: string[], base: string): string {
  if (!existing.includes(base)) return base;
  const m = /^(.*?)(?:\s+(\d+))?$/.exec(base)!;
  const stem = m[1];
  let n = m[2] ? parseInt(m[2], 10) + 1 : 2;
  while (existing.includes(`${stem} ${n}`)) n++;
  return `${stem} ${n}`;
}

export function touch(p: Project): Project {
  return { ...p, modifiedAt: new Date().toISOString() };
}

export function addPart(project: Project, kind: PartKind, opts: { id?: string; name?: string; params?: Record<string, any>; pose?: Partial<Pose>; grounded?: boolean; materialId?: string; color?: string; groupId?: string } = {}): { project: Project; id: string } {
  const id = opts.id ?? uid('part');
  const name = uniqueName(project.parts.map((p) => p.name), opts.name ?? PART_DEFS[kind].label);
  const part = createPart(kind, id, name, opts.params, opts.pose);
  if (opts.grounded) part.grounded = true;
  if (opts.materialId) part.materialId = opts.materialId;
  if (opts.color) part.color = opts.color;
  if (opts.groupId) part.groupId = opts.groupId;
  return { project: { ...project, parts: [...project.parts, part] }, id };
}

export function updatePart(project: Project, id: string, patch: Partial<Part>): Project {
  return { ...project, parts: project.parts.map((p) => (p.id === id ? { ...p, ...patch } : p)) };
}

export function setPartParam(project: Project, id: string, key: string, value: any): Project {
  return { ...project, parts: project.parts.map((p) => (p.id === id ? { ...p, params: { ...p.params, [key]: value } } : p)) };
}

export function setPartPose(project: Project, id: string, pose: Partial<Pose>): Project {
  return { ...project, parts: project.parts.map((p) => (p.id === id ? { ...p, pose: { ...p.pose, ...pose } } : p)) };
}

/**
 * Parts connected to `id` through unsuppressed joints, when that whole group floats freely: no part of
 * it is grounded and none of its joints (or springs) attaches to ground. Returns null otherwise.
 */
export function freeGroupOf(project: Project, id: string): string[] | null {
  const seen = new Set<string>([id]);
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    const part = project.parts.find((p) => p.id === cur);
    if (!part || part.grounded) return null;
    for (const j of project.joints) {
      if (j.suppressed || (j.a !== cur && j.b !== cur)) continue;
      const other = j.a === cur ? j.b : j.a;
      if (other === GROUND) return null;
      if (!seen.has(other)) { seen.add(other); stack.push(other); }
    }
  }
  return [...seen];
}

/**
 * Set a part's pose as the user asked for it. A part of a freely floating jointed group takes the whole
 * group with it as one rigid body (so the requested value is met exactly and every joint stays closed);
 * otherwise only the part is posed and the assembly solve decides what its joints allow.
 */
export function setPartPoseDriving(project: Project, id: string, pose: Partial<Pose>): Project {
  const part = project.parts.find((p) => p.id === id);
  const group = part ? freeGroupOf(project, id) : null;
  if (!part || !group || group.length < 2) return setPartPose(project, id, pose);
  const nx = pose.x ?? part.pose.x, ny = pose.y ?? part.pose.y, da = (pose.angle ?? part.pose.angle) - part.pose.angle;
  const c = Math.cos(da), s = Math.sin(da), ox = part.pose.x, oy = part.pose.y;
  const inGroup = new Set(group);
  return {
    ...project,
    parts: project.parts.map((q) => {
      if (q.id === id) return { ...q, pose: { ...q.pose, ...pose } };
      if (!inGroup.has(q.id)) return q;
      const rx = q.pose.x - ox, ry = q.pose.y - oy;
      return { ...q, pose: { ...q.pose, x: nx + c * rx - s * ry, y: ny + s * rx + c * ry, angle: q.pose.angle + da } };
    }),
  };
}

/** Translate the given parts; a part of a freely floating jointed group takes its whole group along. */
export function nudgeParts(project: Project, ids: string[], dx: number, dy: number): Project {
  const move = new Set<string>();
  for (const id of ids) for (const m of freeGroupOf(project, id) ?? [id]) move.add(m);
  return { ...project, parts: project.parts.map((q) => (move.has(q.id) ? { ...q, pose: { ...q.pose, x: q.pose.x + dx, y: q.pose.y + dy } } : q)) };
}

export function updateJoint(project: Project, id: string, patch: Partial<Joint>): Project {
  return { ...project, joints: project.joints.map((j) => (j.id === id ? { ...j, ...patch } : j)) };
}

export function addJoint(project: Project, joint: Omit<Joint, 'id' | 'name'> & { id?: string; name?: string }): { project: Project; id: string } {
  const id = joint.id ?? uid('joint');
  const base = joint.name ?? defaultJointName(joint.type);
  const name = uniqueName(project.joints.map((j) => j.name), base);
  return { project: { ...project, joints: [...project.joints, { ...joint, id, name } as Joint] }, id };
}

function defaultJointName(t: JointType): string {
  return ({ revolute: 'Pivot', prismatic: 'Slide', rigid: 'Fixed', gear: 'Gear mesh', rackPinion: 'Rack mesh', belt: 'Belt', cam: 'Cam contact', spring: 'Spring' } as Record<JointType, string>)[t];
}

export const DEFAULT_MOTOR: MotorSpec = { enabled: true, type: 'servo', speed: 60 * RPM, maxTorque: null, rampTime: 0.25, profile: 'constant' };

function worldOfAnchor(project: Project, partId: string, anchor: Anchor): { x: number; y: number } {
  const l = anchorLocal(project, partId, anchor);
  if (partId === GROUND) return { x: l.x, y: l.y };
  const part = project.parts.find((p) => p.id === partId)!;
  return localToWorld(part.pose, l.x, l.y);
}

/** z so that `moving` sits directly on top of `base` (stacked along +Z). */
export function stackedZ(project: Project, baseId: string, movingId: string): number | null {
  const a = project.parts.find((p) => p.id === baseId), b = project.parts.find((p) => p.id === movingId);
  if (!a || !b) return null;
  const ga = geometryOf(project, a), gb = geometryOf(project, b);
  return a.pose.z + ga.zMax - gb.zMin;
}

function zOverlap(project: Project, aId: string, bId: string): boolean {
  const a = project.parts.find((p) => p.id === aId), b = project.parts.find((p) => p.id === bId);
  if (!a || !b) return false;
  const ga = geometryOf(project, a), gb = geometryOf(project, b);
  return a.pose.z + ga.zMin < b.pose.z + gb.zMax - 1e-6 && b.pose.z + gb.zMin < a.pose.z + ga.zMax - 1e-6;
}

export interface MateOpts { id?: string; name?: string; move?: boolean; stack?: boolean; extra?: Partial<Joint> }

/** Pin joint: part B is translated so its anchor meets part A's anchor. */
export function mateRevolute(project: Project, a: string, anchorA: Anchor, b: string, anchorB: Anchor, opts: MateOpts = {}): { project: Project; id: string } {
  let p = project;
  if (opts.move !== false && b !== GROUND) {
    const wa = worldOfAnchor(p, a, anchorA), wb = worldOfAnchor(p, b, anchorB);
    const B = p.parts.find((x) => x.id === b)!;
    if (!B.grounded) {
      const pose: Partial<Pose> = { x: B.pose.x + wa.x - wb.x, y: B.pose.y + wa.y - wb.y };
      p = setPartPose(p, b, pose);
      if (opts.stack !== false && a !== GROUND && zOverlap(p, a, b)) {
        const z = stackedZ(p, a, b);
        if (z !== null) p = setPartPose(p, b, { z });
      }
    }
  }
  return addJoint(p, { type: 'revolute', a, b, anchorA, anchorB, id: opts.id, name: opts.name, ...opts.extra });
}

/** Sliding joint along `axisAngle` (in A's frame; defaults to the anchor port's axis). B is aligned onto the axis. */
export function matePrismatic(project: Project, a: string, anchorA: Anchor, b: string, anchorB: Anchor, opts: MateOpts & { axisAngle?: number } = {}): { project: Project; id: string } {
  let p = project;
  const la = anchorLocal(p, a, anchorA);
  const axisLocal = opts.axisAngle ?? la.port?.axis ?? 0;
  const aAngle = a === GROUND ? 0 : p.parts.find((x) => x.id === a)!.pose.angle;
  const axisW = axisLocal + aAngle;
  if (opts.move !== false && b !== GROUND) {
    const B = p.parts.find((x) => x.id === b)!;
    if (!B.grounded) {
      const lb = anchorLocal(p, b, anchorB);
      const portAxis = lb.port?.axis;
      let angle = B.pose.angle;
      if (portAxis !== undefined) {
        // align B's own axis with the slide axis (choose the nearer of the two directions)
        const cand = [axisW - portAxis, axisW - portAxis + Math.PI];
        const diff = (x: number) => Math.abs(Math.atan2(Math.sin(x - B.pose.angle), Math.cos(x - B.pose.angle)));
        angle = diff(cand[0]) <= diff(cand[1]) ? cand[0] : cand[1];
      }
      p = setPartPose(p, b, { angle });
      const wa = worldOfAnchor(p, a, anchorA), wb = worldOfAnchor(p, b, anchorB);
      const nx = -Math.sin(axisW), ny = Math.cos(axisW);
      const off = nx * (wb.x - wa.x) + ny * (wb.y - wa.y);
      const B2 = p.parts.find((x) => x.id === b)!;
      p = setPartPose(p, b, { x: B2.pose.x - nx * off, y: B2.pose.y - ny * off });
      // a slider or stem runs INSIDE the slot of a guide: put it on the guide's layer
      const A = a === GROUND ? null : p.parts.find((x) => x.id === a);
      if (A && A.kind === 'rail' && opts.stack !== false) p = setPartPose(p, b, { z: A.pose.z });
    }
  }
  // a slide also fixes the orientation of B relative to A: remember it, so that turning the guide turns the slider with it
  const Bn = b === GROUND ? null : p.parts.find((x) => x.id === b);
  const rel = (Bn ? Bn.pose.angle : 0) - aAngle;
  return addJoint(p, { type: 'prismatic', a, b, anchorA, anchorB, axisAngle: axisLocal, angle: Math.atan2(Math.sin(rel), Math.cos(rel)), id: opts.id, name: opts.name, ...opts.extra });
}

/** Rigid attachment. B is translated so the anchors coincide; the current relative angle is kept unless `angle` is given. */
export function mateRigid(project: Project, a: string, anchorA: Anchor, b: string, anchorB: Anchor, opts: MateOpts & { angle?: number } = {}): { project: Project; id: string } {
  let p = project;
  const aAngle = a === GROUND ? 0 : p.parts.find((x) => x.id === a)!.pose.angle;
  const B = b === GROUND ? null : p.parts.find((x) => x.id === b)!;
  let angle = opts.angle ?? ((B ? B.pose.angle : 0) - aAngle);
  angle = Math.atan2(Math.sin(angle), Math.cos(angle));
  if (opts.move !== false && B && !B.grounded) {
    p = setPartPose(p, b, { angle: aAngle + angle });
    const wa = worldOfAnchor(p, a, anchorA), wb = worldOfAnchor(p, b, anchorB);
    const B2 = p.parts.find((x) => x.id === b)!;
    p = setPartPose(p, b, { x: B2.pose.x + wa.x - wb.x, y: B2.pose.y + wa.y - wb.y });
  }
  return addJoint(p, { type: 'rigid', a, b, anchorA, anchorB, angle, id: opts.id, name: opts.name, ...opts.extra });
}

export function mateCoupling(project: Project, type: 'gear' | 'belt' | 'rackPinion' | 'cam', a: string, b: string, opts: MateOpts & { anchorB?: Anchor } = {}): { project: Project; id: string } {
  return addJoint(project, { type, a, b, anchorA: { port: 'center' }, anchorB: opts.anchorB ?? { port: type === 'cam' ? 'roller' : 'center' }, id: opts.id, name: opts.name, ...opts.extra });
}

export function addSpring(project: Project, a: string, anchorA: Anchor, b: string, anchorB: Anchor, opts: MateOpts & { stiffness?: number; freeLength?: number; damping?: number } = {}): { project: Project; id: string } {
  const wa = worldOfAnchor(project, a, anchorA), wb = worldOfAnchor(project, b, anchorB);
  const L = Math.hypot(wb.x - wa.x, wb.y - wa.y);
  return addJoint(project, {
    type: 'spring', a, b, anchorA, anchorB, stiffness: opts.stiffness ?? 500, freeLength: opts.freeLength ?? L, springDamping: opts.damping ?? 0.5,
    coilDiameter: 8, wireDiameter: 0.8, coils: 8, id: opts.id, name: opts.name, ...opts.extra,
  });
}

export interface Selection { parts?: string[]; joints?: string[]; loads?: string[]; probes?: string[] }

/** Delete items; joints, loads and probes that depended on deleted parts/joints go with them. */
export function removeItems(project: Project, sel: Selection): Project {
  const parts = new Set(sel.parts ?? []);
  const joints = new Set(sel.joints ?? []);
  for (const j of project.joints) if (parts.has(j.a) || parts.has(j.b)) joints.add(j.id);
  const loads = new Set(sel.loads ?? []);
  for (const l of project.loads) if (parts.has(l.part)) loads.add(l.id);
  const probes = new Set(sel.probes ?? []);
  for (const pr of project.probes) {
    if (pr.target.kind === 'system') continue;
    if (pr.target.kind === 'joint' ? joints.has(pr.target.joint) : parts.has(pr.target.part)) probes.add(pr.id);
  }
  const sketchIds = new Set(project.parts.filter((p) => parts.has(p.id) && p.kind === 'plate').map((p) => p.params.sketchId));
  const stillUsed = new Set(project.parts.filter((p) => !parts.has(p.id) && p.kind === 'plate').map((p) => p.params.sketchId));
  return {
    ...project,
    parts: project.parts.filter((p) => !parts.has(p.id)),
    joints: project.joints.filter((j) => !joints.has(j.id)),
    loads: project.loads.filter((l) => !loads.has(l.id)),
    probes: project.probes.filter((p) => !probes.has(p.id)),
    plots: project.plots.map((pl) => ({ ...pl, channels: pl.channels.filter((c) => !probes.has(c.probe)) })).filter((pl, i) => pl.channels.length > 0 || project.plots[i].channels.length === 0),
    sketches: project.sketches.filter((s) => !sketchIds.has(s.id) || stillUsed.has(s.id)),
  };
}

/**
 * Duplicate parts with the joints between them (and their joints to ground),
 * applying a rigid transform to the copies. Returns the new part ids in order.
 */
export function duplicateParts(project: Project, ids: string[], xf: { dx?: number; dy?: number; dz?: number; rotate?: number; cx?: number; cy?: number } = {}, idGen: (prefix: string) => string = uid): { project: Project; ids: string[]; map: Map<string, string> } {
  const set = new Set(ids);
  const map = new Map<string, string>();
  const rot = xf.rotate ?? 0, cx = xf.cx ?? 0, cy = xf.cy ?? 0, dx = xf.dx ?? 0, dy = xf.dy ?? 0, dz = xf.dz ?? 0;
  const c = Math.cos(rot), s = Math.sin(rot);
  const tf = (x: number, y: number) => ({ x: cx + c * (x - cx) - s * (y - cy) + dx, y: cy + s * (x - cx) + c * (y - cy) + dy });
  const names = project.parts.map((p) => p.name);
  const newParts: Part[] = [];
  let sketches = project.sketches;
  for (const p of project.parts) {
    if (!set.has(p.id)) continue;
    const id = idGen('part');
    map.set(p.id, id);
    const name = uniqueName(names, p.name);
    names.push(name);
    const q = tf(p.pose.x, p.pose.y);
    let params = structuredClone(p.params);
    if (p.kind === 'plate') {
      const sk = project.sketches.find((x) => x.id === p.params.sketchId);
      if (sk) { const sid = idGen('sketch'); sketches = [...sketches, { ...structuredClone(sk), id: sid, name: uniqueName(sketches.map((x) => x.name), sk.name) }]; params = { ...params, sketchId: sid }; }
    }
    newParts.push({ ...p, id, name, params, pose: { x: q.x, y: q.y, angle: p.pose.angle + rot, z: p.pose.z + dz } });
  }
  const jn = project.joints.map((j) => j.name);
  const newJoints: Joint[] = [];
  for (const j of project.joints) {
    const aIn = set.has(j.a), bIn = set.has(j.b);
    const ok = (aIn && bIn) || (aIn && j.b === GROUND) || (bIn && j.a === GROUND);
    if (!ok) continue;
    const nj: Joint = { ...structuredClone(j), id: idGen('joint'), name: uniqueName(jn, j.name), a: map.get(j.a) ?? j.a, b: map.get(j.b) ?? j.b };
    jn.push(nj.name);
    if (j.a === GROUND) { const q = tf(j.anchorA.x ?? 0, j.anchorA.y ?? 0); nj.anchorA = { x: q.x, y: q.y }; }
    if (j.b === GROUND) { const q = tf(j.anchorB.x ?? 0, j.anchorB.y ?? 0); nj.anchorB = { x: q.x, y: q.y }; }
    newJoints.push(nj);
  }
  return { project: { ...project, parts: [...project.parts, ...newParts], joints: [...project.joints, ...newJoints], sketches }, ids: newParts.map((p) => p.id), map };
}

export function patternLinear(project: Project, ids: string[], count: number, dx: number, dy: number, dz = 0, idGen: (prefix: string) => string = uid): { project: Project; ids: string[] } {
  let p = project;
  const all: string[] = [];
  for (let k = 1; k < count; k++) {
    const r = duplicateParts(p, ids, { dx: dx * k, dy: dy * k, dz: dz * k }, idGen);
    p = r.project; all.push(...r.ids);
  }
  return { project: p, ids: all };
}

export function patternCircular(project: Project, ids: string[], count: number, cx: number, cy: number, totalAngle = 2 * Math.PI, idGen: (prefix: string) => string = uid): { project: Project; ids: string[] } {
  let p = project;
  const all: string[] = [];
  const step = Math.abs(Math.abs(totalAngle) - 2 * Math.PI) < 1e-9 ? totalAngle / count : totalAngle / Math.max(count - 1, 1);
  for (let k = 1; k < count; k++) {
    const r = duplicateParts(p, ids, { rotate: step * k, cx, cy }, idGen);
    p = r.project; all.push(...r.ids);
  }
  return { project: p, ids: all };
}

export function groupParts(project: Project, ids: string[], name: string, id: string = uid('group')): { project: Project; id: string } {
  const set = new Set(ids);
  const gname = uniqueName(project.groups.map((g) => g.name), name);
  const parts = project.parts.map((p) => (set.has(p.id) ? { ...p, groupId: id } : p));
  return { project: pruneGroups({ ...project, groups: [...project.groups, { id, name: gname }], parts }), id };
}

export function ungroup(project: Project, groupId: string): Project {
  return pruneGroups({ ...project, parts: project.parts.map((p) => (p.groupId === groupId ? { ...p, groupId: undefined } : p)), groups: project.groups.filter((g) => g.id !== groupId) });
}

function pruneGroups(project: Project): Project {
  const used = new Set(project.parts.map((p) => p.groupId).filter(Boolean));
  return { ...project, groups: project.groups.filter((g) => used.has(g.id)) };
}

export function addLoad(project: Project, load: Omit<Load, 'id' | 'name'> & { id?: string; name?: string }): { project: Project; id: string } {
  const id = load.id ?? uid('load');
  const name = uniqueName(project.loads.map((l) => l.name), load.name ?? (load.type === 'torque' ? 'Torque load' : 'Force load'));
  return { project: { ...project, loads: [...project.loads, { ...load, id, name }] }, id };
}

export const PROBE_COLORS = ['#f2b44a', '#4cc2ff', '#7ee081', '#ff7b72', '#c792ea', '#5eead4', '#f778ba', '#d2a8ff'];

export function addProbe(project: Project, probe: Omit<Probe, 'id' | 'name' | 'color' | 'trace'> & { id?: string; name?: string; color?: string; trace?: boolean }): { project: Project; id: string } {
  const id = probe.id ?? uid('probe');
  const name = uniqueName(project.probes.map((p) => p.name), probe.name ?? 'Probe');
  const color = probe.color ?? PROBE_COLORS[project.probes.length % PROBE_COLORS.length];
  return { project: { ...project, probes: [...project.probes, { ...probe, id, name, color, trace: probe.trace ?? probe.target.kind === 'point' }] }, id };
}

// ------------------------------------------------------------------ variants

function getPath(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath<T extends object>(obj: T, path: string, value: any): T {
  const keys = path.split('.');
  const out: any = Array.isArray(obj) ? [...(obj as any)] : { ...obj };
  let cur = out;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    cur[k] = cur[k] == null ? {} : Array.isArray(cur[k]) ? [...cur[k]] : { ...cur[k] };
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return out;
}

/** read a "part:<id>:<param>" / "joint:<id>:<path>" / "sim:<path>" / "load:<id>:<path>" / "pose:<id>:<field>" key */
export function readKey(project: Project, key: string): any {
  const [scope, a, b] = key.split(':');
  if (scope === 'part') return getPath(project.parts.find((p) => p.id === a)?.params, b);
  if (scope === 'pose') return getPath(project.parts.find((p) => p.id === a)?.pose, b);
  if (scope === 'joint') return getPath(project.joints.find((j) => j.id === a), b);
  if (scope === 'load') return getPath(project.loads.find((l) => l.id === a), b);
  if (scope === 'sim') return getPath(project.sim, a);
  if (scope === 'clearance') return getPath(project.clearances, a);
  return undefined;
}

export function writeKey(project: Project, key: string, value: any): Project {
  const [scope, a, b] = key.split(':');
  const v = structuredClone(value);
  if (scope === 'part') return { ...project, parts: project.parts.map((p) => (p.id === a ? { ...p, params: setPath(p.params, b, v) } : p)) };
  if (scope === 'pose') return { ...project, parts: project.parts.map((p) => (p.id === a ? { ...p, pose: setPath(p.pose, b, v) } : p)) };
  if (scope === 'joint') return { ...project, joints: project.joints.map((j) => (j.id === a ? setPath(j, b, v) : j)) };
  if (scope === 'load') return { ...project, loads: project.loads.map((l) => (l.id === a ? setPath(l, b, v) : l)) };
  if (scope === 'sim') return { ...project, sim: setPath(project.sim, a, v) };
  if (scope === 'clearance') return { ...project, clearances: setPath(project.clearances, a, v) };
  return project;
}

/** Apply a named parameter set. The caller is expected to re-solve the assembly afterwards. */
export function applyVariant(project: Project, variantId: string): Project {
  const v = project.variants.find((x) => x.id === variantId);
  if (!v) return project;
  let p = project;
  for (const [k, val] of Object.entries(v.values)) p = writeKey(p, k, val);
  return { ...p, activeVariant: variantId };
}

/** Capture the current values of the given keys (default: the keys used by existing variants) as a new variant. */
export function captureVariant(project: Project, name: string, keys?: string[], id: string = uid('variant'), note = ''): { project: Project; id: string } {
  const ks = keys ?? [...new Set(project.variants.flatMap((v) => Object.keys(v.values)))];
  const values: Record<string, any> = {};
  for (const k of ks) values[k] = structuredClone(readKey(project, k));
  const v: Variant = { id, name: uniqueName(project.variants.map((x) => x.name), name), note, values };
  return { project: { ...project, variants: [...project.variants, v], activeVariant: id }, id };
}

/** every numeric part parameter + motor/load/sim settings, as variant keys */
export function allParameterKeys(project: Project): string[] {
  const keys: string[] = [];
  for (const p of project.parts) {
    for (const d of PART_DEFS[p.kind].params) if (d.type !== 'sketch') keys.push(`part:${p.id}:${d.key}`);
  }
  for (const j of project.joints) {
    if (j.motor) keys.push(`joint:${j.id}:motor.speed`, `joint:${j.id}:motor.maxTorque`);
    if (j.type === 'spring') keys.push(`joint:${j.id}:stiffness`, `joint:${j.id}:freeLength`);
  }
  for (const l of project.loads) keys.push(`load:${l.id}:fx`, `load:${l.id}:fy`, `load:${l.id}:torque`);
  keys.push('sim:floor.friction');
  return keys;
}
