/**
 * Dimensioned 2D engineering drawing of one part as a self-contained SVG.
 *
 * The sheet is A4 landscape (297 × 210 mm); 1 SVG user unit = 1 mm of paper.
 * Model geometry is drawn at one of the standard scales and all dimension
 * texts state TRUE model millimetres. Machine-readable metadata
 * (data-* attributes) always carries true model values as well.
 */
import type { Part, Project } from '../model/types';
import { geometryOf, massProps, materialOf, partById } from '../model/project';
import { PART_DEFS, type PartGeometry } from '../parts/catalog';
import { bounds, pointInContours, type Poly, type Pt } from '../math/poly';
import { contourKey, escXml, fmt, geometryBounds, identicalCount, matchHoles, num, sortedLayers } from './common';
import { partNumber } from './parts';

export const SHEET_W = 297;
export const SHEET_H = 210;
const BORDER = 8;
const TB_W = 124;
const TB_H = 40;
const TABLE_W = 72;

export const GENERAL_NOTE = 'Dimensions in mm. Generated geometry — verify fits, material and loads before manufacture.';

/** preferred scales first, then emergency reductions for very large parts */
const SCALES = [5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01];

export function scaleLabel(s: number): string {
  return s >= 1 ? `${fmt(s, 3)}:1` : `1:${fmt(1 / s, 3)}`;
}

const f = (v: number) => fmt(v, 3);
const textWidth = (s: string, size: number) => s.length * size * 0.56;

interface TextOpts { size?: number; anchor?: 'start' | 'middle' | 'end'; rotate?: number; cls?: string; bold?: boolean }

/** Collects SVG fragments in paper millimetres and tracks their bounding box. */
class Canvas {
  out: string[] = [];
  x0 = Infinity; y0 = Infinity; x1 = -Infinity; y1 = -Infinity;

  grow(x: number, y: number, pad = 0): void {
    if (x - pad < this.x0) this.x0 = x - pad;
    if (x + pad > this.x1) this.x1 = x + pad;
    if (y - pad < this.y0) this.y0 = y - pad;
    if (y + pad > this.y1) this.y1 = y + pad;
  }
  raw(s: string): void { this.out.push(s); }
  line(xa: number, ya: number, xb: number, yb: number, cls: string): void {
    this.grow(xa, ya); this.grow(xb, yb);
    this.out.push(`<line class="${cls}" x1="${f(xa)}" y1="${f(ya)}" x2="${f(xb)}" y2="${f(yb)}"/>`);
  }
  circle(cx: number, cy: number, r: number, cls: string, grow = true): void {
    if (grow) { this.grow(cx, cy, r); }
    this.out.push(`<circle class="${cls}" cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}"/>`);
  }
  /** closed polylines as one path */
  path(polys: Pt[][], cls: string): void {
    const d: string[] = [];
    for (const p of polys) {
      if (p.length < 2) continue;
      d.push(`M${p.map(([x, y]) => { this.grow(x, y); return `${f(x)} ${f(y)}`; }).join('L')}Z`);
    }
    if (d.length) this.out.push(`<path class="${cls}" d="${d.join('')}"/>`);
  }
  polygon(p: Pt[], cls: string): void {
    for (const [x, y] of p) this.grow(x, y);
    this.out.push(`<polygon class="${cls}" points="${p.map(([x, y]) => `${f(x)},${f(y)}`).join(' ')}"/>`);
  }
  rect(x: number, y: number, w: number, h: number, cls: string): void {
    this.grow(x, y); this.grow(x + w, y + h);
    this.out.push(`<rect class="${cls}" x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}"/>`);
  }
  text(x: number, y: number, s: string, o: TextOpts = {}): void {
    const size = o.size ?? 2.8, anchor = o.anchor ?? 'start', rot = o.rotate ?? 0;
    const w = textWidth(s, size);
    const xa = anchor === 'start' ? 0 : anchor === 'middle' ? -w / 2 : -w;
    const c = Math.cos((rot * Math.PI) / 180), sn = Math.sin((rot * Math.PI) / 180);
    for (const [lx, ly] of [[xa, -size * 0.8], [xa + w, -size * 0.8], [xa, size * 0.25], [xa + w, size * 0.25]]) {
      this.grow(x + c * lx - sn * ly, y + sn * lx + c * ly);
    }
    const tr = rot ? ` transform="rotate(${f(rot)} ${f(x)} ${f(y)})"` : '';
    this.out.push(`<text class="${o.cls ?? 't'}" x="${f(x)}" y="${f(y)}" font-size="${f(size)}" text-anchor="${anchor}"${o.bold ? ' font-weight="bold"' : ''}${tr}>${escXml(s)}</text>`);
  }
}

