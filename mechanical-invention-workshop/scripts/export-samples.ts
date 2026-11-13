/**
 * Writes sample manufacturing exports plus a manifest of EXPECTED values that
 * are computed from the parametric model (never from the exported bytes).
 * The manifest is what scripts/verify_exports.py checks the files against.
 *
 *   npx tsx scripts/export-samples.ts [outDir] [examplesDir]
 *     outDir       default exports/samples
 *     examplesDir  default public/examples — every *.json project in it is exported as well
 */
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initKernel } from '../src/core/geom/kernel';
import { createPart, createProject, geometryOf, massProps, materialOf, normalizeProject } from '../src/core/model/project';
import { GROUND, type Part, type Project } from '../src/core/model/types';
import { PART_DEFS } from '../src/core/parts/catalog';
import {
  assemblyGuideHTML, bomCSV, buildBOM, buildExportMesh, exportParts3MF, geometryBounds, identicalCount, partDrawingSVG,
  partFileBase, partNumber, partProfileDXF, partProfileSVG, profileData, sanitizeName, stlFromReport, activeJoints,
} from '../src/core/export/index';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- demo project

function demoProject(): Project {
  const p = createProject('Export demo', 'export-demo');
  p.description = 'A four-bar linkage on a base plate with a belt drive, a gear, a cam and a slotted rail. Built in scripts/export-samples.ts to exercise every exporter.';
  const O2 = { x: -50, y: -20 }, O4 = { x: 30, y: -20 };
  const crankLen = 30, couplerLen = 80, rockerLen = 50;
  const th = (60 * Math.PI) / 180;
  const A = { x: O2.x + crankLen * Math.cos(th), y: O2.y + crankLen * Math.sin(th) };
  // B = intersection of circle(A, coupler) and circle(O4, rocker), upper solution
  const dx = O4.x - A.x, dy = O4.y - A.y, d = Math.hypot(dx, dy);
  const a = (couplerLen ** 2 - rockerLen ** 2 + d * d) / (2 * d);
  const hgt = Math.sqrt(Math.max(0, couplerLen ** 2 - a * a));
  const B = { x: A.x + (a * dx) / d - (hgt * dy) / d, y: A.y + (a * dy) / d + (hgt * dx) / d };

  const base = createPart('baseplate', 'base', 'Base plate', {
    width: 160, height: 120, thickness: 4, cornerRadius: 6,
    holes: [{ x: O2.x, y: O2.y, d: 4 }, { x: O4.x, y: O4.y, d: 4 }, { x: 55, y: 40, d: 5 }],
  }, { z: 0 });
  base.grounded = true;
  base.materialId = 'plywood';
  p.parts.push(base);
  p.parts.push(createPart('link', 'crank', 'Crank', { length: crankLen, width: 10, thickness: 4, holeDiameter: 4 }, { x: O2.x, y: O2.y, angle: th, z: 4 }));
  p.parts.push(createPart('link', 'coupler', 'Coupler', { length: couplerLen, width: 10, thickness: 4, holeDiameter: 4 }, { x: A.x, y: A.y, angle: Math.atan2(B.y - A.y, B.x - A.x), z: 8 }));
  p.parts.push(createPart('link', 'rocker', 'Rocker', { shape: 'ternary', length: rockerLen, sideAC: 40, sideBC: 40, width: 10, thickness: 4, holeDiameter: 4 }, { x: O4.x, y: O4.y, angle: Math.atan2(B.y - O4.y, B.x - O4.x), z: 4 }));
  p.parts.push(createPart('gear', 'gear', 'Gear 20T', { module: 2, teeth: 20, thickness: 6, boreDiameter: 5 }, { x: 55, y: 40, z: 4 }));
  p.parts.push(createPart('cam', 'cam', 'Cam', { thickness: 6, boreDiameter: 5 }, { x: 55, y: 40, z: 10 }));
  p.parts.push(createPart('pulley', 'pulleyA', 'Drive pulley', { pitchDiameter: 20, boreDiameter: 5 }, { x: -55, y: 40, z: 4 }));
  p.parts.push(createPart('pulley', 'pulleyB', 'Crank pulley', { pitchDiameter: 40, boreDiameter: 5, pinRadius: 10, pinDiameter: 4 }, { x: 0, y: 40, z: 4 }));
  p.parts.push(createPart('rail', 'rail', 'Slotted rail', { length: 80, slotWidth: 10, width: 22, overtravel: 12, thickness: 5 }, { x: -40, y: -48, z: 4 }));
  p.parts.push(createPart('link', 'tie1', 'Tie bar', { length: 60, width: 10, thickness: 4, holeDiameter: 4 }, { x: -70, y: 10, angle: Math.PI / 2, z: 4 }));
  p.parts.push(createPart('link', 'tie2', 'Tie bar', { length: 60, width: 10, thickness: 4, holeDiameter: 4 }, { x: 70, y: -40, angle: Math.PI / 2, z: 4 }));
  p.parts.push(createPart('shaft', 'shaft', 'Gear shaft', { diameter: 5, length: 20 }, { x: 55, y: 40, z: 0 }));

  p.joints.push(
    { id: 'j1', name: 'Crank pivot', type: 'revolute', a: 'base', b: 'crank', anchorA: { port: 'H1' }, anchorB: { port: 'A' } },
    { id: 'j2', name: 'Crank pin', type: 'revolute', a: 'crank', b: 'coupler', anchorA: { port: 'B' }, anchorB: { port: 'A' } },
    { id: 'j3', name: 'Rocker pin', type: 'revolute', a: 'coupler', b: 'rocker', anchorA: { port: 'B' }, anchorB: { port: 'B' } },
    { id: 'j4', name: 'Rocker pivot', type: 'revolute', a: 'base', b: 'rocker', anchorA: { port: 'H2' }, anchorB: { port: 'A' } },
    { id: 'j5', name: 'Shaft seat', type: 'rigid', a: 'base', b: 'shaft', anchorA: { port: 'H3' }, anchorB: { port: 'center' } },
    { id: 'j6', name: 'Gear bearing', type: 'revolute', a: 'shaft', b: 'gear', anchorA: { port: 'center' }, anchorB: { port: 'center' } },
    { id: 'j7', name: 'Cam on gear', type: 'rigid', a: 'gear', b: 'cam', anchorA: { port: 'center' }, anchorB: { port: 'center' }, angle: 0 },
    {
      id: 'j8', name: 'Drive axle', type: 'revolute', a: GROUND, b: 'pulleyA', anchorA: { x: -55, y: 40 }, anchorB: { port: 'center' }, pinDiameter: 5,
      motor: { enabled: true, type: 'servo', speed: 2 * Math.PI, maxTorque: 2e5, rampTime: 0.2, profile: 'constant' },
    },
    { id: 'j9', name: 'Crank pulley axle', type: 'revolute', a: GROUND, b: 'pulleyB', anchorA: { x: 0, y: 40 }, anchorB: { port: 'center' }, pinDiameter: 5 },
    { id: 'j10', name: 'Drive belt', type: 'belt', a: 'pulleyA', b: 'pulleyB', anchorA: { port: 'center' }, anchorB: { port: 'center' } },
    { id: 'j11', name: 'Rail mount', type: 'rigid', a: 'base', b: 'rail', anchorA: { x: -40, y: -48 }, anchorB: { port: 'start' } },
    { id: 'j12', name: 'Return spring', type: 'spring', a: GROUND, b: 'rocker', anchorA: { x: 70, y: 30 }, anchorB: { port: 'C' }, stiffness: 300, preload: 600, coilDiameter: 6, wireDiameter: 0.6 },
  );
  return p;
}

