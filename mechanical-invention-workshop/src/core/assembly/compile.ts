/**
 * Compile a project (design data) into a mechanism model: rigid bodies,
 * constraint descriptors, force elements and contacts. The compiled model is
 * read-only input for the solvers in core/sim.
 */
import type { Joint, MotorSpec, Part, Project } from '../model/types';
import { GROUND } from '../model/types';
import { anchorLocal, geometryOf, massProps, materialOf } from '../model/project';
import type { PartGeometry } from '../parts/catalog';
import { camParamsOf } from '../parts/catalog';
import type { CamParams } from '../parts/profiles';

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  /** stable machine-readable code, e.g. 'assembly.open-joint' */
  code: string;
  title: string;
  detail: string;
  parts: string[];
  joints: string[];
  /** simulation time at which it occurred (runtime diagnostics) */
  time?: number;
}

export type CompileMode = 'assembly' | 'kinematic' | 'dynamic';

export interface BodyDef {
  index: number;
  partIds: string[];
  mass: number;
  inertia: number;
  /** world COM at the design pose */
  x0: number;
  y0: number;
  name: string;
}

/** Part frame expressed in its body's frame (or in the world when body = -1). */
export interface PartRef { body: number; lx: number; ly: number; la: number }

/** A material point: body index (-1 = world) and coordinates in that frame. */
export interface PointRef { body: number; x: number; y: number }

export interface CoordDef {
  jointId: string;
  kind: 'rev' | 'pris';
  bi: number; bj: number;
  ri: [number, number]; rj: [number, number];
  /** prismatic axis, unit vector in body i's frame */
  axis: [number, number];
  /** offset so the coordinate is zero at the design pose */
  zero: number;
}

export type Con =
  | { kind: 'rev'; jointId: string; bi: number; bj: number; ri: [number, number]; rj: [number, number]; row: number }
  | { kind: 'pris'; jointId: string; bi: number; bj: number; ri: [number, number]; rj: [number, number]; axis: [number, number]; ang0: number; row: number }
  | { kind: 'weld'; jointId: string; bi: number; bj: number; ri: [number, number]; rj: [number, number]; ang0: number; row: number }
  /** ra(θa−ψ) + σ·rb(θb−ψ) = c0, ψ = direction of the line of centres */
  | { kind: 'gear'; jointId: string; bi: number; bj: number; ca: [number, number]; cb: [number, number]; ra: number; rb: number; sigma: number; offA: number; offB: number; c0: number; row: number; belt: boolean }
  /** s − σ·r(θp−θr) = c0 with s = position of the pinion centre along the rack */
  | { kind: 'rack'; jointId: string; bi: number; bj: number; cp: [number, number]; o: [number, number]; axis: [number, number]; r: number; sigma: number; offP: number; offR: number; c0: number; row: number };

export interface MotorDef { jointId: string; coord: CoordDef; spec: MotorSpec; ideal: boolean }
export interface LimitDef { jointId: string; coord: CoordDef; lower: number; upper: number }
export interface FrictionDef { jointId: string; coord: CoordDef; limit: number }
export interface DamperDef { jointId: string; coord: CoordDef; c: number }
export interface SpringDef { jointId: string; pa: PointRef; pb: PointRef; k: number; L0: number; c: number; designLength: number }
export interface LoadDef {
  loadId: string; p: PointRef; fx: number; fy: number; torque: number; frame: 'world' | 'part';
  /** part angle offset within the body, for 'part' frame loads */
  la: number; tStart: number; tEnd: number; partId: string;
}
export interface CamDef {
  jointId: string;
  camBody: number; camCenter: [number, number]; camAngle: number;
  followerBody: number; roller: [number, number]; rollerR: number;
  params: CamParams;
  camPart: string; followerPart: string;
}
export interface FloorContactDef { body: number; partId: string; x: number; y: number; r: number; mu: number; key: string }

export interface MechModel {
  mode: CompileMode;
  project: Project;
  bodies: BodyDef[];
  partRef: Map<string, PartRef>;
  geom: Map<string, PartGeometry>;
  cons: Con[];
  /** number of scalar bilateral rows in `cons` */
  nRows: number;
  /** jointId of each bilateral row + component label */
  rowInfo: { jointId: string; label: string; unit: 'mm' | 'rad' | 'mm·rad' }[];
  coords: Map<string, CoordDef>;
  motors: MotorDef[];
  limits: LimitDef[];
  frictions: FrictionDef[];
  dampers: DamperDef[];
  springs: SpringDef[];
  loads: LoadDef[];
  cams: CamDef[];
  floorContacts: FloorContactDef[];
  gravity: { x: number; y: number };
  floorY: number;
  floorEnabled: boolean;
  issues: Diagnostic[];
  /** part ids that take part (not suppressed) */
  activeParts: string[];
}

