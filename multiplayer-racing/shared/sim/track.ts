/**
 * Track geometry: a closed centre line sampled from a centripetal Catmull-Rom
 * spline, plus everything derived from it (walls, checkpoint gates, start grid
 * and a spatial index for fast nearest-point queries).
 *
 * Coordinates live on the XZ plane. A heading `yaw` points along
 * (sin yaw, cos yaw); positive yaw turns left; "left" of a direction (tx, tz)
 * is (tz, -tx).
 */
import { clamp, mod } from './math';

export interface SurfaceDef {
  /** Human readable surface name. */
  name: string;
  /** Tyre friction coefficient on the road. */
  grip: number;
  /** Tyre friction coefficient on the run-off. */
  offroadGrip: number;
  /** Multiplier on the run-off rolling drag. */
  offroadDrag: number;
  /** Bounciness of the barriers (0..1). */
  wallRestitution: number;
  /** Fraction of sliding speed scrubbed by scraping a barrier (0..1). */
  wallFriction: number;
}

export type TrackTheme = 'harbor' | 'glacier';

export interface TrackDef {
  id: string;
  name: string;
  tagline: string;
  theme: TrackTheme;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  /** Closed loop of control points [x, z] in metres, in driving order. */
  points: ReadonlyArray<readonly [number, number]>;
  /** Half of the road width. */
  halfWidth: number;
  /** Distance between the road edge and the barrier. */
  runoff: number;
  surface: SurfaceDef;
  /** Number of ordered checkpoint gates, gate 0 being the start/finish line. */
  checkpoints: number;
  defaultLaps: number;
}

export interface Gate {
  index: number;
  /** Arc length of the gate along the centre line. */
  s: number;
  /** Centre of the gate. */
  cx: number;
  cz: number;
  /** Driving direction through the gate. */
  tx: number;
  tz: number;
  /** Gate end points (left, right) spanning barrier to barrier. */
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

export interface GridSlot {
  x: number;
  z: number;
  yaw: number;
}

export interface Track {
  def: TrackDef;
  id: string;
  /** Number of centre line samples (and segments; the loop is closed). */
  n: number;
  /** Total centre line length. */
  length: number;
  px: Float64Array;
  pz: Float64Array;
  /** Unit tangents at each sample. */
  tx: Float64Array;
  tz: Float64Array;
  /** Cumulative arc length at each sample. */
  s: Float64Array;
  /** Length of segment i (sample i -> i+1). */
  segLen: Float64Array;
  /** Signed, smoothed curvature at each sample (positive = left turn). */
  curv: Float64Array;
  halfWidth: number;
  /** Distance from the centre line to the barrier. */
  wallDist: number;
  gates: Gate[];
  grid: GridSlot[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  // Spatial index.
  cellSize: number;
  cellsX: number;
  cellsZ: number;
  cellStart: Int32Array;
  cellItems: Int32Array;
}

export interface TrackQuery {
  /** Index of the nearest segment. */
  seg: number;
  /** Position along the segment in [0, 1]. */
  t: number;
  /** Arc length of the projection. */
  s: number;
  /** Signed lateral offset (positive = left of the driving direction). */
  lat: number;
  /** Unsigned distance to the centre line. */
  dist: number;
  /** Closest point on the centre line. */
  cx: number;
  cz: number;
  /** Interpolated unit tangent at the projection. */
  tx: number;
  tz: number;
}

export function makeQuery(): TrackQuery {
  return { seg: 0, t: 0, s: 0, lat: 0, dist: 0, cx: 0, cz: 0, tx: 0, tz: 1 };
}

const SAMPLE_SPACING = 2;
const SUBDIVISIONS = 32;
const MIN_CELL_SIZE = 16;
const GRID_SLOTS = 8;

function catmullRom(
  p0: readonly [number, number],
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number],
  u: number,
): [number, number] {
  // Centripetal parameterisation (alpha = 0.5) avoids cusps and overshoot.
  const d01 = Math.pow(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), 0.5) || 1e-6;
  const d12 = Math.pow(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), 0.5) || 1e-6;
  const d23 = Math.pow(Math.hypot(p3[0] - p2[0], p3[1] - p2[1]), 0.5) || 1e-6;
  const t0 = 0;
  const t1 = t0 + d01;
  const t2 = t1 + d12;
  const t3 = t2 + d23;
  const t = t1 + (t2 - t1) * u;
  const out: [number, number] = [0, 0];
  for (let k = 0; k < 2; k++) {
    const a1 = ((t1 - t) / (t1 - t0)) * p0[k]! + ((t - t0) / (t1 - t0)) * p1[k]!;
    const a2 = ((t2 - t) / (t2 - t1)) * p1[k]! + ((t - t1) / (t2 - t1)) * p2[k]!;
    const a3 = ((t3 - t) / (t3 - t2)) * p2[k]! + ((t - t2) / (t3 - t2)) * p3[k]!;
    const b1 = ((t2 - t) / (t2 - t0)) * a1 + ((t - t0) / (t2 - t0)) * a2;
    const b2 = ((t3 - t) / (t3 - t1)) * a2 + ((t - t1) / (t3 - t1)) * a3;
    out[k] = ((t2 - t) / (t2 - t1)) * b1 + ((t - t1) / (t2 - t1)) * b2;
  }
  return out;
}