// ---------------------------------------------------------------- expectations

/** Key parametric dimensions, straight from the part parameters. */
function parametricExpectations(project: Project, part: Part) {
  const p = part.params;
  const g = geometryOf(project, part);
  const cl = project.clearances;
  const key: Record<string, number | string> = {};
  const linear: number[] = [];
  const diameters: number[] = [];
  let closedFormBBox: [number, number, number] | null = null;
  let maxRadius: number | null = null;
  switch (part.kind) {
    case 'link':
      key.length = p.length; key.width = p.width; key.thickness = p.thickness; key.holeDiameter = p.holeDiameter + cl.hole;
      linear.push(p.length, p.thickness);
      if (p.shape === 'ternary') { key.sideAC = p.sideAC; key.sideBC = p.sideBC; linear.push(p.sideAC, p.sideBC); }
      else closedFormBBox = [p.length + p.width, p.width, p.thickness];
      if (g.holes.length) diameters.push(p.holeDiameter + cl.hole);
      break;
    case 'gear': {
      const teeth = Math.round(p.teeth);
      key.teeth = teeth; key.module = p.module; key.pitchDiameter = p.module * teeth; key.thickness = p.thickness;
      const reduced = g.warnings.some((w) => /tip diameter was reduced/i.test(w));
      if (!reduced) { key.tipDiameter = (teeth + 2) * p.module; maxRadius = ((teeth + 2) * p.module) / 2; diameters.push((teeth + 2) * p.module); }
      diameters.push(p.module * teeth);
      linear.push(p.thickness);
      break;
    }
    case 'cam':
      key.thickness = p.thickness;
      if (p.profile === 'eccentric') { key.discRadius = p.discRadius; key.eccentricity = p.eccentricity; maxRadius = p.discRadius + p.eccentricity; }
      else key.baseRadius = p.baseRadius;
      linear.push(p.thickness);
      break;
    case 'pulley': {
      const rc = Math.max(p.pitchDiameter / 2 - p.beltThickness / 2, 1);
      const rf = rc + p.beltThickness + p.flangeHeight;
      const width = 2 * p.flangeThickness + p.beltWidth + 2 * cl.slide;
      key.pitchDiameter = p.pitchDiameter; key.flangeDiameter = 2 * rf; key.beltSeatDiameter = 2 * rc; key.overallWidth = width;
      closedFormBBox = [2 * rf, 2 * rf, width];
      maxRadius = rf;
      linear.push(width);
      diameters.push(2 * rf, 2 * rc);
      if (g.ports.some((q) => q.id === 'pin')) { key.crankThrow = p.pinRadius; linear.push(p.pinRadius); }
      break;
    }
    case 'baseplate':
      key.width = p.width; key.height = p.height; key.thickness = p.thickness;
      closedFormBBox = [p.width, p.height, p.thickness];
      linear.push(p.width, p.height, p.thickness);
      break;
    case 'rail': {
      const w = Math.max(p.width, p.slotWidth + 2 * cl.minFeature + 0.01);
      if (p.openEnds) {
        // two separate guide bars: no end walls, so the overall length is just the channel length
        const len = p.length + 2 * p.overtravel;
        key.overallLength = len; key.width = w; key.thickness = p.thickness; key.channelWidth = p.slotWidth;
        const capT = Math.max(1.5, 1.5 * cl.minFeature);
        closedFormBBox = [len, w, p.thickness + capT];
        linear.push(len, w, p.slotWidth);
        break;
      }
      const overall = p.length + 2 * p.overtravel + (w - p.slotWidth);
      key.overallLength = overall; key.width = w; key.thickness = p.thickness; key.slotLength = p.length + 2 * p.overtravel; key.slotWidth = p.slotWidth;
      closedFormBBox = [overall, w, p.thickness];
      linear.push(overall, w, p.length + 2 * p.overtravel, p.thickness);
      break;
    }
    case 'crank':
      key.diameter = p.diameter; key.thickness = p.thickness; key.crankThrow = p.pinRadius;
      closedFormBBox = [p.diameter, p.diameter, p.thickness];
      maxRadius = p.diameter / 2;
      linear.push(p.pinRadius, p.thickness);
      diameters.push(p.diameter);
      break;
    case 'slider': {
      const w = Math.max(p.width - 2 * cl.slide, 0.2);
      key.length = p.length; key.width = w; key.thickness = p.thickness;
      closedFormBBox = [p.length, w, p.thickness];
      linear.push(p.length, w, p.thickness);
      break;
    }
    case 'follower':
      key.stemLength = p.stemLength; key.rollerDiameter = p.rollerDiameter; key.thickness = p.thickness;
      linear.push(p.stemLength, p.thickness);
      diameters.push(p.rollerDiameter);
      break;
    default:
      if (typeof p.thickness === 'number') { key.thickness = p.thickness; linear.push(p.thickness); }
  }
  return { key, linear, diameters, closedFormBBox, maxRadius };
}

