/**
 * Planar multibody solver.
 *
 * Coordinates: maximal (x, y, θ of each rigid body's centre of mass).
 *
 * DYNAMIC MODE — fixed-step, constraint-based time stepping:
 *   1. explicit forces (gravity, springs, loads) → v* = v + h·M⁻¹f
 *   2. bilateral joint constraints J v⁺ = −C/h are solved EXACTLY each step by
 *      a dense Cholesky factorisation of S = J M⁻¹ Jᵀ (Lagrange multipliers);
 *   3. unilateral / bounded rows (floor contact with Coulomb friction, cam
 *      contact, joint limits, torque-limited motors, joint friction, viscous
 *      damping) form a small boxed complementarity problem on the exact Schur
 *      complement of (2), solved by projected Gauss–Seidel;
 *   4. positions advance with the new velocities and are projected back onto
 *      the joint constraints along M⁻¹Jᵀ, with the correction fed back into
 *      the velocity (SHAKE, Ryckaert et al. 1977) — second-order accurate and
 *      free of secular energy drift for conservative systems.
 *
 * KINEMATIC MODE — motors are prescribed joint coordinates; each step solves
 * C(q, t) = 0 by Newton iteration. No forces are computed.
 *
 * A step that cannot satisfy the constraints is NOT committed: the state stays
 * at the last valid configuration and `status` reports what failed.
 */
import type { MechModel, Con, CoordDef, CamDef, FloorContactDef, MotorDef } from '../assembly/compile';
import type { MotorSpec } from '../model/types';
import { choleskyFactor, choleskySolve, rankReveal } from '../math/linalg';
import { camPitch } from '../parts/profiles';

export const TOL_MM = 1e-7;
export const TOL_RAD = 1e-9;

export type SimStatus = 'ok' | 'locked' | 'diverged';

export interface BoundRow {
  type: 'motor' | 'friction' | 'damper' | 'limitLo' | 'limitHi' | 'cam' | 'floorN' | 'floorT';
  key: string;
  bi: number; bj: number;
  J: Float64Array; // 6
  /** desired row velocity */
  target: number;
  lo: number; hi: number;
  /** compliance added to the diagonal */
  gamma: number;
  /** geometric gap for unilateral rows (mm or rad) */
  gap: number;
  /** index of the normal row this friction row belongs to */
  normal: number;
  mu: number;
  /** impulse solution */
  lambda: number;
  ref: string; // joint id or part id
}

export interface ContactState { key: string; partId: string; x: number; y: number; fn: number; ft: number; slipSpeed: number; gap: number }
export interface CamState { jointId: string; gap: number; force: number; pressureAngle: number; inContact: boolean }

export interface FailureInfo {
  status: SimStatus;
  reason: string;
  /** rows with the largest residual: joint ids + value */
  worst: { jointId: string; label: string; value: number; unit: string }[];
  time: number;
}

export function motorSpeed(spec: MotorSpec, t: number): number {
  const ramp = Math.max(spec.rampTime, 0);
  const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  if (spec.profile === 'reversing' && spec.period && spec.period > 0) {
    const k = Math.floor(t / spec.period);
    const tau = t - k * spec.period;
    const sign = k % 2 === 0 ? 1 : -1;
    const prev = k === 0 ? 0 : -sign;
    const r = ramp > 0 ? smooth(tau / ramp) : 1;
    return spec.speed * (prev + (sign - prev) * r);
  }
  return spec.speed * (ramp > 0 ? smooth(t / ramp) : 1);
}

interface Scratch { c: number; s: number }

export class Simulation {
  readonly model: MechModel;
  readonly nb: number;
  readonly n: number;
  h: number;
  q: Float64Array;
  v: Float64Array;
  t = 0;
  stepCount = 0;
  status: SimStatus = 'ok';
  failure: FailureInfo | null = null;

  readonly invM: Float64Array;
  readonly massV: Float64Array;

  // bilateral rows
  readonly mB: number;
  readonly rowBi: Int32Array;
  readonly rowBj: Int32Array;
  readonly rowTol: Float64Array;
  private J: Float64Array;
  private C: Float64Array;
  private S: Float64Array;
  private E: Float64Array;
  private inc: Int32Array[]; // per body: [row, slot, row, slot, ...]
  private psi: Float64Array; // unwrapped line-of-centres angle per con
  private psiTry: Float64Array;

  readonly idealMotors: MotorDef[];
  readonly limitedMotors: MotorDef[];
  /** prescribed coordinate value of each ideal motor */
  motorTarget: Float64Array;
  private motorTargetNext: Float64Array;
  private camBilateral: boolean;

  // outputs of the last committed step
  /** constraint force per bilateral row (force units; mN, mN·mm) */
  lambda: Float64Array;
  /** actuator effort per motor joint id (torque mN·mm or force mN) */
  motorEffort = new Map<string, number>();
  motorSaturated = new Map<string, boolean>();
  contacts: ContactState[] = [];
  camStates: CamState[] = [];
  limitActive = new Map<string, number>();
  /** acceleration of body coordinates over the last step: (v⁺ − v)/h */
  accel: Float64Array;

  // statistics
  stats = {
    /** max joint position error before the projection of the last step (mm) */
    driftBefore: 0,
    /** max joint position error after projection (mm) */
    posError: 0,
    angError: 0,
    maxPosError: 0,
    projIterations: 0,
    minPivot: 1,
    /** bilateral row with the smallest pivot in the last factorisation */
    minPivotRow: -1,
    deficientRows: 0,
    pgsIterations: 0,
    boundedRows: 0,
    stepMs: 0,
    totalMs: 0,
  };
  /** rows flagged dependent at the initial configuration (structural redundancy) */
  readonly structuralDeficient: Set<number>;
  deficientNow: number[] = [];
  warm = new Map<string, number>();

  // work arrays
  private f: Float64Array;
  private vstar: Float64Array;
  private qTry: Float64Array;
  private rhs: Float64Array;
  private mu: Float64Array;
  private tmpB: Float64Array;
  private corr: Float64Array;
  private Jtmp = new Float64Array(6);
  /** S currently holds the factorisation at the committed state (kinematic stepping) */
  private kinFactorValid = false;
  private vNew: Float64Array;
  private qBefore: Float64Array;
  private dqW: Float64Array;