function arrow(c: Canvas, tip: Pt, dir: Pt): void {
  const L = 2.6, W = 0.5;
  const bx = tip[0] - dir[0] * L, by = tip[1] - dir[1] * L;
  c.polygon([tip, [bx - dir[1] * W, by + dir[0] * W], [bx + dir[1] * W, by - dir[0] * W]], 'arrow');
}

/**
 * Linear dimension in paper space. A, B: measured points; n: unit normal
 * pointing to the side of the dimension line; dist: distance of the dimension
 * line from A–B along n (> 0).
 */
function drawLinearDim(c: Canvas, A: Pt, B: Pt, n: Pt, dist: number, text: string, attrs: string): void {
  const A2: Pt = [A[0] + n[0] * dist, A[1] + n[1] * dist];
  const B2: Pt = [B[0] + n[0] * dist, B[1] + n[1] * dist];
  const L = Math.hypot(B2[0] - A2[0], B2[1] - A2[1]);
  if (L < 1e-9) return;
  const u: Pt = [(B2[0] - A2[0]) / L, (B2[1] - A2[1]) / L];
  const size = 2.8;
  const tw = textWidth(text, size);
  c.raw(`<g class="dim-linear" ${attrs}>`);
  // extension lines: 1 mm gap at the feature, 1.5 mm overshoot past the dimension line
  for (const P of [A, B]) c.line(P[0] + n[0] * 1, P[1] + n[1] * 1, P[0] + n[0] * (dist + 1.5), P[1] + n[1] * (dist + 1.5), 'ext');
  let rot = (Math.atan2(u[1], u[0]) * 180) / Math.PI;
  if (rot >= 90 - 1e-6) rot -= 180;
  if (rot < -90 - 1e-6) rot += 180;
  const rr = (rot * Math.PI) / 180;
  const up: Pt = [Math.sin(rr), -Math.cos(rr)]; // "above the line" for the reader
  let mid: Pt;
  if (L >= 9 && tw <= L - 6.5) {
    c.line(A2[0], A2[1], B2[0], B2[1], 'dimline');
    arrow(c, A2, [-u[0], -u[1]]);
    arrow(c, B2, u);
    mid = [(A2[0] + B2[0]) / 2, (A2[1] + B2[1]) / 2];
  } else if (L >= 9) {
    // arrows fit, text does not: text beside the B end on an extended line
    c.line(A2[0], A2[1], B2[0] + u[0] * (tw + 3), B2[1] + u[1] * (tw + 3), 'dimline');
    arrow(c, A2, [-u[0], -u[1]]);
    arrow(c, B2, u);
    mid = [B2[0] + u[0] * (tw / 2 + 2), B2[1] + u[1] * (tw / 2 + 2)];
  } else {
    // narrow gap: arrows outside pointing inwards, text beside the B end
    c.line(A2[0] - u[0] * 5, A2[1] - u[1] * 5, B2[0] + u[0] * (tw + 7), B2[1] + u[1] * (tw + 7), 'dimline');
    arrow(c, A2, u);
    arrow(c, B2, [-u[0], -u[1]]);
    mid = [B2[0] + u[0] * (tw / 2 + 6), B2[1] + u[1] * (tw / 2 + 6)];
  }
  c.text(mid[0] + up[0] * 0.9, mid[1] + up[1] * 0.9, text, { size, anchor: 'middle', rotate: rot, cls: 't dimtext' });
  c.raw('</g>');
}

interface Placed { n: Pt; a: Pt; b: Pt }

interface ViewResult { canvas: Canvas }

