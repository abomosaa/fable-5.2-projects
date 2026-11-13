// Terraforge server: serves the built editor (dist/) and the local project storage API.
//   node server/server.mjs [--port 5173] [--dev]
// --dev runs the Vite dev server (hot reload) with the same API mounted.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi, ensureShowcases, ASSETS_DIR } from './api.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n, d) => (args.includes('--' + n) ? args[args.indexOf('--' + n) + 1] : d);
const port = +(flag('port', process.env.PORT || 5173));
const host = flag('host', '127.0.0.1');
const dev = args.includes('--dev');
// TERRAFORGE_DIST: serve a frozen copy of the built editor (used for reviews, so the build under
// review cannot change while it is being inspected)
const DIST = process.env.TERRAFORGE_DIST ? resolve(process.env.TERRAFORGE_DIST) : join(ROOT, 'dist');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.map': 'application/json' };

function serveFile(res, file, cache) {
  const st = statSync(file);
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache });
  createReadStream(file).pipe(res);
}

function staticHandler(req, res, url) {
  const dist = DIST;
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  for (const base of [dist, join(ROOT, 'public')]) {
    const f = normalize(join(base, p));
    if ((f === base || f.startsWith(base + sep)) && existsSync(f) && statSync(f).isFile()) return serveFile(res, f, p.startsWith('/assets/') ? 'public, max-age=3600' : 'no-cache');
  }
  if (p.startsWith('/assets/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: `asset not found: ${p}. Run "npm run assets" to download and process the asset library.` }));
  }
  if (extname(p) && extname(p) !== '.html') {
    // unknown static file (favicon etc.): a plain 404, never the SPA shell
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found');
  }
  if (!existsSync(join(DIST, 'index.html'))) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    return res.end('The editor has not been built yet. Run "npm run build" (or "npm start", which builds automatically).');
  }
  serveFile(res, join(DIST, 'index.html'), 'no-cache');
}

async function main() {
  const installed = await ensureShowcases();
  if (installed.length) console.log('Installed showcase projects:', installed.join(', '));
  if (!existsSync(join(ASSETS_DIR, 'manifest.json'))) console.warn('WARNING: public/assets/manifest.json is missing. Run "npm run assets" before opening the editor.');
  let vite = null;
  if (dev) {
    const { createServer: createVite } = await import('vite');
    vite = await createVite({ root: ROOT, server: { middlewareMode: true, hmr: { port: port + 1 } }, appType: 'spa' });
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    // assets are always served straight from disk (Vite snapshots the public dir at start-up)
    if (url.pathname.startsWith('/assets/')) return staticHandler(req, res, url);
    if (vite) return vite.middlewares(req, res, () => staticHandler(req, res, url));
    try {
      staticHandler(req, res, url);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e.message));
    }
  });
  server.listen(port, host, () => console.log(`Terraforge ${dev ? '(dev) ' : ''}running at http://${host}:${port}/`));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
