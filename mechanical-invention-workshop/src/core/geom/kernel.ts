/**
 * Geometry kernel wrapper around manifold-3d (WASM, Apache-2.0).
 * Solids are built as unions of extruded 2D regions; Manifold guarantees a
 * closed 2-manifold result, which is re-checked independently in meshCheck().
 */
import type { Layer } from '../parts/catalog';
import type { Poly } from '../math/poly';

type ManifoldModule = any;
let M: ManifoldModule | null = null;
let initPromise: Promise<void> | null = null;

/** Load the WASM kernel. In the browser pass the URL of manifold.wasm. */
export function initKernel(wasmUrl?: string): Promise<void> {
  if (M) return Promise.resolve();
  if (!initPromise) {
    initPromise = (async () => {
      const mod = await import('manifold-3d');
      const Module = (mod as any).default ?? mod;
      const inst = await Module(wasmUrl ? { locateFile: () => wasmUrl } : undefined);
      inst.setup();
      M = inst;
    })();
  }
  return initPromise;
}

export function kernelReady(): boolean { return M !== null; }

export interface SolidMesh {
  /** xyz triples, mm, part-local */
  positions: Float32Array;
  /** triangle vertex indices (CCW outward) */
  indices: Uint32Array;
  volume: number;
  surfaceArea: number;
  genus: number;
  /** kernel status string, 'NoError' when valid */
  status: string;
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

function crossSection(contours: Poly[]): any {
  return new M.CrossSection(contours as any, 'Positive');
}

/** Build one closed solid from an extrusion stack. Returns null for empty geometry. */
export function buildSolid(layers: Layer[]): SolidMesh | null {
  if (!M) throw new Error('Geometry kernel not initialised');
  const pieces: any[] = [];
  for (const l of layers) {
    if (!l.contours.length || l.z1 - l.z0 <= 1e-9) continue;
    const cs = crossSection(l.contours);
    if (cs.isEmpty()) { cs.delete(); continue; }
    const ex = cs.extrude(l.z1 - l.z0);
    const tr = ex.translate([0, 0, l.z0]);
    pieces.push(tr);
    cs.delete(); ex.delete();
  }
  if (!pieces.length) return null;
  const solid = pieces.length === 1 ? pieces[0] : M.Manifold.union(pieces);
  const mesh = solid.getMesh();
  const np = mesh.numProp;
  const nv = mesh.vertProperties.length / np;
  const positions = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    positions[3 * i] = mesh.vertProperties[np * i];
    positions[3 * i + 1] = mesh.vertProperties[np * i + 1];
    positions[3 * i + 2] = mesh.vertProperties[np * i + 2];
  }
  const indices = new Uint32Array(mesh.triVerts);
  const bb = solid.boundingBox();
  const out: SolidMesh = {
    positions, indices,
    volume: solid.volume(), surfaceArea: solid.surfaceArea(), genus: solid.genus(),
    status: String(solid.status?.() ?? 'NoError'),
    bbox: { min: [bb.min[0], bb.min[1], bb.min[2]], max: [bb.max[0], bb.max[1], bb.max[2]] },
  };
  if (pieces.length > 1) for (const p of pieces) p.delete();
  solid.delete();
  return out;
}

/** Area of the intersection of two contour sets (mm²). */
export function intersectionArea(a: Poly[], b: Poly[]): number {
  if (!M) return NaN;
  const ca = crossSection(a), cb = crossSection(b);
  const ci = ca.intersect(cb);
  const area = ci.area();
  ca.delete(); cb.delete(); ci.delete();
  return area;
}

/** Area and bounding-box centre of the intersection of two contour sets. */
export function intersectionInfo(a: Poly[], b: Poly[]): { area: number; x: number; y: number } {
  if (!M) return { area: NaN, x: NaN, y: NaN };
  const ca = crossSection(a), cb = crossSection(b);
  const ci = ca.intersect(cb);
  const area = ci.area();
  let x = NaN, y = NaN;
  if (area > 0) { const bb = ci.bounds(); x = (bb.min[0] + bb.max[0]) / 2; y = (bb.min[1] + bb.max[1]) / 2; }
  ca.delete(); cb.delete(); ci.delete();
  return { area, x, y };
}

/** Offset a contour set by delta (positive = grow), round joins. */
export function offsetContours(a: Poly[], delta: number): Poly[] {
  if (!M) throw new Error('Geometry kernel not initialised');
  const ca = crossSection(a);
  const co = ca.offset(delta, 'Round', 2, 32);
  const out = co.toPolygons() as Poly[];
  ca.delete(); co.delete();
  return out;
}

export function contoursArea(a: Poly[]): number {
  if (!M) return NaN;
  const ca = crossSection(a);
  const area = ca.area();
  ca.delete();
  return area;
}

/** Union / cleanup of a contour set into simple non-overlapping polygons. */
export function cleanContours(a: Poly[]): Poly[] {
  if (!M) return a;
  const ca = crossSection(a);
  const out = ca.toPolygons() as Poly[];
  ca.delete();
  return out;
}

export interface MeshCheck {
  closed: boolean;
  /** edges used by exactly one triangle */
  boundaryEdges: number;
  /** edges used by more than two triangles or with inconsistent orientation */
  nonManifoldEdges: number;
  degenerateTriangles: number;
  /** signed volume from the divergence theorem, mm³ */
  volume: number;
  triangles: number;
  vertices: number;
  /** Euler characteristic V − E + F */
  euler: number;
}

/**
 * Independent topological check of an indexed triangle mesh: every directed
 * edge must be matched by exactly one opposite directed edge.
 */
export function meshCheck(positions: Float32Array | Float64Array, indices: Uint32Array): MeshCheck {
  const nv = positions.length / 3;
  const nt = indices.length / 3;
  const edges = new Map<number, number>(); // key a*nv+b → count
  let degenerate = 0, vol = 0;
  for (let t = 0; t < nt; t++) {
    const a = indices[3 * t], b = indices[3 * t + 1], c = indices[3 * t + 2];
    if (a === b || b === c || a === c) { degenerate++; continue; }
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      const k = u * nv + v;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
    const ax = positions[3 * a], ay = positions[3 * a + 1], az = positions[3 * a + 2];
    const bx = positions[3 * b], by = positions[3 * b + 1], bz = positions[3 * b + 2];
    const cx = positions[3 * c], cy = positions[3 * c + 1], cz = positions[3 * c + 2];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  let boundary = 0, nonManifold = 0, undirected = 0;
  for (const [k, n] of edges) {
    const u = Math.floor(k / nv), v = k % nv;
    const opp = edges.get(v * nv + u) ?? 0;
    if (n > 1) nonManifold++;
    else if (opp === 0) boundary++;
    else if (opp > 1) nonManifold++;
    if (u < v || opp === 0) undirected++;
  }
  return {
    closed: boundary === 0 && nonManifold === 0 && degenerate === 0,
    boundaryEdges: boundary, nonManifoldEdges: nonManifold, degenerateTriangles: degenerate,
    volume: vol, triangles: nt, vertices: nv, euler: nv - undirected + (nt - degenerate),
  };
}
