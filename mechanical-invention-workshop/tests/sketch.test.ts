import { describe, it, expect } from 'vitest';
import type { Sketch, SkConstraint } from '../src/core/sketch/types';
import { solveSketch, applySolve, constraintResiduals, _jacobianMaxError } from '../src/core/sketch/solver';
import { extractProfiles } from '../src/core/sketch/profiles';
import {
  newSketch, addPoint, addLine, addCircle, addArc, addConstraint, removeItems, rectangle,
  type DistributiveOmit,
} from '../src/core/sketch/ops';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** tiny mutable wrapper around the immutable ops, to keep the tests readable */
class Build {
  s: Sketch = newSketch('sk', 'test');
  pt(x: number, y: number): string { const r = addPoint(this.s, x, y); this.s = r.sketch; return r.id; }
  line(a: string, b: string): string { const r = addLine(this.s, a, b); this.s = r.sketch; return r.id; }
  circle(c: string, radius: number): string { const r = addCircle(this.s, c, radius); this.s = r.sketch; return r.id; }
  arc(c: string, a: string, b: string): string { const r = addArc(this.s, c, a, b); this.s = r.sketch; return r.id; }
  con(c: DistributiveOmit<SkConstraint, 'id'>): string { const r = addConstraint(this.s, c); this.s = r.sketch; return r.id; }
  rect(x0: number, y0: number, x1: number, y1: number): { p: string[]; l: string[] } {
    const r = rectangle(this.s, x0, y0, x1, y1);
    this.s = r.sketch;
    return { p: r.pointIds, l: r.lineIds };
  }
  fix(p: string): string {
    const q = P(this.s, p);
    return this.con({ type: 'fixed', point: p, x: q.x, y: q.y });
  }
}

function P(s: Sketch, id: string): { x: number; y: number } {
  const p = s.points.find(q => q.id === id);
  if (!p) throw new Error(`no point ${id}`);
  return p;
}
function dist(s: Sketch, a: string, b: string): number {
  const p = P(s, a), q = P(s, b);
  return Math.hypot(p.x - q.x, p.y - q.y);
}
function near(actual: number, expected: number, tol: number): void {
  expect(Math.abs(actual - expected), `expected ${actual} ≈ ${expected} (±${tol})`).toBeLessThanOrEqual(tol);
}
function maxMove(a: Sketch, b: Sketch): number {
  let m = 0;
  for (const p of a.points) { const q = P(b, p.id); m = Math.max(m, Math.hypot(p.x - q.x, p.y - q.y)); }
  return m;
}
/** max residual over the given constraint ids (all when omitted) */
function maxResidual(s: Sketch, ids?: string[]): number {
  const r = constraintResiduals(s);
  let m = 0;
  for (const id of ids ?? Object.keys(r)) m = Math.max(m, r[id]);
  return m;
}
function solveApply(s: Sketch, opts?: Parameters<typeof solveSketch>[1]) {
  const result = solveSketch(s, opts);
  return { result, solved: applySolve(s, result) };
}

// ---------------------------------------------------------------------------
// ops
// ---------------------------------------------------------------------------

