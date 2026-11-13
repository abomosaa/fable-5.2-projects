/** Geometry helpers. All coordinates are WGS84 [lon, lat]. */
import type { Geometry, Position } from 'geojson';

export type BBox = [number, number, number, number];

export function isValidLonLat(lon: unknown, lat: unknown): boolean {
  return (
    typeof lon === 'number' && typeof lat === 'number' && Number.isFinite(lon) && Number.isFinite(lat) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
  );
}

/** Wrap a longitude into [-180, 180]. Values beyond ±540 are treated as invalid by callers. */
export function wrapLon(lon: number): number {
  if (lon >= -180 && lon <= 180) return lon;
  const w = ((((lon + 180) % 360) + 360) % 360) - 180;
  return w === -180 && lon > 0 ? 180 : w;
}

/** Point geometry or null when coordinates are not finite / out of range. Longitudes in (180, 360] are wrapped. */
export function pointGeometry(lon: unknown, lat: unknown): Geometry | null {
  const x = typeof lon === 'string' ? (lon.trim() === '' ? NaN : Number(lon)) : (lon as number);
  const y = typeof lat === 'string' ? (lat.trim() === '' ? NaN : Number(lat)) : (lat as number);
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (y < -90 || y > 90 || x < -360 || x > 360) return null;
  return { type: 'Point', coordinates: [round6(wrapLon(x)), round6(y)] };
}

export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function eachPosition(geom: Geometry, fn: (p: Position) => void): void {
  switch (geom.type) {
    case 'Point':
      fn(geom.coordinates);
      break;
    case 'MultiPoint':
    case 'LineString':
      geom.coordinates.forEach(fn);
      break;
    case 'MultiLineString':
    case 'Polygon':
      geom.coordinates.forEach((r) => r.forEach(fn));
      break;
    case 'MultiPolygon':
      geom.coordinates.forEach((poly) => poly.forEach((r) => r.forEach(fn)));
      break;
    case 'GeometryCollection':
      geom.geometries.forEach((g) => eachPosition(g, fn));
      break;
  }
}

export interface GeometryCheck {
  ok: boolean;
  reason?: string;
  geometry?: Geometry;
  notes: string[];
}

/**
 * Validate and normalise a GeoJSON geometry:
 *  - structure must be a known geometry type with numeric positions
 *  - latitudes must be within ±90; longitudes within ±180 after wrapping values in (180, 360]
 *  - coordinates are rounded to 6 decimals, extra dimensions (altitude) are dropped
 *  - polygons rings are closed if upstream left them open; rings with < 4 positions are rejected
 */
export function normaliseGeometry(input: unknown): GeometryCheck {
  const notes: string[] = [];
  if (!input || typeof input !== 'object') return { ok: false, reason: 'geometry missing', notes };
  const g = input as { type?: string; coordinates?: unknown; geometries?: unknown };
  let bad: string | null = null;
  let wrapped = false;

  const pos = (p: unknown): Position => {
    if (!Array.isArray(p) || p.length < 2) {
      bad ??= 'position is not [lon, lat]';
      return [0, 0];
    }
    const lon = Number(p[0]);
    const lat = Number(p[1]);
    if (p[0] === null || p[1] === null || !Number.isFinite(lon) || !Number.isFinite(lat)) {
      bad ??= 'non-numeric coordinate';
      return [0, 0];
    }
    if (lat < -90 || lat > 90) {
      bad ??= `latitude ${lat} out of range`;
      return [0, 0];
    }
    if (lon < -360 || lon > 360) {
      bad ??= `longitude ${lon} out of range`;
      return [0, 0];
    }
    if (lon < -180 || lon > 180) wrapped = true;
    return [round6(wrapLon(lon)), round6(lat)];
  };
  const line = (c: unknown, min: number): Position[] => {
    if (!Array.isArray(c) || c.length < min) {
      bad ??= `too few positions (need ${min})`;
      return [];
    }
    return c.map(pos);
  };
  const ring = (c: unknown): Position[] => {
    const r = line(c, 3);
    if (r.length >= 3) {
      const a = r[0]!;
      const b = r[r.length - 1]!;
      if (a[0] !== b[0] || a[1] !== b[1]) {
        r.push([a[0]!, a[1]!]);
        if (!notes.includes('closed open polygon ring')) notes.push('closed open polygon ring');
      }
      if (r.length < 4) bad ??= 'polygon ring has fewer than 4 positions';
    }
    return r;
  };
  const poly = (c: unknown): Position[][] => {
    if (!Array.isArray(c) || c.length === 0) {
      bad ??= 'polygon has no rings';
      return [];
    }
    return c.map(ring);
  };

  let geometry: Geometry;
  switch (g.type) {
    case 'Point':
      geometry = { type: 'Point', coordinates: pos(g.coordinates) };
      break;
    case 'MultiPoint':
      geometry = { type: 'MultiPoint', coordinates: line(g.coordinates, 1) };
      break;
    case 'LineString':
      geometry = { type: 'LineString', coordinates: line(g.coordinates, 2) };
      break;
    case 'MultiLineString':
      geometry = { type: 'MultiLineString', coordinates: Array.isArray(g.coordinates) && g.coordinates.length ? g.coordinates.map((l) => line(l, 2)) : ((bad ??= 'empty MultiLineString'), []) };
      break;
    case 'Polygon':
      geometry = { type: 'Polygon', coordinates: poly(g.coordinates) };
      break;
    case 'MultiPolygon':
      geometry = { type: 'MultiPolygon', coordinates: Array.isArray(g.coordinates) && g.coordinates.length ? g.coordinates.map(poly) : ((bad ??= 'empty MultiPolygon'), []) };
      break;
    default:
      return { ok: false, reason: `unsupported geometry type ${String(g.type)}`, notes };
  }
  if (bad) return { ok: false, reason: bad, notes };
  if (wrapped) notes.push('wrapped longitude into [-180, 180]');
  return { ok: true, geometry, notes };
}

