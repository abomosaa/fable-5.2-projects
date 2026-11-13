import { describe, expect, it } from 'vitest';
import { firmsVolume } from '../../demo/volume.ts';
import { adapterContractSuite, fixtureEnv, runAdapterOnFixtures } from '../testing.ts';
import adapter, { MAX_DETECTIONS, SOURCE } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 300 });

const scenario = (variant: string) => [{ source: 'nasa-firms', fromRun: 1, effect: { variant } }];

describe('nasa-firms specifics', () => {
  it('puts the MAP_KEY in the documented URL path and redacts it everywhere', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const key = fixtureEnv(adapter).FIRMS_MAP_KEY!;
    expect(run.requests).toEqual([`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/${SOURCE}/world/2`]);
    expect(run.payloads[0]!.url).toBe(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/REDACTED/${SOURCE}/world/2`);
    for (const r of run.records) expect(JSON.stringify(r.provenance)).not.toContain(key);
  });

  it('parses detections: UTC acquisition time, confidence classes and fire radiative power', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);
    expect(run.records).toHaveLength(320);
    const r = run.records.find((x) => x.upstreamId === 'N20_2026-11-09_0000_-7.94678_19.96892')!;
    expect(r.point).toEqual([19.96892, -7.94678]);
    expect(r.occurredAt).toBe(Date.UTC(2026, 10, 9, 0, 0));
    expect(r.title).toBe('Thermal anomaly (VIIRS NOAA-20) 2026-11-09 00:00 UTC');
    expect(r.confidence).toBe(0.6);
    expect(r.confidenceBasis).toContain('nominal');
    expect(r.attributes.fireRadiativePowerMw).toBe(7.86);
    expect(r.attributes.dayNight).toBe('night');
    expect(r.provenance.derived).toContain('confidence');
    expect(r.severity).toBeNull(); // a detection carries no severity
    expect(new Set(run.records.map((x) => x.confidence))).toEqual(new Set([0.3, 0.6, 0.9]));
  });

  it('reports an invalid key as a clear error instead of an empty data set', async () => {
    await expect(runAdapterOnFixtures(adapter, { scenario: scenario('invalid-key') })).rejects.toThrow('malformed FIRMS response: Invalid MAP_KEY.');
  });

  it('rejects malformed rows individually and drops exact duplicates', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: scenario('malformed') });
    expect(run.records.map((r) => r.upstreamId)).toEqual(['N20_2026-11-10_1241_-8.51234_22.10456', 'N21_2026-11-09_0045_-9.00000_22.60000']);
    const odd = run.records[1]!;
    expect(odd.occurredAt).toBe(Date.UTC(2026, 10, 9, 0, 45)); // "45" → 00:45
    expect(odd.confidence).toBeNull(); // unknown class "x" is not guessed
    expect(odd.attributes.fireRadiativePowerMw).toBeUndefined();
    expect(odd.attributes.satellite).toBe('NOAA-21');
    const reasons = run.rejected.map((r) => r.reason);
    expect(reasons.filter((r) => r === 'missing or invalid coordinates')).toHaveLength(2);
    expect(reasons.filter((r) => r === 'unparseable acquisition date/time')).toHaveLength(2);
    expect(reasons).toContain('row has too few columns');
    expect(reasons).toHaveLength(5);
  });

  it('parses a 40,000-row file quickly and keeps every unique detection', () => {
    const csv = firmsVolume({ count: 40_000 }, {} as never) as string;
    const payload = { key: SOURCE, url: 'x', status: 200, body: Buffer.from(csv), contentType: 'text/csv', fetchedAt: 0, etag: null, lastModified: null, notModified: false, fromCache: false, stale: false, text: () => csv, json: () => null as never };
    const t0 = performance.now();
    const out = adapter.parse([payload], { now: 0, env: {} });
    const ms = performance.now() - t0;
    expect(out.records).toHaveLength(40_000);
    expect(out.rejected).toHaveLength(0);
    expect(new Set(out.records.map((r) => r.upstreamId)).size).toBe(40_000);
    expect(ms).toBeLessThan(2000);
    expect(MAX_DETECTIONS).toBeGreaterThanOrEqual(40_000);
  });
});
