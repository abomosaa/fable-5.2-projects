/**
 * One motor + propeller.
 *
 * Aerodynamics: blade-element / momentum theory (BEMT) for a rotor in general
 * flight (axial + edgewise flow).
 *
 *   C_T = (sigma a / 6) * [ theta (1 + 3/2 mu^2) - 3/2 lambda ]        (blade element)
 *   T   = 2 rho A v_i sqrt(V_p^2 + (V_c + v_i)^2)                      (Glauert momentum)
 *   C_Q = C_T (kappa lambda_i + lambda_c) + sigma c_d / 8 (1 + 4.6 mu^2)
 *
 * with lambda = (V_c + v_i) / (Omega R) the inflow ratio and mu = V_p / (Omega R)
 * the advance ratio. The induced velocity v_i is a dynamic state (first-order
 * dynamic inflow) relaxing to the momentum-theory value; in descent, where
 * momentum theory has no solution (vortex ring state), the empirical fit of
 * Leishman is used and unsteady thrust loss/fluctuation is added.
 *
 * What falls out of this without any special-casing:
 *   - thrust falls off with airspeed along the thrust axis (pitch speed limit)
 *   - translational lift (less induced power in forward flight)
 *   - rotor drag linear in speed (H-force), rate damping from differential inflow
 *   - windmilling / prop unloading in dives, extra thrust when "catching" a fall
 *   - prop wash wobble when descending through your own wake
 *
 * Motor: brushless DC machine, steady-state (q-axis) equivalent of the phasor model
 *
 *   V = E + (R + jX) I      with X = L_eff * omega (phase reactance at electrical frequency)
 *
 * For an ESC with fixed commutation timing the torque-producing current is
 *
 *   I   = (duty * V_bus - K_e * omega) / Z,     Z = R + X^2 / R
 *   tau = K_t * I - tau_loss(omega)
 *   P_bus = K_e omega I + Z I^2  ( = duty * V_bus * I )
 *
 * The reactive part of the phase current makes no torque but still heats the
 * windings, which is why the whole of Z appears as a loss. It is also why a
 * loaded motor reaches only ~65-70 % of KV * V, at ~65 % efficiency, in reality.
 * With the bridge shorted (duty 0) nothing flows back to the battery: braking
 * energy is burnt in the windings; at part duty the ESC regenerates duty*V*I.
 */
import { DroneParams, DerivedParams } from './params';
import { clamp, smoothstep, Rng } from './math';

// Leishman's empirical induced-velocity fit for axial descent (vortex ring state),
// nu = v_i / v_h as a polynomial in Vc / v_h for -2 <= Vc/v_h <= 0.
const K1 = -1.125;
const K2 = -1.372;
const K3 = -1.718;
const K4 = -0.65663;

/** Normal-force coefficient of a blade broadside to the flow. */
export const PLATE_CD = 1.1;

/**
 * Normalised induced velocity nu = v_i / v_h for a rotor with normalised axial
 * velocity lc = V_c / v_h (positive = climb) and edgewise velocity mu = V_p / v_h.
 */
export function inducedVelocityRatio(lc: number, mu: number): number {
  let nuAx: number;
  if (lc >= 0) {
    nuAx = -lc / 2 + Math.sqrt((lc * lc) / 4 + 1);
  } else if (lc >= -2) {
    nuAx = 1 + lc * (K1 + lc * (K2 + lc * (K3 + lc * K4)));
  } else {
    // Windmill brake state: momentum theory valid again.
    nuAx = -lc / 2 - Math.sqrt((lc * lc) / 4 - 1);
  }
  if (lc >= 0 && mu < 1e-3) return nuAx;

  // With edgewise flow the wake is swept away and Glauert's equation applies.
  // In descent, blend from it to the vortex-ring fit: Glauert remains valid for
  // slow descents (so the two regimes meet continuously at lc = 0) and wherever
  // the edgewise flow is strong enough to flush the wake.
  let w = 1;
  if (lc < 0) {
    w = Math.max(smoothstep(0.35, 1.0, mu), 1 - smoothstep(0, 0.3, -lc));
    if (w <= 0) return nuAx;
  }
  // Newton iterations on g(nu) = nu^2 (mu^2 + (lc + nu)^2) - 1 = 0
  let nu = nuAx;
  const mu2 = mu * mu;
  for (let i = 0; i < 8; i++) {
    const s = lc + nu;
    const m = mu2 + s * s;
    const g = nu * nu * m - 1;
    const dg = 2 * nu * m + 2 * nu * nu * s;
    if (Math.abs(dg) < 1e-9) break;
    const n2 = clamp(nu - g / dg, 0.01, 3);
    const done = Math.abs(n2 - nu) < 1e-6;
    nu = n2;
    if (done) break;
  }
  return lc >= 0 ? nu : nuAx + (nu - nuAx) * w;
}

