/**
 * Design-time assembly solving: after an edit, find part poses that satisfy
 * every joint while moving as little as possible. If no such pose exists the
 * project is returned UNCHANGED together with a diagnosis (nothing is
 * silently deformed).
 */
import type { Joint, Part, Pose, Project } from '../model/types';
import { GROUND } from '../model/types';
import { compile, partPose, type Diagnostic, type MechModel } from './compile';
import { Simulation } from '../sim/solver';
import { anchorLocal, anchorWorld, geometryOf, localToWorld, massProps, worldToLocal } from '../model/project';
import { freeGroupOf, nudgeParts, setPartPose, setPartPoseDriving } from '../model/ops';

export interface AssemblyResult {
  ok: boolean;
  /** project with solved poses (identical object when nothing moved or when ok = false) */
  project: Project;
  pos: number;
  ang: number;
  iterations: number;
  /** largest part displacement applied, mm */
  moved: number;
  issues: Diagnostic[];
  worst: { jointId: string; label: string; value: number; unit: string }[];
  model: MechModel;
}

function rigidClusters(project: Project): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (a: string): string => { let p = parent.get(a) ?? a; while (p !== (parent.get(p) ?? p)) p = parent.get(p)!; parent.set(a, p); return p; };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra === GROUND ? rb : ra, ra === GROUND ? ra : rb); };
  for (const p of project.parts) { if (p.suppressed) continue; find(p.id); if (p.grounded) union(p.id, GROUND); }
  for (const j of project.joints) if (!j.suppressed && j.type === 'rigid') union(j.a, j.b);
  const out = new Map<string, string>();
  for (const p of project.parts) if (!p.suppressed) out.set(p.id, find(p.id));
  out.set(GROUND, find(GROUND));
  return out;
}

/**
 * Enforce the positional requirements of gear meshes and rack-and-pinion
 * pairs: part B's shaft follows part A so that the pitch circles touch. The
 * rigid group of B is translated and the carrier-side anchors of its joints
 * move with it (ground anchors, free anchors and base-plate holes).
 */
export function propagateCouplings(project: Project): Project {
  let cur = project;
  const maxPass = project.joints.length + 1;
  for (let pass = 0; pass < maxPass; pass++) {
    let changed = false;
    for (const j of cur.joints) {
      if (j.suppressed || (j.type !== 'gear' && j.type !== 'rackPinion')) continue;
      const A = cur.parts.find((p) => p.id === j.a), B = cur.parts.find((p) => p.id === j.b);
      if (!A || !B || A.suppressed || B.suppressed) continue;
      const ga = geometryOf(cur, A), gb = geometryOf(cur, B);
      let dx = 0, dy = 0;
      if (j.type === 'gear') {
        if (!(ga.pitchRadius! > 0) || !(gb.pitchRadius! > 0)) continue;
        const need = ga.pitchRadius! + gb.pitchRadius!;
        let ux = B.pose.x - A.pose.x, uy = B.pose.y - A.pose.y;
        const d = Math.hypot(ux, uy);
        if (d < 1e-9) { ux = 1; uy = 0; } else { ux /= d; uy /= d; }
        if (Math.abs(d - need) < 1e-6) continue;
        dx = A.pose.x + ux * need - B.pose.x; dy = A.pose.y + uy * need - B.pose.y;
      } else {
        if (A.kind !== 'gear' || B.kind !== 'rack' || !(ga.pitchRadius! > 0)) continue;
        const nx = -Math.sin(B.pose.angle), ny = Math.cos(B.pose.angle);
        const side = nx * (A.pose.x - B.pose.x) + ny * (A.pose.y - B.pose.y);
        if (Math.abs(side - ga.pitchRadius!) < 1e-6) continue;
        dx = nx * (side - ga.pitchRadius!); dy = ny * (side - ga.pitchRadius!);
      }
      let next = moveRigidGroup(cur, B.id, dx, dy, A.id);
      // B cannot move (grounded, or fixed to ground): bring A to it instead
      if (next === cur) next = moveRigidGroup(cur, A.id, -dx, -dy, B.id);
      if (next !== cur) { cur = next; changed = true; }
    }
    if (!changed) break;
  }
  return cur;
}

