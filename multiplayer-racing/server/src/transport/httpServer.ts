/**
 * Plain HTTP side of the server: health/readiness probes, a status endpoint,
 * the runtime client configuration and (optionally) the built client.
 */
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { PROTOCOL_VERSION } from '../../../shared/protocol';
import type { ServerConfig } from '../config';
import type { LobbyManager } from '../lobby/manager';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.map', '.webmanifest']);
const MAX_GZIP_CACHE_BYTES = 32 * 1024 * 1024;

export interface HttpContext {
  config: ServerConfig;
  manager: LobbyManager;
  startedAt: number;
  isReady(): boolean;
}

interface GzipEntry {
  mtimeMs: number;
  body: Buffer;
}

export function createHttpHandler(ctx: HttpContext): (req: IncomingMessage, res: ServerResponse) => void {
  const staticRoot = ctx.config.staticDir ? resolve(ctx.config.staticDir) : null;
  const gzipCache = new Map<string, GzipEntry>();
  let gzipCacheBytes = 0;

  function securityHeaders(req: IncomingMessage, res: ServerResponse): void {
    const host = requestHost(ctx.config, req);
    const connect = ["'self'"];
    if (host && /^[A-Za-z0-9.\-:[\]]+$/.test(host)) connect.push(`ws://${host}`, `wss://${host}`);
    if (ctx.config.wsPublicUrl) {
      try {
        const u = new URL(ctx.config.wsPublicUrl);
        connect.push(`${u.protocol}//${u.host}`);
      } catch {
        // Validated at startup.
      }
    }
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "media-src 'self' blob:",
        "worker-src 'self' blob:",
        `connect-src ${connect.join(' ')}`,
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  }

  function json(res: ServerResponse, status: number, body: unknown, head: boolean): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
    });
    res.end(head ? undefined : text);
  }

  function text(res: ServerResponse, status: number, body: string, head: boolean): void {
    res.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(head ? undefined : body);
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string, head: boolean): Promise<void> {
    if (!staticRoot) {
      text(
        res,
        404,
        'Apex Drift server is running, but no client build is being served.\nRun "npm run dev" and open the Vite URL, or "npm run build" and restart.\n',
        head,
      );
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return text(res, 400, 'Bad request\n', head);
    }
    if (decoded.includes('\0')) return text(res, 400, 'Bad request\n', head);
    let file = resolve(join(staticRoot, normalize(decoded)));
    // Never serve anything outside the static root.
    if (file !== staticRoot && !file.startsWith(staticRoot + sep)) return text(res, 403, 'Forbidden\n', head);

    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      file = join(file, 'index.html');
      info = await stat(file).catch(() => null);
    }
    if (!info?.isFile()) {
      // Single-page app: unknown extension-less paths get the app shell.
      if (extname(decoded) !== '') return text(res, 404, 'Not found\n', head);
      file = join(staticRoot, 'index.html');
      info = await stat(file).catch(() => null);
      if (!info?.isFile()) return text(res, 404, 'Not found\n', head);
    }

    const ext = extname(file).toLowerCase();
    const headers: Record<string, string | number> = {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': decoded.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Last-Modified': info.mtime.toUTCString(),
    };
    const since = req.headers['if-modified-since'];
    if (since && Math.floor(info.mtimeMs / 1000) <= Math.floor(new Date(since).getTime() / 1000)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }

    const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    if (acceptsGzip && COMPRESSIBLE.has(ext) && info.size > 1024 && info.size < 8 * 1024 * 1024) {
      let entry = gzipCache.get(file);
      if (!entry || entry.mtimeMs !== info.mtimeMs) {
        const body = gzipSync(await readFile(file));
        if (entry) gzipCacheBytes -= entry.body.byteLength;
        entry = { mtimeMs: info.mtimeMs, body };
        if (gzipCacheBytes + body.byteLength <= MAX_GZIP_CACHE_BYTES) {
          gzipCache.set(file, entry);
          gzipCacheBytes += body.byteLength;
        }
      }
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
      headers['Content-Length'] = entry.body.byteLength;
      res.writeHead(200, headers);
      res.end(head ? undefined : entry.body);
      return;
    }

    headers['Content-Length'] = info.size;
    res.writeHead(200, headers);
    if (head) {
      res.end();
      return;
    }
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  return (req, res) => {
    securityHeaders(req, res);
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      text(res, 405, 'Method not allowed\n', false);
      return;
    }
    const head = method === 'HEAD';
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      text(res, 400, 'Bad request\n', head);
      return;
    }

    switch (pathname) {
      case '/healthz':
        // Liveness: the process is up and its event loop responds.
        json(res, 200, { status: 'ok' }, head);
        return;
      case '/readyz': {
        // Readiness: accepting players (false while starting or draining).
        const ready = ctx.isReady();
        json(res, ready ? 200 : 503, { status: ready ? 'ready' : 'unavailable' }, head);
        return;
      }
      case '/api/status':
        json(
          res,
          200,
          {
            name: 'apex-drift',
            version: ctx.config.serverVersion,
            protocol: PROTOCOL_VERSION,
            region: ctx.config.region,
            uptimeSeconds: Math.round((Date.now() - ctx.startedAt) / 1000),
            ready: ctx.isReady(),
            ...ctx.manager.stats(),
          },
          head,
        );
        return;
      case '/config.json':
        // Runtime configuration for the browser client.
        json(
          res,
          200,
          {
            wsUrl: ctx.config.wsPublicUrl,
            publicUrl: ctx.config.publicUrl,
            region: ctx.config.region,
            protocol: PROTOCOL_VERSION,
            version: ctx.config.serverVersion,
          },
          head,
        );
        return;
      case '/ws':
        text(res, 426, 'This endpoint speaks WebSocket.\n', head);
        return;
      default:
        serveStatic(req, res, pathname, head).catch(() => {
          if (!res.headersSent) text(res, 500, 'Internal server error\n', head);
          else res.destroy();
        });
    }
  };
}

/** Host the client used, honouring X-Forwarded-Host behind a trusted proxy. */
export function requestHost(config: ServerConfig, req: IncomingMessage): string | undefined {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-host'];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (value) return value.split(',')[0]!.trim().toLowerCase();
  }
  return req.headers.host?.toLowerCase();
}

/** Client address, honouring X-Forwarded-For behind a trusted proxy. */
export function requestIp(config: ServerConfig, req: IncomingMessage): string {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = value?.split(',')[0]?.trim();
    if (first && first.length <= 64 && /^[0-9a-fA-F:.]+$/.test(first)) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}