  constructor(model: MechModel, dt: number) {
    this.model = model;
    this.h = dt;
    const nb = (this.nb = model.bodies.length);
    this.n = 3 * nb;
    this.q = new Float64Array(this.n);
    this.v = new Float64Array(this.n);
    this.accel = new Float64Array(this.n);
    this.invM = new Float64Array(this.n);
    this.massV = new Float64Array(this.n);
    for (let b = 0; b < nb; b++) {
      const B = model.bodies[b];
      this.q[3 * b] = B.x0; this.q[3 * b + 1] = B.y0; this.q[3 * b + 2] = 0;
      this.massV[3 * b] = B.mass; this.massV[3 * b + 1] = B.mass; this.massV[3 * b + 2] = B.inertia;
      this.invM[3 * b] = 1 / B.mass; this.invM[3 * b + 1] = 1 / B.mass; this.invM[3 * b + 2] = 1 / B.inertia;
    }
    this.idealMotors = model.motors.filter((m) => m.ideal);
    this.limitedMotors = model.motors.filter((m) => !m.ideal);
    this.camBilateral = model.mode !== 'dynamic';
    const nCam = this.camBilateral ? model.cams.length : 0;
    const mB = (this.mB = model.nRows + this.idealMotors.length + nCam);
    this.rowBi = new Int32Array(mB);
    this.rowBj = new Int32Array(mB);
    this.rowTol = new Float64Array(mB);
    for (const c of model.cons) {
      const rows = c.kind === 'rev' || c.kind === 'pris' ? 2 : c.kind === 'weld' ? 3 : 1;
      for (let k = 0; k < rows; k++) { this.rowBi[c.row + k] = c.bi; this.rowBj[c.row + k] = c.bj; }
    }
    for (let r = 0; r < model.nRows; r++) this.rowTol[r] = model.rowInfo[r].unit === 'rad' ? TOL_RAD : TOL_MM;
    this.idealMotors.forEach((m, k) => {
      const r = model.nRows + k;
      this.rowBi[r] = m.coord.bi; this.rowBj[r] = m.coord.bj;
      this.rowTol[r] = m.coord.kind === 'rev' ? TOL_RAD : TOL_MM;
    });
    if (this.camBilateral) model.cams.forEach((c, k) => {
      const r = model.nRows + this.idealMotors.length + k;
      this.rowBi[r] = c.followerBody; this.rowBj[r] = c.camBody; this.rowTol[r] = TOL_MM;
    });
    this.J = new Float64Array(6 * mB);
    this.C = new Float64Array(mB);
    this.S = new Float64Array(mB * mB);
    this.E = new Float64Array(mB);
    this.lambda = new Float64Array(mB);
    const incL: number[][] = Array.from({ length: nb }, () => []);
    for (let r = 0; r < mB; r++) {
      if (this.rowBi[r] >= 0) incL[this.rowBi[r]].push(r, 0);
      if (this.rowBj[r] >= 0) incL[this.rowBj[r]].push(r, 1);
    }
    this.inc = incL.map((l) => Int32Array.from(l));
    this.psi = new Float64Array(model.cons.length);
    this.psiTry = new Float64Array(model.cons.length);
    model.cons.forEach((c, i) => {
      if (c.kind === 'gear') {
        const a = this.pt(this.q, c.bi, c.ca[0], c.ca[1]), b = this.pt(this.q, c.bj, c.cb[0], c.cb[1]);
        this.psi[i] = Math.atan2(b[1] - a[1], b[0] - a[0]);
      }
    });
    this.motorTarget = new Float64Array(this.idealMotors.length);
    this.motorTargetNext = new Float64Array(this.idealMotors.length);
    this.idealMotors.forEach((m, k) => { this.motorTarget[k] = this.coordValue(m.coord, this.q); });
    this.f = new Float64Array(this.n);
    this.vstar = new Float64Array(this.n);
    this.qTry = new Float64Array(this.n);
    this.rhs = new Float64Array(mB);
    this.mu = new Float64Array(mB);
    this.tmpB = new Float64Array(mB);
    this.corr = new Float64Array(mB);
    this.vNew = new Float64Array(this.n);
    this.qBefore = new Float64Array(this.n);
    this.dqW = new Float64Array(this.n);

    // structural redundancy at the initial configuration
    this.structuralDeficient = new Set();
    if (mB > 0) {
      this.motorTargetNext.set(this.motorTarget);
      this.evalBilateral(this.q, true, this.psi, null);
      const info = this.assembleAndFactor();
      for (const d of info.deficient) this.structuralDeficient.add(d);
      this.deficientNow = info.deficient;
      this.stats.minPivot = info.minPivot;
      this.stats.deficientRows = info.deficient.length;
      let e = 0, a = 0;
      for (let r = 0; r < mB; r++) {
        if (this.rowTol[r] === TOL_RAD) a = Math.max(a, Math.abs(this.C[r])); else e = Math.max(e, Math.abs(this.C[r]));
      }
      this.stats.posError = e; this.stats.angError = a;
    }
  }

  // ------------------------------------------------------------ geometry helpers

  /** world position of a body-local point */
  pt(q: Float64Array, b: number, lx: number, ly: number): [number, number] {
    if (b < 0) return [lx, ly];
    const a = q[3 * b + 2];
    const c = Math.cos(a), s = Math.sin(a);
    return [q[3 * b] + c * lx - s * ly, q[3 * b + 1] + s * lx + c * ly];
  }

  /** world velocity of a body-local point */
  ptVel(q: Float64Array, v: Float64Array, b: number, lx: number, ly: number): [number, number] {
    if (b < 0) return [0, 0];
    const a = q[3 * b + 2];
    const c = Math.cos(a), s = Math.sin(a);
    const rx = c * lx - s * ly, ry = s * lx + c * ly;
    const w = v[3 * b + 2];
    return [v[3 * b] - w * ry, v[3 * b + 1] + w * rx];
  }

  coordValue(c: CoordDef, q: Float64Array): number {
    const ti = c.bi >= 0 ? q[3 * c.bi + 2] : 0, tj = c.bj >= 0 ? q[3 * c.bj + 2] : 0;
    if (c.kind === 'rev') return tj - ti - c.zero;
    const ci = Math.cos(ti), si = Math.sin(ti);
    const ax = ci * c.axis[0] - si * c.axis[1], ay = si * c.axis[0] + ci * c.axis[1];
    const a = this.pt(q, c.bi, c.ri[0], c.ri[1]), b = this.pt(q, c.bj, c.rj[0], c.rj[1]);
    return ax * (b[0] - a[0]) + ay * (b[1] - a[1]) - c.zero;
  }

  /** Jacobian row of a joint coordinate into out[0..5] */
  coordRow(c: CoordDef, q: Float64Array, out: Float64Array, o = 0): void {
    if (c.kind === 'rev') {
      out[o] = 0; out[o + 1] = 0; out[o + 2] = -1; out[o + 3] = 0; out[o + 4] = 0; out[o + 5] = 1;
      return;
    }
    const ti = c.bi >= 0 ? q[3 * c.bi + 2] : 0, tj = c.bj >= 0 ? q[3 * c.bj + 2] : 0;
    const ci = Math.cos(ti), si = Math.sin(ti), cj = Math.cos(tj), sj = Math.sin(tj);
    const ax = ci * c.axis[0] - si * c.axis[1], ay = si * c.axis[0] + ci * c.axis[1];
    const rix = ci * c.ri[0] - si * c.ri[1], riy = si * c.ri[0] + ci * c.ri[1];
    const rjx = cj * c.rj[0] - sj * c.rj[1], rjy = sj * c.rj[0] + cj * c.rj[1];
    const pix = c.bi >= 0 ? q[3 * c.bi] : 0, piy = c.bi >= 0 ? q[3 * c.bi + 1] : 0;
    const pjx = c.bj >= 0 ? q[3 * c.bj] : 0, pjy = c.bj >= 0 ? q[3 * c.bj + 1] : 0;
    const dx = pjx + rjx - pix - rix, dy = pjy + rjy - piy - riy;
    out[o] = -ax; out[o + 1] = -ay; out[o + 2] = -((rix + dx) * ay - (riy + dy) * ax);
    out[o + 3] = ax; out[o + 4] = ay; out[o + 5] = rjx * ay - rjy * ax;
  }

  coordRate(c: CoordDef, q: Float64Array, v: Float64Array): number {
    this.coordRow(c, q, this.Jtmp);
    return this.rowDot(this.Jtmp, 0, c.bi, c.bj, v);
  }

  private rowDot(J: Float64Array, o: number, bi: number, bj: number, v: Float64Array): number {
    let s = 0;
    if (bi >= 0) s += J[o] * v[3 * bi] + J[o + 1] * v[3 * bi + 1] + J[o + 2] * v[3 * bi + 2];
    if (bj >= 0) s += J[o + 3] * v[3 * bj] + J[o + 4] * v[3 * bj + 1] + J[o + 5] * v[3 * bj + 2];
    return s;
  }

  /** cam gap (normal distance roller surface ↔ cam surface) and contact row; returns normalised gap */
  camRow(cam: CamDef, q: Float64Array, out: Float64Array | null, o = 0): { gap: number; nx: number; ny: number; phi: number; rho: number } {
    const cb = cam.camBody, fb = cam.followerBody;
    const cc = this.pt(q, cb, cam.camCenter[0], cam.camCenter[1]);
    const cr = this.pt(q, fb, cam.roller[0], cam.roller[1]);
    const th = (cb >= 0 ? q[3 * cb + 2] : 0) + cam.camAngle;
    const c = Math.cos(th), s = Math.sin(th);
    const dx = cr[0] - cc[0], dy = cr[1] - cc[1];
    // roller centre in the cam part frame
    const ux = c * dx + s * dy, uy = -s * dx + c * dy;
    const rho = Math.hypot(ux, uy) || 1e-12;
    const phi = Math.atan2(uy, ux);
    const pc = camPitch(cam.params, phi);
    const extra = cam.rollerR - cam.params.rollerRadius;
    const g = rho - (pc.r + extra);
    const cp = ux / rho, sp = uy / rho;
    // ∇g in cam frame
    const gx = cp + (pc.dr / rho) * sp, gy = sp - (pc.dr / rho) * cp;
    const gl = Math.hypot(gx, gy) || 1;
    // world normal
    const nx = (c * gx - s * gy) / gl, ny = (s * gx + c * gy) / gl;
    if (out) {
      // follower block (slot 0 = follower), cam block (slot 1 = cam)
      const fp = fb >= 0 ? [q[3 * fb], q[3 * fb + 1]] : [0, 0];
      const rfx = cr[0] - fp[0], rfy = cr[1] - fp[1];
      out[o] = nx; out[o + 1] = ny; out[o + 2] = rfx * ny - rfy * nx;
      const cpos = cb >= 0 ? [q[3 * cb], q[3 * cb + 1]] : [0, 0];
      const rcx = cr[0] - cpos[0], rcy = cr[1] - cpos[1];
      out[o + 3] = -nx; out[o + 4] = -ny; out[o + 5] = -(rcx * ny - rcy * nx);
    }
    return { gap: g / gl, nx, ny, phi, rho };
  }