/** Topological genus when it follows directly from the layer description, else null. */
function expectedTopology(project: Project, part: Part): { genus: number | null; bodies: number | null } {
  const g = geometryOf(project, part);
  const layers = g.layers.filter((l) => l.contours.length && l.z1 - l.z0 > 1e-9).slice().sort((a, b) => a.z0 - b.z0);
  if (!layers.length) return { genus: null, bodies: null };
  const area = (c: [number, number][]) => { let s = 0; for (let i = 0; i < c.length; i++) { const [x0, y0] = c[i], [x1, y1] = c[(i + 1) % c.length]; s += x0 * y1 - x1 * y0; } return s / 2; };
  const counts = layers.map((l) => ({ outer: l.contours.filter((c) => area(c) > 0).length, holes: l.contours.filter((c) => area(c) < 0).length }));
  if (layers.length === 1) return counts[0].outer === 1 ? { genus: counts[0].holes, bodies: 1 } : { genus: null, bodies: counts[0].outer };
  // stacked layers that all carry the same through-holes (e.g. a flanged pulley)
  const contiguous = layers.every((l, i) => i === 0 || Math.abs(l.z0 - layers[i - 1].z1) < 1e-9);
  const sameHoles = counts.every((c) => c.outer === 1 && c.holes === counts[0].holes);
  const through = g.holes.length === counts[0].holes;
  return contiguous && sameHoles && through ? { genus: counts[0].holes, bodies: 1 } : { genus: null, bodies: null };
}