class UnionFind {
  parent = new Map<string, string>();
  find(a: string): string {
    let p = this.parent.get(a);
    if (p === undefined) { this.parent.set(a, a); return a; }
    while (p !== a) { a = p; p = this.parent.get(a)!; }
    return a;
  }
  union(a: string, b: string) {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return;
    // keep GROUND as root
    if (ra === GROUND) this.parent.set(rb, ra); else this.parent.set(ra, rb);
  }
}

const rot = (a: number, x: number, y: number): [number, number] => {
  const c = Math.cos(a), s = Math.sin(a);
  return [c * x - s * y, s * x + c * y];
};

export interface CompileOptions {
  /** assembly mode only: motorised joints hold their current coordinate (the design pose of driven joints is kept) */
  lockMotors?: boolean;
}

export function compile(project: Project, mode: CompileMode, opts: CompileOptions = {}): MechModel {
  const issues: Diagnostic[] = [];
  const parts = project.parts.filter((p) => !p.suppressed);
  const partMap = new Map(parts.map((p) => [p.id, p] as const));
  const geom = new Map<string, PartGeometry>();
  for (const p of parts) {
    const g = geometryOf(project, p);
    geom.set(p.id, g);
    for (const e of g.errors) {
      issues.push({ severity: 'error', code: 'geometry.invalid', title: `${p.name}: part cannot be built as specified`, detail: e, parts: [p.id], joints: [] });
    }
    for (const w of g.warnings) {
      issues.push({ severity: 'warning', code: 'geometry.warning', title: `${p.name}: geometry`, detail: w, parts: [p.id], joints: [] });
    }
    if (!g.layers.length) {
      issues.push({ severity: 'error', code: 'geometry.empty', title: `${p.name} has no solid geometry`, detail: 'The part produces no volume with its current parameters, so it has no mass and cannot be exported.', parts: [p.id], joints: [] });
    }
  }

  const joints = project.joints.filter((j) => !j.suppressed);
  const valid: Joint[] = [];
  for (const j of joints) {
    const miss = [j.a, j.b].filter((id) => id !== GROUND && !partMap.has(id));
    if (miss.length) {
      const supp = miss.some((id) => project.parts.some((p) => p.id === id && p.suppressed));
      issues.push({
        severity: supp ? 'info' : 'error', code: supp ? 'joint.suppressed-part' : 'joint.missing-part',
        title: `${j.name}: ${supp ? 'part suppressed' : 'missing part'}`,
        detail: supp ? 'One of the connected parts is suppressed, so this joint is inactive.' : 'The joint refers to a part that no longer exists. Delete the joint or reconnect it.',
        parts: [j.a, j.b].filter((id) => partMap.has(id)), joints: [j.id],
      });
      continue;
    }
    if (j.a === j.b) {
      issues.push({ severity: 'error', code: 'joint.self', title: `${j.name}: connects a part to itself`, detail: 'A joint needs two different parts (or a part and the ground).', parts: [j.a].filter((x) => x !== GROUND), joints: [j.id] });
      continue;
    }
    const la = anchorLocal(project, j.a, j.anchorA), lb = anchorLocal(project, j.b, j.anchorB);
    if (j.type !== 'gear' && j.type !== 'belt' && j.type !== 'rackPinion' && (!la.ok || !lb.ok)) {
      issues.push({ severity: 'error', code: 'joint.missing-port', title: `${j.name}: anchor feature not found`, detail: `The joint refers to feature "${!la.ok ? j.anchorA.port : j.anchorB.port}" which this part no longer has (for example after changing its shape). Pick a new anchor.`, parts: [j.a, j.b].filter((x) => x !== GROUND), joints: [j.id] });
      continue;
    }
    valid.push(j);
  }

  // ---- rigid clusters
  const uf = new UnionFind();
  uf.find(GROUND);
  for (const p of parts) { uf.find(p.id); if (p.grounded) uf.union(p.id, GROUND); }
  if (mode !== 'assembly') for (const j of valid) if (j.type === 'rigid') uf.union(j.a, j.b);

  const clusters = new Map<string, Part[]>();
  for (const p of parts) {
    const r = uf.find(p.id);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r)!.push(p);
  }
  const bodies: BodyDef[] = [];
  const partRef = new Map<string, PartRef>();
  for (const [root, list] of clusters) {
    if (root === GROUND) {
      for (const p of list) partRef.set(p.id, { body: -1, lx: p.pose.x, ly: p.pose.y, la: p.pose.angle });
      continue;
    }
    let m = 0, sx = 0, sy = 0;
    const mp = list.map((p) => {
      const mpp = massProps(project, p);
      const [cx, cy] = rot(p.pose.angle, mpp.cx, mpp.cy);
      const wx = p.pose.x + cx, wy = p.pose.y + cy;
      m += mpp.mass; sx += mpp.mass * wx; sy += mpp.mass * wy;
      return { mpp, wx, wy };
    });
    const x0 = sx / m, y0 = sy / m;
    let I = 0;
    mp.forEach((q) => { I += q.mpp.inertia + q.mpp.mass * ((q.wx - x0) ** 2 + (q.wy - y0) ** 2); });
    const index = bodies.length;
    bodies.push({ index, partIds: list.map((p) => p.id), mass: m, inertia: Math.max(I, 1e-9), x0, y0, name: list.length === 1 ? list[0].name : `${list[0].name} +${list.length - 1}` });
    for (const p of list) partRef.set(p.id, { body: index, lx: p.pose.x - x0, ly: p.pose.y - y0, la: p.pose.angle });
  }

  const pointRef = (partId: string, lx: number, ly: number): PointRef => {
    if (partId === GROUND) return { body: -1, x: lx, y: ly };
    const r = partRef.get(partId)!;
    const [x, y] = rot(r.la, lx, ly);
    return { body: r.body, x: r.lx + x, y: r.ly + y };
  };
  const angleOf = (partId: string) => (partId === GROUND ? 0 : partRef.get(partId)!.la);
  const bodyOf = (partId: string) => (partId === GROUND ? -1 : partRef.get(partId)!.body);
  /** world coordinates at the design pose */
  const worldOf = (p: PointRef): [number, number] => (p.body < 0 ? [p.x, p.y] : [bodies[p.body].x0 + p.x, bodies[p.body].y0 + p.y]);

  const cons: Con[] = [];
  const rowInfo: MechModel['rowInfo'] = [];
  const coords = new Map<string, CoordDef>();
  const motors: MotorDef[] = [];
  const limits: LimitDef[] = [];
  const frictions: FrictionDef[] = [];
  const dampers: DamperDef[] = [];
  const springs: SpringDef[] = [];
  const cams: CamDef[] = [];
  let nRows = 0;
  const pushRows = (jointId: string, labels: [string, 'mm' | 'rad' | 'mm·rad'][]) => {
    const r = nRows;
    for (const [label, unit] of labels) rowInfo.push({ jointId, label, unit });
    nRows += labels.length;
    return r;
  };
  const nameOf = (id: string) => (id === GROUND ? 'ground' : partMap.get(id)?.name ?? id);

  // pass 1: revolute / prismatic / rigid (define coordinates)
  for (const j of valid) {
    if (j.type !== 'revolute' && j.type !== 'prismatic' && j.type !== 'rigid') continue;
    const la = anchorLocal(project, j.a, j.anchorA), lb = anchorLocal(project, j.b, j.anchorB);
    const pa = pointRef(j.a, la.x, la.y), pb = pointRef(j.b, lb.x, lb.y);
    if (pa.body === pb.body) {
      if (j.type === 'rigid' && mode !== 'assembly') continue; // merged
      const wa = worldOf(pa), wb = worldOf(pb);
      const gap = Math.hypot(wa[0] - wb[0], wa[1] - wb[1]);
      if (pa.body === -1 && gap > 1e-3 && j.type === 'revolute') {
        issues.push({ severity: 'error', code: 'assembly.fixed-mismatch', title: `${j.name}: anchors on fixed parts do not coincide`, detail: `Both ${nameOf(j.a)} and ${nameOf(j.b)} are fixed, but the joint anchors are ${gap.toFixed(3)} mm apart. Move one of the parts or un-ground it.`, parts: [j.a, j.b].filter((x) => x !== GROUND), joints: [j.id] });
      } else {
        issues.push({ severity: 'info', code: 'joint.no-effect', title: `${j.name} has no effect`, detail: `${nameOf(j.a)} and ${nameOf(j.b)} already belong to the same rigid group${pa.body === -1 ? ' (ground)' : ''}, so this joint cannot move.`, parts: [j.a, j.b].filter((x) => x !== GROUND), joints: [j.id] });
      }
      continue;
    }
    const ri: [number, number] = [pa.x, pa.y], rj: [number, number] = [pb.x, pb.y];
    if (j.type === 'rigid') {
      const ang0 = j.angle ?? 0;
      // (θB_part − θA_part) = angle  →  (Θj + laB) − (Θi + laA) = angle
      cons.push({ kind: 'weld', jointId: j.id, bi: pa.body, bj: pb.body, ri, rj, ang0: ang0 - (angleOf(j.b) - angleOf(j.a)), row: pushRows(j.id, [['x', 'mm'], ['y', 'mm'], ['angle', 'rad']]) });
      continue;
    }
    let axis: [number, number] = [1, 0];
    if (j.type === 'prismatic') {
      const portAxis = la.port?.axis;
      const aLocal = j.axisAngle ?? portAxis ?? 0;
      axis = rot(aLocal + angleOf(j.a), 1, 0);
    }
    const coord: CoordDef = { jointId: j.id, kind: j.type === 'revolute' ? 'rev' : 'pris', bi: pa.body, bj: pb.body, ri, rj, axis, zero: 0 };
    if (j.type === 'prismatic') {
      const wa = worldOf(pa), wb = worldOf(pb);
      coord.zero = axis[0] * (wb[0] - wa[0]) + axis[1] * (wb[1] - wa[1]);
      // relative orientation of B to A: the stored joint angle (older files without it keep the designed orientation)
      let ang0 = 0;
      if (j.angle !== undefined) { const d = j.angle - (angleOf(j.b) - angleOf(j.a)); ang0 = Math.atan2(Math.sin(d), Math.cos(d)); }
      cons.push({ kind: 'pris', jointId: j.id, bi: pa.body, bj: pb.body, ri, rj, axis, ang0, row: pushRows(j.id, [['offset', 'mm'], ['angle', 'rad']]) });
    } else {
      cons.push({ kind: 'rev', jointId: j.id, bi: pa.body, bj: pb.body, ri, rj, row: pushRows(j.id, [['x', 'mm'], ['y', 'mm']]) });
    }
    coords.set(j.id, coord);
    if (mode === 'assembly' && opts.lockMotors && j.motor?.enabled) {
      motors.push({ jointId: j.id, coord, spec: { ...j.motor, speed: 0 }, ideal: true });
    }
    if (mode !== 'assembly') {
      if (j.motor?.enabled) {
        const unlimited = j.motor.maxTorque === null || j.motor.maxTorque === undefined || !Number.isFinite(j.motor.maxTorque);
        if (mode === 'dynamic' && j.motor.type === 'dc' && (unlimited || !(j.motor.maxTorque! > 0))) {
          issues.push({
            severity: 'error', code: 'motor.dc-no-stall', title: `${j.name}: DC motor has no stall torque`,
            detail: 'A DC motor curve needs a stall torque (torque at zero speed) and a no-load speed; without a stall torque it can produce no torque at all. Enter a stall torque, or switch the motor type to "Speed-regulated (servo)" for an ideal drive. The motor is inactive until then.',
            parts: [], joints: [j.id],
          });
        } else {
          motors.push({ jointId: j.id, coord, spec: j.motor, ideal: (unlimited && j.motor.type !== 'dc') || mode === 'kinematic' });
        }
      }
      if (j.limits?.enabled) {
        if (j.limits.lower > j.limits.upper) {
          issues.push({ severity: 'error', code: 'joint.limits-inverted', title: `${j.name}: lower limit is above upper limit`, detail: 'Swap the limit values; the limits are ignored until then.', parts: [], joints: [j.id] });
        } else limits.push({ jointId: j.id, coord, lower: j.limits.lower, upper: j.limits.upper });
      }
      if (mode === 'dynamic') {
        if (j.friction && j.friction > 0) frictions.push({ jointId: j.id, coord, limit: j.friction });
        if (j.damping && j.damping > 0) dampers.push({ jointId: j.id, coord, c: j.damping });
      }
    }
  }

  // helper: pitch radius + centre of a rotating transmission part
  const pitchOf = (partId: string): { r: number; center: PointRef; module?: number; teeth?: number } | null => {
    const p = partMap.get(partId);
    if (!p) return null;
    const g = geom.get(partId)!;
    if (g.pitchRadius === undefined || !(g.pitchRadius > 0)) return null;
    const c = g.ports.find((q) => q.id === 'center');
    if (!c) return null;
    return { r: g.pitchRadius, center: pointRef(partId, c.x, c.y), module: p.kind === 'gear' ? p.params.module : undefined, teeth: p.kind === 'gear' ? Math.round(p.params.teeth) : undefined };
  };

  for (const j of valid) {
    const involved = [j.a, j.b].filter((x) => x !== GROUND);
    if (j.type === 'gear' || j.type === 'belt') {
      const A = pitchOf(j.a), B = pitchOf(j.b);
      if (!A || !B) {
        issues.push({ severity: 'error', code: 'coupling.invalid-part', title: `${j.name}: needs two ${j.type === 'gear' ? 'gears' : 'pulleys'}`, detail: `A ${j.type === 'gear' ? 'gear mesh' : 'belt'} connects two parts with a pitch circle (${j.type === 'gear' ? 'spur gears' : 'pulleys or gears'}).`, parts: involved, joints: [j.id] });
        continue;
      }
      if (A.center.body === B.center.body) {
        issues.push({ severity: 'error', code: 'coupling.same-body', title: `${j.name}: both wheels are on the same rigid group`, detail: 'The two wheels cannot rotate relative to each other, so the coupling would lock the assembly. Mount each wheel on its own shaft/revolute joint.', parts: involved, joints: [j.id] });
        continue;
      }
      const wa = worldOf(A.center), wb = worldOf(B.center);
      const dist = Math.hypot(wb[0] - wa[0], wb[1] - wa[1]);
      const psi = Math.atan2(wb[1] - wa[1], wb[0] - wa[0]);
      const offA = angleOf(j.a), offB = angleOf(j.b);
      const isBelt = j.type === 'belt';
      const sigma = isBelt ? (j.crossed ? 1 : -1) : 1;
      const cur = A.r * (offA - psi) + sigma * B.r * (offB - psi);
      let c0 = cur;
      if (!isBelt) {
        const pa = partMap.get(j.a)!, pb = partMap.get(j.b)!;
        if (pa.kind !== 'gear' || pb.kind !== 'gear') {
          issues.push({ severity: 'error', code: 'coupling.invalid-part', title: `${j.name}: needs two spur gears`, detail: 'A gear mesh connects two spur gears.', parts: involved, joints: [j.id] });
          continue;
        }
        if (Math.abs(A.module! - B.module!) > 1e-9) {
          issues.push({ severity: 'error', code: 'gear.module-mismatch', title: `${j.name}: modules differ`, detail: `${pa.name} has module ${A.module} mm but ${pb.name} has module ${B.module} mm. Gears only mesh when their modules (tooth size) are equal.`, parts: involved, joints: [j.id] });
          continue;
        }
        if (Math.abs(pa.params.pressureAngle - pb.params.pressureAngle) > 1e-6) {
          issues.push({ severity: 'warning', code: 'gear.pressure-angle', title: `${j.name}: pressure angles differ`, detail: 'The two gears have different pressure angles; their involutes are not conjugate.', parts: involved, joints: [j.id] });
        }
        const need = A.r + B.r;
        if (Math.abs(dist - need) > 0.02 + 1e-4 * need) {
          issues.push({ severity: 'error', code: 'gear.center-distance', title: `${j.name}: centre distance is wrong`, detail: `The axes of ${pa.name} and ${pb.name} are ${dist.toFixed(3)} mm apart, but their pitch circles (${(2 * A.r).toFixed(2)} + ${(2 * B.r).toFixed(2)} mm) need ${need.toFixed(3)} mm. ${dist < need ? 'The teeth overlap.' : 'The teeth do not reach each other.'} Use "Solve assembly" or move a shaft.`, parts: involved, joints: [j.id] });
        }
        const p = Math.PI * A.module!;
        const base = (p / 2) * (B.teeth! - 1);
        const k = Math.round((cur - base) / p);
        const phase = base + k * p;
        if (mode === 'assembly') c0 = phase;
        else if (Math.abs(cur - phase) > 0.03 * p) {
          issues.push({ severity: 'warning', code: 'gear.phase', title: `${j.name}: teeth are out of phase`, detail: `The teeth of ${pa.name} and ${pb.name} are offset by ${(Math.abs(cur - phase)).toFixed(2)} mm along the pitch circle from proper mesh, so they overlap visually. Use "Solve assembly" to re-phase.`, parts: involved, joints: [j.id] });
        }
      } else if (dist < 1e-6) {
        issues.push({ severity: 'error', code: 'belt.coaxial', title: `${j.name}: pulleys are coaxial`, detail: 'A belt needs two pulleys on different axes.', parts: involved, joints: [j.id] });
        continue;
      } else if (!j.crossed && dist < Math.abs(A.r - B.r) + 1e-6) {
        issues.push({ severity: 'error', code: 'belt.routing', title: `${j.name}: belt cannot be routed`, detail: 'One pulley lies inside the other, so there is no common tangent for the belt.', parts: involved, joints: [j.id] });
        continue;
      } else if (j.crossed && dist < A.r + B.r) {
        issues.push({ severity: 'error', code: 'belt.routing', title: `${j.name}: crossed belt cannot be routed`, detail: 'The pulleys overlap, so a crossed belt has no tangent lines.', parts: involved, joints: [j.id] });
        continue;
      }
      cons.push({
        kind: 'gear', jointId: j.id, bi: A.center.body, bj: B.center.body, ca: [A.center.x, A.center.y], cb: [B.center.x, B.center.y],
        ra: A.r, rb: B.r, sigma, offA, offB, c0, belt: isBelt, row: pushRows(j.id, [[isBelt ? 'belt' : 'mesh', 'mm·rad']]),
      });
    } else if (j.type === 'rackPinion') {
      const pin = pitchOf(j.a);
      const rackPart = partMap.get(j.b);
      if (!pin || !rackPart || rackPart.kind !== 'rack' || partMap.get(j.a)!.kind !== 'gear') {
        issues.push({ severity: 'error', code: 'coupling.invalid-part', title: `${j.name}: needs a gear (A) and a rack (B)`, detail: 'A rack-and-pinion coupling connects a spur gear (part A) to a rack (part B).', parts: involved, joints: [j.id] });
        continue;
      }
      if (Math.abs(pin.module! - rackPart.params.module) > 1e-9) {
        issues.push({ severity: 'error', code: 'gear.module-mismatch', title: `${j.name}: modules differ`, detail: `Pinion module ${pin.module} mm ≠ rack module ${rackPart.params.module} mm.`, parts: involved, joints: [j.id] });
        continue;
      }
      const o = pointRef(j.b, 0, 0);
      if (o.body === pin.center.body) {
        issues.push({ severity: 'error', code: 'coupling.same-body', title: `${j.name}: pinion and rack are rigidly connected`, detail: 'They cannot move relative to each other.', parts: involved, joints: [j.id] });
        continue;
      }
      const offR = angleOf(j.b), offP = angleOf(j.a);
      const aw = rot(offR, 1, 0);
      const wo = worldOf(o), wc = worldOf(pin.center);
      const dx = wc[0] - wo[0], dy = wc[1] - wo[1];
      const s = aw[0] * dx + aw[1] * dy;
      const side = -aw[1] * dx + aw[0] * dy;
      if (side <= 0) {
        issues.push({ severity: 'error', code: 'rack.wrong-side', title: `${j.name}: pinion is behind the rack`, detail: 'The pinion axis is on the back (non-toothed) side of the rack. Flip the rack or move the pinion.', parts: involved, joints: [j.id] });
        continue;
      }
      if (Math.abs(side - pin.r) > 0.02) {
        issues.push({ severity: 'error', code: 'gear.center-distance', title: `${j.name}: pinion height above rack is wrong`, detail: `The pinion axis is ${side.toFixed(3)} mm from the rack pitch line but its pitch radius is ${pin.r.toFixed(3)} mm. Use "Solve assembly" or move the rack.`, parts: involved, joints: [j.id] });
      }
      const sigma = -1;
      const cur = s - sigma * pin.r * (offP - offR);
      const p = Math.PI * pin.module!;
      const base = -pin.r * Math.PI / 2;
      const phase = base + Math.round((cur - base) / p) * p;
      let c0 = cur;
      if (mode === 'assembly') c0 = phase;
      else if (Math.abs(cur - phase) > 0.03 * p) {
        issues.push({ severity: 'warning', code: 'gear.phase', title: `${j.name}: teeth are out of phase`, detail: `Rack and pinion teeth are offset by ${Math.abs(cur - phase).toFixed(2)} mm from proper mesh. Use "Solve assembly" to re-phase.`, parts: involved, joints: [j.id] });
      }
      const len = rackPart.params.teeth * p;
      if (s < 0 || s > len) {
        issues.push({ severity: 'warning', code: 'rack.off-end', title: `${j.name}: pinion is beyond the end of the rack`, detail: `The pinion sits at ${s.toFixed(1)} mm along a ${len.toFixed(1)} mm rack.`, parts: involved, joints: [j.id] });
      }
      const axisLocal = rot(o.body < 0 ? offR : partRef.get(j.b)!.la, 1, 0);
      cons.push({
        kind: 'rack', jointId: j.id, bi: pin.center.body, bj: o.body, cp: [pin.center.x, pin.center.y], o: [o.x, o.y], axis: axisLocal,
        r: pin.r, sigma, offP, offR, c0, row: pushRows(j.id, [['mesh', 'mm·rad']]),
      });
    } else if (j.type === 'cam') {
      const camPart = partMap.get(j.a), fol = partMap.get(j.b);
      if (!camPart || camPart.kind !== 'cam' || !fol) {
        issues.push({ severity: 'error', code: 'cam.invalid-part', title: `${j.name}: part A must be a cam`, detail: 'A cam contact connects a plate cam (part A) to a roller on another part (part B).', parts: involved, joints: [j.id] });
        continue;
      }
      const lb = anchorLocal(project, j.b, j.anchorB);
      const rollerR = lb.port?.r ?? camPart.params.rollerRadius;
      const params = camParamsOf(camPart.params);
      if (Math.abs(rollerR - params.rollerRadius) > 1e-6) {
        issues.push({ severity: 'warning', code: 'cam.roller-mismatch', title: `${j.name}: roller radius differs from the cam's design roller`, detail: `The cam surface was generated for a ${params.rollerRadius.toFixed(2)} mm roller radius but the follower roller is ${rollerR.toFixed(2)} mm. Contact is computed for the cam's design roller path shifted by the difference, which is only approximate. Set the cam's "Design roller radius" to ${rollerR.toFixed(2)} mm.`, parts: involved, joints: [j.id] });
      }
      const center = pointRef(j.a, 0, 0);
      const roller = pointRef(j.b, lb.x, lb.y);
      if (center.body === roller.body) {
        issues.push({ severity: 'error', code: 'coupling.same-body', title: `${j.name}: cam and follower are rigidly connected`, detail: 'They cannot move relative to each other.', parts: involved, joints: [j.id] });
        continue;
      }
      cams.push({
        jointId: j.id, camBody: center.body, camCenter: [center.x, center.y], camAngle: center.body < 0 ? angleOf(j.a) : partRef.get(j.a)!.la,
        followerBody: roller.body, roller: [roller.x, roller.y], rollerR, params: { ...params }, camPart: j.a, followerPart: j.b,
      });
    } else if (j.type === 'spring') {
      const la = anchorLocal(project, j.a, j.anchorA), lb = anchorLocal(project, j.b, j.anchorB);
      const pa = pointRef(j.a, la.x, la.y), pb = pointRef(j.b, lb.x, lb.y);
      const wa = worldOf(pa), wb = worldOf(pb);
      const L = Math.hypot(wb[0] - wa[0], wb[1] - wa[1]);
      const k = j.stiffness ?? 0;
      const L0 = j.freeLength ?? (k > 0 && j.preload !== undefined ? L + j.preload / k : L);
      if (pa.body === pb.body) {
        issues.push({ severity: 'info', code: 'joint.no-effect', title: `${j.name} has no effect`, detail: 'Both ends of the spring are on the same rigid group.', parts: involved, joints: [j.id] });
        continue;
      }
      if (L < 1e-6) {
        issues.push({ severity: 'warning', code: 'spring.zero-length', title: `${j.name}: spring ends coincide`, detail: 'The spring has zero length at the design pose; its direction is undefined until the ends separate.', parts: involved, joints: [j.id] });
      }
      if (mode === 'dynamic') springs.push({ jointId: j.id, pa, pb, k, L0, c: j.springDamping ?? 0, designLength: L });
    }
  }

  // ---- loads
  const loads: LoadDef[] = [];
  if (mode === 'dynamic') {
    for (const l of project.loads) {
      if (!l.enabled) continue;
      if (!partMap.has(l.part)) {
        issues.push({ severity: 'warning', code: 'load.missing-part', title: `${l.name}: part not found`, detail: 'The load refers to a part that is missing or suppressed and is ignored.', parts: [], joints: [] });
        continue;
      }
      const a = anchorLocal(project, l.part, l.anchor);
      const p = pointRef(l.part, a.x, a.y);
      if (p.body < 0) {
        issues.push({ severity: 'info', code: 'load.on-ground', title: `${l.name} acts on a fixed part`, detail: 'The loaded part is grounded, so the load does nothing.', parts: [l.part], joints: [] });
        continue;
      }
      loads.push({ loadId: l.id, p, fx: l.type === 'force' ? l.fx : 0, fy: l.type === 'force' ? l.fy : 0, torque: l.type === 'torque' ? l.torque : 0, frame: l.frame, la: partRef.get(l.part)!.la, tStart: l.tStart ?? 0, tEnd: l.tEnd ?? Infinity, partId: l.part });
    }
  }

  // ---- floor contacts
  const floorContacts: FloorContactDef[] = [];
  const floorEnabled = mode === 'dynamic' && project.sim.floor.enabled;
  if (floorEnabled) {
    for (const p of parts) {
      const r = partRef.get(p.id)!;
      if (r.body < 0) continue;
      const g = geom.get(p.id)!;
      const mu = project.sim.floor.friction * (materialOf(project, p.materialId).frictionFactor ?? 1);
      g.contactCircles.forEach((c, i) => {
        const [x, y] = rot(r.la, c.x, c.y);
        floorContacts.push({ body: r.body, partId: p.id, x: r.lx + x, y: r.ly + y, r: c.r, mu, key: `${p.id}:c${i}` });
      });
      g.contactPoints.forEach((c, i) => {
        const [x, y] = rot(r.la, c[0], c[1]);
        floorContacts.push({ body: r.body, partId: p.id, x: r.lx + x, y: r.ly + y, r: 0, mu, key: `${p.id}:p${i}` });
      });
    }
  }

  // ---- global sanity
  if (mode !== 'assembly') {
    if (parts.length === 0) {
      issues.push({ severity: 'info', code: 'model.empty', title: 'Nothing to simulate', detail: 'Add components from the library, connect them with joints and ground at least one part.', parts: [], joints: [] });
    } else if (bodies.length === 0) {
      issues.push({ severity: 'info', code: 'model.all-fixed', title: 'Every part is fixed', detail: 'All parts are grounded or rigidly attached to ground, so nothing can move.', parts: [], joints: [] });
    }
    const anyStatic = parts.some((p) => partRef.get(p.id)!.body < 0) || cons.some((c) => c.bi < 0 || c.bj < 0);
    if (bodies.length > 0 && !anyStatic && !floorEnabled && mode === 'dynamic' && project.sim.gravityEnabled) {
      issues.push({ severity: 'warning', code: 'model.no-ground', title: 'Nothing is grounded', detail: 'No part is fixed to the ground and the floor is off, so with gravity on the whole assembly will fall. Ground a part (G) or enable the floor.', parts: [], joints: [] });
    }
    if (mode === 'kinematic' && project.sim.floor.enabled) {
      issues.push({ severity: 'info', code: 'model.kinematic-floor', title: 'Floor contact is ignored in kinematic mode', detail: 'Kinematic mode solves geometry only. Switch to dynamic mode for gravity, contact and friction.', parts: [], joints: [] });
    }
    if (motors.length === 0 && mode === 'kinematic' && bodies.length > 0) {
      issues.push({ severity: 'info', code: 'model.no-driver', title: 'No motor drives the mechanism', detail: 'Kinematic mode moves only what motors prescribe. Add a motor to a revolute or prismatic joint.', parts: [], joints: [] });
    }
  }

  return {
    mode, project, bodies, partRef, geom, cons, nRows, rowInfo, coords, motors, limits, frictions, dampers, springs,
    loads, cams, floorContacts,
    gravity: project.sim.gravityEnabled ? { ...project.sim.gravity } : { x: 0, y: 0 },
    floorY: project.sim.floor.y, floorEnabled, issues, activeParts: parts.map((p) => p.id),
  };
}

/** World pose of a part given body states q (x, y, θ per body). */
export function partPose(model: MechModel, q: Float64Array | null, partId: string): { x: number; y: number; angle: number } | null {
  const r = model.partRef.get(partId);
  if (!r) return null;
  if (r.body < 0) return { x: r.lx, y: r.ly, angle: r.la };
  const b = model.bodies[r.body];
  const x = q ? q[3 * r.body] : b.x0, y = q ? q[3 * r.body + 1] : b.y0, a = q ? q[3 * r.body + 2] : 0;
  const c = Math.cos(a), s = Math.sin(a);
  return { x: x + c * r.lx - s * r.ly, y: y + s * r.lx + c * r.ly, angle: a + r.la };
}

/** Body-frame reference for a part-local point. */
export function partPointRef(model: MechModel, partId: string, lx: number, ly: number): PointRef | null {
  const r = model.partRef.get(partId);
  if (!r) return null;
  const c = Math.cos(r.la), s = Math.sin(r.la);
  return { body: r.body, x: r.lx + c * lx - s * ly, y: r.ly + s * lx + c * ly };
}
