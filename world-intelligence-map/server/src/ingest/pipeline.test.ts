import { afterEach, describe, expect, it } from 'vitest';
import { getEach } from '../adapters/base.ts';
import type { FetchContext, RecordDraft } from '../core/types.ts';
import { DAY, draft, HOUR, jsonAdapter, makeWorld, ok, point, status, T0, testManifest, type TestWorld } from '../test/helpers.ts';
import { Scheduler } from './scheduler.ts';

const quakesA = testManifest('qa', [{ id: 'qa-eq', timeModel: 'event', correlationClass: 'earthquake', retentionDays: 30 }]);
const quakesB = testManifest('qb', [{ id: 'qb-eq', timeModel: 'event', correlationClass: 'earthquake', retentionDays: 30 }]);
const alerts = testManifest('al', [{ id: 'al-alerts', timeModel: 'interval', retentionDays: 2 }, { id: 'al-places', timeModel: 'reference', retentionDays: null }], { snapshot: 'full' });
const movers = testManifest('mv', [{ id: 'mv-craft', timeModel: 'snapshot', liveMaxAgeSec: 600, retentionDays: 1, render: { type: 'track', color: 'teal', shape: 'plane' } }], { snapshot: 'full' });
const keyed = testManifest('ky', [{ id: 'ky-l' }], { auth: { type: 'api_key', envVars: [{ name: 'KY_KEY', required: true, description: 'key' }], setup: 'Get a key at example.org and set KY_KEY.' } });

let w: TestWorld;
afterEach(() => w?.close());

function world(env: Record<string, string | undefined> = {}) {
  w = makeWorld([quakesA, quakesB, alerts, movers, keyed].map(jsonAdapter), { env });
  return w;
}
const rows = (sql: string, ...p: (string | number)[]) => w.db.all<Record<string, unknown>>(sql, ...p);

