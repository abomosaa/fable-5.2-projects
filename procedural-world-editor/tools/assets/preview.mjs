#!/usr/bin/env node
// Visual verification: render every processed model LOD and every texture set with stock three.js (GLTFLoader,
// MeshStandardMaterial) in headless Chromium and write PNG contact sheets to .cache/asset-previews/.
// While rendering, every GLB is also checked structurally as loaded by GLTFLoader (triangle counts and bounds
// against the manifest, identity node transforms, base at y = 0, bound texture maps, alpha settings, attributes).
//
//   node tools/assets/preview.mjs [--only id,id] [--kind models|textures] [--force]
//
// Outputs: .cache/asset-previews/textures-N.png, models-<category>-N.png (rows: LODs with one camera; plants also
//          get a "far" strip rendered from further away), strips/<id>.png (full resolution), report.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { OUT, PREVIEWS } from './lib/paths.mjs';
import { startRenderer } from './lib/render.mjs';
import { contactSheet } from './lib/sheet.mjs';

const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const only = opt('--only')?.split(',') ?? null;
const kind = opt('--kind');
const force = args.includes('--force');

const VIEW = {
  tree_conifer: { az: 0.65, el: 0.1, far: 2.5 }, tree_broadleaf: { az: 0.65, el: 0.12, far: 2.5 }, shrub: { az: 0.65, el: 0.3, far: 3 }, groundcover: { az: 0.65, el: 0.45, far: 3 },
  grass: { az: 0.65, el: 0.35, far: 3 }, rock: { az: 0.65, el: 0.4 }, deadwood: { az: 0.65, el: 0.4 }, prop: { az: 0.65, el: 0.3 }, structure: { az: 0.65, el: 0.3 },
};
const PER_SHEET = { tree_conifer: 8, tree_broadleaf: 8 };
const CELL = 440;

const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
const stripDir = path.join(PREVIEWS, 'strips');
fs.mkdirSync(stripDir, { recursive: true });
const reportFile = path.join(PREVIEWS, 'report.json');
const prev = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : { checks: {} };
const checks = {};
const stampOf = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16) + ':p3';
const selected = (id, base) => !only || only.includes(id) || only.includes(base);

