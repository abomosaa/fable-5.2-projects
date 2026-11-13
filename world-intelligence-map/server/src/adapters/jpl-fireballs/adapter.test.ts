import { describe, expect, it } from 'vitest';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { signed } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 150 });

describe('jpl-fireballs specifics', () => {
  it('requests the five years before the clock time', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.requests).toEqual(['https://ssd-api.jpl.nasa.gov/fireball.api?date-min=2021-11-12&req-loc=true']);
  });

  it('applies hemisphere letters, parses UTC times and derives severity from impact energy', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.rejected).toHaveLength(0);
    expect(run.records).toHaveLength(173);
    const r = run.records.find((x) => x.upstreamId === '20261004031445_-41.8_-173.1')!;
    expect(r.point).toEqual([-173.1, -41.8]);
    expect(r.occurredAt).toBe(Date.UTC(2026, 9, 4, 3, 14, 45));
    expect(r.title).toBe('Fireball – 0.18 kt at 41.8°S 173.1°W');
    expect(r.severity).toBe(0);
    expect(r.attributes.velocityKmS).toBe(13.8);
    expect(r.attributes.altitudeKm).toBe(26.9);
    expect(r.confidence).toBeNull();
    const mid = run.records.find((x) => x.upstreamId.startsWith('20260911011211'))!;
    expect(mid.attributes.estimatedImpactEnergyKt).toBe(0.67);
    expect(mid.severity).toBe(1);
    expect(mid.point).toEqual([-100.1, 54.4]);
    expect(mid.provenance.derived).toContain('severity');
  });

  it('signed() refuses unknown hemispheres and negative magnitudes', () => {
    expect(signed('12.5', 'S', 'N', 'S')).toBe(-12.5);
    expect(signed('12.5', 'n', 'N', 'S')).toBe(12.5);
    expect(signed('12.5', 'X', 'N', 'S')).toBeNull();
    expect(signed('-3', 'N', 'N', 'S')).toBeNull();
    expect(signed(null, 'N', 'N', 'S')).toBeNull();
  });

  it('rejects malformed rows individually', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: 'jpl-fireballs', fromRun: 1, effect: { variant: 'malformed' } }] });
    expect(run.records.map((r) => r.upstreamId)).toEqual(['20261004031445_-41.8_-173.1', '20260815073240_4.0_115.4']);
    expect(run.records[1]!.severity).toBeNull();
    const reasons = run.rejected.map((r) => r.reason);
    expect(reasons.filter((r) => r === 'missing or invalid location')).toHaveLength(4);
    expect(reasons).toContain('unparseable date "2026-13-40 99:99:99"');
    expect(reasons).toContain('row is not an array');
    expect(reasons).toHaveLength(6);
  });

  it('accepts an empty result (count 0 without data)', () => {
    const body = '{"signature":{"source":"NASA/JPL Fireball Data API","version":"1.2"},"count":"0"}';
    const out = adapter.parse([{ key: 'fireballs', url: 'x', status: 200, body: Buffer.from(body), contentType: null, fetchedAt: 0, etag: null, lastModified: null, notModified: false, fromCache: false, stale: false, text: () => body, json: () => JSON.parse(body) }], { now: 0, env: {} });
    expect(out.records).toHaveLength(0);
    expect(out.rejected).toHaveLength(0);
  });
});