describe('deduplication and idempotent re-ingestion', () => {
  it('re-ingesting identical data changes nothing but the fetch bookkeeping', async () => {
    world();
    const feed: RecordDraft[] = [draft('qa-eq', { upstreamId: 'e1', title: 'M 5.0' }), draft('qa-eq', { upstreamId: 'e2', title: 'M 4.0', geometry: point(20, 20) })];
    w.net.json('qa.example.org', () => feed);
    const first = await w.pipeline.runSource('qa');
    expect(first).toMatchObject({ outcome: 'ok', inserted: 2, updated: 0, unchanged: 0 });
    w.clock.advance(5 * 60_000);
    const second = await w.pipeline.runSource('qa');
    expect(second).toMatchObject({ outcome: 'ok', inserted: 0, updated: 0, unchanged: 2 });
    expect(w.store.count()).toBe(2);
    const r = rows('SELECT revision, fetched_at, first_seen_at FROM records WHERE id = ?', 'qa:e1')[0]!;
    expect(r).toEqual({ revision: 1, fetched_at: T0 + 5 * 60_000, first_seen_at: T0 });
    // the spatial and full-text indexes hold exactly one entry per record
    expect(rows('SELECT COUNT(*) AS n FROM records_rtree')[0]!.n).toBe(2);
    expect(w.query.list({ layers: ['qa-eq'], time: { mode: 'live', windowMs: DAY }, q: 'M' }, w.ctx()).total).toBe(2);
  });

  it('updates a record in place when its upstream content changes, bumping the revision', async () => {
    world();
    const feed = [draft('qa-eq', { upstreamId: 'e1', title: 'M 5.0 - preliminary', attributes: { magnitude: 5 } })];
    w.net.json('qa.example.org', () => feed);
    await w.pipeline.runSource('qa');
    feed[0] = { ...feed[0]!, title: 'M 5.3 - reviewed', geometry: point(11, 11), attributes: { magnitude: 5.3 } };
    w.clock.advance(60_000);
    expect(await w.pipeline.runSource('qa')).toMatchObject({ inserted: 0, updated: 1, unchanged: 0 });
    expect(w.store.count()).toBe(1);
    const rec = w.query.record('qa:e1', w.ctx())!;
    expect(rec).toMatchObject({ title: 'M 5.3 - reviewed', point: [11, 11] });
    expect(rec.provenance).toMatchObject({ revision: 2, firstSeenAt: T0, fetchedAt: T0 + 60_000 });
    // indexes follow the update: found at the new place and by the new words only
    const at = (lon: number) => w.query.features({ layers: ['qa-eq'], time: { mode: 'live', windowMs: DAY }, bbox: [lon - 0.5, lon - 0.5, lon + 0.5, lon + 0.5] }, 8, w.ctx()).total;
    expect([at(10), at(11)]).toEqual([0, 1]);
    const find = (q: string) => w.query.list({ layers: ['qa-eq'], time: { mode: 'live', windowMs: DAY }, q }, w.ctx()).total;
    expect([find('preliminary'), find('reviewed')]).toEqual([0, 1]);
  });

  it('collapses duplicate ids inside one batch', async () => {
    world();
    w.net.json('qa.example.org', () => [draft('qa-eq', { upstreamId: 'dup', title: 'first' }), draft('qa-eq', { upstreamId: 'dup', title: 'second' })]);
    expect(await w.pipeline.runSource('qa')).toMatchObject({ inserted: 1 });
    expect(w.query.record('qa:dup', w.ctx())!.title).toBe('second');
  });

  it('rejects malformed records individually and still ingests the valid ones', async () => {
    world();
    w.net.json('qa.example.org', () => [draft('qa-eq', { upstreamId: 'good' }), draft('qa-eq', { upstreamId: 'badgeo', geometry: point(10, 99) }), draft('qa-eq', { upstreamId: 'future', occurredAt: T0 + 3 * DAY }), 'garbage', draft('nope', { upstreamId: 'wrong-layer' })]);
    const res = await w.pipeline.runSource('qa');
    expect(res.outcome).toBe('partial');
    expect(res.inserted).toBe(1);
    expect(res.rejected.map((r) => r.reason)).toEqual(['item is not a record', 'geometry: latitude 99 out of range', expect.stringContaining('in the future'), 'unknown layer "nope" for source qa']);
    const run = w.store.recentRuns('qa', 1)[0]!;
    expect(run).toMatchObject({ outcome: 'partial', inserted: 1, rejected: 4 });
    expect(w.health().get('qa')!.status).toBe('healthy');
    expect(w.health().get('qa')!.lastCounts).toMatchObject({ inserted: 1, rejected: 4 });
  });
});

