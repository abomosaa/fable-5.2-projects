#!/usr/bin/env node
// Reproducible asset procedure: download every file pinned in sources.lock.json (exact URL + byte size + sha256)
// into .cache/assets-src/<id>/, verify it, then run the processing step that writes public/assets.
//
//   node tools/assets/fetch-assets.mjs                 # fetch + verify + process (incremental) + manifest + ASSETS.md
//   node tools/assets/fetch-assets.mjs --no-process    # only fetch + verify
//   node tools/assets/fetch-assets.mjs --only id,id    # restrict to some catalog ids (forwarded to the processor)
//   node tools/assets/fetch-assets.mjs --force         # re-process even if the per-asset build cache is fresh
//   node tools/assets/fetch-assets.mjs --pin           # resolve catalog entries that are not in the lock yet against
//                                                      # the Poly Haven API, download them and pin their sha256
//   node tools/assets/fetch-assets.mjs --quick         # trust files whose size matches and that carry a .ok stamp
//
// Downloads are untrusted data. They are only ever written below .cache/assets-src/<id>/ (paths from the lock are
// confined to that directory), read as data by the processor, and never executed or used as a working directory.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { TEXTURES, MODELS } from './catalog.mjs';
import { SRC, LOCK, TOOLS, USER_AGENT } from './lib/paths.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const only = opt('--only')?.split(',') ?? null;
const CONCURRENCY = 6;
const API = 'https://api.polyhaven.com';

const lock = fs.existsSync(LOCK)
  ? JSON.parse(fs.readFileSync(LOCK, 'utf8'))
  : { version: 1, note: '', userAgent: USER_AGENT, assets: {} };
lock.note = 'Pinned source files for tools/assets/fetch-assets.mjs. Generated with --pin from catalog.mjs; every file is verified by size + sha256.';

// ------------------------------------------------------------------ pinning (only with --pin)
async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}
const polyhavenMeta = (id, info) => ({
  provider: 'polyhaven', name: info.name, authors: Object.keys(info.authors ?? {}), license: 'CC0-1.0',
  url: `https://polyhaven.com/a/${id}`, dimensionsMm: info.dimensions,
});
const pinFile = (p, f, extra = {}) => ({ path: p, url: f.url, bytes: f.size, sha256: null, md5: f.md5, ...extra });
const TEX_MAPS = { diff: 'Diffuse', nor: 'nor_gl', arm: 'arm', disp: 'Displacement' };

async function resolveTexture(t) {
  if (t.provider === 'ambientcg') {
    const j = await getJson(`https://ambientcg.com/api/v2/full_json?id=${t.assetId}&include=downloadData,dimensionsData,displayData`);
    const a = j.foundAssets?.[0];
    const dl = a?.downloadFolders?.default?.downloadFiletypeCategories?.zip?.downloads?.find((d) => d.attribute === '2K-PNG');
    if (!dl) throw new Error(`${t.id}: ambientCG asset ${t.assetId} has no 2K-PNG download`);
    const base = `${t.assetId}_2K-PNG_`;
    return {
      kind: 'texture', provider: 'ambientcg', name: a.displayName ?? t.assetId, authors: ['Lennart Demes (ambientCG)'], license: 'CC0-1.0',
      url: `https://ambientcg.com/view?id=${t.assetId}`, dimensionsMm: [(a.dimensionX || 200) * 10, (a.dimensionY || 200) * 10],
      zipMembers: { diff: `${base}Color.png`, nor: `${base}NormalGL.png`, ao: `${base}AmbientOcclusion.png`, rough: `${base}Roughness.png`, disp: `${base}Displacement.png` },
      files: [{ role: 'zip', path: `${t.assetId}_2K-PNG.zip`, url: dl.downloadLink, bytes: dl.size, sha256: null }],
    };
  }
  const [info, files] = [await getJson(`${API}/info/${t.id}`), await getJson(`${API}/files/${t.id}`)];
  const a = { kind: 'texture', ...polyhavenMeta(t.id, info), files: [] };
  for (const [role, key] of Object.entries(TEX_MAPS)) {
    const f = files[key]?.['2k']?.png;
    if (!f) throw new Error(`${t.id}: no 2k png for map ${key} (have: ${Object.keys(files)})`);
    a.files.push(pinFile(`${role}.png`, f, { role }));
  }
  return a;
}

