/**
 * Small dense linear algebra used by the multibody and sketch solvers.
 * Matrices are row-major Float64Array of size n*n (or m*n).
 */

export interface CholeskyInfo {
  /** indices whose pivot fell below tolerance (dependent rows) */
  deficient: number[];
  minPivot: number;
  maxPivot: number;
  /** row index of the smallest accepted pivot (-1 if none) */
  minIndex: number;
}

/**
 * In-place Cholesky factorisation A = L Lᵀ of a symmetric positive
 * SEMI-definite matrix (lower triangle used / written).
 *
 * Rows whose pivot falls below `tol * maxDiag` are treated as linearly
 * dependent: the row/column of L is zeroed and flagged so that the matching
 * multiplier is solved as exactly 0. This is how redundant constraints are
 * handled deliberately rather than by blowing up.
 */
export function choleskyFactor(A: Float64Array, n: number, tol = 1e-11, skip?: Uint8Array): CholeskyInfo {
  let maxDiag = 0;
  for (let i = 0; i < n; i++) maxDiag = Math.max(maxDiag, Math.abs(A[i * n + i]));
  const thresh = Math.max(maxDiag * tol, 1e-300);
  const deficient: number[] = [];
  let minPivot = Infinity, maxPivot = 0, minIndex = -1;
  for (let j = 0; j < n; j++) {
    const rj = j * n;
    let d = A[rj + j];
    for (let k = 0; k < j; k++) { const l = A[rj + k]; d -= l * l; }
    if (d <= thresh) {
      // dependent row
      deficient.push(j);
      if (skip) skip[j] = 1;
      A[rj + j] = 0;
      for (let i = j + 1; i < n; i++) A[i * n + j] = 0;
      for (let k = 0; k < j; k++) A[rj + k] = 0;
      continue;
    }
    if (skip) skip[j] = 0;
    const ljj = Math.sqrt(d);
    if (d < minPivot) { minPivot = d; minIndex = j; }
    if (d > maxPivot) maxPivot = d;
    A[rj + j] = ljj;
    const inv = 1 / ljj;
    for (let i = j + 1; i < n; i++) {
      const ri = i * n;
      let s = A[ri + j];
      for (let k = 0; k < j; k++) s -= A[ri + k] * A[rj + k];
      A[ri + j] = s * inv;
    }
  }
  return { deficient, minPivot: minPivot === Infinity ? 0 : minPivot, maxPivot, minIndex };
}

