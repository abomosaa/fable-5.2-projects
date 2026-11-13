/**
 * WebSocket transport: admission (origin, capacity, per-IP limits), framing
 * limits, heartbeats and stale-connection detection. All game logic lives
 * behind LobbyManager; this file only moves bytes.
 */
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { MAX_CLIENT_MESSAGE_BYTES } from '../../../shared/constants';
import type { ServerConfig } from '../config';
import type { LobbyManager } from '../lobby/manager';
import { isOriginAllowed } from '../security/origin';
import type { Connection, Transport } from './connection';
import type { Logger } from '../util/logger';
import { requestHost, requestIp } from './httpServer';

export const WS_PATH = '/ws';

interface Tracked {
  conn: Connection;
  pingSentAt: number;
}

function reject(socket: Duplex, status: number, reason: string): void {
  const body = `${reason}\n`;
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  socket.destroy();
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

export class WsTransport {
  private readonly wss: WebSocketServer;
  private readonly sockets = new Map<WebSocket, Tracked>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ServerConfig,
    private readonly manager: LobbyManager,
    private readonly logger: Logger,
  ) {
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_CLIENT_MESSAGE_BYTES,
      // Frames are tiny; compression would only add CPU cost and attack surface.
      perMessageDeflate: false,
      clientTracking: false,
    });
  }

  attach(server: HttpServer): void {
    server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
    this.heartbeat = setInterval(() => this.beat(), this.config.heartbeatIntervalMs);
    this.heartbeat.unref();
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy());
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return reject(socket, 400, 'Bad Request');
    }
    if (pathname !== WS_PATH) return reject(socket, 404, 'Not Found');

    const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
    if (!isOriginAllowed(this.config, { origin, host: requestHost(this.config, req) })) {
      this.logger.warn('rejected websocket origin', { origin: origin ?? null });
      return reject(socket, 403, 'Forbidden');
    }
    const ip = requestIp(this.config, req);
    const refusal = this.manager.admit(ip);
    if (refusal === 'rate_limited' || refusal === 'ip_limit') return reject(socket, 429, 'Too Many Requests');
    if (refusal) return reject(socket, 503, 'Service Unavailable');

    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, ip));
  }

  private onConnection(ws: WebSocket, ip: string): void {
    const transport: Transport = {
      send: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: typeof data !== 'string' });
      },
      close: (code, reason) => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code, reason);
        // Do not wait forever for the peer's close frame.
        setTimeout(() => {
          if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
        }, 2000).unref();
      },
      bufferedAmount: () => ws.bufferedAmount,
    };
    const conn = this.manager.connect(transport, ip);
    const tracked: Tracked = { conn, pingSentAt: 0 };
    this.sockets.set(ws, tracked);

    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) this.manager.handleBinary(conn, toBytes(data));
        else this.manager.handleText(conn, Buffer.from(toBytes(data)).toString('utf8'));
      } catch (error) {
        this.logger.error('message handler failed', { conn: conn.id, error: String(error) });
      }
    });
    ws.on('pong', () => {
      const now = this.manager.now();
      conn.lastSeenAt = now;
      if (tracked.pingSentAt > 0) {
        const rtt = Math.max(0, now - tracked.pingSentAt);
        conn.pingMs = conn.pingMs === 0 ? rtt : conn.pingMs * 0.6 + rtt * 0.4;
        tracked.pingSentAt = 0;
      }
    });
    ws.on('close', () => {
      this.sockets.delete(ws);
      this.manager.disconnect(conn);
    });
    // Protocol errors (oversized frame, invalid UTF-8, ...) close the socket.
    ws.on('error', () => ws.terminate());
  }

  /** Pings every socket and terminates the ones that stopped answering. */
  private beat(): void {
    const stale = new Set(this.manager.reapConnections());
    const now = this.manager.now();
    for (const [ws, tracked] of this.sockets) {
      if (stale.has(tracked.conn)) {
        ws.terminate();
        continue;
      }
      if (ws.readyState !== WebSocket.OPEN) continue;
      tracked.pingSentAt = now;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }

  /** Closes every socket and stops accepting new ones. */
  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const ws of this.sockets.keys()) {
      if (ws.readyState === WebSocket.OPEN) ws.close(1001, 'server shutting down');
    }
    await new Promise<void>((done) => {
      const deadline = setTimeout(() => {
        for (const ws of this.sockets.keys()) ws.terminate();
        done();
      }, 1000);
      const poll = setInterval(() => {
        if (this.sockets.size === 0) {
          clearTimeout(deadline);
          clearInterval(poll);
          done();
        }
      }, 20);
      deadline.unref();
      poll.unref();
    });
    this.wss.close();
  }
}
