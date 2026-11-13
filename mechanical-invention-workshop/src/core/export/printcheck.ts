/**
 * Pre-export validation: is the solid a closed manifold (hard requirement for
 * export), and which details may not be manufacturable at the project's
 * minimum feature size (warnings).
 */
import type { Part, Project } from '../model/types';
import { geometryOf, massProps } from '../model/project';
import { PART_DEFS, type PartGeometry } from '../parts/catalog';
import { contoursArea, meshCheck, offsetContours, type MeshCheck, type SolidMesh } from '../geom/kernel';
import type { Poly } from '../math/poly';
import { fmt, geometryBounds, partMesh } from './common';

export interface PrintIssue { severity: 'error' | 'warning' | 'info'; message: string }

export interface PrintReport {
  partId: string;
  name: string;
  /** false → exporters refuse to write this part */
  exportable: boolean;
  mesh: MeshCheck | null;
  kernelStatus: string;
  /** bounding box size, mm */
  size: [number, number, number];
  /** mm³ */
  volume: number;
  issues: PrintIssue[];
}

/** Common desktop FDM bed edge, mm. */
export const COMMON_BED = 220;

export const HUMAN_VALIDATION_NOTE =
  'Material, manufacturing process and real-world load suitability are not verified by this tool and must be validated by a qualified person.';

export interface ThinFeatureResult { area: number; lost: number; fraction: number; flagged: boolean }

/**
 * Morphological opening (erode then dilate by minFeature/2). Whatever does not
 * survive is narrower than minFeature: thin walls, slivers, sharp tips.
 */
export function thinFeatureLoss(contours: Poly[], minFeature: number): ThinFeatureResult {
  const area = contoursArea(contours);
  if (!(minFeature > 0) || !(area > 0)) return { area: area || 0, lost: 0, fraction: 0, flagged: false };
  const r = minFeature / 2;
  const eroded = offsetContours(contours, -r);
  const opened = eroded.length ? offsetContours(eroded, r) : [];
  const openedArea = opened.length ? contoursArea(opened) : 0;
  const lost = Math.max(0, area - openedArea);
  const fraction = lost / area;
  return { area, lost, fraction, flagged: lost > 0.5 || fraction > 0.005 };
}

/**
 * Build the report for a part given an already built mesh (or null when the
 * part has no solid). Exposed so that the refusal path can be tested with a
 * deliberately damaged mesh.
 */
