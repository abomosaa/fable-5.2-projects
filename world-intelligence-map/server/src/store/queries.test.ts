import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecordDraft } from '../core/types.ts';
import { DAY, draft, HOUR, jsonAdapter, makeWorld, point, T0, testManifest, type TestWorld } from '../test/helpers.ts';
import { migrate, openDatabase } from './db.ts';
import { lonRanges, type QueryFilters } from './queries.ts';

const hz = testManifest('hz', [
  { id: 'quakes', timeModel: 'event', category: 'earthquake' },
  { id: 'storms', timeModel: 'interval', category: 'storm', geometry: 'polygon', render: { type: 'polygon', color: 'blue', shape: 'circle' } },
  { id: 'fires', timeModel: 'event', category: 'wildfire', render: { type: 'heatmap', color: 'red', shape: 'circle', heatmapBelowZoom: 6 } },
]);
const ref = testManifest('rf', [
  { id: 'airports', timeModel: 'reference', retentionDays: null, domain: 'transport', category: 'airport', render: { type: 'point', color: 'gray', shape: 'square', minZoom: 4 } },
  { id: 'cables', timeModel: 'reference', retentionDays: null, domain: 'infrastructure', category: 'cable', geometry: 'line', render: { type: 'line', color: 'blue', shape: 'circle' } },
]);
const stats = testManifest('st', [
  { id: 'pop', timeModel: 'indicator', domain: 'society', category: 'population', geometry: 'country', retentionDays: 4000, render: { type: 'choropleth', color: 'purple', shape: 'circle' }, metric: { name: 'Population', unit: 'people', scale: 'sequential', higherIs: 'neutral', transform: 'log' } },
]);
const live = testManifest('lv', [{ id: 'planes', timeModel: 'snapshot', liveMaxAgeSec: 600, retentionDays: 1, domain: 'transport', category: 'aircraft', render: { type: 'track', color: 'teal', shape: 'plane' } }]);
const news = testManifest('nw', [{ id: 'bulletins', timeModel: 'event', domain: 'cyber', category: 'advisory', geometry: 'global' }]);

let w: TestWorld;
const WEEK: QueryFilters['time'] = { mode: 'live', windowMs: 7 * DAY };
const f = (layers: string[], over: Partial<QueryFilters> = {}): QueryFilters => ({ layers, time: WEEK, ...over });
const ids = (layers: string[], over: Partial<QueryFilters> = {}) => w.query.list(f(layers, over), w.ctx(), { limit: 500 }).items.map((i) => i.id.split(':')[1]).sort();

