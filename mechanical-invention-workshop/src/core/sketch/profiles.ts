/**
 * Closed-profile extraction: turns sketch geometry into extrudable regions
 * (outer loop + holes). Never throws on bad input — everything unusable is
 * reported in `openEntities` / `problems`.
 */
import type { Sketch, SketchLoop, SketchProfileResult, SketchRegion } from './types';

type Pt = [number, number];

/** points closer than this are the same vertex (mm) */
const MERGE_TOL = 1e-6;
/** two segments only "cross" when each straddles the other by more than this (mm) */
const CROSS_EPS = 1e-7;
/** loops with |area| below this enclose nothing (mm²) */
const AREA_EPS = 1e-9;
const TWO_PI = Math.PI * 2;

interface Edge {
  id: string;
  /** index of the entity in sketch.entities */
  order: number;
  v0: number;
  v1: number;
  /** polyline from v0 to v1, both ends included */
  poly: Pt[];
}

/** segments of a closed polygon sorted by their smallest x, for sweep-pruned crossing tests */
interface SegSet {
  n: number;
  ax: Float64Array; ay: Float64Array; bx: Float64Array; by: Float64Array;
  lo: Float64Array; hi: Float64Array;
  /** original segment index (segment i joins vertex i and i+1) */
  idx: Int32Array;
  maxW: number;
}

interface LoopRec {
  loop: SketchLoop;
  order: number;
  bbox: [number, number, number, number];
  segs: SegSet;
  inside: Pt | null;
}

function signedArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  }
  return a / 2;
}

function buildSegs(poly: Pt[]): SegSet {
  const n = poly.length;
  const order = new Int32Array(n);
  const lo0 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    order[i] = i;
    lo0[i] = Math.min(poly[i][0], poly[(i + 1) % n][0]);
  }
  const sorted = Array.from(order).sort((a, b) => lo0[a] - lo0[b] || a - b);
  const s: SegSet = {
    n,
    ax: new Float64Array(n), ay: new Float64Array(n), bx: new Float64Array(n), by: new Float64Array(n),
    lo: new Float64Array(n), hi: new Float64Array(n), idx: new Int32Array(n), maxW: 0,
  };
  for (let k = 0; k < n; k++) {
    const i = sorted[k];
    const a = poly[i], b = poly[(i + 1) % n];
    s.ax[k] = a[0]; s.ay[k] = a[1]; s.bx[k] = b[0]; s.by[k] = b[1];
    s.lo[k] = Math.min(a[0], b[0]); s.hi[k] = Math.max(a[0], b[0]);
    s.idx[k] = i;
    s.maxW = Math.max(s.maxW, s.hi[k] - s.lo[k]);
  }
  return s;
}

/** true when the two segments properly cross (touching ends / T-junctions / collinear overlap do not count) */
function properCross(
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number,
): boolean {
  const abx = bx - ax, aby = by - ay;
  const lab = Math.sqrt(abx * abx + aby * aby);
  if (!(lab > 1e-12)) return false;
  const d1 = (abx * (cy - ay) - aby * (cx - ax)) / lab;
  const d2 = (abx * (dy - ay) - aby * (dx - ax)) / lab;
  if (!((d1 > CROSS_EPS && d2 < -CROSS_EPS) || (d1 < -CROSS_EPS && d2 > CROSS_EPS))) return false;
  const cdx = dx - cx, cdy = dy - cy;
  const lcd = Math.sqrt(cdx * cdx + cdy * cdy);
  if (!(lcd > 1e-12)) return false;
  const d3 = (cdx * (ay - cy) - cdy * (ax - cx)) / lcd;
  const d4 = (cdx * (by - cy) - cdy * (bx - cx)) / lcd;
  return (d3 > CROSS_EPS && d4 < -CROSS_EPS) || (d3 < -CROSS_EPS && d4 > CROSS_EPS);
}