  // ------------------------------------------------------------ bilateral rows

  private evalBilateral(q: Float64Array, withJ: boolean, psiRef: Float64Array, psiOut: Float64Array | null): void {
    const { model } = this;
    const J = this.J, C = this.C;
    const cons = model.cons;
    for (let ci = 0; ci < cons.length; ci++) {
      const con: Con = cons[ci];
      const bi = con.bi, bj = con.bj;
      const xi = bi >= 0 ? q[3 * bi] : 0, yi = bi >= 0 ? q[3 * bi + 1] : 0, ti = bi >= 0 ? q[3 * bi + 2] : 0;
      const xj = bj >= 0 ? q[3 * bj] : 0, yj = bj >= 0 ? q[3 * bj + 1] : 0, tj = bj >= 0 ? q[3 * bj + 2] : 0;
      const cI = Math.cos(ti), sI = Math.sin(ti), cJ = Math.cos(tj), sJ = Math.sin(tj);
      const r = con.row;
      const o = 6 * r;
      switch (con.kind) {
        case 'rev':
        case 'weld': {
          const rix = cI * con.ri[0] - sI * con.ri[1], riy = sI * con.ri[0] + cI * con.ri[1];
          const rjx = cJ * con.rj[0] - sJ * con.rj[1], rjy = sJ * con.rj[0] + cJ * con.rj[1];
          C[r] = xj + rjx - xi - rix;
          C[r + 1] = yj + rjy - yi - riy;
          if (withJ) {
            J[o] = -1; J[o + 1] = 0; J[o + 2] = riy; J[o + 3] = 1; J[o + 4] = 0; J[o + 5] = -rjy;
            J[o + 6] = 0; J[o + 7] = -1; J[o + 8] = -rix; J[o + 9] = 0; J[o + 10] = 1; J[o + 11] = rjx;
          }
          if (con.kind === 'weld') {
            C[r + 2] = tj - ti - con.ang0;
            if (withJ) { J[o + 12] = 0; J[o + 13] = 0; J[o + 14] = -1; J[o + 15] = 0; J[o + 16] = 0; J[o + 17] = 1; }
          }
          break;
        }
        case 'pris': {
          const rix = cI * con.ri[0] - sI * con.ri[1], riy = sI * con.ri[0] + cI * con.ri[1];
          const rjx = cJ * con.rj[0] - sJ * con.rj[1], rjy = sJ * con.rj[0] + cJ * con.rj[1];
          const ax = cI * con.axis[0] - sI * con.axis[1], ay = sI * con.axis[0] + cI * con.axis[1];
          const nx = -ay, ny = ax;
          const dx = xj + rjx - xi - rix, dy = yj + rjy - yi - riy;
          C[r] = nx * dx + ny * dy;
          C[r + 1] = tj - ti - con.ang0;
          if (withJ) {
            J[o] = -nx; J[o + 1] = -ny; J[o + 2] = -((rix + dx) * ny - (riy + dy) * nx);
            J[o + 3] = nx; J[o + 4] = ny; J[o + 5] = rjx * ny - rjy * nx;
            J[o + 6] = 0; J[o + 7] = 0; J[o + 8] = -1; J[o + 9] = 0; J[o + 10] = 0; J[o + 11] = 1;
          }
          break;
        }
        case 'gear': {
          const cax = cI * con.ca[0] - sI * con.ca[1], cay = sI * con.ca[0] + cI * con.ca[1];
          const cbx = cJ * con.cb[0] - sJ * con.cb[1], cby = sJ * con.cb[0] + cJ * con.cb[1];
          const dx = xj + cbx - xi - cax, dy = yj + cby - yi - cay;
          const d2 = dx * dx + dy * dy || 1e-18;
          let psi = Math.atan2(dy, dx);
          psi += 2 * Math.PI * Math.round((psiRef[ci] - psi) / (2 * Math.PI));
          if (psiOut) psiOut[ci] = psi;
          const k = con.ra + con.sigma * con.rb;
          C[r] = con.ra * (ti + con.offA - psi) + con.sigma * con.rb * (tj + con.offB - psi) - con.c0;
          if (withJ) {
            const gx = -dy / d2, gy = dx / d2;
            J[o] = k * gx; J[o + 1] = k * gy; J[o + 2] = con.ra + k * (-gx * cay + gy * cax);
            J[o + 3] = -k * gx; J[o + 4] = -k * gy; J[o + 5] = con.sigma * con.rb - k * (-gx * cby + gy * cbx);
          }
          break;
        }
        case 'rack': {
          // i = pinion, j = rack
          const cpx = cI * con.cp[0] - sI * con.cp[1], cpy = sI * con.cp[0] + cI * con.cp[1];
          const ox = cJ * con.o[0] - sJ * con.o[1], oy = sJ * con.o[0] + cJ * con.o[1];
          const ax = cJ * con.axis[0] - sJ * con.axis[1], ay = sJ * con.axis[0] + cJ * con.axis[1];
          const dx = xi + cpx - xj - ox, dy = yi + cpy - yj - oy;
          const s = ax * dx + ay * dy;
          C[r] = s - con.sigma * con.r * (ti + con.offP - tj - con.offR) - con.c0;
          if (withJ) {
            J[o] = ax; J[o + 1] = ay; J[o + 2] = -ax * cpy + ay * cpx - con.sigma * con.r;
            J[o + 3] = -ax; J[o + 4] = -ay; J[o + 5] = -(-ax * oy + ay * ox) + (-ay * dx + ax * dy) + con.sigma * con.r;
          }
          break;
        }
      }
    }
    // ideal motors: coordinate − target
    let r = this.model.nRows;
    for (let k = 0; k < this.idealMotors.length; k++, r++) {
      const m = this.idealMotors[k];
      C[r] = this.coordValue(m.coord, q) - this.motorTargetNext[k];
      if (withJ) this.coordRow(m.coord, q, J, 6 * r);
    }
    if (this.camBilateral) {
      for (const cam of this.model.cams) {
        const g = this.camRow(cam, q, withJ ? J : null, 6 * r);
        C[r] = g.gap;
        r++;
      }
    }
  }

  private assembleAndFactor(): { deficient: number[]; minPivot: number; minIndex: number } {
    const m = this.mB, S = this.S, J = this.J, E = this.E, w = this.invM;
    S.fill(0);
    for (let b = 0; b < this.nb; b++) {
      const list = this.inc[b];
      const w0 = w[3 * b], w1 = w[3 * b + 1], w2 = w[3 * b + 2];
      for (let a = 0; a < list.length; a += 2) {
        const ra = list[a], oa = 6 * ra + 3 * list[a + 1];
        const a0 = J[oa] * w0, a1 = J[oa + 1] * w1, a2 = J[oa + 2] * w2;
        for (let c = a; c < list.length; c += 2) {
          const rc = list[c], oc = 6 * rc + 3 * list[c + 1];
          const val = a0 * J[oc] + a1 * J[oc + 1] + a2 * J[oc + 2];
          S[ra * m + rc] += val;
          if (ra !== rc) S[rc * m + ra] += val;
        }
      }
    }
    for (let i = 0; i < m; i++) {
      const d = S[i * m + i];
      E[i] = d > 1e-300 ? 1 / Math.sqrt(d) : 0;
    }
    for (let i = 0; i < m; i++) {
      const ei = E[i];
      for (let j = 0; j <= i; j++) S[i * m + j] *= ei * E[j];
    }
    const info = choleskyFactor(S, m, 1e-10);
    return { deficient: info.deficient, minPivot: m ? info.minPivot : 1, minIndex: info.minIndex };
  }