describe('full snapshots, expiry and tracks', () => {
  it('ends records that disappear from a complete snapshot and replaces reference data', async () => {
    world();
    let feed: RecordDraft[] = [
      draft('al-alerts', { upstreamId: 'a1', ongoing: true }),
      draft('al-alerts', { upstreamId: 'a2', ongoing: true, geometry: point(30, 30) }),
      draft('al-places', { upstreamId: 'p1', occurredAt: null }),
      draft('al-places', { upstreamId: 'p2', occurredAt: null }),
    ];
    w.net.json('al.example.org', () => feed);
    await w.pipeline.runSource('al');
    feed = [feed[0]!, feed[2]!];
    w.clock.advance(10 * 60_000);
    const res = await w.pipeline.runSource('al');
    expect(res).toMatchObject({ unchanged: 2, ended: 2 });
    expect(rows("SELECT id FROM records WHERE layer_id = 'al-places'").map((r) => r.id)).toEqual(['al:p1']); // reference set replaced
    const a2 = w.query.record('al:a2', w.ctx())!;
    expect(a2.endedAt).toBe(T0 + 10 * 60_000);
    expect(a2.ongoing).toBe(false);
    expect(a2.freshness).toBe('expired'); // kept for history, never shown as live
    expect(w.query.record('al:a1', w.ctx())!.freshness).toBe('fresh');
    // the ongoing record's active interval extends to the latest fetch that confirmed it
    expect(w.query.record('al:a1', w.ctx())!.tEnd).toBe(T0 + 10 * 60_000);
  });

  it('revives a record that comes back', async () => {
    world();
    let feed = [draft('al-alerts', { upstreamId: 'a1', ongoing: true })];
    w.net.json('al.example.org', () => feed);
    await w.pipeline.runSource('al');
    const keep = feed;
    feed = [];
    w.clock.advance(60_000);
    await w.pipeline.runSource('al');
    expect(w.query.record('al:a1', w.ctx())!.endedAt).not.toBeNull();
    feed = keep;
    w.clock.advance(60_000);
    await w.pipeline.runSource('al');
    expect(w.query.record('al:a1', w.ctx())!).toMatchObject({ endedAt: null, freshness: 'fresh' });
  });

  it('marks records expired once their upstream expiry passes', async () => {
    world();
    w.net.json('al.example.org', () => [draft('al-alerts', { upstreamId: 'a1', occurredAt: T0 - HOUR, expiresAt: T0 + HOUR })]);
    await w.pipeline.runSource('al');
    expect(w.query.record('al:a1', w.ctx())!.freshness).toBe('fresh');
    w.clock.advance(2 * HOUR);
    expect(w.query.record('al:a1', w.ctx())!.freshness).toBe('expired');
    // a live view no longer shows it once the look-back window has moved past its end…
    w.clock.advance(2 * HOUR);
    expect(w.query.list({ layers: ['al-alerts'], time: { mode: 'live', windowMs: HOUR } }, w.ctx()).total).toBe(0);
    // …but history still does
    expect(w.query.list({ layers: ['al-alerts'], time: { mode: 'range', from: T0, to: T0 + 30 * 60_000 } }, w.ctx()).total).toBe(1);
  });

  it('accumulates the recent path of moving objects without duplicating points', async () => {
    world();
    let pos = { lon: 10, lat: 50, t: T0 - 60_000 };
    w.net.json('mv.example.org', () => [draft('mv-craft', { upstreamId: 'abc123', title: 'ABC123', geometry: point(pos.lon, pos.lat), occurredAt: pos.t })]);
    await w.pipeline.runSource('mv');
    await w.pipeline.runSource('mv'); // same observation again
    for (let i = 1; i <= 3; i++) {
      w.clock.advance(60_000);
      pos = { lon: 10 + i * 0.1, lat: 50, t: pos.t + 60_000 };
      await w.pipeline.runSource('mv');
    }
    const rec = w.query.record('mv:abc123', w.ctx())!;
    expect(rec.track!.map((p) => p[0])).toEqual([10, 10.1, 10.2, 10.3]);
    expect(rec.point).toEqual([10.3, 50]);
    const f = w.query.features({ layers: ['mv-craft'], time: { mode: 'live', windowMs: HOUR } }, 6, w.ctx());
    expect(f.lines.features).toHaveLength(1);
    expect(f.lines.features[0]!.properties).toMatchObject({ id: 'mv:abc123', path: 1 });
  });
});

