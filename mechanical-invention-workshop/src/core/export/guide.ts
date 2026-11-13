/**
 * Assembly guide: exploded views (inline SVG), BOM, mating table and ordered
 * assembly steps as one self-contained, print-friendly HTML document.
 */
import type { Anchor, Joint, Part, Project } from '../model/types';
import { GROUND } from '../model/types';
import { anchorWorld, geometryOf, jointLabel, materialOf, partById } from '../model/project';
import { PART_DEFS, findPort } from '../parts/catalog';
import { areaProps, pointInContours, signedArea, transformPoly, type Poly, type Pt } from '../math/poly';
import { escXml, fmt, sortedLayers } from './common';
import { partNumber } from './parts';
import {
  activeJoints, beltInfo, buildBOM, jointHardware, motorDriveSpec, pinSpec, springInfo, type BomRow,
} from './bom';

export const GUIDE_DISCLAIMER =
  'This guide is generated automatically from the design model. Dimensions are in millimetres. ' +
  'Simulation results and generated geometry are an aid to design, not a guarantee: fits, material, ' +
  'manufacturing process, fasteners and real-world load capacity must be checked by a competent person before the mechanism is built or used.';

// ---------------------------------------------------------------- exploded view

export interface ExplodedOpts {
  /** part ids drawn in the accent colour; when given, all other parts are drawn muted */
  highlight?: string[];
  /** part ids to draw (default: every non-suppressed part). The frame always fits the whole project. */
  partIds?: string[];
  /** explode factor: 0 = assembled, 1 = default spacing */
  explode?: number;
  /** pixel width of the SVG (default 760) */
  width?: number;
}

/** oblique projection: the stacking axis Z is drawn as an offset up and to the right */
const KX = 0.55;
const KY = 0.33; // = 0.6 · KX

function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy);
  if (L < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / L;
}

/** Douglas–Peucker on a closed polygon (illustration only — never used for manufacturing output). */
export function simplifyClosed(p: Poly, tol: number): Poly {
  const n = p.length;
  if (n <= 8 || !(tol > 0)) return p;
  let far = 0, best = -1;
  for (let i = 1; i < n; i++) { const d = Math.hypot(p[i][0] - p[0][0], p[i][1] - p[0][1]); if (d > best) { best = d; far = i; } }
  const keep = new Uint8Array(n + 1);
  keep[0] = 1; keep[far] = 1; keep[n] = 1;
  const at = (i: number) => p[i % n];
  const stack: [number, number][] = [[0, far], [far, n]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    let worst = -1, wi = -1;
    for (let i = i0 + 1; i < i1; i++) { const d = perpDist(at(i), at(i0), at(i1)); if (d > worst) { worst = d; wi = i; } }
    if (wi >= 0 && worst > tol) { keep[wi] = 1; stack.push([i0, wi], [wi, i1]); }
  }
  const out: Poly = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i]);
  return out.length >= 3 ? out : p;
}