export function buildTrack(def: TrackDef): Track {
  const pts = def.points;
  const count = pts.length;
  if (count < 4) throw new Error(`Track ${def.id} needs at least 4 control points`);

  // 1. Dense polyline through the control points.
  const dense: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    const p0 = pts[mod(i - 1, count)]!;
    const p1 = pts[i]!;
    const p2 = pts[(i + 1) % count]!;
    const p3 = pts[(i + 2) % count]!;
    for (let k = 0; k < SUBDIVISIONS; k++) {
      dense.push(catmullRom(p0, p1, p2, p3, k / SUBDIVISIONS));
    }
  }
  const denseLen = new Float64Array(dense.length + 1);
  for (let i = 0; i < dense.length; i++) {
    const a = dense[i]!;
    const b = dense[(i + 1) % dense.length]!;
    denseLen[i + 1] = denseLen[i]! + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const total = denseLen[dense.length]!;

  // 2. Resample at (nearly) uniform arc length.
  const n = Math.max(16, Math.round(total / SAMPLE_SPACING));
  const px = new Float64Array(n);
  const pz = new Float64Array(n);
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    const target = (i / n) * total;
    while (cursor < dense.length - 1 && denseLen[cursor + 1]! < target) cursor++;
    const a = dense[cursor]!;
    const b = dense[(cursor + 1) % dense.length]!;
    const span = denseLen[cursor + 1]! - denseLen[cursor]!;
    const u = span > 1e-9 ? (target - denseLen[cursor]!) / span : 0;
    px[i] = a[0] + (b[0] - a[0]) * u;
    pz[i] = a[1] + (b[1] - a[1]) * u;
  }

  // 3. Derived per-sample data.
  const tx = new Float64Array(n);
  const tz = new Float64Array(n);
  const s = new Float64Array(n);
  const segLen = new Float64Array(n);
  let length = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s[i] = length;
    segLen[i] = Math.hypot(px[j]! - px[i]!, pz[j]! - pz[i]!);
    length += segLen[i]!;
  }
  for (let i = 0; i < n; i++) {
    const a = mod(i - 1, n);
    const b = (i + 1) % n;
    const dx = px[b]! - px[a]!;
    const dz = pz[b]! - pz[a]!;
    const l = Math.hypot(dx, dz) || 1;
    tx[i] = dx / l;
    tz[i] = dz / l;
  }
  const rawCurv = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = mod(i - 1, n);
    const b = (i + 1) % n;
    // Signed turn between neighbouring tangents (positive = left).
    const cross = tz[a]! * tx[b]! - tx[a]! * tz[b]!;
    const dot = tx[a]! * tx[b]! + tz[a]! * tz[b]!;
    const dYaw = Math.atan2(cross, dot);
    rawCurv[i] = dYaw / (segLen[a]! + segLen[i]!);
  }
  const curv = new Float64Array(n);
  const window = 3;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -window; k <= window; k++) acc += rawCurv[mod(i + k, n)]!;
    curv[i] = acc / (window * 2 + 1);
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, px[i]!);
    maxX = Math.max(maxX, px[i]!);
    minZ = Math.min(minZ, pz[i]!);
    maxZ = Math.max(maxZ, pz[i]!);
  }
  const wallDist = def.halfWidth + def.runoff;
  // Cells scale with the corridor so very wide tracks do not explode the index.
  const CELL_SIZE = Math.max(MIN_CELL_SIZE, wallDist / 6);
  const pad = wallDist + CELL_SIZE * 2;
  const bounds = { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad };

  // 4. Spatial index: every cell lists the segments that can be nearest to a
  //    point inside it, as long as that point is within `reach` of the track.
  const cellsX = Math.ceil((bounds.maxX - bounds.minX) / CELL_SIZE);
  const cellsZ = Math.ceil((bounds.maxZ - bounds.minZ) / CELL_SIZE);
  const reach = wallDist + 10;
  const halfDiag = CELL_SIZE * Math.SQRT1_2;
  const buckets: number[][] = Array.from({ length: cellsX * cellsZ }, () => []);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = px[i]!;
    const az = pz[i]!;
    const bx = px[j]!;
    const bz = pz[j]!;
    const r = reach + halfDiag * 2;
    const x0 = clamp(Math.floor((Math.min(ax, bx) - r - bounds.minX) / CELL_SIZE), 0, cellsX - 1);
    const x1 = clamp(Math.floor((Math.max(ax, bx) + r - bounds.minX) / CELL_SIZE), 0, cellsX - 1);
    const z0 = clamp(Math.floor((Math.min(az, bz) - r - bounds.minZ) / CELL_SIZE), 0, cellsZ - 1);
    const z1 = clamp(Math.floor((Math.max(az, bz) + r - bounds.minZ) / CELL_SIZE), 0, cellsZ - 1);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const mx = bounds.minX + (cx + 0.5) * CELL_SIZE;
        const mz = bounds.minZ + (cz + 0.5) * CELL_SIZE;
        if (Math.sqrt(distSqToSegment(mx, mz, ax, az, bx, bz)) <= r) {
          buckets[cz * cellsX + cx]!.push(i);
        }
      }
    }
  }
  const cellStart = new Int32Array(cellsX * cellsZ + 1);
  let totalItems = 0;
  for (let c = 0; c < buckets.length; c++) {
    cellStart[c] = totalItems;
    totalItems += buckets[c]!.length;
  }
  cellStart[buckets.length] = totalItems;
  const cellItems = new Int32Array(totalItems);
  for (let c = 0; c < buckets.length; c++) cellItems.set(buckets[c]!, cellStart[c]!);

  const track: Track = {
    def,
    id: def.id,
    n,
    length,
    px,
    pz,
    tx,
    tz,
    s,
    segLen,
    curv,
    halfWidth: def.halfWidth,
    wallDist,
    gates: [],
    grid: [],
    bounds,
    cellSize: CELL_SIZE,
    cellsX,
    cellsZ,
    cellStart,
    cellItems,
  };

  // 5. Checkpoint gates, evenly spaced, gate 0 on the start/finish line.
  const span = wallDist + 1;
  for (let g = 0; g < def.checkpoints; g++) {
    const idx = Math.round((g / def.checkpoints) * n) % n;
    const gx = px[idx]!;
    const gz = pz[idx]!;
    const gtx = tx[idx]!;
    const gtz = tz[idx]!;
    track.gates.push({
      index: g,
      s: s[idx]!,
      cx: gx,
      cz: gz,
      tx: gtx,
      tz: gtz,
      ax: gx + gtz * span,
      az: gz - gtx * span,
      bx: gx - gtz * span,
      bz: gz + gtx * span,
    });
  }

  // 6. Staggered two-column start grid behind the line.
  const column = def.halfWidth * 0.42;
  for (let i = 0; i < GRID_SLOTS; i++) {
    const back = 7 + i * 5;
    const side = i % 2 === 0 ? 1 : -1;
    const slot = { x: 0, z: 0, yaw: 0 };
    pointAt(track, length - back, side * column, slot);
    track.grid.push(slot);
  }

  return track;
}