  /** solve S x = b in place using the current factorisation */
  private solveS(b: Float64Array): void {
    const m = this.mB, E = this.E;
    for (let i = 0; i < m; i++) b[i] *= E[i];
    choleskySolve(this.S, m, b);
    for (let i = 0; i < m; i++) b[i] *= E[i];
  }

  /** out += M⁻¹ Jᵀ x  (x per bilateral row) scaled by `k` */
  private addMinvJt(x: Float64Array, k: number, out: Float64Array): void {
    const J = this.J, w = this.invM;
    for (let r = 0; r < this.mB; r++) {
      const xr = x[r] * k;
      if (xr === 0) continue;
      const bi = this.rowBi[r], bj = this.rowBj[r], o = 6 * r;
      if (bi >= 0) { out[3 * bi] += w[3 * bi] * J[o] * xr; out[3 * bi + 1] += w[3 * bi + 1] * J[o + 1] * xr; out[3 * bi + 2] += w[3 * bi + 2] * J[o + 2] * xr; }
      if (bj >= 0) { out[3 * bj] += w[3 * bj] * J[o + 3] * xr; out[3 * bj + 1] += w[3 * bj + 1] * J[o + 4] * xr; out[3 * bj + 2] += w[3 * bj + 2] * J[o + 5] * xr; }
    }
  }

  private residual(): { pos: number; ang: number; ok: boolean; norm: number } {
    let pos = 0, ang = 0, ok = true, norm = 0;
    for (let r = 0; r < this.mB; r++) {
      const a = Math.abs(this.C[r]);
      if (this.rowTol[r] === TOL_RAD) { if (a > ang) ang = a; } else if (a > pos) pos = a;
      const rel = a / this.rowTol[r];
      if (rel > 1) ok = false;
      if (rel > norm) norm = rel;
    }
    return { pos, ang, ok, norm };
  }

  private worstRows(n = 3): FailureInfo['worst'] {
    const idx = Array.from({ length: this.mB }, (_, i) => i).sort((a, b) => Math.abs(this.C[b]) / this.rowTol[b] - Math.abs(this.C[a]) / this.rowTol[a]);
    const out: FailureInfo['worst'] = [];
    const seen = new Set<string>();
    for (const r of idx) {
      const info = this.rowJoint(r);
      if (seen.has(info.jointId)) continue;
      seen.add(info.jointId);
      out.push({ ...info, value: this.C[r] });
      if (out.length >= n) break;
    }
    return out;
  }

  rowJoint(r: number): { jointId: string; label: string; unit: string } {
    const { model } = this;
    if (r < model.nRows) return model.rowInfo[r];
    const k = r - model.nRows;
    if (k < this.idealMotors.length) return { jointId: this.idealMotors[k].jointId, label: 'motor', unit: this.idealMotors[k].coord.kind === 'rev' ? 'rad' : 'mm' };
    return { jointId: model.cams[k - this.idealMotors.length].jointId, label: 'cam contact', unit: 'mm' };
  }

  // ------------------------------------------------------------ forces

  private computeForces(q: Float64Array, v: Float64Array, t: number, f: Float64Array): void {
    const { model } = this;
    f.fill(0);
    const gx = model.gravity.x, gy = model.gravity.y;
    for (let b = 0; b < this.nb; b++) { const m = model.bodies[b].mass; f[3 * b] += m * gx; f[3 * b + 1] += m * gy; }
    for (const s of model.springs) {
      const a = this.pt(q, s.pa.body, s.pa.x, s.pa.y), b = this.pt(q, s.pb.body, s.pb.x, s.pb.y);
      const va = this.ptVel(q, v, s.pa.body, s.pa.x, s.pa.y), vb = this.ptVel(q, v, s.pb.body, s.pb.x, s.pb.y);
      let dx = b[0] - a[0], dy = b[1] - a[1];
      const L = Math.hypot(dx, dy);
      if (L > 1e-9) { dx /= L; dy /= L; } else { dx = 1; dy = 0; }
      const rate = dx * (vb[0] - va[0]) + dy * (vb[1] - va[1]);
      const F = s.k * (L - s.L0) + s.c * rate; // tension positive
      this.applyForce(q, f, s.pa.body, a, F * dx, F * dy);
      this.applyForce(q, f, s.pb.body, b, -F * dx, -F * dy);
    }
    for (const l of model.loads) {
      if (t < l.tStart || t >= l.tEnd) continue;
      const b = l.p.body;
      let fx = l.fx, fy = l.fy;
      if (l.frame === 'part') {
        const a = q[3 * b + 2] + l.la;
        const c = Math.cos(a), s = Math.sin(a);
        fx = c * l.fx - s * l.fy; fy = s * l.fx + c * l.fy;
      }
      const p = this.pt(q, b, l.p.x, l.p.y);
      this.applyForce(q, f, b, p, fx, fy);
      f[3 * b + 2] += l.torque;
    }
  }

  private applyForce(q: Float64Array, f: Float64Array, b: number, p: [number, number], fx: number, fy: number): void {
    if (b < 0) return;
    f[3 * b] += fx; f[3 * b + 1] += fy;
    f[3 * b + 2] += (p[0] - q[3 * b]) * fy - (p[1] - q[3 * b + 1]) * fx;
  }

