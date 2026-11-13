// Aerodynamic strip ("blade element") model.
//
// Every lifting surface (wing, stabiliser, fin) is cut into spanwise strips. Each strip sees
// its own local airflow (aircraft velocity + rotation + propwash + downwash + gusts), computes
// its own angle of attack and produces lift / drag / moment from a full-range (+-180 deg)
// section model with a dynamic flow-separation state. Roll damping, adverse yaw, dihedral
// effect, stall, wing drop, spins, tail authority in the slipstream ... all emerge from this
// instead of being scripted through stability derivatives.

import { Vec3, DEG, clamp } from '../core/math.js';

const PLATE_CL = 1.08;   // post-stall lift amplitude (CL = PLATE_CL * sin 2a)
const PLATE_CD = 1.85;   // flat-plate drag coefficient broadside to the flow
const SEP_SHARPNESS = 17; // 1/rad, steepness of the static separation curve

/** Control-surface effectiveness (d alpha / d delta) from thin aerofoil theory. */
export function flapEffectiveness(chordFrac) {
  const th = Math.acos(clamp(2 * chordFrac - 1, -1, 1));
  return 0.86 * (1 - (th - Math.sin(th)) / Math.PI);
}

/** Finite-wing lift-curve slope (Helmbold / DATCOM), incompressible. */
export function liftSlope3D(a0, AR, sweepHalfChord = 0) {
  const k = a0 / (2 * Math.PI);
  const t = Math.tan(sweepHalfChord);
  return (2 * Math.PI * AR) / (2 + Math.sqrt(4 + (AR / k) * (AR / k) * (1 + t * t)));
}

/** Static attached-flow fraction (1 attached .. 0 separated) for effective AoA ae. */
function sepStatic(ae, asPos, asNeg) {
  const xp = 0.5 * (1 - Math.tanh(SEP_SHARPNESS * (ae - asPos)));
  const xn = 0.5 * (1 + Math.tanh(SEP_SHARPNESS * (ae - asNeg)));
  return xp * xn;
}

/**
 * Find the separation angle (in effective-AoA space) that yields the requested CLmax for a
 * given lift slope, compensating for the rounding of the lift curve near the stall.
 */
export function calibrateStallAngle(a, clMax) {
  // lift at the stall peak: the maximum up to just past the separation angle (further out the
  // flat-plate lift of the separated wing takes over and must not be mistaken for the peak)
  const peak = (as) => {
    let m = 0;
    for (let ae = 0; ae < as + 0.1; ae += 0.004) {
      const x = 0.5 * (1 - Math.tanh(SEP_SHARPNESS * (ae - as)));
      const cl = x * a * ae + (1 - x) * PLATE_CL * Math.sin(2 * ae);
      if (cl > m) m = cl;
    }
    return m;
  };
  let lo = 0.03, hi = 1.0;
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    if (peak(mid) < clMax) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}

export class AeroSurface {
  constructor() {
    this.name = '';
    this.group = 'wing';          // wing | htail | vtail
    this.side = 0;                // -1 left, +1 right, 0 centre
    this.pos = new Vec3();        // quarter-chord point, design frame
    this.r = new Vec3();          // same, relative to the CG
    this.area = 1;
    this.chord = 1;
    this.cAxis = new Vec3(1, 0, 0); // chord line, pointing forward
    this.nAxis = new Vec3(0, 1, 0); // surface normal ("lift" direction at zero AoA)
    this.mAxis = new Vec3(0, 0, 1); // moment axis = c x n
    this.a = 5;                   // lift-curve slope (1/rad), 3D corrected, incompressible
    this.alpha0 = 0;              // zero-lift AoA (rad)
    this.asPos0 = 0.3; this.asNeg0 = -0.3;   // separation angles, flaps up
    this.asPos1 = 0.3;                        // separation angle, flaps fully down
    this.cd0 = 0.008;
    this.kInd = 0.05;             // induced drag factor 1/(pi e AR)
    this.cm0 = 0;
    // control surface (aileron / elevator / rudder)
    this.ctrlAxis = null;         // 'aileron' | 'elevator' | 'rudder' | null
    this.ctrlTau = 0;             // effectiveness * span coverage
    this.ctrlSign = 1;
    this.ctrlAllMoving = false;
    this.sweepTan = 0;            // tan(quarter-chord sweep): lift varies with spanwise flow
    this.sAxis = new Vec3(0, 0, 1); // span axis pointing outboard
    // high-lift device
    this.flapFrac = 0;            // span coverage of the flap on this strip
    this.flapDAlpha = 0;          // shift of zero-lift angle at full flap (rad, positive)
    this.flapDCd0 = 0;
    this.flapDCm = 0;
    this.spoilerFrac = 0;
    this.propwash = 0;            // fraction of the strip bathed by the propeller slipstream
    this.swirl = 0;               // sensitivity to slipstream swirl (fin)
    this.downwash = 0;            // fraction of wing downwash seen (tail surfaces)
    this.qFactor = 1;             // dynamic-pressure ratio (tail in the wing wake)
    this.sweepShift = 0;          // extra aft shift of centre of pressure at supersonic speed
    // dynamic state
    this.x = 1;                   // attached-flow fraction (lagged)
    this.xTarget = 1;
    // outputs of the last evaluation (for visuals / debugging)
    this.alpha = 0; this.cl = 0; this.q = 0; this.lift = 0;
  }
}