/** Translate the rigid group containing `partId`; carrier anchors follow. Returns the same project if the group is fixed. */
export function moveRigidGroup(project: Project, partId: string, dx: number, dy: number, fixedPart?: string): Project {
  const cl = rigidClusters(project);
  const root = cl.get(partId);
  if (root === undefined || root === cl.get(GROUND)) return project;
  if (fixedPart && cl.get(fixedPart) === root) return project;
  const inGroup = (id: string) => id !== GROUND && cl.get(id) === root;
  let parts = project.parts.map((p) => (inGroup(p.id) ? { ...p, pose: { ...p.pose, x: p.pose.x + dx, y: p.pose.y + dy } } : p));
  const joints = project.joints.map((j): Joint => {
    if (j.suppressed || (j.type !== 'revolute' && j.type !== 'prismatic')) return j;
    const aIn = inGroup(j.a), bIn = inGroup(j.b);
    if (aIn === bIn) return j;
    const otherId = aIn ? j.b : j.a;
    const key = aIn ? 'anchorB' : 'anchorA';
    const anchor = j[key];
    if (otherId === GROUND) return { ...j, [key]: { ...anchor, x: (anchor.x ?? 0) + dx, y: (anchor.y ?? 0) + dy } };
    const other = parts.find((p) => p.id === otherId);
    if (!other) return j;
    const c = Math.cos(other.pose.angle), s = Math.sin(other.pose.angle);
    const lx = c * dx + s * dy, ly = -s * dx + c * dy;
    if (anchor.port === undefined) return { ...j, [key]: { x: (anchor.x ?? 0) + lx, y: (anchor.y ?? 0) + ly } };
    // base-plate hole follows the shaft
    const m = /^H(\d+)$/.exec(anchor.port);
    if (other.kind === 'baseplate' && m) {
      const idx = parseInt(m[1], 10) - 1;
      const holes = (other.params.holes as { x: number; y: number; d: number }[]).map((h, i) => (i === idx ? { ...h, x: h.x + lx, y: h.y + ly } : h));
      parts = parts.map((p) => (p.id === other.id ? { ...p, params: { ...p.params, holes } } : p));
    }
    return j;
  });
  return { ...project, parts, joints };
}

export interface DragSpec { partId: string; lx: number; ly: number; tx: number; ty: number }

export function solveAssembly(input: Project, opts: { drag?: DragSpec; propagate?: boolean; lockMotors?: boolean } = {}): AssemblyResult {
  if (opts.propagate === false || opts.drag) return solveOnce(input, opts);
  // Closing the joints (which also re-phases gear teeth) can shift wheels that are not yet held by
  // shafts, so the pitch-circle distances are re-established and the joints re-closed until both agree.
  let project = propagateCouplings(input);
  let res = solveOnce(project, opts);
  for (let pass = 0; pass < 4 && res.ok; pass++) {
    const again = propagateCouplings(res.project);
    if (again === res.project) break;
    const moved = res.moved;
    res = solveOnce(again, opts);
    res.moved = Math.max(res.moved, moved);
  }
  return res;
}

function solveOnce(project: Project, opts: { drag?: DragSpec; lockMotors?: boolean }): AssemblyResult {
  // First try with motorised joints held at their design coordinate, so an edit elsewhere does not
  // silently turn a crank or a cam. If that is impossible (or the user is dragging), release them.
  if (!opts.drag && opts.lockMotors !== false && project.joints.some((j) => !j.suppressed && j.motor?.enabled)) {
    const locked = solveWith(project, compile(project, 'assembly', { lockMotors: true }), undefined);
    if (locked.ok) return locked;
  }
  return solveWith(project, compile(project, 'assembly'), opts.drag);
}

