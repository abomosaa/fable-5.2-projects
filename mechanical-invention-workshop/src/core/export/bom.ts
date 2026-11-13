/**
 * Bill of materials: custom parts, purchased parts, and the hardware implied
 * by joints (pins, springs, belts, motor drives).
 */
import type { Joint, Part, Project } from '../model/types';
import { GROUND } from '../model/types';
import { anchorWorld, geometryOf, massProps, materialOf, partById } from '../model/project';
import { PART_DEFS, findPort } from '../parts/catalog';
import { fmt, identityKey } from './common';
import { partNumber } from './parts';

export interface BomRow {
  item: number;
  /** "P#" of every part in this row (empty for joint hardware) */
  partNumbers: string[];
  partIds: string[];
  name: string;
  qty: number;
  category: 'custom' | 'purchased';
  /** part kind, or 'pin' | 'spring' | 'belt' | 'motor-drive' for joint hardware */
  kind: string;
  spec: string;
  material: string;
  process: string;
  /** kg (0 when unknown) */
  massEach: number;
  note: string;
}

export interface JointHardware {
  kind: 'pin' | 'spring' | 'belt' | 'motor-drive';
  name: string;
  spec: string;
  material: string;
  process: string;
  /** kg, 0 when unknown */
  massEach: number;
  note: string;
  jointId: string;
  jointName: string;
}

/** significant-digit formatting for derived engineering values */
const sig = (v: number, n = 4): string => (Number.isFinite(v) ? String(Number(v.toPrecision(n))) : String(v));

const STEEL_DENSITY = 7.85e-6; // kg/mm³

function livePart(project: Project, id: string): Part | undefined {
  const p = partById(project, id);
  return p && !p.suppressed ? p : undefined;
}

/** A joint counts when it is not suppressed and both sides are ground or existing, non-suppressed parts. */
export function jointActive(project: Project, j: Joint): boolean {
  if (j.suppressed) return false;
  for (const id of [j.a, j.b]) if (id !== GROUND && !livePart(project, id)) return false;
  return true;
}

export function activeJoints(project: Project): Joint[] {
  return project.joints.filter((j) => jointActive(project, j));
}

/**
 * Belt pitch length for two pulleys of pitch radii r1, r2 at centre distance C.
 * Open:    2·√(C² − (r1−r2)²) + r1·(π + 2β) + r2·(π − 2β),  β = asin((r1−r2)/C)
 * Crossed: 2·√(C² − (r1+r2)²) + (r1+r2)·(π + 2β),          β = asin((r1+r2)/C)
 * Returns null when the geometry is impossible.
 */
export function beltLength(r1: number, r2: number, C: number, crossed = false): number | null {
  if (!(r1 > 0) || !(r2 > 0) || !(C > 0)) return null;
  if (crossed) {
    const s = r1 + r2;
    if (C <= s) return null;
    const beta = Math.asin(s / C);
    return 2 * Math.sqrt(C * C - s * s) + s * (Math.PI + 2 * beta);
  }
  const d = r1 - r2;
  if (C <= Math.abs(d)) return null;
  const beta = Math.asin(d / C);
  return 2 * Math.sqrt(C * C - d * d) + r1 * (Math.PI + 2 * beta) + r2 * (Math.PI - 2 * beta);
}

function zRange(project: Project, part: Part): [number, number] {
  const g = geometryOf(project, part);
  return [part.pose.z + g.zMin, part.pose.z + g.zMax];
}

/** purchased parts that already ARE the axle of a revolute joint */
const AXLE_KINDS = new Set(['shaft', 'fastener', 'motor', 'bearing']);

export function pinSpec(project: Project, j: Joint): { d: number; length: number } | null {
  if (j.type !== 'revolute') return null;
  const a = j.a === GROUND ? undefined : livePart(project, j.a);
  const b = j.b === GROUND ? undefined : livePart(project, j.b);
  if ((a && AXLE_KINDS.has(a.kind)) || (b && AXLE_KINDS.has(b.kind))) return null;
  let d: number | undefined = j.pinDiameter && j.pinDiameter > 0 ? j.pinDiameter : undefined;
  for (const [part, anchor] of [[a, j.anchorA], [b, j.anchorB]] as const) {
    if (d !== undefined || !part) continue;
    const port = findPort(geometryOf(project, part), anchor.port);
    if (port?.d !== undefined && port.d > 0) d = port.d;
  }
  if (d === undefined) d = 4;
  let length: number;
  if (a && b) {
    const za = zRange(project, a), zb = zRange(project, b);
    length = Math.max(za[1], zb[1]) - Math.min(za[0], zb[0]);
  } else {
    const p = a ?? b;
    if (!p) return null;
    const z = zRange(project, p);
    length = z[1] - z[0] + 4;
  }
  return { d, length };
}

