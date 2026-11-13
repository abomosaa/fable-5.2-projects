#!/usr/bin/env node
// Convert the verified raw downloads (.cache/assets-src) into the bundled, real-time-ready library in public/assets:
//   public/assets/textures/<id>/{diff,nor,arm,disp}.jpg    tileable PBR sets (2048^2, disp 1024^2)
//   public/assets/models/<id>/lod{0,1[,2]}.glb             plain GLB (float32 attributes, embedded JPEG / WebP)
//   public/assets/manifest.json, ASSETS.md
//
//   node tools/assets/process.mjs [--only id,id] [--kind textures|models] [--force] [--jobs N] [--verbose]
//
// Normally run through fetch-assets.mjs (which verifies the sources first). Results are cached per asset (keyed on
// catalog entry + pinned sources + pipeline code), so re-runs are incremental.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { TEXTURES, MODELS } from './catalog.mjs';
import { ROOT, SRC, OUT, BUILD, LOCK, TOOLS } from './lib/paths.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const only = opt('--only')?.split(',') ?? null;
const kindFilter = opt('--kind');
const profileFilter = opt('--profiles')?.split(',') ?? null;
const verbose = flag('--verbose');
const JOBS = +(opt('--jobs') ?? Math.max(2, Math.min(10, Math.floor(os.cpus().length / 2))));
const MEM_BUDGET = 1.6e9; // sum of raw geometry bytes processed concurrently

if (!fs.existsSync(LOCK)) { console.error('Missing tools/assets/sources.lock.json'); process.exit(1); }
const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));

// ---- make sure the raw inputs are there
const missing = [];
for (const e of [...TEXTURES, ...MODELS]) {
  const a = lock.assets[e.id];
  if (!a) { missing.push(`${e.id}: not in sources.lock.json (run: node tools/assets/fetch-assets.mjs --pin)`); continue; }
  for (const f of a.files) {
    const p = path.join(SRC, e.id, f.path);
    if (!fs.existsSync(p) || fs.statSync(p).size !== f.bytes) missing.push(`${e.id}/${f.path}`);
  }
}
if (missing.length) {
  console.error(`${missing.length} raw source file(s) missing or truncated, e.g.:\n  ${missing.slice(0, 8).join('\n  ')}\nRun: node tools/assets/fetch-assets.mjs`);
  process.exit(1);
}

// ---- job list + cache keys
const codeHash = (() => {
  const h = crypto.createHash('sha256');
  for (const f of ['worker.mjs', ...fs.readdirSync(path.join(TOOLS, 'lib')).filter((f) => !/^(render|sheet|paths)\.mjs$/.test(f)).sort().map((f) => `lib/${f}`)]) h.update(f).update(fs.readFileSync(path.join(TOOLS, f)));
  for (const d of ['sharp', 'meshoptimizer']) h.update(fs.readFileSync(path.join(ROOT, 'node_modules', d, 'package.json')));
  return h.digest('hex');
})();
fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const keyOf = (e) => e.out ?? e.id; // `out` lets two catalog entries build different models from one source asset
const jobs = [];
for (const [kind, list] of [['texture', TEXTURES], ['model', MODELS]]) {
  for (const entry of list) {
    const src = lock.assets[entry.id];
    const key = crypto.createHash('sha256').update(JSON.stringify([entry, src.files.map((f) => [f.path, f.sha256, f.bytes]), src.zipMembers ?? null, codeHash])).digest('hex');
    const weight = kind === 'model' ? src.files.filter((f) => f.path.endsWith('.bin')).reduce((s, f) => s + f.bytes, 0) : 3e7;
    jobs.push({ kind, entry, src, key, weight, cacheFile: path.join(BUILD, `${keyOf(entry)}.json`) });
  }
}