function shade(hex: string, k: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  const ch = (c: number) => Math.max(0, Math.min(255, Math.round(k <= 1 ? c * k : c + (255 - c) * (k - 1))));
  const r = ch((v >> 16) & 255), g = ch((v >> 8) & 255), b = ch(v & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

interface PartView {
  part: Part;
  pn: string;
  /** world-space layers: contours at design pose, world z range (not exploded) */
  layers: { contours: Poly[]; z0: number; z1: number }[];
  zBase: number;
  zTop: number;
  level: number;
  /** world XY point on the top face that a balloon can point at */
  target: Pt;
}

function partViews(project: Project, tolOf: (size: number) => number): { views: PartView[]; size: number; wb: { x0: number; y0: number; x1: number; y1: number } } {
  const live = project.parts.filter((p) => !p.suppressed);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const raw = live.map((part) => {
    const g = geometryOf(project, part);
    const layers = sortedLayers(g).map((l) => ({
      contours: l.contours.map((c) => transformPoly(c, part.pose.x, part.pose.y, part.pose.angle)),
      z0: part.pose.z + l.z0, z1: part.pose.z + l.z1,
    }));
    for (const l of layers) for (const c of l.contours) for (const [x, y] of c) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return { part, layers, zBase: part.pose.z + g.zMin, zTop: part.pose.z + g.zMax };
  }).filter((v) => v.layers.length > 0);
  if (!raw.length) return { views: [], size: 1, wb: { x0: 0, y0: 0, x1: 1, y1: 1 } };
  const size = Math.max(x1 - x0, y1 - y0, 1);
  const tol = tolOf(size);
  const levels = [...new Set(raw.map((v) => Math.round(v.zBase * 1e4) / 1e4))].sort((a, b) => a - b);
  const views: PartView[] = raw.map((v) => {
    const layers = v.layers.map((l) => ({ ...l, contours: l.contours.map((c) => simplifyClosed(c, tol)) }));
    // balloon target: a point on solid material of the topmost layer
    const top = v.layers.reduce((a, b) => (b.z1 > a.z1 ? b : a));
    const outer = top.contours.filter((c) => signedArea(c) > 0).sort((a, b) => signedArea(b) - signedArea(a))[0] ?? top.contours[0];
    const ap = areaProps([outer]);
    let target: Pt = [ap.cx, ap.cy];
    if (!pointInContours(target[0], target[1], top.contours)) {
      search: for (const t of [0.5, 0.7, 0.3, 0.85]) {
        for (let k = 0; k < 8; k++) {
          const q = outer[Math.floor((k / 8) * outer.length)];
          const c: Pt = [ap.cx + (q[0] - ap.cx) * t, ap.cy + (q[1] - ap.cy) * t];
          if (pointInContours(c[0], c[1], top.contours)) { target = c; break search; }
        }
      }
    }
    return {
      part: v.part, pn: partNumber(project, v.part.id), layers, zBase: v.zBase, zTop: v.zTop,
      level: levels.indexOf(Math.round(v.zBase * 1e4) / 1e4), target,
    };
  });
  return { views, size, wb: { x0, y0, x1, y1 } };
}

/**
 * Exploded oblique view of the assembly with part-number balloons.
 * screen = (x + KX·z', −(y + KY·z')), where z' = z + level · spacing.
 */
export function explodedViewSVG(project: Project, opts: ExplodedOpts = {}): string {
  const width = Math.max(240, Math.round(opts.width ?? 760));
  const explode = Math.max(0, opts.explode ?? 1);
  // simplify outlines to about half a pixel of the requested output width
  const { views, size } = partViews(project, (s) => (0.7 * s) / width);
  const n2 = (v: number) => fmt(v, 2);
  if (!views.length) {
    return `<svg xmlns="http://www.w3.org/2000/svg" class="exploded-view" width="${width}" height="80" viewBox="0 0 ${width} 80" role="img"><title>Exploded view</title><text x="${width / 2}" y="44" font-family="sans-serif" font-size="14" text-anchor="middle" fill="#555">No parts to show</text></svg>`;
  }
  const spacing = explode * Math.max(10, Math.min(60, 0.22 * size));
  const zOff = (v: PartView) => v.level * spacing;
  const proj = (x: number, y: number, z: number): Pt => [x + KX * z, -(y + KY * z)];

  // frame from ALL parts so that step views share one stable frame
  let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
  for (const v of views) for (const l of v.layers) for (const z of [l.z0, l.z1]) for (const c of l.contours) for (const [x, y] of c) {
    const [X, Y] = proj(x, y, z + zOff(v));
    if (X < gx0) gx0 = X; if (X > gx1) gx1 = X; if (Y < gy0) gy0 = Y; if (Y > gy1) gy1 = Y;
  }
  const gW = Math.max(gx1 - gx0, 1e-6);
  // 1 px in user units, solving vbW = gW + 2·(column offset) with offsets given in px
  const COL = 52; // px from geometry edge to balloon centre
  const R_PX = 13;
  const PAD = 6;
  const u = gW / Math.max(60, width - 2 * (COL + R_PX + PAD));
  const R = R_PX * u;
  const cxMid = (gx0 + gx1) / 2;

  // balloons: left / right columns, sorted by height, pushed apart
  interface Balloon { v: PartView; tx: number; ty: number; bx: number; by: number }
  const balloons: Balloon[] = views.map((v) => {
    const [tx, ty] = proj(v.target[0], v.target[1], v.zTop + zOff(v));
    return { v, tx, ty, bx: tx < cxMid ? gx0 - COL * u : gx1 + COL * u, by: ty };
  });
  for (const side of [-1, 1]) {
    const col = balloons.filter((b) => (b.bx < cxMid ? -1 : 1) === side).sort((a, b) => a.ty - b.ty || a.v.pn.localeCompare(b.v.pn));
    const gap = 2.35 * R;
    let shift = 0;
    col.forEach((b, i) => { if (i > 0) b.by = Math.max(b.ty, col[i - 1].by + gap); shift += b.by - b.ty; });
    if (col.length) { shift /= col.length; for (const b of col) b.by -= shift; }
  }
  let vx0 = gx0 - (COL + R_PX + PAD) * u, vx1 = gx1 + (COL + R_PX + PAD) * u;
  let vy0 = gy0 - PAD * u, vy1 = gy1 + PAD * u;
  for (const b of balloons) { vy0 = Math.min(vy0, b.by - R - PAD * u); vy1 = Math.max(vy1, b.by + R + PAD * u); }
  const vbW = vx1 - vx0, vbH = vy1 - vy0;
  const height = Math.max(40, Math.round((vbH / vbW) * width));

  const shown = opts.partIds ? new Set(opts.partIds) : null;
  const hl = opts.highlight ? new Set(opts.highlight) : null;
  const isShown = (v: PartView) => !shown || shown.has(v.part.id);

  // painter's order: lowest exploded z first
  interface Item { z: number; order: number; svg: string }
  const items: Item[] = [];
  const pathD = (polys: Pt[][]) => polys.map((p) => `M${p.map(([x, y]) => `${n2(x)} ${n2(y)}`).join('L')}Z`).join('');
  views.forEach((v, vi) => {
    if (!isShown(v)) return;
    const mat = materialOf(project, v.part.materialId);
    const accent = hl ? hl.has(v.part.id) : false;
    const base = hl ? (accent ? '#f59e0b' : '#e5e7eb') : (v.part.color ?? mat.color);
    const fill = hl ? base : shade(base, 1.25);
    const side = shade(fill, 0.72);
    const stroke = hl && !accent ? '#9ca3af' : '#1f2937';
    v.layers.forEach((l, li) => {
      const za = l.z0 + zOff(v), zb = l.z1 + zOff(v);
      const bottom = l.contours.map((c) => c.map(([x, y]) => proj(x, y, za)));
      const top = l.contours.map((c) => c.map(([x, y]) => proj(x, y, zb)));
      const quads: Pt[][] = [];
      for (let ci = 0; ci < bottom.length; ci++) {
        const b = bottom[ci], t = top[ci];
        for (let i = 0; i < b.length; i++) {
          const j = (i + 1) % b.length;
          const q: Pt[] = [b[i], b[j], t[j], t[i]];
          const a2 = (q[0][0] * q[1][1] - q[1][0] * q[0][1]) + (q[1][0] * q[2][1] - q[2][0] * q[1][1]) + (q[2][0] * q[3][1] - q[3][0] * q[2][1]) + (q[3][0] * q[0][1] - q[0][0] * q[3][1]);
          if (Math.abs(a2) < 1e-9) continue;
          quads.push(a2 < 0 ? q.reverse() : q); // uniform winding → non-zero fill never cancels
        }
      }
      const sw = n2(0.9 * u);
      const svg =
        `<g class="part-layer${accent ? ' highlight' : ''}" data-part="${escXml(v.pn)}">` +
        `<path d="${pathD(bottom)}" fill="${side}" fill-rule="evenodd" stroke="${stroke}" stroke-width="${n2(0.6 * u)}" stroke-linejoin="round"/>` +
        (quads.length ? `<path d="${pathD(quads)}" fill="${side}" fill-rule="nonzero" stroke="none"/>` : '') +
        `<path d="${pathD(top)}" fill="${fill}" fill-rule="evenodd" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>` +
        '</g>';
      items.push({ z: za, order: vi * 100 + li, svg });
    });
  });
  items.sort((a, b) => a.z - b.z || a.order - b.order);

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" class="exploded-view" width="${width}" height="${height}" viewBox="${n2(vx0)} ${n2(vy0)} ${n2(vbW)} ${n2(vbH)}" role="img" font-family="sans-serif">` +
    `<title>${escXml(`Exploded view — ${project.name}`)}</title>`,
  );
  out.push('<g class="parts">');
  for (const it of items) out.push(it.svg);
  out.push('</g>');

  // connector lines along the explode axis between mating anchors
  const byId = new Map(views.map((v) => [v.part.id, v]));
  out.push(`<g class="connectors" fill="none" stroke="#475569" stroke-width="${n2(0.8 * u)}" stroke-dasharray="${n2(4 * u)} ${n2(3 * u)}" opacity="0.75">`);
  for (const j of activeJoints(project)) {
    if (j.type !== 'revolute' && j.type !== 'rigid') continue;
    const va = byId.get(j.a), vb = byId.get(j.b);
    if (!va || !vb || !isShown(va) || !isShown(vb)) continue;
    const wa = anchorWorld(project, j.a, j.anchorA), wb = anchorWorld(project, j.b, j.anchorB);
    const [lo, hi, pl, ph] = va.zBase + zOff(va) <= vb.zBase + zOff(vb) ? [va, vb, wa, wb] : [vb, va, wb, wa];
    // only where the explosion actually opened a gap between the two parts
    if (hi.zBase + zOff(hi) - (lo.zTop + zOff(lo)) < 1e-6) continue;
    const p0 = proj(pl.x, pl.y, lo.zTop + zOff(lo));
    const p1 = proj(ph.x, ph.y, hi.zBase + zOff(hi));
    if (Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < 1.5 * u) continue;
    out.push(`<line class="connector" data-joint="${escXml(j.name)}" x1="${n2(p0[0])}" y1="${n2(p0[1])}" x2="${n2(p1[0])}" y2="${n2(p1[1])}"/>`);
  }
  out.push('</g>');

  out.push('<g class="balloons">');
  for (const b of balloons) {
    if (!isShown(b.v)) continue;
    const accent = hl ? hl.has(b.v.part.id) : false;
    const dx = b.tx - b.bx, dy = b.ty - b.by;
    const L = Math.hypot(dx, dy) || 1;
    const ex = b.bx + (dx / L) * R, ey = b.by + (dy / L) * R;
    const fs = (b.v.pn.length > 3 ? 9 : 11) * u;
    out.push(
      `<g class="balloon${accent ? ' highlight' : ''}" data-part="${escXml(b.v.pn)}">` +
      `<line x1="${n2(ex)}" y1="${n2(ey)}" x2="${n2(b.tx)}" y2="${n2(b.ty)}" stroke="#111827" stroke-width="${n2(0.8 * u)}"/>` +
      `<circle cx="${n2(b.tx)}" cy="${n2(b.ty)}" r="${n2(1.8 * u)}" fill="#111827"/>` +
      `<circle cx="${n2(b.bx)}" cy="${n2(b.by)}" r="${n2(R)}" fill="${accent ? '#fde68a' : '#ffffff'}" stroke="#111827" stroke-width="${n2((accent ? 1.8 : 1.1) * u)}"/>` +
      `<text x="${n2(b.bx)}" y="${n2(b.by + fs * 0.36)}" font-size="${n2(fs)}" text-anchor="middle" font-weight="bold" fill="#111827">${escXml(b.v.pn)}</text>` +
      '</g>',
    );
  }
  out.push('</g></svg>');
  return out.join('');
}

// ---------------------------------------------------------------- assembly order

export interface AssemblyStep {
  index: number;
  partId: string;
  partNumber: string;
  /** 'base': grounded / fixed to ground; 'joined': connected to something already placed; 'loose': no connection yet */
  role: 'base' | 'joined' | 'loose';
  /** joints made in this step (to ground or to parts placed earlier) */
  joints: Joint[];
  /** plain-text instructions */
  instructions: string[];
  hardware: string[];
}

function anchorText(project: Project, partId: string, anchor: Anchor): string {
  if (partId === GROUND) return `(${fmt(anchor.x ?? 0, 2)}, ${fmt(anchor.y ?? 0, 2)}) mm`;
  const part = partById(project, partId);
  if (part && anchor.port !== undefined) {
    const port = findPort(geometryOf(project, part), anchor.port);
    if (port) return port.label;
  }
  return `point (${fmt(anchor.x ?? 0, 2)}, ${fmt(anchor.y ?? 0, 2)})`;
}

function refOf(project: Project, partId: string): string {
  if (partId === GROUND) return 'the fixed frame (ground)';
  const p = partById(project, partId);
  return `${partNumber(project, partId)} '${p?.name ?? partId}'`;
}

function gearRatio(project: Project, j: Joint): string {
  const a = partById(project, j.a), b = partById(project, j.b);
  if (!a || !b) return '';
  const za = a.kind === 'gear' ? Math.round(a.params.teeth) : undefined;
  const zb = b.kind === 'gear' ? Math.round(b.params.teeth) : undefined;
  if (za && zb) return `ratio ${za}:${zb} (B turns ${fmt(za / zb, 4)}× A, reversed)`;
  const ra = geometryOf(project, a).pitchRadius, rb = geometryOf(project, b).pitchRadius;
  if (ra && rb) return `ratio ${fmt(2 * ra)}:${fmt(2 * rb)} (pitch ⌀)`;
  return '';
}

/** Key parameter of a joint for the mating table. */
export function jointKeyParameter(project: Project, j: Joint): string {
  const bits: string[] = [];
  const deg = (r: number) => `${fmt((r * 180) / Math.PI, 2)}°`;
  if (j.type === 'revolute') {
    const pin = pinSpec(project, j);
    bits.push(pin ? `pin ⌀${fmt(pin.d)} × ${fmt(pin.length)} mm` : 'runs on the shaft / axle part');
    if (j.limits?.enabled) bits.push(`travel ${deg(j.limits.lower)} … ${deg(j.limits.upper)}`);
  } else if (j.type === 'prismatic') {
    bits.push(`slide axis ${deg(j.axisAngle ?? 0)} in A`);
    if (j.limits?.enabled) bits.push(`travel ${fmt(j.limits.lower)} … ${fmt(j.limits.upper)} mm`);
  } else if (j.type === 'rigid') {
    bits.push(j.angle !== undefined ? `fixed at ${deg(j.angle)}` : 'fixed');
  } else if (j.type === 'gear') {
    bits.push(gearRatio(project, j) || 'gear mesh');
  } else if (j.type === 'rackPinion') {
    const a = partById(project, j.a), b = partById(project, j.b);
    const r = (a && geometryOf(project, a).pitchRadius) || (b && geometryOf(project, b).pitchRadius) || 0;
    bits.push(r > 0 ? `pinion pitch ⌀${fmt(2 * r)} mm → ${fmt(2 * Math.PI * r, 2)} mm per turn` : 'rack & pinion');
  } else if (j.type === 'belt') {
    const b = beltInfo(project, j);
    if (b) bits.push(`ratio ${fmt(2 * b.r1)}:${fmt(2 * b.r2)} (pitch ⌀)${b.crossed ? ', crossed' : ''}`, b.length !== null ? `pitch length ${fmt(b.length)} mm` : 'belt length undefined');
  } else if (j.type === 'cam') {
    const cam = [partById(project, j.a), partById(project, j.b)].find((p) => p?.kind === 'cam');
    bits.push(cam ? `design roller R${fmt(cam.params.rollerRadius)} mm` : 'cam contact');
  } else if (j.type === 'spring') {
    const s = springInfo(project, j);
    if (s) bits.push(`k = ${Number(s.rateNmm.toPrecision(4))} N/mm`, `free length ${fmt(s.freeLength)} mm`);
  }
  const drive = motorDriveSpec(j);
  if (drive) bits.push(drive);
  return bits.join('; ');
}

function instruction(project: Project, j: Joint, partId: string): string {
  const selfIsA = j.a === partId;
  const other = selfIsA ? j.b : j.a;
  const aSelf = anchorText(project, partId, selfIsA ? j.anchorA : j.anchorB);
  const aOther = anchorText(project, other, selfIsA ? j.anchorB : j.anchorA);
  const me = refOf(project, partId), them = refOf(project, other);
  const tag = `${jointLabel(j).toLowerCase()} joint '${j.name}'`;
  const ground = other === GROUND;
  let text: string;
  switch (j.type) {
    case 'revolute':
      text = ground
        ? `Pin ${me} (${aSelf}) to the fixed frame at ${aOther} so that it turns freely — ${tag}.`
        : `Fit ${me} (${aSelf}) onto the pin at ${them} ${aOther} — ${tag}.`;
      break;
    case 'rigid':
      text = ground
        ? `Fix ${me} (${aSelf}) to the fixed frame at ${aOther} — ${tag}.`
        : `Fasten ${me} (${aSelf}) rigidly to ${them} (${aOther}) — ${tag}.`;
      break;
    case 'prismatic':
      text = ground
        ? `Guide ${me} (${aSelf}) so that it slides along the fixed frame through ${aOther} — ${tag}.`
        : `Slide ${me} (${aSelf}) into the guide of ${them} (${aOther}) and check that it moves freely (slide clearance ${fmt(project.clearances.slide)} mm per side) — ${tag}.`;
      break;
    case 'gear': {
      const r = gearRatio(project, j);
      text = `Mesh the teeth of ${me} with ${them}${r ? ` (${r})` : ''}; the gears must turn freely with slight backlash — ${tag}.`;
      break;
    }
    case 'rackPinion':
      text = `Engage ${me} with ${them} so that the pitch line of the rack is tangent to the pinion pitch circle — ${tag}.`;
      break;
    case 'belt': {
      const b = beltInfo(project, j);
      text = `Loop the belt around ${me} and ${them}${b?.length ? ` (pitch length ${fmt(b.length)} mm${b.crossed ? ', crossed' : ''})` : ''} — ${tag}.`;
      break;
    }
    case 'cam':
      text = `Bring ${me} (${aSelf}) into contact with ${them} (${aOther}); the roller must stay on the cam surface (spring or gravity) — ${tag}.`;
      break;
    case 'spring': {
      const s = springInfo(project, j);
      text = `Hook the spring between ${me} (${aSelf}) and ${ground ? `the fixed frame at ${aOther}` : `${them} (${aOther})`}${s ? ` (k = ${Number(s.rateNmm.toPrecision(4))} N/mm)` : ''} — ${tag}.`;
      break;
    }
    default:
      text = `Connect ${me} to ${them} — ${tag}.`;
  }
  const drive = motorDriveSpec(j);
  return drive ? `${text} Driven joint — ${drive}.` : text;
}

/**
 * Assembly order: grounded parts / parts fixed to ground first, then
 * breadth-first over the joint graph (ties: lower pose.z first, then project
 * order), then components without a ground connection, then loose parts.
 */
export function assemblySteps(project: Project): AssemblyStep[] {
  const live = project.parts.filter((p) => !p.suppressed);
  const idx = new Map(project.parts.map((p, i) => [p.id, i]));
  const joints = activeJoints(project);
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a)!.add(b); };
  for (const j of joints) { if (j.a !== j.b) { link(j.a, j.b); link(j.b, j.a); } }
  const byZ = (a: Part, b: Part) => a.pose.z - b.pose.z || idx.get(a.id)! - idx.get(b.id)!;
  const order: { part: Part; role: AssemblyStep['role'] }[] = [];
  const placed = new Set<string>();
  const place = (parts: Part[], role: AssemblyStep['role']) => {
    for (const p of parts.sort(byZ)) if (!placed.has(p.id)) { placed.add(p.id); order.push({ part: p, role }); }
  };
  const bfs = (frontier: string[]) => {
    while (frontier.length) {
      const next = new Set<string>();
      for (const id of frontier) for (const nb of adj.get(id) ?? []) if (nb !== GROUND && !placed.has(nb)) next.add(nb);
      const parts = live.filter((p) => next.has(p.id));
      place(parts, 'joined');
      frontier = parts.map((p) => p.id);
    }
  };
  // 1. the fixed frame
  const fixed = live.filter((p) => p.grounded || joints.some((j) => j.type === 'rigid' && ((j.a === GROUND && j.b === p.id) || (j.b === GROUND && j.a === p.id))));
  place(fixed, 'base');
  // 2. everything reachable from ground / the fixed parts
  bfs([GROUND, ...fixed.map((p) => p.id)]);
  // 3. connected groups that never reach ground, lowest part first
  for (;;) {
    const rest = live.filter((p) => !placed.has(p.id) && (adj.get(p.id)?.size ?? 0) > 0).sort(byZ);
    if (!rest.length) break;
    place([rest[0]], 'loose');
    bfs([rest[0].id]);
  }
  // 4. unconnected parts
  place(live.filter((p) => !placed.has(p.id)), 'loose');

  const done = new Set<string>([GROUND]);
  return order.map(({ part, role }, i) => {
    const mine = joints.filter((j) => (j.a === part.id && done.has(j.b)) || (j.b === part.id && done.has(j.a)));
    done.add(part.id);
    const me = refOf(project, part.id);
    const g = geometryOf(project, part);
    const zText = `z = ${fmt(part.pose.z + g.zMin, 2)} … ${fmt(part.pose.z + g.zMax, 2)} mm`;
    const instructions: string[] = [];
    if (part.grounded) instructions.push(`Place ${me} at its design position (${fmt(part.pose.x, 2)}, ${fmt(part.pose.y, 2)}) mm and fix it to the work surface — it is part of the fixed frame (${zText}).`);
    else if (!mine.length) instructions.push(`Position ${me} at (${fmt(part.pose.x, 2)}, ${fmt(part.pose.y, 2)}) mm, ${zText}. No joint connects it to the parts placed so far${(adj.get(part.id)?.size ?? 0) === 0 ? ' — fasten or support it as your design requires' : ''}.`);
    else instructions.push(`Take ${me} (${PART_DEFS[part.kind].label}${PART_DEFS[part.kind].purchased ? ', purchased' : ''}); it sits at ${zText} in the stack.`);
    if (!sortedLayers(g).length) instructions.push(`Note: ${me} has no solid geometry in the model${g.warnings.length ? ` (${g.warnings[0]})` : ''}, so it is not shown in the views.`);
    for (const j of mine) instructions.push(instruction(project, j, part.id));
    const hardware: string[] = [];
    for (const j of mine) for (const h of jointHardware(project, j)) if (h.kind !== 'motor-drive') hardware.push(`1 × ${h.spec}`);
    return { index: i + 1, partId: part.id, partNumber: partNumber(project, part.id), role, joints: mine, instructions, hardware };
  });
}