/** Soft blade stall: lift grows linearly up to alphaStall, then saturates. */
function stallClip(a: number, as: number): number {
  if (a > as) {
    return as * (1 + 0.15 * (1 - Math.exp(-(a / as - 1) / 0.15)));
  }
  // Cambered sections stall earlier at negative incidence.
  const an = -0.8 * as;
  if (a < an) {
    return an * (1 + 0.15 * (1 - Math.exp(-(a / an - 1) / 0.15)));
  }
  return a;
}

export class Rotor {
  /** Rotor speed [rad/s]; positive = normal direction of rotation. */
  omega = 0;
  /** Induced velocity at the disc [m/s]. */
  vi = 0;

  // ---- outputs of the last update -------------------------------------------------
  /** Thrust along body +Y [N]. */
  thrust = 0;
  /** In-plane (H) force components in the body frame [N]. */
  hx = 0;
  hz = 0;
  /** Aerodynamic shaft torque opposing rotation [N m]. */
  aeroTorque = 0;
  /** Net torque the stator applies to the rotor along its direction of rotation [N m]. */
  shaftTorque = 0;
  /** Phase (torque-producing) current [A]. */
  current = 0;
  /** Electrical power drawn from the DC bus [W] (negative = regenerating). */
  busPower = 0;
  /** Vortex-ring-state intensity 0..1. */
  vrs = 0;
  /** Mean blade angle of attack [rad]. */
  alpha = 0;
  /** External braking torque (e.g. blade striking an obstacle) [N m], consumed each update. */
  strikeTorque = 0;
  /** Health 0..1: fraction of thrust the (possibly chipped/bent) prop still produces. */
  health = 1;

  private noise = 0;
  private readonly R: number;
  private readonly A: number;
  private readonly sigma: number;
  private readonly ctK: number;
  private readonly kt: number;
  private readonly J: number;
  private readonly rp;
  private readonly mp;

  constructor(p: DroneParams, d: DerivedParams) {
    this.rp = p.rotor;
    this.mp = p.motor;
    this.R = p.rotor.radius;
    this.A = d.discArea;
    this.sigma = d.solidity;
    this.ctK = (d.solidity * p.rotor.liftSlope) / 6;
    this.kt = d.kt;
    this.J = d.rotorInertia;
  }

  reset(): void {
    this.omega = 0;
    this.vi = 0;
    this.thrust = 0;
    this.hx = this.hz = 0;
    this.aeroTorque = 0;
    this.shaftTorque = 0;
    this.current = 0;
    this.busPower = 0;
    this.vrs = 0;
    this.alpha = 0;
    this.noise = 0;
    this.strikeTorque = 0;
    this.health = 1;
  }

  get rpm(): number {
    return (this.omega * 30) / Math.PI;
  }

  /** Back-EMF [V] (signed). */
  backEmf(): number {
    return this.kt * this.omega;
  }

  /**
   * Effective series impedance seen by the torque-producing current at the
   * present speed [ohm]: Z = R + X^2 / R with X = reactance * |omega|.
   */
  impedance(): number {
    const x = this.mp.reactance * this.omega;
    return this.mp.resistance + (x * x) / this.mp.resistance;
  }

  /**
   * Torque-producing current for a given (signed) duty and bus voltage, including
   * the ESC current limit. Used by the bus-voltage solver and by update().
   */
  currentFor(duty: number, vbus: number): number {
    const i = (duty * vbus - this.kt * this.omega) / this.impedance();
    // The ESC limits current by cutting duty, which only works while it is
    // driving the motor. Braking current (opposite in sign to the command) is
    // set by the back-EMF across the winding impedance and cannot be limited
    // that way.
    const lim = this.mp.maxCurrent;
    if (duty >= 0) return i > lim ? lim : i;
    return i < -lim ? -lim : i;
  }

