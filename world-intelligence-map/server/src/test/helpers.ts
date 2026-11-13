/** Shared helpers for core tests: small synthetic adapters, an in-memory app and scripted transports. */
import { Catalog } from '../core/catalog.ts';
import { ManualClock } from '../core/clock.ts';
import { loadManifest } from '../adapters/base.ts';
import type { FetchedPayload, LayerDef, RecordDraft, SourceAdapter, SourceManifest } from '../core/types.ts';
import { ResilientHttp, type Transport, type TransportRequest, type TransportResponse } from '../http/client.ts';
import { Pipeline } from '../ingest/pipeline.ts';
import { openDatabase, type Db } from '../store/db.ts';
import { QueryEngine, type QueryContext } from '../store/queries.ts';
import { RecordStore, SqliteHttpCache } from '../store/records.ts';
import { computeHealth, type SourceHealth } from '../ingest/health.ts';

export const T0 = Date.UTC(2026, 10, 11, 0, 0, 0);
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

type LayerInput = Partial<LayerDef> & { id: string };

export function testManifest(id: string, layers: LayerInput[], over: Partial<SourceManifest> = {}): SourceManifest {
  return loadManifest({
    id,
    provider: `Provider ${id}`,
    dataset: `Dataset ${id}`,
    description: 'Synthetic source used by the test-suite.',
    homepageUrl: 'https://example.org/',
    documentationUrl: 'https://example.org/docs',
    sourceUrls: [`https://${id}.example.org/feed`],
    allowedHosts: [`${id}.example.org`],
    coverage: { geographic: 'Global', temporal: 'Test' },
    updateCadence: { upstream: 'test', pollIntervalSec: 300, staleAfterSec: 1800 },
    auth: { type: 'none', envVars: [] },
    attribution: `Attribution ${id}`,
    license: { name: 'Test licence', url: 'https://example.org/licence', redistribution: 'allowed', nonCommercialOnly: false },
    limitations: ['synthetic'],
    confidenceNotes: 'Synthetic test source.',
    retention: { note: 'test' },
    snapshot: 'incremental',
    http: {},
    layers: layers.map((l) => ({
      name: `Layer ${l.id}`,
      description: 'Synthetic test layer.',
      domain: 'hazards',
      category: 'test',
      geometry: 'point',
      timeModel: 'event',
      render: { type: 'point', color: 'red', shape: 'circle' },
      retentionDays: 30,
      ...l,
    })),
    ...over,
  });
}

/** An adapter whose feed is a JSON array of RecordDrafts served from `https://<id>.example.org/feed`. */
export function jsonAdapter(manifest: SourceManifest): SourceAdapter {
  return {
    manifest,
    version: '1.0.0',
    async fetch(ctx) {
      return [await ctx.http.get(`https://${manifest.allowedHosts[0]}/feed`, { key: 'feed' })];
    },
    parse(payloads: FetchedPayload[]) {
      const records: RecordDraft[] = [];
      const rejected: { reason: string }[] = [];
      for (const p of payloads) {
        let body: unknown;
        try {
          body = p.json();
        } catch {
          throw new Error('malformed test feed: not JSON');
        }
        if (!Array.isArray(body)) throw new Error('malformed test feed: not an array');
        for (const item of body) {
          if (item && typeof item === 'object' && typeof (item as RecordDraft).title === 'string') records.push(item as RecordDraft);
          else rejected.push({ reason: 'item is not a record' });
        }
      }
      return { records, rejected };
    },
  };
}

export type Responder = (req: TransportRequest, call: number) => TransportResponse | Promise<TransportResponse> | 'hang' | 'network';

/** Scriptable transport: one responder per host, with a call log. */
export class ScriptedTransport {
  readonly calls: TransportRequest[] = [];
  private readonly responders = new Map<string, Responder>();
  private readonly counts = new Map<string, number>();
  on(host: string, responder: Responder): this {
    this.responders.set(host, responder);
    return this;
  }
  /** Serve a JSON body (re-evaluated on every call so tests can mutate it). */
  json(host: string, body: () => unknown, headers: Record<string, string> = {}): this {
    return this.on(host, () => ({ status: 200, headers: { 'content-type': 'application/json', ...headers }, body: Buffer.from(JSON.stringify(body())) }));
  }
  count(host: string): number {
    return this.counts.get(host) ?? 0;
  }
  readonly transport: Transport = async (req) => {
    const host = new URL(req.url).hostname;
    this.calls.push(req);
    const n = (this.counts.get(host) ?? 0) + 1;
    this.counts.set(host, n);
    const r = this.responders.get(host);
    if (!r) return { status: 404, headers: {}, body: Buffer.from('no responder') };
    const out = await r(req, n);
    if (out === 'network') throw new Error('ECONNRESET');
    if (out === 'hang') {
      return new Promise<TransportResponse>((_, reject) => {
        const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (req.signal.aborted) fail();
        req.signal.addEventListener('abort', fail, { once: true });
      });
    }
    return out;
  };
}

export const ok = (body: unknown, headers: Record<string, string> = {}): TransportResponse => ({
  status: 200,
  headers: { 'content-type': 'application/json', ...headers },
  body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
});
export const status = (code: number, headers: Record<string, string> = {}): TransportResponse => ({ status: code, headers, body: Buffer.from(`HTTP ${code}`) });

export interface TestWorld {
  db: Db;
  catalog: Catalog;
  store: RecordStore;
  clock: ManualClock;
  http: ResilientHttp;
  pipeline: Pipeline;
  query: QueryEngine;
  net: ScriptedTransport;
  env: Record<string, string | undefined>;
  health(): Map<string, SourceHealth>;
  ctx(): QueryContext;
  sleeps: number[];
  close(): void;
}

export function makeWorld(adapters: SourceAdapter[], opts: { env?: Record<string, string | undefined>; fixture?: boolean; now?: number; policy?: Record<string, number> } = {}): TestWorld {
  const db = openDatabase(':memory:');
  const catalog = new Catalog(adapters);
  const store = new RecordStore(db, catalog);
  const clock = new ManualClock(opts.now ?? T0);
  const net = new ScriptedTransport();
  const sleeps: number[] = [];
  const env = opts.env ?? {};
  const http = new ResilientHttp({
    transport: net.transport,
    clock,
    cache: new SqliteHttpCache(db),
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
    policy: { minIntervalMs: 0, timeoutMs: 200, ...opts.policy },
  });
  const pipeline = new Pipeline({ catalog, store, http, clock, env, fixture: opts.fixture ?? false });
  const query = new QueryEngine(db, catalog);
  const health = () => {
    const m = new Map<string, SourceHealth>();
    for (const man of catalog.sources.values()) m.set(man.id, computeHealth(man, pipeline.states.get(man.id), clock.now(), env, { enabled: true, breaker: http.breaker(man.id).state }));
    return m;
  };
  return { db, catalog, store, clock, http, pipeline, query, net, env, health, ctx: () => ({ now: clock.now(), health: health() }), sleeps, close: () => db.close() };
}

export function point(lon: number, lat: number): { type: 'Point'; coordinates: [number, number] } {
  return { type: 'Point', coordinates: [lon, lat] };
}

let seq = 0;
export function draft(layerId: string, over: Partial<RecordDraft> = {}): RecordDraft {
  seq++;
  return { upstreamId: `r${seq}`, layerId, title: `Record ${seq}`, geometry: point(10, 10), occurredAt: T0 - HOUR, ...over };
}