/** Solve L Lᵀ x = b in place (b → x). Deficient rows (L_ii == 0) give x_i = 0. */
export function choleskySolve(L: Float64Array, n: number, b: Float64Array): void {
  for (let i = 0; i < n; i++) {
    const ri = i * n;
    const d = L[ri + i];
    if (d === 0) { b[i] = 0; continue; }
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[ri + k] * b[k];
    b[i] = s / d;
  }
  for (let i = n - 1; i >= 0; i--) {
    const d = L[i * n + i];
    if (d === 0) { b[i] = 0; continue; }
    let s = b[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * b[k];
    b[i] = s / d;
  }
}

export interface RankInfo {
  rank: number;
  /** row indices (of the original matrix) chosen as independent, in pivot order */
  independentRows: number[];
  /** row indices found dependent on the independent set */
  dependentRows: number[];
  /** column indices used as pivots */
  pivotCols: number[];
  /** magnitude of pivots, in order */
  pivots: number[];
}

/**
 * Rank-revealing Gaussian elimination with full pivoting on an m×n matrix.
 * `rowScale` optionally pre-normalises rows. Does not modify the input.
 */
export function rankReveal(Ain: Float64Array, m: number, n: number, tol = 1e-9): RankInfo {
  const A = new Float64Array(Ain);
  const rowIdx = new Int32Array(m);
  const colIdx = new Int32Array(n);
  for (let i = 0; i < m; i++) rowIdx[i] = i;
  for (let j = 0; j < n; j++) colIdx[j] = j;
  // normalise rows so tolerance is relative per constraint
  for (let i = 0; i < m; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s = Math.max(s, Math.abs(A[i * n + j]));
    if (s > 0) for (let j = 0; j < n; j++) A[i * n + j] /= s;
  }
  const pivots: number[] = [];
  let rank = 0;
  const lim = Math.min(m, n);
  for (let k = 0; k < lim; k++) {
    let best = 0, bi = -1, bj = -1;
    for (let i = k; i < m; i++) {
      for (let j = k; j < n; j++) {
        const v = Math.abs(A[i * n + j]);
        if (v > best) { best = v; bi = i; bj = j; }
      }
    }
    if (best <= tol) break;
    if (bi !== k) {
      for (let j = 0; j < n; j++) { const t = A[k * n + j]; A[k * n + j] = A[bi * n + j]; A[bi * n + j] = t; }
      const t = rowIdx[k]; rowIdx[k] = rowIdx[bi]; rowIdx[bi] = t;
    }
    if (bj !== k) {
      for (let i = 0; i < m; i++) { const t = A[i * n + k]; A[i * n + k] = A[i * n + bj]; A[i * n + bj] = t; }
      const t = colIdx[k]; colIdx[k] = colIdx[bj]; colIdx[bj] = t;
    }
    const p = A[k * n + k];
    pivots.push(Math.abs(p));
    for (let i = k + 1; i < m; i++) {
      const f = A[i * n + k] / p;
      if (f === 0) continue;
      for (let j = k; j < n; j++) A[i * n + j] -= f * A[k * n + j];
    }
    rank++;
  }
  return {
    rank,
    independentRows: Array.from(rowIdx.slice(0, rank)),
    dependentRows: Array.from(rowIdx.slice(rank)),
    pivotCols: Array.from(colIdx.slice(0, rank)),
    pivots,
  };
}

/** Solve a general n×n system by LU with partial pivoting. Returns null if singular. */
export function luSolve(Ain: Float64Array, bin: Float64Array, n: number): Float64Array | null {
  const A = new Float64Array(Ain);
  const b = new Float64Array(bin);
  for (let k = 0; k < n; k++) {
    let p = k, best = Math.abs(A[k * n + k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(A[i * n + k]);
      if (v > best) { best = v; p = i; }
    }
    if (best < 1e-300) return null;
    if (p !== k) {
      for (let j = 0; j < n; j++) { const t = A[k * n + j]; A[k * n + j] = A[p * n + j]; A[p * n + j] = t; }
      const t = b[k]; b[k] = b[p]; b[p] = t;
    }
    const piv = A[k * n + k];
    for (let i = k + 1; i < n; i++) {
      const f = A[i * n + k] / piv;
      if (f === 0) continue;
      for (let j = k; j < n; j++) A[i * n + j] -= f * A[k * n + j];
      b[i] -= f * b[k];
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= A[i * n + j] * b[j];
    b[i] = s / A[i * n + i];
  }
  return b;
}

/**
 * Singular values (and optionally right singular vectors) of an m×n matrix by
 * one-sided Jacobi. Intended for small diagnostic problems.
 */
export function svd(Ain: Float64Array, m: number, n: number): { s: Float64Array; V: Float64Array } {
  // work on columns of A (m×n). V is n×n.
  const A = new Float64Array(Ain);
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        let alpha = 0, beta = 0, gamma = 0;
        for (let i = 0; i < m; i++) {
          const ap = A[i * n + p], aq = A[i * n + q];
          alpha += ap * ap; beta += aq * aq; gamma += ap * aq;
        }
        if (Math.abs(gamma) <= 1e-15 * Math.sqrt(alpha * beta) || gamma === 0) continue;
        off = Math.max(off, Math.abs(gamma) / Math.sqrt(alpha * beta + 1e-300));
        const zeta = (beta - alpha) / (2 * gamma);
        const t = Math.sign(zeta || 1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
        const c = 1 / Math.sqrt(1 + t * t), s = c * t;
        for (let i = 0; i < m; i++) {
          const ap = A[i * n + p], aq = A[i * n + q];
          A[i * n + p] = c * ap - s * aq;
          A[i * n + q] = s * ap + c * aq;
        }
        for (let i = 0; i < n; i++) {
          const vp = V[i * n + p], vq = V[i * n + q];
          V[i * n + p] = c * vp - s * vq;
          V[i * n + q] = s * vp + c * vq;
        }
      }
    }
    if (off < 1e-13) break;
  }
  const s = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    let sum = 0;
    for (let i = 0; i < m; i++) sum += A[i * n + j] * A[i * n + j];
    s[j] = Math.sqrt(sum);
  }
  return { s, V };
}