export function bboxOfGeometry(geom: Geometry): BBox {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  eachPosition(geom, (p) => {
    const x = p[0]!;
    const y = p[1]!;
    if (x < w) w = x;
    if (x > e) e = x;
    if (y < s) s = y;
    if (y > n) n = y;
  });
  return [w, s, e, n];
}

function ringCentroid(ring: Position[]): { c: [number, number]; area: number } {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x0, y0] = ring[j] as [number, number];
    const [x1, y1] = ring[i] as [number, number];
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const b = bboxOfGeometry({ type: 'LineString', coordinates: ring });
    return { c: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], area: 0 };
  }
  return { c: [cx / (3 * a), cy / (3 * a)], area: Math.abs(a / 2) };
}

/** A single representative point: the point itself, the middle vertex of a line, the centroid of the largest polygon, the last position of a track. */
export function representativePoint(geom: Geometry, kind?: string): [number, number] {
  switch (geom.type) {
    case 'Point':
      return [geom.coordinates[0]!, geom.coordinates[1]!];
    case 'MultiPoint':
      return [geom.coordinates[0]![0]!, geom.coordinates[0]![1]!];
    case 'LineString': {
      const c = geom.coordinates;
      const p = kind === 'track' ? c[c.length - 1]! : c[Math.floor(c.length / 2)]!;
      return [p[0]!, p[1]!];
    }
    case 'MultiLineString': {
      const longest = geom.coordinates.reduce((a, b) => (b.length > a.length ? b : a));
      const p = kind === 'track' ? longest[longest.length - 1]! : longest[Math.floor(longest.length / 2)]!;
      return [p[0]!, p[1]!];
    }
    case 'Polygon':
      return roundPt(ringCentroid(geom.coordinates[0]!).c);
    case 'MultiPolygon': {
      let best: { c: [number, number]; area: number } | null = null;
      for (const poly of geom.coordinates) {
        const rc = ringCentroid(poly[0]!);
        if (!best || rc.area > best.area) best = rc;
      }
      return roundPt(best!.c);
    }
    default: {
      const b = bboxOfGeometry(geom);
      return roundPt([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]);
    }
  }
}

function roundPt(p: [number, number]): [number, number] {
  return [round6(Math.max(-180, Math.min(180, p[0]))), round6(Math.max(-90, Math.min(90, p[1])))];
}

export function pointInRing(x: number, y: number, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!;
    const yi = ring[i]![1]!;
    const xj = ring[j]![0]!;
    const yj = ring[j]![1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygonGeometry(x: number, y: number, geom: Geometry): boolean {
  const inPoly = (poly: Position[][]) => {
    if (!poly.length || !pointInRing(x, y, poly[0]!)) return false;
    for (let i = 1; i < poly.length; i++) if (pointInRing(x, y, poly[i]!)) return false;
    return true;
  };
  if (geom.type === 'Polygon') return inPoly(geom.coordinates);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some(inPoly);
  return false;
}

const R_KM = 6371.0088;
export function haversineKm(a: [number, number], b: [number, number]): number {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Douglas–Peucker simplification in degrees (good enough for display at low zoom). */
export function simplifyLine(points: Position[], tolerance: number): Position[] {
  if (points.length <= 2 || tolerance <= 0) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  const t2 = tolerance * tolerance;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = points[a] as [number, number];
    const [bx, by] = points[b] as [number, number];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i] as [number, number];
      let d: number;
      if (len2 === 0) d = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
      }
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > t2 && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

export function simplifyGeometry(geom: Geometry, tolerance: number): Geometry {
  if (tolerance <= 0) return geom;
  const ring = (r: Position[]) => {
    const s = simplifyLine(r, tolerance);
    return s.length >= 4 ? s : r.length <= 8 ? r : [r[0]!, r[Math.floor(r.length / 3)]!, r[Math.floor((2 * r.length) / 3)]!, r[r.length - 1]!];
  };
  switch (geom.type) {
    case 'LineString':
      return { type: 'LineString', coordinates: simplifyLine(geom.coordinates, tolerance) };
    case 'MultiLineString':
      return { type: 'MultiLineString', coordinates: geom.coordinates.map((l) => simplifyLine(l, tolerance)) };
    case 'Polygon':
      return { type: 'Polygon', coordinates: geom.coordinates.map(ring) };
    case 'MultiPolygon':
      return { type: 'MultiPolygon', coordinates: geom.coordinates.map((p) => p.map(ring)) };
    default:
      return geom;
  }
}

/** Polygon for a [w,s,e,n] bounding box. */
export function bboxPolygon(b: BBox): Geometry {
  return { type: 'Polygon', coordinates: [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]] };
}

/**
 * Split line strings where consecutive positions jump across the antimeridian (|Δlon| > 180),
 * so tracks and ground paths do not draw a line across the whole map.
 */
export function splitAtAntimeridian(points: Position[]): Position[][] {
  const out: Position[][] = [];
  let cur: Position[] = [];
  for (const p of points) {
    const prev = cur[cur.length - 1];
    if (prev && Math.abs(p[0]! - prev[0]!) > 180) {
      if (cur.length > 1) out.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

/** LineString / MultiLineString geometry from positions, split at the antimeridian. null when fewer than 2 usable positions. */
export function lineGeometry(points: Position[]): Geometry | null {
  const parts = splitAtAntimeridian(points);
  if (!parts.length) return null;
  return parts.length === 1 ? { type: 'LineString', coordinates: parts[0]! } : { type: 'MultiLineString', coordinates: parts };
}