/**
 * Build the strips for one lifting surface definition.
 * @returns {{surfaces: AeroSurface[], area:number, span:number, mac:number, AR:number}}
 */
export function buildLiftingSurface(def) {
  const kind = def.kind;
  const strips = def.strips || 4;
  const af = def.airfoil;
  const vertical = kind === 'vtail';
  const semi = def.semiSpan;
  const cr = def.rootChord, ct = def.tipChord;
  const area = vertical ? semi * (cr + ct) / 2 : semi * (cr + ct);
  const span = vertical ? semi : 2 * semi;
  const lam = ct / cr;
  const mac = (2 / 3) * cr * (1 + lam + lam * lam) / (1 + lam);
  let AR = span * span / area;
  if (vertical) AR *= def.endPlate || 1.55;
  const sweepLE = (def.sweepLE || 0) * DEG;
  // half-chord sweep from leading-edge sweep and taper
  const tanHalf = Math.tan(sweepLE) - (cr - ct) * 0.5 / semi;
  const a = liftSlope3D(af.a0 || 6.1, AR, Math.atan(tanHalf)) * (def.liftEff || 1);
  const e = def.e || 0.8;
  const kInd = 1 / (Math.PI * e * AR);
  const dihedral = (def.dihedral || 0) * DEG;
  const out = [];
  const sides = vertical ? [0] : [-1, 1];
  const asPos0 = calibrateStallAngle(a, af.clMax);
  const asNeg0 = -calibrateStallAngle(a, -(af.clMin ?? -af.clMax * 0.8));
  const fd = def.flapData;

  for (const side of sides) {
    for (let i = 0; i < strips; i++) {
      const e0 = i / strips, e1 = (i + 1) / strips, em = 0.5 * (e0 + e1);
      const s = new AeroSurface();
      s.group = kind; s.side = side;
      s.name = `${def.name || kind}${side < 0 ? 'L' : side > 0 ? 'R' : ''}${i}`;
      const c = cr + (ct - cr) * em;
      s.chord = c;
      s.area = c * semi / strips;
      const yOut = em * semi;                       // distance along the span from the root
      const xq = def.rootLE[0] - yOut * Math.tan(sweepLE) - 0.25 * c;
      if (vertical) {
        s.pos.set(xq, def.rootLE[1] + yOut, def.rootLE[2] || 0);
      } else {
        s.pos.set(xq, def.rootLE[1] + yOut * Math.tan(dihedral), side * ((def.rootLE[2] || 0) + yOut));
      }
      const inc = ((def.incidence || 0) + (def.twist || 0) * em) * DEG;
      if (vertical) {
        s.cAxis.set(1, 0, 0);
        s.nAxis.set(0, 0, 1);
      } else {
        // chord line pitched by the incidence, then rolled by the dihedral
        const th = -side * dihedral;
        s.cAxis.set(Math.cos(inc), Math.sin(inc) * Math.cos(th), Math.sin(inc) * Math.sin(th));
        s.nAxis.set(-Math.sin(inc), Math.cos(inc) * Math.cos(th), Math.cos(inc) * Math.sin(th));
      }
      s.mAxis.crossVectors(s.cAxis, s.nAxis);
      s.sAxis.copy(s.mAxis).scale(side || 1);
      s.sweepTan = vertical ? 0 : Math.tan(sweepLE) - (cr - ct) * 0.25 / semi;
      s.a = a; s.alpha0 = (af.alpha0 || 0) * DEG;
      s.asPos0 = asPos0; s.asNeg0 = asNeg0; s.asPos1 = asPos0;
      s.cd0 = af.cd0; s.kInd = kInd; s.cm0 = af.cm0 || 0;
      s.qFactor = def.qFactor || 1;
      s.downwash = def.downwash || 0;
      s.swirl = def.swirl || 0;
      s.sweepShift = def.supersonicShift ?? 0.2;

      for (const cs of def.controls || []) {
        const cover = Math.max(0, Math.min(e1, cs.to) - Math.max(e0, cs.from)) / (e1 - e0);
        if (cover <= 0) continue;
        if (cs.type === 'flap') {
          s.flapFrac = cover;
          s.flapDAlpha = (fd.dCl0 / a) * cover;
          s.asPos1 = calibrateStallAngle(a, af.clMax + fd.dClMax * cover);
          s.flapDCd0 = fd.dCd0 * cover;
          s.flapDCm = (fd.dCm ?? -0.2 * fd.dCl0) * cover;
        } else if (cs.type === 'spoiler') {
          s.spoilerFrac = cover;
        } else {
          s.ctrlAxis = cs.type;
          s.ctrlTau = (cs.allMoving ? 1 : flapEffectiveness(cs.chordFrac)) * cover * (cs.eff || 1);
          s.ctrlAllMoving = !!cs.allMoving;
          // channel sign convention: +aileron rolls right, +elevator pitches up, +rudder yaws right
          s.ctrlSign = cs.type === 'aileron' ? -side : -1;
        }
      }
      for (const pw of def.propwash || []) {
        const cover = Math.max(0, Math.min(e1, pw.to) - Math.max(e0, pw.from)) / (e1 - e0);
        if (cover > 0) s.propwash = Math.max(s.propwash, cover * pw.frac);
      }
      out.push(s);
    }
  }
  return { surfaces: out, area, span, mac, AR, a };
}