  /**
   * Advance one step.
   * @param rho     air density
   * @param duty    signed ESC duty (-1..1); negative drives the motor in reverse
   * @param vbus    DC bus voltage
   * @param driven  false = ESC outputs floating (disarmed): motor coasts
   * @param vx,vy,vz hub velocity relative to the air, body frame
   * @param ge      ground-effect factor on induced velocity (1 = out of ground effect)
   */
  update(
    dt: number,
    rho: number,
    duty: number,
    vbus: number,
    driven: boolean,
    vx: number,
    vy: number,
    vz: number,
    ge: number,
    rng: Rng,
  ): void {
    const rp = this.rp, mp = this.mp;
    const R = this.R, A = this.A;
    const w = this.omega;
    const Om = Math.abs(w);
    const dir = w >= 0 ? 1 : -1;
    const U = Om * R;
    const Vp = Math.sqrt(vx * vx + vz * vz);

    let T = 0, Q = 0, H = 0;
    let viTarget = 0;
    let vh = 0;
    this.vrs = 0;

    if (U > 1.0) {
      // A reversed prop (turtle mode) blows the other way and works badly:
      // trailing edge first, camber upside down.
      const rev = dir < 0;
      const Vc = rev ? -vy : vy;
      const mu = Math.min(Vp / U, 1.0);
      const lamC = Vc / U;
      const lamI = this.vi / U;
      const lam = lamC + lamI;
      const theta = rev ? rp.pitch * 0.62 : rp.pitch;
      const alpha = theta * (1 + 1.5 * mu * mu) - 1.5 * lam;
      this.alpha = alpha;
      let CT = this.ctK * stallClip(alpha, rp.alphaStall) * (rev ? 0.7 : 1);

      const q = rho * A * U * U;
      const T0 = q * CT;
      if (T0 > 0) {
        vh = Math.sqrt(T0 / (2 * rho * A));
        const lc = Vc / vh;
        const mub = Vp / vh;
        viTarget = inducedVelocityRatio(lc, mub) * vh * ge;

        // Vortex ring state: unsteady recirculation when descending into the wake
        // at roughly 0.4..1.6 v_h with little edgewise flow to flush it away.
        const d = -lc;
        if (d > 0.25 && mub < 1.2) {
          const a = smoothstep(0.25, 0.9, d) * (1 - smoothstep(1.15, 1.9, d));
          const b = 1 - (mub / 1.2) * (mub / 1.2);
          const I = a * b;
          this.vrs = I;
          // Band-limited thrust fluctuation, f_c ~ 0.15 v_h / R (roughly 10-25 Hz for a 5" prop).
          const fc = (0.15 * vh) / R;
          const k = 2 * Math.PI * fc;
          this.noise += -k * this.noise * dt + Math.sqrt(2 * k * dt) * rng.gauss();
          CT *= Math.max(0.2, 1 - 0.18 * I + 0.24 * I * this.noise);
        } else {
          this.noise *= 1 - Math.min(1, 20 * dt);
        }
      }
      CT *= this.health;
      T = q * CT;

      // Profile drag of the blades.
      const aC = clamp(alpha, -2 * rp.alphaStall, 2 * rp.alphaStall);
      let cd = rp.cd0 + rp.cd2 * aC * aC;
      const over = Math.abs(alpha) - rp.alphaStall;
      if (over > 0) cd += 1.2 * Math.min(over, 0.6);
      // A damaged prop is draggier for the thrust it makes.
      cd *= 1 + 1.5 * (1 - this.health);

      const CQ = CT * (rp.kappa * lamI + lamC) + ((this.sigma * cd) / 8) * (1 + 4.6 * mu * mu);
      Q = q * R * CQ;

      // In-plane force: profile drag asymmetry + tilt of the thrust vector.
      H = rho * A * U * ((this.sigma * cd) / 4) * Math.min(Vp, U) + Math.abs(T) * rp.flapK * mu;

      if (rev) T = -T;
    } else {
      this.alpha = 0;
      this.noise = 0;
    }

    // Deep stall: when the axial flow is fast compared with the blade speed
    // (stopped or idling props in a fall or a dive) the blades are just flat
    // plates broadside to the wind. Blade-element theory has nothing to say
    // there, so blend to plate drag on the blade area (sigma * A).
    const wPlate = smoothstep(0.35, 0.9, Math.abs(vy) / Math.max(U, 0.5));
    if (wPlate > 0) {
      const fPlate = -0.5 * rho * this.sigma * A * PLATE_CD * vy * Math.abs(vy);
      T = T * (1 - wPlate) + fPlate * wPlate;
    }

    // Dynamic inflow: the wake needs a finite time to adjust.
    const tau = (0.85 * R) / (2 * Math.max(vh, 2));
    this.vi += (viTarget - this.vi) * (1 - Math.exp(-dt / tau));

    this.thrust = T;
    this.aeroTorque = Q;
    if (Vp > 1e-6) {
      this.hx = (-H * vx) / Vp;
      this.hz = (-H * vz) / Vp;
    } else {
      this.hx = this.hz = 0;
    }

    // ---- motor --------------------------------------------------------------------
    const e = this.kt * w;
    let I = 0;
    if (driven) {
      I = this.currentFor(duty, vbus);
    }
    this.current = I;
    // Mechanical conversion + winding heat (active and reactive current).
    this.busPower = e * I + this.impedance() * I * I;
    if (driven) {
      const ad = Math.min(Math.abs(duty), 1);
      this.busPower += mp.pwmLoss * vbus * vbus * ad * (1 - ad);
    }
    // Iron (hysteresis + eddy) and bearing losses as a speed-dependent drag torque.
    const lossT =
      this.kt * mp.noLoadCurrent * (0.4 + (0.6 * Math.abs(e)) / mp.noLoadVoltage) * Math.tanh(w / 20);
    const shaft = this.kt * I - lossT;
    this.shaftTorque = shaft;

    let dOmega = ((shaft - Q * dir) / this.J) * dt;
    let wNew = w + dOmega;
    if (this.strikeTorque > 0) {
      // Coulomb-type brake: can stop the rotor but never reverse it.
      const dw = (this.strikeTorque / this.J) * dt;
      if (Math.abs(wNew) <= dw) wNew = 0;
      else wNew -= Math.sign(wNew) * dw;
      this.strikeTorque = 0;
    }
    this.omega = wNew;
  }
}