describe('retention', () => {
  it('purges records older than the layer rule, keeps reference data and ongoing records', async () => {
    world();
    w.net.json('qa.example.org', () => [draft('qa-eq', { upstreamId: 'old', occurredAt: T0 - 31 * DAY }), draft('qa-eq', { upstreamId: 'new', occurredAt: T0 - DAY })]);
    w.net.json('al.example.org', () => [
      draft('al-alerts', { upstreamId: 'ended', occurredAt: T0 - 5 * DAY, expiresAt: T0 - 3 * DAY }),
      draft('al-alerts', { upstreamId: 'long-running', occurredAt: T0 - 20 * DAY, ongoing: true }),
      draft('al-places', { upstreamId: 'p1', occurredAt: null }),
    ]);
    await w.pipeline.runSource('qa');
    await w.pipeline.runSource('al');
    const res = w.store.applyRetention(w.clock.now());
    expect(res.byLayer).toEqual({ 'qa-eq': 1, 'al-alerts': 1 });
    expect(rows('SELECT id FROM records ORDER BY id').map((r) => r.id)).toEqual(['al:long-running', 'al:p1', 'qa:new']);
    expect(rows('SELECT COUNT(*) AS n FROM records_rtree')[0]!.n).toBe(3);
    expect(w.query.list({ layers: ['qa-eq'], time: { mode: 'range', from: 0, to: T0 }, q: 'Record' }, w.ctx()).total).toBe(1);
    // idempotent
    expect(w.store.applyRetention(w.clock.now()).deleted).toBe(0);
  });
});

describe('database write path', () => {
  it('keeps working after bulk full-text deletes leave an oversized last-insert rowid on the connection', async () => {
    // Regression: FTS5 tombstone writes can set sqlite3_last_insert_rowid() beyond 2^53. node:sqlite then throws from
    // any later statement.run() in number mode, which once crashed the scheduler after a retention purge.
    world();
    w.net.json('qa.example.org', () => Array.from({ length: 600 }, (_, i) => draft('qa-eq', { upstreamId: `old${i}`, title: `Old quake number ${i}`, occurredAt: T0 - 40 * DAY })));
    await w.pipeline.runSource('qa');
    expect(w.store.applyRetention(w.clock.now()).deleted).toBe(600);
    const probe = w.db.raw.prepare('SELECT last_insert_rowid() AS r');
    probe.setReadBigInts(true);
    const hazard = (probe.get() as { r: bigint }).r > BigInt(Number.MAX_SAFE_INTEGER);
    if (hazard) expect(() => w.db.raw.prepare("UPDATE meta SET value = value WHERE key = 'none'").run()).toThrow(/too large/); // the platform behaviour guarded against
    // every write the application performs afterwards must still succeed
    expect(() => w.pipeline.states.save({ ...w.pipeline.states.get('qa'), nextRunAt: T0 + 1000 })).not.toThrow();
    expect(() => w.store.setMeta('k', 'v')).not.toThrow();
    expect(w.store.startRun('qa', T0)).toBeGreaterThan(0);
    w.net.json('qa.example.org', () => [draft('qa-eq', { upstreamId: 'new1' })]);
    expect(await w.pipeline.runSource('qa')).toMatchObject({ outcome: 'ok', inserted: 1 });
    expect(w.query.list({ layers: ['qa-eq'], time: { mode: 'live', windowMs: DAY }, q: 'Record' }, w.ctx()).total).toBe(1);
  });
});