  springForce(jointId: string): { tension: number; length: number } | null {
    const s = this.model.springs.find((x) => x.jointId === jointId);
    if (!s) return null;
    const a = this.pt(this.q, s.pa.body, s.pa.x, s.pa.y), b = this.pt(this.q, s.pb.body, s.pb.x, s.pb.y);
    const va = this.ptVel(this.q, this.v, s.pa.body, s.pa.x, s.pa.y), vb = this.ptVel(this.q, this.v, s.pb.body, s.pb.x, s.pb.y);
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy);
    if (L > 1e-9) { dx /= L; dy /= L; }
    const rate = dx * (vb[0] - va[0]) + dy * (vb[1] - va[1]);
    return { tension: s.k * (L - s.L0) + s.c * rate, length: L };
  }

  // ------------------------------------------------------------ bounded rows

  private buildBoundedRows(q: Float64Array, vstar: Float64Array, t: number): BoundRow[] {
    const { model } = this;
    const h = this.h;
    const rows: BoundRow[] = [];
    const mk = (type: BoundRow['type'], key: string, bi: number, bj: number, ref: string): BoundRow => ({
      type, key, bi, bj, J: new Float64Array(6), target: 0, lo: -Infinity, hi: Infinity, gamma: 0, gap: 0, normal: -1, mu: 0, lambda: this.warm.get(key) ?? 0, ref,
    });
    for (const m of this.limitedMotors) {
      const row = mk('motor', `motor:${m.jointId}`, m.coord.bi, m.coord.bj, m.jointId);
      this.coordRow(m.coord, q, row.J);
      const sp = motorSpeed(m.spec, t + h);
      const lim = Math.max(m.spec.maxTorque ?? 0, 0) * h;
      row.target = sp; row.lo = -lim; row.hi = lim;
      if (m.spec.type === 'dc') {
        const nl = Math.max(Math.abs(m.spec.speed), 1e-9);
        row.gamma = nl / Math.max(lim, 1e-12);
      }
      rows.push(row);
    }
    for (const fr of model.frictions) {
      const row = mk('friction', `fric:${fr.jointId}`, fr.coord.bi, fr.coord.bj, fr.jointId);
      this.coordRow(fr.coord, q, row.J);
      row.lo = -fr.limit * h; row.hi = fr.limit * h;
      rows.push(row);
    }
    for (const d of model.dampers) {
      const row = mk('damper', `damp:${d.jointId}`, d.coord.bi, d.coord.bj, d.jointId);
      this.coordRow(d.coord, q, row.J);
      row.gamma = 1 / (h * d.c);
      rows.push(row);
    }
    for (const l of model.limits) {
      const val = this.coordValue(l.coord, q);
      const lo = mk('limitLo', `limLo:${l.jointId}`, l.coord.bi, l.coord.bj, l.jointId);
      this.coordRow(l.coord, q, lo.J);
      lo.gap = val - l.lower; lo.target = -Math.max(lo.gap, 0) / h; lo.lo = 0;
      rows.push(lo);
      const hi = mk('limitHi', `limHi:${l.jointId}`, l.coord.bi, l.coord.bj, l.jointId);
      this.coordRow(l.coord, q, hi.J);
      for (let k = 0; k < 6; k++) hi.J[k] = -hi.J[k];
      hi.gap = l.upper - val; hi.target = -Math.max(hi.gap, 0) / h; hi.lo = 0;
      rows.push(hi);
    }
    if (!this.camBilateral) {
      for (const cam of model.cams) {
        const row = mk('cam', `cam:${cam.jointId}`, cam.followerBody, cam.camBody, cam.jointId);
        const g = this.camRow(cam, q, row.J);
        row.gap = g.gap;
        const w0 = this.rowDot(row.J, 0, row.bi, row.bj, vstar);
        if (g.gap > 0.5 && g.gap + 2 * h * w0 > 0.25) { this.warm.delete(row.key); continue; }
        row.target = -Math.max(g.gap, 0) / h; row.lo = 0;
        rows.push(row);
      }
    }
    if (model.floorEnabled) {
      const fy = model.floorY;
      for (const fc of model.floorContacts) {
        const b = fc.body;
        const a = q[3 * b + 2];
        const c = Math.cos(a), s = Math.sin(a);
        const rx = c * fc.x - s * fc.y, ry = s * fc.x + c * fc.y;
        const gap = q[3 * b + 1] + ry - fc.r - fy;
        if (gap > 0.5) {
          const vn = vstar[3 * b + 1] + vstar[3 * b + 2] * rx;
          if (gap + 2 * h * vn > 0.25) { this.warm.delete(`fn:${fc.key}`); this.warm.delete(`ft:${fc.key}`); continue; }
        }
        // contact point lever arm (bottom of the circle)
        const lx = rx, ly = ry - fc.r;
        const nrow = mk('floorN', `fn:${fc.key}`, b, -1, fc.partId);
        nrow.J[0] = 0; nrow.J[1] = 1; nrow.J[2] = lx;
        nrow.gap = gap; nrow.target = -Math.max(gap, 0) / h; nrow.lo = 0;
        const ni = rows.length;
        rows.push(nrow);
        const trow = mk('floorT', `ft:${fc.key}`, b, -1, fc.partId);
        trow.J[0] = 1; trow.J[1] = 0; trow.J[2] = -ly;
        trow.normal = ni; trow.mu = fc.mu; trow.lo = 0; trow.hi = 0;
        rows.push(trow);
      }
    }
    return rows;
  }

  /** B = J_b M⁻¹ J_uᵀ for one bounded row */
  private couple(row: BoundRow, out: Float64Array): void {
    out.fill(0);
    const J = this.J, w = this.invM;
    for (let slot = 0; slot < 2; slot++) {
      const b = slot === 0 ? row.bi : row.bj;
      if (b < 0) continue;
      const u0 = row.J[3 * slot] * w[3 * b], u1 = row.J[3 * slot + 1] * w[3 * b + 1], u2 = row.J[3 * slot + 2] * w[3 * b + 2];
      const list = this.inc[b];
      for (let a = 0; a < list.length; a += 2) {
        const o = 6 * list[a] + 3 * list[a + 1];
        out[list[a]] += J[o] * u0 + J[o + 1] * u1 + J[o + 2] * u2;
      }
    }
  }

  private rowRow(a: BoundRow, b: BoundRow): number {
    const w = this.invM;
    let s = 0;
    for (let sa = 0; sa < 2; sa++) {
      const ba = sa === 0 ? a.bi : a.bj;
      if (ba < 0) continue;
      for (let sb = 0; sb < 2; sb++) {
        const bb = sb === 0 ? b.bi : b.bj;
        if (bb !== ba) continue;
        s += a.J[3 * sa] * w[3 * ba] * b.J[3 * sb] + a.J[3 * sa + 1] * w[3 * ba + 1] * b.J[3 * sb + 1] + a.J[3 * sa + 2] * w[3 * ba + 2] * b.J[3 * sb + 2];
      }
    }
    return s;
  }

  // ------------------------------------------------------------ stepping

  step(): boolean {
    if (this.status !== 'ok') return false;
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const ok = this.model.mode === 'dynamic' ? this.stepDynamic() : this.stepKinematic();
    const dtm = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    this.stats.stepMs = dtm; this.stats.totalMs += dtm;
    return ok;
  }

  private fail(status: SimStatus, reason: string): boolean {
    this.status = status;
    this.failure = { status, reason, worst: this.worstRows(), time: this.t };
    return false;
  }

  private advanceTargets(): void {
    const h = this.h;
    for (let k = 0; k < this.idealMotors.length; k++) {
      this.motorTargetNext[k] = this.motorTarget[k] + h * motorSpeed(this.idealMotors[k].spec, this.t + h / 2);
    }
  }

  private stepDynamic(): boolean {
    const h = this.h, n = this.n, mB = this.mB;
    const q = this.q, v = this.v, vstar = this.vstar, f = this.f, w = this.invM;
    this.computeForces(q, v, this.t, f);
    // Velocities live at half steps (leap-frog). The very first kick is a half step so that a start
    // from rest is second-order accurate instead of carrying an O(h) phase offset.
    const hk = this.stepCount === 0 ? h / 2 : h;
    for (let i = 0; i < n; i++) vstar[i] = v[i] + hk * w[i] * f[i];

    this.advanceTargets();
    this.evalBilateral(q, true, this.psi, null);
    let info = { deficient: [] as number[], minPivot: 1, minIndex: -1 };
    const mu = this.mu, rhs = this.rhs;
    if (mB > 0) {
      info = this.assembleAndFactor();
      for (let r = 0; r < mB; r++) {
        rhs[r] = -this.C[r] / h - this.rowDot(this.J, 6 * r, this.rowBi[r], this.rowBj[r], vstar);
      }
      mu.set(rhs);
      this.solveS(mu);
    }

    // ---- bounded rows on the Schur complement
    const rows = this.buildBoundedRows(q, vstar, this.t);
    const nu = rows.length;
    let Y: Float64Array[] = [];
    let Bm: Float64Array[] = [];
    let D: Float64Array | null = null;
    if (nu > 0) {
      D = new Float64Array(nu * nu);
      const cvec = new Float64Array(nu);
      if (mB > 0) {
        for (let u = 0; u < nu; u++) {
          const B = new Float64Array(mB);
          this.couple(rows[u], B);
          const y = new Float64Array(B);
          this.solveS(y);
          Bm.push(B); Y.push(y);
        }
      }
      for (let a = 0; a < nu; a++) {
        for (let b = a; b < nu; b++) {
          let val = this.rowRow(rows[a], rows[b]);
          if (mB > 0) { const Ba = Bm[a], Yb = Y[b]; let s = 0; for (let r = 0; r < mB; r++) s += Ba[r] * Yb[r]; val -= s; }
          D[a * nu + b] = val; D[b * nu + a] = val;
        }
        let c = this.rowDot(rows[a].J, 0, rows[a].bi, rows[a].bj, vstar) - rows[a].target;
        if (mB > 0) { const Ba = Bm[a]; let s = 0; for (let r = 0; r < mB; r++) s += Ba[r] * mu[r]; c += s; }
        cvec[a] = c;
      }
      this.stats.pgsIterations = solveBoxLCP(D, cvec, rows, nu);
      if (mB > 0) {
        for (let u = 0; u < nu; u++) {
          const l = rows[u].lambda;
          if (l === 0) continue;
          const y = Y[u];
          for (let r = 0; r < mB; r++) mu[r] -= y[r] * l;
        }
      }
    }
    this.stats.boundedRows = nu;

    // ---- new velocity
    const vn = this.qTry; // reuse as temp for v⁺ then positions
    const vnew = this.vNew;
    vnew.set(vstar);
    if (mB > 0) this.addMinvJt(mu, 1, vnew);
    for (const row of rows) {
      const l = row.lambda;
      if (l === 0) continue;
      if (row.bi >= 0) { const b = row.bi; vnew[3 * b] += w[3 * b] * row.J[0] * l; vnew[3 * b + 1] += w[3 * b + 1] * row.J[1] * l; vnew[3 * b + 2] += w[3 * b + 2] * row.J[2] * l; }
      if (row.bj >= 0) { const b = row.bj; vnew[3 * b] += w[3 * b] * row.J[3] * l; vnew[3 * b + 1] += w[3 * b + 1] * row.J[4] * l; vnew[3 * b + 2] += w[3 * b + 2] * row.J[5] * l; }
    }
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(vnew[i])) return this.fail('diverged', 'Velocities became non-finite (numerical divergence).');
      vn[i] = q[i] + h * vnew[i];
    }

    // ---- SHAKE projection onto joint constraints
    const corr = this.corr;
    corr.fill(0);
    let iters = 0;
    let res = { pos: 0, ang: 0, ok: true, norm: 0 };
    if (mB > 0) {
      this.psiTry.set(this.psi);
      this.evalBilateral(vn, false, this.psi, this.psiTry);
      res = this.residual();
      this.stats.driftBefore = res.pos;
      const qBefore = this.qBefore;
      qBefore.set(vn);
      let prevNorm = res.norm;
      let stale = true;
      const tmp = this.tmpB;
      while (!res.ok && iters < 40) {
        iters++;
        if (!stale) {
          this.evalBilateral(vn, true, this.psi, this.psiTry);
          this.assembleAndFactor();
        }
        tmp.set(this.C);
        this.solveS(tmp);
        // limit the correction size (a huge correction means the constraints cannot be met)
        const dq = this.dqW;
        dq.fill(0);
        this.addMinvJt(tmp, -1, dq);
        let big = 0;
        for (let b = 0; b < this.nb; b++) big = Math.max(big, Math.abs(dq[3 * b + 2]) * 4, Math.abs(dq[3 * b]) / 25, Math.abs(dq[3 * b + 1]) / 25);
        const sc = big > 1 ? 1 / big : 1;
        for (let i = 0; i < n; i++) vn[i] += sc * dq[i];
        if (stale) for (let r = 0; r < mB; r++) corr[r] -= (sc * tmp[r]) / h;
        this.evalBilateral(vn, false, this.psi, this.psiTry);
        res = this.residual();
        if (stale && (res.norm > 0.5 * prevNorm) && iters >= 2) stale = false; // slow convergence: switch to full Newton
        prevNorm = res.norm;
      }
      if (!res.ok) {
        const worst = this.worstRows();
        this.status = 'locked';
        this.failure = {
          status: 'locked',
          reason: 'The joint constraints could not be satisfied after this step (position solve did not converge).',
          worst, time: this.t,
        };
        return false;
      }
      for (let i = 0; i < n; i++) vnew[i] += (vn[i] - qBefore[i]) / h;
      this.stats.projIterations = iters;
    }

    // ---- unilateral position correction (penetration), position only
    if (nu > 0 && D) this.correctPenetration(rows, D, Y, vn);

    // ---- commit
    for (let i = 0; i < n; i++) {
      this.accel[i] = (vnew[i] - v[i]) / h;
      v[i] = vnew[i];
      q[i] = vn[i];
      if (!Number.isFinite(q[i]) || Math.abs(v[i]) > 1e9) return this.fail('diverged', 'State became non-finite or velocities exceeded 10⁹ (numerical divergence).');
    }
    if (mB > 0) this.psi.set(this.psiTry);
    this.motorTarget.set(this.motorTargetNext);
    this.t += h;
    this.stepCount++;
    for (let r = 0; r < mB; r++) this.lambda[r] = (mu[r] + corr[r]) / h;
    this.stats.posError = res.pos; this.stats.angError = res.ang;
    this.stats.maxPosError = Math.max(this.stats.maxPosError, res.pos);
    this.stats.minPivot = info.minPivot;
    this.stats.minPivotRow = info.minIndex;
    this.stats.deficientRows = info.deficient.length;
    this.deficientNow = info.deficient;
    this.collectOutputs(rows);
    return true;
  }

  private correctPenetration(rows: BoundRow[], D: Float64Array, Y: Float64Array[], qn: Float64Array): void {
    const nu = rows.length, h = this.h, w = this.invM;
    // gaps at the new position
    const idx: number[] = [];
    const gaps: number[] = [];
    const slop = 1e-4;
    let any = false;
    for (let u = 0; u < nu; u++) {
      const row = rows[u];
      let gap = Infinity;
      if (row.type === 'floorN') {
        const fc = this.floorByKey.get(row.key)!;
        const b = fc.body, a = qn[3 * b + 2];
        gap = qn[3 * b + 1] + Math.sin(a) * fc.x + Math.cos(a) * fc.y - fc.r - this.model.floorY;
      } else if (row.type === 'cam') {
        const cam = this.model.cams.find((c) => c.jointId === row.ref)!;
        gap = this.camRow(cam, qn, null).gap;
      } else if (row.type === 'limitLo' || row.type === 'limitHi') {
        const l = this.model.limits.find((x) => x.jointId === row.ref)!;
        const val = this.coordValue(l.coord, qn);
        gap = row.type === 'limitLo' ? val - l.lower : l.upper - val;
      } else continue;
      idx.push(u); gaps.push(gap);
      if (gap < -slop) any = true;
    }
    if (!any) return;
    const k = idx.length;
    const lam = new Float64Array(k);
    for (let it = 0; it < 60; it++) {
      let change = 0;
      for (let a = 0; a < k; a++) {
        const ua = idx[a];
        let wv = (gaps[a] + slop) / h;
        for (let b = 0; b < k; b++) wv += D[ua * nu + idx[b]] * lam[b];
        const d = D[ua * nu + ua] + 1e-14;
        const nl = Math.max(0, lam[a] - wv / d);
        change = Math.max(change, Math.abs(nl - lam[a]) * d);
        lam[a] = nl;
      }
      if (change < 1e-9) break;
    }
    const x = this.tmpB;
    x.fill(0);
    for (let a = 0; a < k; a++) {
      const l = lam[a];
      if (l === 0) continue;
      const row = rows[idx[a]];
      if (row.bi >= 0) { const b = row.bi; qn[3 * b] += h * w[3 * b] * row.J[0] * l; qn[3 * b + 1] += h * w[3 * b + 1] * row.J[1] * l; qn[3 * b + 2] += h * w[3 * b + 2] * row.J[2] * l; }
      if (row.bj >= 0) { const b = row.bj; qn[3 * b] += h * w[3 * b] * row.J[3] * l; qn[3 * b + 1] += h * w[3 * b + 1] * row.J[4] * l; qn[3 * b + 2] += h * w[3 * b + 2] * row.J[5] * l; }
      if (this.mB > 0) { const y = Y[idx[a]]; for (let r = 0; r < this.mB; r++) x[r] -= y[r] * l; }
    }
    if (this.mB > 0) this.addMinvJt(x, h, qn);
  }

  private _floorByKey: Map<string, FloorContactDef> | null = null;
  private get floorByKey(): Map<string, FloorContactDef> {
    if (!this._floorByKey) {
      this._floorByKey = new Map();
      for (const fc of this.model.floorContacts) this._floorByKey.set(`fn:${fc.key}`, fc);
    }
    return this._floorByKey;
  }

  private collectOutputs(rows: BoundRow[]): void {
    const h = this.h;
    this.motorEffort.clear(); this.motorSaturated.clear(); this.limitActive.clear();
    this.contacts = []; this.camStates = [];
    this.warm.clear();
    this.idealMotors.forEach((m, k) => {
      this.motorEffort.set(m.jointId, this.lambda[this.model.nRows + k]);
      this.motorSaturated.set(m.jointId, false);
    });
    for (let u = 0; u < rows.length; u++) {
      const row = rows[u];
      if (row.lambda !== 0) this.warm.set(row.key, row.lambda);
      const force = row.lambda / h;
      switch (row.type) {
        case 'motor':
          this.motorEffort.set(row.ref, force);
          // servo: at the torque limit. DC curve: within 5 % of stall torque (i.e. the rotor is nearly stopped or driven backwards)
          this.motorSaturated.set(row.ref, row.hi > 0 && (row.gamma === 0
            ? (row.lambda >= row.hi * (1 - 1e-9) || row.lambda <= row.lo * (1 - 1e-9))
            : Math.abs(row.lambda) >= 0.95 * row.hi));
          break;
        case 'limitLo': if (row.lambda > 0) this.limitActive.set(row.ref, -force); break;
        case 'limitHi': if (row.lambda > 0) this.limitActive.set(row.ref, force); break;
        case 'floorN': {
          const fc = this.floorByKey.get(row.key)!;
          const t = rows[u + 1];
          const p = this.pt(this.q, fc.body, fc.x, fc.y);
          const b = fc.body;
          const lx = p[0] - this.q[3 * b], ly = p[1] - fc.r - this.q[3 * b + 1];
          const slip = this.v[3 * b] - this.v[3 * b + 2] * ly;
          void lx;
          if (row.lambda > 0 || row.gap < 1e-3) {
            this.contacts.push({ key: fc.key, partId: fc.partId, x: p[0], y: p[1] - fc.r, fn: force, ft: t ? t.lambda / h : 0, slipSpeed: slip, gap: row.gap });
          }
          break;
        }
        default: break;
      }
    }
    if (!this.camBilateral) {
      for (const cam of this.model.cams) {
        const row = rows.find((r) => r.type === 'cam' && r.ref === cam.jointId);
        this.camStates.push(this.camStateOf(cam, row ? row.lambda / h : 0));
      }
    }
  }

  private camStateOf(cam: CamDef, force: number): CamState {
    const g = this.camRow(cam, this.q, null);
    // pressure angle: between contact normal and the follower's velocity direction of the roller centre
    let pa = NaN;
    const fb = cam.followerBody;
    const vr = this.ptVel(this.q, this.v, fb, cam.roller[0], cam.roller[1]);
    const coordDir = this.followerDirection(cam);
    if (coordDir) pa = Math.acos(Math.min(1, Math.abs(coordDir[0] * g.nx + coordDir[1] * g.ny)));
    else { const sp = Math.hypot(vr[0], vr[1]); if (sp > 1e-6) pa = Math.acos(Math.min(1, Math.abs((vr[0] * g.nx + vr[1] * g.ny) / sp))); }
    return { jointId: cam.jointId, gap: g.gap, force, pressureAngle: pa, inContact: this.camBilateral ? true : force > 0 || g.gap < 1e-3 };
  }

  /** direction in which the roller centre is free to move (prismatic guide axis or tangent of an arm) */
  private followerDirection(cam: CamDef): [number, number] | null {
    for (const c of this.model.coords.values()) {
      if (c.kind === 'pris' && (c.bj === cam.followerBody || c.bi === cam.followerBody)) {
        const ti = c.bi >= 0 ? this.q[3 * c.bi + 2] : 0;
        return [Math.cos(ti) * c.axis[0] - Math.sin(ti) * c.axis[1], Math.sin(ti) * c.axis[0] + Math.cos(ti) * c.axis[1]];
      }
    }
    for (const c of this.model.coords.values()) {
      if (c.kind === 'rev' && (c.bj === cam.followerBody || c.bi === cam.followerBody)) {
        const loc = c.bj === cam.followerBody ? c.rj : c.ri;
        const piv = this.pt(this.q, cam.followerBody, loc[0], loc[1]);
        const r = this.pt(this.q, cam.followerBody, cam.roller[0], cam.roller[1]);
        const dx = r[0] - piv[0], dy = r[1] - piv[1];
        const L = Math.hypot(dx, dy);
        if (L > 1e-9) return [-dy / L, dx / L];
      }
    }
    return null;
  }

  private stepKinematic(): boolean {
    const n = this.n, mB = this.mB, h = this.h;
    this.advanceTargets();
    const qt = this.qTry;
    qt.set(this.q);
    let res = { pos: 0, ang: 0, ok: true, norm: 0 };
    let iters = 0;
    if (mB > 0) {
      this.psiTry.set(this.psi);
      this.evalBilateral(qt, true, this.psi, this.psiTry);
      res = this.residual();
      this.stats.driftBefore = res.pos;
      const tmp = this.tmpB;
      const dq = this.dqW;
      // Modified Newton: the first iterations reuse the Jacobian and factorisation of the last
      // committed step (cheap); if convergence is slow, switch to full Newton with a fresh Jacobian.
      this.evalBilateral(this.q, true, this.psi, null);
      this.evalBilateral(qt, false, this.psi, this.psiTry);
      let stale = this.kinFactorValid;
      let prevNorm = res.norm;
      while (!res.ok && iters < 50) {
        iters++;
        if (!stale) { this.evalBilateral(qt, true, this.psi, this.psiTry); this.assembleAndFactor(); }
        tmp.set(this.C);
        this.solveS(tmp);
        dq.fill(0);
        this.addMinvJt(tmp, -1, dq);
        let big = 0;
        for (let b = 0; b < this.nb; b++) big = Math.max(big, Math.abs(dq[3 * b + 2]) * 4, Math.abs(dq[3 * b]) / 25, Math.abs(dq[3 * b + 1]) / 25);
        const sc = big > 1 ? 1 / big : 1;
        for (let i = 0; i < n; i++) qt[i] += sc * dq[i];
        this.evalBilateral(qt, false, this.psi, this.psiTry);
        res = this.residual();
        if (stale && (iters >= 6 || res.norm > 0.3 * prevNorm)) stale = false;
        prevNorm = res.norm;
      }
      this.kinFactorValid = false;
      if (!res.ok) {
        const worst = this.worstRows();
        this.status = 'locked';
        this.failure = { status: 'locked', reason: 'No assembled position exists for the commanded motor position (kinematic position solve did not converge).', worst, time: this.t };
        // leave J/C consistent with the committed state
        this.motorTargetNext.set(this.motorTarget);
        this.evalBilateral(this.q, true, this.psi, null);
        this.assembleAndFactor();
        return false;
      }
      // velocities: J v = −∂C/∂t (only motor rows are time dependent)
      this.evalBilateral(qt, true, this.psi, this.psiTry);
      const info = this.assembleAndFactor();
      this.kinFactorValid = true;
      this.rhs.fill(0);
      for (let k = 0; k < this.idealMotors.length; k++) this.rhs[this.model.nRows + k] = motorSpeed(this.idealMotors[k].spec, this.t + h);
      this.solveS(this.rhs);
      const vnew = new Float64Array(n);
      this.addMinvJt(this.rhs, 1, vnew);
      for (let i = 0; i < n; i++) { this.accel[i] = (vnew[i] - this.v[i]) / h; this.v[i] = vnew[i]; }
      this.stats.minPivot = info.minPivot;
      this.stats.minPivotRow = info.minIndex;
      this.stats.deficientRows = info.deficient.length;
      this.deficientNow = info.deficient;
      this.psi.set(this.psiTry);
    }
    this.q.set(qt);
    this.motorTarget.set(this.motorTargetNext);
    this.t += h;
    this.stepCount++;
    this.stats.projIterations = iters;
    this.stats.posError = res.pos; this.stats.angError = res.ang;
    this.stats.maxPosError = Math.max(this.stats.maxPosError, res.pos);
    this.camStates = this.model.cams.map((c) => this.camStateOf(c, NaN));
    return true;
  }

  // ------------------------------------------------------------ analysis

  /** Dense Jacobian of the bilateral rows at the current state (rows × 3·bodies). */
  denseJacobian(includeMotors = true, includeCams = true): { J: Float64Array; rows: number[]; m: number; n: number } {
    this.motorTargetNext.set(this.motorTarget);
    this.evalBilateral(this.q, true, this.psi, null);
    const rows: number[] = [];
    for (let r = 0; r < this.mB; r++) {
      const k = r - this.model.nRows;
      if (k >= 0 && k < this.idealMotors.length && !includeMotors) continue;
      if (k >= this.idealMotors.length && !includeCams) continue;
      rows.push(r);
    }
    const m = rows.length, n = this.n;
    const D = new Float64Array(m * n);
    rows.forEach((r, i) => {
      const bi = this.rowBi[r], bj = this.rowBj[r];
      if (bi >= 0) for (let k = 0; k < 3; k++) D[i * n + 3 * bi + k] = this.J[6 * r + k];
      if (bj >= 0) for (let k = 0; k < 3; k++) D[i * n + 3 * bj + k] = this.J[6 * r + 3 + k];
    });
    return { J: D, rows, m, n };
  }

  /** Degrees of freedom by Jacobian rank at the current configuration. */
  mobility(): { dof: number; dofDriven: number; rank: number; redundantRows: number[]; rows: number } {
    const n = this.n;
    // scale rotation columns by a characteristic length so rank tolerances are meaningful
    const scaleCols = (D: Float64Array, m: number) => {
      for (let b = 0; b < this.nb; b++) {
        const L = Math.sqrt(this.model.bodies[b].inertia / this.model.bodies[b].mass) || 1;
        for (let i = 0; i < m; i++) D[i * n + 3 * b + 2] /= L;
      }
    };
    const a = this.denseJacobian(false, true);
    scaleCols(a.J, a.m);
    const ra = a.m && n ? rankReveal(a.J, a.m, n, 1e-7) : { rank: 0, dependentRows: [] as number[] };
    const b = this.denseJacobian(true, true);
    scaleCols(b.J, b.m);
    const rb = b.m && n ? rankReveal(b.J, b.m, n, 1e-7) : { rank: 0, dependentRows: [] as number[] };
    return {
      dof: n - ra.rank,
      dofDriven: n - rb.rank,
      rank: rb.rank,
      redundantRows: rb.dependentRows.map((i) => b.rows[i]),
      rows: b.m,
    };
  }

  kineticEnergy(): number {
    let e = 0;
    for (let i = 0; i < this.n; i++) e += 0.5 * this.massV[i] * this.v[i] * this.v[i];
    return e;
  }

  potentialEnergy(): number {
    let e = 0;
    const g = this.model.gravity;
    for (let b = 0; b < this.nb; b++) e -= this.model.bodies[b].mass * (g.x * this.q[3 * b] + g.y * this.q[3 * b + 1]);
    for (const s of this.model.springs) {
      const a = this.pt(this.q, s.pa.body, s.pa.x, s.pa.y), b = this.pt(this.q, s.pb.body, s.pb.x, s.pb.y);
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      e += 0.5 * s.k * (L - s.L0) ** 2;
    }
    return e;
  }

  /** residual of the joint constraints at the current state (mm / rad) */
  constraintError(): { pos: number; ang: number } {
    if (this.mB === 0) return { pos: 0, ang: 0 };
    this.motorTargetNext.set(this.motorTarget);
    this.evalBilateral(this.q, false, this.psi, null);
    const r = this.residual();
    return { pos: r.pos, ang: r.ang };
  }

  /** per-row residuals at the current state */
  rowResiduals(): { jointId: string; label: string; unit: string; value: number }[] {
    if (this.mB === 0) return [];
    this.motorTargetNext.set(this.motorTarget);
    this.evalBilateral(this.q, false, this.psi, null);
    return Array.from({ length: this.mB }, (_, r) => ({ ...this.rowJoint(r), value: this.C[r] }));
  }

  /**
   * Newton projection of the CURRENT state onto the constraints with minimal
   * mass-weighted movement (used for design-time assembly). Optional soft
   * drag targets pull body points toward world positions.
   */
  projectToConstraints(maxIter = 60, drag?: { body: number; lx: number; ly: number; tx: number; ty: number; weight: number }): { ok: boolean; iterations: number; pos: number; ang: number } {
    const n = this.n, mB = this.mB;
    const q = this.q;
    let res = { pos: 0, ang: 0, ok: true, norm: 0 };
    let iters = 0;
    this.motorTargetNext.set(this.motorTarget);
    const dq = new Float64Array(n);
    const newton = (limit: number) => {
      if (mB === 0) return;
      for (let k = 0; k < limit; k++) {
        this.evalBilateral(q, true, this.psi, this.psiTry);
        this.psi.set(this.psiTry);
        res = this.residual();
        if (res.ok) return;
        iters++;
        this.assembleAndFactor();
        const tmp = this.tmpB;
        tmp.set(this.C);
        this.solveS(tmp);
        dq.fill(0);
        this.addMinvJt(tmp, -1, dq);
        let big = 0;
        for (let b = 0; b < this.nb; b++) big = Math.max(big, Math.abs(dq[3 * b + 2]) * 2.5, Math.abs(dq[3 * b]) / 40, Math.abs(dq[3 * b + 1]) / 40);
        const sc = big > 1 ? 1 / big : 1;
        for (let i = 0; i < n; i++) q[i] += sc * dq[i];
      }
      this.evalBilateral(q, true, this.psi, this.psiTry);
      this.psi.set(this.psiTry);
      res = this.residual();
    };
    if (drag && drag.body >= 0) {
      for (let k = 0; k < 8; k++) {
        // soft pull: move the grabbed body so the point approaches the target, then re-project
        const b = drag.body;
        const p = this.pt(q, b, drag.lx, drag.ly);
        const ex = drag.tx - p[0], ey = drag.ty - p[1];
        if (Math.hypot(ex, ey) < 1e-6) break;
        const rx = p[0] - q[3 * b], ry = p[1] - q[3 * b + 1];
        const w0 = this.invM[3 * b], w2 = this.invM[3 * b + 2];
        const a11 = w0 + w2 * ry * ry, a12 = -w2 * rx * ry, a22 = w0 + w2 * rx * rx;
        const det = a11 * a22 - a12 * a12 || 1e-300;
        const lx = (a22 * ex - a12 * ey) / det, ly = (-a12 * ex + a11 * ey) / det;
        const g = drag.weight;
        q[3 * b] += g * w0 * lx; q[3 * b + 1] += g * w0 * ly; q[3 * b + 2] += g * w2 * (rx * ly - ry * lx);
        newton(6);
      }
    }
    newton(maxIter);
    this.stats.posError = res.pos; this.stats.angError = res.ang;
    return { ok: res.ok, iterations: iters, pos: res.pos, ang: res.ang };
  }
}