/** Do any segments of A and B cross? With A === B: does the polygon cross itself? */
function segsCross(A: SegSet, B: SegSet): boolean {
  const self = A === B;
  for (let i = 0; i < A.n; i++) {
    const lo = A.lo[i], hi = A.hi[i];
    // first segment of B that can reach lo
    const want = lo - B.maxW;
    let l = 0, r = B.n;
    while (l < r) { const mid = (l + r) >> 1; if (B.lo[mid] < want) l = mid + 1; else r = mid; }
    const aylo = Math.min(A.ay[i], A.by[i]), ayhi = Math.max(A.ay[i], A.by[i]);
    for (let j = l; j < B.n && B.lo[j] <= hi; j++) {
      if (B.hi[j] < lo) continue;
      if (self) {
        const ia = A.idx[i], ib = B.idx[j];
        if (ia >= ib) continue;
        if (ib - ia === 1 || (ia === 0 && ib === A.n - 1)) continue;
      }
      if (Math.min(B.ay[j], B.by[j]) > ayhi || Math.max(B.ay[j], B.by[j]) < aylo) continue;
      if (properCross(A.ax[i], A.ay[i], A.bx[i], A.by[i], B.ax[j], B.ay[j], B.bx[j], B.by[j])) return true;
    }
  }
  return false;
}

/** 1 strictly inside, −1 strictly outside, 0 on the boundary (within CROSS_EPS) */
function classify(x: number, y: number, poly: Pt[]): number {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    const ex = xi - xj, ey = yi - yj;
    const len2 = ex * ex + ey * ey;
    let t = len2 > 0 ? ((x - xj) * ex + (y - yj) * ey) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = xj + t * ex - x, py = yj + t * ey - y;
    if (px * px + py * py <= CROSS_EPS * CROSS_EPS) return 0;
    if ((yi > y) !== (yj > y) && x < xi + ((y - yi) / (yj - yi)) * (xj - xi)) inside = !inside;
  }
  return inside ? 1 : -1;
}

/** Does loop B have vertices strictly inside AND strictly outside loop A (i.e. the outlines pass through each other)? */
function straddles(B: LoopRec, A: LoopRec): boolean {
  let seenIn = false, seenOut = false;
  const bb = A.bbox;
  for (const p of B.loop.points) {
    const outsideBox = p[0] < bb[0] - CROSS_EPS || p[0] > bb[2] + CROSS_EPS || p[1] < bb[1] - CROSS_EPS || p[1] > bb[3] + CROSS_EPS;
    const cls = outsideBox ? -1 : classify(p[0], p[1], A.loop.points);
    if (cls > 0) seenIn = true; else if (cls < 0) seenOut = true;
    if (seenIn && seenOut) return true;
  }
  return false;
}

function pointInPoly(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  const x = p[0], y = p[1];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i][1], yj = poly[j][1];
    if ((yi > y) !== (yj > y)) {
      const xc = poly[i][0] + ((y - yi) / (yj - yi)) * (poly[j][0] - poly[i][0]);
      if (x < xc) inside = !inside;
    }
  }
  return inside;
}

/** A point strictly inside the polygon: middle of the widest inside-span on a scanline that misses all vertices. */
function interiorPoint(poly: Pt[]): Pt | null {
  const ys = poly.map(p => p[1]).sort((a, b) => a - b);
  let bestGap = 0, y = NaN;
  for (let i = 1; i < ys.length; i++) {
    const gap = ys[i] - ys[i - 1];
    if (gap > bestGap) { bestGap = gap; y = (ys[i] + ys[i - 1]) / 2; }
  }
  if (!(bestGap > 0)) return null;
  const xs: number[] = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i][1], yj = poly[j][1];
    if ((yi > y) !== (yj > y)) xs.push(poly[i][0] + ((y - yi) / (yj - yi)) * (poly[j][0] - poly[i][0]));
  }
  xs.sort((a, b) => a - b);
  let best = -1, x = NaN;
  for (let k = 0; k + 1 < xs.length; k += 2) {
    const wdt = xs[k + 1] - xs[k];
    if (wdt > best) { best = wdt; x = (xs[k] + xs[k + 1]) / 2; }
  }
  return best > 0 ? [x, y] : null;
}

function bboxOf(poly: Pt[]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  return [minX, minY, maxX, maxY];
}

function labelOf(ids: string[]): string {
  return ids.length <= 6 ? ids.join(', ') : `${ids.slice(0, 6).join(', ')}, … (${ids.length} entities)`;
}

/**
 * Extract closed profiles (regions with holes) from the non-construction
 * geometry of a sketch.
 *
 *  - `chordTol` (mm, default 0.02): maximum chord error when arcs/circles are
 *    turned into polygons (24 … 720 segments per full turn).
 *  - `maxSegLen` (mm, optional): additionally limits the length of the segments
 *    generated for arcs/circles (straight lines are never subdivided).
 */