describe('sketch ops', () => {
  it('creates deterministic unique ids and never mutates its input', () => {
    const s0 = newSketch('s1', 'plate');
    const a = addPoint(s0, 1, 2);
    const b = addPoint(a.sketch, 3, 4);
    expect(s0.points.length).toBe(0);
    expect([a.id, b.id]).toEqual(['p1', 'p2']);
    const l = addLine(b.sketch, a.id, b.id);
    const c = addCircle(l.sketch, a.id, 5);
    const arc = addArc(c.sketch, a.id, b.id, b.id);
    const k = addConstraint(arc.sketch, { type: 'distance', a: a.id, b: b.id, value: 10 });
    expect([l.id, c.id, arc.id, k.id]).toEqual(['l1', 'c1', 'a1', 'k1']);
    expect(k.sketch.constraints[0]).toEqual({ id: 'k1', type: 'distance', a: 'p1', b: 'p2', value: 10 });
    expect(b.sketch.entities.length).toBe(0);
    // ids continue after the highest existing number, even after deletions
    const less = removeItems(k.sketch, ['k1']);
    const p3 = addPoint(less, 0, 0);
    expect(p3.id).toBe('p3');
    const all = [...p3.sketch.points, ...p3.sketch.entities, ...p3.sketch.constraints].map(x => x.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it('rectangle() makes 4 shared corners, 4 lines and H/V constraints', () => {
    const r = rectangle(newSketch('s', 'r'), 0, 0, 40, 20);
    expect(r.pointIds.length).toBe(4);
    expect(r.lineIds.length).toBe(4);
    expect(r.sketch.points.length).toBe(4);
    expect(r.sketch.constraints.map(c => c.type)).toEqual(['horizontal', 'vertical', 'horizontal', 'vertical']);
    expect(maxResidual(r.sketch)).toBe(0);
    const used = new Set<string>();
    for (const e of r.sketch.entities) if (e.type === 'line') { used.add(e.p1); used.add(e.p2); }
    expect(used.size).toBe(4);
  });

  it('removeItems cascades to entities, orphaned points and constraints', () => {
    const b = new Build();
    const { p, l } = b.rect(0, 0, 40, 20);
    const lone = b.pt(100, 100);
    const d = b.con({ type: 'distance', a: p[0], b: p[1], value: 40 });
    const dFar = b.con({ type: 'distance', a: p[2], b: p[3], value: 40 });
    // removing a corner point removes the two lines that use it, their H/V constraints and the distance on it
    const s1 = removeItems(b.s, [p[0]]);
    expect(s1.points.map(q => q.id).sort()).toEqual([p[1], p[2], p[3], lone].sort());
    expect(s1.entities.map(e => e.id).sort()).toEqual([l[1], l[2]].sort());
    expect(s1.constraints.some(c => c.id === d)).toBe(false);
    expect(s1.constraints.some(c => c.id === dFar)).toBe(true);
    expect(s1.constraints.length).toBe(3);
    // removing a line drops only its own constraint; its points stay while another line uses them
    const s2 = removeItems(b.s, [l[0]]);
    expect(s2.points.length).toBe(5);
    expect(s2.entities.length).toBe(3);
    expect(s2.constraints.length).toBe(5);
    // removing all lines of the rectangle removes its (now unused) points, not the unrelated one
    const s3 = removeItems(b.s, l);
    expect(s3.points.map(q => q.id)).toEqual([lone]);
    expect(s3.constraints.length).toBe(0);
    // removing just a constraint
    const s4 = removeItems(b.s, [d]);
    expect(s4.constraints.length).toBe(b.s.constraints.length - 1);
    expect(b.s.constraints.length).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// solver: status / dof
// ---------------------------------------------------------------------------

describe('sketch solver — rectangle', () => {
  function dimensionedRect(fixed: boolean): { b: Build; p: string[] } {
    const b = new Build();
    const { p } = b.rect(0, 0, 38, 22);
    if (fixed) b.fix(p[0]);
    b.con({ type: 'distance', a: p[0], b: p[1], value: 40 });
    b.con({ type: 'distance', a: p[0], b: p[3], value: 20 });
    return { b, p };
  }

  it('empty sketch', () => {
    const r = solveSketch(newSketch('e', 'empty'));
    expect(r.status).toBe('empty');
    expect(r.dof).toBe(0);
    expect(r.points).toEqual({});
  });

  it('fixed corner + H/V + two distances → fully constrained, exact sides, minimal movement', () => {
    const { b, p } = dimensionedRect(true);
    const before = JSON.stringify(b.s);
    const { result, solved } = solveApply(b.s);
    expect(JSON.stringify(b.s)).toBe(before); // input untouched
    expect(result.status).toBe('fully-constrained');
    expect(result.converged).toBe(true);
    expect(result.dof).toBe(0);
    expect(result.redundant).toEqual([]);
    expect(result.conflicting).toEqual([]);
    expect(result.freePoints).toEqual([]);
    expect(result.residual).toBeLessThan(1e-9);
    near(dist(solved, p[0], p[1]), 40, 1e-6);
    near(dist(solved, p[1], p[2]), 20, 1e-6);
    near(dist(solved, p[2], p[3]), 40, 1e-6);
    near(dist(solved, p[3], p[0]), 20, 1e-6);
    const want = [[0, 0], [40, 0], [40, 20], [0, 20]];
    p.forEach((id, i) => { near(P(solved, id).x, want[i][0], 1e-6); near(P(solved, id).y, want[i][1], 1e-6); });
    expect(maxResidual(solved)).toBeLessThan(1e-8);
    // solving an already solved sketch does not move anything
    const again = solveApply(solved);
    expect(again.result.status).toBe('fully-constrained');
    expect(maxMove(solved, again.solved)).toBe(0);
  });

  it('without the fixed point → under-constrained, dof 2, least movement', () => {
    const { b, p } = dimensionedRect(false);
    const { result, solved } = solveApply(b.s);
    expect(result.status).toBe('under-constrained');
    expect(result.converged).toBe(true);
    expect(result.dof).toBe(2); // translation in x and y (H/V block rotation)
    expect(result.freePoints.slice().sort()).toEqual(p.slice().sort());
    expect(result.message).toMatch(/fix a point/i);
    near(dist(solved, p[0], p[1]), 40, 1e-6);
    near(dist(solved, p[0], p[3]), 20, 1e-6);
    // the closest 40×20 rectangle to the drawn 38×22 one grows/shrinks symmetrically
    const want = [[-1, 1], [39, 1], [39, 21], [-1, 21]];
    p.forEach((id, i) => { near(P(solved, id).x, want[i][0], 1e-6); near(P(solved, id).y, want[i][1], 1e-6); });
  });

  it('H/V only → 4 dof; an unconstrained sketch → 2 dof per point, and nothing moves', () => {
    const b = new Build();
    b.rect(0, 0, 38, 22);
    const r1 = solveSketch(b.s);
    expect(r1.status).toBe('under-constrained');
    expect(r1.dof).toBe(4);
    const free = new Build();
    const a = free.pt(1, 2), c = free.pt(30, 4);
    free.line(a, c);
    const ci = free.circle(a, 7);
    const { result, solved } = solveApply(free.s);
    expect(result.dof).toBe(5); // 2 points + 1 radius
    expect(result.freeRadii).toEqual([ci]);
    expect(result.radii[ci]).toBe(7);
    expect(maxMove(free.s, solved)).toBe(0);
  });

  it('a distance that needs a large move still converges', () => {
    const b = new Build();
    const { p } = b.rect(0, 0, 10, 10);
    b.fix(p[0]);
    b.con({ type: 'distance', a: p[0], b: p[1], value: 450 });
    b.con({ type: 'distance', a: p[1], b: p[2], value: 300 });
    const { result, solved } = solveApply(b.s);
    expect(result.status).toBe('fully-constrained');
    near(P(solved, p[2]).x, 450, 1e-6);
    near(P(solved, p[2]).y, 300, 1e-6);
  });
});

describe('sketch solver — triangle and conflicts', () => {
  function triangle(dCA: number): { b: Build; A: string; B: string; C: string; ids: Record<string, string> } {
    const b = new Build();
    const A = b.pt(0, 0), B = b.pt(48, 2), C = b.pt(20, 25);
    const ab = b.line(A, B);
    b.line(B, C);
    b.line(C, A);
    const ids = {
      fix: b.fix(A),
      h: b.con({ type: 'horizontal', line: ab }),
      dAB: b.con({ type: 'distance', a: A, b: B, value: 50 }),
      dCA: b.con({ type: 'distance', a: C, b: A, value: dCA }),
      dBC: b.con({ type: 'distance', a: B, b: C, value: 40 }),
    };
    return { b, A, B, C, ids };
  }

  it('three distances + fixed point + horizontal base → fully constrained', () => {
    const { b, B, C } = triangle(30);
    const { result, solved } = solveApply(b.s);
    expect(result.status).toBe('fully-constrained');
    expect(result.dof).toBe(0);
    near(P(solved, B).x, 50, 1e-6); near(P(solved, B).y, 0, 1e-6);
    near(P(solved, C).x, 18, 1e-6); near(P(solved, C).y, 24, 1e-6); // 30-40-50 right triangle
  });

  it('breaking the triangle inequality → conflicting, offender named, last valid shape kept', () => {
    const { b, ids } = triangle(30);
    const valid = solveApply(b.s).solved;
    // user edits the dimension C–A from 30 to 100 (> 50 + 40)
    const edited: Sketch = {
      ...valid,
      constraints: valid.constraints.map(c => (c.id === ids.dCA && c.type === 'distance' ? { ...c, value: 100 } : c)),
    };
    const { result, solved } = solveApply(edited);
    expect(result.status).toBe('conflicting');
    expect(result.conflicting).toEqual([ids.dCA]);
    expect(result.redundant).toEqual([]);
    expect(result.converged).toBe(true);
    // accepted constraints hold, and the geometry is exactly the previous valid triangle — no squashed compromise
    expect(maxResidual(solved, [ids.fix, ids.h, ids.dAB, ids.dBC])).toBeLessThan(1e-8);
    expect(maxMove(valid, solved)).toBeLessThan(1e-9);
    near(constraintResiduals(solved)[ids.dCA], 70, 1e-6);
    // the message names the offender, its value and the distances it fights with
    expect(result.message).toContain(`Distance ${ids.dCA} = 100 mm conflicts with`);
    expect(result.message).toContain(`distance ${ids.dAB}`);
    expect(result.message).toContain(`distance ${ids.dBC}`);
    // dof is that of the accepted subset: C can still swing about B
    expect(result.dof).toBe(1);
  });

  it('conflict in a not-yet-solved sketch: earlier constraints win, the rest is solved exactly', () => {
    const { b, ids, A, B, C } = triangle(30);
    const s: Sketch = {
      ...b.s,
      constraints: [
        ...b.s.constraints.filter(c => c.id !== ids.dCA),
        { id: 'dLast', type: 'distance', a: C, b: A, value: 100 },
      ],
    };
    const { result, solved } = solveApply(s);
    expect(result.status).toBe('conflicting');
    expect(result.conflicting).toEqual(['dLast']);
    expect(result.converged).toBe(true);
    near(dist(solved, A, B), 50, 1e-6);
    near(dist(solved, B, C), 40, 1e-6);
    near(P(solved, B).y, 0, 1e-6);
    expect(dist(solved, C, A)).toBeLessThan(90 + 1e-6);
  });

  it('two different values for the same distance → the later one conflicts', () => {
    const b = new Build();
    const p1 = b.pt(0, 0), p2 = b.pt(28, 3);
    b.fix(p1);
    const d1 = b.con({ type: 'distance', a: p1, b: p2, value: 30 });
    const d2 = b.con({ type: 'distance', a: p1, b: p2, value: 35 });
    const { result, solved } = solveApply(b.s);
    expect(result.status).toBe('conflicting');
    expect(result.conflicting).toEqual([d2]);
    near(dist(solved, p1, p2), 30, 1e-6);
    expect(result.message).toContain(`distance ${d1}`);
  });

  it('a degenerate (collinear) start is not mistaken for a conflict', () => {
    // apex drawn exactly on the base line: plain Newton cannot leave the line, the restart can
    const b = new Build();
    const A = b.pt(0, 0), B = b.pt(10, 0), C = b.pt(5, 0);
    b.fix(A); b.fix(B);
    b.con({ type: 'distance', a: A, b: C, value: 10 });
    b.con({ type: 'distance', a: B, b: C, value: 10 });
    const { result, solved } = solveApply(b.s);
    expect(result.status).toBe('fully-constrained');
    expect(result.conflicting).toEqual([]);
    near(P(solved, C).x, 5, 1e-6);
    near(Math.abs(P(solved, C).y), Math.sqrt(75), 1e-6);
  });
});

describe('sketch solver — redundancy', () => {
  it('the same distance twice → redundant, duplicate reported', () => {
    const b = new Build();
    const p1 = b.pt(0, 0), p2 = b.pt(28, 3);
    const l = b.line(p1, p2);
    b.fix(p1);
    b.con({ type: 'horizontal', line: l });
    b.con({ type: 'distance', a: p1, b: p2, value: 30 });
    const dup = b.con({ type: 'distance', a: p2, b: p1, value: 30 });
    const { result, solved } = solveApply(b.s);
    expect(result.status).toBe('redundant');
    expect(result.redundant).toEqual([dup]);
    expect(result.conflicting).toEqual([]);
    expect(result.dof).toBe(0);
    expect(result.converged).toBe(true);
    near(P(solved, p2).x, 30, 1e-6); near(P(solved, p2).y, 0, 1e-6);
    expect(result.message).toContain(dup);
  });

  it('horizontal line + distance + explicit 0° angle to a horizontal reference → angle is redundant', () => {
    const b = new Build();
    const p1 = b.pt(0, 0), p2 = b.pt(30, 1), p3 = b.pt(5, 12), p4 = b.pt(24, 13);
    const ref = b.line(p1, p2), l2 = b.line(p3, p4);
    b.fix(p1);
    b.con({ type: 'horizontal', line: ref });
    b.con({ type: 'distance', a: p1, b: p2, value: 30 });
    b.con({ type: 'horizontal', line: l2 });
    b.con({ type: 'distance', a: p3, b: p4, value: 20 });
    const ang = b.con({ type: 'angle', l1: ref, l2, value: 0 });
    const { result, solved } = solveApply(b.s);
    expect(result.status).toBe('redundant');
    expect(result.redundant).toEqual([ang]);
    expect(result.dof).toBe(2); // second line can still translate
    near(dist(solved, p3, p4), 20, 1e-6);
    near(P(solved, p3).y, P(solved, p4).y, 1e-9);
  });

  it('fixing both ends of a dimensioned line: consistent → redundant, inconsistent → conflicting', () => {
    const mk = (drawnX: number, drawnY: number, fixX: number) => {
      const b = new Build();
      const p1 = b.pt(0, 0), p2 = b.pt(drawnX, drawnY);
      b.fix(p1);
      const f = b.con({ type: 'fixed', point: p2, x: fixX, y: 0 });
      const d = b.con({ type: 'distance', a: p1, b: p2, value: 30 });
      return { r: solveSketch(b.s), d, f, p2 };
    };
    const ok = mk(30, 0, 30);
    expect(ok.r.status).toBe('redundant');
    expect(ok.r.redundant).toEqual([ok.d]);
    expect(ok.r.dof).toBe(0);
    // nothing satisfied yet: plain order decides, the later constraint (distance) loses
    const bad = mk(28, 3, 31);
    expect(bad.r.status).toBe('conflicting');
    expect(bad.r.conflicting).toEqual([bad.d]);
    expect(bad.r.points[bad.p2].x).toBeCloseTo(31, 9);
    expect(bad.r.points[bad.p2].y).toBeCloseTo(0, 9);
    // the drawing already satisfies the distance: the constraint that would break the valid shape loses
    const edit = mk(30, 0, 31);
    expect(edit.r.status).toBe('conflicting');
    expect(edit.r.conflicting).toEqual([edit.f]);
    expect(edit.r.points[edit.p2]).toEqual({ x: 30, y: 0 });
  });
});

// ---------------------------------------------------------------------------
// solver: every constraint type, numerically
// ---------------------------------------------------------------------------

describe('sketch solver — constraint types', () => {
  it('analytic Jacobian matches finite differences for every equation type', () => {
    const b = new Build();
    const p = [b.pt(1, 2), b.pt(31, 7), b.pt(12, 28), b.pt(-9, 14), b.pt(22, -11), b.pt(40, 25), b.pt(3, -17)];
    const l1 = b.line(p[0], p[1]), l2 = b.line(p[2], p[3]), l3 = b.line(p[4], p[5]);
    const c1 = b.circle(p[6], 6.5), c2 = b.circle(p[2], 3.25);
    const a1 = b.arc(p[3], p[4], p[5]);
    b.con({ type: 'coincident', a: p[0], b: p[6] });
    b.con({ type: 'fixed', point: p[1], x: 30, y: 8 });
    b.con({ type: 'horizontal', line: l1 });
    b.con({ type: 'vertical', line: l2 });
    b.con({ type: 'distance', a: p[0], b: p[5], value: 12 });
    b.con({ type: 'angle', l1, l2, value: 0.4 });
    b.con({ type: 'radius', entity: c1, value: 5 });
    b.con({ type: 'radius', entity: a1, value: 9 });
    b.con({ type: 'parallel', l1, l2: l3 });
    b.con({ type: 'perpendicular', l1: l2, l2: l3 });
    b.con({ type: 'equal', e1: l1, e2: l3 });
    b.con({ type: 'equal', e1: c1, e2: c2 });
    b.con({ type: 'equal', e1: c1, e2: a1 });
    b.con({ type: 'pointOn', point: p[2], entity: l1 });
    b.con({ type: 'pointOn', point: p[0], entity: c2 });
    b.con({ type: 'pointOn', point: p[1], entity: a1 });
    b.con({ type: 'tangent', line: l1, circle: c1 });
    b.con({ type: 'tangent', line: l2, circle: a1 });
    expect(_jacobianMaxError(b.s)).toBeLessThan(1e-6);
  });

  it('angle: 30° between two lines (signed, CCW positive)', () => {
    for (const sign of [1, -1]) {
      const b = new Build();
      const o = b.pt(0, 0), x = b.pt(30, 0), q = b.pt(20, 20 * sign);
      const l1 = b.line(o, x), l2 = b.line(o, q);
      b.fix(o);
      b.con({ type: 'horizontal', line: l1 });
      b.con({ type: 'distance', a: o, b: x, value: 30 });
      b.con({ type: 'distance', a: o, b: q, value: 25 });
      b.con({ type: 'angle', l1, l2, value: (sign * Math.PI) / 6 });
      const { result, solved } = solveApply(b.s);
      expect(result.status).toBe('fully-constrained');
      const pq = P(solved, q);
      near(Math.atan2(pq.y, pq.x), (sign * Math.PI) / 6, 1e-9);
      near(pq.x, 25 * Math.cos(Math.PI / 6), 1e-6);
      near(pq.y, sign * 12.5, 1e-6);
    }
  });

  it('angle between two free-floating lines is measured from l1 to l2', () => {
    const b = new Build();
    const a = b.pt(0, 0), c = b.pt(20, 3), d = b.pt(5, 10), e = b.pt(9, 31);
    const l1 = b.line(a, c), l2 = b.line(d, e);
    const k = b.con({ type: 'angle', l1, l2, value: (100 * Math.PI) / 180 });
    const { result, solved } = solveApply(b.s);
    expect(result.status).toBe('under-constrained');
    expect(result.dof).toBe(7);
    const t1 = Math.atan2(P(solved, c).y - P(solved, a).y, P(solved, c).x - P(solved, a).x);
    const t2 = Math.atan2(P(solved, e).y - P(solved, d).y, P(solved, e).x - P(solved, d).x);
    near(t2 - t1, (100 * Math.PI) / 180, 1e-9);
    expect(constraintResiduals(solved)[k]).toBeLessThan(1e-9);
  });

  it('perpendicular and parallel', () => {
    const b = new Build();
    const a = b.pt(0, 0), c = b.pt(30, 10), d = b.pt(5, 5), e = b.pt(12, 30), f = b.pt(40, 0), g = b.pt(65, 14);
    const l1 = b.line(a, c), l2 = b.line(d, e), l3 = b.line(f, g);
    b.fix(a); b.fix(c);
    b.con({ type: 'perpendicular', l1, l2 });
    b.con({ type: 'parallel', l1, l2: l3 });
    const { result, solved } = solveApply(b.s);
    expect(result.converged).toBe(true);
    expect(result.status).toBe('under-constrained');
    expect(result.dof).toBe(6); // 12 unknowns − 4 (fixed) − 2
    const v = (p: string, q: string) => [P(solved, q).x - P(solved, p).x, P(solved, q).y - P(solved, p).y];
    const u1 = v(a, c), u2 = v(d, e), u3 = v(f, g);
    near((u1[0] * u2[0] + u1[1] * u2[1]) / (Math.hypot(u1[0], u1[1]) * Math.hypot(u2[0], u2[1])), 0, 1e-9);
    near((u1[0] * u3[1] - u1[1] * u3[0]) / (Math.hypot(u1[0], u1[1]) * Math.hypot(u3[0], u3[1])), 0, 1e-9);
    // least movement = orthogonal projection of each drawn line vector onto the required direction
    const n1 = Math.hypot(30, 10);
    near(Math.hypot(u2[0], u2[1]), (7 * -10 + 25 * 30) / n1, 1e-6);
    near(Math.hypot(u3[0], u3[1]), (25 * 30 + 14 * 10) / n1, 1e-6);
    // and the mid points stay where they were drawn
    near((P(solved, d).x + P(solved, e).x) / 2, 8.5, 1e-6);
    near((P(solved, d).y + P(solved, e).y) / 2, 17.5, 1e-6);
  });

  it('equal: two lines get the same length, circles/arcs the same radius', () => {
    const b = new Build();
    const a = b.pt(0, 0), c = b.pt(30, 0), d = b.pt(0, 10), e = b.pt(18, 14);
    const l1 = b.line(a, c), l2 = b.line(d, e);
    b.fix(a); b.fix(c);
    b.con({ type: 'equal', e1: l1, e2: l2 });
    const c1 = b.circle(a, 4), c2 = b.circle(d, 9);
    b.con({ type: 'radius', entity: c1, value: 6 });
    b.con({ type: 'equal', e1: c1, e2: c2 });
    const ac = b.pt(60, 0), as = b.pt(70, 1), ae = b.pt(59, 11);
    const arc = b.arc(ac, as, ae);
    b.con({ type: 'equal', e1: arc, e2: c1 });
    const { result, solved } = solveApply(b.s);
    expect(result.converged).toBe(true);
    expect(result.conflicting).toEqual([]);
    near(dist(solved, d, e), 30, 1e-6);
    near(result.radii[c1], 6, 1e-9);
    near(result.radii[c2], 6, 1e-9);
    near(dist(solved, ac, as), 6, 1e-6);
    near(dist(solved, ac, ae), 6, 1e-6);
    expect(result.freeRadii).toEqual([]);
    const circles = solved.entities.filter(en => en.type === 'circle');
    expect(circles.map(en => (en.type === 'circle' ? en.r : 0))).toEqual([result.radii[c1], result.radii[c2]]);
  });

  it('pointOn: line (infinite) and circle', () => {
    const b = new Build();
    const a = b.pt(0, 0), c = b.pt(20, 10), p = b.pt(40, 14), cc = b.pt(0, 40), q = b.pt(9, 44);
    const l = b.line(a, c);
    const circ = b.circle(cc, 12);
    b.fix(a); b.fix(c); b.fix(cc);
    b.con({ type: 'radius', entity: circ, value: 12 });
    b.con({ type: 'pointOn', point: p, entity: l });
    b.con({ type: 'pointOn', point: q, entity: circ });
    const { result, solved } = solveApply(b.s);
    expect(result.status).toBe('under-constrained');
    expect(result.dof).toBe(2); // each point slides along its curve
    expect(result.freePoints.slice().sort()).toEqual([p, q].sort());
    const pp = P(solved, p);
    near(20 * pp.y - 10 * pp.x, 0, 1e-6); // on the line through (0,0) and (20,10), beyond its end
    // nearest point of the line to the drawn position (40,14): foot of the perpendicular
    near(pp.x, 37.6, 1e-6); near(pp.y, 18.8, 1e-6);
    near(dist(solved, q, cc), 12, 1e-9);
    // nearest point of the circle: radial projection
    const k = 12 / Math.hypot(9, 4);
    near(P(solved, q).x, 9 * k, 1e-6); near(P(solved, q).y, 40 + 4 * k, 1e-6);
  });

  it('tangent: line–circle and line–arc', () => {
    const b = new Build();
    const a = b.pt(0, 0), c = b.pt(50, 0), cc = b.pt(20, 13);
    const l = b.line(a, c);
    const circ = b.circle(cc, 10);
    b.fix(a); b.fix(c);
    b.con({ type: 'radius', entity: circ, value: 10 });
    const t = b.con({ type: 'tangent', line: l, circle: circ });
    const ac = b.pt(40, -8), as = b.pt(47, -8), ae = b.pt(40, -1);
    const arc = b.arc(ac, as, ae);
    const t2 = b.con({ type: 'tangent', line: l, circle: arc });
    const { result, solved } = solveApply(b.s);
    expect(result.converged).toBe(true);
    expect(result.conflicting).toEqual([]);
    near(P(solved, cc).y, 10, 1e-9); // centre sits one radius above the line
    near(P(solved, cc).x, 20, 1e-9); // and did not slide sideways
    const r = dist(solved, ac, as);
    near(dist(solved, ac, ae), r, 1e-9);
    near(Math.abs(P(solved, ac).y), r, 1e-9);
    expect(constraintResiduals(solved)[t]).toBeLessThan(1e-9);
    expect(constraintResiduals(solved)[t2]).toBeLessThan(1e-9);
  });

  it('radius on a circle and on an arc; coincident', () => {
    const b = new Build();
    const cc = b.pt(0, 0), ac = b.pt(50, 0), as = b.pt(58, 0), ae = b.pt(50, 9), extra = b.pt(3, 1);
    const circ = b.circle(cc, 4);
    const arc = b.arc(ac, as, ae);
    b.fix(cc); b.fix(ac);
    b.con({ type: 'radius', entity: circ, value: 7.5 });
    b.con({ type: 'radius', entity: arc, value: 10 });
    b.con({ type: 'coincident', a: extra, b: cc });
    const { result, solved } = solveApply(b.s);
    expect(result.status).toBe('under-constrained');
    expect(result.dof).toBe(2); // arc start and end each slide on the circle
    expect(result.radii[circ]).toBeCloseTo(7.5, 12);
    near(dist(solved, ac, as), 10, 1e-9);
    near(dist(solved, ac, ae), 10, 1e-9);
    near(P(solved, as).x, 60, 1e-6); near(P(solved, as).y, 0, 1e-6);
    near(P(solved, ae).x, 50, 1e-6); near(P(solved, ae).y, 10, 1e-6);
    near(dist(solved, extra, cc), 0, 1e-9);
    expect(result.freeRadii).toEqual([]);
  });

  it('arc: |centre−start| = |centre−end| is always enforced but never reported', () => {
    const b = new Build();
    const c = b.pt(0, 0), s = b.pt(10, 0), e = b.pt(0, 13);
    const arc = b.arc(c, s, e);
    b.fix(c); b.fix(s);
    const { result, solved } = solveApply(b.s);
    expect(result.status).toBe('under-constrained');
    expect(result.dof).toBe(1); // 6 unknowns − 4 fixed − 1 implicit
    expect(result.redundant).toEqual([]);
    expect(result.conflicting).toEqual([]);
    near(dist(solved, c, e), 10, 1e-9);
    near(P(solved, e).x, 0, 1e-6); near(P(solved, e).y, 10, 1e-6);
    expect(result.freePoints).toEqual([e]);
    expect(result.freeRadii).toEqual([]);
    // nothing fixed: 6 − 1 = 5 dof and the radius itself is free
    const free = new Build();
    const arc2 = free.arc(free.pt(0, 0), free.pt(10, 0), free.pt(0, 13));
    const r2 = solveSketch(free.s);
    expect(r2.dof).toBe(5);
    expect(r2.freeRadii).toEqual([arc2]);
    expect(arc).toBe(arc2);
    // a user constraint that contradicts the arc equation is the one reported
    const bad = b.con({ type: 'fixed', point: e, x: 0, y: 13 });
    const r3 = solveSketch(b.s);
    expect(r3.status).toBe('conflicting');
    expect(r3.conflicting).toEqual([bad]);
    near(Math.hypot(r3.points[e].x, r3.points[e].y), 10, 1e-8);
  });

  it('constraints with missing references are ignored and mentioned', () => {
    const b = new Build();
    const p1 = b.pt(0, 0), p2 = b.pt(10, 0);
    b.fix(p1); b.fix(p2);
    const ghost = b.con({ type: 'distance', a: p1, b: 'nope', value: 5 });
    const r = solveSketch(b.s);
    expect(r.status).toBe('fully-constrained');
    expect(r.message).toContain(ghost);
    expect(constraintResiduals(b.s)[ghost]).toBe(Infinity);
  });
});

// ---------------------------------------------------------------------------
// dragging
// ---------------------------------------------------------------------------

describe('sketch solver — dragging', () => {
  it('a point on a rigid link follows the drag target as far as the constraints allow', () => {
    const b = new Build();
    const o = b.pt(0, 0), tip = b.pt(30, 0);
    b.fix(o);
    const d = b.con({ type: 'distance', a: o, b: tip, value: 30 });
    for (const target of [{ x: 0, y: 50 }, { x: -300, y: 400 }, { x: 12, y: -5 }]) {
      const { result, solved } = solveApply(b.s, { dragged: { [tip]: target } });
      expect(result.status).toBe('under-constrained');
      expect(result.dof).toBe(1);
      expect(constraintResiduals(solved)[d]).toBeLessThan(1e-9);
      const k = 30 / Math.hypot(target.x, target.y);
      near(P(solved, tip).x, target.x * k, 1e-3);
      near(P(solved, tip).y, target.y * k, 1e-3);
      near(P(solved, o).x, 0, 1e-9);
    }
  });

  it('dragging a rectangle corner resizes it; H/V keep holding', () => {
    const b = new Build();
    const { p } = b.rect(0, 0, 40, 20);
    b.fix(p[0]);
    const { result, solved } = solveApply(b.s, { dragged: { [p[2]]: { x: 55, y: 31 } } });
    expect(result.converged).toBe(true);
    expect(maxResidual(solved)).toBeLessThan(1e-9);
    near(P(solved, p[2]).x, 55, 1e-3); near(P(solved, p[2]).y, 31, 1e-3);
    near(P(solved, p[1]).x, 55, 1e-3); near(P(solved, p[1]).y, 0, 1e-9);
    near(P(solved, p[3]).x, 0, 1e-9); near(P(solved, p[3]).y, 31, 1e-3);
  });

  it('an unconstrained point goes exactly to the target; a fully constrained sketch does not move', () => {
    const free = new Build();
    const a = free.pt(1, 1), other = free.pt(5, 5);
    const r = solveSketch(free.s, { dragged: { [a]: { x: 9, y: -4 } } });
    expect(r.points[a]).toEqual({ x: 9, y: -4 });
    expect(r.points[other]).toEqual({ x: 5, y: 5 });

    const b = new Build();
    const { p } = b.rect(0, 0, 40, 20);
    b.fix(p[0]);
    b.con({ type: 'distance', a: p[0], b: p[1], value: 40 });
    b.con({ type: 'distance', a: p[0], b: p[3], value: 20 });
    const { result, solved } = solveApply(b.s, { dragged: { [p[2]]: { x: 90, y: 70 } } });
    expect(result.status).toBe('fully-constrained');
    expect(maxMove(b.s, solved)).toBeLessThan(1e-9);
  });

  it('a four-bar linkage follows a dragged joint while all link lengths hold', () => {
    const b = new Build();
    const A = b.pt(0, 0), D = b.pt(60, 0), B = b.pt(0, 20), C = b.pt(60, 35);
    b.fix(A); b.fix(D);
    const links = [
      b.con({ type: 'distance', a: A, b: B, value: 20 }),
      b.con({ type: 'distance', a: B, b: C, value: Math.hypot(60, 15) }),
      b.con({ type: 'distance', a: C, b: D, value: 35 }),
    ];
    let s = b.s;
    for (let step = 1; step <= 6; step++) {
      const ang = Math.PI / 2 - step * 0.2;
      const target = { x: 20 * Math.cos(ang), y: 20 * Math.sin(ang) };
      const r = solveSketch(s, { dragged: { [B]: target } });
      expect(r.dof).toBe(1);
      expect(r.converged).toBe(true);
      s = applySolve(s, r);
      expect(maxResidual(s, links)).toBeLessThan(1e-9);
      near(P(s, B).x, target.x, 1e-3);
      near(P(s, B).y, target.y, 1e-3);
    }
    expect(P(s, C).y).toBeGreaterThan(0); // stayed on the same assembly branch
  });
});

// ---------------------------------------------------------------------------
// profiles
// ---------------------------------------------------------------------------

describe('profile extraction', () => {
  it('rectangle with a circular hole → 1 region, 1 hole, exact circle data, correct areas', () => {
    const b = new Build();
    const { l } = b.rect(0, 0, 40, 20);
    const c = b.circle(b.pt(20, 10), 5);
    const res = extractProfiles(b.s);
    expect(res.problems).toEqual([]);
    expect(res.openEntities).toEqual([]);
    expect(res.regions.length).toBe(1);
    const region = res.regions[0];
    expect(region.outer.area).toBe(800);
    expect(region.outer.points.length).toBe(4);
    expect(region.outer.entityIds.slice().sort()).toEqual(l.slice().sort());
    expect(region.outer.circle).toBeUndefined();
    expect(region.holes.length).toBe(1);
    const hole = region.holes[0];
    expect(hole.circle).toEqual({ cx: 20, cy: 10, r: 5, entityId: c });
    expect(hole.entityIds).toEqual([c]);
    const exact = Math.PI * 25;
    expect(hole.area).toBeGreaterThan(0); // CCW
    expect(hole.area).toBeLessThanOrEqual(exact);
    expect(exact - hole.area).toBeLessThan(2 * Math.PI * 5 * 0.02); // perimeter × chord tolerance
    // chord error of the polygon itself
    const n = hole.points.length;
    expect(n).toBeGreaterThanOrEqual(24);
    expect(5 * (1 - Math.cos(Math.PI / n))).toBeLessThanOrEqual(0.02);
    for (const [x, y] of hole.points) near(Math.hypot(x - 20, y - 10), 5, 1e-12);
  });

  it('chord tolerance drives the segment count (24 … 720)', () => {
    const b = new Build();
    b.circle(b.pt(0, 0), 10);
    const count = (chordTol: number, maxSegLen?: number) =>
      extractProfiles(b.s, { chordTol, maxSegLen }).regions[0].outer.points.length;
    expect(count(5)).toBe(24);
    const n = count(0.001);
    expect(10 * (1 - Math.cos(Math.PI / n))).toBeLessThanOrEqual(0.001);
    expect(10 * (1 - Math.cos(Math.PI / (n - 2)))).toBeGreaterThan(0.001); // not wastefully fine
    expect(count(1e-9)).toBe(720);
    expect(count(5, 1)).toBe(63); // 2π·10 / 1 mm
  });

  it('slot (2 lines + 2 arcs) → one closed CCW loop with the right area', () => {
    const b = new Build();
    const A = b.pt(0, -5), B = b.pt(30, -5), C = b.pt(30, 5), D = b.pt(0, 5);
    const cr = b.pt(30, 0), cl = b.pt(0, 0);
    const ids = [b.line(A, B), b.arc(cr, B, C), b.line(C, D), b.arc(cl, D, A)];
    const res = extractProfiles(b.s);
    expect(res.problems).toEqual([]);
    expect(res.openEntities).toEqual([]);
    expect(res.regions.length).toBe(1);
    const loop = res.regions[0].outer;
    expect(res.regions[0].holes).toEqual([]);
    expect(loop.circle).toBeUndefined();
    expect(loop.entityIds.slice().sort()).toEqual(ids.slice().sort());
    const exact = 30 * 10 + Math.PI * 25;
    expect(loop.area).toBeLessThanOrEqual(exact);
    expect(exact - loop.area).toBeLessThan(2 * Math.PI * 5 * 0.02);
    // every vertex lies on the slot outline, and the extremes are reached
    for (const [x, y] of loop.points) {
      const dx = x < 0 ? x : x > 30 ? x - 30 : 0;
      near(Math.hypot(dx, y), 5, 1e-9);
    }
    near(Math.min(...loop.points.map(q => q[0])), -5, 0.02);
    near(Math.max(...loop.points.map(q => q[0])), 35, 0.02);
  });

  it('separate end points joined by coincident constraints chain into the same loop', () => {
    const b = new Build();
    const corners: [number, number][] = [[0, 0], [40, 0], [40, 20], [0, 20]];
    const ends: string[][] = [];
    for (let i = 0; i < 4; i++) {
      const p = b.pt(corners[i][0], corners[i][1]);
      const q = b.pt(corners[(i + 1) % 4][0], corners[(i + 1) % 4][1] + (i === 0 ? 1e-7 : 0));
      b.line(p, q);
      ends.push([p, q]);
    }
    // corners 1 and 2 are tied by constraints, the others only by position (within 1e-6 mm)
    b.con({ type: 'coincident', a: ends[0][1], b: ends[1][0] });
    b.con({ type: 'coincident', a: ends[1][1], b: ends[2][0] });
    const res = extractProfiles(b.s);
    expect(res.problems).toEqual([]);
    expect(res.openEntities).toEqual([]);
    expect(res.regions.length).toBe(1);
    expect(res.regions[0].outer.points.length).toBe(4);
    near(res.regions[0].outer.area, 800, 1e-4);
  });

  it('open chains and dangling lines are reported, closed loops still extracted; construction ignored', () => {
    const b = new Build();
    // closed triangle (drawn clockwise on purpose) with a tail
    const t1 = b.pt(0, 0), t2 = b.pt(0, 10), t3 = b.pt(10, 0), tail = b.pt(-5, -5);
    b.line(t1, t2); b.line(t2, t3); b.line(t3, t1);
    const tailLine = b.line(t1, tail);
    // open chain of three lines
    const c = [b.pt(20, 0), b.pt(30, 0), b.pt(30, 10), b.pt(20, 10)];
    const chain = [b.line(c[0], c[1]), b.line(c[1], c[2]), b.line(c[2], c[3])];
    // construction circle must not become a region
    const cc = b.circle(b.pt(50, 50), 5);
    b.s = { ...b.s, entities: b.s.entities.map(e => (e.id === cc ? { ...e, construction: true } : e)) };
    const res = extractProfiles(b.s);
    expect(res.openEntities).toEqual([tailLine, ...chain]);
    expect(res.regions.length).toBe(1);
    expect(res.regions[0].outer.area).toBeCloseTo(50, 12); // positive although drawn clockwise
    expect(res.regions[0].outer.points.length).toBe(3);
    expect(res.problems).toEqual([]);
  });

  it('nested island: circle inside a hole → 2 regions', () => {
    const b = new Build();
    b.rect(0, 0, 40, 30);
    const hole = b.circle(b.pt(20, 15), 8);
    const island = b.circle(b.pt(21, 15), 2);
    const res = extractProfiles(b.s);
    expect(res.problems).toEqual([]);
    expect(res.regions.length).toBe(2);
    expect(res.regions[0].outer.area).toBe(1200);
    expect(res.regions[0].holes.map(h => h.circle?.entityId)).toEqual([hole]);
    expect(res.regions[1].outer.circle).toEqual({ cx: 21, cy: 15, r: 2, entityId: island });
    expect(res.regions[1].holes).toEqual([]);
    for (const r of res.regions) {
      expect(r.outer.area).toBeGreaterThan(0);
      for (const h of r.holes) expect(h.area).toBeGreaterThan(0);
    }
  });

  it('a dividing line splits a rectangle into two adjacent regions (shared edge, no nesting)', () => {
    const b = new Build();
    const p = [b.pt(0, 0), b.pt(20, 0), b.pt(40, 0), b.pt(40, 20), b.pt(20, 20), b.pt(0, 20)];
    for (let i = 0; i < 6; i++) b.line(p[i], p[(i + 1) % 6]);
    b.line(p[1], p[4]);
    b.circle(b.pt(30, 10), 3);
    const res = extractProfiles(b.s);
    expect(res.problems).toEqual([]);
    expect(res.openEntities).toEqual([]);
    expect(res.regions.length).toBe(2);
    expect(res.regions.map(r => r.outer.area)).toEqual([400, 400]);
    expect(res.regions.map(r => r.holes.length).sort()).toEqual([0, 1]);
    const withHole = res.regions.find(r => r.holes.length === 1)!;
    expect(Math.min(...withHole.outer.points.map(q => q[0]))).toBe(20);
  });

  it('rounded rectangle (4 lines + 4 tangent arcs) and loops that only touch at a vertex', () => {
    const b = new Build();
    const r = 5, w = 40, h = 20;
    const p = [b.pt(r, 0), b.pt(w - r, 0), b.pt(w, r), b.pt(w, h - r), b.pt(w - r, h), b.pt(r, h), b.pt(0, h - r), b.pt(0, r)];
    const c = [b.pt(w - r, r), b.pt(w - r, h - r), b.pt(r, h - r), b.pt(r, r)];
    for (let i = 0; i < 4; i++) {
      b.line(p[2 * i], p[2 * i + 1]);
      b.arc(c[i], p[2 * i + 1], p[(2 * i + 2) % 8]);
    }
    const res = extractProfiles(b.s);
    expect(res.problems).toEqual([]);
    expect(res.openEntities).toEqual([]);
    expect(res.regions.length).toBe(1);
    expect(res.regions[0].outer.entityIds.length).toBe(8);
    const exact = w * h - (4 - Math.PI) * r * r;
    expect(res.regions[0].outer.area).toBeLessThanOrEqual(exact);
    expect(exact - res.regions[0].outer.area).toBeLessThan(2 * Math.PI * r * 0.02);

    // two triangles sharing one vertex are two regions, not a self-intersection
    const t = new Build();
    const o = t.pt(0, 0), a1 = t.pt(10, 5), a2 = t.pt(10, -5), b1 = t.pt(-10, 5), b2 = t.pt(-10, -5);
    t.line(o, a1); t.line(a1, a2); t.line(a2, o); t.line(o, b1); t.line(b1, b2); t.line(b2, o);
    const two = extractProfiles(t.s);
    expect(two.problems).toEqual([]);
    expect(two.regions.map(g => g.outer.area)).toEqual([50, 50]);

    // a bridge between an outer and an inner loop is open geometry; the loops still nest
    const g = new Build();
    const outer = g.rect(0, 0, 40, 40), inner = g.rect(10, 10, 20, 20);
    const bridge = g.line(outer.p[0], inner.p[0]);
    const nested = extractProfiles(g.s);
    expect(nested.openEntities).toEqual([bridge]);
    expect(nested.regions.length).toBe(1);
    expect(nested.regions[0].outer.area).toBe(1600);
    expect(nested.regions[0].holes.map(hl => hl.area)).toEqual([100]);
  });

  it('self-intersecting bow-tie is reported and yields no region', () => {
    const b = new Build();
    const p = [b.pt(0, 0), b.pt(10, 10), b.pt(10, 0), b.pt(0, 10)];
    for (let i = 0; i < 4; i++) b.line(p[i], p[(i + 1) % 4]);
    const res = extractProfiles(b.s);
    expect(res.regions).toEqual([]);
    expect(res.problems.length).toBe(1);
    expect(res.problems[0]).toMatch(/crosses itself/);
    // asymmetric bow-tie (non-zero net area) is caught as well
    const b2 = new Build();
    const q = [b2.pt(0, 0), b2.pt(30, 12), b2.pt(30, 0), b2.pt(0, 4)];
    for (let i = 0; i < 4; i++) b2.line(q[i], q[(i + 1) % 4]);
    const res2 = extractProfiles(b2.s);
    expect(res2.regions).toEqual([]);
    expect(res2.problems.length).toBe(1);
  });

  it('loops that cross each other are reported', () => {
    const b = new Build();
    b.rect(0, 0, 20, 20);
    b.rect(10, 10, 30, 30);
    b.circle(b.pt(0, 0), 4); // crosses the first rectangle at its corner
    const res = extractProfiles(b.s);
    expect(res.problems.length).toBe(2);
    for (const msg of res.problems) expect(msg).toMatch(/crosses the loop/);
    // crossing loops are never nested into each other
    for (const r of res.regions) expect(r.holes).toEqual([]);
  });

  it('does not throw on broken input', () => {
    const s: Sketch = {
      id: 'x', name: 'broken',
      points: [{ id: 'p1', x: 0, y: 0 }, { id: 'p2', x: NaN, y: 1 }, { id: 'p3', x: 5, y: 5 }],
      entities: [
        { id: 'l1', type: 'line', p1: 'p1', p2: 'missing' },
        { id: 'l2', type: 'line', p1: 'p1', p2: 'p2' },
        { id: 'l3', type: 'line', p1: 'p1', p2: 'p1' },
        { id: 'c1', type: 'circle', center: 'p3', r: -1 },
        { id: 'a1', type: 'arc', center: 'p3', start: 'p3', end: 'p1' },
      ],
      constraints: [{ id: 'k1', type: 'coincident', a: 'p1', b: 'ghost' }],
    };
    const res = extractProfiles(s);
    expect(res.regions).toEqual([]);
    expect(res.problems.length).toBe(5);
    expect(() => solveSketch(s)).not.toThrow();
    expect(() => constraintResiduals(s)).not.toThrow();
    const r = solveSketch(s);
    expect(r.message).toContain('k1'); // constraint on a missing point is ignored, and said so
    for (const id of ['p1', 'p2', 'p3']) expect(Number.isFinite(r.points[id].x + r.points[id].y)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// robustness: seeded random sketches
// ---------------------------------------------------------------------------

describe('sketch solver — seeded random rigid trusses', () => {
  function lcg(seed: number): () => number {
    let a = seed >>> 0;
    return () => { a = (Math.imul(a, 1664525) + 1013904223) >>> 0; return a / 4294967296; };
  }
  /** every point after the first two hangs on two earlier points by distances → rigid, dof 0 */
  function randomTruss(seed: number, noise: number): { s: Sketch; truth: [number, number][] } {
    const r = lcg(seed);
    const n = 5 + (seed % 14);
    const truth: [number, number][] = [[r() * 200, r() * 200]];
    truth.push([truth[0][0] + 20 + r() * 100, truth[0][1]]);
    const anchors: [number, number][] = [];
    while (truth.length < n) {
      // a new point and two anchors that are well clear of being in line with it
      const i = truth.length;
      const t: [number, number] = [r() * 200, r() * 200];
      const a = Math.floor(r() * i), c = Math.floor(r() * i);
      const ux = truth[a][0] - t[0], uy = truth[a][1] - t[1];
      const vx = truth[c][0] - t[0], vy = truth[c][1] - t[1];
      if (a === c || Math.abs(ux * vy - uy * vx) < 0.3 * Math.hypot(ux, uy) * Math.hypot(vx, vy)) continue;
      if (Math.min(Math.hypot(ux, uy), Math.hypot(vx, vy)) < 10) continue;
      truth.push(t);
      anchors.push([a, c]);
    }
    const b = new Build();
    const ids = truth.map((t, i) => b.pt(t[0] + (i ? noise * (2 * r() - 1) : 0), t[1] + (i ? noise * (2 * r() - 1) : 0)));
    const d = (i: number, j: number) => Math.hypot(truth[i][0] - truth[j][0], truth[i][1] - truth[j][1]);
    b.con({ type: 'fixed', point: ids[0], x: truth[0][0], y: truth[0][1] });
    b.con({ type: 'horizontal', line: b.line(ids[0], ids[1]) });
    b.con({ type: 'distance', a: ids[0], b: ids[1], value: d(0, 1) });
    anchors.forEach(([a, c], k) => {
      b.con({ type: 'distance', a: ids[a], b: ids[k + 2], value: d(a, k + 2) });
      b.con({ type: 'distance', a: ids[c], b: ids[k + 2], value: d(c, k + 2) });
    });
    return { s: b.s, truth };
  }

  it('sloppily drawn (±0.5 mm) trusses all solve to the dimensioned shape', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { s, truth } = randomTruss(seed, 0.5);
      const { result, solved } = solveApply(s);
      expect(result.status, `seed ${seed}: ${result.message}`).toBe('fully-constrained');
      expect(result.dof).toBe(0);
      expect(maxResidual(solved)).toBeLessThan(1e-8);
      solved.points.forEach((p, i) => {
        expect(Math.hypot(p.x - truth[i][0], p.y - truth[i][1]), `seed ${seed} point ${p.id}`).toBeLessThan(1e-5);
      });
    }
  });

  it('an impossible dimension in a solved truss is always the one reported, and nothing moves', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { s } = randomTruss(seed, 0);
      const dims = s.constraints.filter(c => c.type === 'distance');
      const pick = dims[1 + (seed % (dims.length - 1))];
      const broken: Sketch = {
        ...s,
        constraints: s.constraints.map(c => (c.id === pick.id && c.type === 'distance' ? { ...c, value: c.value + 1000 } : c)),
      };
      const { result, solved } = solveApply(broken);
      expect(result.status, `seed ${seed}`).toBe('conflicting');
      expect(result.conflicting, `seed ${seed}`).toEqual([pick.id]);
      expect(maxMove(s, solved)).toBeLessThan(1e-9);
      expect(result.message).toContain(`${pick.id} =`);
    }
  });
});

// ---------------------------------------------------------------------------
// performance
// ---------------------------------------------------------------------------

describe('sketch solver — performance', () => {
  /** zig-zag truss of 30 points; `skips` of the 28 possible i→i+2 braces are added */
  function truss(skips: number): Sketch {
    const b = new Build();
    const n = 30;
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      // drawn sloppily: up to ±0.8 mm off the ideal position
      ids.push(b.pt(i * 10 + 0.8 * Math.sin(i * 1.7), (i % 2) * 10 + 0.8 * Math.cos(i * 2.3)));
    }
    b.con({ type: 'fixed', point: ids[0], x: 0, y: 0 });
    const base = b.line(ids[0], ids[2]);
    b.con({ type: 'horizontal', line: base });
    for (let i = 0; i + 1 < n; i++) b.con({ type: 'distance', a: ids[i], b: ids[i + 1], value: Math.SQRT2 * 10 });
    for (let i = 0; i < skips; i++) b.con({ type: 'distance', a: ids[i], b: ids[i + 2], value: 20 });
    return b.s;
  }
  function timeIt(f: () => void, runs = 7): number {
    f(); f(); // warm up
    const t: number[] = [];
    for (let i = 0; i < runs; i++) { const t0 = performance.now(); f(); t.push(performance.now() - t0); }
    return t.sort((a, b) => a - b)[runs >> 1];
  }

  it('30 points / 40 constraints (under-constrained) solves fast', () => {
    const s = truss(9);
    expect(s.points.length).toBe(30);
    expect(s.constraints.length).toBe(40);
    const r = solveSketch(s);
    expect(r.status).toBe('under-constrained');
    expect(r.converged).toBe(true);
    expect(r.dof).toBe(60 - 41);
    expect(maxResidual(applySolve(s, r))).toBeLessThan(1e-8);
    const ms = timeIt(() => solveSketch(s));
    console.log(`30 pt / 40 constraints, under-constrained: ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(200);
  });

  it('30 points fully constrained, re-solve of a solved sketch, and a conflict all stay fast', () => {
    const s = truss(28);
    const r = solveSketch(s);
    expect(r.status).toBe('fully-constrained');
    expect(r.dof).toBe(0);
    const solved = applySolve(s, r);
    near(P(solved, 'p30').x, 290, 1e-6);
    near(P(solved, 'p30').y, 10, 1e-6);
    const msFull = timeIt(() => solveSketch(s));
    const msAgain = timeIt(() => solveSketch(solved));
    // contradict one brace in the solved sketch
    const last = solved.constraints[solved.constraints.length - 1];
    const broken: Sketch = {
      ...solved,
      constraints: solved.constraints.map(c => (c.id === last.id && c.type === 'distance' ? { ...c, value: 35 } : c)),
    };
    const rb = solveSketch(broken);
    expect(rb.status).toBe('conflicting');
    expect(rb.conflicting).toEqual([last.id]);
    expect(maxMove(solved, applySolve(broken, rb))).toBeLessThan(1e-9);
    const msConflict = timeIt(() => solveSketch(broken));
    console.log(`30 pt fully constrained: ${msFull.toFixed(2)} ms, already solved: ${msAgain.toFixed(2)} ms, conflict: ${msConflict.toFixed(2)} ms`);
    expect(msFull).toBeLessThan(200);
    expect(msAgain).toBeLessThan(200);
    expect(msConflict).toBeLessThan(400);
  });
});

describe('conflicts never deform the sketch (review round 1, F-16)', () => {
  it('horizontal + vertical + length on one line is a conflict and the line is not collapsed', () => {
    let s = newSketch('s', 'S');
    const a = addPoint(s, 0, 0); s = a.sketch; const b = addPoint(s, 10, 3); s = b.sketch;
    const l = addLine(s, a.id, b.id); s = l.sketch;
    s = addConstraint(s, { type: 'horizontal', line: l.id }).sketch;
    s = addConstraint(s, { type: 'vertical', line: l.id }).sketch;
    s = addConstraint(s, { type: 'distance', a: a.id, b: b.id, value: 10 }).sketch;
    const r = solveSketch(s);
    expect(r.status).toBe('conflicting');
    const out = applySolve(s, r);
    const pa = out.points.find((p) => p.id === a.id)!, pb = out.points.find((p) => p.id === b.id)!;
    expect(Math.hypot(pa.x - pb.x, pa.y - pb.y)).toBeGreaterThan(9.99);     // still a 10 mm line
    expect(Math.abs(pa.y - pb.y)).toBeLessThan(1e-6);                        // horizontal (the first constraint) holds
    expect(r.conflicting.length).toBe(1);
  });
  it('a zero dimension that would collapse a rectangle side is refused instead of flattening the rectangle', () => {
    let s = newSketch('s', 'S');
    const rect = rectangle(s, 0, 0, 40, 20); s = rect.sketch;
    s = addConstraint(s, { type: 'fixed', point: rect.pointIds[0], x: 0, y: 0 }).sketch;
    const line = s.entities.find((e) => e.type === 'line')! as any;
    const c = addConstraint(s, { type: 'distance', a: line.p1, b: line.p2, value: 0 }); s = c.sketch;
    const r = solveSketch(s);
    expect(r.status).toBe('conflicting');
    expect(r.conflicting).toEqual([c.id]);
    const out = applySolve(s, r);
    for (const e of out.entities) if (e.type === 'line') { const p = out.points.find((q) => q.id === e.p1)!, q = out.points.find((x) => x.id === e.p2)!; expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThan(19.9); }
  });
});