/**
 * Projected Gauss–Seidel for the boxed LCP  w = Dλ + c,  lo ≤ λ ≤ hi,
 * with Coulomb friction rows bounded by ±μ·λ_normal. Returns iterations used.
 */
export function solveBoxLCP(D: Float64Array, c: Float64Array, rows: BoundRow[], nu: number): number {
  const lam = new Float64Array(nu);
  for (let i = 0; i < nu; i++) {
    const r = rows[i];
    let l = r.lambda;
    if (r.normal >= 0) { const lim = r.mu * Math.max(lam[r.normal], 0); l = Math.max(-lim, Math.min(lim, l)); }
    else l = Math.max(r.lo, Math.min(r.hi, l));
    lam[i] = Number.isFinite(l) ? l : 0;
  }
  let it = 0;
  const CAP = 1e15;
  for (; it < 300; it++) {
    let change = 0;
    for (let i = 0; i < nu; i++) {
      const r = rows[i];
      const dii = D[i * nu + i] + r.gamma;
      const d = dii > 1e-14 ? dii : 1e-14;
      let wv = c[i] + r.gamma * lam[i];
      const o = i * nu;
      for (let j = 0; j < nu; j++) wv += D[o + j] * lam[j];
      let nl = lam[i] - wv / d;
      let lo = r.lo, hi = r.hi;
      if (r.normal >= 0) { const lim = r.mu * Math.max(lam[r.normal], 0); lo = -lim; hi = lim; }
      if (nl < lo) nl = lo; else if (nl > hi) nl = hi;
      if (nl > CAP) nl = CAP; else if (nl < -CAP) nl = -CAP;
      const dl = Math.abs(nl - lam[i]) * d;
      if (dl > change) change = dl;
      lam[i] = nl;
    }
    if (change < 1e-10) { it++; break; }
  }
  for (let i = 0; i < nu; i++) rows[i].lambda = lam[i];
  return it;
}