export function reportForMesh(project: Project, part: Part, mesh: SolidMesh | null, kernelError?: string): PrintReport {
  const g: PartGeometry = geometryOf(project, part);
  const issues: PrintIssue[] = [];
  const gb = geometryBounds(g);
  let size: [number, number, number] = [gb.x1 - gb.x0, gb.y1 - gb.y0, gb.zMax - gb.zMin];
  let check: MeshCheck | null = null;
  let exportable = true;
  let volume = 0;
  let kernelStatus = mesh ? mesh.status : kernelError ? 'KernelError' : 'NoSolid';

  if (!mesh) {
    exportable = false;
    issues.push({
      severity: 'error',
      message: kernelError
        ? `The geometry kernel could not build a solid for this part (${kernelError}). Nothing was exported.`
        : 'This part has no solid geometry (empty or zero-thickness profile), so there is nothing to export.',
    });
  } else {
    size = [mesh.bbox.max[0] - mesh.bbox.min[0], mesh.bbox.max[1] - mesh.bbox.min[1], mesh.bbox.max[2] - mesh.bbox.min[2]];
    check = meshCheck(mesh.positions, mesh.indices);
    volume = check.volume;
    kernelStatus = mesh.status;
    if (mesh.status !== 'NoError') {
      exportable = false;
      issues.push({ severity: 'error', message: `The geometry kernel reported "${mesh.status}" for this solid; it is not a valid manifold and was not exported.` });
    }
    if (check.triangles === 0) {
      exportable = false;
      issues.push({ severity: 'error', message: 'The solid has no triangles; nothing was exported.' });
    } else if (!check.closed) {
      exportable = false;
      const why: string[] = [];
      if (check.boundaryEdges) why.push(`${check.boundaryEdges} open (boundary) edge${check.boundaryEdges === 1 ? '' : 's'}`);
      if (check.nonManifoldEdges) why.push(`${check.nonManifoldEdges} non-manifold edge${check.nonManifoldEdges === 1 ? '' : 's'}`);
      if (check.degenerateTriangles) why.push(`${check.degenerateTriangles} degenerate triangle${check.degenerateTriangles === 1 ? '' : 's'}`);
      issues.push({ severity: 'error', message: `The mesh is not a closed manifold (${why.join(', ')}). A slicer would misinterpret it, so the export was refused.` });
    }
    if (!(check.volume > 0) || !Number.isFinite(check.volume)) {
      exportable = false;
      issues.push({ severity: 'error', message: `The solid has no positive volume (${fmt(check.volume, 3)} mm³): faces are inverted or the part is empty. Export refused.` });
    }
    if (exportable) {
      const mp = massProps(project, part);
      if (mp.volume > 0 && Math.abs(check.volume - mp.volume) / mp.volume > 0.005) {
        issues.push({
          severity: 'warning',
          message: `Mesh volume ${fmt(check.volume, 1)} mm³ differs from the layer-sum volume ${fmt(mp.volume, 1)} mm³ used for mass (overlapping layers or self-intersecting profile).`,
        });
      }
    }
  }

  // ---- manufacturability hints (never block the export) -------------------
  const mf = project.clearances.minFeature;
  for (const e of g.errors) {
    exportable = false;
    issues.push({ severity: 'error', message: `Model: ${e} Export refused: the solid would not be the part that was specified.` });
  }
  for (const w of g.warnings) issues.push({ severity: 'warning', message: `Model: ${w}` });

  if (mesh && mf > 0) {
    const multi = g.layers.length > 1;
    const seen = new Set<string>();
    for (const l of g.layers) {
      if (!l.contours.length || l.z1 - l.z0 <= 1e-9) continue;
      const where = multi ? ` in layer z ${fmt(l.z0 - g.zMin)}–${fmt(l.z1 - g.zMin)} mm` : '';
      let res: ThinFeatureResult | null = null;
      try { res = thinFeatureLoss(l.contours, mf); } catch { res = null; }
      if (res && res.flagged) {
        const msg = `Thin walls / fine features${where}: ${fmt(res.lost, 2)} mm² (${fmt(res.fraction * 100, 2)} %) of the profile is narrower than the minimum feature size ${fmt(mf)} mm and may not print or cut cleanly (e.g. thin rims, tooth tips, sharp corners).`;
        if (!seen.has(msg)) { seen.add(msg); issues.push({ severity: 'warning', message: msg }); }
      }
      if (l.z1 - l.z0 < mf - 1e-9) {
        issues.push({ severity: 'warning', message: `Layer z ${fmt(l.z0 - g.zMin)}–${fmt(l.z1 - g.zMin)} mm is only ${fmt(l.z1 - l.z0)} mm thick, below the minimum feature size ${fmt(mf)} mm.` });
      }
    }
    for (const h of g.holes) {
      if (h.d < 2 * mf - 1e-9) {
        issues.push({ severity: 'warning', message: `Hole ${h.label} (⌀${fmt(h.d)} mm) is smaller than twice the minimum feature size (${fmt(2 * mf)} mm) and may close up or need drilling.` });
      }
    }
  }
  if (size[0] > COMMON_BED || size[1] > COMMON_BED || size[2] > COMMON_BED) {
    issues.push({ severity: 'warning', message: `Part measures ${fmt(size[0], 1)} × ${fmt(size[1], 1)} × ${fmt(size[2], 1)} mm and exceeds a common print volume (${COMMON_BED} mm per axis).` });
  }
  if (PART_DEFS[part.kind]?.purchased) {
    issues.push({ severity: 'info', message: 'Purchased component — exported envelope geometry is for reference/fit checks only.' });
  }
  issues.push({ severity: 'info', message: HUMAN_VALIDATION_NOTE });

  return { partId: part.id, name: part.name, exportable, mesh: check, kernelStatus, size, volume, issues };
}

/** Build the part's solid and report whether it can be exported / printed. Never throws. */
export function checkPrintable(project: Project, part: Part): PrintReport {
  let mesh: SolidMesh | null = null;
  let err: string | undefined;
  try {
    mesh = partMesh(project, part);
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  return reportForMesh(project, part, mesh, err);
}
