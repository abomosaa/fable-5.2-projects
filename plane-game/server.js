#!/usr/bin/env node
// Zero-dependency static file server for the flight simulator.
//   npm start            -> http://localhost:8080
//   PORT=9000 npm start  -> custom port
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
  if (urlPath === PING) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('skyward'); }
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
});

const PING = '/__skyward_ping';

/** Is it really this process answering on 127.0.0.1:port (and not another program bound there)? */
function selfCheck(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: PING, timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(body === 'skyward'));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function listen(port, attemptsLeft) {
  const fixed = !!process.env.PORT;
  const retry = (why) => {
    if (!fixed && attemptsLeft > 0) return listen(port + 1, attemptsLeft - 1);
    console.error(`Could not start the server on port ${port}: ${why}`);
    process.exit(1);
  };
  const onError = (e) => { server.removeListener('listening', onListening); retry(e.code === 'EADDRINUSE' ? 'the port is in use' : e.message); };
  const onListening = async () => {
    server.removeListener('error', onError);
    if (!(await selfCheck(port))) {
      // another program owns this port on the loopback interface: move on
      server.close(() => retry('another program is answering there'));
      return;
    }
    const url = `http://localhost:${port}`;
    console.log('\n  SKYWARD flight simulator is running\n');
    console.log(`  Open  ${url}  in your browser (Chrome, Edge or Firefox recommended).`);
    console.log('  Press Ctrl+C to stop.\n');
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port);
}
listen(Number(process.env.PORT) || 8080, 20);