const R = await startRenderer();
console.log(`WebGL renderer: ${R.gl}`);
const t0 = Date.now();
let rendered = 0;
try {
  if (kind !== 'models') for (const [id, t] of Object.entries(manifest.textures)) {
    const strip = path.join(stripDir, `tex_${id}.png`), stampFile = strip + '.stamp';
    const stamp = stampOf([t, Object.values(t.files).map((f) => fs.statSync(path.join(OUT, f)).mtimeMs)]);
    if (!force && !(only && selected(id)) && fs.existsSync(strip) && fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === stamp && prev.checks[id]) { checks[id] = prev.checks[id]; continue; }
    if (!selected(id)) continue;
    const problems = [];
    const r = await R.renderTexture({ dir: `/public/assets/${path.dirname(t.files.diff)}`, cell: CELL });
    fs.writeFileSync(strip, R.decode(r.image));
    for (const [role, want] of [['diff', 2048], ['nor', 2048], ['arm', 2048], ['disp', 1024]]) {
      const m = await sharp(path.join(OUT, t.files[role])).metadata();
      if (m.width !== want || m.height !== want || m.format !== 'jpeg') problems.push(`${role}: ${m.format} ${m.width}x${m.height}`);
      if (role === 'disp' && m.channels !== 1) problems.push(`disp has ${m.channels} channels`);
    }
    checks[id] = { problems }; fs.writeFileSync(stampFile, stamp); rendered++;
  }
  if (kind !== 'textures') for (const [id, m] of Object.entries(manifest.models)) {
    const strip = path.join(stripDir, `${id}.png`), stampFile = strip + '.stamp';
    const stamp = stampOf([m, m.lods.map((l) => fs.statSync(path.join(OUT, l.file)).mtimeMs)]);
    if (!force && !(only && selected(id, m.variantOf)) && fs.existsSync(strip) && fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === stamp && prev.checks[id]) { checks[id] = prev.checks[id]; continue; }
    if (!selected(id, m.variantOf)) continue;
    const problems = [];
    const v = VIEW[m.category] ?? VIEW.prop;
    const r = await R.renderModel({ urls: m.lods.map((l) => `/public/assets/${l.file}`), cell: CELL, ...v });
    let img = sharp(R.decode(r.strip));
    if (r.far) {
      // far strip: rendered at 1/far size (unmagnified, i.e. true pixels) and placed under the near strip
      const farBuf = await sharp(R.decode(r.far)).png().toBuffer();
      const fm = await sharp(farBuf).metadata();
      img = sharp({ create: { width: CELL * m.lods.length, height: CELL + fm.height, channels: 3, background: '#aab7c4' } })
        .composite([{ input: R.decode(r.strip), left: 0, top: 0 }, { input: farBuf, left: 0, top: CELL }]);
    }
    await img.png({ compressionLevel: 6 }).toFile(strip);
    r.infos.forEach((inf, l) => {
      const L = `lod${l}`;
      if (Math.round(inf.tris) !== m.lods[l].triangles) problems.push(`${L}: ${inf.tris} tris loaded vs manifest ${m.lods[l].triangles}`);
      if (!inf.identity) problems.push(`${L}: non-identity node transform`);
      if (l === 0 ? Math.abs(inf.min[1]) > 1e-3 : (inf.min[1] < -1e-3 || inf.min[1] > 0.3 * m.height + 0.05)) problems.push(`${L}: min y = ${inf.min[1].toFixed(4)}`);
      for (const mt of inf.mats) {
        if (!mt.map) problems.push(`${L}/${mt.name}: no baseColor map`);
        if (!mt.normalMap) problems.push(`${L}/${mt.name}: no normal map`);
        if (!mt.hasNormals || !mt.hasUv) problems.push(`${L}/${mt.name}: missing normals/uvs`);
        if (mt.hasColor) problems.push(`${L}/${mt.name}: has vertex colours`);
        if (mt.name.startsWith('foliage_') && (Math.abs(mt.alphaTest - 0.4) > 1e-6 || mt.side !== 2 || mt.transparent)) problems.push(`${L}/${mt.name}: foliage material must be MASK 0.4 + doubleSided`);
      }
      if (l === 0) {
        for (let k = 0; k < 3; k++) if (Math.abs(inf.min[k] - m.bounds.min[k]) > 2e-3 || Math.abs(inf.max[k] - m.bounds.max[k]) > 2e-3) { problems.push('lod0 bounds differ from manifest'); break; }
        if (inf.mats.length !== m.materials.length) problems.push(`lod0 has ${inf.mats.length} primitives, manifest lists ${m.materials.length} materials`);
      }
    });
    for (let l = 1; l < m.lods.length; l++) if (m.lods[l].triangles > m.lods[l - 1].triangles) problems.push('LOD triangle counts not monotonic');
    checks[id] = { problems, draws: r.infos.map((i) => i.meshes), textures: r.infos.map((i) => i.mats.map((x) => (x.mapSize ?? [0])[0])) };
    fs.writeFileSync(stampFile, stamp); rendered++;
    if (rendered % 20 === 0) console.log(`  rendered ${rendered} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
} finally { await R.close(); }

// ---- contact sheets
for (const f of fs.readdirSync(PREVIEWS)) if (/^(models|textures)-.*\.png$/.test(f)) fs.rmSync(path.join(PREVIEWS, f));
const sheets = [];
const flagOf = (id) => (checks[id]?.problems.length ? '  !!' : '');
{
  const cells = Object.entries(manifest.textures).filter(([id]) => fs.existsSync(path.join(stripDir, `tex_${id}.png`)))
    .map(([id, t]) => ({ label: `${id}  [${t.role}]`, sub: `${t.tileSizeM} m  ${(t.bytes / 1e6).toFixed(1)} MB${flagOf(id)}`, image: path.join(stripDir, `tex_${id}.png`) }));
  for (let i = 0; i < cells.length; i += 12) { const out = path.join(PREVIEWS, `textures-${i / 12 + 1}.png`); await contactSheet(cells.slice(i, i + 12), { cellW: 660, cellH: 330, cols: 3, out }); sheets.push(out); }
}
for (const cat of Object.keys(VIEW)) {
  const list = Object.entries(manifest.models).filter(([id, m]) => m.category === cat && fs.existsSync(path.join(stripDir, `${id}.png`)));
  if (!list.length) continue;
  const tree = cat.startsWith('tree');
  const per = PER_SHEET[cat] ?? 18;
  const cells = list.map(([id, m]) => ({ label: id, sub: `${m.lods.map((l) => l.triangles).join(' / ')} tris  h=${m.height} m  r=${m.radius} m  ${(m.bytes / 1e6).toFixed(1)} MB${flagOf(id)}`, image: path.join(stripDir, `${id}.png`) }));
  for (let i = 0; i < cells.length; i += per) {
    const out = path.join(PREVIEWS, `models-${cat}-${i / per + 1}.png`);
    await contactSheet(cells.slice(i, i + per), tree ? { cellW: 960, cellH: 480, cols: 2, out, bg: '#aab7c4' } : { cellW: 640, cellH: VIEW[cat].far ? 520 : cat === 'rock' || cat === 'deadwood' ? 214 : 320, cols: 3, out, bg: '#aab7c4' });
    sheets.push(out);
  }
}

const withProblems = Object.entries(checks).filter(([, c]) => c.problems.length);
fs.writeFileSync(reportFile, JSON.stringify({ webgl: R.gl, rendererErrors: [...new Set(R.errors)].slice(0, 50), checks }, null, 1) + '\n');
console.log(`preview: rendered ${rendered} assets, ${withProblems.length} with problems${R.errors.length ? `, ${R.errors.length} browser console messages` : ''}`);
for (const [id, c] of withProblems) console.log(`  ${id}: ${c.problems.slice(0, 4).join('; ')}`);
for (const e of [...new Set(R.errors)].slice(0, 8)) console.log(`  browser: ${e.slice(0, 300)}`);
console.log(`sheets:\n  ${sheets.map((s) => path.relative(process.cwd(), s)).join('\n  ')}`);
if (withProblems.length) process.exitCode = 1;