// ---------------------------------------------------------------- export of one project

interface Summary { slug: string; name: string; parts: number; exported: number; refused: number; files: number }

function exportProject(project: Project, slug: string, outRoot: string): Summary {
  const dir = join(outRoot, slug);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let files = 0;
  const write = (name: string, data: string | Uint8Array) => { writeFileSync(join(dir, name), data); files++; return name; };

  const live = project.parts.filter((p) => !p.suppressed);
  const custom = live.filter((p) => !PART_DEFS[p.kind].purchased);
  const partEntries: any[] = [];
  const meshIds: string[] = [];
  const meshInfo = new Map<string, { triangles: number }>();
  let refused = 0;

  for (const part of custom) {
    const pn = partNumber(project, part.id);
    const base = partFileBase(project, part);
    const g = geometryOf(project, part);
    const gb = geometryBounds(g);
    const mp = massProps(project, part);
    const par = parametricExpectations(project, part);
    const topo = expectedTopology(project, part);
    const geomSize: [number, number, number] = [gb.x1 - gb.x0, gb.y1 - gb.y0, gb.zMax - gb.zMin];
    if (par.closedFormBBox) {
      const dev = Math.max(...par.closedFormBBox.map((v, i) => Math.abs(v - geomSize[i])));
      if (dev > 1e-6) throw new Error(`${pn} ${part.name}: closed-form bbox ${par.closedFormBBox} disagrees with the geometry bbox ${geomSize}`);
    }
    const { mesh, report } = buildExportMesh(project, part);
    const stlBytes = stlFromReport(mesh, report, `${pn} ${part.name}`);
    const filesOut: Record<string, string | null> = { stl: null, drawing: null, dxf: null, profileSvg: null };
    if (stlBytes && mesh) {
      filesOut.stl = write(`${base}.stl`, stlBytes);
      meshIds.push(part.id);
      meshInfo.set(part.id, { triangles: mesh.indices.length / 3 });
    } else refused++;
    const hasProfile = !gb.empty;
    if (hasProfile) {
      filesOut.drawing = write(`${base}_drawing.svg`, partDrawingSVG(project, part.id));
      filesOut.dxf = write(`${base}_profile.dxf`, partProfileDXF(project, part.id));
      filesOut.profileSvg = write(`${base}_profile.svg`, partProfileSVG(project, part.id));
    }
    const pd = profileData(project, part);
    partEntries.push({
      partNumber: pn, partId: part.id, name: part.name, kind: part.kind,
      material: materialOf(project, part.materialId).name, qty: identicalCount(project, part),
      exportable: report.exportable,
      files: filesOut,
      expected: {
        bboxSize: par.closedFormBBox ?? geomSize,
        bboxSource: par.closedFormBBox ? 'closed-form from parameters' : 'parametric layer contours',
        bboxXY: [gb.x0, gb.y0, gb.x1, gb.y1],
        volume: mp.volume,
        massKg: mp.mass,
        genus: topo.genus,
        bodies: topo.bodies,
        triangles: meshInfo.get(part.id)?.triangles ?? null,
        holes: g.holes.map((h) => ({ label: h.label, x: h.x, y: h.y, d: h.d, nominal: h.nominal })),
        maxRadiusXY: par.maxRadius,
        keyDims: par.key,
        drawingLinearDims: par.linear,
        drawingDiameterDims: par.diameters,
        dxfLayers: pd.layerNames,
        dxfPrimaryOuterLoops: pd.layers[0]?.outer.length ?? 0,
        dxfPrimaryInnerLoops: pd.layers[0]?.inner.length ?? 0,
      },
      printReport: { kernelStatus: report.kernelStatus, issues: report.issues },
    });
  }

  // combined 3MF of every exportable custom part
  let threemf: any = null;
  const pkg = exportParts3MF(project, custom.map((p) => p.id));
  if (pkg.ok && pkg.bytes) {
    const file = write(pkg.filename, pkg.bytes);
    threemf = {
      file, unit: 'millimeter',
      objects: meshIds.map((id) => {
        const part = project.parts.find((p) => p.id === id)!;
        const gb = geometryBounds(geometryOf(project, part));
        return {
          name: part.name, partNumber: partNumber(project, id), triangles: meshInfo.get(id)!.triangles,
          volume: massProps(project, part).volume, bboxSize: [gb.x1 - gb.x0, gb.y1 - gb.y0, gb.zMax - gb.zMin],
        };
      }),
    };
  }

  const rows = buildBOM(project);
  const bomFile = write('bom.csv', bomCSV(rows));
  const guideFile = write('assembly-guide.html', assemblyGuideHTML(project));
  const manifest = {
    format: 'mechanism-workshop-export-manifest', version: 1,
    generator: 'scripts/export-samples.ts',
    units: { length: 'mm', volume: 'mm3', mass: 'kg' },
    note: 'Expected values are computed from the parametric model (parameters, layer contours, massProps), not from the exported files.',
    project: { id: project.id, name: project.name, slug, parts: live.length, joints: activeJoints(project).length, clearances: project.clearances },
    parts: partEntries,
    threemf,
    bom: {
      file: bomFile, rows: rows.length,
      customRows: rows.filter((r) => r.category === 'custom').length,
      purchasedRows: rows.filter((r) => r.category === 'purchased').length,
      totalQty: rows.reduce((s, r) => s + r.qty, 0),
      partNumbers: live.map((p) => partNumber(project, p.id)),
    },
    guide: {
      file: guideFile,
      partNumbers: live.map((p) => partNumber(project, p.id)),
      // only parts that have geometry can carry a balloon in the exploded views
      balloonPartNumbers: live.filter((p) => !geometryBounds(geometryOf(project, p)).empty).map((p) => partNumber(project, p.id)),
      jointNames: activeJoints(project).map((j) => j.name),
    },
  };
  write('manifest.json', JSON.stringify(manifest, null, 1));
  return { slug, name: project.name, parts: live.length, exported: meshIds.length, refused, files };
}

