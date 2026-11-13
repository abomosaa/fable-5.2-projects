#!/usr/bin/env node
/**
 * One-command launcher: builds the app if needed and serves it locally.
 * No network access is required at run time.
 *   npm start            → http://localhost:4173
 *   PORT=8080 npm start
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = join(root, 'dist');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
if (!existsSync(join(root, 'public', 'examples', 'index.json'))) {
  console.log('Generating showcase projects…');
  const r = spawnSync(npx, ['tsx', 'scripts/build-examples.ts'], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
if (!existsSync(join(dist, 'index.html')) || process.argv.includes('--rebuild')) {
  console.log('Building the app (first launch only)…');
  const r = spawnSync(npx, ['vite', 'build'], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.map': 'application/json',
};
const firstPort = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? '127.0.0.1';
const handler = (req, res) => {
  let p = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(dist, p));
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(readFileSync(file));
};
function listen(port, attempt) {
  const server = createServer(handler);
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < 20 && !process.env.PORT) { listen(port + 1, attempt + 1); return; }
    console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use. Set another one: PORT=8080 npm start` : e.message);
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.log(`\nMechanism Workshop is running at  http://${host === '0.0.0.0' ? 'localhost' : host}:${port}\n(Ctrl+C to stop)`);
  });
}
listen(firstPort, 0);