describe('cross-source correlation', () => {
  const quake = (id: string, lon: number, lat: number, t: number, mag: number): RecordDraft => draft('x', { upstreamId: id, title: `M ${mag}`, geometry: point(lon, lat), occurredAt: t, attributes: { magnitude: mag } });

  it('links close reports from different sources without touching the originals', async () => {
    world();
    const t = T0 - 3 * HOUR;
    w.net.json('qa.example.org', () => [{ ...quake('a1', 142.5, 38.2, t, 6.1), layerId: 'qa-eq' }, { ...quake('a2', -70, -30, t, 5.0), layerId: 'qa-eq' }, { ...quake('a3', 142.6, 38.25, t + 20_000, 4.2), layerId: 'qa-eq' }]);
    w.net.json('qb.example.org', () => [
      { ...quake('b1', 142.62, 38.31, t + 4_000, 6.0), layerId: 'qb-eq' }, // same event: 14 km, 4 s, ΔM 0.1
      { ...quake('b2', -70.1, -30.1, t + 10 * 60_000, 5.0), layerId: 'qb-eq' }, // same place, 10 minutes later → not linked
      { ...quake('b3', 150, 45, t + 2_000, 6.1), layerId: 'qb-eq' }, // same time, 1,000 km away → not linked
    ]);
    await w.pipeline.runSource('qa');
    const before = w.query.record('qa:a1', w.ctx())!;
    await w.pipeline.runSource('qb');

    const a1 = w.query.record('qa:a1', w.ctx())!;
    const inc = a1.incident as { id: string; class: string; sourceCount: number; note: string; members: { id: string; basis: { distanceKm: number; timeGapSec: number } }[] };
    expect(inc.class).toBe('earthquake');
    expect(inc.sourceCount).toBe(2);
    expect(inc.members.map((m) => m.id)).toEqual(['qb:b1']);
    expect(inc.members[0]!.basis.timeGapSec).toBe(4);
    expect(inc.members[0]!.basis.distanceKm).toBeGreaterThan(10);
    expect(inc.members[0]!.basis.distanceKm).toBeLessThan(20);
    expect(inc.note).toMatch(/possibly describe the same incident/);
    // provenance and content of the originals are untouched
    expect(a1.provenance.contentHash).toBe(before.provenance.contentHash);
    expect(a1.title).toBe(before.title);
    expect(w.store.count()).toBe(6);
    // conservative: nothing else is linked – including the M4.2 aftershock 20 s later whose magnitude differs too much
    for (const id of ['qa:a2', 'qa:a3', 'qb:b2', 'qb:b3']) expect(w.query.record(id, w.ctx())!.incident).toBeNull();
  });

  it('never links two records of the same source, and is idempotent', async () => {
    world();
    const t = T0 - HOUR;
    w.net.json('qa.example.org', () => [{ ...quake('a1', 10, 10, t, 5), layerId: 'qa-eq' }, { ...quake('a2', 10.01, 10.01, t + 1000, 5), layerId: 'qa-eq' }]);
    await w.pipeline.runSource('qa');
    expect(rows('SELECT COUNT(*) AS n FROM incidents')[0]!.n).toBe(0);
    w.net.json('qb.example.org', () => [{ ...quake('b1', 10, 10, t + 500, 5), layerId: 'qb-eq' }]);
    await w.pipeline.runSource('qb');
    const snapshot = () => JSON.stringify(rows('SELECT incident_id, record_id FROM incident_members ORDER BY record_id'));
    const first = snapshot();
    expect(rows('SELECT member_count, source_count FROM incidents')).toEqual([{ member_count: 3, source_count: 2 }]);
    w.net.json('qb.example.org', () => [{ ...quake('b1', 10, 10, t + 500, 5.1), layerId: 'qb-eq' }]); // content change → re-correlate
    w.clock.advance(60_000);
    await w.pipeline.runSource('qb');
    expect(snapshot()).toBe(first);
  });

  it('dissolves an incident when a member is purged', async () => {
    world();
    const t = T0 - 29 * DAY - 23 * HOUR;
    w.net.json('qa.example.org', () => [{ ...quake('a1', 10, 10, t, 5), layerId: 'qa-eq' }]);
    w.net.json('qb.example.org', () => [{ ...quake('b1', 10, 10, t, 5), layerId: 'qb-eq' }]);
    await w.pipeline.runSource('qa');
    await w.pipeline.runSource('qb');
    expect(rows('SELECT COUNT(*) AS n FROM incidents')[0]!.n).toBe(1);
    w.clock.advance(2 * HOUR);
    w.net.json('qb.example.org', () => []);
    w.store.applyRetention(w.clock.now());
    expect(rows('SELECT COUNT(*) AS n FROM incident_members')[0]!.n).toBe(0);
    expect(rows('SELECT COUNT(*) AS n FROM incidents')[0]!.n).toBe(0);
  });
});