export function extractProfiles(
  sketch: Sketch, opts: { chordTol?: number; maxSegLen?: number } = {},
): SketchProfileResult {
  const chordTol = opts.chordTol !== undefined && opts.chordTol > 0 ? opts.chordTol : 0.02;
  const maxSegLen = opts.maxSegLen !== undefined && opts.maxSegLen > 0 ? opts.maxSegLen : 0;
  const problems: string[] = [];
  const open = new Set<string>();

  /** segments for a full turn of radius r */
  const segsPerTurn = (r: number): number => {
    let full = 24;
    if (chordTol < r) full = Math.ceil(Math.PI / Math.acos(1 - chordTol / r) - 1e-9);
    if (maxSegLen > 0) full = Math.max(full, Math.ceil((TWO_PI * r) / maxSegLen - 1e-9));
    if (!Number.isFinite(full)) full = 720;
    return Math.min(720, Math.max(24, full));
  };

  // ---- vertices: merge coincident / identical points -----------------------
  const pts = sketch.points;
  const np = pts.length;
  const pIdx = new Map<string, number>();
  pts.forEach((p, i) => { if (!pIdx.has(p.id)) pIdx.set(p.id, i); });
  const parent = new Int32Array(np);
  for (let i = 0; i < np; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent[rb] = ra; else parent[ra] = rb; // the first point of a group represents it
  };
  for (const c of sketch.constraints) {
    if (c.type !== 'coincident') continue;
    const a = pIdx.get(c.a), b = pIdx.get(c.b);
    if (a !== undefined && b !== undefined) union(a, b);
  }
  {
    const byX: number[] = [];
    for (let i = 0; i < np; i++) if (Number.isFinite(pts[i].x) && Number.isFinite(pts[i].y)) byX.push(i);
    byX.sort((a, b) => pts[a].x - pts[b].x || a - b);
    for (let i = 0; i < byX.length; i++) {
      const a = pts[byX[i]];
      for (let j = i + 1; j < byX.length && pts[byX[j]].x - a.x <= MERGE_TOL; j++) {
        const b = pts[byX[j]];
        if (Math.hypot(b.x - a.x, b.y - a.y) <= MERGE_TOL) union(byX[i], byX[j]);
      }
    }
  }
  /** vertex index of a point id; −1 missing, −2 not finite */
  const vert = (id: string): number => {
    const i = pIdx.get(id);
    if (i === undefined) return -1;
    const v = find(i);
    return Number.isFinite(pts[v].x) && Number.isFinite(pts[v].y) ? v : -2;
  };
  const vpos = (v: number): Pt => [pts[v].x, pts[v].y];
  const badRef = (kind: string, id: string, v: number): void => {
    problems.push(v === -1
      ? `${kind} ${id} refers to a point that does not exist.`
      : `${kind} ${id} uses a point without valid coordinates.`);
  };

  // ---- collect edges and stand-alone circles -------------------------------
  const cands: { poly: Pt[]; ids: string[]; order: number; circle?: SketchLoop['circle'] }[] = [];
  let edges: Edge[] = [];
  const lineKeys = new Map<string, string>();
  const circlePoly = (cx: number, cy: number, r: number, a0: number): Pt[] => {
    const nseg = segsPerTurn(r);
    const poly: Pt[] = [];
    for (let k = 0; k < nseg; k++) {
      const a = a0 + (TWO_PI * k) / nseg;
      poly.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return poly;
  };

  sketch.entities.forEach((e, order) => {
    if (e.construction) return;
    if (e.type === 'line') {
      const v0 = vert(e.p1), v1 = vert(e.p2);
      if (v0 < 0 || v1 < 0) { badRef('Line', e.id, Math.min(v0, v1)); return; }
      if (v0 === v1) {
        problems.push(`Line ${e.id} has zero length.`);
        open.add(e.id);
        return;
      }
      const key = v0 < v1 ? `${v0}_${v1}` : `${v1}_${v0}`;
      const twin = lineKeys.get(key);
      if (twin !== undefined) {
        problems.push(`Line ${e.id} lies exactly on top of line ${twin}; it was ignored.`);
        return;
      }
      lineKeys.set(key, e.id);
      edges.push({ id: e.id, order, v0, v1, poly: [vpos(v0), vpos(v1)] });
    } else if (e.type === 'circle') {
      const ci = pIdx.get(e.center);
      if (ci === undefined) { badRef('Circle', e.id, -1); return; }
      const cx = pts[ci].x, cy = pts[ci].y;
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) { badRef('Circle', e.id, -2); return; }
      if (!Number.isFinite(e.r) || !(e.r > 1e-9)) {
        problems.push(`Circle ${e.id} has no valid radius.`);
        return;
      }
      cands.push({
        poly: circlePoly(cx, cy, e.r, 0), ids: [e.id], order,
        circle: { cx, cy, r: e.r, entityId: e.id },
      });
    } else {
      const ci = pIdx.get(e.center);
      const v0 = vert(e.start), v1 = vert(e.end);
      if (ci === undefined || v0 < 0 || v1 < 0) {
        badRef('Arc', e.id, ci === undefined ? -1 : Math.min(v0, v1));
        return;
      }
      const cx = pts[ci].x, cy = pts[ci].y;
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) { badRef('Arc', e.id, -2); return; }
      const s = vpos(v0), en = vpos(v1);
      const r0 = Math.hypot(s[0] - cx, s[1] - cy), r1 = Math.hypot(en[0] - cx, en[1] - cy);
      if (!(r0 > 1e-9) || !(r1 > 1e-9)) {
        problems.push(`Arc ${e.id} has zero radius.`);
        open.add(e.id);
        return;
      }
      const a0 = Math.atan2(s[1] - cy, s[0] - cx);
      if (v0 === v1) {
        // start and end are the same vertex: the arc is a full circle
        cands.push({ poly: circlePoly(cx, cy, r0, a0), ids: [e.id], order, circle: { cx, cy, r: r0, entityId: e.id } });
        return;
      }
      let sweep = Math.atan2(en[1] - cy, en[0] - cx) - a0;
      while (sweep <= 0) sweep += TWO_PI;
      const nseg = Math.max(2, Math.ceil((segsPerTurn(Math.max(r0, r1)) * sweep) / TWO_PI - 1e-9));
      const poly: Pt[] = [s];
      for (let k = 1; k < nseg; k++) {
        const f = k / nseg;
        const a = a0 + sweep * f, r = r0 + (r1 - r0) * f; // radius blends if the arc is not solved yet
        poly.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      poly.push(en);
      edges.push({ id: e.id, order, v0, v1, poly });
    }
  });

  // ---- faces of the planar graph (bridges / dangling edges are open) --------
  let faces: number[][] = [];
  for (let guard = 0; guard < 4 && edges.length > 0; guard++) {
    const nh = edges.length * 2;
    const origin = new Int32Array(nh);
    const ang = new Float64Array(nh);
    const out = new Map<number, number[]>();
    for (let k = 0; k < edges.length; k++) {
      const e = edges[k], L = e.poly.length;
      origin[2 * k] = e.v0;
      origin[2 * k + 1] = e.v1;
      ang[2 * k] = Math.atan2(e.poly[1][1] - e.poly[0][1], e.poly[1][0] - e.poly[0][0]);
      ang[2 * k + 1] = Math.atan2(e.poly[L - 2][1] - e.poly[L - 1][1], e.poly[L - 2][0] - e.poly[L - 1][0]);
      for (const h of [2 * k, 2 * k + 1]) {
        const list = out.get(origin[h]);
        if (list) list.push(h); else out.set(origin[h], [h]);
      }
    }
    const pos = new Int32Array(nh);
    for (const list of out.values()) {
      list.sort((a, b) => ang[a] - ang[b] || a - b);
      list.forEach((h, i) => { pos[h] = i; });
    }
    const next = new Int32Array(nh);
    for (let h = 0; h < nh; h++) {
      const tw = h ^ 1;
      const list = out.get(origin[tw])!;
      next[h] = list[(pos[tw] - 1 + list.length) % list.length];
    }
    const faceOf = new Int32Array(nh).fill(-1);
    faces = [];
    for (let h = 0; h < nh; h++) {
      if (faceOf[h] >= 0) continue;
      const face: number[] = [];
      let cur = h;
      do { faceOf[cur] = faces.length; face.push(cur); cur = next[cur]; } while (cur !== h && faceOf[cur] < 0);
      faces.push(face);
    }
    const keep: Edge[] = [];
    for (let k = 0; k < edges.length; k++) {
      if (faceOf[2 * k] === faceOf[2 * k + 1]) open.add(edges[k].id); else keep.push(edges[k]);
    }
    if (keep.length === edges.length) break;
    edges = keep;
    faces = [];
  }

  const selfCache = new Map<string, boolean>();
  const reported = new Set<string>();
  for (const face of faces) {
    const poly: Pt[] = [];
    const ids: string[] = [];
    let order = Infinity;
    for (const h of face) {
      const e = edges[h >> 1];
      ids.push(e.id);
      order = Math.min(order, e.order);
      const L = e.poly.length;
      if ((h & 1) === 0) for (let k = 0; k < L - 1; k++) poly.push(e.poly[k]);
      else for (let k = L - 1; k > 0; k--) poly.push(e.poly[k]);
    }
    const key = ids.slice().sort().join('|');
    let crossesItself = selfCache.get(key);
    if (crossesItself === undefined) {
      const sset = buildSegs(poly);
      crossesItself = segsCross(sset, sset);
      selfCache.set(key, crossesItself);
    }
    if (crossesItself) {
      if (!reported.has(key)) {
        reported.add(key);
        problems.push(`The loop through ${labelOf(ids)} crosses itself and cannot be used as a profile.`);
      }
      continue;
    }
    const area = signedArea(poly);
    if (area > AREA_EPS) cands.push({ poly, ids, order });
    else if (!(area < -AREA_EPS) && !reported.has(key)) {
      reported.add(key);
      problems.push(`The loop through ${labelOf(ids)} encloses no area.`);
    }
  }

  // ---- loops, crossing checks, nesting -------------------------------------
  cands.sort((a, b) => a.order - b.order);
  const loops: LoopRec[] = cands.map(c => {
    const loop: SketchLoop = { points: c.poly, area: signedArea(c.poly), entityIds: c.ids };
    if (c.circle) loop.circle = c.circle;
    return { loop, order: c.order, bbox: bboxOf(c.poly), segs: buildSegs(c.poly), inside: interiorPoint(c.poly) };
  });
  const nl = loops.length;
  const bboxOverlap = (a: LoopRec, b: LoopRec): boolean =>
    a.bbox[0] <= b.bbox[2] && b.bbox[0] <= a.bbox[2] && a.bbox[1] <= b.bbox[3] && b.bbox[1] <= a.bbox[3];
  const crossing = new Set<number>();
  for (let i = 0; i < nl; i++) {
    for (let j = i + 1; j < nl; j++) {
      if (!bboxOverlap(loops[i], loops[j])) continue;
      // proper segment crossings, or (when an outline passes exactly through a vertex of the other) vertices on both sides
      if (segsCross(loops[i].segs, loops[j].segs) || straddles(loops[i], loops[j]) || straddles(loops[j], loops[i])) {
        crossing.add(i * nl + j);
        crossing.add(j * nl + i);
        problems.push(`The loop through ${labelOf(loops[i].loop.entityIds)} crosses the loop through ${labelOf(loops[j].loop.entityIds)}.`);
      }
    }
  }
  const byArea: number[] = [];
  for (let i = 0; i < nl; i++) byArea.push(i);
  byArea.sort((a, b) => loops[b].loop.area - loops[a].loop.area || a - b);
  const depth = new Int32Array(nl);
  const parentLoop = new Int32Array(nl).fill(-1);
  const dropped = new Uint8Array(nl);
  for (let k = 0; k < nl; k++) {
    const i = byArea[k];
    const ip = loops[i].inside;
    if (!ip) continue;
    for (let kk = k - 1; kk >= 0; kk--) {
      const j = byArea[kk];
      if (dropped[j] || crossing.has(i * nl + j) || !bboxOverlap(loops[i], loops[j])) continue;
      if (!pointInPoly(ip, loops[j].loop.points)) continue;
      const aj = loops[j].loop.area, ai = loops[i].loop.area;
      const jp = loops[j].inside;
      if (aj - ai <= 1e-9 * aj && jp && pointInPoly(jp, loops[i].loop.points)) {
        // same outline drawn twice
        dropped[i] = 1;
        problems.push(`The loop through ${labelOf(loops[i].loop.entityIds)} coincides with the loop through ${labelOf(loops[j].loop.entityIds)}; it was ignored.`);
      } else {
        parentLoop[i] = j;
        depth[i] = depth[j] + 1;
      }
      break;
    }
  }
  const regions: SketchRegion[] = [];
  const regionOf = new Map<number, SketchRegion>();
  for (let i = 0; i < nl; i++) {
    if (dropped[i] || depth[i] % 2 !== 0) continue;
    const region: SketchRegion = { outer: loops[i].loop, holes: [] };
    regionOf.set(i, region);
    regions.push(region);
  }
  for (let i = 0; i < nl; i++) {
    if (dropped[i] || depth[i] % 2 === 0) continue;
    regionOf.get(parentLoop[i])?.holes.push(loops[i].loop);
  }

  const openEntities: string[] = [];
  for (const e of sketch.entities) if (open.has(e.id)) openEntities.push(e.id);
  return { regions, openEntities, problems };
}
