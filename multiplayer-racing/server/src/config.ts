/**
 * Server configuration, read once from environment variables and validated.
 * Everything a deployment needs to change lives here; see README "Deployment".
 */
import {
  COUNTDOWN_TICKS,
  DEFAULT_SNAPSHOT_EVERY,
  DEFAULT_TICK_RATE,
  FINISH_TIMEOUT_TICKS,
  SIM_HZ,
} from '../../shared/constants';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
export type RuntimeEnv = 'development' | 'production' | 'test';

export interface ServerConfig {
  env: RuntimeEnv;
  serverVersion: string;
  /** Interface to bind. */
  host: string;
  port: number;
  /** Public base URL of the site, e.g. https://race.example.com */
  publicUrl: string | null;
  /** Public WebSocket URL handed to clients, e.g. wss://race.example.com/ws */
  wsPublicUrl: string | null;
  /** Exact origins allowed to open WebSockets. `*` allows any (not recommended). */
  allowedOrigins: string[];
  /** Accept WebSocket handshakes without an Origin header (non-browser clients). */
  allowMissingOrigin: boolean;
  /** Trust X-Forwarded-For / X-Forwarded-Host from a reverse proxy. */
  trustProxy: boolean;
  region: string;
  /** Directory with the built client, or null to not serve static files. */
  staticDir: string | null;
  /** Directory for persisted data (lap records), or null for in-memory only. */
  dataDir: string | null;
  logLevel: LogLevel;

  tickRate: number;
  snapshotEvery: number;
  countdownTicks: number;
  finishTimeoutTicks: number;
  /** Ticks the cars keep rolling after the race is decided, before results. */
  cooldownTicks: number;
  resultsHoldMs: number;

  maxConnections: number;
  maxConnectionsPerIp: number;
  maxRooms: number;
  maxRoomsPerIp: number;
  /** Per-IP budgets: burst size and sustained rate per minute. */
  createBurst: number;
  createPerMinute: number;
  joinBurst: number;
  joinPerMinute: number;
  connectBurst: number;
  connectPerMinute: number;
  reconnectGraceMs: number;
  /** A lobby with no activity for this long is closed. */
  roomIdleTimeoutMs: number;
  kickBanMs: number;
  helloTimeoutMs: number;
  heartbeatIntervalMs: number;
  /** A connection that is silent for this long is terminated. */
  connectionTimeoutMs: number;
  shutdownGraceMs: number;
}

export class ConfigError extends Error { }

type Env = Record<string, string | undefined>;

function str(env: Env, key: string): string | null {
  const v = env[key];
  return v === undefined || v.trim() === '' ? null : v.trim();
}

function int(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = str(env, key);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${key} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = str(env, key);
  if (raw === null) return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new ConfigError(`${key} must be true or false (got "${raw}")`);
}

