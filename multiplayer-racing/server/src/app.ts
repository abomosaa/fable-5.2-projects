/**
 * Assembles the server: configuration, persistence, lobby, HTTP + WebSocket
 * transports and the fixed-timestep game loop. `createGameServer` is used by
 * `main.ts` and by the integration tests.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { ServerConfig } from './config';
import { LobbyManager } from './lobby/manager';
import { FileRecordsStore, MemoryRecordsStore, type RecordsStore } from './persistence/recordsStore';
import { createHttpHandler } from './transport/httpServer';
import { WsTransport } from './transport/wsServer';
import { createLogger, type Logger } from './util/logger';

/** Ticks simulated in one go to catch up after a stall before giving up on the backlog. */
const MAX_CATCHUP_TICKS = 8;
const HOUSEKEEPING_INTERVAL_MS = 250;
const IDLE_POLL_MS = 50;

export interface GameServer {
  readonly config: ServerConfig;
  readonly manager: LobbyManager;
  /** Port the server is listening on (useful when configured with port 0). */
  readonly port: number;
  readonly loopStats: { ticks: number; droppedTicks: number };
  /** Graceful shutdown: notify clients, close sockets, flush persistence. */
  stop(reason?: string): Promise<void>;
}

export interface GameServerDeps {
  logger?: Logger;
  records?: RecordsStore;
}

export async function createGameServer(config: ServerConfig, deps: GameServerDeps = {}): Promise<GameServer> {
  const logger = deps.logger ?? createLogger(config.logLevel);
  const records =
    deps.records ??
    (config.dataDir ? await FileRecordsStore.open(join(config.dataDir, 'records.json'), logger) : new MemoryRecordsStore());
  const manager = new LobbyManager(config, logger, records);

  let ready = false;
  const startedAt = Date.now();
  const http: HttpServer = createServer(createHttpHandler({ config, manager, startedAt, isReady: () => ready }));
  // Slow or idle HTTP clients must not hold sockets open forever.
  http.headersTimeout = 15_000;
  http.requestTimeout = 30_000;
  http.keepAliveTimeout = 5_000;
  const ws = new WsTransport(config, manager, logger);
  ws.attach(http);

  // ---- Fixed-timestep loop. Simulation time advances only in whole ticks;
  // wall-clock hiccups are caught up (bounded) and never change the step.
  const tickMs = 1000 / config.tickRate;
  const loopStats = { ticks: 0, droppedTicks: 0 };
  let nextTickAt = performance.now();
  let loopTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  const loop = (): void => {
    if (stopped) return;
    const now = performance.now();
    if (!manager.hasActiveRaces()) {
      nextTickAt = now + tickMs;
      loopTimer = setTimeout(loop, IDLE_POLL_MS);
      return;
    }
    let steps = 0;
    while (now >= nextTickAt && steps < MAX_CATCHUP_TICKS) {
      manager.tick();
      nextTickAt += tickMs;
      steps++;
    }
    loopStats.ticks += steps;
    if (now >= nextTickAt) {
      // Stalled for longer than we are willing to catch up: drop the backlog
      // so the race slows down instead of fast-forwarding.
      const dropped = Math.floor((now - nextTickAt) / tickMs) + 1;
      loopStats.droppedTicks += dropped;
      nextTickAt += dropped * tickMs;
    }
    loopTimer = setTimeout(loop, Math.max(0, nextTickAt - performance.now()));
  };

  const housekeeping = setInterval(() => {
    try {
      manager.housekeeping();
    } catch (error) {
      logger.error('housekeeping failed', { error: String(error) });
    }
  }, HOUSEKEEPING_INTERVAL_MS);
  housekeeping.unref();

  await new Promise<void>((resolveListen, rejectListen) => {
    http.once('error', rejectListen);
    http.listen(config.port, config.host, () => {
      http.off('error', rejectListen);
      resolveListen();
    });
  });
  const port = (http.address() as AddressInfo).port;
  ready = true;
  loop();
  logger.info('server listening', {
    host: config.host,
    port,
    env: config.env,
    tickRate: config.tickRate,
    static: config.staticDir,
    origins: config.allowedOrigins,
  });

  let stopping: Promise<void> | null = null;
  const stop = (reason = 'The server is restarting. Please reconnect in a moment.'): Promise<void> => {
    stopping ??= (async () => {
      ready = false;
      manager.beginShutdown(reason);
      // Give the notice a moment to reach clients before closing sockets.
      if (config.shutdownGraceMs > 0) await new Promise((r) => setTimeout(r, config.shutdownGraceMs));
      stopped = true;
      if (loopTimer) clearTimeout(loopTimer);
      clearInterval(housekeeping);
      manager.closeAll();
      await ws.close();
      await new Promise<void>((done) => {
        http.close(() => done());
        http.closeAllConnections();
      });
      await records.close();
      logger.info('server stopped');
    })();
    return stopping;
  };

  return { config, manager, port, loopStats, stop };
}