const results = new Map(); // id -> results[]
const todo = [];
for (const j of jobs) {
  const selected = (!only || only.includes(j.entry.id) || only.includes(keyOf(j.entry))) && (!kindFilter || kindFilter.startsWith(j.kind)) && (!profileFilter || profileFilter.includes(j.entry.profile ?? 'texture'));
  let cached = null;
  if (fs.existsSync(j.cacheFile)) { try { cached = JSON.parse(fs.readFileSync(j.cacheFile, 'utf8')); } catch { cached = null; } }
  const valid = cached && cached.results.every((r) => Object.keys(r.sha256).every((f) => fs.existsSync(path.join(OUT, f))));
  if (valid && (cached.key === j.key && !(flag('--force') && selected) || !selected)) { results.set(keyOf(j.entry), cached.results); if (cached.key !== j.key) console.warn(`  note: ${j.entry.id} is stale (not selected for rebuild)`); continue; }
  if (!selected) continue; // not built yet and not selected
  todo.push(j);
}
todo.sort((a, b) => b.weight - a.weight);
console.log(`${jobs.length} assets in catalog, ${results.size} up to date, ${todo.length} to build (${JOBS} workers)`);

// ---- worker pool (memory-weighted)
const t0 = Date.now();
let failed = 0, running = 0, load = 0, finished = 0;
await new Promise((resolve) => {
  if (!todo.length) return resolve();
  const idle = [];
  const pump = () => {
    while (idle.length && todo.length) {
      const i = todo.findIndex((j) => running === 0 || load + j.weight <= MEM_BUDGET);
      if (i < 0) break;
      const job = todo.splice(i, 1)[0];
      const w = idle.pop();
      w.job = job; running++; load += job.weight;
      w.send({ kind: job.kind, entry: job.entry, src: job.src, verbose });
    }
    if (!todo.length && running === 0) { for (const w of workers) w.kill(); resolve(); }
  };
  const workers = Array.from({ length: Math.min(JOBS, todo.length) }, () => {
    const w = fork(path.join(TOOLS, 'worker.mjs'), [], { execArgv: ['--max-old-space-size=12000'], stdio: ['ignore', 'inherit', 'pipe', 'ipc'] });
    let err = '';
    w.stderr.on('data', (d) => { err += d; });
    w.on('message', (m) => {
      if (m.type === 'ready') { idle.push(w); pump(); return; }
      if (m.type === 'log') { console.log(`    ${m.message}`); return; }
      const job = w.job; w.job = null; running--; load -= job.weight; finished++;
      if (m.type === 'done') {
        results.set(keyOf(job.entry), m.results);
        fs.writeFileSync(job.cacheFile, JSON.stringify({ key: job.key, results: m.results, logs: m.logs }));
        const tri = m.results.map((r) => (r.lods ? `${r.id} ${r.lods.map((l) => l.triangles).join('/')}` : r.id)).join(', ');
        console.log(`  [${finished}] ${keyOf(job.entry)} ok (${((Date.now() - t0) / 1000).toFixed(0)}s)  ${tri.slice(0, 150)}`);
        if (!verbose) for (const l of m.logs ?? []) if (/WARN|simplification used|no UVs|OPAQUE/.test(l)) console.log(`      ${l}`);
      } else { failed++; console.error(`  [${finished}] ${job.entry.id} FAILED\n${m.error}`); }
      idle.push(w); pump();
    });
    w.on('exit', (code) => {
      if (w.job) { failed++; running--; load -= w.job.weight; console.error(`  worker crashed while processing ${w.job.entry.id} (exit ${code})\n${err.split('\n').filter((l) => !/Fontconfig/.test(l)).slice(-12).join('\n')}`); w.job = null; pump(); }
    });
    return w;
  });
});

