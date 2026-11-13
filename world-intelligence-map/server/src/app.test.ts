/**
 * Integration tests on the real application in fixture mode: every registered adapter runs its real fetch + parse
 * against its bundled fixtures, through the real pipeline, into a real (in-memory) database, queried through the real
 * HTTP API. Also covers the scripted failure scenario and the high-volume (50,000+ records) case.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADAPTERS } from './adapters/registry.ts';
import { buildServer } from './api/server.ts';
import { createApp, type App } from './app.ts';
import { loadConfig } from './config.ts';
import { ManualClock } from './core/clock.ts';
import { FIXTURE_EPOCH } from './core/fixtureEpoch.ts';
import { repoRoot } from './core/paths.ts';
import { DOMAINS } from './core/types.ts';

const HOUR = 3_600_000;

function fixtureApp(opts: { volume: number; scenario: boolean }) {
  const clock = new ManualClock(FIXTURE_EPOCH);
  const config = loadConfig([`--mode=fixture`, `--volume=${opts.volume}`, `--scenario=${opts.scenario ? 'on' : 'off'}`, '--quiet'], {});
  const app = createApp(config, { clock, log: () => {}, httpPolicy: { timeoutMs: 150 }, sleep: async () => {} });
  return { app, clock };
}

describe('breadth requirements', () => {
  it('registers enough real sources, layers and domains', () => {
    const layers = ADAPTERS.flatMap((a) => a.manifest.layers);
    const domains = new Set(layers.map((l) => l.domain));
    const noCredentials = ADAPTERS.filter((a) => a.manifest.auth.envVars.every((v) => !v.required));
    expect(ADAPTERS.length).toBeGreaterThanOrEqual(12);
    expect(layers.length).toBeGreaterThanOrEqual(20);
    expect(domains.size).toBeGreaterThanOrEqual(7);
    expect(noCredentials.length).toBeGreaterThanOrEqual(8);
    // current inventory – update deliberately when sources are added or removed
    expect({ sources: ADAPTERS.length, layers: layers.length, domains: domains.size, keyless: noCredentials.length }).toEqual({ sources: 40, layers: 80, domains: 10, keyless: 34 });
    expect([...domains].sort()).toEqual(DOMAINS.map((d) => d.id).sort());
    expect(new Set(layers.map((l) => l.id)).size).toBe(layers.length);
  });

  it('documents every credential and switch in .env.example without containing a secret', () => {
    const example = readFileSync(path.join(repoRoot(), '.env.example'), 'utf8');
    for (const a of ADAPTERS) for (const v of a.manifest.auth.envVars) expect(example, `${v.name} (${a.manifest.id})`).toMatch(new RegExp(`^#? ?${v.name}=`, 'm'));
    for (const name of ['WIM_MODE', 'PORT', 'WIM_DB_FILE', 'WIM_DISABLED_SOURCES', 'WIM_ENABLED_SOURCES']) expect(example).toContain(name);
    // credential variables are present but empty
    for (const line of example.split('\n')) {
      const m = /^([A-Z_]*(KEY|TOKEN|PASSWORD|SECRET|IDENTIFIER|EMAIL|APPNAME|CLIENT_ID))=(.*)$/.exec(line);
      if (m) expect(m[3], m[1]).toBe('');
    }
  });

  it('opt-in sources stay off in live mode until enabled explicitly', async () => {
    const off = createApp(loadConfig(['--mode=live', '--db=:memory:', '--quiet'], {}), { transport: async () => ({ status: 500, headers: {}, body: Buffer.alloc(0) }), log: () => {} });
    expect(off.pipeline.isEnabled('opensky')).toBe(false);
    expect(off.pipeline.isEnabled('acled')).toBe(false);
    expect(off.pipeline.isEnabled('usgs-earthquakes')).toBe(true);
    expect(off.health().get('opensky')).toMatchObject({ status: 'disabled' });
    expect(off.health().get('opensky')!.message).toMatch(/WIM_ENABLED_SOURCES/);
    expect((await off.pipeline.runSource('opensky')).outcome).toBe('disabled');
    await off.close();
    const on = createApp(loadConfig(['--mode=live', '--db=:memory:', '--quiet'], { WIM_ENABLED_SOURCES: 'opensky', WIM_DISABLED_SOURCES: 'usgs-earthquakes' }), { transport: async () => ({ status: 500, headers: {}, body: Buffer.alloc(0) }), log: () => {} });
    expect(on.pipeline.isEnabled('opensky')).toBe(true);
    expect(on.pipeline.isEnabled('usgs-earthquakes')).toBe(false);
    // live mode never falls back to fixtures: with upstream failing there is simply no data, and the source says why
    expect((await on.pipeline.runSource('emsc-earthquakes')).outcome).toBe('failed');
    expect(on.store.count()).toBe(0);
    expect(on.health().get('emsc-earthquakes')).toMatchObject({ status: 'unavailable', lastSuccessAt: null });
    expect(on.health().get('emsc-earthquakes')!.message).toMatch(/No data has been fetched yet/);
    await on.close();
  });
});

describe('fixture mode: API and database integration at high volume', () => {
  let app: App;
  let server: FastifyInstance;
  let ingestMs = 0;
  const get = async (url: string) => {
    const res = await server.inject({ method: 'GET', url });
    return { status: res.statusCode, body: res.json() as any, headers: res.headers };
  };
  const allLayers = () => [...app.catalog.layers.keys()].join(',');

  beforeAll(async () => {
    ({ app } = fixtureApp({ volume: 50_000, scenario: false }));
    const t0 = performance.now();
    const results = await app.scheduler.runAllOnce();
    ingestMs = performance.now() - t0;
    const bad = results.filter((r) => r.outcome !== 'ok');
    expect(bad.map((r) => `${r.sourceId}: ${r.outcome} ${r.error ?? ''} ${r.rejected[0]?.reason ?? ''}`)).toEqual([]);
    server = await buildServer(app, { webRoot: '/nonexistent' });
  }, 120_000);
  afterAll(async () => {
    await server?.close();
    await app?.close();
  });

  it('ingests every source through its real adapter and holds more than 50,000 records', async () => {
    const { body } = await get('/api/sources');
    expect(body.fixture).toBe(true);
    expect(body.sources).toHaveLength(ADAPTERS.length);
    expect(body.totalRecords).toBeGreaterThan(60_000);
    for (const s of body.sources) {
      expect(s.health.status, s.manifest.id).toBe('healthy');
      expect(s.records, s.manifest.id).toBeGreaterThan(0);
      for (const l of s.manifest.layers) expect(s.layerRecords[l.id], `${s.manifest.id}/${l.id}`).toBeGreaterThan(0);
      // complete manifest is exposed for the source inventory UI
      for (const k of ['provider', 'dataset', 'documentationUrl', 'coverage', 'updateCadence', 'auth', 'attribution', 'license', 'limitations', 'confidenceNotes', 'retention']) expect(s.manifest[k]).toBeTruthy();
    }
    expect(app.store.count("layer_id = 'active-fires'")).toBe(50_000);
    expect(app.store.count('is_fixture = 0')).toBe(0);
    console.log(`[volume] fixture ingestion of ${body.totalRecords} records from ${ADAPTERS.length} sources: ${Math.round(ingestMs)} ms`);
  });

  it('labels everything as fixture data', async () => {
    const meta = (await get('/api/meta')).body;
    expect(meta).toMatchObject({ mode: 'fixture', fixture: true, fixtureEpoch: FIXTURE_EPOCH });
    expect(meta.fixtureNotice).toMatch(/FIXTURE DATA/);
    expect(meta.layers).toHaveLength(80);
    const rec = (await get('/api/records/usgs-earthquakes:aka2026whmgzn')).body;
    expect(rec.fixture).toBe(true);
    expect(rec.record.provenance.fixture).toBe(true);
  });

  it('answers whole-world and viewport queries over 60k+ records quickly, with server-side aggregation', async () => {
    const timed = async (url: string) => {
      const t0 = performance.now();
      const r = await get(url);
      return { ...r, ms: performance.now() - t0 };
    };
    const world = await timed(`/api/features?layers=${allLayers()}&bbox=-180,-85,180,85&z=1.5&window=604800`);
    expect(world.status).toBe(200);
    expect(world.body.total).toBeGreaterThan(55_000);
    // never thousands of raw markers: clusters and density cells instead
    expect(world.body.points.features.length).toBeLessThan(1500);
    expect(world.body.density.features.length).toBeLessThan(6000);
    expect(world.body.clustered).toBe(true);
    const clusteredTotal = world.body.points.features.reduce((n: number, f: any) => n + (f.properties.n ?? 1), 0);
    expect(clusteredTotal).toBeGreaterThan(3000);
    expect(world.ms).toBeLessThan(2500);

    const fires = await timed('/api/features?layers=active-fires&bbox=10,-20,40,5&z=4&window=604800');
    expect(fires.body.counts['active-fires']).toBeGreaterThan(5000);
    expect(fires.body.points.features).toHaveLength(0);
    expect(fires.ms).toBeLessThan(800);

    const city = await timed(`/api/features?layers=${allLayers()}&bbox=20,-10,23,-7&z=8&window=604800`);
    expect(city.body.total).toBeGreaterThan(0);
    expect(city.body.total).toBeLessThan(world.body.total / 10); // the client never downloads the whole database
    expect(city.ms).toBeLessThan(400);
    console.log(`[volume] features: world z1.5 ${world.ms.toFixed(0)} ms (${world.body.total} records → ${world.body.points.features.length} points/clusters + ${world.body.density.features.length} density cells), regional heat map ${fires.ms.toFixed(0)} ms, z8 viewport ${city.ms.toFixed(0)} ms`);
  });

  it('all layers off returns nothing anywhere', async () => {
    const f = (await get('/api/features?layers=&bbox=-180,-85,180,85&z=2')).body;
    expect(f.total).toBe(0);
    expect(f.points.features.concat(f.areas.features, f.lines.features, f.density.features)).toHaveLength(0);
    expect((await get('/api/list?layers=')).body).toMatchObject({ items: [], total: 0 });
    expect((await get('/api/list?layers=&q=earthquake')).body.total).toBe(0);
    expect((await get('/api/choropleth?layers=')).body.layers).toEqual({});
  });

  it('isolates layers: results only ever contain the requested layers', async () => {
    const f = (await get('/api/features?layers=earthquakes,nws-warnings&bbox=-180,-85,180,85&z=3&window=2592000')).body;
    expect(Object.keys(f.counts).sort()).toEqual(['earthquakes', 'nws-warnings']);
    for (const feat of [...f.points.features, ...f.areas.features]) {
      expect(['earthquakes', 'nws-warnings']).toContain(feat.properties.l);
      if (feat.properties.ls) for (const part of String(feat.properties.ls).split(',')) expect(part).toMatch(/^(earthquakes|nws-warnings):/);
    }
    const list = (await get('/api/list?layers=earthquakes&q=alaska&window=2592000')).body;
    expect(list.total).toBeGreaterThan(0);
    expect(list.items.every((i: any) => i.layerId === 'earthquakes')).toBe(true);
    // the same word exists in other layers, which stay invisible while disabled
    const wider = (await get(`/api/list?layers=${allLayers()}&q=alaska&window=2592000`)).body;
    expect(wider.total).toBeGreaterThan(list.total);
  });

  it('serves choropleth values, lists, histogram and record details with provenance', async () => {
    const ch = (await get('/api/choropleth?layers=wb-population,hapi-idps')).body.layers;
    expect(Object.keys(ch['wb-population'].values).length).toBeGreaterThan(180);
    expect(ch['wb-population'].values.IND.v).toBeGreaterThan(1.4e9);
    expect(Object.keys(ch['hapi-idps'].values).length).toBeGreaterThan(5);

    const list = (await get('/api/list?layers=earthquakes,emsc-earthquakes&sort=severity&limit=5&window=2592000')).body;
    expect(list.items).toHaveLength(5);
    expect(list.items[0].severity).toBeGreaterThanOrEqual(list.items[4].severity);

    const hist = (await get('/api/histogram?layers=earthquakes&window=604800&buckets=7')).body;
    expect(hist.counts).toHaveLength(7);
    expect(hist.total).toBe(hist.counts.reduce((a: number, b: number) => a + b, 0));
    expect(hist.total).toBeGreaterThan(20);

    const rec = (await get(`/api/records/${encodeURIComponent(list.items[0].id)}`)).body;
    expect(rec.record.id).toBe(list.items[0].id);
    for (const k of ['occurredAt', 'fetchedAt', 'updatedAt', 'severity', 'attributes', 'url', 'attribution', 'licenseUrl', 'freshness']) expect(rec.record).toHaveProperty(k);
    expect(rec.record.provenance.fetchUrls[0]).toMatch(/^https?:\/\//);
    expect(rec.source.license.url).toMatch(/^https:\/\//);
    expect(rec.source.documentationUrl).toMatch(/^https:\/\//);
    expect(rec.sourceHealth.status).toBe('healthy');
  });

  it('correlates independent reports of the same earthquake across USGS, EMSC and GDACS', async () => {
    const n = app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM incidents WHERE class = 'earthquake' AND source_count >= 2")!.n;
    expect(n).toBeGreaterThan(3);
    const m = app.db.get<{ record_id: string }>("SELECT record_id FROM incident_members WHERE incident_id IN (SELECT incident_id FROM incidents WHERE class = 'earthquake') AND record_id LIKE 'usgs-earthquakes:%' LIMIT 1")!;
    const rec = (await get(`/api/records/${encodeURIComponent(m.record_id)}`)).body.record;
    expect(rec.incident.members.length).toBeGreaterThan(0);
    expect(rec.incident.members.every((x: any) => x.sourceId !== 'usgs-earthquakes' || x.id !== rec.id)).toBe(true);
    expect(rec.incident.note).toMatch(/inference by this application/);
  });

  it('validates parameters and never exposes a URL proxy', async () => {
    for (const bad of ['/api/features?layers=a&bbox=1,2,3', '/api/features?layers=a&z=99', '/api/features?layers=DROP%20TABLE', '/api/list?layers=a&sev=9-1', '/api/list?layers=a&from=2026-01-01', '/api/list?layers=a&fresh=bogus', '/api/list?layers=a&sort=random', `/api/list?layers=a&q=${'x'.repeat(200)}`, '/api/histogram?layers=a&hfrom=5000000000000&hto=1']) {
      const r = await get(bad);
      expect(r.status, bad).toBe(400);
      expect(r.body.error).toBe('bad_request');
    }
    expect((await get('/api/records/nope')).status).toBe(404);
    expect((await get('/api/sources/nope')).status).toBe(404);
    for (const p of ['/api/proxy?url=https://example.org', '/api/fetch?url=https://example.org', '/proxy/https://example.org']) expect((await get(p)).status).toBe(404);
    const res = await server.inject({ method: 'GET', url: '/api/meta' });
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('never leaks credentials or environment values through the API', async () => {
    const dump = JSON.stringify([(await get('/api/sources')).body, (await get('/api/meta')).body, (await get('/api/sources/nasa-firms')).body]);
    for (const v of Object.values(app.env)) if (v) expect(dump).not.toContain(v);
    expect(dump).toContain('FIRMS_MAP_KEY'); // the variable NAME is documented, its value is not
    const fire = app.db.get<{ id: string }>("SELECT id FROM records WHERE layer_id = 'active-fires' LIMIT 1")!;
    const rec = (await get(`/api/records/${encodeURIComponent(fire.id)}`)).body;
    expect(JSON.stringify(rec)).toContain('/api/area/csv/REDACTED/');
  });

  it('serves the offline basemap assets', async () => {
    const c = await server.inject({ method: 'GET', url: '/basemap/countries.geojson' });
    expect(c.statusCode).toBe(200);
    expect(c.json().features.length).toBeGreaterThan(200);
    const g = await server.inject({ method: 'GET', url: '/glyphs/Noto%20Sans%20Regular/0-255.pbf' });
    expect(g.statusCode).toBe(200);
    expect(g.rawPayload.length).toBeGreaterThan(10_000);
    expect((await server.inject({ method: 'GET', url: '/glyphs/x/..%2F..%2Fetc%2Fpasswd' })).statusCode).toBe(400);
  });

  it('re-ingesting every source is idempotent', async () => {
    const before = app.store.count();
    const hashes = app.db.get<{ h: number }>('SELECT SUM(revision) AS h FROM records WHERE source_id NOT IN (\'celestrak\')')!.h;
    const results = await app.scheduler.runAllOnce();
    expect(results.filter((r) => r.outcome !== 'ok').map((r) => r.sourceId)).toEqual([]);
    expect(results.filter((r) => r.sourceId !== 'celestrak').reduce((n, r) => n + r.inserted + r.updated + r.ended, 0)).toBe(0);
    expect(app.store.count()).toBe(before);
    expect(app.db.get<{ h: number }>('SELECT SUM(revision) AS h FROM records WHERE source_id NOT IN (\'celestrak\')')!.h).toBe(hashes);
  }, 60_000);
});

describe('fixture mode: scripted outage, rate-limit, malformed-payload, stale-data and recovery scenario', () => {
  let app: App;
  let clock: ManualClock;
  const status = (id: string) => app.health().get(id)!;
  const run = (id: string) => app.pipeline.runSource(id);

  beforeAll(async () => {
    ({ app, clock } = fixtureApp({ volume: 0, scenario: true }));
    await app.prepareDemo();
  }, 60_000);
  afterAll(async () => app?.close());

  it('stale data: a source last fetched in an earlier session is flagged until it is refreshed', async () => {
    const h = status('noaa-nhc');
    expect(h).toMatchObject({ status: 'stale', dataIsStale: true, lastSuccessAt: FIXTURE_EPOCH - 6 * HOUR });
    expect(h.message).toMatch(/No successful refresh for 6 h/);
    const ctx = app.queryContext();
    const storms = app.query.list({ layers: ['nhc-active-storms'], time: { mode: 'live', windowMs: 86_400_000 } }, ctx);
    expect(storms.total).toBeGreaterThan(0);
    expect(storms.items.every((i) => i.freshness === 'stale')).toBe(true);
    const f = app.query.features({ layers: ['nhc-active-storms'], time: { mode: 'live', windowMs: 86_400_000 } }, 3, ctx);
    expect(f.points.features.every((x) => (x.properties as { f: number }).f === 3)).toBe(true); // rendered dimmed, never as live
    // recovery
    expect((await run('noaa-nhc')).outcome).toBe('ok');
    expect(status('noaa-nhc')).toMatchObject({ status: 'healthy', dataIsStale: false });
    expect(app.query.list({ layers: ['nhc-active-storms'], time: { mode: 'live', windowMs: 86_400_000 } }, app.queryContext()).items.every((i) => i.freshness === 'fresh')).toBe(true);
  });

  it('missing optional credentials: reported with setup instructions while everything else works', async () => {
    expect((await run('cloudflare-radar')).outcome).toBe('misconfigured');
    const h = status('cloudflare-radar');
    expect(h.status).toBe('misconfigured');
    expect(h.missingEnv).toEqual(['CLOUDFLARE_API_TOKEN']);
    expect(h.message.length).toBeGreaterThan(60);
    expect(app.fixtureTransport!.requests.filter((r) => r.sourceId === 'cloudflare-radar')).toHaveLength(0);
  });

  it('outage and recovery: HTTP 503 for two runs keeps the data, then recovers', async () => {
    expect((await run('emsc-earthquakes')).outcome).toBe('ok');
    const n = app.store.count("source_id = 'emsc-earthquakes'");
    for (const expected of ['delayed', 'delayed']) {
      clock.advance(20_000);
      expect((await run('emsc-earthquakes')).outcome).toBe('failed');
      expect(status('emsc-earthquakes').status).toBe(expected);
      expect(app.store.count("source_id = 'emsc-earthquakes'")).toBe(n);
    }
    clock.advance(20_000);
    expect((await run('emsc-earthquakes')).outcome).toBe('ok');
    expect(status('emsc-earthquakes')).toMatchObject({ status: 'healthy', consecutiveFailures: 0 });
  });

  it('rate limiting: 429 with Retry-After pauses the source, then it recovers', async () => {
    expect((await run('nasa-eonet')).outcome).toBe('ok');
    clock.advance(20_000);
    const limited = await run('nasa-eonet');
    expect(limited.outcome).toBe('rate_limited');
    expect(status('nasa-eonet')).toMatchObject({ status: 'rate_limited', rateLimitedUntil: clock.now() + 45_000 });
    const calls = app.fixtureTransport!.requests.filter((r) => r.sourceId === 'nasa-eonet').length;
    clock.advance(20_000);
    await run('nasa-eonet'); // too early: must not contact upstream
    expect(app.fixtureTransport!.requests.filter((r) => r.sourceId === 'nasa-eonet').length).toBe(calls);
    clock.advance(30_000);
    expect((await run('nasa-eonet')).outcome).toBe('ok');
    expect(status('nasa-eonet').status).toBe('healthy');
  });

  it('malformed records: rejected individually, valid ones ingested, source stays up', async () => {
    expect((await run('usgs-earthquakes')).outcome).toBe('ok');
    clock.advance(20_000);
    const second = await run('usgs-earthquakes'); // unchanged upstream → 304 Not Modified
    expect(second).toMatchObject({ outcome: 'ok', inserted: 0, updated: 0 });
    clock.advance(20_000);
    const third = await run('usgs-earthquakes');
    expect(third.outcome).toBe('partial');
    expect(third.rejected).toHaveLength(6);
    expect(third.inserted).toBe(2);
    expect(status('usgs-earthquakes')).toMatchObject({ status: 'healthy' });
    expect(status('usgs-earthquakes').lastCounts).toMatchObject({ rejected: 6 });
    // hostile text from the malformed payload is stored sanitised
    const hostile = app.query.record('usgs-earthquakes:ok0002', app.queryContext())!;
    expect(hostile.title).toBe('M 2.7 - 5 km NE of Sanitised');
    expect(hostile.url).toBeNull();
    clock.advance(20_000);
    expect((await run('usgs-earthquakes')).outcome).toBe('ok');
  });

  it('timeout: a hanging upstream is abandoned and the source recovers on the next run', async () => {
    expect((await run('aviation-sigmet')).outcome).toBe('ok');
    clock.advance(20_000);
    const hung = await run('aviation-sigmet');
    expect(hung.outcome).toBe('failed');
    expect(status('aviation-sigmet').lastError).toMatch(/timeout|cached/);
    clock.advance(20_000);
    expect((await run('aviation-sigmet')).outcome).toBe('ok');
  });

  it('live updates: clients are told over server-sent events when a source ingests', async () => {
    const server = await buildServer(app, { webRoot: '/nonexistent' });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address() as { port: number };
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${address.port}/api/stream`, { signal: ac.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const until = async (needle: string) => {
      const deadline = Date.now() + 5000;
      while (!buffer.includes(needle) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      return buffer.includes(needle);
    };
    expect(await until('event: hello')).toBe(true);
    clock.advance(20_000);
    await run('jpl-fireballs');
    expect(await until('event: ingest')).toBe(true);
    const frame = buffer.slice(buffer.indexOf('event: ingest'));
    const data = JSON.parse(/data: (.*)/.exec(frame)![1]!);
    expect(data).toMatchObject({ type: 'ingest', sourceId: 'jpl-fireballs', outcome: 'ok', status: 'healthy' });
    expect(data.layers).toEqual(['fireballs']);
    ac.abort();
    await server.close();
  });

  it('circuit breaker: repeated network failures open it, calls stop, and it closes again after recovery', async () => {
    expect((await run('gdacs')).outcome).toBe('ok');
    const n = app.store.count("source_id = 'gdacs'");
    const seen = new Set<string>();
    let opened = false;
    for (let i = 0; i < 6; i++) {
      clock.advance(20_000);
      const r = await run('gdacs');
      expect(['failed', 'circuit_open']).toContain(r.outcome);
      seen.add(status('gdacs').status);
      opened ||= app.http.breaker('gdacs').state === 'open';
    }
    expect(opened).toBe(true);
    expect(seen.has('unavailable')).toBe(true);
    expect(status('gdacs').message).toMatch(/circuit breaker open/);
    expect(app.store.count("source_id = 'gdacs'")).toBe(n); // cached data preserved throughout
    // other sources were never affected
    expect(status('usgs-earthquakes').status).toBe('healthy');
    // recovery: after the cool-down a probe succeeds and the breaker closes
    let outcome = '';
    for (let i = 0; i < 8 && outcome !== 'ok'; i++) {
      clock.advance(10 * 60_000);
      outcome = (await run('gdacs')).outcome;
    }
    expect(outcome).toBe('ok');
    expect(app.http.breaker('gdacs').state).toBe('closed');
    expect(status('gdacs').status).toBe('healthy');
  }, 30_000);
});