function solveWith(project: Project, model: MechModel, dragSpec: DragSpec | undefined): AssemblyResult {
  const opts = { drag: dragSpec };
  const sim = new Simulation(model, 1);
  let drag;
  if (opts.drag) {
    const r = model.partRef.get(opts.drag.partId);
    if (r && r.body >= 0) {
      const c = Math.cos(r.la), s = Math.sin(r.la);
      drag = { body: r.body, lx: r.lx + c * opts.drag.lx - s * opts.drag.ly, ly: r.ly + s * opts.drag.lx + c * opts.drag.ly, tx: opts.drag.tx, ty: opts.drag.ty, weight: 0.7 };
    }
  }
  const res = sim.projectToConstraints(80, drag);
  const issues = [...model.issues];
  if (!res.ok) {
    const rr = sim.rowResiduals().filter((r) => Math.abs(r.value) > (r.unit === 'rad' ? 1e-6 : 1e-4));
    const byJoint = new Map<string, { jointId: string; label: string; value: number; unit: string }>();
    for (const r of rr) { const e = byJoint.get(r.jointId); if (!e || Math.abs(r.value) > Math.abs(e.value)) byJoint.set(r.jointId, r); }
    const worst = [...byJoint.values()].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 4);
    const jn = (id: string) => project.joints.find((j) => j.id === id)?.name ?? id;
    const involvedParts = new Set<string>();
    for (const w of worst) { const j = project.joints.find((x) => x.id === w.jointId); if (j) { if (j.a !== GROUND) involvedParts.add(j.a); if (j.b !== GROUND) involvedParts.add(j.b); } }
    issues.push({
      severity: 'error', code: 'assembly.cannot-close',
      title: 'Assembly cannot be closed',
      detail: `No position of the parts satisfies all joints at once. Remaining gaps after the best attempt: ${worst.map((w) => `${jn(w.jointId)} ${Math.abs(w.value).toFixed(w.unit === 'rad' ? 4 : 3)} ${w.unit}`).join(', ')}. This usually means a link is too short or too long to reach its joints (the loop cannot close), or that two joints demand different positions for the same part. The parts were left where they were.`,
      parts: [...involvedParts], joints: worst.map((w) => w.jointId),
    });
    return { ok: false, project, pos: res.pos, ang: res.ang, iterations: res.iterations, moved: 0, issues, worst, model };
  }
  let moved = 0;
  let any = false;
  const parts = project.parts.map((p): Part => {
    const pose = partPose(model, sim.q, p.id);
    if (!pose) return p;
    const d = Math.hypot(pose.x - p.pose.x, pose.y - p.pose.y) + Math.abs(pose.angle - p.pose.angle) * 10;
    if (d < 1e-10) return p;
    moved = Math.max(moved, d);
    any = true;
    return { ...p, pose: { ...p.pose, x: pose.x, y: pose.y, angle: pose.angle } };
  });
  return { ok: true, project: any ? { ...project, parts } : project, pos: res.pos, ang: res.ang, iterations: res.iterations, moved, issues, worst: [], model };
}

export interface PoseEdit { project: Project; how: 'plain' | 'rigid-group' | 'pinned' }

/**
 * Apply a pose the user asked for on one part ("this part goes there"), by typing or by keys.
 *
 *  - A grounded part, or a part with no joints, is simply posed.
 *  - In a jointed group that floats freely (nothing grounded) the whole group moves as one rigid body,
 *    so the value is met exactly — except a rotation of the driven side of a motorised joint, which
 *    sets that joint's angle instead (the crank turns, the machine does not).
 *  - Otherwise the part (with whatever is rigidly fixed to it) is held at the requested pose and the
 *    rest of the mechanism follows through its joints, motors first held and then released as in any
 *    assembly solve. A rotation that cannot be made about the part's own origin is tried about each of
 *    its pivots (the angle is what was asked for; the origin then moves round the pivot).
 *  - If the mechanism cannot follow, the part alone is posed ('plain'): the ordinary assembly solve then
 *    undoes or adjusts it and the caller reports that.
 */
