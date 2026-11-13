/**
 * Functional 2D profiles: involute gears, racks and cams.
 * All output is in part-local millimetres.
 */
import type { CamSegment } from '../model/types';
import { arcSegments, type Poly } from '../math/poly';

const inv = (a: number) => Math.tan(a) - a;

export interface GearDims {
  pitchR: number; baseR: number; tipR: number; rootR: number;
  /** tooth thickness along the pitch circle, after backlash thinning */
  toothThickness: number;
  circularPitch: number;
  warnings: string[];
}

export function gearDims(module: number, teeth: number, pressureAngle: number, backlash: number): GearDims {
  const warnings: string[] = [];
  const pitchR = (module * teeth) / 2;
  const baseR = pitchR * Math.cos(pressureAngle);
  let tipR = pitchR + module;
  const rootR = Math.max(pitchR - 1.25 * module, module * 0.2);
  const circularPitch = Math.PI * module;
  const toothThickness = circularPitch / 2 - backlash / 2;
  // pointed-tooth check
  const half = (r: number) => toothThickness / (2 * pitchR) + inv(pressureAngle) - inv(Math.acos(Math.min(1, baseR / r)));
  if (half(tipR) < 0.1 * module / tipR) {
    // shrink tip until land ≥ 0.2 m
    let lo = pitchR, hi = tipR;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (half(mid) * mid * 2 > 0.2 * module) lo = mid; else hi = mid; }
    tipR = lo;
    warnings.push('Teeth would be pointed: tip diameter was reduced to keep a 0.2·m land.');
  }
  const minTeeth = Math.ceil(2 / Math.sin(pressureAngle) ** 2);
  if (teeth < minTeeth - 4) {
    warnings.push(`${teeth} teeth at ${(pressureAngle * 180 / Math.PI).toFixed(0)}° is far below the undercut limit (${minTeeth}): flanks below the base circle are radial and the mating tip may interfere.`);
  }
  if (toothThickness <= 0.2 * module) warnings.push('Backlash is larger than is sensible for this module: teeth are very thin.');
  return { pitchR, baseR, tipR, rootR, toothThickness, circularPitch, warnings };
}

/**
 * External involute spur gear outline, CCW, tooth 0 centred on local +X.
 * Flanks are true involutes of the base circle from max(base, root) to the
 * tip; below the base circle the flank continues radially to the root circle.
 */