describe('failure isolation, health and stale data', () => {
  it('a failing source never throws, keeps its data and leaves other sources unaffected', async () => {
    world();
    w.net.json('qa.example.org', () => [draft('qa-eq', { upstreamId: 'e1' })]);
    w.net.json('qb.example.org', () => [draft('qb-eq', { upstreamId: 'e1' })]);
    await w.pipeline.runSource('qa');
    await w.pipeline.runSource('qb');
    w.net.on('qa.example.org', () => 'network');
    w.clock.advance(60_000);
    const res = await w.pipeline.runSource('qa');
    // upstream failed but a cached copy exists: nothing is re-stamped, the failure is recorded
    expect(res.outcome).toBe('failed');
    expect(w.store.count("source_id = 'qa'")).toBe(1);
    expect(w.query.record('qa:e1', w.ctx())!.fetchedAt).toBe(T0);
    const h = w.health();
    expect(h.get('qa')).toMatchObject({ status: 'delayed', consecutiveFailures: 1, lastSuccessAt: T0 });
    expect(h.get('qa')!.message).toMatch(/cached copy/);
    expect(h.get('qb')!.status).toBe('healthy');
    expect((await w.pipeline.runSource('qb')).outcome).toBe('ok');
  });

  it('walks through delayed → unavailable → stale data → recovery', async () => {
    world();
    let up = true;
    w.net.on('qa.example.org', () => (up ? ok([draft('qa-eq', { upstreamId: 'e1', occurredAt: T0 - 60_000 })]) : status(500)));
    await w.pipeline.runSource('qa');
    expect(w.health().get('qa')!.status).toBe('healthy');
    up = false;
    w.clock.advance(5 * 60_000);
    await w.pipeline.runSource('qa');
    expect(w.health().get('qa')).toMatchObject({ status: 'delayed', dataIsStale: false });
    expect(w.query.record('qa:e1', w.ctx())!.freshness).toBe('fresh'); // still inside the staleness budget
    for (let i = 0; i < 2; i++) {
      w.clock.advance(5 * 60_000);
      await w.pipeline.runSource('qa');
    }
    expect(w.health().get('qa')).toMatchObject({ status: 'unavailable', consecutiveFailures: 3 });
    // past staleAfterSec (30 min) without a successful fetch: records are flagged, never silently shown as live
    w.clock.advance(20 * 60_000);
    await w.pipeline.runSource('qa');
    const h = w.health().get('qa')!;
    expect(h.dataIsStale).toBe(true);
    expect(h.message).toMatch(/Showing data from the last successful fetch/);
    expect(w.query.record('qa:e1', w.ctx())!.freshness).toBe('stale');
    const list = w.query.list({ layers: ['qa-eq'], time: { mode: 'live', windowMs: DAY }, freshness: ['stale'] }, w.ctx());
    expect(list.items.map((i) => i.id)).toEqual(['qa:e1']);
    // recovery
    up = true;
    w.clock.advance(61_000 * 5);
    for (let i = 0; i < 4 && (await w.pipeline.runSource('qa')).outcome !== 'ok'; i++) w.clock.advance(31 * 60_000);
    expect(w.health().get('qa')).toMatchObject({ status: 'healthy', dataIsStale: false, consecutiveFailures: 0, lastError: null });
    expect(w.query.record('qa:e1', w.ctx())!.freshness).not.toBe('stale');
  });

  it('reports "stale" when a source simply has not been refreshed within its budget', async () => {
    world();
    w.net.json('qa.example.org', () => [draft('qa-eq', { upstreamId: 'e1' })]);
    await w.pipeline.runSource('qa');
    w.clock.advance(31 * 60_000);
    expect(w.health().get('qa')).toMatchObject({ status: 'stale', dataIsStale: true });
    expect(w.health().get('qa')!.message).toMatch(/No successful refresh for 31 min/);
  });

  it('backs off on rate limits and does not contact upstream again before Retry-After', async () => {
    world();
    let limited = false;
    w.net.on('qa.example.org', () => (limited ? status(429, { 'retry-after': '900' }) : ok([draft('qa-eq', { upstreamId: 'e1' })])));
    await w.pipeline.runSource('qa');
    limited = true;
    w.clock.advance(60_000);
    const res = await w.pipeline.runSource('qa');
    expect(res).toMatchObject({ outcome: 'rate_limited', retryAt: T0 + 60_000 + 900_000 });
    expect(w.health().get('qa')).toMatchObject({ status: 'rate_limited', rateLimitedUntil: T0 + 60_000 + 900_000, consecutiveFailures: 0 });
    const calls = w.net.count('qa.example.org');
    w.clock.advance(5 * 60_000);
    expect((await w.pipeline.runSource('qa')).outcome).toBe('rate_limited');
    expect(w.net.count('qa.example.org')).toBe(calls); // not hammered
    limited = false;
    w.clock.advance(15 * 60_000);
    expect((await w.pipeline.runSource('qa')).outcome).toBe('ok');
    expect(w.health().get('qa')!.status).toBe('healthy');
  });

  it('treats a wholly malformed payload as a failure and keeps the previous data', async () => {
    world();
    let body: unknown = [draft('qa-eq', { upstreamId: 'e1' })];
    w.net.on('qa.example.org', () => ok(body as object));
    await w.pipeline.runSource('qa');
    body = '<html>Service temporarily unavailable</html>';
    w.clock.advance(60_000);
    const res = await w.pipeline.runSource('qa');
    expect(res).toMatchObject({ outcome: 'failed', errorKind: 'parse' });
    expect(w.store.count()).toBe(1);
    expect(w.health().get('qa')!.lastError).toMatch(/malformed test feed/);
  });

  it('does not end the whole world when a full-snapshot source returns an empty error-like result', async () => {
    world();
    let body: unknown[] = Array.from({ length: 30 }, (_, i) => draft('al-alerts', { upstreamId: `a${i}`, ongoing: true }));
    w.net.json('al.example.org', () => body);
    await w.pipeline.runSource('al');
    body = ['oops'];
    w.clock.advance(60_000);
    const res = await w.pipeline.runSource('al');
    expect(res).toMatchObject({ outcome: 'partial', ended: 0 });
    expect(w.store.count('ended_at IS NULL')).toBe(30);
  });

  it('never calls a credential-backed source without its credentials, and explains how to configure it', async () => {
    world();
    w.net.json('ky.example.org', () => [draft('ky-l')]);
    const res = await w.pipeline.runSource('ky');
    expect(res.outcome).toBe('misconfigured');
    expect(w.net.count('ky.example.org')).toBe(0);
    const h = w.health().get('ky')!;
    expect(h).toMatchObject({ status: 'misconfigured', missingEnv: ['KY_KEY'] });
    expect(h.message).toBe('Missing credential: KY_KEY. Get a key at example.org and set KY_KEY.');
  });

  it('reports rejected credentials as misconfiguration', async () => {
    world({ KY_KEY: 'wrong' });
    w.net.on('ky.example.org', () => status(401));
    expect((await w.pipeline.runSource('ky')).outcome).toBe('misconfigured');
    expect(w.health().get('ky')).toMatchObject({ status: 'misconfigured' });
    expect(w.health().get('ky')!.message).toMatch(/rejected the configured credentials/);
  });
});

