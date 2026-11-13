/**
 * Planar geometric constraint solver for sketches.
 *
 * Unknowns: x,y of every point and the radius of every circle entity.
 * Every constraint contributes one or two scalar equations; every arc adds the
 * internal equation |centre-start| = |centre-end|.
 *
 * Solving: damped minimum-norm Newton (Levenberg–Marquardt on J Jᵀ, with a line
 * search), so each step moves the geometry as little as possible; then a
 * projected refinement slides along the constraint manifold to the point
 * closest to the input coordinates (or to the drag targets).
 *
 * Diagnosis never compromises: constraints that cannot be satisfied together
 * with the rest are left out and reported, the remaining ones are solved
 * exactly. Order of preference when constraints contradict each other:
 *   1. the implicit arc equations,
 *   2. constraints the input coordinates already satisfy (so the last valid
 *      shape is kept and the constraint that was just added/edited is blamed),
 *   3. the remaining constraints in sketch order (earlier wins).
 * Redundancy and degrees of freedom come from an ordered rank analysis of the
 * unit-normalised Jacobian at the solution.
 */
import type { Sketch, SkConstraint, SkEntity, SketchSolveResult, SketchStatus } from './types';
import { choleskyFactor, choleskySolve } from '../math/linalg';

export interface SolveSketchOptions {
  /** convergence tolerance on every equation residual (mm or rad). Default 1e-9. */
  tol?: number;
  /** maximum Levenberg–Marquardt iterations per solve attempt. Default 100. */
  maxIter?: number;
  /** soft target positions for points being dragged: point id → target */
  dragged?: Record<string, { x: number; y: number }>;
}

const TWO_PI = Math.PI * 2;
/** residual below which a constraint counts as "already satisfied by the input" (priority group) */
const SAT_TOL = 1e-6;
/** a unit-normalised Jacobian row whose remainder after projection is below this adds no rank */
const RANK_TOL = 1e-6;
/** squared null-space projection above which an unknown counts as free */
const FREE_TOL = 1e-8;
/** weight of a dragged coordinate relative to "stay where you are" for everything else */
const DRAG_WEIGHT = 1e6;

// ---------------------------------------------------------------------------
// Equations
// ---------------------------------------------------------------------------

/** term kinds: 0 variable, 1 distance, 2 signed point–line distance, 3 |point–line distance|, 4 line direction angle */
interface Term { k: number; c: number; a: number; b: number; p: number; }

/** residual = wrap( Σ c·term(q) − k0 ) */
interface Eq { terms: Term[]; k0: number; wrap: number; vars: number[]; }

const V = (c: number, a: number): Term => ({ k: 0, c, a, b: 0, p: 0 });
const D = (c: number, a: number, b: number): Term => ({ k: 1, c, a, b, p: 0 });
const S = (c: number, p: number, a: number, b: number): Term => ({ k: 2, c, a, b, p });
const AS = (c: number, p: number, a: number, b: number): Term => ({ k: 3, c, a, b, p });
const TH = (c: number, a: number, b: number): Term => ({ k: 4, c, a, b, p: 0 });

function mkEq(terms: Term[], k0 = 0, wrap = 0): Eq {
  const set = new Set<number>();
  for (const t of terms) {
    if (t.k === 0) { set.add(t.a); continue; }
    set.add(t.a); set.add(t.a + 1); set.add(t.b); set.add(t.b + 1);
    if (t.k === 2 || t.k === 3) { set.add(t.p); set.add(t.p + 1); }
  }
  return { terms, k0, wrap, vars: Array.from(set).sort((x, y) => x - y) };
}

/** Evaluate one equation; when J is given, ADD its gradient into row J[off .. off+n). */
function evalEq(eq: Eq, q: Float64Array, J: Float64Array | null, off: number): number {
  let r = -eq.k0;
  const terms = eq.terms;
  for (let ti = 0; ti < terms.length; ti++) {
    const t = terms[ti];
    const a = t.a, b = t.b;
    switch (t.k) {
      case 0:
        r += t.c * q[a];
        if (J) J[off + a] += t.c;
        break;
      case 1: {
        const dx = q[a] - q[b], dy = q[a + 1] - q[b + 1];
        const L = Math.sqrt(dx * dx + dy * dy);
        let ux = 1, uy = 0; // arbitrary escape direction when the points coincide
        if (L > 1e-12) { ux = dx / L; uy = dy / L; }
        r += t.c * L;
        if (J) {
          J[off + a] += t.c * ux; J[off + a + 1] += t.c * uy;
          J[off + b] -= t.c * ux; J[off + b + 1] -= t.c * uy;
        }
        break;
      }
      case 2:
      case 3: {
        const p = t.p;
        const ux = q[b] - q[a], uy = q[b + 1] - q[a + 1];
        const wx = q[p] - q[a], wy = q[p + 1] - q[a + 1];
        const L = Math.sqrt(ux * ux + uy * uy);
        if (!(L > 1e-12)) break; // degenerate line: contributes nothing
        const d = (ux * wy - uy * wx) / L;
        let c = t.c;
        if (t.k === 3 && d < 0) c = -c;
        r += c * d;
        if (J) {
          const nx = -uy / L, ny = ux / L;
          const gux = wy / L - (d * ux) / (L * L);
          const guy = -wx / L - (d * uy) / (L * L);
          J[off + p] += c * nx; J[off + p + 1] += c * ny;
          J[off + b] += c * gux; J[off + b + 1] += c * guy;
          J[off + a] -= c * (gux + nx); J[off + a + 1] -= c * (guy + ny);
        }
        break;
      }
      default: {
        const dx = q[b] - q[a], dy = q[b + 1] - q[a + 1];
        const L2 = dx * dx + dy * dy;
        if (!(L2 > 1e-24)) break; // degenerate line: direction undefined
        r += t.c * Math.atan2(dy, dx);
        if (J) {
          const gx = (-dy / L2) * t.c, gy = (dx / L2) * t.c;
          J[off + b] += gx; J[off + b + 1] += gy;
          J[off + a] -= gx; J[off + a + 1] -= gy;
        }
      }
    }
  }
  if (eq.wrap !== 0) r -= eq.wrap * Math.round(r / eq.wrap);
  return r;
}