beforeEach(async () => {
  w = makeWorld([hz, ref, stats, live, news].map(jsonAdapter));
  const q = (id: string, lon: number, lat: number, ageH: number, o: Partial<RecordDraft> = {}) => draft('quakes', { upstreamId: id, title: `Quake ${id}`, geometry: point(lon, lat), occurredAt: T0 - ageH * HOUR, ...o });
  w.net.json('hz.example.org', () => [
    q('tokyo', 139.7, 35.7, 2, { severity: 3, confidence: 0.95, confidenceBasis: 'reviewed', title: 'Quake near Tokyo' }),
    q('osaka', 135.5, 34.7, 30, { severity: 1, confidence: 0.7, confidenceBasis: 'automatic' }),
    q('lima', -77.0, -12.0, 80, { severity: 2 }),
    q('fiji', 179.5, -17.0, 5, { severity: 4, confidence: 0.4, confidenceBasis: 'automatic' }),
    q('samoa', -172.0, -13.8, 6, { severity: null }),
    q('old', 10, 10, 20 * 24),
    draft('storms', { upstreamId: 'cyclone', title: 'Cyclone warning area', geometry: { type: 'Polygon', coordinates: [[[120, 10], [130, 10], [130, 20], [120, 20], [120, 10]]] }, occurredAt: T0 - 2 * DAY, ongoing: true, severity: 3 }),
    draft('storms', { upstreamId: 'past-storm', title: 'Expired storm watch', geometry: { type: 'Polygon', coordinates: [[[-90, 25], [-85, 25], [-85, 30], [-90, 30], [-90, 25]]] }, occurredAt: T0 - 5 * DAY, expiresAt: T0 - 4 * DAY, severity: 2 }),
    ...Array.from({ length: 40 }, (_, i) => draft('fires', { upstreamId: `fire${i}`, title: `Fire ${i}`, geometry: point(20 + (i % 8) * 0.01, -8 + Math.floor(i / 8) * 0.01), occurredAt: T0 - 3 * HOUR })),
  ]);
  w.net.json('rf.example.org', () => [
    draft('airports', { upstreamId: 'hnd', title: 'Tokyo Haneda', geometry: point(139.78, 35.55), occurredAt: null }),
    draft('airports', { upstreamId: 'lim', title: 'Lima Jorge Chavez', geometry: point(-77.11, -12.02), occurredAt: null }),
    draft('cables', { upstreamId: 'tpc', title: 'Trans-Pacific cable', geometry: { type: 'LineString', coordinates: [[140, 35], [160, 40], [179, 42]] }, occurredAt: null }),
  ]);
  const pop = (c: string, year: number, v: number) => draft('pop', { upstreamId: `${c}-${year}`, title: `Population ${c} ${year}`, geometry: undefined, country: c, occurredAt: Date.UTC(year, 0, 1), metric: { name: 'Population', value: v, unit: 'people', period: String(year) } });
  w.net.json('st.example.org', () => [pop('JPN', 2023, 124.5e6), pop('JPN', 2024, 124.0e6), pop('JPN', 2025, 123.5e6), pop('PER', 2024, 34.0e6), pop('FJI', 2025, 0.93e6), pop('KEN', 2025, 57e6), pop('BRA', 2025, 212e6), pop('IND', 2025, 1450e6)]);
  w.net.json('lv.example.org', () => [
    draft('planes', { upstreamId: 'fresh1', title: 'JAL123', geometry: point(140, 36), occurredAt: T0 - 2 * 60_000 }),
    draft('planes', { upstreamId: 'old1', title: 'ANA456', geometry: point(141, 36), occurredAt: T0 - 45 * 60_000 }),
  ]);
  w.net.json('nw.example.org', () => [draft('bulletins', { upstreamId: 'cve1', title: 'CVE-2026-0001 exploited', geometry: undefined, geometryKind: 'global', occurredAt: T0 - DAY, severity: 4 })]);
  for (const id of ['hz', 'rf', 'st', 'lv', 'nw']) expect((await w.pipeline.runSource(id)).outcome).toBe('ok');
});
afterEach(() => w.close());

const ALL = ['quakes', 'storms', 'fires', 'airports', 'cables', 'pop', 'planes', 'bulletins'];