function renderViews(part: Part, g: PartGeometry, s: number): ViewResult {
  const c = new Canvas();
  const gb = geometryBounds(g);
  const layers = sortedLayers(g);
  const M = (p: Pt): Pt => [p[0] * s, -p[1] * s];
  const allPts: Pt[] = [];
  for (const l of layers) for (const k of l.contours) for (const p of k) allPts.push(p);

  // ------------------------------------------------------------ front view
  c.raw('<g class="view front-view">');
  // visible = not completely covered by a layer above it
  const byTop = layers.slice().sort((a, b) => b.z1 - a.z1 || b.z0 - a.z0);
  const drawn = new Set<string>();
  const hiddenPolys: Pt[][] = [], visiblePolys: Pt[][] = [];
  const holeDrawn = new Set<number>();
  const holeHidden = new Set<number>();
  byTop.forEach((l, li) => {
    const above = byTop.slice(0, li).filter((o) => o.z1 > l.z1 - 1e-9 && o !== l);
    const m = matchHoles(l.contours, g.holes);
    const isHidden = (poly: Poly) => above.some((o) => poly.every(([x, y]) => pointInContours(x, y, o.contours)));
    for (const poly of [...m.outer, ...m.inner]) {
      const key = contourKey(poly);
      if (drawn.has(key)) continue;
      drawn.add(key);
      (li > 0 && isHidden(poly) ? hiddenPolys : visiblePolys).push(poly.map(M));
    }
    for (const hi of m.holeIdx) {
      if (holeDrawn.has(hi)) continue;
      holeDrawn.add(hi);
      if (li > 0 && above.some((o) => pointInContours(g.holes[hi].x + g.holes[hi].d / 2 - 1e-6, g.holes[hi].y, o.contours) && pointInContours(g.holes[hi].x, g.holes[hi].y, o.contours))) holeHidden.add(hi);
    }
  });
  c.path(hiddenPolys, 'hidden');
  c.path(visiblePolys, 'outline');
  g.holes.forEach((h, i) => {
    if (!holeDrawn.has(i)) return;
    const [x, y] = M([h.x, h.y]);
    c.circle(x, y, (h.d / 2) * s, holeHidden.has(i) ? 'hidden' : 'outline');
  });

  // part origin marker (reference for the hole table)
  if (!gb.empty && gb.x0 - 1e-9 <= 0 && gb.x1 + 1e-9 >= 0 && gb.y0 - 1e-9 <= 0 && gb.y1 + 1e-9 >= 0) {
    c.raw('<g class="origin" data-x="0" data-y="0">');
    c.line(-3, 0, 3, 0, 'centre'); c.line(0, -3, 0, 3, 'centre');
    c.raw('</g>');
  }

  // hole centre marks + labels
  for (const h of g.holes) {
    const [x, y] = M([h.x, h.y]);
    const e = (h.d / 2) * s + 1.6;
    c.raw(`<g class="hole-centre" data-x="${num(h.x)}" data-y="${num(h.y)}" data-d="${num(h.d)}" data-nominal="${num(h.nominal)}" data-label="${escXml(h.label)}">`);
    c.line(x - e, y, x + e, y, 'centre');
    c.line(x, y - e, x, y + e, 'centre');
    c.raw('</g>');
    c.text(x + (h.d / 2) * s * 0.75 + 0.8, y - (h.d / 2) * s * 0.75 - 0.8, h.label, { size: 2.2, cls: 't holelabel' });
  }

  // dimensions from the parametric model
  const placed: Placed[] = [];
  const usedAngles: { cx: number; cy: number; a: number }[] = [];
  const MIN_CLEAR = 6; // paper mm between the part and a dimension line
  /** model-space directions already occupied by extension lines, per feature point */
  const busy: { x: number; y: number; a: number }[] = [];
  const ordered = [...g.dims.filter((d) => d.kind === 'linear'), ...g.dims.filter((d) => d.kind === 'diameter')];
  for (const d of ordered) {
    if (d.kind === 'linear') {
      const dx = d.b[0] - d.a[0], dy = d.b[1] - d.a[1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      const nm: Pt = [-dy / len, dx / len]; // left normal, model
      let lo = Infinity, hi = -Infinity;
      for (const [x, y] of allPts) {
        const pr = (x - d.a[0]) * nm[0] + (y - d.a[1]) * nm[1];
        if (pr < lo) lo = pr; if (pr > hi) hi = pr;
      }
      if (!Number.isFinite(lo)) { lo = 0; hi = 0; }
      const eps = 1e-6;
      const inside = (v: number) => v > lo + eps && v < hi - eps;
      let off = d.offset ?? -8;
      if (off === 0) off = -8;
      if (inside(off)) {
        // the requested side would put the dimension line across the part:
        // mirror it if the other side is free, otherwise push it out
        if (!inside(-off)) off = -off;
        else off = off > 0 ? hi + MIN_CLEAR / s : lo - MIN_CLEAR / s;
      }
      // keep a readable gap between part and dimension line at this scale
      if (off > 0) off = Math.max(off, hi + MIN_CLEAR / s);
      else off = Math.min(off, lo - MIN_CLEAR / s);
      const sign = off > 0 ? 1 : -1;
      const n: Pt = [nm[0] * sign, -nm[1] * sign];
      for (const q of [d.a, d.b]) busy.push({ x: q[0], y: q[1], a: Math.atan2(nm[1] * sign, nm[0] * sign) });
      let dist = Math.abs(off) * s;
      const A = M(d.a), B = M(d.b);
      const u: Pt = [(B[0] - A[0]) / (len * s), (B[1] - A[1]) / (len * s)];
      for (let iter = 0; iter < 8; iter++) {
        const a2: Pt = [A[0] + n[0] * dist, A[1] + n[1] * dist];
        const clash = placed.some((p) => {
          if (p.n[0] * n[0] + p.n[1] * n[1] < 0.98) return false;
          const sep = Math.abs((a2[0] - p.a[0]) * n[0] + (a2[1] - p.a[1]) * n[1]);
          if (sep > 5.5) return false;
          const t0 = (p.a[0] - a2[0]) * u[0] + (p.a[1] - a2[1]) * u[1];
          const t1 = (p.b[0] - a2[0]) * u[0] + (p.b[1] - a2[1]) * u[1];
          return Math.max(t0, t1) > -2 && Math.min(t0, t1) < len * s + 2;
        });
        if (!clash) break;
        dist += 7;
      }
      placed.push({ n, a: [A[0] + n[0] * dist, A[1] + n[1] * dist], b: [B[0] + n[0] * dist, B[1] + n[1] * dist] });
      drawLinearDim(c, A, B, n, dist, d.label ?? f(len), `data-value="${num(len)}" data-ax="${num(d.a[0])}" data-ay="${num(d.a[1])}" data-bx="${num(d.b[0])}" data-by="${num(d.b[1])}"`);
    } else if (d.kind === 'diameter') {
      const r = d.d / 2;
      if (!(r > 0)) continue;
      const angDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
      /** distance along the ray from the centre at which it finally leaves the part profile */
      const exitAt = (a: number): number => {
        const ux = Math.cos(a), uy = Math.sin(a);
        let best = r;
        for (const l of layers) for (const poly of l.contours) {
          for (let i = 0, n = poly.length; i < n; i++) {
            const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % n];
            const ex = x1 - x0, ey = y1 - y0;
            const den = ux * ey - uy * ex;
            if (Math.abs(den) < 1e-12) continue;
            const t = ((x0 - d.c[0]) * ey - (y0 - d.c[1]) * ex) / den;
            const w = ((x0 - d.c[0]) * uy - (y0 - d.c[1]) * ux) / den;
            if (t > best && w >= -1e-9 && w <= 1 + 1e-9) best = t;
          }
        }
        return best;
      };
      const taken = (a: number) =>
        usedAngles.some((q) => Math.hypot(q.cx - d.c[0], q.cy - d.c[1]) < 1e-6 && angDiff(q.a, a) < 0.3) ||
        busy.some((q) => Math.hypot(q.x - d.c[0], q.y - d.c[1]) < 1e-6 && angDiff(q.a, a) < 0.45);
      let ang: number;
      if (d.angle !== undefined) {
        ang = d.angle;
        // do not stack two leaders of the same centre on top of each other
        for (let k = 0; k < 12 && usedAngles.some((q) => Math.hypot(q.cx - d.c[0], q.cy - d.c[1]) < 1e-6 && angDiff(q.a, ang) < 0.3); k++) ang += 0.55;
      } else {
        // no preferred direction: shortest free leader among the 45° directions
        const cand = [45, 135, -135, -45, 90, -90, 0, 180].map((v) => (v * Math.PI) / 180);
        let bestScore = Infinity;
        ang = cand[0];
        cand.forEach((a, i) => {
          const score = exitAt(a) * s + (taken(a) ? 1e6 : 0) + i * 1e-3;
          if (score < bestScore) { bestScore = score; ang = a; }
        });
      }
      usedAngles.push({ cx: d.c[0], cy: d.c[1], a: ang });
      const ux = Math.cos(ang), uy = Math.sin(ang);
      const exit = exitAt(ang);
      const rEnd = Math.max(r, exit) + 7 / s;
      const isHole = g.holes.some((h) => Math.hypot(h.x - d.c[0], h.y - d.c[1]) < 1e-6 && Math.abs(h.d - d.d) < 1e-6);
      const [cx, cy] = M(d.c);
      const P0: Pt = M([d.c[0] + r * ux, d.c[1] + r * uy]);
      const P1: Pt = M([d.c[0] + rEnd * ux, d.c[1] + rEnd * uy]);
      const text = d.label ?? `⌀${f(d.d)}`;
      const right = ux >= -1e-9;
      c.raw(`<g class="dim-diameter" data-value="${num(d.d)}" data-cx="${num(d.c[0])}" data-cy="${num(d.c[1])}">`);
      if (!isHole) c.circle(cx, cy, r * s, 'ref');
      c.line(P1[0], P1[1], P0[0], P0[1], 'dimline');
      arrow(c, P0, [-ux, uy]); // tip on the circle, pointing at the centre
      const sx = P1[0] + (right ? 4 : -4);
      c.line(P1[0], P1[1], sx, P1[1], 'dimline');
      c.text(sx + (right ? 0.8 : -0.8), P1[1] + 1, text, { size: 2.8, anchor: right ? 'start' : 'end', cls: 't dimtext' });
      c.raw('</g>');
    }
  }
  c.raw('</g>');

  if (gb.empty) return { canvas: c };

  // caption of the front view
  const frontLeft = c.x0, frontTop = c.y0;
  c.text(frontLeft, frontTop - 3, 'FRONT VIEW (looking along −Z)', { size: 2.4, cls: 't caption' });

  // ------------------------------------------------------------ side view (Z stack-up)
  const sideX = c.x1 + 16;
  const Z = (z: number) => sideX + (z - gb.zMin) * s;
  c.raw('<g class="view side-view">');
  let sy0 = Infinity, sy1 = -Infinity;
  const hiddenSeen = new Set<string>();
  for (const l of layers) {
    const b = bounds(l.contours);
    c.rect(Z(l.z0), -b.y1 * s, (l.z1 - l.z0) * s, (b.y1 - b.y0) * s, 'outline');
    sy0 = Math.min(sy0, -b.y1 * s); sy1 = Math.max(sy1, -b.y0 * s);
    const m = matchHoles(l.contours, g.holes);
    for (const hi of m.holeIdx) {
      const h = g.holes[hi];
      for (const yy of [h.y - h.d / 2, h.y + h.d / 2]) {
        const key = `${f(l.z0)}|${f(l.z1)}|${f(yy)}`;
        if (hiddenSeen.has(key)) continue;
        hiddenSeen.add(key);
        c.line(Z(l.z0), -yy * s, Z(l.z1), -yy * s, 'hidden');
      }
    }
  }
  const centreSeen = new Set<string>();
  for (const h of g.holes) {
    const key = f(h.y);
    if (centreSeen.has(key)) continue;
    centreSeen.add(key);
    c.line(Z(gb.zMin) - 2, -h.y * s, Z(gb.zMax) + 2, -h.y * s, 'centre');
  }
  const T = gb.zMax - gb.zMin;
  drawLinearDim(c, [Z(gb.zMin), sy1], [Z(gb.zMax), sy1], [0, 1], 8, f(T), `data-value="${num(T)}" data-kind="thickness"`);
  c.text(Z(gb.zMin), sy0 - 3, 'SIDE VIEW (Z →)', { size: 2.4, cls: 't caption' });
  c.raw('</g>');
  return { canvas: c };
}

