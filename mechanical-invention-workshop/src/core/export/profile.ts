/**
 * Planar cutting profiles (laser / waterjet / router): ASCII DXF (R12,
 * AC1009) and SVG. True scale, millimetres, part-local coordinates.
 *
 * Layers
 *   CUT_OUTER      outer contours of the primary (lowest-z) layer, closed polylines
 *   CUT_INNER      inner contours of the primary layer; exact circular holes are
 *                  true CIRCLE entities, not polygons
 *   HOLE_CENTRES   a POINT at every hole centre (for drilling / marking)
 *   Z<z0>-<z1>_OUTER / _INNER
 *                  profiles of further Z layers that differ from the ones
 *                  already written (z measured from the bottom face, '.' → 'p')
 */
import type { Part, Project } from '../model/types';
import { geometryOf, partById } from '../model/project';
import type { HoleFeature } from '../parts/catalog';
import type { Poly } from '../math/poly';
import { contourSetKey, escXml, fmt, geometryBounds, matchHoles, num, sortedLayers, type ProfileBounds } from './common';
import { partNumber } from './parts';

export interface ProfileLayer {
  /** DXF layer names */
  outerName: string;
  innerName: string;
  z0: number;
  z1: number;
  outer: Poly[];
  /** non-circular inner loops */
  inner: Poly[];
  /** exact circular holes cut in this layer */
  holes: HoleFeature[];
}

export interface ProfileData {
  bounds: ProfileBounds;
  /** [0] is the primary profile (CUT_OUTER / CUT_INNER) */
  layers: ProfileLayer[];
  /** every hole feature of the part */
  holes: HoleFeature[];
  /** all DXF layer names in table order */
  layerNames: string[];
}

const zTag = (z: number) => fmt(z, 3).replace('.', 'p').replace('-', 'm');

/** The cutting-profile content shared by the DXF and SVG writers. */
export function profileData(project: Project, part: Part): ProfileData {
  const g = geometryOf(project, part);
  const gb = geometryBounds(g);
  const layers = sortedLayers(g);
  const out: ProfileLayer[] = [];
  const seen = new Set<string>();
  const cutSomewhere = new Set<number>();
  layers.forEach((l, i) => {
    const key = contourSetKey(l.contours);
    const m = matchHoles(l.contours, g.holes);
    if (seen.has(key)) return;
    seen.add(key);
    m.holeIdx.forEach((h) => cutSomewhere.add(h));
    const z0 = l.z0 - gb.zMin, z1 = l.z1 - gb.zMin;
    const primary = out.length === 0;
    const base = `Z${zTag(z0)}-${zTag(z1)}`;
    out.push({
      outerName: primary ? 'CUT_OUTER' : `${base}_OUTER`,
      innerName: primary ? 'CUT_INNER' : `${base}_INNER`,
      z0, z1, outer: m.outer, inner: m.inner, holes: m.holeIdx.map((h) => g.holes[h]),
    });
    void i;
  });
  // hole features without a matching polygon anywhere still belong on the primary profile
  if (out.length) {
    g.holes.forEach((h, i) => { if (!cutSomewhere.has(i)) out[0].holes.push(h); });
  }
  const layerNames = ['CUT_OUTER', 'CUT_INNER', 'HOLE_CENTRES'];
  for (const l of out.slice(1)) {
    if (!layerNames.includes(l.outerName)) layerNames.push(l.outerName);
    if (!layerNames.includes(l.innerName)) layerNames.push(l.innerName);
  }
  return { bounds: gb, layers: out, holes: g.holes, layerNames };
}

// ---------------------------------------------------------------------- DXF

class Dxf {
  private s: string[] = [];
  g(code: number, value: string | number): this {
    this.s.push(String(code), typeof value === 'number' ? num(value) : value);
    return this;
  }
  int(code: number, value: number): this { this.s.push(String(code), String(Math.round(value))); return this; }
  toString(): string { return this.s.join('\r\n') + '\r\n'; }
}

function dxfName(s: string): string {
  return s.replace(/[^A-Za-z0-9_$-]/g, '_').slice(0, 31);
}

