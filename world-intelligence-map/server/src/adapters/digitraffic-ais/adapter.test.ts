import { describe, expect, it } from 'vitest';
import { FIXTURE_EPOCH } from '../../core/fixtureEpoch.ts';
import type { FetchedPayload, HttpGetOptions } from '../../core/types.ts';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { DEFAULT_DIGITRAFFIC_USER, MAX_POSITION_AGE_MS, shipClass } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 550 });

describe('digitraffic-ais specifics', () => {
  it('joins positions with static AIS metadata and converts units', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);
    expect(run.payloads.map((p) => p.key)).toEqual(['locations', 'vessels']);
    expect(run.output.upstreamTime).toBe(Date.parse('2026-11-10T23:59:32Z'));

    const r = run.records.find((x) => x.upstreamId === '245399000')!;
    expect(r.title).toBe('LADY HANNAH');
    expect(r.layerId).toBe('vessels-baltic');
    expect(r.subcategory).toBe('cargo');
    expect(r.geometry).toEqual({ type: 'Point', coordinates: [19.448478, 59.981635] });
    expect(r.occurredAt).toBe(1794355169363); // timestampExternal is already epoch milliseconds
    expect(new Date(r.occurredAt!).toISOString()).toBe('2026-11-10T23:59:29.363Z');
    expect(r.attributes).toEqual({
      mmsi: 245399000, name: 'LADY HANNAH', shipTypeCode: 70, shipClass: 'cargo', speedKn: 9, courseDeg: 320.7, headingDeg: 320,
      navStatusCode: 0, navStatus: 'under way using engine', destination: 'SEGVX', draughtM: 5.4, positionAccuracyHigh: true,
    });
    expect(r.severity).toBeNull();
    expect(r.confidence).toBeNull();
    expect(Object.keys(r.attributes).some((k) => /owner|operator|crew|imo|callsign/i.test(k))).toBe(false);
  });

  it('maps AIS "not available" sentinels to absent values', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const tug = run.records.find((x) => x.upstreamId === '230044260')!; // heading 511
    expect(tug.subcategory).toBe('tug');
    expect(tug.attributes.headingDeg).toBeUndefined();
    expect(tug.attributes.speedKn).toBe(0);
    expect(tug.attributes.draughtM).toBe(2);

    const survey = run.records.find((x) => x.upstreamId === '230182220')!; // sog 102.3, cog 360, heading 511, draught 0
    expect(survey.attributes.speedKn).toBeUndefined();
    expect(survey.attributes.courseDeg).toBeUndefined();
    expect(survey.attributes.headingDeg).toBeUndefined();
    expect(survey.attributes.draughtM).toBeUndefined();
    expect(survey.attributes.navStatus).toBe('moored');

    const noMeta = run.records.find((x) => x.upstreamId === '266420000')!; // position without a metadata row
    expect(noMeta.title).toBe('MMSI 266420000');
    expect(noMeta.subcategory).toBeNull();
    expect(noMeta.attributes.shipTypeCode).toBeUndefined();
  });

  it('only emits positions from the last 60 minutes, all inside the regional coverage box', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const all = (run.payloads[0]!.json() as { features: { mmsi: number; properties: { timestampExternal: number } }[] }).features;
    const stale = all.filter((f) => FIXTURE_EPOCH - f.properties.timestampExternal > MAX_POSITION_AGE_MS);
    expect(stale.length).toBe(12);
    expect(run.records).toHaveLength(all.length - stale.length);
    for (const f of stale) expect(run.records.some((r) => r.upstreamId === String(f.mmsi))).toBe(false);
    for (const r of run.records) {
      expect(r.occurredAt!).toBeLessThan(FIXTURE_EPOCH);
      expect(r.occurredAt!).toBeGreaterThanOrEqual(FIXTURE_EPOCH - 600_000);
      expect(r.point![0]).toBeGreaterThan(15);
      expect(r.point![0]).toBeLessThan(33);
      expect(r.point![1]).toBeGreaterThan(57);
      expect(r.point![1]).toBeLessThan(66);
    }
    // Two hours later the very same payload yields nothing.
    const later = adapter.parse(run.payloads, { now: FIXTURE_EPOCH + 2 * 3_600_000, env: {} });
    expect(later.records).toHaveLength(0);
    expect(later.rejected).toHaveLength(0);
  });

  it('decodes AIS ship-type codes into broad classes', () => {
    expect([70, 79, 80, 60, 52, 31, 51, 35, 37, 36, 40, 30, 90, 20].map(shipClass)).toEqual([
      'cargo', 'cargo', 'tanker', 'passenger', 'tug', 'tug', 'search and rescue', 'military operations', 'pleasure craft', 'sailing',
      'high-speed craft', 'fishing', 'other', 'wing in ground',
    ]);
    expect(shipClass(0)).toBeNull();
    expect(shipClass(null)).toBeNull();
    expect(shipClass(7)).toBe('reserved or special');
  });

  it('rejects malformed features individually and sanitises hostile broadcast text', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: adapter.manifest.id, fromRun: 1, effect: { variant: 'malformed' } }] });
    expect(run.records.map((r) => r.upstreamId).sort()).toEqual(['230000001', '230000002']);
    const reasons = run.rejected.map((r) => r.reason).sort();
    expect(reasons).toEqual([
      'feature without properties',
      'invalid coordinates',
      'missing geometry',
      'missing or invalid mmsi', // absent
      'missing or invalid mmsi', // string instead of integer
      'missing position time',
      'position time is in the future',
      'vessel metadata without a valid mmsi',
      'vessel metadata without a valid mmsi',
    ]);
    // (181, 91) "position not available" and the two-hour-old position are skipped, not rejected.
    const hostile = run.records.find((r) => r.upstreamId === '230000001')!;
    expect(hostile.title).toBe('EVIL QUEEN');
    expect(hostile.attributes.destination).toBe('HELSINKI');
    expect(hostile.attributes.shipTypeCode).toBeUndefined(); // "seventy" is not a code
    expect(hostile.attributes.draughtM).toBeUndefined(); // negative draught
    const sentinel = run.records.find((r) => r.upstreamId === '230000002')!;
    expect(sentinel.title).toBe('MMSI 230000002');
    expect(sentinel.attributes).toEqual({ mmsi: 230000002, navStatusCode: 15, positionAccuracyHigh: false });
  });

  it('identifies the application with a Digitraffic-User header and asks for gzip', async () => {
    const calls: { url: string; opts: HttpGetOptions }[] = [];
    const http = {
      async get(url: string, opts: HttpGetOptions = {}): Promise<FetchedPayload> {
        calls.push({ url, opts });
        return { key: opts.key ?? url, url } as FetchedPayload;
      },
    };
    const base = { http, now: FIXTURE_EPOCH, cursor: { get: () => null, set: () => {} }, signal: new AbortController().signal };
    await adapter.fetch({ ...base, env: {} });
    await adapter.fetch({ ...base, env: { DIGITRAFFIC_USER: ' ExampleOrg/Map 2.0 ' } });
    expect(calls.map((c) => c.url)).toEqual([
      'https://meri.digitraffic.fi/api/ais/v1/locations', 'https://meri.digitraffic.fi/api/ais/v1/vessels',
      'https://meri.digitraffic.fi/api/ais/v1/locations', 'https://meri.digitraffic.fi/api/ais/v1/vessels',
    ]);
    expect(calls[0]!.opts.headers).toEqual({ 'Digitraffic-User': DEFAULT_DIGITRAFFIC_USER, 'Accept-Encoding': 'gzip' });
    expect(calls[3]!.opts.headers).toEqual({ 'Digitraffic-User': 'ExampleOrg/Map 2.0', 'Accept-Encoding': 'gzip' });
    expect(calls[1]!.opts.cacheTtlSec).toBe(3600);
  });
});
