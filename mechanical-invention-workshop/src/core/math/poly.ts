/** 2D polygon helpers. Polygons are arrays of [x, y]; CCW = solid, CW = hole. */

export type Pt = [number, number];
export type Poly = Pt[];

export const CHORD_TOL = 0.01; // mm, max sagitta when discretising arcs

export function arcSegments(r: number, sweep = 2 * Math.PI, tol = CHORD_TOL): number {
  if (r <= tol) return Math.max(6, Math.ceil((sweep / (2 * Math.PI)) * 12));
  const step = 2 * Math.acos(Math.max(-1, 1 - tol / r));
  const full = Math.min(180, Math.max(32, Math.ceil((2 * Math.PI) / step)));
  return Math.max(2, Math.ceil((full * sweep) / (2 * Math.PI)));
}

/** CCW circle polygon (CW if hole = true). Segment count always divisible by 4. */
export function circlePoly(cx: number, cy: number, r: number, hole = false, n?: number): Poly {
  let N = n ?? arcSegments(r);
  N = Math.ceil(N / 4) * 4;
  const out: Poly = [];
  for (let i = 0; i < N; i++) {
    const a = ((hole ? -i : i) / N) * 2 * Math.PI;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

export function arcPts(cx: number, cy: number, r: number, a0: number, a1: number, includeEnd = true): Poly {
  const n = arcSegments(r, Math.abs(a1 - a0));
  const out: Poly = [];
  const last = includeEnd ? n : n - 1;
  for (let i = 0; i <= last; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

export function signedArea(p: Poly): number {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % n];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

export function reversed(p: Poly): Poly { return p.slice().reverse(); }

/** Andrew monotone chain convex hull, CCW. */
export function convexHull(pts: Poly): Poly {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Poly = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 1e-12) lower.pop();
    lower.push(q);
  }
  const upper: Poly = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 1e-12) upper.pop();
    upper.push(q);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/** convex hull of a set of circles (rounded polygon / stadium), CCW */
export function hullOfCircles(circles: { x: number; y: number; r: number }[]): Poly {
  const pts: Poly = [];
  for (const c of circles) {
    const n = Math.ceil(arcSegments(c.r) / 4) * 4;
    // align samples so hull tangent points are well approximated
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 2 * Math.PI;
      pts.push([c.x + c.r * Math.cos(a), c.y + c.r * Math.sin(a)]);
    }
  }
  return convexHull(pts);
}

export function roundedRect(x0: number, y0: number, x1: number, y1: number, r: number): Poly {
  r = Math.max(0, Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2));
  if (r < 1e-9) return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const out: Poly = [];
  const H = Math.PI / 2;
  out.push(...arcPts(x1 - r, y0 + r, r, -H, 0));
  out.push(...arcPts(x1 - r, y1 - r, r, 0, H));
  out.push(...arcPts(x0 + r, y1 - r, r, H, 2 * H));
  out.push(...arcPts(x0 + r, y0 + r, r, 2 * H, 3 * H));
  return out;
}

export function transformPoly(p: Poly, x: number, y: number, angle: number): Poly {
  const c = Math.cos(angle), s = Math.sin(angle);
  return p.map(([px, py]) => [x + c * px - s * py, y + s * px + c * py]);
}

export interface AreaProps { area: number; cx: number; cy: number; /** polar second moment about the centroid */ J: number }

/** Area properties of a set of contours (CCW positive, CW negative), by Green's theorem. */
export function areaProps(contours: Poly[]): AreaProps {
  let A = 0, Sx = 0, Sy = 0, Ixx = 0, Iyy = 0;
  for (const p of contours) {
    for (let i = 0, n = p.length; i < n; i++) {
      const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % n];
      const c = x0 * y1 - x1 * y0;
      A += c;
      Sx += (x0 + x1) * c;
      Sy += (y0 + y1) * c;
      Ixx += (y0 * y0 + y0 * y1 + y1 * y1) * c;
      Iyy += (x0 * x0 + x0 * x1 + x1 * x1) * c;
    }
  }
  A /= 2;
  if (Math.abs(A) < 1e-12) return { area: 0, cx: 0, cy: 0, J: 0 };
  const cx = Sx / (6 * A), cy = Sy / (6 * A);
  const Jo = (Ixx + Iyy) / 12;
  return { area: A, cx, cy, J: Jo - A * (cx * cx + cy * cy) };
}

export function pointInPoly(x: number, y: number, p: Poly): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const xi = p[i][0], yi = p[i][1], xj = p[j][0], yj = p[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** even-odd containment test against a contour set */
export function pointInContours(x: number, y: number, contours: Poly[]): boolean {
  let c = false;
  for (const p of contours) if (pointInPoly(x, y, p)) c = !c;
  return c;
}

export function bounds(contours: Poly[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of contours) for (const [x, y] of p) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

function segInt(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1x = b[0] - a[0], d1y = b[1] - a[1], d2x = d[0] - c[0], d2y = d[1] - c[1];
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-14) return false;
  const t = ((c[0] - a[0]) * d2y - (c[1] - a[1]) * d2x) / den;
  const u = ((c[0] - a[0]) * d1y - (c[1] - a[1]) * d1x) / den;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
}

/** Fast boolean: do two contour sets (even-odd) overlap with non-zero area? */
export function contoursOverlap(A: Poly[], B: Poly[]): boolean {
  const ba = bounds(A), bb = bounds(B);
  if (ba.x1 < bb.x0 || bb.x1 < ba.x0 || ba.y1 < bb.y0 || bb.y1 < ba.y0) return false;
  const ox0 = Math.max(ba.x0, bb.x0), ox1 = Math.min(ba.x1, bb.x1);
  const oy0 = Math.max(ba.y0, bb.y0), oy1 = Math.min(ba.y1, bb.y1);
  const inBox = (p: Pt, q: Pt) =>
    !(Math.max(p[0], q[0]) < ox0 || Math.min(p[0], q[0]) > ox1 || Math.max(p[1], q[1]) < oy0 || Math.min(p[1], q[1]) > oy1);
  const ea: [Pt, Pt][] = [], eb: [Pt, Pt][] = [];
  for (const p of A) for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; if (inBox(a, b)) ea.push([a, b]); }
  for (const p of B) for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; if (inBox(a, b)) eb.push([a, b]); }
  for (const [a, b] of ea) for (const [c, d] of eb) if (segInt(a, b, c, d)) return true;
  // no boundary crossing: containment of one in the other
  for (const p of A) { if (p.length && pointInContours(p[0][0], p[0][1], B)) return true; }
  for (const p of B) { if (p.length && pointInContours(p[0][0], p[0][1], A)) return true; }
  return false;
}

/** distance from point to closed polyline */
export function distToPoly(x: number, y: number, p: Poly): number {
  let best = Infinity;
  for (let i = 0, n = p.length; i < n; i++) {
    const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % n];
    const dx = x1 - x0, dy = y1 - y0;
    const L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((x - x0) * dx + (y - y0) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const ex = x - (x0 + t * dx), ey = y - (y0 + t * dy);
    const d = ex * ex + ey * ey;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}