export function motorDriveSpec(j: Joint): string | null {
  const m = j.motor;
  if (!m?.enabled) return null;
  const linear = j.type === 'prismatic';
  const speed = linear ? `${sig(Math.abs(m.speed))} mm/s` : `${sig((Math.abs(m.speed) * 60) / (2 * Math.PI))} rpm`;
  const limit = m.maxTorque === null || m.maxTorque === undefined || !Number.isFinite(m.maxTorque)
    ? 'unlimited/ideal'
    : linear ? `${sig(m.maxTorque / 1000)} N` : `${sig(m.maxTorque / 1e6)} N·m`;
  const speedWord = m.type === 'dc' ? 'no-load speed' : 'target speed';
  const limitWord = linear ? (m.type === 'dc' ? 'stall force' : 'force limit') : (m.type === 'dc' ? 'stall torque' : 'torque limit');
  return `Motor drive${linear ? ' (linear)' : ''}: ${speedWord} ${speed}, ${limitWord} ${limit}${m.profile === 'reversing' ? `, reversing every ${sig(m.period ?? 0)} s` : ''}`;
}

export interface BeltInfo { r1: number; r2: number; centre: number; length: number | null; width: number; thickness?: number; crossed: boolean }

export function beltInfo(project: Project, j: Joint): BeltInfo | null {
  if (j.type !== 'belt') return null;
  const a = livePart(project, j.a), b = livePart(project, j.b);
  if (!a || !b) return null;
  const ga = geometryOf(project, a), gb = geometryOf(project, b);
  const r1 = ga.pitchRadius ?? findPort(ga, j.anchorA.port)?.r ?? 0;
  const r2 = gb.pitchRadius ?? findPort(gb, j.anchorB.port)?.r ?? 0;
  const centre = Math.hypot(a.pose.x - b.pose.x, a.pose.y - b.pose.y);
  const width = j.beltWidth ?? a.params.beltWidth ?? b.params.beltWidth ?? 6;
  const thickness = j.beltThickness ?? a.params.beltThickness ?? b.params.beltThickness;
  return { r1, r2, centre, length: beltLength(r1, r2, centre, !!j.crossed), width, thickness, crossed: !!j.crossed };
}

export interface SpringInfo { rate: number; /** N/mm */ rateNmm: number; designLength: number; freeLength: number }

export function springInfo(project: Project, j: Joint): SpringInfo | null {
  if (j.type !== 'spring') return null;
  const pa = anchorWorld(project, j.a, j.anchorA), pb = anchorWorld(project, j.b, j.anchorB);
  const designLength = Math.hypot(pa.x - pb.x, pa.y - pb.y);
  const rate = j.stiffness ?? 0;
  let freeLength = j.freeLength;
  if (freeLength === undefined) freeLength = rate > 0 ? designLength - (j.preload ?? 0) / rate : designLength;
  return { rate, rateNmm: rate / 1000, designLength, freeLength };
}

/** Hardware needed to realise one joint (pin, spring or belt, plus a motor drive when enabled). */
export function jointHardware(project: Project, j: Joint): JointHardware[] {
  const out: JointHardware[] = [];
  if (!jointActive(project, j)) return out;
  const base = { jointId: j.id, jointName: j.name };
  if (j.type === 'revolute') {
    const pin = pinSpec(project, j);
    if (pin) {
      out.push({
        ...base, kind: 'pin', name: 'Dowel pin / shoulder screw',
        spec: `Dowel pin / shoulder screw ⌀${fmt(pin.d)} × ${fmt(pin.length)} mm`,
        material: 'Steel', process: 'Purchased',
        massEach: STEEL_DENSITY * Math.PI * (pin.d / 2) ** 2 * pin.length,
        note: 'Length = stack height of the joined parts; pick the next standard length and add axial retention.',
      });
    }
  } else if (j.type === 'spring') {
    const s = springInfo(project, j)!;
    const coil = j.coilDiameter !== undefined ? `⌀coil ${fmt(j.coilDiameter)} mm` : '⌀coil not specified';
    const extra = `${j.wireDiameter !== undefined ? `, wire ⌀${fmt(j.wireDiameter)} mm` : ''}${j.coils !== undefined ? `, ${fmt(j.coils, 2)} coils` : ''}`;
    const type = s.freeLength < s.designLength - 1e-9 ? 'Extension spring' : s.freeLength > s.designLength + 1e-9 ? 'Compression spring' : 'Spring';
    out.push({
      ...base, kind: 'spring', name: type,
      spec: `Spring, k = ${sig(s.rateNmm)} N/mm, free length ${fmt(s.freeLength)} mm, ${coil}${extra}`,
      material: 'Spring steel', process: 'Purchased', massEach: 0,
      note: `Installed length ${fmt(s.designLength)} mm at the design pose.`,
    });
  } else if (j.type === 'belt') {
    const b = beltInfo(project, j);
    if (b) {
      out.push({
        ...base, kind: 'belt', name: b.crossed ? 'Belt (crossed)' : 'Belt',
        spec: b.length !== null
          ? `Belt, pitch length ${fmt(b.length)} mm, width ${fmt(b.width)} mm${b.thickness !== undefined ? `, thickness ${fmt(b.thickness)} mm` : ''}${b.crossed ? ', crossed' : ''}`
          : `Belt, pitch length undefined (pulleys overlap at centre distance ${fmt(b.centre)} mm), width ${fmt(b.width)} mm`,
        material: 'Rubber / PU', process: 'Purchased', massEach: 0,
        note: `Pitch ⌀${fmt(2 * b.r1)} / ⌀${fmt(2 * b.r2)} mm at centre distance ${fmt(b.centre)} mm.`,
      });
    }
  }
  const drive = motorDriveSpec(j);
  if (drive) {
    out.push({ ...base, kind: 'motor-drive', name: 'Motor drive', spec: drive, material: '—', process: 'Purchased', massEach: 0, note: '' });
  }
  return out;
}