describe('layer isolation', () => {
  it('with all layers off, every query is empty', () => {
    const ctx = w.ctx();
    const feat = w.query.features(f([]), 3, ctx);
    expect(feat.total).toBe(0);
    expect([feat.points, feat.areas, feat.lines, feat.density].map((c) => c.features.length)).toEqual([0, 0, 0, 0]);
    expect(feat.counts).toEqual({});
    expect(w.query.list(f([]), ctx)).toEqual({ items: [], total: 0 });
    expect(w.query.list(f([], { q: 'Tokyo' }), ctx).total).toBe(0);
    expect(w.query.choropleth(f([]), ctx)).toEqual({});
    expect(w.query.histogram(f([]), ctx, T0 - 7 * DAY, T0, 7).total).toBe(0);
  });

  it('a disabled layer contributes nothing to features, clusters, counts, lists, search, alerts or the histogram', () => {
    const ctx = w.ctx();
    const both = w.query.features(f(['quakes', 'fires']), 8, ctx);
    const only = w.query.features(f(['quakes']), 8, ctx);
    expect(both.counts).toEqual({ quakes: 5, fires: 40 });
    expect(only.counts).toEqual({ quakes: 5 });
    expect(only.total).toBe(5);
    for (const fc of [only.points, only.areas, only.lines, only.density]) {
      for (const feat of fc.features) {
        const p = feat.properties as { l: string; ls?: string };
        expect(p.l).toBe('quakes');
        if (p.ls) expect(p.ls.split(',').every((x) => x.startsWith('quakes:'))).toBe(true);
      }
    }
    // clusters are built from enabled layers only: airports sit next to the Tokyo quake but are not counted
    const z2 = w.query.features(f(['quakes']), 2, ctx);
    expect(z2.points.features.reduce((n, x) => n + ((x.properties as { n?: number }).n ?? 1), 0)).toBe(5);
    // search and severity-sorted "alerts" see enabled layers only
    expect(ids(['quakes'], { q: 'tokyo' })).toEqual(['tokyo']);
    expect(ids(['airports'], { q: 'tokyo' })).toEqual(['hnd']);
    expect(ids(['quakes', 'airports'], { q: 'tokyo' })).toEqual(['hnd', 'tokyo']);
    expect(ids(['storms'], { q: 'tokyo' })).toEqual([]);
    const alerts = w.query.list(f(['quakes'], { severityMin: 3, severityUnknown: false }), ctx, { sort: 'severity' });
    expect(alerts.items.map((i) => i.title)).toEqual(['Quake fiji', 'Quake near Tokyo']);
    expect(w.query.histogram(f(['quakes']), ctx, T0 - 7 * DAY, T0, 7).total).toBe(5);
    expect(w.query.histogram(f(['fires']), ctx, T0 - 7 * DAY, T0, 7).total).toBe(40);
  });

  it('ignores unknown layer ids', () => {
    expect(w.query.features(f(['nope', 'quakes', 'quakes']), 3, w.ctx()).counts).toEqual({ quakes: 5 });
  });
});

describe('spatial queries', () => {
  it('returns only records intersecting the bounding box', () => {
    expect(ids(['quakes'], { bbox: [130, 30, 145, 40] })).toEqual(['osaka', 'tokyo']);
    expect(ids(['quakes'], { bbox: [-80, -15, -70, -10] })).toEqual(['lima']);
    expect(ids(['quakes'], { bbox: [0, 60, 10, 70] })).toEqual([]);
    // polygons and lines match when their bounding box intersects the viewport
    expect(ids(['storms', 'cables'], { bbox: [125, 15, 126, 16] })).toEqual(['cyclone']);
    expect(ids(['cables'], { bbox: [150, 30, 170, 45] })).toEqual(['tpc']);
  });

  it('handles viewports that cross the antimeridian or wrap the world', () => {
    expect(ids(['quakes'], { bbox: [170, -25, 190, -10] })).toEqual(['fiji', 'samoa']); // 170°E … 170°W
    expect(ids(['quakes'], { bbox: [170, -25, -170, -10] })).toEqual(['fiji', 'samoa']);
    expect(ids(['quakes'], { bbox: [-190, -25, -165, -10] })).toEqual(['fiji', 'samoa']);
    expect(ids(['quakes'], { bbox: [-400, -85, 400, 85] }).length).toBe(5);
    expect(lonRanges([170, 0, 190, 0])).toEqual([[170, 180], [-180, -170]]);
    expect(lonRanges([-200, 0, 200, 0])).toBeNull();
    expect(lonRanges([10, 0, 20, 0])).toEqual([[10, 20]]);
  });

  it('keeps non-geographic bulletins in lists but never on the map', () => {
    const ctx = w.ctx();
    const feat = w.query.features(f(['bulletins']), 3, ctx);
    expect(feat.counts).toEqual({ bulletins: 1 });
    expect(feat.points.features).toHaveLength(0);
    expect(w.query.list(f(['bulletins'], { bbox: [0, 0, 10, 10] }), ctx).total).toBe(1);
    expect(w.query.list(f(['bulletins'], { bbox: [0, 0, 10, 10] }), ctx, { includeGlobal: false }).total).toBe(0);
  });
});

