// International Standard Atmosphere (ISA) up to 32 km.

export const RHO0 = 1.225;       // kg/m^3 sea level density
export const P0 = 101325;        // Pa
export const T0 = 288.15;        // K
const R_AIR = 287.053;
const GAMMA = 1.4;

/**
 * @param {number} h geometric altitude (m)
 * @param {object} out receives {T, p, rho, a, sigma}
 * @param {number} dT temperature offset from ISA (K)
 */
export function atmosphere(h, out, dT = 0) {
  if (h < -500) h = -500;
  let T, p;
  if (h <= 11000) {
    T = T0 - 0.0065 * h;
    p = P0 * Math.pow(T / T0, 5.255877);
  } else if (h <= 20000) {
    T = 216.65;
    p = 22632.06 * Math.exp(-(h - 11000) / 6341.62);
  } else {
    const hh = Math.min(h, 47000);
    T = 216.65 + 0.001 * (hh - 20000);
    p = 5474.889 * Math.pow(216.65 / T, 34.16319);
  }
  T += dT;
  const rho = p / (R_AIR * T);
  out.T = T;
  out.p = p;
  out.rho = rho;
  out.a = Math.sqrt(GAMMA * R_AIR * T);
  out.sigma = rho / RHO0;
  return out;
}

/** Calibrated airspeed from true airspeed, accounting for compressibility. */
export function casFromTas(tas, p, a) {
  const M = tas / a;
  // impact pressure
  const qc = p * (Math.pow(1 + 0.2 * M * M, 3.5) - 1);
  return 340.294 * Math.sqrt(5 * (Math.pow(qc / P0 + 1, 2 / 7) - 1));
}