export function applyPoseEdit(project: Project, partId: string, patch: Partial<Pose>): PoseEdit {
  const part = project.parts.find((p) => p.id === partId);
  const plain = (): PoseEdit => ({ project: setPartPose(project, partId, patch), how: 'plain' });
  if (!part || part.suppressed) return plain();
  const nx = patch.x ?? part.pose.x, ny = patch.y ?? part.pose.y, na = patch.angle ?? part.pose.angle;
  const da = na - part.pose.angle;
  const turns = Math.abs(da) > 1e-12, shifts = Math.abs(nx - part.pose.x) > 1e-12 || Math.abs(ny - part.pose.y) > 1e-12;
  if (!turns && !shifts) return plain();
  const cl = rigidClusters(project);
  const root = cl.get(partId);
  if (root === undefined || root === cl.get(GROUND)) return plain();
  const group = freeGroupOf(project, partId);
  if (group && group.length === 1) return plain();
  const motor = turns ? drivenByMotor(project, cl, root) : null;
  const driven = !!motor;
  if (group && !driven) return { project: setPartPoseDriving(project, partId, patch), how: 'rigid-group' };

  const inCluster = (id: string) => id !== GROUND && cl.get(id) === root;
  const o0 = part.pose;
  /**
   * Hold the part's rigid cluster on a path from where it is to the requested pose and let everything
   * else follow, in small steps so a linkage stays on its current closure. `centre` = turn about that
   * point instead of the part's own origin. With `carrier`, the other side of the motor joint is held
   * still as well (turning a crank must not tilt the machine it is mounted on).
   */
  const pinned = (centre: { x: number; y: number } | null, carrier: string | null): Project | null => {
    const poseAt = (f: number) => {
      const a = f * da, c = Math.cos(a), sn = Math.sin(a);
      if (centre) { const rx = o0.x - centre.x, ry = o0.y - centre.y; return { x: centre.x + c * rx - sn * ry, y: centre.y + sn * rx + c * ry, a }; }
      return { x: o0.x + f * (nx - o0.x), y: o0.y + f * (ny - o0.y), a };
    };
    const end = poseAt(1);
    const steps = Math.min(72, Math.max(1, Math.ceil(Math.abs(da) / (10 * Math.PI / 180)), Math.ceil(Math.hypot(end.x - o0.x, end.y - o0.y) / 5)));
    const run = (n: number): Project | null => {
      let cur = project;
      for (let k = 1; k <= n; k++) {
        const t = poseAt(k / n), c = Math.cos(t.a), sn = Math.sin(t.a);
        const held: Project = {
          ...cur,
          parts: cur.parts.map((q) => {
            if (q.id === partId) return { ...q, grounded: true, pose: { ...q.pose, ...(k === n ? patch : {}), x: t.x, y: t.y, angle: k === n ? na : o0.angle + t.a } };
            if (q.id === carrier) return { ...q, grounded: true };
            if (!inCluster(q.id)) return q;
            const orig = project.parts.find((x) => x.id === q.id)!.pose;
            const rx = orig.x - o0.x, ry = orig.y - o0.y;
            return { ...q, pose: { ...q.pose, x: t.x + c * rx - sn * ry, y: t.y + sn * rx + c * ry, angle: orig.angle + t.a } };
          }),
        };
        const res = solveAssembly(held, driven ? { lockMotors: false } : {});
        if (!res.ok) return null;
        cur = res.project;
      }
      return cur;
    };
    const solved = run(steps) ?? (steps > 1 ? run(1) : null);
    if (!solved) return null;
    const wasGrounded = (id: string) => !!project.parts.find((x) => x.id === id)?.grounded;
    const out: Project = { ...solved, parts: solved.parts.map((q) => (q.id === partId || q.id === carrier ? { ...q, grounded: wasGrounded(q.id) } : q)) };
    // A joint between the held part and ground is not seen while the part is held: the result only counts
    // if nothing has to move once the hold is released.
    const check = solveAssembly(out);
    return check.ok && check.moved < 1e-6 ? out : null;
  };
  const tryAt = (centre: { x: number; y: number } | null): Project | null => (motor?.carrier ? pinned(centre, motor.carrier) : null) ?? pinned(centre, null);
  let out = tryAt(null);
  if (!out && turns && patch.x === undefined && patch.y === undefined) {
    // the angle is what was asked for: try turning about each pivot of the part instead of its origin
    const pivots: { x: number; y: number; toGround: boolean }[] = [];
    for (const j of project.joints) {
      if (j.suppressed || j.type !== 'revolute') continue;
      const aIn = inCluster(j.a), bIn = inCluster(j.b);
      if (aIn === bIn) continue;
      const w = aIn ? anchorWorld(project, j.a, j.anchorA) : anchorWorld(project, j.b, j.anchorB);
      if (!w.ok || Math.hypot(w.x - o0.x, w.y - o0.y) < 1e-9) continue;
      pivots.push({ x: w.x, y: w.y, toGround: cl.get(aIn ? j.b : j.a) === cl.get(GROUND) });
    }
    pivots.sort((p, q) => Number(q.toGround) - Number(p.toGround));
    for (const pv of pivots.slice(0, 6)) { out = tryAt(pv); if (out) break; }
  }
  return out ? { project: out, how: 'pinned' } : plain();
}