async function resolveModel(m) {
  const [info, files] = [await getJson(`${API}/info/${m.id}`), await getJson(`${API}/files/${m.id}`)];
  const res = m.res ?? '2k';
  const g = files.gltf?.[res]?.gltf;
  if (!g) throw new Error(`${m.id}: no ${res} glTF`);
  const a = { kind: 'model', ...polyhavenMeta(m.id, info), polycount: info.polycount, gltf: path.basename(new URL(g.url).pathname), files: [] };
  a.files.push(pinFile(a.gltf, g));
  for (const [p, f] of Object.entries(g.include ?? {})) a.files.push(pinFile(p, f));
  // Poly Haven glTFs ship JPEG base colour without alpha; pull the separate lossless alpha / mask / opacity maps.
  for (const key of Object.keys(files)) {
    if (!/(^|_)(alpha|mask|opacity)$/i.test(key)) continue;
    const f = files[key]?.[res]?.png ?? files[key]?.[res]?.jpg;
    if (f) a.files.push(pinFile(`extra/${path.basename(new URL(f.url).pathname)}`, f, { role: 'alpha-source', map: key }));
  }
  return a;
}

let lockDirty = false;
if (flag('--pin')) {
  const repin = opt('--repin')?.split(',') ?? [];
  for (const [list, resolve] of [[TEXTURES, resolveTexture], [MODELS, resolveModel]]) {
    for (const e of list) {
      if (lock.assets[e.id] && !repin.includes(e.id)) continue;
      process.stdout.write(`  pinning ${e.id} ... `);
      lock.assets[e.id] = await resolve(e);
      lockDirty = true;
      console.log(`${lock.assets[e.id].files.length} files`);
    }
  }
}

// ------------------------------------------------------------------ fetch + verify
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const sha = crypto.createHash('sha256'), md5 = crypto.createHash('md5');
    let bytes = 0;
    fs.createReadStream(file)
      .on('data', (d) => { sha.update(d); md5.update(d); bytes += d.length; })
      .on('error', reject)
      .on('end', () => resolve({ sha256: sha.digest('hex'), md5: md5.digest('hex'), bytes }));
  });
}
function safeJoin(base, rel) {
  const p = path.resolve(base, rel);
  if (!p.startsWith(base + path.sep)) throw new Error(`refusing path outside the asset directory: ${rel}`);
  return p;
}
async function download(url, dest) {
  if (!/^https:\/\//.test(url)) throw new Error(`refusing non-https url ${url}`);
  const tmp = dest + '.part';
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(tmp));
      fs.renameSync(tmp, dest);
      return;
    } catch (e) { lastErr = e; await new Promise((res) => setTimeout(res, 1500 * attempt)); }
  }
  fs.rmSync(tmp, { force: true });
  throw new Error(`download failed after retries: ${url}\n    ${lastErr?.message}`);
}

const catalogIds = new Set([...TEXTURES, ...MODELS].map((e) => e.id));
const notPinned = [...catalogIds].filter((id) => !lock.assets[id]);
if (notPinned.length) { console.error(`Not in sources.lock.json: ${notPinned.join(', ')}\nRun: node tools/assets/fetch-assets.mjs --pin`); process.exit(1); }

const jobs = [];
for (const [id, a] of Object.entries(lock.assets)) {
  if (!catalogIds.has(id) || (only && !only.includes(id))) continue;
  const dir = path.join(SRC, id);
  for (const f of a.files) jobs.push({ id, f, dest: safeJoin(dir, f.path) });
}