describe('temporal queries', () => {
  it('live mode shows the look-back window ending now', () => {
    expect(ids(['quakes'], { time: { mode: 'live', windowMs: 5.5 * HOUR } })).toEqual(['fiji', 'tokyo']);
    expect(ids(['quakes'], { time: { mode: 'live', windowMs: 6 * HOUR } })).toEqual(['fiji', 'samoa', 'tokyo']); // window edges are inclusive
    expect(ids(['quakes'], { time: { mode: 'live', windowMs: 2 * DAY } })).toEqual(['fiji', 'osaka', 'samoa', 'tokyo']);
    expect(ids(['quakes'], { time: { mode: 'live', windowMs: 30 * DAY } })).toEqual(['fiji', 'lima', 'old', 'osaka', 'samoa', 'tokyo']);
  });

  it('range mode returns what happened inside the range, inclusive of its ends', () => {
    expect(ids(['quakes'], { time: { mode: 'range', from: T0 - 40 * HOUR, to: T0 - 20 * HOUR } })).toEqual(['osaka']);
    expect(ids(['quakes'], { time: { mode: 'range', from: T0 - 30 * HOUR, to: T0 - 30 * HOUR } })).toEqual(['osaka']);
    expect(ids(['quakes'], { time: { mode: 'range', from: T0 - 21 * DAY, to: T0 - 19 * DAY } })).toEqual(['old']);
    expect(ids(['quakes'], { time: { mode: 'range', from: T0 + HOUR, to: T0 + DAY } })).toEqual([]);
  });

  it('interval records match while their active period overlaps the window; ongoing ones extend to the present', () => {
    expect(ids(['storms'], { time: { mode: 'live', windowMs: HOUR } })).toEqual(['cyclone']);
    expect(ids(['storms'], { time: { mode: 'range', from: T0 - 5 * DAY + HOUR, to: T0 - 4 * DAY - HOUR } })).toEqual(['past-storm']);
    expect(ids(['storms'], { time: { mode: 'range', from: T0 - 3 * DAY, to: T0 - 2.5 * DAY } })).toEqual([]);
    expect(ids(['storms'], { time: { mode: 'range', from: T0 - 10 * DAY, to: T0 } })).toEqual(['cyclone', 'past-storm']);
  });

  it('reference data is timeless and always visible', () => {
    expect(ids(['airports'], { time: { mode: 'range', from: 0, to: 1000 } })).toEqual(['hnd', 'lim']);
    expect(w.query.record('rf:hnd', w.ctx())!.freshness).toBe('reference');
  });

  it('snapshot layers hide observations older than liveMaxAge in live mode but keep them for history', () => {
    expect(ids(['planes'], { time: { mode: 'live', windowMs: DAY } })).toEqual(['fresh1']);
    expect(ids(['planes'], { time: { mode: 'range', from: T0 - HOUR, to: T0 } })).toEqual(['fresh1', 'old1']);
  });

  it('indicators show the latest value at or before the end of the window', () => {
    const at = (to: number) => w.query.choropleth(f(['pop'], { time: { mode: 'range', from: to - DAY, to } }), w.ctx()).pop!;
    expect(at(T0).values.JPN).toMatchObject({ v: 123.5e6, p: '2025' });
    expect(at(Date.UTC(2024, 5, 1)).values.JPN).toMatchObject({ v: 124.0e6, p: '2024' });
    expect(at(Date.UTC(2023, 5, 1)).values.JPN).toMatchObject({ v: 124.5e6, p: '2023' });
    expect(at(Date.UTC(2022, 5, 1)).values.JPN).toBeUndefined();
    expect(Object.keys(at(Date.UTC(2024, 5, 1)).values).sort()).toEqual(['JPN', 'PER']);
    const now = at(T0);
    expect(now).toMatchObject({ name: 'Population', unit: 'people', transform: 'log', min: 0.93e6, max: 1450e6 });
    expect(now.breaks.length).toBeGreaterThan(1);
    expect(w.query.features(f(['pop']), 3, w.ctx()).total).toBe(0); // delivered as country values, not as features
  });

  it('builds a histogram over the requested span', () => {
    const h = w.query.histogram(f(['quakes']), w.ctx(), T0 - 4 * DAY, T0, 4);
    expect(h.bucketMs).toBe(DAY);
    expect(h.counts).toEqual([1, 0, 1, 3]); // lima (80 h), osaka (30 h), tokyo+fiji+samoa (<24 h)
    expect(w.query.histogram(f(['airports', 'pop']), w.ctx(), T0 - 4 * DAY, T0, 4).total).toBe(0); // timeless layers have no event times
  });
});