function distSqToSegment(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t;
  const cz = az + dz * t;
  return (x - cx) * (x - cx) + (z - cz) * (z - cz);
}

function projectOnSegment(track: Track, i: number, x: number, z: number, out: TrackQuery): number {
  const j = i + 1 === track.n ? 0 : i + 1;
  const ax = track.px[i]!;
  const az = track.pz[i]!;
  const dx = track.px[j]! - ax;
  const dz = track.pz[j]! - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t;
  const cz = az + dz * t;
  const d2 = (x - cx) * (x - cx) + (z - cz) * (z - cz);
  if (d2 < out.dist) {
    out.dist = d2;
    out.seg = i;
    out.t = t;
    out.cx = cx;
    out.cz = cz;
  }
  return d2;
}

/**
 * Projects a point onto the centre line. Stateless and deterministic, so the
 * server and predicting clients always agree on the result.
 */
export function queryTrack(track: Track, x: number, z: number, out: TrackQuery): TrackQuery {
  out.dist = Infinity;
  const cx = Math.floor((x - track.bounds.minX) / track.cellSize);
  const cz = Math.floor((z - track.bounds.minZ) / track.cellSize);
  let found = false;
  if (cx >= 0 && cz >= 0 && cx < track.cellsX && cz < track.cellsZ) {
    const cell = cz * track.cellsX + cx;
    const end = track.cellStart[cell + 1]!;
    for (let k = track.cellStart[cell]!; k < end; k++) {
      projectOnSegment(track, track.cellItems[k]!, x, z, out);
      found = true;
    }
  }
  if (!found) {
    for (let i = 0; i < track.n; i++) projectOnSegment(track, i, x, z, out);
  }
  return finishQuery(track, x, z, out);
}