function layerColor(name: string): number {
  if (name === 'CUT_OUTER') return 1;      // red
  if (name === 'CUT_INNER') return 5;      // blue
  if (name === 'HOLE_CENTRES') return 3;   // green
  return name.endsWith('_OUTER') ? 6 : 4;  // magenta / cyan for further Z layers
}

/**
 * Cutting profile as ASCII DXF R12 (AC1009): POLYLINE/VERTEX/SEQEND, CIRCLE
 * and POINT entities only, $INSUNITS = 4 (millimetres).
 */
export function partProfileDXF(project: Project, partId: string): string {
  const part = partById(project, partId);
  if (!part) throw new Error(`partProfileDXF: no part with id "${partId}"`);
  const pd = profileData(project, part);
  const b = pd.bounds;
  const d = new Dxf();
  d.g(999, `Mechanism Workshop cutting profile - ${partNumber(project, part.id)} ${part.name.replace(/[^\x20-\x7e]/g, '?')} - units mm, part-local coordinates, true scale`);
  // HEADER
  d.g(0, 'SECTION').g(2, 'HEADER');
  d.g(9, '$ACADVER').g(1, 'AC1009');
  d.g(9, '$INSBASE').g(10, 0).g(20, 0).g(30, 0);
  d.g(9, '$EXTMIN').g(10, b.x0).g(20, b.y0).g(30, 0);
  d.g(9, '$EXTMAX').g(10, b.x1).g(20, b.y1).g(30, 0);
  d.g(9, '$LIMMIN').g(10, b.x0).g(20, b.y0);
  d.g(9, '$LIMMAX').g(10, b.x1).g(20, b.y1);
  d.g(9, '$INSUNITS').int(70, 4);
  d.g(9, '$MEASUREMENT').int(70, 1);
  d.g(9, '$LUNITS').int(70, 2);
  d.g(9, '$LUPREC').int(70, 4);
  d.g(0, 'ENDSEC');
  // TABLES
  d.g(0, 'SECTION').g(2, 'TABLES');
  d.g(0, 'TABLE').g(2, 'LTYPE').int(70, 1);
  d.g(0, 'LTYPE').g(2, 'CONTINUOUS').int(70, 0).g(3, 'Solid line').int(72, 65).int(73, 0).g(40, 0);
  d.g(0, 'ENDTAB');
  d.g(0, 'TABLE').g(2, 'LAYER').int(70, pd.layerNames.length + 1);
  d.g(0, 'LAYER').g(2, '0').int(70, 0).int(62, 7).g(6, 'CONTINUOUS');
  for (const name of pd.layerNames) d.g(0, 'LAYER').g(2, dxfName(name)).int(70, 0).int(62, layerColor(name)).g(6, 'CONTINUOUS');
  d.g(0, 'ENDTAB');
  d.g(0, 'ENDSEC');
  d.g(0, 'SECTION').g(2, 'BLOCKS').g(0, 'ENDSEC');
  // ENTITIES
  d.g(0, 'SECTION').g(2, 'ENTITIES');
  const polyline = (layer: string, p: Poly) => {
    if (p.length < 2) return;
    d.g(0, 'POLYLINE').g(8, dxfName(layer)).int(66, 1).g(10, 0).g(20, 0).g(30, 0).int(70, 1); // 70 = 1: closed
    for (const [x, y] of p) d.g(0, 'VERTEX').g(8, dxfName(layer)).g(10, x).g(20, y).g(30, 0);
    d.g(0, 'SEQEND').g(8, dxfName(layer));
  };
  for (const l of pd.layers) {
    for (const p of l.outer) polyline(l.outerName, p);
    for (const p of l.inner) polyline(l.innerName, p);
    for (const h of l.holes) d.g(0, 'CIRCLE').g(8, dxfName(l.innerName)).g(10, h.x).g(20, h.y).g(30, 0).g(40, h.d / 2);
  }
  for (const h of pd.holes) d.g(0, 'POINT').g(8, 'HOLE_CENTRES').g(10, h.x).g(20, h.y).g(30, 0);
  d.g(0, 'ENDSEC');
  d.g(0, 'EOF');
  return d.toString();
}

// ---------------------------------------------------------------------- SVG

/**
 * Cutting profile as SVG for laser cutters: 1 user unit = 1 mm, hairline
 * strokes, CAD y-up flipped to SVG y-down (svg_y = −cad_y).
 */