function wrapText(s: string, maxChars: number): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > maxChars) { lines.push(cur); cur = w; }
    else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function clip(s: string, width: number, size: number): string {
  const max = Math.max(3, Math.floor(width / (size * 0.56)));
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const STYLE = [
  'text{font-family:sans-serif;fill:#111;stroke:none}',
  '.outline{fill:none;stroke:#000;stroke-width:0.35;stroke-linejoin:round}',
  '.hidden{fill:none;stroke:#444;stroke-width:0.18;stroke-dasharray:1.6 0.8}',
  '.centre{fill:none;stroke:#b00020;stroke-width:0.13;stroke-dasharray:4 0.8 0.6 0.8}',
  '.hole-centre .centre,.origin .centre{stroke-dasharray:none}',
  '.ref{fill:none;stroke:#555;stroke-width:0.13;stroke-dasharray:5 0.9 0.7 0.9}',
  '.ext,.dimline{fill:none;stroke:#0b3d91;stroke-width:0.13}',
  '.arrow{fill:#0b3d91;stroke:none}',
  '.dimtext{fill:#0b3d91}',
  '.holelabel{fill:#b00020}',
  '.caption{fill:#555}',
  '.frame{fill:none;stroke:#000;stroke-width:0.5}',
  '.thin{fill:none;stroke:#000;stroke-width:0.18}',
  '.sheet{fill:#fff;stroke:none}',
].join('');

/**
 * Dimensioned engineering drawing (front view, side view, hole table, title block).
 * Throws if the part id is unknown.
 */
export function partDrawingSVG(project: Project, partId: string): string {
  const part = partById(project, partId);
  if (!part) throw new Error(`partDrawingSVG: no part with id "${partId}"`);
  const g = geometryOf(project, part);
  const gb = geometryBounds(g);
  const pn = partNumber(project, part.id);
  const mat = materialOf(project, part.materialId);
  const qty = identicalCount(project, part);
  const hasHoles = g.holes.length > 0;

  // ---- sheet regions ----
  const ax0 = BORDER + 4;
  const ax1 = hasHoles ? SHEET_W - BORDER - TABLE_W - 6 : SHEET_W - BORDER - 4;
  const ay0 = BORDER + 4;
  const ay1 = SHEET_H - BORDER - TB_H - 4;
  const aw = ax1 - ax0, ah = ay1 - ay0;

  // ---- pick the largest standard scale at which the annotated views fit ----
  let scale = SCALES[SCALES.length - 1];
  let view = renderViews(part, g, scale);
  for (const s of SCALES) {
    const v = renderViews(part, g, s);
    const w = v.canvas.x1 - v.canvas.x0, h = v.canvas.y1 - v.canvas.y0;
    if (!Number.isFinite(w) || (w <= aw && h <= ah)) { scale = s; view = v; break; }
  }
  const vc = view.canvas;
  const vw = Number.isFinite(vc.x1 - vc.x0) ? vc.x1 - vc.x0 : 0, vh = Number.isFinite(vc.y1 - vc.y0) ? vc.y1 - vc.y0 : 0;
  const tx = ax0 + (aw - vw) / 2 - (Number.isFinite(vc.x0) ? vc.x0 : 0);
  const ty = ay0 + (ah - vh) / 2 - (Number.isFinite(vc.y0) ? vc.y0 : 0);

  const out: string[] = [];
  const T = gb.zMax - gb.zMin;
  out.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${SHEET_W}mm" height="${SHEET_H}mm" viewBox="0 0 ${SHEET_W} ${SHEET_H}"` +
    ` data-part-number="${escXml(pn)}" data-part-id="${escXml(part.id)}" data-scale="${scaleLabel(scale)}" data-scale-factor="${num(scale)}"` +
    ` data-bbox-mm="${num(gb.x0)} ${num(gb.y0)} ${num(gb.x1)} ${num(gb.y1)}" data-thickness-mm="${num(T)}" data-units="mm">\n`,
  );
  out.push(`<title>${escXml(`${pn} ${part.name} — ${project.name}`)}</title>\n`);
  out.push(`<desc>Engineering drawing, A4 landscape, scale ${scaleLabel(scale)}. 1 user unit = 1 mm of paper; dimension texts and data-* attributes are true model millimetres in part-local coordinates. ${escXml(GENERAL_NOTE)}</desc>\n`);
  out.push(`<style>${STYLE}</style>\n`);
  out.push(`<rect class="sheet" x="0" y="0" width="${SHEET_W}" height="${SHEET_H}"/>\n`);
  out.push(`<rect class="frame" x="${BORDER}" y="${BORDER}" width="${SHEET_W - 2 * BORDER}" height="${SHEET_H - 2 * BORDER}"/>\n`);

  // ---- views ----
  out.push(`<g class="views" transform="translate(${f(tx)} ${f(ty)})">\n${vc.out.join('\n')}\n</g>\n`);
  if (gb.empty) {
    out.push(`<text class="t" x="${f(ax0 + aw / 2)}" y="${f(ay0 + ah / 2)}" font-size="5" text-anchor="middle">No solid geometry to draw</text>\n`);
  }

  // ---- hole table ----
  if (hasHoles) {
    const c = new Canvas();
    const x0 = SHEET_W - BORDER - TABLE_W - 2, y0 = BORDER + 4;
    const cols = [14, 14.5, 14.5, 14.5, 14.5];
    const heads = ['Hole', 'X', 'Y', '⌀ model', '⌀ nominal'];
    const availH = ay1 - y0 - 12;
    let rowH = 4.6;
    if (g.holes.length * rowH > availH) rowH = Math.max(2.9, availH / g.holes.length);
    const maxRows = Math.max(1, Math.floor(availH / rowH));
    const rows = g.holes.slice(0, maxRows);
    const fs = Math.min(2.6, rowH * 0.62);
    c.raw('<g class="hole-table">');
    c.text(x0, y0 + 3, 'HOLE TABLE', { size: 3, bold: true });
    c.text(x0 + TABLE_W, y0 + 3, 'mm, from part origin', { size: 2.2, anchor: 'end', cls: 't caption' });
    const top = y0 + 5;
    const hh = 5;
    c.rect(x0, top, TABLE_W, hh + rows.length * rowH, 'thin');
    c.line(x0, top + hh, x0 + TABLE_W, top + hh, 'thin');
    let x = x0;
    cols.forEach((w, i) => {
      if (i > 0) c.line(x, top, x, top + hh + rows.length * rowH, 'thin');
      c.text(x + w / 2, top + 3.5, heads[i], { size: 2.4, anchor: 'middle', bold: true });
      x += w;
    });
    rows.forEach((h, r) => {
      const y = top + hh + r * rowH;
      if (r > 0) c.line(x0, y, x0 + TABLE_W, y, 'thin');
      const cells = [clip(h.label, cols[0] - 1, fs), f(h.x), f(h.y), f(h.d), f(h.nominal)];
      let cx = x0;
      c.raw(`<g class="hole-row" data-label="${escXml(h.label)}" data-x="${num(h.x)}" data-y="${num(h.y)}" data-d="${num(h.d)}" data-nominal="${num(h.nominal)}">`);
      cells.forEach((t, i) => {
        c.text(i === 0 ? cx + cols[i] / 2 : cx + cols[i] - 1.2, y + rowH * 0.5 + fs * 0.36, t, { size: fs, anchor: i === 0 ? 'middle' : 'end' });
        cx += cols[i];
      });
      c.raw('</g>');
    });
    if (rows.length < g.holes.length) {
      c.text(x0, top + hh + rows.length * rowH + 3.5, `… and ${g.holes.length - rows.length} more hole(s): see the cutting profile (DXF)`, { size: 2.2, cls: 't caption' });
    }
    c.raw('</g>');
    out.push(c.out.join('\n') + '\n');
  }

  // ---- notes (under the views, left of the title block) ----
  {
    const c = new Canvas();
    const nx = BORDER + 4, nyTop = SHEET_H - BORDER - TB_H;
    const width = SHEET_W - 2 * BORDER - TB_W - 8;
    const size = 2.6;
    const maxChars = Math.floor(width / (size * 0.56));
    const notes: string[] = [];
    for (const d of g.dims) if (d.kind === 'note') notes.push(d.text);
    const layers = sortedLayers(g);
    if (layers.length > 1) notes.push(`Z stack-up (mm from the bottom face): ${layers.map((l) => `${f(l.z0 - gb.zMin)}–${f(l.z1 - gb.zMin)}`).join(', ')}`);
    notes.push(`Hole clearance ${f(project.clearances.hole)} on diameter · slide clearance ${f(project.clearances.slide)} per side · min. feature ${f(project.clearances.minFeature)}`);
    for (const w of g.warnings) notes.push(`Warning: ${w}`);
    c.raw('<g class="notes">');
    c.line(BORDER, nyTop, SHEET_W - BORDER - TB_W, nyTop, 'thin');
    c.text(nx, nyTop + 4.2, 'NOTES', { size: 2.8, bold: true });
    let y = nyTop + 8.4;
    const yMax = SHEET_H - BORDER - 1.5;
    let n = 0;
    outer: for (const note of notes) {
      n++;
      const lines = wrapText(`${n}. ${note}`, maxChars);
      for (const ln of lines) {
        if (y > yMax) break outer;
        c.text(nx, y, ln, { size, cls: 't note' });
        y += 3.7;
      }
    }
    c.raw('</g>');
    out.push(c.out.join('\n') + '\n');
  }

  // ---- title block ----
  {
    const c = new Canvas();
    const x0 = SHEET_W - BORDER - TB_W, y0 = SHEET_H - BORDER - TB_H;
    const mp = massProps(project, part);
    const def = PART_DEFS[part.kind];
    c.raw('<g class="title-block">');
    c.rect(x0, y0, TB_W, TB_H, 'frame');
    const r1 = 11, r2 = 7, r3 = 7, r4 = 7; // row heights; the rest is the general note
    const lab = (x: number, y: number, s: string) => c.text(x + 1.2, y + 2.6, s, { size: 1.9, cls: 't caption' });
    // row 1: part name | part number
    c.line(x0, y0 + r1, x0 + TB_W, y0 + r1, 'thin');
    c.line(x0 + TB_W - 30, y0, x0 + TB_W - 30, y0 + r1, 'thin');
    lab(x0, y0, 'PART');
    c.text(x0 + 1.5, y0 + 8.6, clip(part.name, TB_W - 34, 5), { size: 5, bold: true, cls: 't part-name' });
    lab(x0 + TB_W - 30, y0, 'PART No.');
    c.text(x0 + TB_W - 15, y0 + 8.8, pn, { size: 5.5, bold: true, anchor: 'middle', cls: 't part-number' });
    // row 2: project | kind
    let y = y0 + r1;
    c.line(x0, y + r2, x0 + TB_W, y + r2, 'thin');
    c.line(x0 + TB_W - 44, y, x0 + TB_W - 44, y + r2, 'thin');
    lab(x0, y, 'PROJECT');
    c.text(x0 + 15, y + 4.9, clip(project.name, TB_W - 61, 3.2), { size: 3.2, cls: 't project-name' });
    lab(x0 + TB_W - 44, y, 'TYPE');
    c.text(x0 + TB_W - 34, y + 4.9, clip(`${def.label}${def.purchased ? ' (purchased)' : ''}`, 33, 2.8), { size: 2.8 });
    // row 3: material | process
    y += r2;
    c.line(x0, y + r3, x0 + TB_W, y + r3, 'thin');
    c.line(x0 + TB_W - 56, y, x0 + TB_W - 56, y + r3, 'thin');
    lab(x0, y, 'MATERIAL');
    c.text(x0 + 15, y + 4.9, clip(mat.name, TB_W - 73, 3.2), { size: 3.2, cls: 't material' });
    lab(x0 + TB_W - 56, y, 'PROCESS');
    c.text(x0 + TB_W - 43, y + 4.9, clip(mat.process, 42, 2.8), { size: 2.8 });
    // row 4: qty | scale | units | mass | sheet
    y += r3;
    c.line(x0, y + r4, x0 + TB_W, y + r4, 'thin');
    const cells: [string, string, number][] = [
      ['QTY', String(qty), 20], ['SCALE', scaleLabel(scale), 24], ['UNITS', 'mm', 20],
      ['MASS', `${fmt(mp.mass * 1000, mp.mass * 1000 < 10 ? 2 : 1)} g`, 34], ['SHEET', 'A4', 26],
    ];
    let cx = x0;
    cells.forEach(([k, v, w], i) => {
      if (i > 0) c.line(cx, y, cx, y + r4, 'thin');
      lab(cx, y, k);
      c.text(cx + w - 1.5, y + 5.2, v, { size: 3.2, anchor: 'end', bold: k === 'QTY' || k === 'SCALE', cls: `t tb-${k.toLowerCase()}` });
      cx += w;
    });
    // row 5: general note
    y += r4;
    const noteLines = wrapText(GENERAL_NOTE, Math.floor((TB_W - 3) / (2.4 * 0.56)));
    noteLines.slice(0, 2).forEach((ln, i) => c.text(x0 + 1.5, y + 3.4 + i * 3.1, ln, { size: 2.4, cls: 't general-note' }));
    c.raw('</g>');
    out.push(c.out.join('\n') + '\n');
  }

  out.push('</svg>\n');
  return out.join('');
}