describe('filters', () => {
  it('filters by severity range, with or without unknowns', () => {
    expect(ids(['quakes'], { severityMin: 3 })).toEqual(['fiji', 'samoa', 'tokyo']); // unknown severity kept by default
    expect(ids(['quakes'], { severityMin: 3, severityUnknown: false })).toEqual(['fiji', 'tokyo']);
    expect(ids(['quakes'], { severityMin: 1, severityMax: 2, severityUnknown: false })).toEqual(['lima', 'osaka']);
  });
  it('filters by confidence, source, category and country', () => {
    expect(ids(['quakes'], { confidenceMin: 0.6, confidenceUnknown: false })).toEqual(['osaka', 'tokyo']);
    expect(ids(['quakes'], { confidenceMin: 0.6 })).toEqual(['lima', 'osaka', 'samoa', 'tokyo']);
    expect(ids(ALL, { sources: ['rf'] })).toEqual(['hnd', 'lim', 'tpc']);
    expect(ids(ALL, { categories: ['storm', 'airport'] })).toEqual(['cyclone', 'hnd', 'lim', 'past-storm']);
    expect(ids(['quakes', 'airports'], { countries: ['JPN'] })).toEqual(['hnd', 'osaka', 'tokyo']);
    expect(ids(['quakes', 'airports'], { countries: ['PER', 'JPN'] }).length).toBe(5);
    expect(ids(['quakes'], { countries: ['XXX'] })).toEqual([]);
  });
  it('filters by freshness', () => {
    expect(ids(['quakes', 'storms', 'airports'], { freshness: ['reference'] })).toEqual(['hnd', 'lim']);
    expect(ids(['storms'], { freshness: ['expired'], time: { mode: 'range', from: T0 - 10 * DAY, to: T0 } })).toEqual(['past-storm']);
    expect(ids(['quakes'], { freshness: ['fresh'] })).toEqual(['fiji', 'samoa', 'tokyo']);
    expect(ids(['quakes'], { freshness: ['recent'] })).toEqual(['lima', 'osaka']);
  });
  it('searches titles, places and country names with prefix matching; hostile input is inert', () => {
    expect(ids(ALL, { q: 'tok' })).toEqual(['hnd', 'tokyo']);
    expect(ids(ALL, { q: 'japan' }).length).toBeGreaterThanOrEqual(3); // country names are indexed
    expect(ids(ALL, { q: 'cable trans' })).toEqual(['tpc']);
    expect(ids(ALL, { q: 'CVE-2026-0001' })).toEqual(['cve1']);
    for (const q of ['"', 'a" OR "b', '* NEAR(', "'; DROP TABLE records;--", ')))', 'AND', '   ']) expect(() => ids(ALL, { q })).not.toThrow();
    expect(w.store.count()).toBeGreaterThan(50);
  });
  it('combines filters', () => {
    expect(ids(ALL, { q: 'quake', countries: ['JPN'], severityMin: 2, severityUnknown: false, bbox: [130, 30, 145, 40], time: { mode: 'live', windowMs: 12 * HOUR } })).toEqual(['tokyo']);
  });
});

