import { describe, it, expect, beforeAll } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { initKernel, meshCheck, type SolidMesh } from '../src/core/geom/kernel';
import { createPart, createProject, geometryOf, massProps, materialOf } from '../src/core/model/project';
import { GROUND, type PartKind, type Project } from '../src/core/model/types';
import { PART_DEFS } from '../src/core/parts/catalog';
import { newSketch, addPoint, addCircle, rectangle } from '../src/core/sketch/ops';
import {
  meshToBinarySTL, parseBinarySTL, meshesTo3MF, parse3MF, f32str,
  checkPrintable, reportForMesh, thinFeatureLoss, HUMAN_VALIDATION_NOTE,
  partNumber, exportPartSTL, exportParts3MF, stlFromReport, buildExportMesh, partMesh,
  partDrawingSVG, partProfileDXF, partProfileSVG, profileData,
  buildBOM, bomCSV, beltLength, pinSpec,
  assemblyGuideHTML, explodedViewSVG, assemblySteps,
} from '../src/core/export/index';

beforeAll(async () => { await initKernel(); });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Project with pinned clearances so the numeric expectations do not depend on app defaults. */
function mkProject(name: string, id = 'test'): Project {
  const p = createProject(name, id);
  p.clearances = { hole: 0.2, slide: 0.15, backlash: 0.1, minFeature: 0.8 };
  return p;
}

const LINK = { shape: 'binary', length: 60, width: 10, thickness: 4, holeDiameter: 4 };
const PULLEY = { pitchDiameter: 30, beltWidth: 6, beltThickness: 1.5, flangeHeight: 2, flangeThickness: 1.2, boreDiameter: 5, pinRadius: 0, pinDiameter: 4 };
const GEAR = { module: 2, teeth: 20, pressureAngle: (20 * Math.PI) / 180, thickness: 6, boreDiameter: 5, pinRadius: 0 };
const PLATE = { width: 120, height: 60, thickness: 4, cornerRadius: 4, holes: [{ x: -40, y: 0, d: 4 }, { x: 40, y: 0, d: 4 }] };

function linkProject(params: Record<string, any> = {}): Project {
  const p = mkProject('Test rig');
  p.parts.push(createPart('link', 'l1', 'Link', { ...LINK, ...params }));
  return p;
}

function meshBounds(positions: Float32Array) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], positions[i + k]); max[k] = Math.max(max[k], positions[i + k]);
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/** Tiny XML sanity check: balanced, properly nested tags; quoted attributes; no stray '<' or bare '&' in text. */
function xmlCheck(xml: string): { ok: boolean; error?: string; elements: number; root?: string } {
  let s = xml.replace(/^\uFEFF?\s*<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE[^>]*>/i, '');
  const stack: string[] = [];
  let elements = 0, root: string | undefined, pos = 0;
  const tag = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*="[^"<]*")*)\s*(\/?)>/y;
  const badEntity = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;
  s = s.trim();
  while (pos < s.length) {
    const lt = s.indexOf('<', pos);
    const text = s.slice(pos, lt < 0 ? s.length : lt);
    if (badEntity.test(text)) return { ok: false, error: `bare & in text near ${pos}`, elements };
    if (text.trim() && !stack.length) return { ok: false, error: `text outside the root element near ${pos}`, elements };
    if (lt < 0) break;
    tag.lastIndex = lt;
    const m = tag.exec(s);
    if (!m) return { ok: false, error: `malformed tag at ${lt}: ${s.slice(lt, lt + 60)}`, elements };
    if (badEntity.test(m[3])) return { ok: false, error: `bare & in attribute at ${lt}`, elements };
    const names = [...m[3].matchAll(/\s([A-Za-z_][\w:.-]*)=/g)].map((a) => a[1]);
    if (new Set(names).size !== names.length) return { ok: false, error: `duplicate attribute at ${lt}`, elements };
    if (m[1]) {
      const open = stack.pop();
      if (open !== m[2]) return { ok: false, error: `</${m[2]}> closes <${open}> at ${lt}`, elements };
    } else {
      elements++;
      if (!root) root = m[2];
      else if (!stack.length) return { ok: false, error: 'more than one root element', elements };
      if (!m[4]) stack.push(m[2]);
    }
    pos = lt + m[0].length;
  }
  if (stack.length) return { ok: false, error: `unclosed <${stack[stack.length - 1]}>`, elements };
  return { ok: true, elements, root };
}

interface DxfEntity { type: string; layer: string; codes: Map<number, string[]> }