// ---------------------------------------------------------------- HTML

const CSS = `
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#111827;background:#fff;margin:0;padding:24px;line-height:1.45;font-size:14px}
main{max-width:960px;margin:0 auto}
h1{font-size:26px;margin:0 0 4px}
h2{font-size:18px;margin:32px 0 10px;padding-bottom:4px;border-bottom:2px solid #111827}
h3{font-size:15px;margin:18px 0 6px}
p{margin:6px 0}
.sub{color:#4b5563;margin:0 0 12px}
.disclaimer{border:1px solid #b45309;background:#fffbeb;padding:10px 12px;border-radius:4px;font-size:13px}
.desc{white-space:pre-wrap;color:#374151}
table{border-collapse:collapse;width:100%;font-size:12.5px;margin:6px 0 14px}
th,td{border:1px solid #9ca3af;padding:4px 6px;text-align:left;vertical-align:top}
th{background:#f3f4f6}
td.num,th.num{text-align:right;white-space:nowrap}
figure{margin:8px 0;text-align:center}
figure svg{max-width:100%;height:auto}
figcaption{font-size:12px;color:#4b5563}
.step{border:1px solid #d1d5db;border-radius:4px;padding:10px 14px;margin:12px 0;break-inside:avoid;page-break-inside:avoid}
.step h3{margin-top:0}
.step ol,.step ul{margin:4px 0 4px 20px;padding:0}
.hw{font-size:13px;color:#374151}
.pn{font-weight:700;white-space:nowrap}
.muted{color:#6b7280}
footer{margin-top:28px;font-size:12px;color:#6b7280;border-top:1px solid #d1d5db;padding-top:8px}
@media print{body{padding:0;font-size:11.5px}h2{break-after:avoid}table,figure{break-inside:avoid}.disclaimer{background:none}}
`.trim();