describe('rendering by zoom', () => {
  it('clusters at low zoom and returns individual points when zoomed in', () => {
    const ctx = w.ctx();
    const low = w.query.features(f(['quakes'], { time: { mode: 'live', windowMs: 2 * DAY } }), 1, ctx);
    const cluster = low.points.features.find((x) => (x.properties as { k: string }).k === 'c')!;
    expect(cluster.properties).toMatchObject({ n: 2, l: 'quakes', s: 3, ls: 'quakes:2' }); // Tokyo + Osaka; most severe member wins
    const high = w.query.features(f(['quakes'], { time: { mode: 'live', windowMs: 2 * DAY } }), 8, ctx);
    expect(high.points.features.every((x) => (x.properties as { k: string }).k === 'p')).toBe(true);
    expect(high.points.features).toHaveLength(4);
  });

  it('serves density cells for heat-map layers below their threshold and points above it', () => {
    const ctx = w.ctx();
    const low = w.query.features(f(['fires']), 3, ctx);
    expect(low.points.features).toHaveLength(0);
    expect(low.density.features.reduce((n, x) => n + (x.properties as { w: number }).w, 0)).toBe(40);
    expect(low.counts.fires).toBe(40);
    const high = w.query.features(f(['fires'], { bbox: [19.9, -8.1, 20.2, -7.9] }), 12, ctx);
    expect(high.density.features).toHaveLength(0);
    expect(high.points.features).toHaveLength(40);
  });

  it('does not query zoom-gated layers below their minimum zoom, and says so', () => {
    const ctx = w.ctx();
    const low = w.query.features(f(['airports', 'quakes']), 3, ctx);
    expect(low.hiddenByZoom).toEqual(['airports']);
    expect(low.counts).toEqual({ quakes: 5 });
    expect(w.query.features(f(['airports']), 5, ctx).counts).toEqual({ airports: 2 });
  });

  it('returns polygons and lines as geometry, simplified at low zoom', () => {
    const ctx = w.ctx();
    const feat = w.query.features(f(['storms', 'cables']), 2, ctx);
    // most severe first; the storm watch that expired four days ago is still inside the 7-day look-back, flagged expired
    expect(feat.areas.features.map((x) => (x.properties as { id: string; f: number }).id)).toEqual(['hz:cyclone', 'hz:past-storm']);
    expect(feat.areas.features.map((x) => (x.properties as { f: number }).f)).toEqual([0, 4]);
    expect(w.query.features(f(['storms'], { time: { mode: 'live', windowMs: DAY } }), 2, ctx).areas.features).toHaveLength(1);
    expect(feat.lines.features[0]!.geometry.type).toBe('LineString');
    expect(feat.areas.features[0]!.properties).toMatchObject({ l: 'storms', s: 3 });
  });
});

describe('record detail', () => {
  it('returns the full record with provenance, or null', () => {
    const r = w.query.record('hz:tokyo', w.ctx())!;
    expect(r).toMatchObject({ id: 'hz:tokyo', sourceId: 'hz', layerId: 'quakes', title: 'Quake near Tokyo', countries: ['JPN'], attribution: 'Attribution hz', freshness: 'fresh' });
    expect(r.provenance).toMatchObject({ provider: 'Provider hz', dataset: 'Dataset hz', fetchUrls: ['https://hz.example.org/feed'], derived: ['country'], fixture: false, revision: 1 });
    expect(w.query.record('hz:nope', w.ctx())).toBeNull();
  });
});

describe('migrations', () => {
  it('apply once, in order, and are recorded', () => {
    const db = openDatabase(':memory:');
    const applied = db.all<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version').map((r) => r.version);
    expect(applied[0]).toBe('001_init.sql');
    expect(migrate(db)).toEqual([]); // nothing left to do
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name").map((r) => r.name);
    for (const t of ['records', 'records_rtree', 'records_fts', 'source_state', 'ingest_runs', 'http_cache', 'incidents', 'incident_members', 'source_cursor']) expect(tables).toContain(t);
    db.close();
  });
});