// ---------------------------------------------------------------- main

async function main() {
  const outRoot = resolve(process.argv[2] ?? join(ROOT, 'exports', 'samples'));
  await initKernel();
  mkdirSync(outRoot, { recursive: true });
  const jobs: { project: Project; slug: string }[] = [{ project: demoProject(), slug: 'export-demo' }];

  const exDir = resolve(process.argv[3] ?? join(ROOT, 'public', 'examples'));
  if (existsSync(exDir)) {
    for (const f of readdirSync(exDir).filter((n) => n.toLowerCase().endsWith('.json')).sort()) {
      try {
        const raw = JSON.parse(readFileSync(join(exDir, f), 'utf8'));
        if (!raw || raw.format !== 'mechanism-workshop') { console.log(`skip   ${f} (not a project file)`); continue; }
        const project = normalizeProject(raw);
        let slug = sanitizeName(basename(f, '.json'), 'example');
        while (jobs.some((j) => j.slug === slug)) slug += '-example';
        jobs.push({ project, slug });
      } catch (e) {
        console.log(`skip   ${f}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  let failed = false;
  for (const job of jobs) {
    try {
      const s = exportProject(job.project, job.slug, outRoot);
      console.log(`export ${s.slug}: "${s.name}" — ${s.parts} parts, ${s.exported} solids exported, ${s.refused} refused, ${s.files} files`);
    } catch (e) {
      failed = true;
      console.error(`FAILED ${job.slug}: ${e instanceof Error ? e.stack ?? e.message : e}`);
    }
  }
  console.log(`wrote ${jobs.length} project(s) to ${outRoot}`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
