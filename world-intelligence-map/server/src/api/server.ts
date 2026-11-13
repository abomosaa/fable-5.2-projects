/**
 * HTTP API + static hosting.
 *
 *  GET  /api/meta                 mode, clock, domains, layer catalog
 *  GET  /api/sources              complete source inventory: manifests + health + record counts
 *  GET  /api/sources/:id          one source with its recent ingestion runs
 *  POST /api/sources/:id/refresh  ask the scheduler to fetch a source now (throttled)
 *  GET  /api/features             viewport query: clusters/points, polygons, lines, density cells
 *  GET  /api/choropleth           country values for indicator layers
 *  GET  /api/list                 sorted records for the results panel, search, alerts and cluster contents
 *  GET  /api/histogram            counts per time bucket for the timeline
 *  GET  /api/records/:id          full record with provenance and correlation links
 *  GET  /api/stream               server-sent events: ingest + health notifications
 *  GET  /basemap/countries.geojson, /glyphs/:fontstack/:range.pbf   offline basemap assets
 *
 * The browser only ever talks to this API. Upstream providers are contacted by the ingestion pipeline alone,
 * through per-source host allowlists – there is no URL-proxy endpoint.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import compress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { App } from '../app.ts';
import { allCountries } from '../core/countries.ts';
import { FIXTURE_EPOCH } from '../core/fixtureEpoch.ts';
import { assetPath, repoRoot } from '../core/paths.ts';
import { DOMAINS, SEVERITY_LABELS } from '../core/types.ts';
import type { IngestEvent } from '../ingest/pipeline.ts';
import { timeBounds } from '../store/queries.ts';
import { BadRequest, num, parseFilters, parseTimeValue, str } from './params.ts';

export const APP_VERSION = '1.0.0';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "child-src blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

export async function buildServer(app: App, opts: { webRoot?: string; logger?: boolean } = {}): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: opts.logger ?? false, routerOptions: { maxParamLength: 300 } });
  await fastify.register(compress, { global: true, threshold: 1024, encodings: ['br', 'gzip'], brotliOptions: { params: { 1: 4 } } });

  fastify.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });

  fastify.setErrorHandler((err, _req, reply) => {
    const e = err as Error & { statusCode?: number };
    if (err instanceof BadRequest || e.statusCode === 400) {
      void reply.code(400).send({ error: 'bad_request', message: e.message });
      return;
    }
    if (e.statusCode && e.statusCode < 500) {
      void reply.code(e.statusCode).send({ error: 'request_error', message: e.message });
      return;
    }
    fastify.log.error(err);
    void reply.code(500).send({ error: 'internal_error', message: 'The server could not complete this request.' });
  });

  // Small in-memory request limiter to keep one client from monopolising the database.
  const buckets = new Map<string, { tokens: number; at: number }>();
  const RATE = 40; // requests per second sustained
  const BURST = 160;
  fastify.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const key = req.ip;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { tokens: BURST, at: now }));
    b.tokens = Math.min(BURST, b.tokens + ((now - b.at) / 1000) * RATE);
    b.at = now;
    if (b.tokens < 1) {
      reply.header('Retry-After', '1');
      return reply.code(429).send({ error: 'rate_limited', message: 'Too many requests; slow down.' });
    }
    b.tokens -= 1;
    if (buckets.size > 5000) buckets.clear();
  });

  const fixture = app.config.mode === 'fixture';

  const layerPayload = () =>
    [...app.catalog.layers.values()].map((l) => ({
      id: l.id, name: l.name, description: l.description, domain: l.domain, category: l.category, sourceId: l.sourceId, geometry: l.geometry,
      timeModel: l.timeModel, render: l.render, metric: l.metric ?? null, freshForSec: l.freshForSec ?? null, liveMaxAgeSec: l.liveMaxAgeSec ?? null,
      retentionDays: l.retentionDays, defaultOn: l.defaultOn, correlationClass: l.correlationClass ?? null,
    }));

  fastify.get('/api/meta', async () => {
    const extent = app.query.timeExtent();
    return {
      app: 'world-intelligence-map',
      version: APP_VERSION,
      mode: app.config.mode,
      fixture,
      fixtureNotice: fixture
        ? 'FIXTURE DATA – bundled sample payloads replayed on a simulated clock. Nothing shown here is live intelligence.'
        : null,
      fixtureEpoch: fixture ? FIXTURE_EPOCH : null,
      now: app.clock.now(),
      clock: app.clock.kind,
      domains: DOMAINS,
      severityLabels: SEVERITY_LABELS,
      layers: layerPayload(),
      sourceCount: app.catalog.sources.size,
      timeExtent: extent,
      demoScenario: fixture && app.demo ? app.demo.steps.map((s) => ({ source: s.source, fromRun: s.fromRun, toRun: s.toRun ?? null, label: s.label ?? '' })) : [],
      countries: allCountries().map((c) => ({ iso3: c.iso3, name: c.name, label: c.label, bbox: c.bbox })),
    };
  });

  const sourcePayload = (id: string, inventory: ReturnType<typeof app.query.inventory>) => {
    const m = app.catalog.sources.get(id)!;
    const h = app.health().get(id)!;
    return {
      manifest: m,
      health: h,
      records: inventory.bySource[id] ?? 0,
      layerRecords: Object.fromEntries(m.layers.map((l) => [l.id, inventory.byLayer[l.id] ?? 0])),
      running: app.pipeline.isRunning(id),
      demoScenario: app.demo?.steps.find((s) => s.source === id)?.label ?? null,
    };
  };

  fastify.get('/api/sources', async () => {
    const inv = app.query.inventory();
    return { now: app.clock.now(), fixture, totalRecords: inv.total, sources: [...app.catalog.sources.keys()].map((id) => sourcePayload(id, inv)) };
  });

  fastify.get<{ Params: { id: string } }>('/api/sources/:id', async (req, reply) => {
    if (!app.catalog.sources.has(req.params.id)) return reply.code(404).send({ error: 'not_found', message: 'Unknown source.' });
    return { ...sourcePayload(req.params.id, app.query.inventory()), runs: app.store.recentRuns(req.params.id, 12) };
  });

  const lastManual = new Map<string, number>();
  fastify.post<{ Params: { id: string } }>('/api/sources/:id/refresh', async (req, reply) => {
    const id = req.params.id;
    if (!app.catalog.sources.has(id)) return reply.code(404).send({ error: 'not_found', message: 'Unknown source.' });
    const wall = Date.now();
    // Manual refreshes are throttled so this endpoint cannot be used to hammer an upstream provider.
    const minGap = fixture ? 3000 : Math.min(60_000, app.catalog.sources.get(id)!.updateCadence.pollIntervalSec * 1000);
    if (wall - (lastManual.get(id) ?? 0) < minGap) {
      reply.header('Retry-After', String(Math.ceil(minGap / 1000)));
      return reply.code(429).send({ error: 'rate_limited', message: 'This source was refreshed very recently.' });
    }
    lastManual.set(id, wall);
    void app.scheduler.runNow(id);
    return reply.code(202).send({ accepted: true });
  });

  fastify.get('/api/features', async (req) => {
    const q = req.query as Record<string, unknown>;
    const filters = parseFilters(q);
    const zoom = num(q, 'z', 0, 24) ?? 2;
    return app.query.features(filters, zoom, app.queryContext());
  });

  fastify.get('/api/choropleth', async (req) => {
    const filters = parseFilters(req.query as Record<string, unknown>);
    const ctx = app.queryContext();
    return { now: ctx.now, layers: app.query.choropleth(filters, ctx) };
  });

  fastify.get('/api/list', async (req) => {
    const q = req.query as Record<string, unknown>;
    const filters = parseFilters(q);
    const sort = str(q, 'sort');
    if (sort && sort !== 'time' && sort !== 'severity') throw new BadRequest('sort: expected time or severity');
    const ctx = app.queryContext();
    return {
      now: ctx.now,
      ...app.query.list(filters, ctx, { limit: num(q, 'limit', 1, 500), offset: num(q, 'offset', 0, 1_000_000), sort: (sort as 'time' | 'severity') ?? 'time', includeGlobal: str(q, 'global') !== '0' }),
    };
  });

  fastify.get('/api/histogram', async (req) => {
    const q = req.query as Record<string, unknown>;
    const filters = parseFilters(q);
    const ctx = app.queryContext();
    const hf = str(q, 'hfrom');
    const ht = str(q, 'hto');
    const b = timeBounds(filters.time, ctx.now);
    const from = hf ? parseTimeValue(hf, 'hfrom') : b.from;
    const to = ht ? parseTimeValue(ht, 'hto') : b.to;
    if (from >= to) throw new BadRequest('histogram range is empty');
    return { now: ctx.now, ...app.query.histogram(filters, ctx, from, to, num(q, 'buckets', 1, 240) ?? 60) };
  });

  fastify.get<{ Params: { id: string } }>('/api/records/:id', async (req, reply) => {
    const ctx = app.queryContext();
    const rec = app.query.record(req.params.id, ctx);
    if (!rec) return reply.code(404).send({ error: 'not_found', message: 'No such record (it may have been purged by retention).' });
    const m = app.catalog.sources.get(rec.sourceId);
    const layer = app.catalog.layer(rec.layerId);
    return {
      now: ctx.now,
      record: rec,
      layer: layer ? { id: layer.id, name: layer.name, domain: layer.domain, timeModel: layer.timeModel } : null,
      source: m
        ? {
            id: m.id, provider: m.provider, dataset: m.dataset, homepageUrl: m.homepageUrl, documentationUrl: m.documentationUrl, attribution: m.attribution,
            license: m.license, confidenceNotes: m.confidenceNotes, limitations: m.limitations, updateCadence: m.updateCadence,
          }
        : null,
      sourceHealth: ctx.health.get(rec.sourceId) ?? null,
      fixture: rec.provenance.fixture,
    };
  });

  // ── server-sent events ──
  const clients = new Set<FastifyReply>();
  const broadcast = (event: string, data: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) {
      try {
        c.raw.write(frame);
      } catch {
        clients.delete(c);
      }
    }
  };
  const onIngest = (e: IngestEvent) => broadcast('ingest', { ...e, status: app.health().get(e.sourceId)?.status });
  app.pipeline.on('ingest', onIngest);
  const heartbeat = setInterval(() => broadcast('heartbeat', { now: app.clock.now() }), 20_000);
  heartbeat.unref();
  fastify.addHook('onClose', async () => {
    clearInterval(heartbeat);
    app.pipeline.off('ingest', onIngest);
    for (const c of clients) c.raw.end();
    clients.clear();
  });

  fastify.get('/api/stream', (req, reply) => {
    if (clients.size >= 200) {
      void reply.code(503).send({ error: 'busy', message: 'Too many live connections.' });
      return;
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    reply.raw.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ now: app.clock.now(), mode: app.config.mode })}\n\n`);
    clients.add(reply);
    req.raw.on('close', () => clients.delete(reply));
  });

  // ── offline basemap assets ──
  const countriesFile = path.join(assetPath(), 'ne', 'countries.geojson');
  const countriesBody = readFileSync(countriesFile);
  fastify.get('/basemap/countries.geojson', async (_req, reply) => {
    reply.header('Content-Type', 'application/geo+json; charset=utf-8');
    reply.header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    return reply.send(countriesBody);
  });

  const glyphDir = path.join(assetPath(), 'glyphs');
  fastify.get<{ Params: { fontstack: string; range: string } }>('/glyphs/:fontstack/:range', async (req, reply) => {
    const m = /^(\d{1,6})-(\d{1,6})\.pbf$/.exec(req.params.range);
    if (!m) return reply.code(400).send({ error: 'bad_request', message: 'invalid glyph range' });
    reply.header('Content-Type', 'application/x-protobuf');
    reply.header('Cache-Control', 'public, max-age=604800, immutable');
    // One bundled font serves every requested font stack; ranges that are not bundled yield an empty glyph set.
    const file = path.join(glyphDir, 'Noto Sans Regular', `${m[1]}-${m[2]}.pbf`);
    return reply.send(existsSync(file) ? readFileSync(file) : Buffer.alloc(0));
  });

  fastify.get('/healthz', async () => ({ ok: true, mode: app.config.mode, now: app.clock.now() }));

  // ── static web client (production build) ──
  const webRoot = opts.webRoot ?? path.join(repoRoot(), 'web', 'dist');
  if (existsSync(path.join(webRoot, 'index.html'))) {
    await fastify.register(fastifyStatic, { root: webRoot, maxAge: '1h', immutable: false });
    const index = readFileSync(path.join(webRoot, 'index.html'));
    fastify.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !/\.[a-z0-9]{2,5}$/i.test(req.url.split('?')[0]!)) {
        return reply.header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(index);
      }
      return reply.code(404).send({ error: 'not_found', message: 'Not found.' });
    });
  } else {
    fastify.get('/', async (_req, reply) =>
      reply.header('Content-Type', 'text/plain; charset=utf-8').send('World Intelligence Map API is running. The web client has not been built yet: run `npm run build`.'),
    );
  }

  return fastify;
}