const _f = { fc: 0, fn: 0, cm: 0, xcp: 0 };

/**
 * Section coefficients -> force components in the strip's (chord, normal) basis.
 * @param s        strip
 * @param vc,vn,vs strip velocity relative to the air along the chord / normal / outboard span axes
 * @param rho      air density
 * @param defl     control deflection (rad, trailing edge toward -n is positive)
 * @param flap     flap position 0..1
 * @param spoiler  spoiler position 0..1
 * @param fx       compressibility / ground-effect factors
 * @param quasiStatic  ignore the separation lag (used by the trimmer)
 */
export function stripForce(s, vc, vn, vs, rho, defl, flap, spoiler, fx, quasiStatic) {
  const V2 = vc * vc + vn * vn;
  if (V2 < 0.01) { _f.fc = 0; _f.fn = 0; _f.cm = 0; _f.xcp = 0; s.q = 0; s.cl = 0; s.lift = 0; s.xTarget = 1; return _f; }
  const V = Math.sqrt(V2);
  const alpha = Math.atan2(-vn, vc);
  const a = s.a * fx.lift * (1 + 0.1 * (1 - fx.ground) * (s.group === 'wing' ? 1 : 0));
  const fl = flap * s.flapFrac > 0 ? flap : 0;
  const spo = spoiler * s.spoilerFrac;
  // effective angle of attack measured from the zero-lift line
  // plain control surfaces lose effectiveness at large deflection
  const dEff = s.ctrlAllMoving ? defl : defl / Math.sqrt(1 + (defl / 0.6) * (defl / 0.6));
  const dAe = s.ctrlTau * dEff;
  let ae = alpha - s.alpha0 + dAe + s.flapDAlpha * fl - 0.09 * spo;
  // wrap to (-pi, pi]
  if (ae > Math.PI) ae -= 2 * Math.PI; else if (ae < -Math.PI) ae += 2 * Math.PI;
  // a deflected hinged surface also raises the attainable lift (about half of its increment)
  const cShift = s.ctrlAllMoving ? 0 : 0.5 * dAe;
  const asPos = (s.asPos0 + (s.asPos1 - s.asPos0) * fl) * fx.clMax + cShift;
  const asNeg = s.asNeg0 * fx.clMax + cShift;
  const xs = sepStatic(ae, asPos, asNeg);
  s.xTarget = xs;
  const x = quasiStatic ? xs : s.x;
  const s2 = Math.sin(2 * ae), sn = Math.sin(ae);
  const clAtt = a * ae * (1 - 0.35 * spo);
  const cl = x * clAtt + (1 - x) * PLATE_CL * s2;
  const cd0 = s.cd0 * fx.cd0 + s.flapDCd0 * fl * fl + 0.06 * spo;
  const cd = x * (cd0 + s.kInd * fx.kInd * fx.ground * clAtt * clAtt) + (1 - x) * (cd0 + PLATE_CD * sn * sn);
  const q = 0.5 * rho * V2 * s.qFactor;
  // swept wings: lift follows the flow component normal to the quarter-chord line, which
  // gives the sweep contribution to the dihedral effect in a sideslip
  let kSweep = 1;
  if (s.sweepTan !== 0 && vc > 1) kSweep = clamp(1 + s.sweepTan * vs / vc, 0.4, 1.6);
  const L = q * s.area * cl * kSweep, D = q * s.area * cd;
  _f.fc = (-L * vn - D * vc) / V;
  _f.fn = (L * vc - D * vn) / V;
  // pitching moment about the quarter chord (camber, flap and control deflection)
  _f.cm = q * s.area * s.chord * (x * (s.cm0 + s.flapDCm * fl - (s.ctrlAllMoving ? 0 : 0.2 * a * dAe)));
  // centre of pressure moves aft when the flow separates (to mid-chord) and at supersonic speed
  _f.xcp = s.chord * (0.25 * (1 - x) * Math.min(1, Math.abs(sn) * 2) + s.sweepShift * fx.acShift);
  s.alpha = alpha; s.cl = cl; s.q = q; s.lift = L;
  return _f;
}
