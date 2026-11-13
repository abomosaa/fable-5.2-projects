/**
 * Deterministic transport for fixture/demo mode and tests.
 *
 * Each adapter directory contains fixtures/index.json:
 *   { "capturedAt": "...", "notes": "...", "routes": [ { "match": "<substring of URL>", "file": "name.json", ... } ] }
 * A request is answered from the first route whose `match` is a substring of the request URL (or whose `regex` matches).
 * Routes may declare an `etag` (conditional requests then yield 304) and named `variants` (e.g. a malformed payload).
 *
 * A scenario can override responses per source and per ingestion run to demonstrate outages, rate limiting,
 * malformed payloads and recovery – always deterministically (keyed by run number, never by wall clock or randomness).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Transport, TransportRequest, TransportResponse } from './client.ts';

export interface FixtureRoute {
  match?: string;
  regex?: string;
  /** File inside the adapter's fixtures/ directory. */
  file?: string;
  /** Name of a registered generator producing the body (large synthetic volume fixtures). */
  generator?: string;
  generatorParams?: Record<string, unknown>;
  status?: number;
  contentType?: string;
  etag?: string;
  lastModified?: string;
  headers?: Record<string, string>;
  /** Alternate files, selectable by a scenario step: { "malformed": "feed.malformed.json" } */
  variants?: Record<string, string>;
}
export interface FixtureIndex {
  capturedAt?: string;
  notes?: string;
  routes: FixtureRoute[];
}

export interface ScenarioEffect {
  /** Respond with this status instead of the fixture. */
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Use a named variant file of the matched route. */
  variant?: string;
  /** Never answer (until the client's timeout aborts the request). */
  hang?: boolean;
  /** Throw a network error. */
  networkError?: boolean;
}
export interface ScenarioStep {
  source: string;
  /** Inclusive run numbers (1-based) during which the effect applies. `to` omitted = forever. */
  fromRun: number;
  toRun?: number;
  effect: ScenarioEffect;
  label?: string;
  /** Apply only to requests whose URL contains this text (default: every request of the source). */
  urlIncludes?: string;
}

export type FixtureGenerator = (params: Record<string, unknown>, req: TransportRequest) => Buffer | string;

export interface FixtureTransportOptions {
  /** Directory containing one sub-directory per adapter. */
  adaptersDir: string;
  scenario?: ScenarioStep[];
  generators?: Record<string, FixtureGenerator>;
  /** Routes consulted before a source's own index.json (used to swap in generated high-volume payloads). */
  extraRoutes?: Record<string, FixtureRoute[]>;
}

export class FixtureTransport {
  private readonly indexes = new Map<string, FixtureIndex | null>();
  private readonly runs = new Map<string, number>();
  private readonly generated = new Map<string, Buffer>();
  readonly requests: { sourceId: string; url: string; run: number }[] = [];
  constructor(private readonly opts: FixtureTransportOptions) {}

  /** Called by the pipeline at the start of every ingestion run of a source. */
  beginRun(sourceId: string): number {
    const n = (this.runs.get(sourceId) ?? 0) + 1;
    this.runs.set(sourceId, n);
    return n;
  }
  runNumber(sourceId: string): number {
    return this.runs.get(sourceId) ?? 0;
  }
  setScenario(steps: ScenarioStep[]): void {
    this.opts.scenario = steps;
  }

  fixturesDir(sourceId: string): string {
    return path.join(this.opts.adaptersDir, sourceId, 'fixtures');
  }

  index(sourceId: string): FixtureIndex | null {
    if (this.indexes.has(sourceId)) return this.indexes.get(sourceId)!;
    const file = path.join(this.fixturesDir(sourceId), 'index.json');
    const idx = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as FixtureIndex) : null;
    this.indexes.set(sourceId, idx);
    return idx;
  }

  readonly transport: Transport = async (req): Promise<TransportResponse> => {
    const run = Math.max(1, this.runNumber(req.sourceId));
    this.requests.push({ sourceId: req.sourceId, url: req.url, run });
    const step = this.opts.scenario?.find(
      (s) => s.source === req.sourceId && run >= s.fromRun && (s.toRun == null || run <= s.toRun) && (!s.urlIncludes || req.url.includes(s.urlIncludes)),
    );
    const effect = step?.effect;

    if (effect?.hang) {
      await new Promise<never>((_, reject) => {
        const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (req.signal.aborted) fail();
        req.signal.addEventListener('abort', fail, { once: true });
      });
    }
    if (effect?.networkError) throw new Error('fixture scenario: simulated network failure (ECONNRESET)');
    if (effect?.status) {
      return { status: effect.status, headers: effect.headers ?? {}, body: Buffer.from(effect.body ?? `fixture scenario: simulated HTTP ${effect.status}`) };
    }

    const idx = this.index(req.sourceId);
    if (!idx) return { status: 404, headers: {}, body: Buffer.from(`no fixtures for source ${req.sourceId}`) };
    const routes = [...(this.opts.extraRoutes?.[req.sourceId] ?? []), ...idx.routes];
    const route = routes.find((r) => (r.regex ? new RegExp(r.regex).test(req.url) : r.match ? req.url.includes(r.match) : false));
    if (!route) return { status: 404, headers: {}, body: Buffer.from(`no fixture route matches ${req.url}`) };

    const headers: Record<string, string> = { 'content-type': route.contentType ?? guessType(route.file ?? ''), ...(route.headers ?? {}) };
    const variantFile = effect?.variant ? route.variants?.[effect.variant] : undefined;
    // Routes without the requested variant answer with their canonical file.
    // Validators only apply to the canonical file – variants simulate changed upstream content.
    if (!variantFile) {
      if (route.etag) headers['etag'] = route.etag;
      if (route.lastModified) headers['last-modified'] = route.lastModified;
      if (route.etag && req.headers['if-none-match'] === route.etag) return { status: 304, headers, body: Buffer.alloc(0) };
      if (route.lastModified && req.headers['if-modified-since'] === route.lastModified) return { status: 304, headers, body: Buffer.alloc(0) };
    }

    let body: Buffer;
    if (route.generator && !variantFile) {
      const gen = this.opts.generators?.[route.generator];
      if (!gen) return { status: 500, headers: {}, body: Buffer.from(`unknown fixture generator ${route.generator}`) };
      const gkey = `${route.generator}:${JSON.stringify(route.generatorParams ?? {})}`;
      let cached = this.generated.get(gkey);
      if (!cached) {
        const out = gen(route.generatorParams ?? {}, req);
        cached = typeof out === 'string' ? Buffer.from(out) : out;
        this.generated.set(gkey, cached);
      }
      body = cached;
    } else {
      const file = path.join(this.fixturesDir(req.sourceId), variantFile ?? route.file ?? '');
      if (!existsSync(file)) return { status: 500, headers: {}, body: Buffer.from(`fixture file missing: ${file}`) };
      body = readFileSync(file);
    }
    return { status: route.status ?? 200, headers, body };
  };
}

function guessType(file: string): string {
  if (/\.(geo)?json$/i.test(file)) return 'application/json';
  if (/\.(xml|rss|atom|kml)$/i.test(file)) return 'application/xml';
  if (/\.csv$/i.test(file)) return 'text/csv';
  if (/\.zip$/i.test(file)) return 'application/zip';
  return 'text/plain';
}
