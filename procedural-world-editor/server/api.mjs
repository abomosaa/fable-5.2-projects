// Project storage API (no external dependencies). Projects are plain folders under ./projects:
//   projects/<id>/project.json + binary layers (+ .autosave/ with the same layout)
// Pristine showcase projects live in ./showcases and are copied into ./projects on first use.

import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, stat, rm, cp, rename } from 'node:fs/promises';
import { join, resolve, normalize, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECTS_DIR = process.env.TERRAFORGE_PROJECTS || join(ROOT, 'projects');
export const SHOWCASES_DIR = process.env.TERRAFORGE_SHOWCASES || join(ROOT, 'showcases');
export const EXPORTS_DIR = process.env.TERRAFORGE_EXPORTS || join(ROOT, 'exports');
export const ASSETS_DIR = join(ROOT, 'public', 'assets');

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/;
const FILE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,120}$/;

function safeJoin(base, ...parts) {
  const p = normalize(join(base, ...parts));
  if (p !== base && !p.startsWith(base + sep)) throw Object.assign(new Error('invalid path'), { status: 400 });
  return p;
}

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body) || body instanceof Uint8Array;
  const data = isBuf ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': isBuf ? 'application/octet-stream' : 'application/json', 'Content-Length': data.length, 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

function readBody(req, limit = 512 * 1024 * 1024) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function ensureShowcases() {
  await mkdir(PROJECTS_DIR, { recursive: true });
  if (!existsSync(SHOWCASES_DIR)) return [];
  const installed = [];
  for (const d of await readdir(SHOWCASES_DIR)) {
    const src = join(SHOWCASES_DIR, d);
    if (!(await stat(src)).isDirectory() || !existsSync(join(src, 'project.json'))) continue;
    const dst = join(PROJECTS_DIR, d);
    if (!existsSync(join(dst, 'project.json'))) {
      await cp(src, dst, { recursive: true });
      installed.push(d);
    }
  }
  return installed;
}

async function listProjects() {
  await ensureShowcases();
  const out = [];
  for (const d of await readdir(PROJECTS_DIR)) {
    const pj = join(PROJECTS_DIR, d, 'project.json');
    if (!existsSync(pj)) continue;
    try {
      const doc = JSON.parse(await readFile(pj, 'utf8'));
      const st = await stat(pj);
      let autosave = null;
      const ap = join(PROJECTS_DIR, d, '.autosave', 'project.json');
      if (existsSync(ap)) {
        const ast = await stat(ap);
        if (ast.mtimeMs > st.mtimeMs + 500) autosave = new Date(ast.mtimeMs).toISOString();
      }
      out.push({ id: d, name: doc.name, modified: new Date(st.mtimeMs).toISOString(), showcase: doc.showcase || null, preset: doc.terrain?.preset, seed: doc.seed, size: doc.terrain?.size, autosave, hasThumb: existsSync(join(PROJECTS_DIR, d, 'thumb.jpg')) });
    } catch (e) {
      out.push({ id: d, name: d, error: 'unreadable project.json: ' + e.message });
    }
  }
  out.sort((a, b) => (a.showcase ? 0 : 1) - (b.showcase ? 0 : 1) || (a.showcase || '').localeCompare(b.showcase || '') || (b.modified || '').localeCompare(a.modified || ''));
  return out;
}

// ---- minimal tar writer (ustar) for portable project packages ----
function tarHeader(name, size, mtime) {
  const b = Buffer.alloc(512);
  let prefix = '';
  if (name.length > 100) {
    const i = name.lastIndexOf('/', 155);
    prefix = name.slice(0, i);
    name = name.slice(i + 1);
  }
  b.write(name, 0, 100);
  b.write('0000644\0', 100);
  b.write('0000000\0', 108);
  b.write('0000000\0', 116);
  b.write(size.toString(8).padStart(11, '0') + '\0', 124);
  b.write(Math.floor(mtime / 1000).toString(8).padStart(11, '0') + '\0', 136);
  b.write('        ', 148);
  b.write('0', 156);
  b.write('ustar\0' + '00', 257);
  b.write(prefix, 345, 155);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += b[i];
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return b;
}

async function collectFiles(dir, rel = '') {
  const out = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (d.name === '.autosave') continue;
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...(await collectFiles(p, rel + d.name + '/')));
    else out.push({ path: p, name: rel + d.name });
  }
  return out;
}

