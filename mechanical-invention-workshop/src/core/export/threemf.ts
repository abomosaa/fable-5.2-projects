/**
 * 3MF (3D Manufacturing Format, core spec 1.x) writer.
 * Package = OPC zip with [Content_Types].xml, _rels/.rels and 3D/3dmodel.model.
 */
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import type { SolidMesh } from '../geom/kernel';
import { escXml } from './common';

export interface ThreeMFItem { name: string; partNumber: string; mesh: SolidMesh }

const CORE_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';

/** Shortest decimal string that parses back to exactly the same float32 (≥ 6 significant digits tried first). */
export function f32str(v: number): string {
  if (v === 0 || !Number.isFinite(v)) return '0';
  for (let p = 6; p <= 9; p++) {
    const s = v.toPrecision(p);
    if (Math.fround(parseFloat(s)) === v) return String(Number(s));
  }
  return String(v);
}

/** Simple shelf layout so the items of one package do not overlap on the build plate. */
function layout(items: ThreeMFItem[], rowWidth = 200, gap = 5): [number, number, number][] {
  const out: [number, number, number][] = [];
  let cx = 0, cy = 0, rowH = 0;
  for (const it of items) {
    const { min, max } = it.mesh.bbox;
    const w = max[0] - min[0], h = max[1] - min[1];
    if (cx > 0 && cx + w > rowWidth) { cx = 0; cy += rowH + gap; rowH = 0; }
    out.push([cx - min[0], cy - min[1], -min[2]]);
    cx += w + gap;
    rowH = Math.max(rowH, h);
  }
  return out;
}

export function meshesTo3MF(items: ThreeMFItem[], title: string): Uint8Array {
  const xml: string[] = [];
  xml.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  xml.push(`<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}">\n`);
  xml.push(` <metadata name="Title">${escXml(title)}</metadata>\n`);
  xml.push(' <metadata name="Application">Mechanism Workshop</metadata>\n');
  xml.push(' <metadata name="Description">Part-local coordinates in millimetres, each part resting on z = 0. Validate material, process and loads before manufacture.</metadata>\n');
  xml.push(' <resources>\n');
  items.forEach((it, i) => {
    const P = it.mesh.positions, I = it.mesh.indices;
    xml.push(`  <object id="${i + 1}" type="model" name="${escXml(it.name)}" partnumber="${escXml(it.partNumber)}">\n   <mesh>\n    <vertices>\n`);
    const chunk: string[] = [];
    for (let v = 0; v < P.length; v += 3) chunk.push(`     <vertex x="${f32str(P[v])}" y="${f32str(P[v + 1])}" z="${f32str(P[v + 2])}"/>\n`);
    xml.push(chunk.join(''));
    xml.push('    </vertices>\n    <triangles>\n');
    const tri: string[] = [];
    for (let t = 0; t < I.length; t += 3) tri.push(`     <triangle v1="${I[t]}" v2="${I[t + 1]}" v3="${I[t + 2]}"/>\n`);
    xml.push(tri.join(''));
    xml.push('    </triangles>\n   </mesh>\n  </object>\n');
  });
  xml.push(' </resources>\n <build>\n');
  const place = layout(items);
  items.forEach((it, i) => {
    const [tx, ty, tz] = place[i];
    xml.push(`  <item objectid="${i + 1}" partnumber="${escXml(it.partNumber)}" transform="1 0 0 0 1 0 0 0 1 ${f32str(Math.fround(tx))} ${f32str(Math.fround(ty))} ${f32str(Math.fround(tz))}"/>\n`);
  });
  xml.push(' </build>\n</model>\n');

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
    ' <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
    ' <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
    '</Types>\n';
  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
    ' <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n' +
    '</Relationships>\n';

  // fixed timestamp → byte-identical output for identical input
  const mtime = new Date(2020, 0, 1, 0, 0, 0);
  return zipSync({
    '[Content_Types].xml': [strToU8(contentTypes), { mtime }],
    '_rels/.rels': [strToU8(rels), { mtime }],
    '3D/3dmodel.model': [strToU8(xml.join('')), { mtime }],
  }, { level: 6 });
}

export interface Parsed3MFObject { id: string; name: string; partNumber: string; positions: Float32Array; indices: Uint32Array }
export interface Parsed3MF { unit: string; files: string[]; objects: Parsed3MFObject[]; buildItems: { objectId: string; partNumber: string; transform: string }[] }

const attr = (tag: string, name: string): string => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&') : '';
};

/** Minimal reader for packages written by meshesTo3MF (round-trip tests and previews). */
export function parse3MF(bytes: Uint8Array): Parsed3MF {
  const zip = unzipSync(bytes);
  const files = Object.keys(zip);
  const key = files.find((f) => f.toLowerCase() === '3d/3dmodel.model');
  if (!key) throw new Error('3MF package has no 3D/3dmodel.model part.');
  const xml = strFromU8(zip[key]);
  const model = /<model\b[^>]*>/.exec(xml);
  const unit = model ? attr(model[0], 'unit') : '';
  const objects: Parsed3MFObject[] = [];
  const objRe = /<object\b[^>]*>[\s\S]*?<\/object>/g;
  for (let m = objRe.exec(xml); m; m = objRe.exec(xml)) {
    const head = /<object\b[^>]*>/.exec(m[0])![0];
    const pos: number[] = [], idx: number[] = [];
    const vRe = /<vertex\b[^>]*\/>/g;
    for (let v = vRe.exec(m[0]); v; v = vRe.exec(m[0])) pos.push(Number(attr(v[0], 'x')), Number(attr(v[0], 'y')), Number(attr(v[0], 'z')));
    const tRe = /<triangle\b[^>]*\/>/g;
    for (let t = tRe.exec(m[0]); t; t = tRe.exec(m[0])) idx.push(Number(attr(t[0], 'v1')), Number(attr(t[0], 'v2')), Number(attr(t[0], 'v3')));
    objects.push({ id: attr(head, 'id'), name: attr(head, 'name'), partNumber: attr(head, 'partnumber'), positions: new Float32Array(pos), indices: new Uint32Array(idx) });
  }
  const buildItems: Parsed3MF['buildItems'] = [];
  const iRe = /<item\b[^>]*\/>/g;
  for (let i = iRe.exec(xml); i; i = iRe.exec(xml)) buildItems.push({ objectId: attr(i[0], 'objectid'), partNumber: attr(i[0], 'partnumber'), transform: attr(i[0], 'transform') });
  return { unit, files, objects, buildItems };
}