const problems = [];
let done = 0, downloaded = 0, dlBytes = 0;
const t0 = Date.now();
async function verify({ f, dest }) {
  const stamp = dest + '.ok';
  if (flag('--quick') && f.sha256 && fs.existsSync(stamp) && fs.statSync(dest).size === f.bytes && fs.readFileSync(stamp, 'utf8') === f.sha256) return true;
  const h = await hashFile(dest);
  if (h.bytes !== f.bytes) return `size mismatch (expected ${f.bytes} bytes, got ${h.bytes})`;
  if (f.sha256) { if (h.sha256 !== f.sha256) return `sha256 mismatch (expected ${f.sha256}, got ${h.sha256})`; }
  else if (flag('--pin')) {
    if (f.md5 && h.md5 !== f.md5) return `md5 mismatch against the Poly Haven API (expected ${f.md5}, got ${h.md5})`;
    f.sha256 = h.sha256; lockDirty = true;
  } else return 'no sha256 pinned for this file; run with --pin';
  fs.writeFileSync(stamp, f.sha256);
  return true;
}
async function run(job) {
  const { id, f, dest } = job;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let res = fs.existsSync(dest) ? await verify(job) : 'missing';
  if (res !== true) {
    if (fs.existsSync(dest)) console.warn(`  re-downloading ${id}/${f.path}: ${res}`);
    try { await download(f.url, dest); downloaded++; dlBytes += f.bytes; res = await verify(job); } catch (e) { res = e.message; }
  }
  if (res !== true) problems.push(`${id}/${f.path}\n    url: ${f.url}\n    problem: ${res}`);
  if (++done % 50 === 0 || done === jobs.length) console.log(`  [${done}/${jobs.length}] verified, ${downloaded} downloaded (${(dlBytes / 1e6).toFixed(0)} MB) ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
jobs.sort((a, b) => b.f.bytes - a.f.bytes); // big files first so the tail is short
let cursor = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (cursor < jobs.length) await run(jobs[cursor++]); }));

if (lockDirty || (flag('--pin') && Object.keys(lock.assets).some((id) => !catalogIds.has(id)))) {
  // only catalog entries are kept, in catalog order; md5 (only used to cross-check the first download) is dropped once sha256 is pinned
  const ordered = {};
  for (const e of [...TEXTURES, ...MODELS]) if (lock.assets[e.id]) ordered[e.id] = lock.assets[e.id];
  for (const a of Object.values(ordered)) for (const f of a.files) if (f.sha256) delete f.md5;
  lock.assets = ordered;
  fs.writeFileSync(LOCK, JSON.stringify(lock, null, 1) + '\n');
  console.log('updated sources.lock.json');
}
if (problems.length) {
  console.error(`\n${problems.length} file(s) could not be fetched/verified:\n- ${problems.join('\n- ')}\n\n` +
    'If an upstream file legitimately changed, re-pin it: node tools/assets/fetch-assets.mjs --pin --repin <id>\n' +
    'Otherwise delete the offending file under .cache/assets-src/ and re-run.');
  process.exit(1);
}
const totalBytes = jobs.reduce((s, j) => s + j.f.bytes, 0);
console.log(`OK: ${jobs.length} source files (${(totalBytes / 1e9).toFixed(2)} GB) present and verified in ${path.relative(process.cwd(), SRC) || SRC}`);

// ------------------------------------------------------------------ process
if (!flag('--no-process')) {
  const fwd = [];
  if (only) fwd.push('--only', only.join(','));
  for (const f of ['--force', '--verbose']) if (flag(f)) fwd.push(f);
  if (opt('--jobs')) fwd.push('--jobs', opt('--jobs'));
  const r = spawnSync(process.execPath, [path.join(TOOLS, 'process.mjs'), ...fwd], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