async function buildPackage(id) {
  const dir = safeJoin(PROJECTS_DIR, id);
  const doc = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'));
  const files = (await collectFiles(dir)).map((f) => ({ ...f, name: `${id}/project/${f.name}` }));
  // referenced assets
  let lock = null;
  if (existsSync(join(dir, 'assets.lock.json'))) lock = JSON.parse(await readFile(join(dir, 'assets.lock.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(ASSETS_DIR, 'manifest.json'), 'utf8'));
  const sub = { version: manifest.version, textures: {}, models: {} };
  const want = lock || { models: [], textures: [] };
  const missing = [];
  for (const t of want.textures || []) {
    const e = manifest.textures[t.id || t];
    if (!e) {
      missing.push(t.id || t);
      continue;
    }
    sub.textures[t.id || t] = e;
    for (const f of Object.values(e.files)) files.push({ path: join(ASSETS_DIR, f), name: `${id}/assets/${f}` });
  }
  for (const m of want.models || []) {
    const e = manifest.models[m.id || m];
    if (!e) {
      if (!String(m.id || m).startsWith('proc_')) missing.push(m.id || m);
      continue;
    }
    sub.models[m.id || m] = e;
    for (const l of e.lods) if (l.file) files.push({ path: join(ASSETS_DIR, l.file), name: `${id}/assets/${l.file}` });
  }
  const chunks = [];
  const add = (name, data, mtime = Date.now()) => {
    chunks.push(tarHeader(name, data.length, mtime), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad));
  };
  add(`${id}/assets/manifest.json`, Buffer.from(JSON.stringify(sub, null, 1)));
  add(
    `${id}/README.txt`,
    Buffer.from(
      `Terraforge project package: ${doc.name}\n\nproject/  -> copy to <terraforge>/projects/${id}\nassets/   -> merge into <terraforge>/public/assets (all assets are CC0, see ASSETS.md in the application)\n${missing.length ? '\nWARNING: assets missing at packaging time: ' + missing.join(', ') + '\n' : ''}`,
    ),
  );
  for (const f of files) {
    if (!existsSync(f.path)) continue;
    add(f.name, await readFile(f.path), (await stat(f.path)).mtimeMs);
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 1 });
}

export async function handleApi(req, res, url) {
  try {
    const parts = url.pathname.replace(/^\/api\//, '').split('/').filter(Boolean).map(decodeURIComponent);
    const method = req.method;
    if (parts[0] === 'health') return send(res, 200, { ok: true, projectsDir: PROJECTS_DIR });
    if (parts[0] === 'projects' && parts.length === 1 && method === 'GET') return send(res, 200, await listProjects());
    if (parts[0] === 'showcases' && parts[1] === 'restore' && method === 'POST') {
      const id = parts[2];
      if (!ID_RE.test(id) || !existsSync(join(SHOWCASES_DIR, id))) return send(res, 404, { error: 'unknown showcase' });
      await rm(safeJoin(PROJECTS_DIR, id), { recursive: true, force: true });
      await cp(join(SHOWCASES_DIR, id), safeJoin(PROJECTS_DIR, id), { recursive: true });
      return send(res, 200, { ok: true });
    }
    if (parts[0] === 'projects' && parts.length >= 2) {
      const id = parts[1];
      if (!ID_RE.test(id)) return send(res, 400, { error: 'invalid project id' });
      const dir = safeJoin(PROJECTS_DIR, id);
      const auto = url.searchParams.get('autosave') === '1';
      const base = auto ? join(dir, '.autosave') : dir;
      if (parts.length === 2 && method === 'DELETE') {
        await rm(dir, { recursive: true, force: true });
        return send(res, 200, { ok: true });
      }
      if (parts[2] === 'file' && parts[3]) {
        const name = parts[3];
        if (!FILE_RE.test(name)) return send(res, 400, { error: 'invalid file name' });
        const fp = safeJoin(base, name);
        if (method === 'GET') {
          if (!existsSync(fp)) return send(res, 404, { error: `file not found: ${id}/${name}` });
          const st = await stat(fp);
          res.writeHead(200, { 'Content-Type': name.endsWith('.json') ? 'application/json' : name.endsWith('.jpg') ? 'image/jpeg' : 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
          return createReadStream(fp).pipe(res);
        }
        if (method === 'PUT') {
          const body = await readBody(req);
          await mkdir(base, { recursive: true });
          // atomic replace so a crash mid-write cannot corrupt a project
          const tmp = fp + '.tmp-' + process.pid;
          await writeFile(tmp, body);
          await rename(tmp, fp);
          return send(res, 200, { ok: true, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') });
        }
      }
      if (parts[2] === 'autosave' && method === 'DELETE') {
        await rm(join(dir, '.autosave'), { recursive: true, force: true });
        return send(res, 200, { ok: true });
      }
      if (parts[2] === 'duplicate' && method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        const newId = body.id;
        if (!ID_RE.test(newId || '')) return send(res, 400, { error: 'invalid new id' });
        const dst = safeJoin(PROJECTS_DIR, newId);
        if (existsSync(dst)) return send(res, 409, { error: 'target exists' });
        await cp(dir, dst, { recursive: true, filter: (s) => !s.includes('.autosave') });
        const doc = JSON.parse(await readFile(join(dst, 'project.json'), 'utf8'));
        doc.id = newId;
        doc.name = body.name || doc.name + ' copy';
        delete doc.showcase;
        doc.created = new Date().toISOString();
        doc.modified = doc.created;
        await writeFile(join(dst, 'project.json'), JSON.stringify(doc));
        return send(res, 200, { ok: true, id: newId });
      }
      if (parts[2] === 'package' && method === 'GET') {
        if (!existsSync(join(dir, 'project.json'))) return send(res, 404, { error: 'unknown project' });
        const data = await buildPackage(id);
        return send(res, 200, data, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${id}.terraforge.tar.gz"` });
      }
      if (parts[2] === 'export' && parts[3] && parts[4] && method === 'PUT') {
        const stamp = parts[3],
          name = parts[4];
        if (!FILE_RE.test(stamp) || !FILE_RE.test(name)) return send(res, 400, { error: 'invalid export path' });
        const edir = safeJoin(EXPORTS_DIR, id, stamp);
        await mkdir(edir, { recursive: true });
        const body = await readBody(req);
        await writeFile(join(edir, name), body);
        return send(res, 200, { ok: true, path: join('exports', id, stamp, name), bytes: body.length });
      }
    }
    return send(res, 404, { error: 'unknown endpoint ' + method + ' ' + url.pathname });
  } catch (e) {
    return send(res, e.status || 500, { error: e.message });
  }
}