export function buildBOM(project: Project): BomRow[] {
  type Draft = Omit<BomRow, 'item'>;
  const custom: Draft[] = [], purchased: Draft[] = [], hardware: Draft[] = [];

  // ---- parts, identical ones grouped ----
  const groups = new Map<string, Draft>();
  const names = new Map<string, string[]>();
  for (const part of project.parts) {
    if (part.suppressed) continue;
    const key = identityKey(part);
    let row = groups.get(key);
    if (!row) {
      const def = PART_DEFS[part.kind];
      const g = geometryOf(project, part);
      const mat = materialOf(project, part.materialId);
      row = {
        partNumbers: [], partIds: [], name: part.name, qty: 0,
        category: def.purchased ? 'purchased' : 'custom', kind: part.kind,
        spec: g.spec || def.label, material: mat.name, process: mat.process,
        massEach: massProps(project, part).mass,
        note: [...g.errors.map((e) => `NOT BUILDABLE AS SPECIFIED: ${e}`), ...g.warnings].join(' '),
      };
      groups.set(key, row);
      names.set(key, []);
      (def.purchased ? purchased : custom).push(row);
    }
    row.qty++;
    row.partNumbers.push(partNumber(project, part.id));
    row.partIds.push(part.id);
    const ns = names.get(key)!;
    if (!ns.includes(part.name)) ns.push(part.name);
    row.name = ns.join(' / ');
  }

  // ---- hardware implied by joints ----
  const joints = activeJoints(project);
  const motorParts = project.parts.filter((p) => !p.suppressed && p.kind === 'motor');
  const hw = new Map<string, { row: Draft; joints: string[] }>();
  const drives: string[] = [];
  for (const j of joints) {
    for (const h of jointHardware(project, j)) {
      if (h.kind === 'motor-drive' && motorParts.length > 0) {
        drives.push(`${h.spec} (joint "${j.name}")`);
        continue;
      }
      const key = `${h.kind}|${h.spec}`;
      let e = hw.get(key);
      if (!e) {
        e = {
          row: { partNumbers: [], partIds: [], name: h.name, qty: 0, category: 'purchased', kind: h.kind, spec: h.spec, material: h.material, process: h.process, massEach: h.massEach, note: h.note },
          joints: [],
        };
        hw.set(key, e);
        hardware.push(e.row);
      }
      e.row.qty++;
      e.joints.push(j.name);
    }
  }
  for (const e of hw.values()) {
    const where = `For joint${e.joints.length === 1 ? '' : 's'}: ${e.joints.map((n) => `"${n}"`).join(', ')}.`;
    e.row.note = e.row.note ? `${where} ${e.row.note}` : where;
  }
  // with motor parts in the project the drive spec is a property of the motor row
  if (drives.length) {
    for (const row of purchased) {
      if (row.kind !== 'motor') continue;
      const text = drives.join('; ');
      row.note = row.note ? `${row.note} ${text}` : text;
    }
  }

  return [...custom, ...purchased, ...hardware].map((r, i) => ({ item: i + 1, ...r }));
}

function csvField(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const BOM_CSV_COLUMNS = [
  'item', 'part_numbers', 'name', 'qty', 'category', 'kind', 'spec', 'material', 'process', 'mass_each_g', 'mass_total_g', 'note',
] as const;

/** RFC 4180 CSV (CRLF line ends, quotes doubled). Masses in grams; empty when unknown. */
export function bomCSV(rows: BomRow[]): string {
  const lines: string[] = [BOM_CSV_COLUMNS.join(',')];
  const grams = (kg: number) => (kg > 0 ? fmt(kg * 1000, 3) : '');
  for (const r of rows) {
    lines.push([
      r.item, r.partNumbers.join(' '), r.name, r.qty, r.category, r.kind, r.spec, r.material, r.process,
      grams(r.massEach), grams(r.massEach * r.qty), r.note,
    ].map(csvField).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
