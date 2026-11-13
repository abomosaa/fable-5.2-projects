// Propeller performance from blade-element / momentum theory (BEMT).
//
// For a given blade geometry we integrate the aerodynamic forces on blade sections along the
// radius, iterating on the induced axial and swirl velocities from momentum theory with a
// Prandtl tip-loss factor. The result is a table of thrust and power coefficients
//   CT = T / (rho n^2 D^4),  CP = P / (rho n^3 D^5)   as functions of
//   J  = V / (n D)   (advance ratio) and the blade pitch angle at 75 % radius.
// The table covers static thrust, climb, cruise, windmilling and reverse flow.

import { DEG, clamp } from '../core/math.js';

const A0 = 5.9;                 // section lift slope
const ALPHA0 = -2.2 * DEG;      // zero-lift angle of the cambered blade section
const STALL_P = 15 * DEG, STALL_N = -11 * DEG;
const CD0 = 0.011, CD2 = 0.011;

function polar(alpha, out) {
  let ae = alpha - ALPHA0;
  if (ae > Math.PI) ae -= 2 * Math.PI; else if (ae < -Math.PI) ae += 2 * Math.PI;
  const xp = 0.5 * (1 - Math.tanh(22 * (ae - STALL_P)));
  const xn = 0.5 * (1 + Math.tanh(22 * (ae - STALL_N)));
  const x = xp * xn;
  const clAtt = A0 * ae;
  const sn = Math.sin(ae);
  out.cl = x * clAtt + (1 - x) * 1.05 * Math.sin(2 * ae);
  out.cd = x * (CD0 + CD2 * clAtt * clAtt) + (1 - x) * (CD0 + 1.8 * sn * sn);
}

const J_MAX = 3.0, J_STEP = 0.05;
const N_J = Math.round(J_MAX / J_STEP) + 1;
const STATIONS = 16;

function solve(J, beta75, geom, out) {
  const B = geom.blades, R = 0.5, omega = 2 * Math.PI;
  const x0 = 0.2;
  const dr = (1 - x0) * R / STATIONS;
  const pol = { cl: 0, cd: 0 };
  let T = 0, Q = 0;
  const V = J;
  for (let i = 0; i < STATIONS; i++) {
    const x = x0 + (i + 0.5) * (1 - x0) / STATIONS;
    const r = x * R;
    const chord = geom.cMax * R * (1 - 1.4 * (x - 0.45) * (x - 0.45));
    const theta = Math.atan(0.75 * Math.tan(geom.designPitch) / x) + (beta75 - geom.designPitch);
    let va = 0.3, vt = 0, dT = 0, dQ = 0;
    for (let it = 0; it < 60; it++) {
      const Ua = V + va, Ut = Math.max(omega * r - vt, 1e-3);
      const W2 = Ua * Ua + Ut * Ut;
      const phi = Math.atan2(Ua, Ut);
      polar(theta - phi, pol);
      const cphi = Math.cos(phi), sphi = Math.sin(phi);
      const cn = pol.cl * cphi - pol.cd * sphi;
      const ct = pol.cl * sphi + pol.cd * cphi;
      dT = 0.5 * W2 * B * chord * cn;
      dQ = 0.5 * W2 * B * chord * ct * r;
      const f = (B / 2) * (R - r) / (r * Math.max(Math.abs(sphi), 0.02));
      const F = Math.max(0.05, (2 / Math.PI) * Math.acos(Math.min(1, Math.exp(-f))));
      const disc = V * V + dT / (Math.PI * r * F);
      const vaNew = disc >= 0 ? 0.5 * (-V + Math.sqrt(disc)) : -0.5 * V;
      const vtNew = dQ / (4 * Math.PI * r * r * F * Math.max(Math.abs(V + va), 0.3));
      va += 0.25 * (vaNew - va);
      vt += 0.25 * (clamp(vtNew, -0.5 * omega * r, 0.5 * omega * r) - vt);
    }
    T += dT * dr;
    Q += dQ * dr;
  }
  out.ct = T;              // rho = 1, n = 1, D = 1
  out.cp = 2 * Math.PI * Q;
}

/**
 * @param {object} geom {blades, cMax (max chord / radius), designPitch (rad at 75%R),
 *                       pitchMin, pitchMax (rad) for variable pitch; equal for fixed pitch}
 */
export function buildPropTable(geom) {
  const fixed = geom.pitchMax - geom.pitchMin < 1e-6;
  const nB = fixed ? 1 : Math.round((geom.pitchMax - geom.pitchMin) / (2 * DEG)) + 1;
  const ct = new Float64Array(nB * N_J), cp = new Float64Array(nB * N_J);
  const tmp = { ct: 0, cp: 0 };
  for (let b = 0; b < nB; b++) {
    const beta = fixed ? geom.pitchMin : geom.pitchMin + (geom.pitchMax - geom.pitchMin) * b / (nB - 1);
    for (let j = 0; j < N_J; j++) {
      solve(j * J_STEP, beta, geom, tmp);
      ct[b * N_J + j] = tmp.ct;
      cp[b * N_J + j] = tmp.cp;
    }
  }
  return { ct, cp, nB, fixed, pitchMin: geom.pitchMin, pitchMax: geom.pitchMax };
}

/** Bilinear lookup. Beyond J_MAX the (negative) coefficients scale with J^2 (forces ~ V^2). */
export function propLookup(tab, J, beta, out) {
  if (J < 0) J = 0;
  let scale = 1;
  if (J > J_MAX) { scale = (J / J_MAX) * (J / J_MAX); J = J_MAX; }
  const fj = J / J_STEP;
  let j0 = Math.floor(fj);
  if (j0 > N_J - 2) j0 = N_J - 2;
  const tj = fj - j0;
  let b0 = 0, tb = 0;
  if (!tab.fixed) {
    const fb = clamp((beta - tab.pitchMin) / (tab.pitchMax - tab.pitchMin), 0, 1) * (tab.nB - 1);
    b0 = Math.min(Math.floor(fb), tab.nB - 2);
    tb = fb - b0;
  }
  const i00 = b0 * N_J + j0;
  let ct = tab.ct[i00] * (1 - tj) + tab.ct[i00 + 1] * tj;
  let cp = tab.cp[i00] * (1 - tj) + tab.cp[i00 + 1] * tj;
  if (!tab.fixed) {
    const i10 = i00 + N_J;
    ct = ct * (1 - tb) + (tab.ct[i10] * (1 - tj) + tab.ct[i10 + 1] * tj) * tb;
    cp = cp * (1 - tb) + (tab.cp[i10] * (1 - tj) + tab.cp[i10 + 1] * tj) * tb;
  }
  out.ct = ct * scale;
  out.cp = cp * scale;
  return out;
}

export const PROP_J_MAX = J_MAX;
