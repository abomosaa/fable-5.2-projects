/** Composition root: wires configuration, catalog, database, HTTP client, pipeline, scheduler and query engine. */
import { ADAPTERS } from './adapters/registry.ts';
import { Catalog } from './core/catalog.ts';
import { FixtureClock, systemClock, type Clock } from './core/clock.ts';
import type { HttpPolicy } from './http/client.ts';
import { FIXTURE_EPOCH } from './core/fixtureEpoch.ts';
import { adaptersPath } from './core/paths.ts';
import type { SourceAdapter } from './core/types.ts';
import type { AppConfig } from './config.ts';
import { demoPlan, type DemoPlan } from './demo/scenario.ts';
import { GENERATORS } from './demo/volume.ts';
import { fetchTransport, ResilientHttp, type Transport } from './http/client.ts';
import { FixtureTransport } from './http/fixtureTransport.ts';
import { computeHealth, type SourceHealth } from './ingest/health.ts';
import { Pipeline } from './ingest/pipeline.ts';
import { Scheduler } from './ingest/scheduler.ts';
import { openDatabase, type Db } from './store/db.ts';
import { QueryEngine, type QueryContext } from './store/queries.ts';
import { RecordStore, SqliteHttpCache } from './store/records.ts';

export interface App {
  config: AppConfig;
  catalog: Catalog;
  db: Db;
  store: RecordStore;
  http: ResilientHttp;
  pipeline: Pipeline;
  scheduler: Scheduler;
  query: QueryEngine;
  clock: Clock;
  env: Record<string, string | undefined>;
  demo: DemoPlan | null;
  fixtureTransport: FixtureTransport | null;
  health(): Map<string, SourceHealth>;
  queryContext(): QueryContext;
  /** Fixture mode: play the "earlier session" for the stale-data demonstration. */
  prepareDemo(): Promise<void>;
  close(): Promise<void>;
}

export interface AppOverrides {
  adapters?: SourceAdapter[];
  transport?: Transport;
  clock?: Clock;
  log?: (msg: string) => void;
  /** Overrides for the upstream HTTP policy (tests shorten timeouts). */
  httpPolicy?: Partial<HttpPolicy>;
  sleep?: (ms: number) => Promise<void>;
}

export function createApp(config: AppConfig, overrides: AppOverrides = {}): App {
  const adapters = overrides.adapters ?? ADAPTERS;
  const catalog = new Catalog(adapters);
  const fixture = config.mode === 'fixture';
  const log = overrides.log ?? (config.quiet ? () => {} : (m: string) => console.log(m));
  const clock: Clock = overrides.clock ?? (fixture ? new FixtureClock(FIXTURE_EPOCH) : systemClock);
  const db = openDatabase(config.dbFile);
  const store = new RecordStore(db, catalog);

  let demo: DemoPlan | null = null;
  let fixtureTransport: FixtureTransport | null = null;
  let transport: Transport;
  let env: Record<string, string | undefined>;

  if (fixture) {
    demo = config.demoScenario === 'off'
      ? { steps: [], fastSources: [], misconfigured: [], staleSource: null }
      : demoPlan(new Set(catalog.sources.keys()), config.demoStaleHoldSec, config.demoScenario === 'on');
    fixtureTransport = new FixtureTransport({
      adaptersDir: adaptersPath(),
      scenario: demo.steps,
      generators: GENERATORS,
      extraRoutes: config.demoVolume > 0 && catalog.sources.has('nasa-firms')
        ? { 'nasa-firms': [{ match: '/api/area/csv/', generator: 'firms-volume', generatorParams: { count: config.demoVolume }, contentType: 'text/csv' }] }
        : {},
    });
    transport = overrides.transport ?? fixtureTransport.transport;
    // Fixture mode never uses real credentials: every declared variable gets an inert placeholder,
    // except the sources the scenario deliberately leaves unconfigured.
    env = {};
    for (const m of catalog.sources.values()) {
      if (demo.misconfigured.includes(m.id)) continue;
      for (const v of m.auth.envVars) env[v.name] = `fixture-${v.name.toLowerCase()}`;
    }
  } else {
    transport = overrides.transport ?? fetchTransport((sourceId) => catalog.sources.get(sourceId)?.allowedHosts ?? []);
    env = config.env;
  }

  const http = new ResilientHttp({
    transport,
    clock,
    cache: new SqliteHttpCache(db),
    // Fixture mode: short timeouts, no request spacing and no TTL caching, so every run reaches the scripted scenario.
    policy: { ...(fixture ? { timeoutMs: 4000, minIntervalMs: 0, backoffBaseMs: 200, backoffCapMs: 1500 } : {}), ...overrides.httpPolicy },
    ignoreManifestHttp: fixture,
    ...(overrides.sleep ? { sleep: overrides.sleep } : fixture ? { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 1500))) } : {}),
  });
  // Sources whose terms make them opt-in (manifest enabledByDefault: false) stay off in live mode until the operator
  // lists them in WIM_ENABLED_SOURCES. Fixture mode replays bundled files only, so everything is switched on there.
  const disabled = new Set(config.disabledSources);
  if (!fixture) {
    for (const m of catalog.sources.values()) if (!m.enabledByDefault && !config.enabledSources.has(m.id)) disabled.add(m.id);
  }
  const pipeline = new Pipeline({ catalog, store, http, clock, env, fixture, fixtureTransport: fixtureTransport ?? undefined, disabled, log });
  const scheduler = new Scheduler({
    catalog,
    pipeline,
    store,
    clock,
    concurrency: config.concurrency,
    log,
    intervalSec: fixture ? (id, sec) => (demo!.fastSources.includes(id) ? 20 : Math.min(sec, 120)) : undefined,
    firstRunDelayMs: (id) => (fixture && demo?.staleSource?.id === id ? demo.staleSource.holdSec * 1000 : undefined),
  });
  const query = new QueryEngine(db, catalog);

  let healthCache: { at: number; map: Map<string, SourceHealth> } | null = null;
  const health = (): Map<string, SourceHealth> => {
    const wall = Date.now();
    if (healthCache && wall - healthCache.at < 500) return healthCache.map;
    const now = clock.now();
    const map = new Map<string, SourceHealth>();
    for (const m of catalog.sources.values()) {
      map.set(m.id, computeHealth(m, pipeline.states.get(m.id), now, env, { enabled: pipeline.isEnabled(m.id), breaker: http.breaker(m.id).state }));
    }
    healthCache = { at: wall, map };
    return map;
  };
  pipeline.on('ingest', () => {
    healthCache = null;
  });

  return {
    config, catalog, db, store, http, pipeline, scheduler, query, clock, env, demo, fixtureTransport, health,
    queryContext: () => ({ now: clock.now(), health: health() }),
    async prepareDemo() {
      const s = demo?.staleSource;
      if (!s || !('withOffset' in clock) || !catalog.sources.has(s.id)) return;
      await (clock as FixtureClock).withOffset(-s.ageMs, () => pipeline.runSource(s.id));
      healthCache = null;
    },
    async close() {
      await scheduler.stop();
      db.close();
    },
  };
}