describe('partial refresh of multi-request sources', () => {
  it('ingests what loaded, reports the gap as delayed, retries sooner and recovers', async () => {
    const m = testManifest('mr', [{ id: 'mr-a' }, { id: 'mr-b' }]);
    const adapter = {
      ...jsonAdapter(m),
      fetch: (ctx: FetchContext) => getEach(ctx, ['a', 'b'].map((k) => ({ url: `https://mr.example.org/${k}`, opts: { key: k } }))),
    };
    w = makeWorld([adapter], { policy: { maxRetries: 0 } });
    let bDown = true;
    w.net.on('mr.example.org', (req) => (req.url.endsWith('/a') ? ok([draft('mr-a', { upstreamId: 'a1' })]) : bDown ? status(502) : ok([draft('mr-b', { upstreamId: 'b1' })])));
    const res = await w.pipeline.runSource('mr');
    expect(res).toMatchObject({ outcome: 'partial', inserted: 1, errorKind: 'partial' });
    expect(res.error).toBe('1 of 2 requests failed (upstream HTTP 502)');
    const h = w.health().get('mr')!;
    expect(h).toMatchObject({ status: 'delayed', dataIsStale: false, lastSuccessAt: T0 });
    expect(h.message).toMatch(/^Partially refreshed: 1 of 2 requests failed/);
    // the scheduler retries a partial refresh on the failure back-off, not the full interval
    const s = new Scheduler({ catalog: w.catalog, pipeline: w.pipeline, store: w.store, clock: w.clock, random: () => 0.5 });
    expect(s.planNext('mr', res, T0, 1)).toBe(T0 + 15_000);
    await s.stop();
    // repeated partial failures never escalate to "unavailable" while part of the data keeps refreshing
    for (let i = 0; i < 4; i++) {
      w.clock.advance(60_000);
      await w.pipeline.runSource('mr');
    }
    expect(w.health().get('mr')!.status).toBe('delayed');
    bDown = false;
    w.clock.advance(60_000);
    expect(await w.pipeline.runSource('mr')).toMatchObject({ outcome: 'ok', inserted: 1 });
    expect(w.health().get('mr')).toMatchObject({ status: 'healthy', lastError: null });
  });
});