function url(env: Env, key: string, protocols: string[]): string | null {
  const raw = str(env, key);
  if (raw === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(`${key} must be an absolute URL (got "${raw}")`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new ConfigError(`${key} must use one of ${protocols.join(', ')} (got "${raw}")`);
  }
  return raw.replace(/\/+$/, '');
}

export function normalizeOrigin(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function loadConfig(env: Env = process.env): ServerConfig {
  const rawEnv = str(env, 'NODE_ENV') ?? 'development';
  if (rawEnv !== 'development' && rawEnv !== 'production' && rawEnv !== 'test') {
    throw new ConfigError(`NODE_ENV must be development, production or test (got "${rawEnv}")`);
  }
  const runtime: RuntimeEnv = rawEnv;
  const production = runtime === 'production';

  const publicUrl = url(env, 'PUBLIC_URL', ['http:', 'https:']);
  const wsPublicUrl = url(env, 'WS_PUBLIC_URL', ['ws:', 'wss:']);

  const allowedOrigins: string[] = [];
  const rawOrigins = str(env, 'ALLOWED_ORIGINS');
  if (rawOrigins) {
    for (const part of rawOrigins.split(',')) {
      const item = part.trim();
      if (!item) continue;
      if (item === '*') {
        allowedOrigins.push('*');
        continue;
      }
      const origin = normalizeOrigin(item);
      if (!origin) throw new ConfigError(`ALLOWED_ORIGINS contains an invalid origin: "${item}"`);
      allowedOrigins.push(origin);
    }
  }
  if (publicUrl) {
    const origin = normalizeOrigin(publicUrl);
    if (origin && !allowedOrigins.includes(origin)) allowedOrigins.push(origin);
  }

  const logLevel = (str(env, 'LOG_LEVEL') ?? (runtime === 'test' ? 'silent' : 'info')) as LogLevel;
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(logLevel)) {
    throw new ConfigError(`LOG_LEVEL must be debug, info, warn, error or silent (got "${logLevel}")`);
  }

  const tickRate = int(env, 'TICK_RATE', DEFAULT_TICK_RATE, 10, 1000);

  return {
    env: runtime,
    serverVersion: str(env, 'SERVER_VERSION') ?? '1.0.0',
    host: str(env, 'HOST') ?? (production ? '0.0.0.0' : '127.0.0.1'),
    port: int(env, 'PORT', 8089, 0, 65535),
    publicUrl,
    wsPublicUrl,
    allowedOrigins,
    // Browsers always send Origin; only scripts and native tools omit it.
    allowMissingOrigin: bool(env, 'ALLOW_MISSING_ORIGIN', !production),
    trustProxy: bool(env, 'TRUST_PROXY', false),
    region: (str(env, 'REGION') ?? '').slice(0, 32),
    staticDir: str(env, 'STATIC_DIR'),
    dataDir: str(env, 'DATA_DIR'),
    logLevel,

    tickRate,
    snapshotEvery: int(env, 'SNAPSHOT_EVERY', DEFAULT_SNAPSHOT_EVERY, 1, 10),
    countdownTicks: int(env, 'COUNTDOWN_TICKS', COUNTDOWN_TICKS, SIM_HZ / 2, 30 * SIM_HZ),
    finishTimeoutTicks: int(env, 'FINISH_TIMEOUT_S', FINISH_TIMEOUT_TICKS / SIM_HZ, 1, 600) * SIM_HZ,
    cooldownTicks: int(env, 'COOLDOWN_TICKS', 4 * SIM_HZ, 0, 30 * SIM_HZ),
    resultsHoldMs: int(env, 'RESULTS_HOLD_S', 40, 1, 600) * 1000,

    maxConnections: int(env, 'MAX_CONNECTIONS', 500, 1, 100_000),
    maxConnectionsPerIp: int(env, 'MAX_CONNECTIONS_PER_IP', 16, 1, 10_000),
    maxRooms: int(env, 'MAX_ROOMS', 100, 1, 10_000),
    maxRoomsPerIp: int(env, 'MAX_ROOMS_PER_IP', 6, 1, 10_000),
    createBurst: int(env, 'CREATE_BURST', 5, 1, 10_000),
    createPerMinute: int(env, 'CREATE_PER_MINUTE', 6, 1, 100_000),
    joinBurst: int(env, 'JOIN_BURST', 15, 1, 10_000),
    joinPerMinute: int(env, 'JOIN_PER_MINUTE', 40, 1, 100_000),
    connectBurst: int(env, 'CONNECT_BURST', 40, 1, 100_000),
    connectPerMinute: int(env, 'CONNECT_PER_MINUTE', 120, 1, 1_000_000),
    reconnectGraceMs: int(env, 'RECONNECT_GRACE_S', 30, 1, 600) * 1000,
    roomIdleTimeoutMs: int(env, 'ROOM_IDLE_TIMEOUT_S', 15 * 60, 5, 24 * 3600) * 1000,
    kickBanMs: int(env, 'KICK_BAN_S', 120, 0, 24 * 3600) * 1000,
    helloTimeoutMs: int(env, 'HELLO_TIMEOUT_S', 10, 1, 120) * 1000,
    heartbeatIntervalMs: int(env, 'HEARTBEAT_INTERVAL_S', 5, 1, 120) * 1000,
    connectionTimeoutMs: int(env, 'CONNECTION_TIMEOUT_S', 30, 2, 600) * 1000,
    shutdownGraceMs: int(env, 'SHUTDOWN_GRACE_MS', 500, 0, 30_000),
  };
}

/** A config for tests: fast, quiet, permissive about Origin. */
export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return { ...loadConfig({ NODE_ENV: 'test' }), port: 0, ...overrides };
}
