/**
 * Shared helpers for the manufacturing exporters. Pure TS, no DOM.
 * All lengths are millimetres, part-local unless stated otherwise.
 */
import type { Part, Project } from '../model/types';
import { geometryOf } from '../model/project';
import type { PartGeometry } from '../parts/catalog';
import { buildSolid, type SolidMesh } from '../geom/kernel';
import { bounds, signedArea, type Poly } from '../math/poly';

/** Fixed-point number with at most `decimals` decimals, trailing zeros trimmed, never "-0". */
export function fmt(v: number, decimals = 3): string {
  if (!Number.isFinite(v)) return String(v);
  const s = v.toFixed(decimals);
  const n = Number(s);
  return Object.is(n, -0) || n === 0 ? '0' : String(n).includes('e') ? s : String(n);
}

/** Full-precision but tidy number for machine-readable attributes (rounded to 1e-6). */
export function num(v: number): string {
  return fmt(v, 6);
}

export function escXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    // characters that are illegal in XML 1.0
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/** File-system safe token: lower-case letters, digits, '-', '_' and '.'. */
export function sanitizeName(s: string, fallback = 'untitled'): string {
  const out = String(s ?? '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .toLowerCase()
    .slice(0, 60);
  return out || fallback;
}

/** JSON with sorted object keys: equal parameter sets give equal strings. */
export function stableStringify(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

/** Parts with equal keys are interchangeable: same kind, same parameters, same material. */
export function identityKey(part: Part): string {
  const mo = part.massOverride ? stableStringify(part.massOverride) : '';
  return `${part.kind}|${part.materialId}|${stableStringify(part.params)}|${mo}`;
}

/** Number of non-suppressed parts in the project identical to `part` (including itself). */
export function identicalCount(project: Project, part: Part): number {
  const k = identityKey(part);
  return project.parts.filter((p) => !p.suppressed && identityKey(p) === k).length || 1;
}

export interface ProfileBounds { x0: number; y0: number; x1: number; y1: number; zMin: number; zMax: number; empty: boolean }

/** True XY bounding box of all layer contours plus the Z range. */
export function geometryBounds(g: PartGeometry): ProfileBounds {
  const all: Poly[] = [];
  for (const l of g.layers) all.push(...l.contours);
  if (!all.length || !all.some((c) => c.length)) return { x0: 0, y0: 0, x1: 0, y1: 0, zMin: 0, zMax: 0, empty: true };
  const b = bounds(all);
  return { ...b, zMin: g.zMin, zMax: g.zMax, empty: false };
}

/** Returns a copy of the mesh translated so that its lowest point is at z = 0. */
export function restOnZ0(mesh: SolidMesh): SolidMesh {
  let zMin = Infinity;
  for (let i = 2; i < mesh.positions.length; i += 3) if (mesh.positions[i] < zMin) zMin = mesh.positions[i];
  if (!Number.isFinite(zMin) || zMin === 0) return mesh;
  const positions = new Float32Array(mesh.positions);
  for (let i = 2; i < positions.length; i += 3) positions[i] = positions[i] - zMin;
  return {
    ...mesh, positions,
    bbox: { min: [mesh.bbox.min[0], mesh.bbox.min[1], mesh.bbox.min[2] - zMin], max: [mesh.bbox.max[0], mesh.bbox.max[1], mesh.bbox.max[2] - zMin] },
  };
}

/**
 * The solid of a part in PART-LOCAL coordinates, resting on z = 0.
 * Returns null for empty geometry; throws if the kernel is not initialised.
 */
export function partMesh(project: Project, part: Part): SolidMesh | null {
  const g = geometryOf(project, part);
  const mesh = buildSolid(g.layers);
  return mesh ? restOnZ0(mesh) : null;
}

export function isHoleContour(c: Poly): boolean { return signedArea(c) < 0; }

/** Sorted (by z0, then z1) copy of the non-empty layers. */
export function sortedLayers(g: PartGeometry): PartGeometry['layers'] {
  return g.layers
    .filter((l) => l.contours.length > 0 && l.z1 - l.z0 > 1e-9)
    .slice()
    .sort((a, b) => a.z0 - b.z0 || a.z1 - b.z1);
}

/** Geometric fingerprint of a contour, independent of start vertex and orientation. */
export function contourKey(c: Poly): string {
  const b = bounds([c]);
  const r = (v: number) => (Math.round(v * 1e4) / 1e4).toFixed(4);
  return `${c.length}|${r(Math.abs(signedArea(c)))}|${r(b.x0)}|${r(b.y0)}|${r(b.x1)}|${r(b.y1)}`;
}

export function contourSetKey(contours: Poly[]): string {
  return contours.map(contourKey).sort().join(';');
}

export interface MatchedContours {
  /** CCW contours */
  outer: Poly[];
  /** CW contours that are NOT one of the exact circular holes */
  inner: Poly[];
  /** indices into geometry.holes of circular hole features present in this contour set */
  holeIdx: number[];
}

/**
 * Split a contour set into outer loops, non-circular inner loops, and the exact
 * circular holes: a CW polygon whose vertices all lie on the circle of a hole
 * feature (same centre, same radius) is replaced by that feature.
 */
export function matchHoles(contours: Poly[], holes: PartGeometry['holes']): MatchedContours {
  const out: MatchedContours = { outer: [], inner: [], holeIdx: [] };
  const used = new Set<number>();
  for (const c of contours) {
    if (c.length < 3) continue;
    if (!isHoleContour(c)) { out.outer.push(c); continue; }
    let hit = -1;
    for (let i = 0; i < holes.length && hit < 0; i++) {
      if (used.has(i)) continue;
      const h = holes[i], r = h.d / 2;
      // polygonised circles have their vertices on the circle; allow for other discretisations (≤ 0.05 mm / 2 %)
      const tol = Math.max(1e-6, Math.min(0.05, r * 0.02));
      if (c.length >= 8 && c.every(([x, y]) => Math.abs(Math.hypot(x - h.x, y - h.y) - r) <= tol)) hit = i;
    }
    if (hit >= 0) { used.add(hit); out.holeIdx.push(hit); } else out.inner.push(c);
  }
  out.holeIdx.sort((a, b) => a - b);
  return out;
}
