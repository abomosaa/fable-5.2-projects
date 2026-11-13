import { normalizeOrigin, type ServerConfig } from '../config';

export interface OriginRequest {
  origin: string | undefined;
  /** Host the client connected to (Host header, or X-Forwarded-Host behind a trusted proxy). */
  host: string | undefined;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Decides whether a WebSocket handshake's Origin is acceptable.
 *
 *  - Origins listed in ALLOWED_ORIGINS (and PUBLIC_URL's origin) always pass.
 *  - Same-origin handshakes pass: the Origin's host equals the request Host.
 *    This is the safe default for a server that also serves the client.
 *  - Outside production, any localhost origin passes (Vite dev server).
 *  - A missing Origin (non-browser client) passes only if allowMissingOrigin.
 *  - Everything else is rejected, which blocks cross-site WebSocket hijacking.
 */
export function isOriginAllowed(config: ServerConfig, request: OriginRequest): boolean {
  if (config.allowedOrigins.includes('*')) return true;
  if (request.origin === undefined || request.origin === '') return config.allowMissingOrigin;
  const origin = normalizeOrigin(request.origin);
  if (!origin) return false;
  if (config.allowedOrigins.includes(origin)) return true;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  if (request.host && originUrl.host === request.host.toLowerCase()) return true;
  if (config.env !== 'production' && LOCAL_HOSTS.has(originUrl.hostname)) return true;
  return false;
}