/** Minimal ASCII DXF reader: group-code/value pairs → header variables and entities. */
function readDxf(text: string) {
  const lines = text.split(/\r\n|\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  expect(lines.length % 2).toBe(0);
  const pairs: [number, string][] = [];
  for (let i = 0; i < lines.length; i += 2) {
    expect(lines[i]).toMatch(/^\s*\d+\s*$/);
    pairs.push([Number(lines[i]), lines[i + 1]]);
  }
  const header = new Map<string, [number, string][]>();
  const entities: DxfEntity[] = [];
  const layers: string[] = [];
  let section = '', hv = '', table = '';
  let cur: DxfEntity | null = null;
  for (let i = 0; i < pairs.length; i++) {
    const [c, v] = pairs[i];
    if (c === 0 && v === 'SECTION') { section = pairs[i + 1][1]; i++; continue; }
    if (c === 0 && v === 'ENDSEC') { section = ''; cur = null; continue; }
    if (section === 'HEADER') {
      if (c === 9) { hv = v; header.set(hv, []); } else if (hv) header.get(hv)!.push([c, v]);
    } else if (section === 'TABLES') {
      if (c === 0 && v === 'TABLE') { table = pairs[i + 1][1]; i++; }
      else if (c === 0 && v === 'LAYER' && table === 'LAYER') layers.push(pairs[i + 1][1]);
    } else if (section === 'ENTITIES') {
      if (c === 0) { cur = { type: v, layer: '', codes: new Map() }; entities.push(cur); }
      else if (cur) {
        if (c === 8) cur.layer = v;
        if (!cur.codes.has(c)) cur.codes.set(c, []);
        cur.codes.get(c)!.push(v);
      }
    }
  }
  const eof = pairs[pairs.length - 1];
  return { header, entities, layers, eof };
}

const num = (e: DxfEntity, code: number) => Number(e.codes.get(code)?.[0]);

/** true when `spec` appears in the CSV correctly quoted (only needed if it contains a comma or quote) */
function parsedSpecHasComma(spec: string, csv: string): boolean {
  const field = /[",\r\n]/.test(spec) ? `"${spec.replace(/"/g, '""')}"` : spec;
  return csv.includes(`,${field},`);
}

/** A small but complete mechanism used by the BOM and guide tests. */
function rigProject(): Project {
  const p = mkProject('Belt & crank rig', 'rig');
  const base = createPart('baseplate', 'base', 'Base plate', { ...PLATE, width: 160, height: 100, holes: [{ x: -50, y: 0, d: 4 }, { x: 30, y: 0, d: 4 }] });
  base.grounded = true;
  p.parts.push(base);                                                                                                   // P1
  p.parts.push(createPart('link', 'crank', 'Crank', { ...LINK, length: 30 }, { x: -50, y: 0, z: 4 }));                          // P2
  p.parts.push(createPart('link', 'coupler', 'Coupler "long", v2', { ...LINK, length: 80 }, { x: -20, y: 0, z: 8 }));           // P3
  p.parts.push(createPart('link', 'tieA', 'Tie bar', { ...LINK, length: 45 }, { x: 0, y: 30, z: 4 }));                          // P4
  p.parts.push(createPart('link', 'tieB', 'Tie bar', { ...LINK, length: 45 }, { x: 0, y: -30, z: 4 }));                         // P5
  p.parts.push(createPart('pulley', 'pa', 'Small pulley', { ...PULLEY, pitchDiameter: 20 }, { x: -40, y: 60, z: 4 }));            // P6
  p.parts.push(createPart('pulley', 'pb', 'Large pulley', { ...PULLEY, pitchDiameter: 50 }, { x: 35, y: 60, z: 4 }));             // P7
  p.parts.push(createPart('shaft', 'sh', 'Axle', { diameter: 5, length: 30 }, { x: 60, y: -30, z: 0 }));               // P8
  const hidden = createPart('link', 'ghost', 'Suppressed link', { ...LINK, length: 99 });
  hidden.suppressed = true;
  p.parts.push(hidden);                                                                                                 // P9
  p.parts.push(createPart('gear', 'g1', 'Loose gear', { ...GEAR }, { x: 60, y: -30, z: 20 }));                                  // P10
  p.joints.push(
    { id: 'j1', name: 'Crank pivot', type: 'revolute', a: 'base', b: 'crank', anchorA: { port: 'H1' }, anchorB: { port: 'A' } },
    { id: 'j2', name: 'Crank pin', type: 'revolute', a: 'crank', b: 'coupler', anchorA: { port: 'B' }, anchorB: { port: 'A' } },
    { id: 'j3', name: 'Small pulley axle', type: 'revolute', a: GROUND, b: 'pa', anchorA: { x: -40, y: 60 }, anchorB: { port: 'center' },
      motor: { enabled: true, type: 'servo', speed: 4 * Math.PI, maxTorque: 150000, rampTime: 0.1, profile: 'constant' } },
    { id: 'j4', name: 'Large pulley axle', type: 'revolute', a: GROUND, b: 'pb', anchorA: { x: 35, y: 60 }, anchorB: { port: 'center' } },
    { id: 'j5', name: 'Drive belt', type: 'belt', a: 'pa', b: 'pb', anchorA: { port: 'center' }, anchorB: { port: 'center' } },
    { id: 'j6', name: 'Return spring', type: 'spring', a: GROUND, b: 'coupler', anchorA: { x: 60, y: 40 }, anchorB: { port: 'B' }, stiffness: 250, freeLength: 30, coilDiameter: 6 },
    { id: 'j7', name: 'Ghost joint', type: 'revolute', a: 'base', b: 'ghost', anchorA: { port: 'H2' }, anchorB: { port: 'A' } },
    { id: 'j8', name: 'Axle seat', type: 'rigid', a: 'base', b: 'sh', anchorA: { x: 60, y: -30 }, anchorB: { port: 'center' } },
  );
  return p;
}

// ---------------------------------------------------------------------------
// STL
// ---------------------------------------------------------------------------

describe('STL export', () => {
  it('round-trips a 60 mm link: size, closed mesh, volume, bounding box', () => {
    const p = linkProject();
    const r = exportPartSTL(p, 'l1');
    expect(r.ok).toBe(true);
    expect(r.filename).toBe('test-rig_P1_link.stl');
    const bytes = r.bytes!;
    const parsed = parseBinarySTL(bytes);
    expect(parsed.triangles).toBeGreaterThan(100);
    expect(bytes.length).toBe(84 + 50 * parsed.triangles);
    expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(80, true)).toBe(parsed.triangles);
    expect(parsed.header).toContain('units=mm');
    expect(parsed.header).toContain('Link');
    expect(parsed.header.toLowerCase().startsWith('solid')).toBe(false);

    const chk = meshCheck(parsed.positions, parsed.indices);
    expect(chk.closed).toBe(true);
    expect(chk.boundaryEdges).toBe(0);
    expect(chk.nonManifoldEdges).toBe(0);
    expect(chk.euler).toBe(2 - 2 * 2); // two through holes → genus 2
    const vol = massProps(p, p.parts[0]).volume;
    expect(Math.abs(chk.volume - vol) / vol).toBeLessThan(1e-3);
    // independent closed form: stadium minus two ⌀4.2 holes (polygonised arcs lose < 0.1 %)
    const exact = (60 * 10 + Math.PI * 25 - 2 * Math.PI * 2.1 ** 2) * 4;
    expect(Math.abs(chk.volume - exact) / exact).toBeLessThan(2e-3);

    const b = meshBounds(parsed.positions);
    expect(b.size[0]).toBeCloseTo(70, 4); // length + width
    expect(b.size[1]).toBeCloseTo(10, 4);
    expect(b.size[2]).toBeCloseTo(4, 4);
    expect(b.min[0]).toBeCloseTo(-5, 4);
    expect(b.min[2]).toBe(0); // resting on z = 0
    expect(r.report.size[0]).toBeCloseTo(70, 4);
  });

  it('writes unit facet normals that agree with the triangle winding', () => {
    const p = linkProject();
    const mesh = partMesh(p, p.parts[0])!;
    const stl = parseBinarySTL(meshToBinarySTL(mesh, 'n'));
    const P = stl.positions, I = stl.indices, N = stl.normals;
    let worst = 0, up = 0, down = 0;
    for (let t = 0; t < stl.triangles; t++) {
      const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
      const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const len = Math.hypot(n[0], n[1], n[2]);
      const dot = (n[0] * N[3 * t] + n[1] * N[3 * t + 1] + n[2] * N[3 * t + 2]) / len;
      worst = Math.max(worst, Math.abs(1 - dot));
      expect(Math.hypot(N[3 * t], N[3 * t + 1], N[3 * t + 2])).toBeCloseTo(1, 5);
      if (N[3 * t + 2] > 0.999) up++;
      if (N[3 * t + 2] < -0.999) down++;
    }
    expect(worst).toBeLessThan(1e-5);
    expect(up).toBeGreaterThan(0);
    expect(up).toBe(down); // top and bottom caps are triangulated alike
  });

  it('exports multi-layer parts as one solid resting on z = 0', () => {
    const p = mkProject('Stack');
    p.parts.push(createPart('pulley', 'pu', 'Pulley', { ...PULLEY, pinRadius: 8 }));
    p.parts.push(createPart('motor', 'mo', 'Motor'));
    for (const part of p.parts) {
      const r = exportPartSTL(p, part.id);
      expect(r.ok).toBe(true);
      const parsed = parseBinarySTL(r.bytes!);
      const chk = meshCheck(parsed.positions, parsed.indices);
      expect(chk.closed).toBe(true);
      const g = geometryOf(p, part);
      const b = meshBounds(parsed.positions);
      expect(b.min[2]).toBe(0);
      expect(b.size[2]).toBeCloseTo(g.zMax - g.zMin, 4);
      const vol = massProps(p, part).volume;
      expect(Math.abs(chk.volume - vol) / vol).toBeLessThan(1e-3);
    }
    // pulley: 2·1.2 flanges + 6 belt + 2·0.15 clearance; bore + pin hole → genus 2
    const pu = parseBinarySTL(exportPartSTL(p, 'pu').bytes!);
    expect(meshBounds(pu.positions).size[2]).toBeCloseTo(8.7, 4);
    expect(meshCheck(pu.positions, pu.indices).euler).toBe(-2);
    // motor: the housing lies below local z = 0 in the model, yet the export rests on z = 0
    expect(geometryOf(p, p.parts[1]).zMin).toBeLessThan(0);
    expect(partMesh(p, p.parts[1])!.bbox.min[2]).toBe(0);
  });

  it('rejects truncated files when parsing', () => {
    const p = linkProject();
    const bytes = exportPartSTL(p, 'l1').bytes!;
    expect(() => parseBinarySTL(bytes.slice(0, bytes.length - 7))).toThrow(/size mismatch/);
    expect(() => parseBinarySTL(new Uint8Array(10))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// refusal of broken solids + printability hints
// ---------------------------------------------------------------------------

describe('print check', () => {
  it('detects a mesh with one triangle removed and refuses to export it', () => {
    const p = linkProject();
    const part = p.parts[0];
    const good = partMesh(p, part)!;
    const okReport = reportForMesh(p, part, good);
    expect(okReport.exportable).toBe(true);
    expect(okReport.kernelStatus).toBe('NoError');
    expect(stlFromReport(good, okReport, 'x')).toBeInstanceOf(Uint8Array);

    const broken: SolidMesh = { ...good, indices: good.indices.slice(0, good.indices.length - 3) };
    const chk = meshCheck(broken.positions, broken.indices);
    expect(chk.closed).toBe(false);
    expect(chk.boundaryEdges).toBe(3);
    const report = reportForMesh(p, part, broken);
    expect(report.exportable).toBe(false);
    expect(report.mesh!.boundaryEdges).toBe(3);
    const err = report.issues.filter((i) => i.severity === 'error');
    expect(err.length).toBeGreaterThan(0);
    expect(err[0].message).toMatch(/not a closed manifold/);
    expect(err[0].message).toMatch(/3 open/);
    expect(stlFromReport(broken, report, 'x')).toBeUndefined();
  });

  it('refuses inverted solids, bad kernel status and missing solids', () => {
    const p = linkProject();
    const part = p.parts[0];
    const good = partMesh(p, part)!;
    const flipped = new Uint32Array(good.indices);
    for (let i = 0; i < flipped.length; i += 3) { const t = flipped[i + 1]; flipped[i + 1] = flipped[i + 2]; flipped[i + 2] = t; }
    const inv = reportForMesh(p, part, { ...good, indices: flipped });
    expect(inv.exportable).toBe(false);
    expect(inv.volume).toBeLessThan(0);
    expect(inv.issues.some((i) => i.severity === 'error' && /no positive volume/.test(i.message))).toBe(true);

    const bad = reportForMesh(p, part, { ...good, status: 'NotManifold' });
    expect(bad.exportable).toBe(false);
    expect(bad.issues.some((i) => i.severity === 'error' && /NotManifold/.test(i.message))).toBe(true);

    const none = reportForMesh(p, part, null);
    expect(none.exportable).toBe(false);
    expect(none.mesh).toBeNull();
    expect(none.issues[0].severity).toBe('error');
  });

  it('refuses a part without solid geometry in every exporter', () => {
    const p = linkProject();
    p.parts.push(createPart('plate', 'pl', 'Empty sketch part')); // no sketch linked → no layers
    const rep = checkPrintable(p, p.parts[1]);
    expect(rep.exportable).toBe(false);
    expect(rep.volume).toBe(0);
    const stl = exportPartSTL(p, 'pl');
    expect(stl.ok).toBe(false);
    expect(stl.bytes).toBeUndefined();
    expect(stl.report.issues.some((i) => i.severity === 'error')).toBe(true);
    expect(buildExportMesh(p, p.parts[1]).mesh).toBeNull();

    const pkg = exportParts3MF(p, ['l1', 'pl']);
    expect(pkg.ok).toBe(true);
    expect(pkg.reports.map((r) => r.exportable)).toEqual([true, false]);
    expect(parse3MF(pkg.bytes!).objects.length).toBe(1);

    const nothing = exportParts3MF(p, ['pl', 'does-not-exist']);
    expect(nothing.ok).toBe(false);
    expect(nothing.bytes).toBeUndefined();
    expect(nothing.reports.length).toBe(2);
    expect(exportPartSTL(p, 'does-not-exist').ok).toBe(false);
  });

  it('warns about thin walls only when the wall is below the minimum feature size', () => {
    const sane = linkProject();
    const saneRep = checkPrintable(sane, sane.parts[0]);
    expect(saneRep.exportable).toBe(true);
    expect(saneRep.issues.filter((i) => i.severity === 'warning')).toEqual([]);
    expect(saneRep.issues.some((i) => i.message === HUMAN_VALIDATION_NOTE)).toBe(true);

    // width 5, hole 4 + 0.2 clearance → 0.4 mm wall < 0.8 mm
    const thin = linkProject({ width: 5 });
    const rep = checkPrintable(thin, thin.parts[0]);
    expect(rep.exportable).toBe(true); // still a valid solid: warning, not refusal
    const w = rep.issues.filter((i) => i.severity === 'warning' && /Thin walls/.test(i.message));
    expect(w.length).toBe(1);
    expect(w[0].message).toContain('0.8 mm');
    const lost = Number(/([\d.]+) mm²/.exec(w[0].message)![1]);
    expect(lost).toBeGreaterThan(1);

    // relaxing the minimum feature size below the wall removes the warning
    thin.clearances.minFeature = 0.3;
    const relaxed = checkPrintable(thin, thin.parts[0]);
    expect(relaxed.issues.some((i) => /Thin walls/.test(i.message))).toBe(false);
  });

  it('measures the lost area of a thin fin by morphological opening', () => {
    // 10 × 10 block with a 0.4 × 5 mm fin on its right side
    const block: [number, number][] = [[0, 0], [10, 0], [10, 4.8], [15, 4.8], [15, 5.2], [10, 5.2], [10, 10], [0, 10]];
    const r = thinFeatureLoss([block], 0.8);
    expect(r.area).toBeCloseTo(102, 6);
    expect(r.lost).toBeGreaterThan(2);      // the whole fin (2 mm²) …
    expect(r.lost).toBeLessThan(2.3);       // … plus four rounded corners of the block
    expect(r.flagged).toBe(true);
    const plain = thinFeatureLoss([[[0, 0], [10, 0], [10, 10], [0, 10]]], 0.8);
    expect(plain.lost).toBeLessThan(0.2);   // 4 corners × (1 − π/4) × 0.4²
    expect(plain.flagged).toBe(false);
  });

  it('reports small holes, thin layers, oversize parts and purchased components', () => {
    const p = mkProject('Hints');
    p.parts.push(createPart('link', 'small', 'Small holes', { ...LINK, holeDiameter: 1 }));       // ⌀1.2 < 1.6
    p.parts.push(createPart('link', 'film', 'Film', { ...LINK, thickness: 0.5 }));                 // 0.5 < 0.8
    p.parts.push(createPart('baseplate', 'big', 'Big plate', { ...PLATE, width: 300, height: 100 }));
    p.parts.push(createPart('shaft', 'sh', 'Shaft'));
    const msgs = (id: string, sev: string) => checkPrintable(p, p.parts.find((q) => q.id === id)!).issues.filter((i) => i.severity === sev).map((i) => i.message);
    expect(msgs('small', 'warning').filter((m) => /smaller than twice the minimum feature size/.test(m)).length).toBe(2);
    expect(msgs('film', 'warning').some((m) => /only 0.5 mm thick/.test(m))).toBe(true);
    expect(msgs('big', 'warning').some((m) => /300 × 100 × \d+(\.\d+)? mm and exceeds a common print volume/.test(m))).toBe(true);
    expect(msgs('small', 'info').some((m) => /print beds/.test(m))).toBe(false);
    expect(msgs('sh', 'info').some((m) => /Purchased component — exported envelope geometry is for reference\/fit checks only/.test(m))).toBe(true);
    for (const part of p.parts) expect(checkPrintable(p, part).issues.some((i) => i.message === HUMAN_VALIDATION_NOTE)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3MF
// ---------------------------------------------------------------------------

describe('3MF export', () => {
  it('writes a valid package whose objects parse back to closed meshes', () => {
    const p = mkProject('Pack & <ship>');
    p.parts.push(createPart('link', 'a', 'Link "A" & co', { ...LINK }));
    p.parts.push(createPart('gear', 'g', 'Gear', { ...GEAR }));
    p.parts.push(createPart('baseplate', 'b', 'Base', { ...PLATE }));
    const r = exportParts3MF(p, ['a', 'g', 'b']);
    expect(r.ok).toBe(true);
    expect(r.filename).toBe('pack-ship_parts.3mf');
    expect(r.reports.length).toBe(3);

    const zip = unzipSync(r.bytes!);
    expect(Object.keys(zip).sort()).toEqual(['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels']);
    expect(Object.keys(zip)[0]).toBe('[Content_Types].xml');
    const ct = strFromU8(zip['[Content_Types].xml']);
    expect(ct).toContain('application/vnd.ms-package.3dmanufacturing-3dmodel+xml');
    expect(ct).toContain('application/vnd.openxmlformats-package.relationships+xml');
    const rels = strFromU8(zip['_rels/.rels']);
    expect(rels).toContain('Target="/3D/3dmodel.model"');
    expect(rels).toContain('http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel');
    const model = strFromU8(zip['3D/3dmodel.model']);
    for (const x of [ct, rels, model]) expect(xmlCheck(x)).toMatchObject({ ok: true });
    expect(xmlCheck(model).root).toBe('model');
    expect(model).toContain('unit="millimeter"');
    expect(model).toContain('xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"');
    expect((model.match(/<object /g) ?? []).length).toBe(3);
    expect((model.match(/<item /g) ?? []).length).toBe(3);
    expect(model).toContain('name="Link &quot;A&quot; &amp; co" partnumber="P1"');

    const parsed = parse3MF(r.bytes!);
    expect(parsed.unit).toBe('millimeter');
    expect(parsed.objects.map((o) => o.partNumber)).toEqual(['P1', 'P2', 'P3']);
    expect(parsed.objects.map((o) => o.name)).toEqual(['Link "A" & co', 'Gear', 'Base']);
    expect(parsed.buildItems.map((b) => b.objectId)).toEqual(['1', '2', '3']);
    parsed.objects.forEach((o, i) => {
      const chk = meshCheck(o.positions, o.indices);
      expect(chk.closed).toBe(true);
      const vol = massProps(p, p.parts[i]).volume;
      expect(Math.abs(chk.volume - vol) / vol).toBeLessThan(1e-3);
      // vertices survive the text round trip bit-for-bit
      const src = partMesh(p, p.parts[i])!;
      expect(o.positions.length).toBe(src.positions.length);
      expect(Array.from(o.positions)).toEqual(Array.from(src.positions));
      expect(Array.from(o.indices)).toEqual(Array.from(src.indices));
    });
    // build items do not overlap: translations differ
    expect(new Set(parsed.buildItems.map((b) => b.transform)).size).toBe(3);
    // deterministic bytes
    expect(Array.from(exportParts3MF(p, ['a', 'g', 'b']).bytes!)).toEqual(Array.from(r.bytes!));
  });

  it('formats float32 coordinates with enough digits to round-trip', () => {
    for (const v of [0, 1, -2.5, 0.1, 1 / 3, 123.456, 1e-7, -22.75, 8.7, Math.PI * 100]) {
      const f = Math.fround(v);
      expect(Math.fround(Number(f32str(f)))).toBe(f);
    }
    expect(f32str(Math.fround(8.7))).toBe('8.7');
    expect(f32str(-0)).toBe('0');
  });

  it('meshesTo3MF accepts items directly', () => {
    const p = linkProject();
    const mesh = partMesh(p, p.parts[0])!;
    const parsed = parse3MF(meshesTo3MF([{ name: 'A', partNumber: 'P1', mesh }, { name: 'B', partNumber: 'P2', mesh }], 'two'));
    expect(parsed.objects.length).toBe(2);
    expect(parsed.objects[1].indices.length).toBe(mesh.indices.length);
  });
});

// ---------------------------------------------------------------------------
// cutting profiles
// ---------------------------------------------------------------------------

describe('cutting profile DXF / SVG', () => {
  it('writes closed polylines, true CIRCLE holes at exact centres and $INSUNITS = 4', () => {
    const p = linkProject();
    const text = partProfileDXF(p, 'l1');
    expect(text).toContain('$INSUNITS\r\n70\r\n4\r\n');
    expect(text).toContain('$ACADVER\r\n1\r\nAC1009\r\n');
    const dxf = readDxf(text);
    expect(dxf.eof).toEqual([0, 'EOF']);
    expect(dxf.header.get('$INSUNITS')).toEqual([[70, '4']]);
    expect(dxf.header.get('$EXTMIN')!.map(([, v]) => Number(v))).toEqual([-5, -5, 0]);
    expect(dxf.header.get('$EXTMAX')!.map(([, v]) => Number(v))).toEqual([65, 5, 0]);
    expect(dxf.layers).toEqual(['0', 'CUT_OUTER', 'CUT_INNER', 'HOLE_CENTRES']);

    const circles = dxf.entities.filter((e) => e.type === 'CIRCLE');
    expect(circles.length).toBe(2);
    expect(circles.every((c) => c.layer === 'CUT_INNER')).toBe(true);
    expect(circles.map((c) => [num(c, 10), num(c, 20), num(c, 40)])).toEqual([[0, 0, 2.1], [60, 0, 2.1]]);
    const points = dxf.entities.filter((e) => e.type === 'POINT');
    expect(points.map((c) => [c.layer, num(c, 10), num(c, 20)])).toEqual([['HOLE_CENTRES', 0, 0], ['HOLE_CENTRES', 60, 0]]);

    // exactly one outer polyline, closed (flag 70 bit 1); hole polygons are NOT duplicated as polylines
    const polylines = dxf.entities.filter((e) => e.type === 'POLYLINE');
    expect(polylines.length).toBe(1);
    expect(polylines[0].layer).toBe('CUT_OUTER');
    expect(Number(polylines[0].codes.get(70)![0]) & 1).toBe(1);
    expect(dxf.entities.filter((e) => e.type === 'SEQEND').length).toBe(1);
    const verts = dxf.entities.filter((e) => e.type === 'VERTEX');
    expect(verts.length).toBe(geometryOf(p, p.parts[0]).layers[0].contours[0].length);
    const xs = verts.map((v) => num(v, 10)), ys = verts.map((v) => num(v, 20));
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([-5, 65, -5, 5]);
    expect(new Set(dxf.entities.map((e) => e.type))).toEqual(new Set(['POLYLINE', 'VERTEX', 'SEQEND', 'CIRCLE', 'POINT']));
  });

  it('keeps non-circular cut-outs as closed polylines and adds Z layers for stacked profiles', () => {
    const p = mkProject('Profiles');
    p.parts.push(createPart('rail', 'r', 'Rail', { length: 80, slotWidth: 10, width: 22, overtravel: 12, thickness: 5 }));
    p.parts.push(createPart('pulley', 'pu', 'Pulley', { ...PULLEY, pinRadius: 8 }));
    const rail = readDxf(partProfileDXF(p, 'r'));
    const rp = rail.entities.filter((e) => e.type === 'POLYLINE');
    expect(rp.map((e) => e.layer)).toEqual(['CUT_OUTER', 'CUT_INNER']);
    expect(rp.every((e) => (Number(e.codes.get(70)![0]) & 1) === 1)).toBe(true);
    expect(rail.entities.filter((e) => e.type === 'CIRCLE').length).toBe(0);

    const pd = profileData(p, p.parts[1]);
    expect(pd.layers.length).toBe(2); // flange profile + belt seat; the top flange repeats the first
    expect(pd.layerNames).toEqual(['CUT_OUTER', 'CUT_INNER', 'HOLE_CENTRES', 'Z1p2-7p5_OUTER', 'Z1p2-7p5_INNER']);
    const pu = readDxf(partProfileDXF(p, 'pu'));
    expect(pu.layers).toEqual(['0', ...pd.layerNames]);
    const cutCircles = pu.entities.filter((e) => e.type === 'CIRCLE' && e.layer === 'CUT_INNER');
    expect(cutCircles.map((c) => [num(c, 10), num(c, 20), num(c, 40)])).toEqual([[0, 0, 2.6], [8, 0, 2.1]]);
    expect(pu.entities.filter((e) => e.type === 'POLYLINE').map((e) => e.layer)).toEqual(['CUT_OUTER', 'Z1p2-7p5_OUTER']);
  });

  it('writes a laser-ready SVG in mm with flipped Y and hole metadata', () => {
    const p = mkProject('Profiles');
    p.parts.push(createPart('baseplate', 'b', 'Plate', { ...PLATE, width: 100, height: 60, cornerRadius: 0, holes: [{ x: -30, y: 10, d: 4 }, { x: 20, y: -15, d: 6 }] }));
    const svg = partProfileSVG(p, 'b');
    expect(xmlCheck(svg)).toMatchObject({ ok: true, root: 'svg' });
    expect(svg).toContain('width="102mm" height="62mm" viewBox="-51 -31 102 62"');
    expect(svg).toContain('data-bbox-mm="-50 -30 50 30"');
    expect(svg).toContain('data-part-number="P1"');
    expect(svg).toMatch(/<desc>[^<]*Y axis flipped[^<]*svg_y = −cad_y/);
    expect(svg).toContain('stroke-width="0.1"');
    // y is negated: CAD (−30, 10) → SVG (−30, −10); CAD (20, −15) → SVG (20, 15)
    expect(svg).toContain('<circle class="cut-inner hole" cx="-30" cy="-10" r="2.1"');
    expect(svg).toContain('<circle class="cut-inner hole" cx="20" cy="15" r="3.1"');
    expect(svg).toContain('<g class="hole-centre" data-x="-30" data-y="10" data-d="4.2"');
    expect(svg).toContain('<g class="hole-centre" data-x="20" data-y="-15" data-d="6.2"');
    expect(svg).toContain('<path class="cut-outer" d="M-50 30L50 30L50 -30L-50 -30Z"/>');
    expect(svg).not.toMatch(/href|<image/);
  });
});

describe('every catalogue part kind', () => {
  it('goes through all exporters with consistent, well-formed output', () => {
    const p = mkProject('Catalogue');
    const sk0 = rectangle(newSketch('sk1', 'Bracket'), 0, 0, 50, 30);
    const c = addPoint(sk0.sketch, 15, 12);
    p.sketches.push(addCircle(c.sketch, c.id, 3).sketch);
    (Object.keys(PART_DEFS) as PartKind[]).forEach((kind, i) => {
      p.parts.push(createPart(kind, `k${i}`, PART_DEFS[kind].label, kind === 'plate' ? { sketchId: 'sk1', thickness: 4 } : {}));
    });
    expect(p.parts.length).toBeGreaterThanOrEqual(15);
    for (const part of p.parts) {
      const g = geometryOf(p, part);
      const rep = checkPrintable(p, part);
      expect(rep.exportable, `${part.kind} exportable`).toBe(true);
      const stl = exportPartSTL(p, part.id);
      expect(stl.ok).toBe(true);
      const parsed = parseBinarySTL(stl.bytes!);
      const chk = meshCheck(parsed.positions, parsed.indices);
      expect(chk.closed, `${part.kind} closed after STL round trip`).toBe(true);
      const b = meshBounds(parsed.positions);
      expect(b.min[2]).toBe(0);
      expect(b.size[2]).toBeCloseTo(g.zMax - g.zMin, 4);

      const drawing = partDrawingSVG(p, part.id);
      expect(xmlCheck(drawing), `${part.kind} drawing`).toMatchObject({ ok: true, root: 'svg' });
      expect((drawing.match(/<g class="hole-centre"/g) ?? []).length).toBe(g.holes.length);
      expect((drawing.match(/<g class="hole-row"/g) ?? []).length).toBe(g.holes.length);
      expect((drawing.match(/<g class="dim-linear"/g) ?? []).length).toBe(g.dims.filter((d) => d.kind === 'linear').length + 1);
      expect((drawing.match(/<g class="dim-diameter"/g) ?? []).length).toBe(g.dims.filter((d) => d.kind === 'diameter').length);
      expect(drawing).toMatch(/data-scale="(5:1|2:1|1:1|1:2|1:5)"/);

      const dxf = readDxf(partProfileDXF(p, part.id));
      const circles = dxf.entities.filter((e) => e.type === 'CIRCLE' && e.layer === 'CUT_INNER');
      expect(circles.map((e) => [num(e, 10), num(e, 20), num(e, 40)])).toEqual(g.holes.map((h) => [h.x, h.y, h.d / 2].map((v) => Number(v.toFixed(6)))));
      expect(dxf.entities.filter((e) => e.type === 'POINT').length).toBe(g.holes.length);
      const polylines = dxf.entities.filter((e) => e.type === 'POLYLINE');
      expect(polylines.length).toBeGreaterThan(0);
      expect(polylines.every((e) => (Number(e.codes.get(70)![0]) & 1) === 1)).toBe(true);
      expect(new Set(dxf.entities.map((e) => e.layer)).size).toBeLessThanOrEqual(dxf.layers.length - 1);
      for (const e of dxf.entities) expect(dxf.layers).toContain(e.layer);

      const prof = partProfileSVG(p, part.id);
      expect(xmlCheck(prof), `${part.kind} profile`).toMatchObject({ ok: true, root: 'svg' });
      expect((prof.match(/<circle class="cut-inner hole"/g) ?? []).length).toBe(circles.length);
    }
    // the sketched plate: its circle is a true CIRCLE entity, not a polygon
    const plate = p.parts.find((q) => q.kind === 'plate')!;
    const dxf = readDxf(partProfileDXF(p, plate.id));
    expect(dxf.entities.filter((e) => e.type === 'CIRCLE').map((e) => [num(e, 10), num(e, 20), num(e, 40)])).toEqual([[15, 12, 3]]);
    expect(dxf.entities.filter((e) => e.type === 'POLYLINE').map((e) => e.layer)).toEqual(['CUT_OUTER']);
    expect(dxf.header.get('$EXTMAX')!.map(([, v]) => Number(v))).toEqual([50, 30, 0]);
    // BOM and guide cope with every kind too
    const rows = buildBOM(p);
    expect(rows.reduce((n, r) => n + r.qty, 0)).toBe(p.parts.length);
    expect(rows.filter((r) => r.category === 'purchased').map((r) => r.kind).sort()).toEqual(
      (Object.keys(PART_DEFS) as PartKind[]).filter((k) => PART_DEFS[k].purchased).sort());
    const html = assemblyGuideHTML(p);
    for (const part of p.parts) expect(html).toContain(`>${partNumber(p, part.id)}<`);
  });
});

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------

describe('part drawing SVG', () => {
  it('is well-formed, true to scale and carries the hole table and dimension metadata', () => {
    const p = linkProject();
    p.parts.push(createPart('link', 'l2', 'Link', { ...LINK })); // identical → quantity 2
    const g = geometryOf(p, p.parts[0]);
    const svg = partDrawingSVG(p, 'l1');
    const x = xmlCheck(svg);
    expect(x).toMatchObject({ ok: true, root: 'svg' });
    expect(x.elements).toBeGreaterThan(60);
    expect(svg).toMatch(/<svg [^>]*width="297mm" height="210mm" viewBox="0 0 297 210"/);
    expect(svg).toContain('data-part-number="P1"');
    expect(svg).toContain('data-scale="2:1"');
    expect(svg).toContain('data-bbox-mm="-5 -5 65 5"');

    // linear dimensions: link length from the model + thickness on the side view
    const lin = [...svg.matchAll(/<g class="dim-linear" data-value="([^"]+)"/g)].map((m) => Number(m[1]));
    expect(lin).toContain(60);
    expect(lin).toContain(4);
    expect(lin.length).toBe(2);
    // each one is a real dimension: 2 extension lines, dimension line, 2 arrowheads, text
    for (const g of svg.match(/<g class="dim-linear"[\s\S]*?<\/g>/g)!) {
      expect((g.match(/class="ext"/g) ?? []).length).toBe(2);
      expect((g.match(/class="dimline"/g) ?? []).length).toBe(1);
      expect((g.match(/class="arrow"/g) ?? []).length).toBe(2);
      expect((g.match(/<text /g) ?? []).length).toBe(1);
    }
    expect(svg).toMatch(/<g class="dim-linear" data-value="60"[\s\S]*?<text [^>]*>60<\/text>/);
    const dia = g.dims.find((d) => d.kind === 'diameter') as { label?: string };
    expect(svg).toMatch(/<g class="dim-diameter" data-value="4.2"/);
    expect(svg).toContain(`>${dia.label}</text>`);

    // hole centre marks with true coordinates + hole table
    const marks = [...svg.matchAll(/<g class="hole-centre" data-x="([^"]+)" data-y="([^"]+)" data-d="([^"]+)"/g)].map((m) => m.slice(1, 4).map(Number));
    expect(marks).toEqual([[0, 0, 4.2], [60, 0, 4.2]]);
    expect(svg).toContain('HOLE TABLE');
    for (const head of ['Hole', 'X', 'Y', '⌀ model', '⌀ nominal']) expect(svg).toContain(`>${head}</text>`);
    const rows = [...svg.matchAll(/<g class="hole-row" data-label="([^"]+)" data-x="([^"]+)" data-y="([^"]+)" data-d="([^"]+)" data-nominal="([^"]+)"/g)].map((m) => m.slice(1, 6));
    expect(rows).toEqual([[g.holes[0].label, '0', '0', '4.2', '4'], [g.holes[1].label, '60', '0', '4.2', '4']]);

    // views and title block
    expect(svg).toContain('class="view front-view"');
    expect(svg).toContain('class="view side-view"');
    const tb = /<g class="title-block">[\s\S]*<\/g>/.exec(svg)![0];
    expect(tb).toContain('>Test rig</text>');
    expect(tb).toContain('>Link</text>');
    expect(tb).toContain('>P1</text>');
    expect(tb).toContain(`>${materialOf(p, p.parts[0].materialId).name}</text>`);
    expect(tb).toMatch(/class="t tb-qty"[^>]*>2<\/text>/);
    expect(tb).toMatch(/class="t tb-scale"[^>]*>2:1<\/text>/);
    expect(tb).toContain('Dimensions in mm. Generated geometry');
    expect(svg).toContain('verify fits, material and loads before manufacture.');
    const note = g.dims.find((d) => d.kind === 'note') as { text: string };
    expect(svg).toContain(note.text.replace(/\s+/g, ' '));
    expect(svg).not.toMatch(/href|<image|@import/);
    expect([...svg.matchAll(/font-family:([^;}"]+)/g)].every((m) => m[1] === 'sans-serif')).toBe(true);

    // front view really is at 2:1: outline path spans 2 × 70 mm of paper
    const d = /<path class="outline" d="([^"]+)"/.exec(svg)![1];
    const xs = [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(140, 2);
  });

  it('picks a standard scale so that the part fits the A4 sheet', () => {
    const p = mkProject('Scales');
    p.parts.push(createPart('baseplate', 'big', 'Big', { ...PLATE, width: 300, height: 200 }));
    p.parts.push(createPart('baseplate', 'huge', 'Huge', { ...PLATE, width: 700, height: 450 }));
    p.parts.push(createPart('slider', 'tiny', 'Tiny', { length: 12, width: 6, thickness: 5, holeDiameter: 0 }));
    p.parts.push(createPart('gear', 'gear', 'Gear', { ...GEAR }));
    const scaleOf = (id: string) => /data-scale="([^"]+)"/.exec(partDrawingSVG(p, id))![1];
    expect(scaleOf('big')).toBe('1:2');
    expect(scaleOf('huge')).toBe('1:5');
    p.parts[1].params = { ...p.parts[1].params, width: 2500, height: 1500 }; // beyond 1:5 → emergency reduction
    expect(scaleOf('huge')).toBe('1:20');
    p.parts[1].params = { ...p.parts[1].params, width: 700, height: 450 };
    expect(scaleOf('tiny')).toBe('5:1');
    expect(scaleOf('gear')).toBe('2:1');
    for (const part of p.parts) {
      const svg = partDrawingSVG(p, part.id);
      expect(xmlCheck(svg)).toMatchObject({ ok: true });
      // the front view lies inside the sheet frame: translated outline points within [8, 289] × [8, 202]
      const tr = /<g class="views" transform="translate\(([-\d.]+) ([-\d.]+)\)"/.exec(svg)!.slice(1).map(Number);
      const pts = [...(/<path class="outline" d="([^"]+)"/.exec(svg)![1]).matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]) + tr[0], Number(m[2]) + tr[1]]);
      expect(Math.min(...pts.map((q) => q[0]))).toBeGreaterThan(8);
      expect(Math.max(...pts.map((q) => q[0]))).toBeLessThan(289);
      expect(Math.min(...pts.map((q) => q[1]))).toBeGreaterThan(8);
      expect(Math.max(...pts.map((q) => q[1]))).toBeLessThan(202);
    }
    // gear: diameter dimensions with labels from the model, thickness as the linear dimension
    const gear = partDrawingSVG(p, 'gear');
    expect([...gear.matchAll(/<g class="dim-diameter" data-value="([^"]+)"/g)].map((m) => Number(m[1]))).toEqual([44, 40, 5.2]); // (z + 2)·m, z·m, bore + clearance
    for (const d of geometryOf(p, p.parts[3]).dims) if (d.kind === 'diameter' && d.label) expect(gear).toContain(`>${d.label}</text>`);
    expect([...gear.matchAll(/<g class="dim-linear" data-value="([^"]+)"/g)].map((m) => Number(m[1]))).toEqual([6]);
    expect(() => partDrawingSVG(p, 'nope')).toThrow(/no part/);
  });

  it('mirrors a dimension whose requested side would cross the part, and escapes text', () => {
    const p = mkProject('A & B <test>');
    p.parts.push(createPart('baseplate', 'b', 'Plate "1" & <2>', { ...PLATE, width: 100, height: 60, holes: [] }));
    const svg = partDrawingSVG(p, 'b');
    expect(xmlCheck(svg)).toMatchObject({ ok: true });
    expect(svg).toContain('Plate &quot;1&quot; &amp; &lt;2&gt;');
    expect(svg).not.toContain('HOLE TABLE');
    const dims = [...svg.matchAll(/<g class="dim-linear" data-value="([^"]+)"[^>]*>([\s\S]*?)<\/g>/g)];
    expect(dims.map((m) => Number(m[1]))).toEqual([100, 60, 4]);
    // the 60 mm height dimension: its dimension line is vertical and lies LEFT of the plate (x < left edge)
    const outline = /<path class="outline" d="([^"]+)"/.exec(svg)![1];
    const left = Math.min(...[...outline.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[1])));
    const dl = /class="dimline" x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"/.exec(dims[1][2])!.slice(1).map(Number);
    expect(dl[0]).toBe(dl[2]);
    expect(dl[0]).toBeLessThan(left - 3);
    const k = Number(/data-scale-factor="([^"]+)"/.exec(svg)![1]);
    expect(svg).toContain('data-scale="2:1"');
    expect(k).toBe(2);
    expect(Math.abs(dl[3] - dl[1])).toBeCloseTo(60 * k, 2); // 60 mm drawn at 2:1 → 120 mm of paper
    // the 100 mm width dimension sits BELOW the plate (larger SVG y than the bottom edge)
    const bottom = Math.max(...[...outline.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[2])));
    const dw = /class="dimline" x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)"/.exec(dims[0][2])!.slice(1).map(Number);
    expect(dw[1]).toBe(dw[3]);
    expect(dw[1]).toBeCloseTo(bottom + 8 * k, 2); // offset −8 mm honoured at scale
  });
});

// ---------------------------------------------------------------------------
// BOM
// ---------------------------------------------------------------------------

describe('bill of materials', () => {
  it('numbers parts by their position in the project', () => {
    const p = rigProject();
    expect(partNumber(p, 'base')).toBe('P1');
    expect(partNumber(p, 'coupler')).toBe('P3');
    expect(partNumber(p, 'g1')).toBe('P10');
  });

  it('groups identical parts, separates custom from purchased and skips suppressed parts', () => {
    const p = rigProject();
    const rows = buildBOM(p);
    expect(rows.map((r) => r.item)).toEqual(rows.map((_, i) => i + 1));
    const tie = rows.find((r) => r.name === 'Tie bar')!;
    expect(tie.qty).toBe(2);
    expect(tie.partNumbers).toEqual(['P4', 'P5']);
    expect(tie.partIds).toEqual(['tieA', 'tieB']);
    expect(tie.category).toBe('custom');
    expect(tie.spec).toBe(geometryOf(p, p.parts[3]).spec);
    expect(tie.spec).toContain('45');
    expect(tie.material).toBe(materialOf(p, p.parts[3].materialId).name);
    expect(tie.process).toBe(materialOf(p, p.parts[3].materialId).process);
    expect(tie.massEach).toBeCloseTo(massProps(p, p.parts[3]).mass, 12);
    expect(tie.massEach).toBeGreaterThan(0.002);
    expect(tie.massEach).toBeLessThan(0.003);
    // same kind but different length → separate rows
    expect(rows.filter((r) => r.kind === 'link').map((r) => r.qty)).toEqual([1, 1, 2]);
    expect(rows.some((r) => r.name.includes('Suppressed'))).toBe(false);
    expect(rows.flatMap((r) => r.partNumbers)).not.toContain('P9');

    const shaft = rows.find((r) => r.kind === 'shaft')!;
    expect(shaft.category).toBe('purchased');
    expect(shaft.spec).toBe(geometryOf(p, p.parts[7]).spec);
    // custom rows come first, then purchased
    const cats = rows.map((r) => r.category);
    expect(cats.lastIndexOf('custom')).toBeLessThan(cats.indexOf('purchased'));
    expect(rows.filter((r) => r.category === 'custom').flatMap((r) => r.partNumbers).sort()).toEqual(['P1', 'P10', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7']);

    // a different material splits the group
    p.parts[4].materialId = 'petg';
    expect(buildBOM(p).filter((r) => r.name === 'Tie bar').map((r) => r.qty)).toEqual([1, 1]);
  });

  it('derives pins from revolute joints with diameter and stack length', () => {
    const p = rigProject();
    const rows = buildBOM(p);
    const pins = rows.filter((r) => r.kind === 'pin');
    // base (z 0–4) + crank (z 4–8) → 8; crank (4–8) + coupler (8–12) → 8: grouped, ⌀4 from the hole ports
    const small = pins.find((r) => r.spec === 'Dowel pin / shoulder screw ⌀4 × 8 mm')!;
    expect(small.qty).toBe(2);
    expect(small.note).toContain('"Crank pivot", "Crank pin"');
    // ground joints: pulley width 8.7 + 4 = 12.7; ⌀5 from the bore port
    const axle = pins.find((r) => r.spec === 'Dowel pin / shoulder screw ⌀5 × 12.7 mm')!;
    expect(axle.qty).toBe(2);
    expect(pins.length).toBe(2);
    expect(pins.every((r) => r.category === 'purchased' && r.partNumbers.length === 0)).toBe(true);
    expect(pinSpec(p, p.joints[0])).toEqual({ d: 4, length: 8 });
    // explicit pin diameter wins; the suppressed part's joint produces nothing
    p.joints[0].pinDiameter = 3;
    expect(pinSpec(p, p.joints[0])).toEqual({ d: 3, length: 8 });
    expect(rows.some((r) => r.note.includes('Ghost joint'))).toBe(false);
  });

  it('computes the exact open and crossed belt length', () => {
    const p = rigProject();
    const r1 = 10, r2 = 25, C = 75;
    const beta = Math.asin((r1 - r2) / C);
    const open = 2 * Math.sqrt(C * C - (r1 - r2) ** 2) + r1 * (Math.PI + 2 * beta) + r2 * (Math.PI - 2 * beta);
    expect(beltLength(r1, r2, C)).toBeCloseTo(open, 10);
    // by hand: 2·√5400 = 146.9694, β = asin(−0.2) = −0.201358, 10·(π − 0.402716) = 27.3888, 25·(π + 0.402716) = 88.6077
    expect(open).toBeCloseTo(262.9659, 3);
    const belt = buildBOM(p).find((r) => r.kind === 'belt')!;
    expect(Number(/pitch length ([\d.]+) mm/.exec(belt.spec)![1])).toBeCloseTo(open, 3);
    expect(belt.spec).toMatch(/^Belt, pitch length 262\.966 mm, width 6 mm/);
    expect(belt.qty).toBe(1);
    // equal pulleys: 2C + 2πr
    expect(beltLength(10, 10, 50)).toBeCloseTo(100 + 20 * Math.PI, 10);
    // symmetric in the pulley order
    expect(beltLength(25, 10, 75)).toBeCloseTo(open, 10);

    p.joints.find((j) => j.type === 'belt')!.crossed = true;
    const bc = Math.asin((r1 + r2) / C);
    const crossed = 2 * Math.sqrt(C * C - (r1 + r2) ** 2) + (r1 + r2) * (Math.PI + 2 * bc);
    const beltX = buildBOM(p).find((r) => r.kind === 'belt')!;
    expect(Number(/pitch length ([\d.]+) mm/.exec(beltX.spec)![1])).toBeCloseTo(crossed, 3);
    expect(crossed).toBeGreaterThan(open);
    expect(beltX.spec).toContain('crossed');
    expect(beltLength(10, 25, 14)).toBeNull(); // pulleys swallow each other
  });

  it('lists springs in N/mm and motor drives, moving the drive spec onto a motor part when one exists', () => {
    const p = rigProject();
    let rows = buildBOM(p);
    const spring = rows.find((r) => r.kind === 'spring')!;
    expect(spring.spec).toBe('Spring, k = 0.25 N/mm, free length 30 mm, ⌀coil 6 mm'); // 250 mN/mm = 0.25 N/mm
    const drive = rows.find((r) => r.kind === 'motor-drive')!;
    expect(drive.spec).toBe('Motor drive: target speed 120 rpm, torque limit 0.15 N·m'); // 4π rad/s, 150 000 mN·mm
    expect(drive.category).toBe('purchased');

    p.joints[2].motor!.maxTorque = null;
    rows = buildBOM(p);
    expect(rows.find((r) => r.kind === 'motor-drive')!.spec).toBe('Motor drive: target speed 120 rpm, torque limit unlimited/ideal');

    p.parts.push(createPart('motor', 'm', 'Stepper', { mass: 0.28 }));
    rows = buildBOM(p);
    expect(rows.some((r) => r.kind === 'motor-drive')).toBe(false);
    const motor = rows.find((r) => r.kind === 'motor')!;
    expect(motor.category).toBe('purchased');
    expect(motor.note).toContain('Motor drive: target speed 120 rpm, torque limit unlimited/ideal');
    expect(motor.massEach).toBeCloseTo(0.28, 12); // catalogue mass
  });

  it('writes RFC 4180 CSV with units in the column names', () => {
    const p = rigProject();
    const rows = buildBOM(p);
    const csv = bomCSV(rows);
    const lines = csv.split('\r\n');
    expect(lines[lines.length - 1]).toBe('');
    expect(lines.length).toBe(rows.length + 2);
    expect(lines[0]).toBe('item,part_numbers,name,qty,category,kind,spec,material,process,mass_each_g,mass_total_g,note');
    // commas and quotes inside fields are quoted / doubled
    expect(csv).toContain('3,P3,"Coupler ""long"", v2",1,custom,link,');
    expect(parsedSpecHasComma(geometryOf(p, p.parts[2]).spec, csv)).toBe(true);
    expect(csv).toContain(',P4 P5,Tie bar,2,custom,link,');
    // parse back with a strict RFC 4180 state machine
    const parsed: string[][] = [];
    let row: string[] = [], field = '', q = false;
    for (let i = 0; i < csv.length; i++) {
      const c = csv[i];
      if (q) {
        if (c === '"' && csv[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c;
      } else if (c === '"') { expect(field).toBe(''); q = true; }
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r' && csv[i + 1] === '\n') { row.push(field); parsed.push(row); row = []; field = ''; i++; }
      else field += c;
    }
    expect(q).toBe(false);
    expect(parsed.length).toBe(rows.length + 1);
    expect(parsed.every((r) => r.length === 12)).toBe(true);
    expect(parsed[3][2]).toBe('Coupler "long", v2');
    const tie = parsed.find((r) => r[2] === 'Tie bar')!;
    expect(Number(tie[9])).toBeCloseTo(massProps(p, p.parts[3]).mass * 1000, 3);
    expect(Number(tie[10])).toBeCloseTo(2 * Number(tie[9]), 2);
    expect(parsed.find((r) => r[5] === 'belt')![9]).toBe(''); // unknown mass stays blank
  });
});

// ---------------------------------------------------------------------------
// assembly guide
// ---------------------------------------------------------------------------

describe('assembly guide', () => {
  it('orders the steps: fixed frame, breadth-first over joints, lower z first, loose parts last', () => {
    const p = rigProject();
    const steps = assemblySteps(p);
    // level 0: grounded base. level 1 (joined to base or ground): Axle z0, Crank z4, pulleys z4. level 2: Coupler. loose: tie bars, gear
    expect(steps.map((s) => s.partNumber)).toEqual(['P1', 'P8', 'P2', 'P6', 'P7', 'P3', 'P4', 'P5', 'P10']);
    expect(steps.map((s) => s.role)).toEqual(['base', 'joined', 'joined', 'joined', 'joined', 'joined', 'loose', 'loose', 'loose']);
    expect(steps.map((s) => s.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const crank = steps[2];
    expect(crank.joints.map((j) => j.name)).toEqual(['Crank pivot']);
    const portLabel = (partIdx: number, port: string) => geometryOf(p, p.parts[partIdx]).ports.find((q) => q.id === port)!.label;
    expect(crank.instructions.join(' ')).toContain(`Fit P2 'Crank' (${portLabel(1, 'A')}) onto the pin at P1 'Base plate' ${portLabel(0, 'H1')} — revolute joint 'Crank pivot'.`);
    expect(crank.hardware).toEqual(['1 × Dowel pin / shoulder screw ⌀4 × 8 mm']);
    // the belt is fitted when its second pulley arrives
    const big = steps[4];
    expect(big.joints.map((j) => j.name)).toEqual(['Large pulley axle', 'Drive belt']);
    expect(big.hardware.some((h) => /^1 × Belt, pitch length 262\.966 mm/.test(h))).toBe(true);
    // every active joint is made exactly once
    const made = steps.flatMap((s) => s.joints.map((j) => j.id)).sort();
    expect(made).toEqual(['j1', 'j2', 'j3', 'j4', 'j5', 'j6', 'j8']);
  });

  it('produces a self-contained HTML guide with every part number, joint and step', () => {
    const p = rigProject();
    const html = assemblyGuideHTML(p);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<svg');
    const live = p.parts.filter((q) => !q.suppressed);
    for (const part of live) expect(html).toContain(`>${partNumber(p, part.id)}<`);
    expect(html).not.toContain('>P9<'); // suppressed
    for (const j of p.joints.filter((q) => q.id !== 'j7')) expect(html).toContain(j.name);
    expect(html).not.toContain('Ghost joint');
    // one exploded overview + one view per step
    expect((html.match(/<svg /g) ?? []).length).toBe(1 + live.length);
    expect((html.match(/<section class="step"/g) ?? []).length).toBe(live.length);
    expect(html).toContain('Custom parts (to manufacture)');
    expect(html).toContain('Purchased parts and hardware');
    expect(html).toContain('Mating table');
    expect(html).toContain('Coupler &quot;long&quot;, v2');
    expect(html).toContain('ratio 20:50 (pitch ⌀); pitch length 262.966 mm');
    expect(html).toContain('k = 0.25 N/mm');
    expect(html).toContain('must be checked by a competent person');
    // no external resources of any kind
    expect(html).not.toMatch(/<script|<link|<img|\ssrc=|\shref=|@import|url\(/i);
    expect([...html.matchAll(/https?:\/\/[^"'\s<]+/g)].map((m) => m[0]).every((u) => u === 'http://www.w3.org/2000/svg')).toBe(true);
    // every inline SVG is well-formed XML
    for (const svg of html.match(/<svg [\s\S]*?<\/svg>/g)!) expect(xmlCheck(svg)).toMatchObject({ ok: true, root: 'svg' });
  });

  it('draws exploded views with balloons, highlights and connector lines', () => {
    const p = rigProject();
    const all = explodedViewSVG(p);
    expect(xmlCheck(all)).toMatchObject({ ok: true, root: 'svg' });
    const balloons = [...all.matchAll(/<g class="balloon[^"]*" data-part="([^"]+)"/g)].map((m) => m[1]).sort();
    expect(balloons).toEqual(['P1', 'P10', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8']);
    expect(all).toMatch(/<svg [^>]*width="760"/);
    expect([...all.matchAll(/<line class="connector" data-joint="([^"]+)"/g)].map((m) => m[1])).toEqual(['Crank pivot', 'Crank pin']);
    expect(all).toContain('fill-rule="evenodd"');

    const step = explodedViewSVG(p, { partIds: ['base', 'crank'], highlight: ['crank'], width: 400 });
    expect(step).toMatch(/<svg [^>]*width="400"/);
    expect([...step.matchAll(/<g class="balloon[^"]*" data-part="([^"]+)"/g)].map((m) => m[1]).sort()).toEqual(['P1', 'P2']);
    expect(step).toContain('<g class="balloon highlight" data-part="P2">');
    expect(step).toContain('class="part-layer highlight" data-part="P2"');
    expect(step).not.toContain('data-part="P3"');
    // the step view keeps the frame of the full assembly so consecutive steps line up
    const vb = (s: string) => /viewBox="([^"]+)"/.exec(s)![1];
    expect(vb(explodedViewSVG(p, { partIds: ['base'] }))).toBe(vb(all));
    // explode = 0 collapses the stack: the frame gets smaller
    const flat = explodedViewSVG(p, { explode: 0 });
    expect(Number(vb(flat).split(' ')[3])).toBeLessThan(Number(vb(all).split(' ')[3]));
    // parts are painted from the lowest z upwards
    const order = [...all.matchAll(/<g class="part-layer[^"]*" data-part="([^"]+)"/g)].map((m) => m[1]);
    expect(order[0]).toBe('P1');
    expect(order.indexOf('P2')).toBeLessThan(order.indexOf('P3'));
    expect(explodedViewSVG(mkProject('Empty'))).toContain('No parts to show');
  });
});