describe('scheduler', () => {
  it('runs all sources with bounded concurrency and isolates failures', async () => {
    world();
    let active = 0;
    let peak = 0;
    const slow = (body: unknown) => async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return ok(body as object);
    };
    w.net.on('qa.example.org', slow([draft('qa-eq')]));
    w.net.on('qb.example.org', () => 'network');
    w.net.on('al.example.org', slow([draft('al-alerts', { ongoing: true })]));
    w.net.on('mv.example.org', slow([draft('mv-craft')]));
    const s = new Scheduler({ catalog: w.catalog, pipeline: w.pipeline, store: w.store, clock: w.clock, concurrency: 2 });
    const results = await s.runAllOnce();
    expect(peak).toBeLessThanOrEqual(2);
    expect(Object.fromEntries(results.map((r) => [r.sourceId, r.outcome]))).toEqual({ qa: 'ok', qb: 'failed', al: 'ok', mv: 'ok', ky: 'misconfigured' });
    await s.stop();
  });

  it('plans the next run from the outcome: interval, backoff, Retry-After', async () => {
    world();
    const s = new Scheduler({ catalog: w.catalog, pipeline: w.pipeline, store: w.store, clock: w.clock, random: () => 0.5 });
    const res = (o: object) => ({ sourceId: 'qa', outcome: 'ok', inserted: 0, updated: 0, unchanged: 0, ended: 0, rejected: [], error: null, errorKind: null, durationMs: 0, changedLayers: [], retryAt: null, ...o }) as never;
    expect(s.planNext('qa', res({}), T0, 0)).toBe(T0 + 300_000);
    expect(s.planNext('qa', res({ outcome: 'failed' }), T0, 1)).toBe(T0 + 15_000);
    expect(s.planNext('qa', res({ outcome: 'failed' }), T0, 3)).toBe(T0 + 60_000);
    expect(s.planNext('qa', res({ outcome: 'failed' }), T0, 12)).toBe(T0 + 300_000); // capped at the normal interval
    expect(s.planNext('qa', res({ outcome: 'rate_limited', retryAt: T0 + 900_000 }), T0, 0)).toBe(T0 + 900_500);
    expect(s.planNext('ky', res({ outcome: 'misconfigured' }), T0, 0)).toBe(T0 + 300_000);
    await s.stop();
  });
});