// ---- manifest (only complete assets are listed)
const sourceOf = (src) => ({ url: src.url, authors: src.authors, license: src.license });
const manifest = { version: 1, units: 'meters', upAxis: 'Y', alphaCutoff: 0.4, textures: {}, models: {} };
const rows = [];
let total = 0;
for (const entry of TEXTURES) {
  const src = lock.assets[entry.id];
  for (const r of results.get(entry.id) ?? []) {
    manifest.textures[r.id] = {
      name: src.name, role: entry.role, tileSizeM: +(Math.max(...src.dimensionsMm.slice(0, 2)) / 1000).toFixed(3),
      files: r.files, avgColor: r.avgColor, source: sourceOf(src), bytes: r.bytes,
    };
    total += r.bytes;
    rows.push([`\`${r.id}\``, `texture / ${entry.role}`, `\`public/assets/textures/${r.id}/{diff,nor,arm,disp}.jpg\``, src.url, src.authors.join(', '), 'CC0 1.0',
      `2K PNG maps (${src.provider === 'ambientcg' ? 'separate AO + roughness packed into ARM' : 'diffuse, nor_gl, arm, displacement'}) resampled to 2048² JPEG; displacement range-normalised to 8-bit 1024²`]);
  }
}
for (const entry of MODELS) {
  const src = lock.assets[entry.id];
  for (const r of results.get(keyOf(entry)) ?? []) {
    manifest.models[r.id] = {
      name: src.name + (r.variant ? ` (${r.variant.toUpperCase()})` : ''), category: entry.category,
      lods: r.lods.map((l) => ({ file: l.file, triangles: l.triangles })),
      bounds: r.bounds, height: r.height, radius: r.radius, ...(r.trunkRadius != null ? { trunkRadius: r.trunkRadius } : {}),
      materials: r.materials, source: sourceOf(src),
      ...(entry.tags ? { tags: entry.tags } : {}), ...(r.variant ? { variantOf: keyOf(entry).toLowerCase() } : {}), bytes: r.bytes,
    };
    total += r.bytes;
    const modes = [...new Set(r.lods.map((l) => l.mode))];
    const how = modes.includes('cards') || modes.includes('geometry')
      ? `foliage: ${r.lods.map((l, i) => `lod${i} ${l.mode === 'cards' ? 'baked cluster cards' : l.mode === 'geometry' ? 'component culling + rescale' : l.mode}`).join(', ')}; trunk/branches meshopt-simplified`
      : 'meshopt edge-collapse simplification';
    rows.push([`\`${r.id}\``, `model / ${entry.category}`, `\`public/assets/models/${r.id}/lod{0..${r.lods.length - 1}}.glb\``, src.url, src.authors.join(', '), 'CC0 1.0',
      `${r.variant ? `variant "${r.sourceNode}" split from the set; ` : ''}${r.sourceTriangles.toLocaleString('en-US')} → ${r.lods.map((l) => l.triangles.toLocaleString('en-US')).join(' / ')} tris; ${how}; primitives merged per material, origin moved to base centre, textures re-encoded (JPEG / WebP) and embedded`]);
  }
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');

// ---- ASSETS.md (human-readable license manifest)
let md = `# Bundled assets

Everything under \`public/assets/\` is a processed derivative (decimated meshes, re-encoded textures) of assets
published by [Poly Haven](https://polyhaven.com)${rows.some((r) => r[3].includes('ambientcg')) ? ' and - one meadow grass texture - [ambientCG](https://ambientcg.com)' : ''}, all released under the
[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) public-domain dedication.
Attribution is **not required**; the authors are credited here anyway, with thanks.

- Machine-readable index: \`public/assets/manifest.json\`
- Exact source files (URL, byte size, sha256): \`tools/assets/sources.lock.json\`
- Regenerate: \`npm run assets\` (= \`node tools/assets/fetch-assets.mjs\`, see \`tools/assets/README.md\`)

${Object.keys(manifest.textures).length} texture sets, ${Object.keys(manifest.models).length} models, ${(total / 1e6).toFixed(0)} MB.

| Asset | Kind | Local path | Source | Author(s) | License | Processing |
|---|---|---|---|---|---|---|
`;
for (const r of rows) md += `| ${r.join(' | ')} |\n`;
fs.writeFileSync(path.join(ROOT, 'ASSETS.md'), md);

// ---- remove outputs that are no longer part of the catalog
if (!only && !kindFilter && !profileFilter && !failed) {
  const keep = { models: new Set(Object.keys(manifest.models)), textures: new Set(Object.keys(manifest.textures)) };
  for (const sub of ['models', 'textures']) {
    const d = path.join(OUT, sub);
    if (!fs.existsSync(d)) continue;
    for (const n of fs.readdirSync(d)) if (!keep[sub].has(n)) { fs.rmSync(path.join(d, n), { recursive: true, force: true }); console.log(`  removed stale public/assets/${sub}/${n}`); }
  }
}

console.log(`manifest: ${Object.keys(manifest.textures).length} texture sets, ${Object.keys(manifest.models).length} models, ${(total / 1e6).toFixed(1)} MB`);
if (failed) { console.error(`${failed} asset(s) failed - the manifest lists only the completed ones.`); process.exit(1); }
