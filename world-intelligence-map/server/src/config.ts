/** Runtime configuration from CLI flags and environment variables. Credentials stay in process.env on the server. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from './core/paths.ts';

export interface AppConfig {
  mode: 'live' | 'fixture';
  host: string;
  port: number;
  dbFile: string;
  disabledSources: Set<string>;
  /** Opt-in sources (manifest enabledByDefault: false) that the operator switched on. */
  enabledSources: Set<string>;
  /**
   * Fixture mode only. 'on': scripted outage / rate-limit / malformed-payload / timeout / breaker runs plus the static
   * conditions; 'static': only the conditions that do not change over time (stale source, missing credentials) – used by
   * the end-to-end tests; 'off': every source healthy.
   */
  demoScenario: 'on' | 'static' | 'off';
  /** Fixture mode only: number of generated high-volume detections (0 disables the generator). */
  demoVolume: number;
  /** Fixture mode only: seconds the stale-data demonstration source is left un-refreshed after start-up. */
  demoStaleHoldSec: number;
  concurrency: number;
  env: Record<string, string | undefined>;
  quiet: boolean;
}

export function loadDotEnv(): void {
  const file = path.join(repoRoot(), '.env');
  if (existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch (err) {
      console.warn(`[config] could not read .env: ${(err as Error).message}`);
    }
  }
}

export function loadConfig(argv: string[] = process.argv.slice(2), env: Record<string, string | undefined> = process.env): AppConfig {
  const flag = (name: string): string | undefined => {
    const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return undefined;
    return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : 'true';
  };
  const modeRaw = (flag('mode') ?? env.WIM_MODE ?? 'live').toLowerCase();
  if (modeRaw !== 'live' && modeRaw !== 'fixture') throw new Error(`invalid mode "${modeRaw}" (expected live or fixture)`);
  const mode = modeRaw;
  const port = Number(flag('port') ?? env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid port');
  const volume = Number(flag('volume') ?? env.WIM_DEMO_VOLUME ?? 45000);
  return {
    mode,
    host: flag('host') ?? env.HOST ?? '127.0.0.1',
    port,
    // Fixture mode always starts from an empty in-memory database so every run is identical.
    dbFile: mode === 'fixture' ? ':memory:' : (flag('db') ?? env.WIM_DB_FILE ?? path.join(repoRoot(), 'data', 'live.sqlite')),
    disabledSources: new Set((env.WIM_DISABLED_SOURCES ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
    enabledSources: new Set((env.WIM_ENABLED_SOURCES ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
    demoScenario: (['on', 'static', 'off'] as const).find((v) => v === (flag('scenario') ?? env.WIM_DEMO_SCENARIO ?? 'on')) ?? 'on',
    demoVolume: Number.isFinite(volume) && volume >= 0 ? Math.min(500_000, Math.floor(volume)) : 45000,
    demoStaleHoldSec: Math.max(0, Number(flag('stale-hold') ?? env.WIM_DEMO_STALE_HOLD_SEC ?? 240) || 0),
    concurrency: Math.max(1, Math.min(16, Number(env.WIM_INGEST_CONCURRENCY ?? 4) || 4)),
    env,
    quiet: flag('quiet') === 'true' || env.WIM_QUIET === '1',
  };
}