/** Evaluate all equations. Returns max |residual| (NaN if anything is not finite). */
function evalAll(eqs: Eq[], q: Float64Array, c: Float64Array, J: Float64Array | null, n: number): number {
  if (J) J.fill(0);
  let mx = 0;
  for (let i = 0; i < eqs.length; i++) {
    const r = evalEq(eqs[i], q, J, i * n);
    c[i] = r;
    const a = Math.abs(r);
    if (!(a <= mx)) mx = a;
  }
  return mx;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

interface Model {
  n: number;
  nPts: number;
  q0: Float64Array;
  pointIds: string[];
  /** point id → index of its x variable (y is +1) */
  pIndex: Map<string, number>;
  circleIds: string[];
  /** circle entity id → index of its radius variable */
  rIndex: Map<string, number>;
  entities: Map<string, SkEntity>;
  arcIds: string[];
  arcEqs: Eq[];
  /** per user constraint (same order as sketch.constraints); null = references missing/invalid geometry */
  conEqs: (Eq[] | null)[];
  /** characteristic size of the sketch (mm) */
  scale: number;
}

function buildModel(sketch: Sketch): Model {
  const pointIds: string[] = [];
  const pIndex = new Map<string, number>();
  const coords: number[] = [];
  for (const p of sketch.points) {
    if (pIndex.has(p.id)) continue;
    pIndex.set(p.id, 2 * pointIds.length);
    pointIds.push(p.id);
    // non-finite input coordinates are treated as 0 so that constraints can repair them
    coords.push(Number.isFinite(p.x) ? p.x : 0, Number.isFinite(p.y) ? p.y : 0);
  }
  const nPts = pointIds.length;
  const entities = new Map<string, SkEntity>();
  const circleIds: string[] = [];
  const rIndex = new Map<string, number>();
  const radii: number[] = [];
  for (const e of sketch.entities) {
    if (entities.has(e.id)) continue;
    entities.set(e.id, e);
    if (e.type === 'circle' && pIndex.has(e.center)) {
      rIndex.set(e.id, 2 * nPts + circleIds.length);
      circleIds.push(e.id);
      radii.push(Number.isFinite(e.r) ? e.r : 0);
    }
  }
  const n = 2 * nPts + circleIds.length;
  const q0 = new Float64Array(n);
  for (let i = 0; i < coords.length; i++) q0[i] = coords[i];
  for (let i = 0; i < radii.length; i++) q0[2 * nPts + i] = radii[i];

  const arcIds: string[] = [];
  const arcEqs: Eq[] = [];
  for (const e of entities.values()) {
    if (e.type !== 'arc') continue;
    const c = pIndex.get(e.center), s = pIndex.get(e.start), en = pIndex.get(e.end);
    if (c === undefined || s === undefined || en === undefined) continue;
    arcIds.push(e.id);
    arcEqs.push(mkEq([D(1, c, s), D(-1, c, en)]));
  }

  const model: Model = {
    n, nPts, q0, pointIds, pIndex, circleIds, rIndex, entities, arcIds, arcEqs, conEqs: [], scale: 1,
  };
  model.conEqs = sketch.constraints.map(c => constraintEqs(c, model));

  // characteristic size
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < nPts; i++) {
    const x = q0[2 * i], y = q0[2 * i + 1];
    if (Number.isFinite(x)) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
    if (Number.isFinite(y)) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  let scale = 0;
  if (maxX >= minX && maxY >= minY) scale = Math.hypot(maxX - minX, maxY - minY);
  for (const r of radii) if (Number.isFinite(r)) scale = Math.max(scale, Math.abs(r));
  for (const c of sketch.constraints) {
    if ((c.type === 'distance' || c.type === 'radius') && Number.isFinite(c.value)) scale = Math.max(scale, Math.abs(c.value));
  }
  model.scale = scale > 1e-9 ? scale : 1;
  return model;
}

function constraintEqs(c: SkConstraint, m: Model): Eq[] | null {
  const pt = (id: string): number => {
    const i = m.pIndex.get(id);
    return i === undefined ? -1 : i;
  };
  const line = (id: string): [number, number] | null => {
    const e = m.entities.get(id);
    if (!e || e.type !== 'line') return null;
    const a = pt(e.p1), b = pt(e.p2);
    return a < 0 || b < 0 ? null : [a, b];
  };
  /** radius of a circle/arc as a term */
  const radTerm = (id: string, coef: number): Term | null => {
    const e = m.entities.get(id);
    if (!e) return null;
    if (e.type === 'circle') {
      const r = m.rIndex.get(id);
      return r === undefined ? null : V(coef, r);
    }
    if (e.type === 'arc') {
      const cc = pt(e.center), s = pt(e.start), en = pt(e.end);
      return cc < 0 || s < 0 || en < 0 ? null : D(coef, cc, s);
    }
    return null;
  };
  const centre = (id: string): number => {
    const e = m.entities.get(id);
    return e && (e.type === 'circle' || e.type === 'arc') ? pt(e.center) : -1;
  };

  switch (c.type) {
    case 'coincident': {
      const a = pt(c.a), b = pt(c.b);
      if (a < 0 || b < 0) return null;
      return [mkEq([V(1, a), V(-1, b)]), mkEq([V(1, a + 1), V(-1, b + 1)])];
    }
    case 'fixed': {
      const p = pt(c.point);
      if (p < 0 || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return null;
      return [mkEq([V(1, p)], c.x), mkEq([V(1, p + 1)], c.y)];
    }
    case 'horizontal': {
      const l = line(c.line);
      return l ? [mkEq([V(1, l[1] + 1), V(-1, l[0] + 1)])] : null;
    }
    case 'vertical': {
      const l = line(c.line);
      return l ? [mkEq([V(1, l[1]), V(-1, l[0])])] : null;
    }
    case 'distance': {
      const a = pt(c.a), b = pt(c.b);
      if (a < 0 || b < 0 || !Number.isFinite(c.value)) return null;
      if (Math.abs(c.value) <= 1e-12) return [mkEq([V(1, a), V(-1, b)]), mkEq([V(1, a + 1), V(-1, b + 1)])];
      return [mkEq([D(1, a, b)], c.value)];
    }
    case 'angle': {
      const l1 = line(c.l1), l2 = line(c.l2);
      if (!l1 || !l2 || !Number.isFinite(c.value)) return null;
      return [mkEq([TH(1, l2[0], l2[1]), TH(-1, l1[0], l1[1])], c.value, TWO_PI)];
    }
    case 'parallel':
    case 'perpendicular': {
      const l1 = line(c.l1), l2 = line(c.l2);
      if (!l1 || !l2) return null;
      return [mkEq([TH(1, l2[0], l2[1]), TH(-1, l1[0], l1[1])], c.type === 'parallel' ? 0 : Math.PI / 2, Math.PI)];
    }
    case 'radius': {
      const t = radTerm(c.entity, 1);
      if (!t || !Number.isFinite(c.value)) return null;
      return [mkEq([t], c.value)];
    }
    case 'equal': {
      const l1 = line(c.e1), l2 = line(c.e2);
      if (l1 && l2) return [mkEq([D(1, l1[0], l1[1]), D(-1, l2[0], l2[1])])];
      const r1 = radTerm(c.e1, 1), r2 = radTerm(c.e2, -1);
      return r1 && r2 ? [mkEq([r1, r2])] : null;
    }
    case 'pointOn': {
      const p = pt(c.point);
      if (p < 0) return null;
      const l = line(c.entity);
      if (l) return [mkEq([S(1, p, l[0], l[1])])];
      const cc = centre(c.entity), r = radTerm(c.entity, -1);
      return cc >= 0 && r ? [mkEq([D(1, p, cc), r])] : null;
    }
    case 'tangent': {
      const l = line(c.line);
      const cc = centre(c.circle), r = radTerm(c.circle, -1);
      return l && cc >= 0 && r ? [mkEq([AS(1, cc, l[0], l[1]), r])] : null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Levenberg–Marquardt (minimum-norm form)
// ---------------------------------------------------------------------------

interface LMResult { ok: boolean; q: Float64Array; res: number; iters: number; }

/**
 * Drive all equations to zero starting from qStart. Steps are
 *   dq = −W⁻¹Jᵀ (J W⁻¹ Jᵀ + μI)⁻¹ c
 * with rows normalised to unit length, i.e. damped minimum-norm Newton steps,
 * globalised by backtracking and, when that fails, by raising μ.
 * `winv` (optional) holds 1/weight per unknown: heavy unknowns move less.
 * `ok` means every |residual| ≤ tol; the iteration normally ends well below tol.
 */
function lmSolve(
  eqs: Eq[], qStart: Float64Array, winv: Float64Array | null, tol: number, maxIter: number, scale: number,
): LMResult {
  const m = eqs.length, n = qStart.length;
  const q = Float64Array.from(qStart);
  if (m === 0) return { ok: true, q, res: 0, iters: 0 };
  const c = new Float64Array(m);
  const J = new Float64Array(m * n);
  let res = evalAll(eqs, q, c, J, n);
  if (res <= tol) return { ok: true, q, res, iters: 0 };

  const cn = new Float64Array(m), s = new Float64Array(m), y = new Float64Array(m);
  const A0 = new Float64Array(m * m), A = new Float64Array(m * m);
  const qn = new Float64Array(n), dq = new Float64Array(n);
  const y2 = new Float64Array(m), g2 = new Float64Array(n);
  const hist: number[] = [];
  // the damping acts on SQUARED singular values of the unit-row Jacobian, so it starts tiny:
  // chains of ill-conditioned triangles easily reach singular values of 1e-6
  let mu = 1e-12;
  let iters = 0;
  /** extra iterations spent after reaching tol, to land well below it */
  let polish = 0;
  /** growth factor of the damping after a failed step */
  let nu = 10;
  /** best iterate already within tol (polishing must never lose it) */
  let best: Float64Array | null = null;
  let bestRes = Infinity;

  while (iters < maxIter) {
    // normalise rows (so mm and rad equations are comparable and μ is meaningful)
    let merit = 0, raw = 0;
    for (let i = 0; i < m; i++) {
      const vars = eqs[i].vars, ro = i * n;
      let nn = 0;
      for (let k = 0; k < vars.length; k++) {
        const g = J[ro + vars[k]];
        nn += winv ? g * g * winv[vars[k]] : g * g;
      }
      const si = nn > 1e-24 ? 1 / Math.max(Math.sqrt(nn), 1e-6) : 1;
      s[i] = si;
      for (let k = 0; k < vars.length; k++) J[ro + vars[k]] *= si;
      const cs = c[i] * si;
      merit += cs * cs;
      raw += c[i] * c[i];
    }
    if (!Number.isFinite(merit)) break;
    // stagnation: stuck at a least-squares compromise (infeasible) → give up early
    hist.push(raw);
    if (polish === 0 && hist.length > 6 && raw > 0.99 * hist[hist.length - 6]) break;

    // A0 = J W⁻¹ Jᵀ (lower triangle)
    for (let i = 0; i < m; i++) {
      const vars = eqs[i].vars, ro = i * n;
      for (let k = 0; k <= i; k++) {
        const rk = k * n;
        let sum = 0;
        for (let v = 0; v < vars.length; v++) {
          const j = vars[v];
          const g = J[rk + j];
          if (g !== 0) sum += winv ? J[ro + j] * g * winv[j] : J[ro + j] * g;
        }
        A0[i * m + k] = sum;
      }
    }

    let accepted = false;
    while (iters < maxIter) {
      iters++;
      A.set(A0);
      for (let i = 0; i < m; i++) A[i * m + i] += mu;
      choleskyFactor(A, m, 1e-15);
      for (let i = 0; i < m; i++) y[i] = c[i] * s[i];
      choleskySolve(A, m, y);
      dq.fill(0);
      for (let i = 0; i < m; i++) {
        const yi = y[i];
        if (yi === 0) continue;
        const vars = eqs[i].vars, ro = i * n;
        for (let k = 0; k < vars.length; k++) dq[vars[k]] -= J[ro + vars[k]] * yi;
      }
      let stepMax = 0, stepNorm2 = 0;
      for (let j = 0; j < n; j++) {
        stepNorm2 += winv ? dq[j] * dq[j] * winv[j] : dq[j] * dq[j];
        if (winv) dq[j] *= winv[j];
        const a = Math.abs(dq[j]);
        if (a > stepMax) stepMax = a;
      }
      if (!(stepMax > 1e-14 * scale)) { iters = maxIter; break; } // stationary: no further progress possible
      // Backtracking along the (nearly) Newton direction first: it copes with ill-conditioning
      // far better than damping does; only when that fails is the damping increased.
      // A trial point is accepted when the residual drops, or — for ill-conditioned systems,
      // where a good step may raise the residual a little — when the NEXT correction computed
      // with the same Jacobian is clearly shorter (natural monotonicity test).
      // (only once the residuals are small compared with the sketch: far away it would just wander)
      const local = merit < m * (0.01 * scale) * (0.01 * scale);
      let alpha = 1;
      for (let ls = 0; ls < 4; ls++) {
        for (let j = 0; j < n; j++) qn[j] = q[j] + alpha * dq[j];
        evalAll(eqs, qn, cn, null, n);
        let meritN = 0;
        for (let i = 0; i < m; i++) { const v = cn[i] * s[i]; meritN += v * v; }
        if (meritN < merit * (1 - 1e-4 * alpha)) { accepted = true; break; }
        if (polish > 0) break; // already within tol and cannot improve further
        if (local && meritN < 100 * merit) {
          for (let i = 0; i < m; i++) y2[i] = cn[i] * s[i];
          choleskySolve(A, m, y2);
          g2.fill(0);
          for (let i = 0; i < m; i++) {
            const yi = y2[i];
            if (yi === 0) continue;
            const vars = eqs[i].vars, ro = i * n;
            for (let k = 0; k < vars.length; k++) g2[vars[k]] += J[ro + vars[k]] * yi;
          }
          let next2 = 0;
          for (let j = 0; j < n; j++) next2 += winv ? g2[j] * g2[j] * winv[j] : g2[j] * g2[j];
          const lim = 1 - alpha / 4;
          if (next2 <= lim * lim * stepNorm2) { accepted = true; break; }
        }
        alpha *= 0.4;
      }
      if (accepted) {
        q.set(qn);
        if (alpha === 1) mu = Math.max(mu * 0.2, 1e-14);
        nu = 10;
        break;
      }
      if (polish > 0) break;
      mu *= nu;
      nu *= 3;
      if (mu > 1e6) break;
    }
    if (!accepted) break;
    res = evalAll(eqs, q, c, J, n);
    if (res <= tol) {
      if (res <= tol * 1e-3 || polish >= 2) break;
      if (!best || res < bestRes) { best = Float64Array.from(q); bestRes = res; }
      polish++;
    }
  }
  if (best && !(res <= bestRes)) return { ok: true, q: best, res: bestRes, iters };
  return { ok: res <= tol, q, res, iters };
}

/** deterministic PRNG (mulberry32) */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** [start from the stuck point?, perturbation amplitude relative to sketch size] */
const RESTARTS: [boolean, number][] = [[true, 0.01], [false, 0.05], [true, 0.2]];

/**
 * lmSolve plus a few deterministic perturbed restarts, so that symmetric /
 * degenerate starting positions (collinear triangles, coincident points …) are
 * not mistaken for conflicts. On failure the result of the FIRST attempt is
 * returned (its end point is the least-squares compromise used for diagnosis).
 */
function solveRobust(
  eqs: Eq[], qStart: Float64Array, tol: number, maxIter: number, scale: number, first?: LMResult,
): LMResult {
  const r0 = first ?? lmSolve(eqs, qStart, null, tol, maxIter, scale);
  if (r0.ok) return r0;
  const n = qStart.length;
  for (let a = 0; a < RESTARTS.length; a++) {
    const [fromStuck, amp] = RESTARTS[a];
    const base = fromStuck ? r0.q : qStart;
    const rand = rng(0x51ed270b + a * 7919);
    const qp = new Float64Array(n);
    let finite = true;
    for (let j = 0; j < n; j++) {
      qp[j] = base[j] + amp * scale * (2 * rand() - 1);
      if (!Number.isFinite(qp[j])) finite = false;
    }
    if (!finite) continue;
    const r = lmSolve(eqs, qp, null, tol, maxIter, scale);
    if (r.ok) return r;
  }
  return r0;
}

/**
 * Starting from a feasible q, slide along the constraint manifold to minimise
 *   f(q) = ½ Σ w_j (q_j − t_j)²
 * by projected Gauss–Newton steps with backtracking; every accepted iterate is
 * restored onto the manifold, so the result always satisfies the equations.
 * The tangent-space projection uses the orthonormal row basis of analyseRank
 * (well conditioned, and consistent with the rank decisions of the diagnosis).
 */
function refine(
  eqs: Eq[], qFeas: Float64Array, t: Float64Array, w: Float64Array | null,
  tol: number, scale: number, maxOuter: number,
): Float64Array {
  const n = qFeas.length;
  let q = qFeas;
  const winv = w ? Float64Array.from(w, v => 1 / v) : null;
  /** column scale: unknowns are measured in units of 1/√weight */
  const cs = w ? Float64Array.from(w, v => 1 / Math.sqrt(v)) : null;
  const f = (x: Float64Array): number => {
    let sum = 0;
    for (let j = 0; j < n; j++) { const d = x[j] - t[j]; sum += (w ? w[j] : 1) * d * d; }
    return 0.5 * sum;
  };
  let fq = f(q);
  const d = new Float64Array(n), qt = new Float64Array(n);
  let alphaPrev = 1;
  /** stop when an iteration improves the objective by less than this fraction (looser while dragging) */
  const relStop = w ? 1e-9 : 1e-13;
  for (let outer = 0; outer < maxOuter; outer++) {
    if (!(fq > 1e-26 * scale * scale)) break;
    const ra = analyseRank(eqs, q, n, cs);
    if (ra.rank >= n) break; // nothing can move
    // d = −(pull-back to the target) projected onto the tangent space, in scaled unknowns
    for (let j = 0; j < n; j++) d[j] = (t[j] - q[j]) / (cs ? cs[j] : 1);
    for (let k = 0; k < ra.rank; k++) {
      const ko = k * n;
      let dot = 0;
      for (let j = 0; j < n; j++) dot += ra.Q[ko + j] * d[j];
      if (dot !== 0) for (let j = 0; j < n; j++) d[j] -= dot * ra.Q[ko + j];
    }
    let slope = 0;
    for (let j = 0; j < n; j++) { slope += d[j] * d[j]; if (cs) d[j] *= cs[j]; }
    if (!(slope > 2e-18 * fq) || !(slope > 1e-22 * scale * scale)) break; // tangential pull is negligible
    // line search along the restored path; f(α) ≈ f − slope·α + ½κα² gives a near-optimal second trial
    const fOld = fq;
    const trial = (a: number): { q: Float64Array; f: number } | null => {
      for (let j = 0; j < n; j++) qt[j] = q[j] + a * d[j];
      const r = lmSolve(eqs, qt, winv, tol, 30, scale);
      return r.ok ? { q: r.q, f: f(r.q) } : null;
    };
    let alpha = Math.min(8, Math.max(alphaPrev, 1e-3));
    let moved = false;
    for (let bt = 0; bt < 7; bt++) {
      const r = trial(alpha);
      let alphaQ = NaN;
      if (r) {
        const kappa = (2 * (r.f - fOld + slope * alpha)) / (alpha * alpha);
        alphaQ = kappa > 0 ? slope / kappa : Infinity;
        if (r.f < fOld - 1e-4 * alpha * slope) {
          let best = r, bestAlpha = alpha;
          if (alphaQ < 0.7 * alpha || alphaQ > 1.5 * alpha) {
            const a2 = Math.min(8, 4 * alpha, Math.max(alphaQ, 0.05 * alpha));
            const r2 = trial(a2);
            if (r2 && r2.f < best.f) { best = r2; bestAlpha = a2; }
          }
          q = best.q; fq = best.f; alphaPrev = bestAlpha; moved = true;
          break;
        }
      }
      alpha = alphaQ < alpha ? Math.max(alphaQ, 0.1 * alpha) : 0.3 * alpha;
    }
    if (!moved) break;
    if (fOld - fq <= relStop * fOld) break;
  }
  return q;
}

// ---------------------------------------------------------------------------
// Rank analysis
// ---------------------------------------------------------------------------

interface RankAnalysis {
  rank: number;
  /** per equation (in the given order): does it add rank over the equations before it? */
  independent: boolean[];
  /** orthonormal basis of the row space, rank × n */
  Q: Float64Array;
}

/**
 * Ordered rank-revealing orthogonalisation (modified Gram–Schmidt, twice) of the
 * unit-normalised Jacobian rows. `colScale` optionally rescales the unknowns.
 */
function analyseRank(eqs: Eq[], q: Float64Array, n: number, colScale: Float64Array | null = null): RankAnalysis {
  const m = eqs.length;
  const Q = new Float64Array(Math.min(m, n) * n);
  const independent: boolean[] = new Array<boolean>(m).fill(false);
  const row = new Float64Array(n);
  let rank = 0;
  for (let i = 0; i < m && rank < n; i++) {
    row.fill(0);
    evalEq(eqs[i], q, row, 0);
    let nn = 0;
    for (let j = 0; j < n; j++) { if (colScale) row[j] *= colScale[j]; nn += row[j] * row[j]; }
    if (!(nn > 1e-24)) continue;
    const inv = 1 / Math.sqrt(nn);
    for (let j = 0; j < n; j++) row[j] *= inv;
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < rank; k++) {
        const ko = k * n;
        let dot = 0;
        for (let j = 0; j < n; j++) dot += row[j] * Q[ko + j];
        if (dot !== 0) for (let j = 0; j < n; j++) row[j] -= dot * Q[ko + j];
      }
    }
    let rem = 0;
    for (let j = 0; j < n; j++) rem += row[j] * row[j];
    rem = Math.sqrt(rem);
    if (rem > RANK_TOL) {
      const ko = rank * n;
      for (let j = 0; j < n; j++) Q[ko + j] = row[j] / rem;
      independent[i] = true;
      rank++;
    }
  }
  return { rank, independent, Q };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function fmt(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

function describe(c: SkConstraint): string {
  switch (c.type) {
    case 'distance': return `distance ${c.id} = ${fmt(c.value)} mm`;
    case 'radius': return `radius ${c.id} = ${fmt(c.value)} mm`;
    case 'angle': return `angle ${c.id} = ${fmt((c.value * 180) / Math.PI)}°`;
    case 'pointOn': return `point-on ${c.id}`;
    default: return `${c.type} ${c.id}`;
  }
}

function capitalise(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

function listSome(items: string[], max: number): string {
  return items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Solve a sketch and diagnose its constraint state. The input is not modified.
 * See the module comment for the method; see SketchSolveResult for the output.
 */
export function solveSketch(sketch: Sketch, opts: SolveSketchOptions = {}): SketchSolveResult {
  const tol = opts.tol !== undefined && opts.tol > 0 ? opts.tol : 1e-9;
  const maxIter = opts.maxIter !== undefined && opts.maxIter >= 1 ? Math.floor(opts.maxIter) : 100;
  const model = buildModel(sketch);
  const { n, nPts, q0, scale, arcEqs, conEqs } = model;
  if (nPts === 0) {
    return {
      status: 'empty', converged: true, dof: 0, points: {}, radii: {}, redundant: [], conflicting: [],
      freePoints: [], freeRadii: [], residual: 0, message: 'The sketch is empty.',
    };
  }
  const cons = sketch.constraints;
  const validIdx: number[] = [];
  const ignored: string[] = [];
  cons.forEach((c, i) => { if (conEqs[i]) validIdx.push(i); else ignored.push(c.id); });

  const accepted = new Uint8Array(cons.length);
  const conflicts: { ci: number; culprits: string[] }[] = [];
  let q: Float64Array;

  // ---- fast path: everything at once ------------------------------------
  const allEqs: Eq[] = arcEqs.slice();
  for (const ci of validIdx) for (const e of conEqs[ci]!) allEqs.push(e);
  // A "solution" that collapses a line to a point or a circle to zero radius is a deformation, not a
  // solution (e.g. horizontal + vertical on the same line). Such results are treated as conflicts.
  const degTol = Math.max(1e-6, 1e-7 * scale);
  const shapes: { kind: 'line' | 'circle'; a: number; b: number }[] = [];
  for (const e of model.entities.values()) {
    if (e.type === 'line') {
      const a = model.pIndex.get(e.p1), b = model.pIndex.get(e.p2);
      if (a !== undefined && b !== undefined && Math.hypot(q0[a] - q0[b], q0[a + 1] - q0[b + 1]) > degTol) shapes.push({ kind: 'line', a, b });
    } else if (e.type === 'circle') {
      const r = model.rIndex.get(e.id);
      if (r !== undefined && q0[r] > degTol) shapes.push({ kind: 'circle', a: r, b: r });
    } else {
      const c = model.pIndex.get(e.center), st = model.pIndex.get(e.start);
      if (c !== undefined && st !== undefined && Math.hypot(q0[c] - q0[st], q0[c + 1] - q0[st + 1]) > degTol) shapes.push({ kind: 'line', a: c, b: st });
    }
  }
  const collapses = (qq: Float64Array): boolean => shapes.some((sh) => (sh.kind === 'line' ? Math.hypot(qq[sh.a] - qq[sh.b], qq[sh.a + 1] - qq[sh.b + 1]) <= degTol : qq[sh.a] <= degTol));
  const r0 = lmSolve(allEqs, q0, null, tol, maxIter, scale);
  if (r0.ok && !collapses(r0.q)) {
    q = r0.q;
    for (const ci of validIdx) accepted[ci] = 1;
  } else {
    // ---- incremental: grow an accepted set, constraints the input already satisfies first
    q = Float64Array.from(q0);
    let movedFromInput = false;
    let accEqs: Eq[] = arcEqs.slice();
    let accOwners: number[] = arcEqs.map((_, k) => -1 - k);
    if (arcEqs.length) {
      const ra = solveRobust(arcEqs, q, tol, maxIter, scale);
      if (ra.ok) { if (ra.iters > 0) movedFromInput = true; q = ra.q; }
    }
    const resAt = (ci: number, qq: Float64Array): number => {
      let mx = 0;
      for (const e of conEqs[ci]!) { const a = Math.abs(evalEq(e, qq, null, 0)); if (!(a <= mx)) mx = a; }
      return mx;
    };
    const accept = (ci: number): void => {
      accepted[ci] = 1;
      for (const e of conEqs[ci]!) { accEqs.push(e); accOwners.push(ci); }
    };
    const groupA: number[] = [], groupB: number[] = [];
    for (const ci of validIdx) (resAt(ci, q) <= SAT_TOL ? groupA : groupB).push(ci);
    let queue = groupB;
    if (groupA.length) {
      const eqsA = accEqs.slice();
      for (const ci of groupA) for (const e of conEqs[ci]!) eqsA.push(e);
      const ra = lmSolve(eqsA, q, null, tol, maxIter, scale);
      if (ra.ok && !collapses(ra.q)) {
        if (ra.iters > 0) movedFromInput = true;
        q = ra.q;
        for (const ci of groupA) accept(ci);
      } else {
        queue = groupA.concat(groupB);
      }
    }
    // the first attempt for a lone remaining candidate is exactly the failed all-at-once solve
    const reuse = queue.length === 1 && queue === groupB && !movedFromInput ? r0 : undefined;
    for (const ci of queue) {
      if (resAt(ci, q) <= tol) { accept(ci); continue; }
      const tryEqs = accEqs.concat(conEqs[ci]!);
      const r = solveRobust(tryEqs, q, tol, maxIter, scale, reuse && !collapses(reuse.q) ? reuse : undefined);
      if (r.ok && !collapses(r.q)) {
        q = r.q;
        accept(ci);
        continue;
      }
      // conflict: name the accepted constraints that carry stress at the least-squares compromise
      const owners = accOwners.concat(conEqs[ci]!.map(() => ci));
      conflicts.push({ ci, culprits: findCulprits(sketch, model, tryEqs, owners, r.q, ci) });
    }
  }

  // ---- accepted equations in canonical order (arcs first, then user order) ----
  const eqs: Eq[] = arcEqs.slice();
  const owners: number[] = arcEqs.map(() => -1);
  for (const ci of validIdx) {
    if (!accepted[ci]) continue;
    for (const e of conEqs[ci]!) { eqs.push(e); owners.push(ci); }
  }

  // ---- minimise movement from the input / follow drag targets ----
  const target = Float64Array.from(q0);
  let weights: Float64Array | null = null;
  if (opts.dragged) {
    for (const id of Object.keys(opts.dragged)) {
      const i = model.pIndex.get(id);
      const tp = opts.dragged[id];
      if (i === undefined || !tp || !Number.isFinite(tp.x) || !Number.isFinite(tp.y)) continue;
      if (!weights) weights = new Float64Array(n).fill(1);
      target[i] = tp.x; target[i + 1] = tp.y;
      weights[i] = DRAG_WEIGHT; weights[i + 1] = DRAG_WEIGHT;
    }
  }
  {
    const cc = new Float64Array(eqs.length);
    if (evalAll(eqs, q, cc, null, n) <= tol) q = refine(eqs, q, target, weights, tol, scale, weights ? 40 : 20);
  }

  // ---- diagnosis at the solution ----
  const cFinal = new Float64Array(eqs.length);
  const residual = evalAll(eqs, q, cFinal, null, n);
  const converged = residual <= tol;
  const ra = analyseRank(eqs, q, n);
  const dof = n - ra.rank;

  const addsRank = new Uint8Array(cons.length);
  for (let i = 0; i < eqs.length; i++) if (owners[i] >= 0 && ra.independent[i]) addsRank[owners[i]] = 1;
  const redundant: string[] = [];
  for (const ci of validIdx) if (accepted[ci] && !addsRank[ci]) redundant.push(cons[ci].id);
  const conflicting = conflicts.map(k => cons[k.ci].id);

  // free unknowns: e_j has a component in the null space of J  ⇔  1 − Σ_k Q_kj² > 0
  const pinned = new Float64Array(n);
  for (let k = 0; k < ra.rank; k++) for (let j = 0; j < n; j++) { const v = ra.Q[k * n + j]; pinned[j] += v * v; }
  const isFree = (j: number): boolean => 1 - pinned[j] > FREE_TOL;
  const points: Record<string, { x: number; y: number }> = {};
  const freePoints: string[] = [];
  for (let i = 0; i < nPts; i++) {
    const id = model.pointIds[i];
    points[id] = { x: q[2 * i], y: q[2 * i + 1] };
    if (isFree(2 * i) || isFree(2 * i + 1)) freePoints.push(id);
  }
  const radii: Record<string, number> = {};
  const freeRadii: string[] = [];
  const g = new Float64Array(n);
  for (const e of model.entities.values()) {
    if (e.type === 'circle') {
      const ri = model.rIndex.get(e.id);
      if (ri === undefined) continue;
      radii[e.id] = q[ri];
      if (isFree(ri)) freeRadii.push(e.id);
    } else if (e.type === 'arc') {
      // radius |centre−start| is free when its gradient is not entirely in the row space
      const ci = model.pIndex.get(e.center), si = model.pIndex.get(e.start);
      if (ci === undefined || si === undefined || !model.pIndex.has(e.end)) continue;
      g.fill(0);
      evalEq(mkEq([D(1, ci, si)]), q, g, 0);
      let gg = 0;
      for (let j = 0; j < n; j++) gg += g[j] * g[j];
      let inRow = 0;
      for (let k = 0; k < ra.rank; k++) {
        let dot = 0;
        for (let j = 0; j < n; j++) dot += ra.Q[k * n + j] * g[j];
        inRow += dot * dot;
      }
      if (gg - inRow > FREE_TOL * Math.max(gg, 1)) freeRadii.push(e.id);
    }
  }

  // ---- status + message ----
  let status: SketchStatus;
  let message: string;
  if (conflicting.length) {
    status = 'conflicting';
    const parts = conflicts.slice(0, 3).map(k => {
      const name = capitalise(describe(cons[k.ci]));
      return k.culprits.length
        ? `${name} conflicts with: ${listSome(k.culprits, 8)}`
        : `${name} cannot be satisfied together with the other constraints`;
    });
    message = parts.join('; ');
    if (conflicts.length > 3) message += `; and ${conflicts.length - 3} more conflicting constraint(s)`;
    message += '. The conflicting constraint' + (conflicts.length > 1 ? 's were' : ' was') + ' not applied.';
  } else if (redundant.length) {
    status = 'redundant';
    const names = validIdx.filter(ci => accepted[ci] && !addsRank[ci]).map(ci => describe(cons[ci]));
    message = `Redundant: ${listSome(names, 6)} ${names.length > 1 ? 'repeat' : 'repeats'} what the other constraints already enforce and can be removed.`;
  } else if (dof === 0) {
    status = 'fully-constrained';
    message = 'Fully constrained.';
  } else {
    status = 'under-constrained';
    message = `Under-constrained: ${dof} degree${dof === 1 ? '' : 's'} of freedom remain${dof === 1 ? 's' : ''}`;
    const hasFixed = validIdx.some(ci => accepted[ci] && cons[ci].type === 'fixed');
    if (!hasFixed) {
      message += '. No point is fixed yet — fix a point to anchor the sketch.';
    } else {
      const free = freePoints.concat(freeRadii.map(id => `radius of ${id}`));
      message += free.length ? ` (still free: ${listSome(free, 6)}).` : '.';
    }
  }
  if (status !== 'conflicting' && dof > 0 && status === 'redundant') {
    message += ` ${dof} degree${dof === 1 ? '' : 's'} of freedom remain${dof === 1 ? 's' : ''}.`;
  }
  if (ignored.length) message += ` Ignored (missing or invalid references): ${listSome(ignored, 6)}.`;
  if (!converged) message += ' The solver did not converge on the remaining constraints.';

  return { status, converged, dof, points, radii, redundant, conflicting, freePoints, freeRadii, residual, message };
}

/**
 * Which accepted constraints take part in a conflict? At the least-squares
 * compromise reached by the failed solve, exactly the constraints that carry
 * "stress" (non-zero residual) are fighting the candidate. Falls back to the
 * accepted constraints that share unknowns with the candidate.
 */
function findCulprits(
  sketch: Sketch, model: Model, eqs: Eq[], owners: number[], qStuck: Float64Array, cand: number,
): string[] {
  const n = model.n, m = eqs.length;
  const c = new Float64Array(m), J = new Float64Array(m * n);
  const stress = new Map<number, number>();
  let finite = true, mx = 0;
  evalAll(eqs, qStuck, c, J, n);
  for (let i = 0; i < m; i++) {
    let nn = 0;
    for (const v of eqs[i].vars) nn += J[i * n + v] * J[i * n + v];
    const s = Math.abs(c[i]) * (nn > 1e-24 ? 1 / Math.max(Math.sqrt(nn), 1e-6) : 1);
    if (!Number.isFinite(s)) { finite = false; break; }
    if (s > mx) mx = s;
    if (s > (stress.get(owners[i]) ?? 0)) stress.set(owners[i], s);
  }
  const label = (o: number): string => (o >= 0 ? describe(sketch.constraints[o]) : `arc ${model.arcIds[-1 - o]}`);
  const out: string[] = [];
  if (finite && mx > 0) {
    const keys = Array.from(stress.keys()).filter(o => o !== cand && stress.get(o)! > 0.02 * mx);
    keys.sort((a, b) => a - b);
    for (const o of keys) out.push(label(o));
  }
  if (out.length) return out;
  // fallback: accepted constraints touching the same unknowns
  const mine = new Set<number>();
  for (let i = 0; i < m; i++) if (owners[i] === cand) for (const v of eqs[i].vars) mine.add(v);
  const seen = new Set<number>();
  for (let i = 0; i < m; i++) {
    const o = owners[i];
    if (o === cand || seen.has(o)) continue;
    if (eqs[i].vars.some(v => mine.has(v))) { seen.add(o); out.push(label(o)); }
  }
  return out;
}

/** New sketch with the solved coordinates / radii written back (input untouched). */
export function applySolve(sketch: Sketch, result: SketchSolveResult): Sketch {
  return {
    ...sketch,
    points: sketch.points.map(p => {
      const s = result.points[p.id];
      return s ? { ...p, x: s.x, y: s.y } : p;
    }),
    entities: sketch.entities.map(e => {
      if (e.type !== 'circle') return e;
      const r = result.radii[e.id];
      return r === undefined ? e : { ...e, r };
    }),
  };
}

/**
 * Absolute residual of every constraint at the sketch's current coordinates
 * (mm, or rad for angle / parallel / perpendicular). Two-equation constraints
 * (coincident, fixed) report the Euclidean distance. Constraints that reference
 * missing or unsuitable geometry report Infinity.
 */
export function constraintResiduals(sketch: Sketch): Record<string, number> {
  const model = buildModel(sketch);
  const out: Record<string, number> = {};
  sketch.constraints.forEach((c, i) => {
    const eqs = model.conEqs[i];
    if (!eqs) { out[c.id] = Infinity; return; }
    let sum = 0;
    for (const e of eqs) { const r = evalEq(e, model.q0, null, 0); sum += r * r; }
    out[c.id] = Math.sqrt(sum);
  });
  return out;
}

/**
 * @internal Test hook: largest difference between the analytic Jacobian and a
 * central finite-difference Jacobian over all equations of the sketch.
 */
export function _jacobianMaxError(sketch: Sketch, h = 1e-6): number {
  const model = buildModel(sketch);
  const n = model.n;
  const eqs: Eq[] = model.arcEqs.slice();
  for (const list of model.conEqs) if (list) for (const e of list) eqs.push(e);
  const row = new Float64Array(n);
  const q = Float64Array.from(model.q0);
  let worst = 0;
  for (const e of eqs) {
    row.fill(0);
    evalEq(e, q, row, 0);
    for (let j = 0; j < n; j++) {
      const keep = q[j];
      q[j] = keep + h; const fp = evalEq(e, q, null, 0);
      q[j] = keep - h; const fm = evalEq(e, q, null, 0);
      q[j] = keep;
      let diff = fp - fm;
      if (e.wrap !== 0) diff -= e.wrap * Math.round(diff / e.wrap);
      worst = Math.max(worst, Math.abs(diff / (2 * h) - row[j]));
    }
  }
  return worst;
}