/** Keyboard nudge of the selected parts: one part behaves like a typed position; several move together. */
export function applyNudge(project: Project, ids: string[], dx: number, dy: number): Project {
  const only = ids.length === 1 ? project.parts.find((p) => p.id === ids[0]) : undefined;
  if (only) return applyPoseEdit(project, only.id, { x: only.pose.x + dx, y: only.pose.y + dy }).project;
  return nudgeParts(project, ids, dx, dy);
}

/**
 * Is this rigid cluster the driven (lighter) side of an enabled motor joint? Ground counts as infinitely
 * heavy. Returns the part that carries the motor (null when that side is ground), or null if not driven.
 */
function drivenByMotor(project: Project, cl: Map<string, string>, root: string): { carrier: string | null } | null {
  const ground = cl.get(GROUND);
  const mass = (r: string | undefined) => (r === undefined || r === ground ? Infinity : project.parts.reduce((m, p) => (!p.suppressed && cl.get(p.id) === r ? m + massProps(project, p).mass : m), 0));
  for (const j of project.joints) {
    if (j.suppressed || !j.motor?.enabled) continue;
    const ra = cl.get(j.a), rb = cl.get(j.b);
    if (ra === rb || (ra !== root && rb !== root)) continue;
    const other = ra === root ? rb : ra, otherId = ra === root ? j.b : j.a;
    if (mass(root) <= mass(other)) return { carrier: other === ground || otherId === GROUND ? null : otherId };
  }
  return null;
}

/** Residual gap of each positional joint at the design pose (for overlays / diagnostics). */
export function jointGaps(project: Project): { jointId: string; gap: number }[] {
  const out: { jointId: string; gap: number }[] = [];
  for (const j of project.joints) {
    if (j.suppressed || (j.type !== 'revolute' && j.type !== 'rigid')) continue;
    const pa = j.a === GROUND ? null : project.parts.find((p) => p.id === j.a);
    const pb = j.b === GROUND ? null : project.parts.find((p) => p.id === j.b);
    if ((j.a !== GROUND && !pa) || (j.b !== GROUND && !pb)) continue;
    const la = anchorLocal(project, j.a, j.anchorA), lb = anchorLocal(project, j.b, j.anchorB);
    const wa = pa ? localToWorld(pa.pose, la.x, la.y) : la;
    const wb = pb ? localToWorld(pb.pose, lb.x, lb.y) : lb;
    out.push({ jointId: j.id, gap: Math.hypot(wa.x - wb.x, wa.y - wb.y) });
  }
  return out;
}

export { worldToLocal };