const h = escXml;

function bomTable(rows: BomRow[], caption: string): string {
  if (!rows.length) return `<h3>${h(caption)}</h3><p class="muted">None.</p>`;
  const body = rows.map((r) =>
    `<tr><td class="num">${r.item}</td><td class="pn">${h(r.partNumbers.join(', ') || '—')}</td><td>${h(r.name)}</td><td class="num">${r.qty}</td>` +
    `<td>${h(r.spec)}</td><td>${h(r.material)}</td><td>${h(r.process)}</td><td class="num">${r.massEach > 0 ? h(fmt(r.massEach * 1000, 2)) : '—'}</td><td>${h(r.note)}</td></tr>`).join('\n');
  return `<h3>${h(caption)}</h3>\n<table class="bom">\n<thead><tr><th class="num">Item</th><th>Part No.</th><th>Name</th><th class="num">Qty</th><th>Specification</th><th>Material</th><th>Process</th><th class="num">Mass each (g)</th><th>Note</th></tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
}

/** Self-contained HTML assembly guide (inline CSS and SVG, no external resources). */
export function assemblyGuideHTML(project: Project): string {
  const live = project.parts.filter((p) => !p.suppressed);
  const rows = buildBOM(project);
  const joints = activeJoints(project);
  const steps = assemblySteps(project);
  const out: string[] = [];
  out.push('<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">');
  out.push(`<title>${h(project.name)} — assembly guide</title>\n<style>${CSS}</style>\n</head>\n<body>\n<main>`);
  out.push(`<h1>${h(project.name)}</h1>\n<p class="sub">Assembly guide · ${live.length} part${live.length === 1 ? '' : 's'} · ${joints.length} joint${joints.length === 1 ? '' : 's'} · all dimensions in mm</p>`);
  out.push(`<p class="disclaimer"><strong>Read first.</strong> ${h(GUIDE_DISCLAIMER)}</p>`);
  if (project.description?.trim()) out.push(`<p class="desc">${h(project.description.trim())}</p>`);

  // exploded view
  out.push('<h2>1. Exploded view</h2>');
  out.push(`<figure>${explodedViewSVG(project, { width: 900 })}<figcaption>Parts are spread along the stacking axis Z (drawn up and to the right). Dashed lines join mating pin / fastening points. Balloons show part numbers.</figcaption></figure>`);
  if (live.length) {
    out.push('<table class="legend"><thead><tr><th>Part No.</th><th>Name</th><th>Type</th><th>Material</th><th class="num">Stack z (mm)</th></tr></thead><tbody>');
    for (const p of live) {
      const g = geometryOf(project, p);
      const def = PART_DEFS[p.kind];
      out.push(`<tr><td class="pn">${h(partNumber(project, p.id))}</td><td>${h(p.name)}</td><td>${h(def.label)}${def.purchased ? ' (purchased)' : ''}</td><td>${h(materialOf(project, p.materialId).name)}</td><td class="num">${h(fmt(p.pose.z + g.zMin, 2))} … ${h(fmt(p.pose.z + g.zMax, 2))}</td></tr>`);
    }
    out.push('</tbody></table>');
  }

  // BOM
  out.push('<h2>2. Bill of materials</h2>');
  out.push(bomTable(rows.filter((r) => r.category === 'custom'), 'Custom parts (to manufacture)'));
  out.push(bomTable(rows.filter((r) => r.category === 'purchased'), 'Purchased parts and hardware'));

  // mating table
  out.push('<h2>3. Mating table</h2>');
  if (!joints.length) out.push('<p class="muted">This project has no joints.</p>');
  else {
    out.push('<table class="mates"><thead><tr><th>Joint</th><th>Type</th><th>Part A</th><th>Anchor A</th><th>Part B</th><th>Anchor B</th><th>Key parameter</th></tr></thead><tbody>');
    const side = (id: string) => (id === GROUND ? '<span class="muted">Ground (fixed frame)</span>' : `<span class="pn">${h(partNumber(project, id))}</span> ${h(partById(project, id)?.name ?? id)}`);
    for (const j of joints) {
      out.push(`<tr><td>${h(j.name)}</td><td>${h(jointLabel(j))}</td><td>${side(j.a)}</td><td>${h(anchorText(project, j.a, j.anchorA))}</td><td>${side(j.b)}</td><td>${h(anchorText(project, j.b, j.anchorB))}</td><td>${h(jointKeyParameter(project, j))}</td></tr>`);
    }
    out.push('</tbody></table>');
  }

  // steps
  out.push('<h2>4. Assembly steps</h2>');
  if (!steps.length) out.push('<p class="muted">Nothing to assemble: the project has no parts.</p>');
  const sofar: string[] = [];
  for (const s of steps) {
    sofar.push(s.partId);
    const part = partById(project, s.partId)!;
    out.push(`<section class="step" id="step-${s.index}">`);
    out.push(`<h3>Step ${s.index} of ${steps.length} — add <span class="pn">${h(s.partNumber)}</span> ${h(part.name)}</h3>`);
    out.push(`<figure>${explodedViewSVG(project, { partIds: sofar.slice(), highlight: [s.partId], width: 620 })}</figure>`);
    out.push(`<ol>${s.instructions.map((t) => `<li>${h(t)}</li>`).join('')}</ol>`);
    out.push(s.hardware.length
      ? `<p class="hw"><strong>Hardware used:</strong> ${s.hardware.map(h).join('; ')}</p>`
      : '<p class="hw muted">No extra hardware in this step.</p>');
    out.push('</section>');
  }
  out.push(`<footer>${h('Generated by Mechanism Workshop. Dimensions in mm. Generated geometry — verify fits, material and loads before manufacture.')}</footer>`);
  out.push('</main>\n</body>\n</html>\n');
  return out.join('\n');
}