export function partProfileSVG(project: Project, partId: string): string {
  const part = partById(project, partId);
  if (!part) throw new Error(`partProfileSVG: no part with id "${partId}"`);
  const pd = profileData(project, part);
  const b = pd.bounds;
  const pn = partNumber(project, part.id);
  const margin = 1;
  const W = b.x1 - b.x0 + 2 * margin, H = b.y1 - b.y0 + 2 * margin;
  const n = (v: number) => num(v);
  const pathOf = (polys: Poly[]) => polys.filter((p) => p.length >= 2).map((p) => `M${p.map(([x, y]) => `${n(x)} ${n(-y)}`).join('L')}Z`).join('');
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${n(W)}mm" height="${n(H)}mm" viewBox="${n(b.x0 - margin)} ${n(-b.y1 - margin)} ${n(W)} ${n(H)}"` +
    ` data-part-number="${escXml(pn)}" data-part-id="${escXml(part.id)}" data-bbox-mm="${n(b.x0)} ${n(b.y0)} ${n(b.x1)} ${n(b.y1)}" data-units="mm" data-y-axis="flipped">\n`,
  );
  out.push(`<title>${escXml(`${pn} ${part.name} — cutting profile`)}</title>\n`);
  out.push(
    '<desc>Cutting profile, true scale: 1 user unit = 1 mm. Part-local CAD coordinates with the Y axis flipped for SVG: ' +
    'svg_x = cad_x, svg_y = −cad_y (CAD y-up → SVG y-down). data-* attributes carry true CAD values. ' +
    'Red (cut-outer): outer contour, cut last. Blue (cut-inner, hole): inner cut-outs and holes, cut first. ' +
    'Green (hole-centre): centre marks only, do not cut. Magenta: profiles of further Z layers, for reference. ' +
    'Stroke width 0.1 mm (hairline); kerf is not compensated.</desc>\n',
  );
  out.push('<g fill="none" stroke-width="0.1" stroke-linejoin="round">\n');
  pd.layers.forEach((l, i) => {
    if (i === 0) {
      out.push(`<g id="CUT_INNER" stroke="#0000ff">\n`);
      if (l.inner.length) out.push(`<path class="cut-inner" d="${pathOf(l.inner)}"/>\n`);
      for (const h of l.holes) out.push(`<circle class="cut-inner hole" cx="${n(h.x)}" cy="${n(-h.y)}" r="${n(h.d / 2)}" data-label="${escXml(h.label)}"/>\n`);
      out.push('</g>\n');
      out.push(`<g id="CUT_OUTER" stroke="#ff0000">\n`);
      for (const p of l.outer) out.push(`<path class="cut-outer" d="${pathOf([p])}"/>\n`);
      out.push('</g>\n');
    } else {
      out.push(`<g id="${escXml(l.outerName.replace(/_OUTER$/, ''))}" class="extra-layer" stroke="#ff00ff" data-z0="${n(l.z0)}" data-z1="${n(l.z1)}">\n`);
      if (l.outer.length) out.push(`<path class="layer-outer" d="${pathOf(l.outer)}"/>\n`);
      if (l.inner.length) out.push(`<path class="layer-inner" d="${pathOf(l.inner)}"/>\n`);
      for (const h of l.holes) out.push(`<circle class="layer-inner layer-hole" cx="${n(h.x)}" cy="${n(-h.y)}" r="${n(h.d / 2)}"/>\n`);
      out.push('</g>\n');
    }
  });
  out.push('<g id="HOLE_CENTRES" stroke="#00a000">\n');
  for (const h of pd.holes) {
    const e = Math.max(0.3, Math.min(1, h.d / 4));
    out.push(
      `<g class="hole-centre" data-x="${n(h.x)}" data-y="${n(h.y)}" data-d="${n(h.d)}" data-label="${escXml(h.label)}">` +
      `<path d="M${n(h.x - e)} ${n(-h.y)}L${n(h.x + e)} ${n(-h.y)}M${n(h.x)} ${n(-h.y - e)}L${n(h.x)} ${n(-h.y + e)}"/></g>\n`,
    );
  }
  out.push('</g>\n</g>\n</svg>\n');
  return out.join('');
}