export function involuteGearProfile(module: number, teeth: number, pressureAngle: number, backlash: number): { poly: Poly; dims: GearDims } {
  const d = gearDims(module, teeth, pressureAngle, backlash);
  const { pitchR, baseR, tipR, rootR, toothThickness } = d;
  const halfPitchAngle = toothThickness / (2 * pitchR);
  const halfAt = (r: number) => halfPitchAngle + inv(pressureAngle) - inv(Math.acos(Math.min(1, baseR / r)));
  const flankStart = Math.max(baseR, rootR);
  const nFlank = 10;
  const pitchAngle = (2 * Math.PI) / teeth;
  const poly: Poly = [];
  const halfBase = halfAt(flankStart);
  const halfTip = Math.max(halfAt(tipR), 0);
  for (let k = 0; k < teeth; k++) {
    const c = k * pitchAngle;
    // root arc from previous tooth's trailing flank to this tooth's leading (lower-angle) flank
    const rootA0 = c - pitchAngle + halfBase;
    const rootA1 = c - halfBase;
    const nRoot = Math.max(2, Math.ceil(arcSegments(rootR, Math.max(rootA1 - rootA0, 1e-6)) ));
    for (let i = 1; i < nRoot; i++) {
      const a = rootA0 + ((rootA1 - rootA0) * i) / nRoot;
      poly.push([rootR * Math.cos(a), rootR * Math.sin(a)]);
    }
    // leading flank (negative side), root → tip
    if (rootR < flankStart - 1e-9) poly.push([rootR * Math.cos(c - halfBase), rootR * Math.sin(c - halfBase)]);
    for (let i = 0; i <= nFlank; i++) {
      // spacing denser near the base circle where curvature is highest
      const u = i / nFlank;
      const r = flankStart + (tipR - flankStart) * u * u * (3 - 2 * u) * 0.5 + (tipR - flankStart) * u * 0.5;
      const a = c - halfAt(r);
      poly.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    // tip land
    const nTip = Math.max(1, Math.ceil(arcSegments(tipR, 2 * halfTip)));
    for (let i = 1; i < nTip; i++) {
      const a = c - halfTip + (2 * halfTip * i) / nTip;
      poly.push([tipR * Math.cos(a), tipR * Math.sin(a)]);
    }
    // trailing flank, tip → root
    for (let i = nFlank; i >= 0; i--) {
      const u = i / nFlank;
      const r = flankStart + (tipR - flankStart) * u * u * (3 - 2 * u) * 0.5 + (tipR - flankStart) * u * 0.5;
      const a = c + halfAt(r);
      poly.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    if (rootR < flankStart - 1e-9) poly.push([rootR * Math.cos(c + halfBase), rootR * Math.sin(c + halfBase)]);
  }
  return { poly, dims: d };
}

/**
 * Rack outline, CCW. Pitch line is local y = 0, teeth point toward +y, the
 * rack spans x ∈ [0, teeth·p]. Tooth SPACES are centred at x = i·p, teeth at (i+½)·p.
 */
export function rackProfile(module: number, teeth: number, pressureAngle: number, backlash: number, backing: number): { poly: Poly; length: number; pitch: number } {
  const p = Math.PI * module;
  const length = teeth * p;
  const add = module, ded = 1.25 * module;
  const halfT = (p / 2 - backlash / 2) / 2; // half tooth thickness at pitch line
  const t = Math.tan(pressureAngle);
  const poly: Poly = [];
  const yBottom = -ded - backing;
  poly.push([0, yBottom], [length, yBottom]);
  // walk teeth from right to left along the top (CCW overall)
  const xs: Poly = [];
  for (let i = 0; i < teeth; i++) {
    const c = (i + 0.5) * p;
    const l = c - halfT, r = c + halfT;
    xs.push([l - ded * t, -ded], [l + add * t, add], [r - add * t, add], [r + ded * t, -ded]);
  }
  // clamp ends
  xs[0][0] = Math.max(xs[0][0], 0);
  xs[xs.length - 1][0] = Math.min(xs[xs.length - 1][0], length);
  poly.push([length, -ded]);
  for (let i = xs.length - 1; i >= 0; i--) poly.push(xs[i]);
  poly.push([0, -ded]);
  // remove consecutive duplicates
  const out: Poly = [];
  for (const q of poly) {
    const l = out[out.length - 1];
    if (!l || Math.hypot(l[0] - q[0], l[1] - q[1]) > 1e-9) out.push(q);
  }
  return { poly: out, length, pitch: p };
}

// ---------------------------------------------------------------- cams

export interface CamParams {
  profile: 'segments' | 'eccentric';
  baseRadius: number;
  rollerRadius: number;
  segments: CamSegment[];
  /** eccentric: disc radius and offset of its centre from the shaft */
  discRadius?: number;
  eccentricity?: number;
}

const TWO_PI = 2 * Math.PI;

/**
 * Follower lift s(ϑ) [mm] and its first two derivatives w.r.t. cam rotation ϑ
 * [mm/rad, mm/rad²] for a segment-defined cam. ϑ is the cam's rotation
 * (counter-clockwise) since the follower sat on the start of segment 1.
 */
export function camLift(segments: CamSegment[], thetaIn: number): { s: number; ds: number; dds: number } {
  let theta = thetaIn % TWO_PI;
  if (theta < 0) theta += TWO_PI;
  let start = 0;
  let h0 = 0;
  for (const seg of segments) {
    const beta = Math.max(seg.duration, 1e-9);
    if (theta <= start + beta + 1e-12 && start < TWO_PI) {
      const x = Math.min(1, Math.max(0, (theta - start) / beta));
      const D = seg.lift - h0;
      switch (seg.law) {
        case 'dwell': return { s: h0, ds: 0, dds: 0 };
        case 'linear': return { s: h0 + D * x, ds: D / beta, dds: 0 };
        case 'harmonic':
          return {
            s: h0 + (D * (1 - Math.cos(Math.PI * x))) / 2,
            ds: (D / beta) * (Math.PI / 2) * Math.sin(Math.PI * x),
            dds: (D / (beta * beta)) * ((Math.PI * Math.PI) / 2) * Math.cos(Math.PI * x),
          };
        case 'poly345': {
          const x2 = x * x, x3 = x2 * x, x4 = x3 * x, x5 = x4 * x;
          return {
            s: h0 + D * (10 * x3 - 15 * x4 + 6 * x5),
            ds: (D / beta) * (30 * x2 - 60 * x3 + 30 * x4),
            dds: (D / (beta * beta)) * (60 * x - 180 * x2 + 120 * x3),
          };
        }
        case 'cycloidal':
        default:
          return {
            s: h0 + D * (x - Math.sin(TWO_PI * x) / TWO_PI),
            ds: (D / beta) * (1 - Math.cos(TWO_PI * x)),
            dds: (D / (beta * beta)) * TWO_PI * Math.sin(TWO_PI * x),
          };
      }
    }
    start += beta;
    h0 = seg.law === 'dwell' ? h0 : seg.lift;
  }
  // past the last segment: dwell at the final lift
  return { s: h0, ds: 0, dds: 0 };
}

/** end lift of each segment taking 'dwell' into account + closure info */
export function camSegmentSummary(segments: CamSegment[]): { total: number; endLift: number; maxLift: number } {
  let total = 0, h = 0, maxLift = 0;
  for (const s of segments) {
    total += s.duration;
    if (s.law !== 'dwell') h = s.lift;
    maxLift = Math.max(maxLift, h);
  }
  return { total, endLift: h, maxLift };
}

/**
 * Pitch curve (path of the roller centre in the cam frame), polar form:
 * radius r(φ) and dr/dφ at cam-frame angle φ (CCW from cam +X).
 * For segment cams the follower contact at cam rotation ϑ sits at φ = −ϑ.
 */
export function camPitch(p: CamParams, phi: number): { r: number; dr: number } {
  if (p.profile === 'eccentric') {
    const R = (p.discRadius ?? 20) + p.rollerRadius;
    const e = Math.min(p.eccentricity ?? 5, R * 0.95);
    const s = Math.sin(phi), c = Math.cos(phi);
    const root = Math.sqrt(Math.max(R * R - e * e * s * s, 1e-12));
    return { r: e * c + root, dr: -e * s - (e * e * s * c) / root };
  }
  const L = camLift(p.segments, -phi);
  return { r: p.baseRadius + p.rollerRadius + L.s, dr: -L.ds };
}

export interface CamProfileResult {
  /** actual cam surface, CCW */
  surface: Poly;
  /** pitch curve, CCW */
  pitch: Poly;
  minR: number; maxR: number;
  warnings: string[];
}

export function camProfile(p: CamParams): CamProfileResult {
  const warnings: string[] = [];
  const n = 720;
  const surface: Poly = [], pitch: Poly = [];
  const rr = p.rollerRadius;
  let minR = Infinity, maxR = 0, undercut = false, minRho = Infinity;
  const h = TWO_PI / n;
  for (let i = 0; i < n; i++) {
    const phi = i * h;
    const { r, dr } = camPitch(p, phi);
    const c = Math.cos(phi), s = Math.sin(phi);
    const px = r * c, py = r * s;
    // tangent dP/dφ
    const tx = dr * c - r * s, ty = dr * s + r * c;
    const tl = Math.hypot(tx, ty) || 1;
    // outward normal for CCW traversal: (ty, -tx)
    const nx = ty / tl, ny = -tx / tl;
    pitch.push([px, py]);
    const sx = px - rr * nx, sy = py - rr * ny;
    surface.push([sx, sy]);
    const sr = Math.hypot(sx, sy);
    minR = Math.min(minR, sr); maxR = Math.max(maxR, sr);
    // curvature of pitch curve via second derivative (finite difference)
    const a = camPitch(p, phi - h), b = camPitch(p, phi + h);
    const ddr = (a.r - 2 * r + b.r) / (h * h);
    const kappaNum = r * r + 2 * dr * dr - r * ddr;
    const rho = Math.pow(r * r + dr * dr, 1.5) / kappaNum; // >0 convex
    if (rho > 0 && rho < minRho) minRho = rho;
    if (rho > 0 && rho <= rr * 1.02) undercut = true;
  }
  if (undercut) {
    warnings.push(`Cam is undercut: the pitch curve's smallest convex radius of curvature (${minRho.toFixed(2)} mm) is not larger than the roller radius (${rr.toFixed(2)} mm). The follower cannot follow this profile; enlarge the base circle or lengthen the rise/fall.`);
  }
  if (p.profile === 'segments') {
    const sum = camSegmentSummary(p.segments);
    if (sum.total > TWO_PI + 1e-6) warnings.push(`Cam segments add up to ${(sum.total * 180 / Math.PI).toFixed(1)}° (> 360°); the excess is ignored.`);
    if (Math.abs(sum.endLift) > 1e-6 && sum.total >= TWO_PI - 1e-6) warnings.push(`Cam profile does not close: lift is ${sum.endLift.toFixed(2)} mm at 360° but 0 at 0° (a step the follower cannot follow).`);
    if (sum.total < TWO_PI - 1e-6 && Math.abs(sum.endLift) > 1e-6) warnings.push(`Cam segments end at ${(sum.total * 180 / Math.PI).toFixed(1)}° with lift ${sum.endLift.toFixed(2)} mm; the remainder dwells there and then steps back to 0.`);
  }
  if (minR <= 0.5) warnings.push('Cam surface collapses to the shaft centre: base radius is too small.');
  return { surface, pitch, minR, maxR, warnings };
}