/** Exhaustive variant of {@link queryTrack}; used for validation and scenery. */
export function queryTrackBrute(track: Track, x: number, z: number, out: TrackQuery): TrackQuery {
  out.dist = Infinity;
  for (let i = 0; i < track.n; i++) projectOnSegment(track, i, x, z, out);
  return finishQuery(track, x, z, out);
}

function finishQuery(track: Track, x: number, z: number, out: TrackQuery): TrackQuery {
  const i = out.seg;
  const j = i + 1 === track.n ? 0 : i + 1;
  const dist = Math.sqrt(out.dist);
  out.dist = dist;
  out.s = track.s[i]! + track.segLen[i]! * out.t;
  const sdx = track.px[j]! - track.px[i]!;
  const sdz = track.pz[j]! - track.pz[i]!;
  // Left normal of the segment is (dz, -dx).
  const side = (x - out.cx) * sdz - (z - out.cz) * sdx;
  out.lat = side >= 0 ? dist : -dist;
  let ttx = track.tx[i]! + (track.tx[j]! - track.tx[i]!) * out.t;
  let ttz = track.tz[i]! + (track.tz[j]! - track.tz[i]!) * out.t;
  const l = Math.sqrt(ttx * ttx + ttz * ttz) || 1;
  ttx /= l;
  ttz /= l;
  out.tx = ttx;
  out.tz = ttz;
  return out;
}

/** Index of the segment containing arc length `s` (wrapped). */
export function segmentAt(track: Track, s: number): number {
  const w = mod(s, track.length);
  let i = Math.min(track.n - 1, Math.floor((w / track.length) * track.n));
  while (i > 0 && track.s[i]! > w) i--;
  while (i < track.n - 1 && track.s[i + 1]! <= w) i++;
  return i;
}

/** World position/heading at arc length `s` with a lateral offset (left positive). */
export function pointAt(track: Track, s: number, lat: number, out: GridSlot): GridSlot {
  const w = mod(s, track.length);
  const i = segmentAt(track, w);
  const j = i + 1 === track.n ? 0 : i + 1;
  const t = track.segLen[i]! > 0 ? clamp((w - track.s[i]!) / track.segLen[i]!, 0, 1) : 0;
  let ttx = track.tx[i]! + (track.tx[j]! - track.tx[i]!) * t;
  let ttz = track.tz[i]! + (track.tz[j]! - track.tz[i]!) * t;
  const l = Math.sqrt(ttx * ttx + ttz * ttz) || 1;
  ttx /= l;
  ttz /= l;
  out.x = track.px[i]! + (track.px[j]! - track.px[i]!) * t + ttz * lat;
  out.z = track.pz[i]! + (track.pz[j]! - track.pz[i]!) * t - ttx * lat;
  out.yaw = Math.atan2(ttx, ttz);
  return out;
}

/** Smoothed signed curvature at arc length `s`. */
export function curvatureAt(track: Track, s: number): number {
  return track.curv[segmentAt(track, s)]!;
}

/** Shortest signed arc-length difference `a - b` along the loop. */
export function arcDelta(track: Track, a: number, b: number): number {
  let d = (a - b) % track.length;
  if (d > track.length / 2) d -= track.length;
  else if (d < -track.length / 2) d += track.length;
  return d;
}

export interface TrackReport {
  length: number;
  minRadius: number;
  minSeparation: number;
  startStraight: number;
}

/**
 * Geometric sanity report used by tests: the tightest corner must stay wider
 * than the barrier offset and distant sections must not overlap.
 */
export function analyseTrack(track: Track): TrackReport {
  let maxCurv = 0;
  for (let i = 0; i < track.n; i++) maxCurv = Math.max(maxCurv, Math.abs(track.curv[i]!));
  let minSeparation = Infinity;
  const guard = track.wallDist * 4 + 20;
  for (let i = 0; i < track.n; i += 2) {
    for (let j = i + 2; j < track.n; j += 2) {
      const along = Math.min(Math.abs(track.s[j]! - track.s[i]!), track.length - Math.abs(track.s[j]! - track.s[i]!));
      if (along < guard) continue;
      const d = Math.hypot(track.px[i]! - track.px[j]!, track.pz[i]! - track.pz[j]!);
      if (d < minSeparation) minSeparation = d;
    }
  }
  // Distance before the line over which the heading stays within ~6 degrees.
  let startStraight = 0;
  const yaw0 = Math.atan2(track.tx[0]!, track.tz[0]!);
  for (let k = 1; k < track.n; k++) {
    const i = track.n - k;
    const yaw = Math.atan2(track.tx[i]!, track.tz[i]!);
    let d = Math.abs(yaw - yaw0);
    if (d > Math.PI) d = Math.PI * 2 - d;
    if (d > 0.1) break;
    startStraight += track.segLen[i]!;
  }
  return { length: track.length, minRadius: 1 / Math.max(maxCurv, 1e-9), minSeparation, startStraight };
}
