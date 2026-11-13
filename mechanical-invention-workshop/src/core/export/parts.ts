/**
 * Per-part mesh export (STL, 3MF). A part is written in PART-LOCAL
 * coordinates (mm), resting on z = 0. Parts whose solid is not a valid closed
 * manifold are refused — never silently exported.
 */
import type { Part, Project } from '../model/types';
import { partById } from '../model/project';
import type { SolidMesh } from '../geom/kernel';
import { partMesh, sanitizeName } from './common';
import { reportForMesh, type PrintReport } from './printcheck';
import { meshToBinarySTL } from './stl';
import { meshesTo3MF, type ThreeMFItem } from './threemf';

/** Stable identifier of a part: "P" + 1-based index in project.parts. Used in BOM, drawings, guide and 3MF. */
export function partNumber(project: Project, partId: string): string {
  const i = project.parts.findIndex((p) => p.id === partId);
  return i >= 0 ? `P${i + 1}` : 'P?';
}

export function partFileBase(project: Project, part: Part): string {
  return `${sanitizeName(project.name, 'project')}_${partNumber(project, part.id)}_${sanitizeName(part.name, 'part')}`;
}

function missingReport(partId: string): PrintReport {
  return {
    partId, name: '', exportable: false, mesh: null, kernelStatus: 'NoSolid', size: [0, 0, 0], volume: 0,
    issues: [{ severity: 'error', message: `No part with id "${partId}" exists in this project.` }],
  };
}

/** Build the solid and its report in one go (the mesh is null when not exportable). */
export function buildExportMesh(project: Project, part: Part): { mesh: SolidMesh | null; report: PrintReport } {
  let mesh: SolidMesh | null = null;
  let err: string | undefined;
  try { mesh = partMesh(project, part); } catch (e) { err = e instanceof Error ? e.message : String(e); }
  const report = reportForMesh(project, part, mesh, err);
  return { mesh: report.exportable ? mesh : null, report };
}

/** STL bytes for an already checked mesh; refuses when the report says the solid is not exportable. */
export function stlFromReport(mesh: SolidMesh | null, report: PrintReport, name: string): Uint8Array | undefined {
  if (!mesh || !report.exportable) return undefined;
  return meshToBinarySTL(mesh, name);
}

export function exportPartSTL(project: Project, partId: string): { ok: boolean; filename: string; bytes?: Uint8Array; report: PrintReport } {
  const part = partById(project, partId);
  if (!part) return { ok: false, filename: `${sanitizeName(project.name, 'project')}_unknown.stl`, report: missingReport(partId) };
  const filename = `${partFileBase(project, part)}.stl`;
  const { mesh, report } = buildExportMesh(project, part);
  const bytes = stlFromReport(mesh, report, `${partNumber(project, part.id)} ${part.name}`);
  return bytes ? { ok: true, filename, bytes, report } : { ok: false, filename, report };
}

/**
 * One 3MF package with every exportable part of `partIds` as its own object.
 * Non-exportable parts are skipped and listed in `reports`; ok = false when nothing could be exported.
 */
export function exportParts3MF(project: Project, partIds: string[]): { ok: boolean; filename: string; bytes?: Uint8Array; reports: PrintReport[] } {
  const filename = `${sanitizeName(project.name, 'project')}_parts.3mf`;
  const reports: PrintReport[] = [];
  const items: ThreeMFItem[] = [];
  for (const id of partIds) {
    const part = partById(project, id);
    if (!part) { reports.push(missingReport(id)); continue; }
    const { mesh, report } = buildExportMesh(project, part);
    reports.push(report);
    if (mesh) items.push({ name: part.name, partNumber: partNumber(project, part.id), mesh });
  }
  if (!items.length) return { ok: false, filename, reports };
  return { ok: true, filename, bytes: meshesTo3MF(items, project.name), reports };
}
